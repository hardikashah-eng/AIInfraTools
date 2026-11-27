// Shadow upgrades from the metrics a canary already exports: per-version vLLM metrics in Prometheus (llm-d controlled
// deployments, Argo Rollouts, Flagger, or any two label selectors), compared at matched load. See docs/SHADOW.md.
//
// A canary's versions see different load: a canary at a small weight, or with fewer replicas, runs at lower load per
// engine, so it looks faster than it is. Prometheus has no per-request records, but it has short windows (one per
// step). Each window of each version carries its load (calls running and waiting per engine, mean prompt length,
// prefix-cache hit rate) and its mean latencies. The baseline's latency is fitted as a function of that load on its own
// windows; each canary window is compared with what the baseline shows at the canary's load, inside the load range the
// baseline covers. The interval comes from resampling windows of both versions and fitting again.
//
// Metric names are vLLM's (v1 engine): vllm:time_to_first_token_seconds, vllm:request_time_per_output_token_seconds
// (else vllm:inter_token_latency_seconds), vllm:e2e_request_latency_seconds, vllm:num_requests_running|waiting,
// vllm:prompt_tokens_total, vllm:generation_tokens_total, vllm:prefix_cache_hits_total|queries_total,
// vllm:request_success_total{finished_reason}. llm-d's controlled deployments label each version llm_isvc_name.
import { promRange } from './pull.mjs';
import { GATES, judge, decide, errorTest } from './shadow.mjs';
import { median, pctl, rng } from './stats.mjs';

// ---------- selectors ----------
// A selector is a list of Prometheus label matchers, as inside { }: llm_isvc_name="chat-v2",namespace="llm"
const MATCHER = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"(?:[^"\\]|\\.)*"\s*$/;
export function checkSelector(s) {
  const x = String(s ?? '').trim().replace(/^\{|\}$/g, '');
  if (!x) throw new Error('empty selector');
  // split on commas outside quotes
  const parts = []; let cur = '', q = false;
  for (let i = 0; i < x.length; i++) { const c = x[i]; if (c === '\\' && q) { cur += c + x[++i]; continue; } if (c === '"') q = !q; if (c === ',' && !q) { parts.push(cur); cur = ''; } else cur += c; }
  if (q) throw new Error(`selector ${s}: unbalanced quotes`);
  parts.push(cur);
  const ok = parts.map(p => p.trim()).filter(Boolean);
  for (const p of ok) if (!MATCHER.test(p)) throw new Error(`selector ${s}: "${p}" is not a label matcher (name="value", name=~"regex", != or !~)`);
  return ok.join(',');
}
export const join = (...ss) => ss.filter(Boolean).map(checkSelector).join(',');

// ---------- the queries, per version ----------
export function queries(sel, step = 60) {
  const S = checkSelector(sel), W = `[${Math.max(1, Math.round(step))}s]`, inc = (m, extra = '') => `sum(increase(${m}{${S}${extra}}${W}))`;
  const mean = h => `(${inc(h + '_sum')} / ${inc(h + '_count')})`, p95 = h => `histogram_quantile(0.95, sum by (le) (rate(${h}_bucket{${S}}${W})))`;
  return {
    n: inc('vllm:e2e_request_latency_seconds_count'),
    ttft: mean('vllm:time_to_first_token_seconds'),
    tpot: `${mean('vllm:request_time_per_output_token_seconds')} or ${mean('vllm:inter_token_latency_seconds')}`,
    e2e: mean('vllm:e2e_request_latency_seconds'),
    ttftP95: p95('vllm:time_to_first_token_seconds'),
    e2eP95: p95('vllm:e2e_request_latency_seconds'),
    running: `avg(avg_over_time(vllm:num_requests_running{${S}}${W}))`,
    waiting: `avg(avg_over_time(vllm:num_requests_waiting{${S}}${W}))`,
    engines: `count(vllm:num_requests_running{${S}})`,
    promptTok: inc('vllm:prompt_tokens_total'),
    genTok: inc('vllm:generation_tokens_total'),
    hits: inc('vllm:prefix_cache_hits_total'),
    lookups: inc('vllm:prefix_cache_queries_total'),
    finished: inc('vllm:request_success_total'),
    errors: inc('vllm:request_success_total', ',finished_reason=~"abort|error"'),
  };
}

// query_range answers (one series per query: every query aggregates to a single series) → windows
export function windowsFrom(series, step = 60) {
  const at = new Map();
  for (const [k, pts] of Object.entries(series)) for (const [t, v] of pts || []) { const x = +v; if (!Number.isFinite(x)) continue; if (!at.has(+t)) at.set(+t, { t: +t }); at.get(+t)[k] = x; }
  const out = [];
  for (const w of [...at.values()].sort((a, b) => a.t - b.t)) {
    if (!(w.n > 0)) continue;
    out.push({
      t: w.t, n: w.n, stepS: step, ttft: w.ttft, tpot: w.tpot, e2e: w.e2e, ttftP95: w.ttftP95, e2eP95: w.e2eP95,
      conc: (w.running || 0) + (w.waiting || 0), engines: w.engines || null,
      isl: w.promptTok > 0 ? w.promptTok / w.n : null, osl: w.genTok > 0 ? w.genTok / w.n : null,
      hit: w.lookups > 0 ? (w.hits || 0) / w.lookups : null, finished: w.finished ?? w.n, errors: w.errors || 0, genTok: w.genTok || 0,
    });
  }
  return out;
}

// fetch both versions over [from, to] (the baseline from baselineFrom when given: its response to load is learned from
// a longer history than a short canary has); returns { baseline, candidate } windows and the raw series (to save, replay)
export async function fetchArms(prom, { baseline, candidate, select = null, from, to, baselineFrom = from, step = 60, fetcher, headers }) {
  const sel = { baseline: join(select, baseline), candidate: join(select, candidate) }, raw = { baseline: {}, candidate: {} };
  for (const arm of ['baseline', 'candidate']) {
    for (const [k, q] of Object.entries(queries(sel[arm], step))) {
      const r = await promRange(prom, q, { from: arm === 'baseline' ? baselineFrom : from, to, step, fetcher, headers });
      raw[arm][k] = r.length ? r[0].samples.map(s => [s.t, s.v]) : [];
    }
  }
  return { kind: 'fleetops.shadow-prom', from, baselineFrom, to, step, selectors: sel, series: raw, ...fromSaved({ step, series: raw }) };
}
export const fromSaved = j => ({ baseline: windowsFrom(j.series.baseline, j.step), candidate: windowsFrom(j.series.candidate, j.step) });

// ---------- matched load over windows ----------
// The baseline's latency as a function of load, fitted on its own windows: for each canary window, a local linear fit
// (LOESS) of the baseline's log latency around that window's load, tricube-weighted by distance in log calls per engine
// and by requests, with prompt length, prefix-cache hit (and output length for end-to-end time) as linear terms. Local
// fits follow the knee near saturation that a global curve misses. Canary windows outside the baseline's load range
// (2nd–98th percentile) are left out, never extrapolated.
const lc = w => Math.log(Math.max(0.5, w.conc || 0.5));
const covs = (w, m) => { const f = [w.isl > 0 ? Math.log(w.isl) : 0, w.hit ?? 0]; if (m === 'e2e') f.push(w.osl > 0 ? Math.log(w.osl) : 0); return f; };
function solve(A, b) {
  const k = b.length;
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]; if (Math.abs(A[c][c]) < 1e-12) return null; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j < k; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c]; } }
  return b.map((v, i) => v / A[i][i]);
}
// baseline prepared once per (resampled) set: load, covariates, log latency, weight
const prep = (ws, m) => ws.map(w => ({ c: lc(w), x: covs(w, m), y: Math.log(w[m]), n: w.n })).sort((a, b) => a.c - b.c);
function predict(B, w, m, span) {
  const c0 = lc(w), x0 = covs(w, m), k = Math.min(B.length, Math.max(12, Math.min(80, Math.ceil(span * B.length))));
  // the k nearest in load: B is sorted by load, so they are a contiguous run around c0
  let lo = 0, hi = B.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (B[mid].c < c0) lo = mid + 1; else hi = mid; }
  let i0 = lo, i1 = lo; // [i0, i1)
  while (i1 - i0 < k) { if (i0 > 0 && (i1 >= B.length || c0 - B[i0 - 1].c <= B[i1].c - c0)) i0--; else i1++; }
  const h = Math.max(1e-6, Math.max(c0 - B[i0].c, B[i1 - 1].c - c0) * 1.0001), K = 2 + x0.length, A = Array.from({ length: K }, () => new Array(K).fill(0)), r = new Array(K).fill(0);
  let tot = 0;
  for (let i = i0; i < i1; i++) {
    const u = Math.abs(B[i].c - c0) / h; if (u >= 1) continue; const wt = B[i].n * (1 - u ** 3) ** 3, f = [1, B[i].c - c0, ...B[i].x.map((v, j) => v - x0[j])]; tot += wt;
    for (let a = 0; a < K; a++) { r[a] += wt * f[a] * B[i].y; for (let b = 0; b < K; b++) A[a][b] += wt * f[a] * f[b]; }
  }
  for (let a = 1; a < K; a++) A[a][a] += 1e-6 * tot; // keeps a constant covariate (no hit data) solvable
  const beta = solve(A, r); return beta ? beta[0] : NaN;
}
const usable = (ws, m, minReq) => ws.filter(w => w[m] > 0 && w.n >= minReq);
function support(bw) {
  const r = a => [pctl(a, 0.02), pctl(a, 0.98)], C = r(bw.map(lc)), I = r(bw.map(w => (w.isl > 0 ? Math.log(w.isl) : 0)));
  return w => { const c = lc(w), i = w.isl > 0 ? Math.log(w.isl) : 0; return c >= C[0] && c <= C[1] && i >= I[0] && i <= I[1]; };
}
function adjEffect(bw, cw, m, span) {
  const B = prep(bw, m); let s = 0, n = 0;
  for (const w of cw) { const p = predict(B, w, m, span); if (!Number.isFinite(p)) continue; s += w.n * (Math.log(w[m]) - p); n += w.n; }
  return n ? s / n : NaN;
}
const resample = (a, u) => a.map(() => a[Math.floor(u() * a.length)]);
// at least minWin canary windows and minRequests canary requests inside the baseline's load range, or no verdict
export function windowEffect(bw0, cw0, m, { minWin = 5, minReq = 5, minRequests = 200, boot = null, seed = 11, span = 0.3 } = {}) {
  if (boot == null) boot = Math.max(100, Math.min(200, Math.round(60000 / Math.max(1, bw0.length + cw0.length))));
  const bw = usable(bw0, m, minReq), call = usable(cw0, m, minReq);
  if (bw.length < 20) return null;
  const inside = support(bw), cw = call.filter(inside);
  if (cw.length < minWin || cw.reduce((a, w) => a + w.n, 0) < minRequests) return null;
  const est = adjEffect(bw, cw, m, span); if (!Number.isFinite(est)) return null;
  const u = rng(seed + m.length * 7), bs = [];
  for (let i = 0; i < boot; i++) { const e = adjEffect(resample(bw, u), resample(cw, u), m, span); if (Number.isFinite(e)) bs.push(e); }
  const r = a => a.reduce((s, w) => s + w.n, 0);
  return { est, lo: pctl(bs, 0.025), hi: pctl(bs, 0.975), windows: cw.length, baselineWindows: bw.length, coverage: r(call) ? r(cw) / r(call) : 0, mode: 'matched load (windows)' };
}
// the per-version comparison a dashboard makes: request-weighted means over the whole period, no load matching
export function windowNaive(bw, cw, m) {
  const mean = ws => { let s = 0, n = 0; for (const w of ws) if (w[m] > 0) { s += w[m] * w.n; n += w.n; } return n ? s / n : NaN; };
  return mean(cw) / mean(bw) - 1;
}

export function compareWindows(bw, cw, opt = {}) {
  const G = Object.assign({}, GATES, opt.gates || {}), step = opt.step || (bw[0] && bw[0].stepS) || 60, metrics = {};
  for (const m of ['ttft', 'tpot', 'e2e']) {
    const e = windowEffect(bw, cw, m, opt);
    // judge's "more" is in the unit it is given: windows here, turned into minutes at this step
    const j = judge(e && { est: e.est, lo: e.lo, hi: e.hi }, G[m], e ? e.windows : 0);
    if (j.more != null) j.more = Math.ceil(j.more * step / 60);
    metrics[m] = Object.assign(j, e ? { windows: e.windows, mode: e.mode, coverage: e.coverage } : {}, { naive: windowNaive(bw, cw, m) });
  }
  const sum = (ws, k) => ws.reduce((a, w) => a + (w[k] || 0), 0), eb = { n: sum(bw, 'finished'), k: sum(bw, 'errors') }, ec = { n: sum(cw, 'finished'), k: sum(cw, 'errors') };
  if (eb.n && ec.n) metrics.errorRate = errorTest(eb, ec, G.errorRate);
  const B = opt.baseline || {}, C = opt.candidate || {}, secs = ws => ws.length * step;
  if (B.gpus && C.gpus && bw.length && cw.length) {
    const tb = sum(bw, 'genTok') / secs(bw) / B.gpus, tc = sum(cw, 'genTok') / secs(cw) / C.gpus;
    metrics.tokPerGpuS = { baseline: tb, candidate: tc, effect: tc / tb - 1, note: 'each version at its own load: a canary at low weight shows less' };
    if (B.rate && C.rate) { const cb = B.rate / 3600 / (tb / 1e6), cc = C.rate / 3600 / (tc / 1e6); metrics.costPerMTok = { baseline: cb, candidate: cc, effect: cc / cb - 1, note: 'at the load each version saw' }; }
  }
  const load = ws => ({ windows: ws.length, requests: Math.round(sum(ws, 'n')), concPerEngine: median(ws.map(w => w.conc)), isl: median(ws.map(w => w.isl).filter(Number.isFinite)), hit: median(ws.map(w => w.hit).filter(Number.isFinite)), ttftP95: median(ws.map(w => w.ttftP95).filter(Number.isFinite)), e2eP95: median(ws.map(w => w.e2eP95).filter(Number.isFinite)) });
  let prediction = null;
  if (opt.predicted) {
    const rows = [];
    for (const [k, p] of Object.entries(opt.predicted)) { const m = metrics[k]; const meas = m ? (m.effect ?? null) : null; if (meas == null || !Number.isFinite(p) || !Number.isFinite(meas)) continue; rows.push({ metric: k, predicted: p, measured: meas, off: (1 + meas) / (1 + p) - 1 }); }
    prediction = { rows, holds: rows.every(r => Math.abs(r.off) <= G.prediction) };
  }
  const d = decide(metrics, null, prediction, { unit: 'minutes of canary traffic' });
  if (d.why === 'no latency data to judge yet') d.why = `too little canary traffic to judge yet (needs ${opt.minWin || 5} windows and ${opt.minRequests || 200} requests inside the baseline's load range)`;
  return { decision: d.decision, why: d.why, verdict: verdictOf(d.decision), source: 'prometheus', step, ...(prediction ? { prediction } : {}), requests: { baseline: Math.round(sum(bw, 'n')), candidate: Math.round(sum(cw, 'n')) }, load: { baseline: load(bw), candidate: load(cw) }, metrics, gates: G };
}
// one word for rollout controllers
export const verdictOf = d => (d === 'promote' ? 'promote' : d === 'roll back' ? 'rollback' : 'wait');

// ---------- a canary that looks faster than it is ----------
// The baseline runs at 4–24 calls per engine over a day's swing; the canary, with too many replicas for its weight,
// at half that. The canary's TPOT is 8% worse at any load, its TTFT the same.
export function synthWindows({ seed = 5, n = 240, step = 60, t0 = Math.floor(Date.UTC(2026, 10, 25, 8) / 1000), slower = 0.08, loadShare = 0.5 } = {}) {
  const u = rng(seed), noise = s => Math.exp(s * (u() + u() + u() - 1.5)), arm = (scale, k, rps) => {
    const ws = [];
    for (let i = 0; i < n; i++) {
      const conc = scale * (14 + 10 * Math.sin(2 * Math.PI * i / n)) * noise(0.15), isl = 2000 * noise(0.3), osl = 300 * noise(0.2), hit = Math.min(0.98, 0.6 * noise(0.1));
      const ttft = 0.06 * (1 + conc / 8) * (isl / 2000) ** 0.5 * (1 - 0.5 * hit) / 0.7 * noise(0.04), tpot = 0.02 * (1 + conc / 16) * k * noise(0.03);
      const nReq = Math.max(1, Math.round(rps * step * conc / 14 * noise(0.1))), errors = u() < 0.02 ? 1 : 0;
      ws.push({ t: t0 + i * step, n: nReq, stepS: step, ttft, tpot, e2e: ttft + tpot * osl, conc, engines: null, isl, osl, hit, finished: nReq, errors, genTok: nReq * osl });
    }
    return ws;
  };
  return { baseline: arm(1, 1, 9), candidate: arm(loadShare, 1 + slower, 1), step };
}
// the same windows as query_range series, for a mock Prometheus or a saved file
export function seriesOf(ws) {
  const s = {}, put = (k, t, v) => { if (v == null || !Number.isFinite(v)) return; (s[k] = s[k] || []).push([t, String(v)]); };
  for (const w of ws) {
    put('n', w.t, w.n); put('ttft', w.t, w.ttft); put('tpot', w.t, w.tpot); put('e2e', w.t, w.e2e); put('running', w.t, w.conc); put('waiting', w.t, 0); put('engines', w.t, w.engines ?? 1);
    put('promptTok', w.t, w.isl * w.n); put('genTok', w.t, w.genTok); put('hits', w.t, w.hit * 1000); put('lookups', w.t, 1000); put('finished', w.t, w.finished); put('errors', w.t, w.errors);
  }
  return s;
}
