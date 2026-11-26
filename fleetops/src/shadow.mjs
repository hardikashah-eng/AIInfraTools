// Shadow upgrades: measure an infra change (GPUs, engine or its config, network, topology, serving layout) against the
// baseline before it ships, and keep measuring the baseline so drift is caught. See docs/SHADOW.md.
//
//   plan     predict what the change should do (the Inference Sizer at the workload's load) and how many requests a test
//            needs to see an effect of a given size
//   compare  baseline vs candidate on request records at matched load: per metric an effect with a confidence interval,
//            a verdict against gates, the naive comparison beside it, prediction vs measurement, cost
//   baseline / watch   keep a sample of a service's requests as its baseline; compare later windows with it
//
// Request records are the store's `request` kind: { t, isl, osl, cached?, ttft?, e2e?, tpot?, error?, variant?, pair? }.
// They come from engine traces (fleetops data import otlp-traces FILE --derive), from shadow replay (shadow-replay.mjs), or files.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../inference-sizer/src/catalog.js'), M = require('../../inference-sizer/src/model.js');

// An effect inside ±gate is "the same"; a confidence interval wholly past it is "worse" or "better". Latency effects
// are ratios (candidate ÷ baseline − 1); errors are a difference in rate; answers are a match rate.
export const GATES = { ttft: 0.05, tpot: 0.05, e2e: 0.05, errorRate: 0.005, tokPerGpuS: 0.05, costPerMTok: 0.05, answers: { match: 0.98, logprob: 0.05 }, prediction: 0.15 };
const METRICS = ['ttft', 'tpot', 'e2e'];

// ---------- small statistics ----------
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : NaN; };
function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const normCdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

// ---------- load context ----------
export function withMetrics(r) {
  const o = Object.assign({}, r);
  if (o.tpot == null && Number.isFinite(o.e2e) && Number.isFinite(o.ttft) && o.osl > 1) o.tpot = (o.e2e - o.ttft) / (o.osl - 1);
  return o;
}
// calls in flight at each request's start, within its own arm (itself included)
export function annotateLoad(rs) {
  const out = rs.map(withMetrics).sort((a, b) => a.t - b.t), ends = [];
  for (const r of out) {
    while (ends.length && ends[0] <= r.t) ends.shift();
    r.conc = ends.length + 1;
    const e = r.t + (Number.isFinite(r.e2e) ? r.e2e : 0); let i = ends.length; while (i > 0 && ends[i - 1] > e) i--; ends.splice(i, 0, e);
  }
  return out;
}
// the load a request met: calls in flight (half powers of two: 1, 2, 3, 4, 6, 8, 11, 16…), prompt length (powers of two), cache hit (none/part/most)
export function stratum(r, m) {
  const c = Math.floor(2 * Math.log2(Math.max(1, r.conc || 1))), l = Math.floor(Math.log2(Math.max(1, r.isl || 1)));
  const h = r.cached == null ? 'n' : r.cached / Math.max(1, r.isl) >= 0.9 ? 'h' : r.cached / Math.max(1, r.isl) >= 0.5 ? 'p' : 'z';
  // end-to-end time scales with output length, so its strata also split by output length (powers of two)
  return m === 'e2e' ? `${c}|${l}|${h}|${Math.floor(Math.log2(Math.max(1, r.osl || 1)))}` : `${c}|${l}|${h}`;
}

// ---------- matched-load effect of one metric ----------
// Stratified: in each load stratum both arms reach, log(median candidate) − log(median baseline), weighted by how much
// traffic the stratum carries in both arms. Paired (replay sends each request to both): the median per-request log ratio.
// Confidence interval by bootstrap (resampling requests within strata, or pairs).
function strataOf(rs, m) { const S = new Map(); for (const r of rs) { const v = r[m]; if (!(v > 0)) continue; const k = stratum(r, m); if (!S.has(k)) S.set(k, []); S.get(k).push(Math.log(v)); } return S; }
function stratEffect(Sb, Sc, minN) {
  let w = 0, sum = 0;
  for (const [k, b] of Sb) { const c = Sc.get(k); if (!c || b.length < minN || c.length < minN) continue; const wt = b.length + c.length; sum += wt * (median(c) - median(b)); w += wt; }
  return w ? sum / w : NaN;
}
const resample = (a, u) => { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[Math.floor(u() * a.length)]; return o; };
export function effect(base, cand, m, { minN = 5, boot = 400, seed = 7, paired = false } = {}) {
  const u = rng(seed + m.length);
  if (paired) {
    const byPair = new Map(); for (const r of base) if (r.pair != null && r[m] > 0) byPair.set(r.pair, r[m]);
    const d = []; for (const r of cand) { const b = byPair.get(r.pair); if (b > 0 && r[m] > 0) d.push(Math.log(r[m] / b)); }
    if (d.length < minN) return null;
    const est = median(d), bs = []; for (let i = 0; i < boot; i++) bs.push(median(resample(d, u)));
    return { n: d.length, est, lo: pctl(bs, 0.025), hi: pctl(bs, 0.975), mode: 'paired', coverage: 1 };
  }
  const Sb = strataOf(base, m), Sc = strataOf(cand, m), est = stratEffect(Sb, Sc, minN);
  if (!Number.isFinite(est)) return null;
  let matched = 0, all = 0; for (const [k, b] of Sb) { const c = Sc.get(k) || []; all += b.length; if (b.length >= minN && c.length >= minN) matched += b.length; }
  const bs = [];
  for (let i = 0; i < boot; i++) {
    const rb = new Map([...Sb].map(([k, v]) => [k, resample(v, u)])), rc = new Map([...Sc].map(([k, v]) => [k, resample(v, u)]));
    const e = stratEffect(rb, rc, minN); if (Number.isFinite(e)) bs.push(e);
  }
  const nb = [...Sb.values()].reduce((a, v) => a + v.length, 0), nc = [...Sc.values()].reduce((a, v) => a + v.length, 0);
  return { n: Math.min(nb, nc), est, lo: pctl(bs, 0.025), hi: pctl(bs, 0.975), mode: 'matched load', coverage: all ? matched / all : 0 };
}
// the comparison most dashboards make: all requests, medians, no load matching
export function naive(base, cand, m) { const b = base.map(r => r[m]).filter(v => v > 0), c = cand.map(r => r[m]).filter(v => v > 0); return b.length && c.length ? Math.log(median(c) / median(b)) : NaN; }

const ratio = x => Math.expm1(x);
// worse / better / same / inconclusive, and for inconclusive about how many more requests per arm would settle it
export function judge(e, gate, n) {
  if (!e) return { verdict: 'no data' };
  const lo = ratio(e.lo), hi = ratio(e.hi), est = ratio(e.est);
  let verdict = lo > gate ? 'worse' : hi < -gate ? 'better' : lo > -gate && hi < gate ? 'same' : 'inconclusive', more = null;
  if (verdict === 'inconclusive') { const half = (hi - lo) / 2, target = Math.max(Math.abs(gate - Math.abs(est)), gate / 20); more = Math.max(0, Math.ceil(n * ((half / target) ** 2 - 1))); }
  return { verdict, effect: est, lo, hi, more };
}

// ---------- compare ----------
// arms: { baseline: [requests], candidate: [requests] } with optional { gpus, rate ($/GPU-h) } per arm, predicted ratios
// from plan(), answers from shadow-replay's equivalence check, infra signals from infraSignals().
export function compare(base0, cand0, opt = {}) {
  const G = Object.assign({}, GATES, opt.gates || {});
  const base = annotateLoad(base0), cand = annotateLoad(cand0);
  const pairIds = new Set(base.filter(r => r.pair != null).map(r => r.pair)), shared = cand.filter(r => pairIds.has(r.pair)).length;
  const paired = opt.paired ?? (shared >= Math.min(base.length, cand.length) * 0.5 && shared >= 5);
  const metrics = {};
  for (const m of METRICS) {
    const e = effect(base, cand, m, { paired, boot: opt.boot, minN: opt.minN });
    const j = judge(e, G[m], e ? e.n : 0);
    metrics[m] = Object.assign(j, e ? { n: e.n, mode: e.mode, coverage: e.coverage } : {}, { naive: ratio(naive(base, cand, m)) });
  }
  // errors: difference in rate, two-proportion test
  const er = rs => ({ n: rs.length, k: rs.filter(r => r.error).length }), eb = er(base), ec = er(cand);
  if (eb.n && ec.n) metrics.errorRate = errorTest(eb, ec, G.errorRate);
  // tokens/s per GPU and cost per million output tokens: meaningful when both arms served the same requests (paired)
  const span = rs => (rs.length ? Math.max(...rs.map(r => r.t + (r.e2e || 0))) - Math.min(...rs.map(r => r.t)) : 0);
  const outTok = rs => rs.filter(r => !r.error).reduce((a, r) => a + (r.osl || 0), 0);
  const B = opt.baseline || {}, Cc = opt.candidate || {};
  if (B.gpus && Cc.gpus) {
    const tb = outTok(base) / Math.max(1, span(base)) / B.gpus, tc = outTok(cand) / Math.max(1, span(cand)) / Cc.gpus;
    metrics.tokPerGpuS = { baseline: tb, candidate: tc, effect: tc / tb - 1, note: paired ? 'same requests on both arms' : 'arms served different traffic: read with care' };
    if (B.rate && Cc.rate) {
      const cb = B.gpus * B.rate * span(base) / 3600 / Math.max(1e-9, outTok(base) / 1e6), cc = Cc.gpus * Cc.rate * span(cand) / 3600 / Math.max(1e-9, outTok(cand) / 1e6);
      metrics.costPerMTok = { baseline: cb, candidate: cc, effect: cc / cb - 1, verdict: cc / cb - 1 > G.costPerMTok ? 'worse' : cc / cb - 1 < -G.costPerMTok ? 'better' : 'same' };
    }
  }
  // the same answers: greedy decoding should give the same tokens on both arms
  let answers = null;
  if (opt.answers) {
    const a = opt.answers;
    answers = Object.assign({}, a, { verdict: a.matchRate >= G.answers.match && (a.meanAbsLogprobDiff ?? 0) <= G.answers.logprob ? 'same' : 'different' });
  }
  // prediction vs measurement: is the model of the change right?
  let prediction = null;
  if (opt.predicted) {
    const rows = [];
    for (const [k, p] of Object.entries(opt.predicted)) { const m = metrics[k]; const meas = m ? (m.effect ?? null) : null; if (meas == null || !Number.isFinite(p)) continue; rows.push({ metric: k, predicted: p, measured: meas, off: (1 + meas) / (1 + p) - 1 }); }
    prediction = { rows, holds: rows.every(r => Math.abs(r.off) <= G.prediction) };
  }
  const d = decide(metrics, answers, prediction);
  return { decision: d.decision, why: d.why, paired, requests: { baseline: base.length, candidate: cand.length }, metrics, answers, prediction, infra: opt.infra || null, gates: G };
}

// errors: a difference in rate past the gate, by a one-sided two-proportion test. eb, ec: { n, k } (requests, errors)
export function errorTest(eb, ec, gate = GATES.errorRate) {
  const pb = eb.k / eb.n, pc = ec.k / ec.n, pp = (eb.k + ec.k) / (eb.n + ec.n), se = Math.sqrt(Math.max(1e-12, pp * (1 - pp) * (1 / eb.n + 1 / ec.n))), z = (pc - pb) / se;
  return { baseline: pb, candidate: pc, diff: pc - pb, p: 1 - normCdf(z), verdict: pc - pb > gate && 1 - normCdf(z) < 0.05 ? 'worse' : pb - pc > gate && normCdf(z) < 0.05 ? 'better' : 'same' };
}

// promote / roll back / extend the test, from the metric verdicts (and answers and the prediction when there are any)
export function decide(metrics, answers = null, prediction = null, { unit = 'requests per arm' } = {}) {
  const vs = Object.entries(metrics).filter(([, m]) => m && m.verdict);
  const worse = vs.filter(([, m]) => m.verdict === 'worse').map(([k]) => k), open = vs.filter(([, m]) => m.verdict === 'inconclusive').map(([k]) => k);
  let decision, why;
  if (answers && answers.verdict === 'different') { decision = 'roll back'; why = `answers differ (${(100 * answers.matchRate).toFixed(1)}% identical under greedy decoding)`; }
  else if (worse.length) { decision = 'roll back'; why = `worse on ${worse.join(', ')}`; }
  else if (open.length) { decision = 'extend the test'; why = `not settled on ${open.join(', ')}: about ${Math.max(...open.map(k => metrics[k].more || 0))} more ${unit}`; }
  else if (['ttft', 'tpot', 'e2e'].every(k => !metrics[k] || metrics[k].verdict === 'no data')) { decision = 'extend the test'; why = 'no latency data to judge yet'; }
  else { decision = 'promote'; why = `no metric worse${vs.some(([, m]) => m.verdict === 'better') ? `; better on ${vs.filter(([, m]) => m.verdict === 'better').map(([k]) => k).join(', ')}` : ''}`; }
  if (prediction && !prediction.holds) why += '; the prediction was off: recalibrate the sizer for this change';
  return { decision, why };
}

// ---------- infra signals per arm (from the store's collectors) ----------
export function infraSignals(store, { baselineNodes, candidateNodes, from, to }) {
  const inArm = (re, n) => re && n && re.test(n), out = {};
  const bw = { b: [], c: [] }; for (const x of store.query('collective', { from, to })) { if (!Number.isFinite(x.busbw)) continue; if (inArm(baselineNodes, x.node)) bw.b.push(x.busbw); else if (inArm(candidateNodes, x.node)) bw.c.push(x.busbw); }
  if (bw.b.length && bw.c.length) out.ncclBusBw = { baseline: median(bw.b), candidate: median(bw.c), effect: median(bw.c) / median(bw.b) - 1 };
  const pw = { b: [], c: [] }, ecc = { b: 0, c: 0 };
  for (const d of store.query('device', { from, to })) { const k = inArm(baselineNodes, d.node) ? 'b' : inArm(candidateNodes, d.node) ? 'c' : null; if (!k) continue; if (Number.isFinite(d.powerW)) pw[k].push(d.powerW); if ((d.faults || []).length) ecc[k] += d.faults.length; }
  if (pw.b.length && pw.c.length) out.powerW = { baseline: median(pw.b), candidate: median(pw.c), effect: median(pw.c) / median(pw.b) - 1 };
  const hard = { b: 0, c: 0 }; for (const l of store.query('log', { from, to, where: l => l.severity === 'hard' })) { if (inArm(baselineNodes, l.node)) hard.b++; else if (inArm(candidateNodes, l.node)) hard.c++; }
  out.hardFaults = { baseline: hard.b + ecc.b, candidate: hard.c + ecc.c };
  return out;
}

// ---------- plan: predict the change, size the test ----------
// config: { model, gpu, tp, wprec?, kvprec?, gpus?, effs? } (sizer ids). workload: { isl, osl, prefixHit (0–100), inflight }.
export function predict(config, w) {
  const m = C.MODELS.find(x => x.id === config.model), g = C.GPUS.find(x => x.id === config.gpu);
  if (!m) throw new Error(`unknown model ${config.model}`); if (!g) throw new Error(`unknown GPU ${config.gpu}`);
  const tp = config.tp || g.domain || 8, s = Object.assign({}, M.SETTINGS, m, g, { wprec: config.wprec || m.wprec, kvprec: config.kvprec || 'fp8', avgIn: w.isl, peakIn: w.isl, avgOut: w.osl, peakOut: w.osl, ctx: Math.max(w.isl + w.osl, m.maxCtx || 0), prefixHit: w.prefixHit || 0 }, config.effs || {});
  const inst = Math.max(1, Math.round((config.gpus || tp) / tp));
  return M.operatingPoint(s, M.derive(s), { g: tp, kind: config.layout || 'TPEP', pp: 1, tpl: tp }, Math.max(1, Math.round(w.inflight / inst)));
}
export function workloadOf(requests) {
  const rs = annotateLoad(requests);
  const isl = median(rs.map(r => r.isl)), osl = median(rs.map(r => r.osl)), cachedKnown = rs.filter(r => r.cached != null);
  return { isl, osl, prefixHit: cachedKnown.length ? 100 * cachedKnown.reduce((a, r) => a + r.cached, 0) / Math.max(1, cachedKnown.reduce((a, r) => a + r.isl, 0)) : 0, inflight: median(rs.map(r => r.conc)),
    sigma: (() => { const l = rs.map(r => r.ttft).filter(v => v > 0).map(Math.log); if (l.length < 10) return null; const mu = l.reduce((a, b) => a + b, 0) / l.length; return Math.sqrt(l.reduce((a, b) => a + (b - mu) ** 2, 0) / (l.length - 1)); })() };
}
// requests per arm to see a relative effect `delta` (two-sided α = 0.05, power 0.8) on a log-normal latency of spread σ;
// pairing removes most of the request-to-request spread (σ of a paired log ratio ≈ pairedShare × σ)
export function testSize({ sigma = 0.6, delta = 0.03, paired = true, pairedShare = 0.35, rps = null } = {}) {
  const s = paired ? sigma * pairedShare : sigma, d = Math.log(1 + delta), k = (1.96 + 0.8416) ** 2;
  const n = Math.ceil((paired ? 1 : 2) * k * s * s / (d * d));
  return { requestsPerArm: n, sigma, delta, paired, seconds: rps ? n / rps : null };
}
// ---------- calibration: what measurements taught the sizer ----------
// A profile is the one fleetops calibrate writes and the Inference Sizer reads (--calibration):
// { version, sizer: { "<gpu>|<model>": { effPrefill, effDecodeBW, effDecodeComp, fitOn, source } } }
export const EFF_KEYS = ['effPrefill', 'effDecodeBW', 'effDecodeComp'];
const EFF_CAP = { effPrefill: 0.9, effDecodeBW: 0.95, effDecodeComp: 0.9 }; // as calibrate.mjs: past these it is a model gap
export function calibrationFor(profile, config) {
  const p = profile && profile.sizer && (profile.sizer[`${config.gpu}|${config.model}`] || profile.sizer[`${config.gpu}|*`]);
  return p ? Object.fromEntries(EFF_KEYS.filter(k => typeof p[k] === 'number').map(k => [k, p[k]])) : null;
}
// a config with the profile's efficiencies for its GPU and model (its own effs still win)
export function applyCalibration(config, profile) { const c = calibrationFor(profile, config); return c ? Object.assign({}, config, { effs: Object.assign({}, c, config.effs || {}), calibrated: true }) : config; }

// When the measured effect of a change is off the prediction by more than the gate, fit the candidate's efficiencies
// so the sizer predicts what was measured: TPOT through the decode efficiencies, then TTFT through prefill, each by a
// one-dimensional search on a multiplier (capped as calibrate.mjs caps them). The baseline is taken as calibrated:
// measurements are relative, candidate against baseline. Only metrics with a settled verdict are used.
export function recalibrate(planObj, metrics, { gate = GATES.prediction } = {}) {
  if (!planObj || !planObj.configs || !planObj.workload) return null;
  const { baseline, candidate } = planObj.configs, w = planObj.workload, settled = m => m && ['worse', 'better', 'same'].includes(m.verdict) && Number.isFinite(m.effect);
  const pb = predict(baseline, w), base = Object.assign({}, M.SETTINGS, candidate.effs || {});
  const eff0 = Object.fromEntries(EFF_KEYS.map(k => [k, base[k]])), eff = Object.assign({}, eff0), rows = [];
  const ratio = (k, e) => { const pc = predict(Object.assign({}, candidate, { effs: e }), w); return pc[k] / pb[k]; };
  const fit = (k, keys) => {
    if (!settled(metrics[k])) return;
    const want = 1 + metrics[k].effect, now = ratio(k, eff), off = want / now - 1;
    if (Math.abs(off) <= gate) { rows.push({ metric: k, predicted: now - 1, measured: metrics[k].effect, off, changed: false }); return; }
    const at = m => { const e = Object.assign({}, eff); for (const x of keys) e[x] = Math.min(EFF_CAP[x], eff0[x] * m); return e; };
    // latency falls as efficiency rises: find the multiplier whose predicted ratio meets the measured one
    let lo = 0.05, hi = Math.max(...keys.map(x => EFF_CAP[x] / eff0[x]));
    if (ratio(k, at(hi)) > want || ratio(k, at(lo)) < want) { rows.push({ metric: k, predicted: now - 1, measured: metrics[k].effect, off, changed: false, note: 'outside what efficiencies can explain: a model gap, not a calibration' }); return; }
    for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); if (ratio(k, at(mid)) > want) lo = mid; else hi = mid; }
    Object.assign(eff, at(hi));
    rows.push({ metric: k, predicted: now - 1, measured: metrics[k].effect, off, changed: true, after: ratio(k, eff) - 1 });
  };
  fit('tpot', ['effDecodeBW', 'effDecodeComp']);
  fit('ttft', ['effPrefill']);
  const changed = rows.some(r => r.changed);
  return { key: `${candidate.gpu}|${candidate.model}`, changed, rows, before: eff0, eff: Object.fromEntries(EFF_KEYS.map(k => [k, +eff[k].toFixed(4)])) };
}
export function mergeProfile(profile, rc, { fitOn, t = Math.floor(Date.now() / 1000) } = {}) {
  const p = profile && typeof profile === 'object' ? JSON.parse(JSON.stringify(profile)) : { version: 1, sizer: {} };
  p.sizer = p.sizer || {}; p.sizer[rc.key] = Object.assign({}, p.sizer[rc.key] || {}, rc.eff, { fitOn, source: 'fleetops-shadow', at: t });
  p.generatedAt = t; return p;
}

export function plan({ baseline, candidate, workload, delta = 0.03, rps = null, paired = true }) {
  const pb = predict(baseline, workload), pc = predict(candidate, workload);
  const tokB = pb.outPerGpu, tokC = pc.outPerGpu;
  const predicted = { ttft: pc.ttft / pb.ttft - 1, tpot: pc.tpot / pb.tpot - 1, tokPerGpuS: tokC / tokB - 1 };
  if (baseline.rate && candidate.rate) predicted.costPerMTok = (candidate.rate / tokC) / (baseline.rate / tokB) - 1;
  return { workload, configs: { baseline, candidate }, baseline: { ttft: pb.ttft, tpot: pb.tpot, tokPerGpuS: tokB }, candidate: { ttft: pc.ttft, tpot: pc.tpot, tokPerGpuS: tokC }, predicted,
    test: testSize({ sigma: workload.sigma || 0.6, delta, paired, rps }),
    note: 'Predictions are the Inference Sizer at the workload\'s median prompt, output, cache hit and calls in flight; calibrate it (fleetops calibrate) for numbers to trust.' };
}

// ---------- baselines and drift ----------
// A baseline is a sample of a service's requests (load context and latencies only), kept to compare later windows with.
export function makeBaseline(name, requests, { max = 5000, t = Math.floor(Date.now() / 1000), meta = {} } = {}) {
  const rs = annotateLoad(requests), step = Math.max(1, rs.length / max), sample = [];
  for (let i = 0; i < rs.length && sample.length < max; i += step) { const r = rs[Math.floor(i)]; sample.push({ t: r.t, isl: r.isl, osl: r.osl, cached: r.cached, conc: r.conc, ttft: r.ttft, tpot: r.tpot, e2e: r.e2e, error: r.error ? 1 : undefined }); }
  return { kind: 'shadow-baseline', name, t, requests: rs.length, sample, meta };
}
// keep the arms' own load context: a baseline sample already has conc
const keepConc = rs => rs.map(r => Object.assign({}, r));
export function drift(baseline, current, opt = {}) {
  const base = keepConc(baseline.sample), cur = annotateLoad(current);
  const res = {};
  for (const m of METRICS) { const e = effect(base, cur, m, { boot: opt.boot, minN: opt.minN }); res[m] = Object.assign(judge(e, (opt.gates || GATES)[m], e ? e.n : 0), e ? { coverage: e.coverage, n: e.n } : {}); }
  const drifted = Object.entries(res).filter(([, v]) => v.verdict === 'worse' || v.verdict === 'better').map(([k, v]) => `${k} ${v.effect >= 0 ? '+' : ''}${(100 * v.effect).toFixed(1)}%`);
  return { baseline: { name: baseline.name, t: baseline.t, requests: baseline.requests }, current: cur.length, metrics: res, drifted: drifted.length > 0, note: drifted.length ? `drifted from the baseline: ${drifted.join(', ')}` : 'within the baseline at matched load' };
}

// ---------- demo ----------
// A candidate 8% slower than the baseline at any load, that happened to get less than half the traffic during the test:
// the naive comparison says it's faster, the matched-load comparison says it's worse.
export function synth({ seed = 3, n = 3000, t0 = Date.UTC(2026, 10, 20, 12) / 1000 } = {}) {
  const u = rng(seed), lognorm = s => Math.exp(s * Math.sqrt(-2 * Math.log(1 - u() + 1e-12)) * Math.cos(2 * Math.PI * u()));
  const arm = (variant, rate, speed, loadPenalty) => {
    const out = []; let t = t0;
    // traffic: Poisson with bursts; the arm's offered rate sets how loaded it runs
    while (out.length < n) {
      t += -Math.log(1 - u()) / (rate * (1 + 0.8 * Math.sin((t - t0) / 600)));
      const isl = Math.round(2000 * lognorm(0.9)), osl = Math.max(16, Math.round(250 * lognorm(0.6))), cached = Math.round(isl * (u() < 0.6 ? 0.92 : 0.1));
      out.push({ t, isl, osl, cached, variant, source: 'shadow-demo' });
    }
    // latencies depend on load and load on latencies: settle both in a few passes
    const noise = out.map(() => [lognorm(0.25), lognorm(0.15)]);
    const set = (r, i, conc) => { const load = 1 + loadPenalty * Math.max(0, conc - 8) / 8, fresh = r.isl - r.cached;
      r.ttft = (0.05 + fresh / 20000) * load * speed * noise[i][0]; r.tpot = 0.02 * load * speed * noise[i][1]; r.e2e = r.ttft + r.tpot * (r.osl - 1); };
    out.forEach((r, i) => set(r, i, 1));
    for (let pass = 0; pass < 3; pass++) { const byT = new Map(annotateLoad(out).map(x => [x.t, x.conc])); out.forEach((r, i) => set(r, i, byT.get(r.t))); }
    for (const r of out) r.error = u() < 0.002 ? true : undefined;
    return out;
  };
  return { baseline: arm('baseline', 1.0, 1.0, 0.5), candidate: arm('candidate', 0.55, 1.08, 0.5) };
}
