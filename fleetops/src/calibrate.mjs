// Continuous calibration: fit the models to measurements in the store, keep the fits as versioned profiles, and say
// when new measurements drift away from them.
//
//   FleetScope pools   serving records (vLLM /metrics, Prometheus) → per-pool {prefill, decode} multipliers, using
//                      FleetScope's own fitter, accepted at 10% (p50) / 20% (p99).
//   Inference Sizer    benchmark records (MLPerf, benchmark_serving) → engine efficiencies per GPU and model, fitted so
//                      the sizer's GPU count for the measured load matches what the measured system used.
//   Drift              the latest window simulated with the stored profile: outside the bar → a drift record.
//
// Profiles are plain JSON so FleetScope graphs and the sizer (`--calibration`) can read them without this package.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../../fleetscope/src/engine.js'), Cal = require('../../fleetscope/src/calibrate.js'), TP = require('../../fleetscope/src/templates.js');
const SM = require('../../inference-sizer/src/model.js'), SC = require('../../inference-sizer/src/catalog.js');

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);

// Benchmark model names → each tool's closest catalog model (same architecture).
export const MODEL_MAP = [
  { re: /llama-?2-?70b|llama-?3(\.\d)?-?70b|llama33-70b/i, fleetscope: 'llama-70b', sizer: 'llama33-70b', note: 'Llama 2 70B and Llama 3.x 70B share the architecture (80 layers, GQA with 8 KV heads)' },
  { re: /llama-?3\.?1-?405b/i, fleetscope: 'llama-405b', sizer: 'llama31-405b' },
  { re: /llama-?3\.?1-?8b/i, fleetscope: 'llama-8b', sizer: 'llama31-8b' },
];
export const modelFor = (name, tool) => { const m = MODEL_MAP.find(x => x.re.test(name || '')); return m ? m[tool] : null; };

// ---------- measured targets ----------

// Serving records for one pool over a window → one FleetScope target (medians of each field, rate weighted by window).
export function servingTarget(records) {
  if (!records.length) return null;
  const f = k => median(records.map(r => r[k]));
  const win = records.reduce((t, r) => t + (r.windowS || 0), 0);
  return { source: 'serving', records: records.length, windowS: Math.min(win || 600, 3600), rate: f('rate'), islMean: f('islMean'), oslMean: f('oslMean'),
    ttftP50: f('ttftP50'), ttftP99: f('ttftP99'), tpotP50: f('tpotP50'), tpotP99: f('tpotP99'), from: records[0].t, to: records[records.length - 1].t };
}
// A benchmark record → a FleetScope target (Poisson load at the measured rate).
export function benchTarget(b, { islMean } = {}) {
  return { source: b.source || 'benchmark', rate: b.qps || b.samplesPerS, windowS: 600, islMean: b.islMean ?? islMean, oslMean: b.oslMean,
    ttftP50: b.ttftP50, ttftP99: b.ttftP99, tpotP50: b.tpotP50, tpotP99: b.tpotP99 };
}

// ---------- FleetScope ----------

// A one-pool graph for a benchmarked system: the GPU, the model, and as many instances as the GPUs allow.
export function benchGraph(b, { maxBatch = 1024 } = {}) {
  const gpu = b.gpu, model = modelFor(b.model, 'fleetscope');
  if (!E.GPUS[gpu]) return { error: `${gpu} is not in FleetScope's GPU catalog` };
  if (!model) return { error: `no FleetScope model for ${b.model}` };
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  const tp = E.profile(gpu, E.MODELS[model]).tp, instances = Math.max(1, Math.floor(b.gpus / tp));
  g.nodes.find(n => n.type === 'model').cfg.key = model;
  Object.assign(g.nodes.find(n => n.id === 'on').cfg, { name: `${b.system || gpu} (benchmark)`, gpu, instances, autoscale: false, maxBatch });
  return { graph: g, poolId: 'on', instances, tp };
}

// Fit one pool of a graph to a target with FleetScope's fitter. Returns the multipliers, before/after acceptance and
// FleetScope's diagnosis when the fit can't pass (capacity, overloaded, limit, tail).
export function fitFleetScopePool(graph, poolId, target, { instances, maxS = 300, iters = 10 } = {}) {
  const c = E.compileGraph(graph, lookup);
  if (c.errors.length) throw new Error('graph does not compile: ' + c.errors.map(e => e.msg).join('; '));
  const r = Cal.fitPool(c.spec, poolId, target, { instances, maxS, iters });
  const rows = a => a.rows.map(x => ({ metric: x.metric, measured: x.rec, simulated: x.sim, err: x.err, bar: x.bar, pass: x.pass }));
  return { calib: r.calib, pass: r.acceptance.pass, diagnosis: r.diagnosis, before: rows(r.acceptanceBefore), after: rows(r.acceptance) };
}

// Simulate a target with given multipliers (no fitting): used for held-out checks and drift.
export function checkFleetScopePool(graph, poolId, target, calib, { instances, maxS = 300 } = {}) {
  const c = E.compileGraph(graph, lookup);
  const base = Cal.benchSpec(c.spec, poolId, target, { instances, maxS });
  const pool = base.pools.find(p => p.id === poolId);
  pool.calib = { prefill: calib.prefill || 1, decode: calib.decode || 1 };
  const a = Cal.acceptance(target, Cal.measure(E.simulate(base), poolId));
  return { pass: a.pass, rows: a.rows.map(x => ({ metric: x.metric, measured: x.rec, simulated: x.sim, err: x.err, bar: x.bar, pass: x.pass })) };
}

// Write multipliers into a graph's pools (by pool node id or name).
export function applyToGraph(graph, profile) {
  const g = JSON.parse(JSON.stringify(graph)), applied = [];
  for (const n of g.nodes.filter(x => x.type === 'pool')) {
    const p = (profile.fleetscope || {})[n.id] || (profile.fleetscope || {})[n.cfg.name];
    if (!p) continue;
    n.cfg.calibPrefill = p.calib.prefill; n.cfg.calibDecode = p.calib.decode; applied.push(n.id);
  }
  return { graph: g, applied };
}

// ---------- Inference Sizer ----------

// Sizer inputs that reproduce a benchmark's operating point: its request rate, token sizes and latency limits,
// aggregated serving, no headroom or spare instance (a benchmark runs at the edge on purpose).
export function sizerInputs(b, { islMean, peakIn = 1024, peakOut = 1024, ctx = 2048, wprec = 'fp8' } = {}) {
  const g = SC.GPUS.find(x => x.id === b.gpu), m = SC.MODELS.find(x => x.id === modelFor(b.model, 'sizer'));
  if (!g) return { error: `${b.gpu} is not in the sizer's GPU catalog` };
  if (!m) return { error: `no sizer model for ${b.model}` };
  const s = Object.assign({}, SM.SETTINGS, m, g, {
    model: m.id, gpu: g.id, wprec, kvprec: 'fp8', ctx, dau: (b.qps || b.samplesPerS) * 86400, rpu: 1, peakFactor: 1, concSource: 'dau', conc: 0,
    avgIn: b.islMean ?? islMean, peakIn, avgOut: b.oslMean, peakOut, ttft: Math.round((b.ttftLimit || b.ttftP99 * 1.1) * 1000), tpot: Math.round((b.tpotLimit || b.tpotP99 * 1.1) * 1000),
    mode: 'agg', headroom: 0, nPlus1: false, sloMargin: 0,
  });
  return { s };
}
const EFF = ['effPrefill', 'effDecodeBW', 'effDecodeComp'];
// Physical ceilings for the fitted efficiencies: a fit that wants more than this is a model gap, not an efficiency.
export const EFF_CAP = { effPrefill: 0.9, effDecodeBW: 0.95, effDecodeComp: 0.9 };
const predictGpus = (s, k) => { const x = Object.assign({}, s); for (const e of EFF) x[e] = Math.min(EFF_CAP[e], s[e] * k); const p = SM.plan(x, { noSens: true }); return p.chosen ? p.chosen.gpus : Infinity; };

// Fit one multiplier on the three engine efficiencies (each capped) so the sizer's GPU count for the measured load
// equals the GPUs the measured system used.
export function fitSizer(b, opts = {}) {
  const x = sizerInputs(b, opts);
  if (x.error) return { error: x.error };
  const s = x.s, want = b.gpus, before = predictGpus(s, 1);
  let lo = 0.1, hi = Math.max(...EFF.map(e => EFF_CAP[e] / s[e])), reached = predictGpus(s, hi) <= want;
  if (reached) for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (predictGpus(s, mid) <= want) hi = mid; else lo = mid; }
  // rounded up, so the stored profile lands on the same side of the GPU-count boundary as the fit
  const k = hi, eff = Object.fromEntries(EFF.map(e => [e, Math.min(EFF_CAP[e], Math.ceil(s[e] * k * 1e4) / 1e4)]));
  const after = SM.plan(Object.assign({}, s, eff), { noSens: true }).chosen?.gpus ?? Infinity;
  return {
    gpu: b.gpu, model: modelFor(b.model, 'sizer'), measuredGpus: want, before, after, multiplier: +k.toFixed(3), eff, reached,
    errBefore: Number.isFinite(before) ? (before - want) / want : null, errAfter: Number.isFinite(after) ? (after - want) / want : null,
    capped: EFF.filter(e => s[e] * k >= EFF_CAP[e]), inputs: { qps: b.qps, islMean: s.avgIn, oslMean: s.avgOut, ttftMs: s.ttft, tpotMs: s.tpot },
  };
}
// GPUs the sizer predicts for a (held-out) benchmark with given efficiencies, against what it used.
export function checkSizer(b, eff, opts = {}) {
  const x = sizerInputs(b, opts);
  if (x.error) return { error: x.error };
  const s = Object.assign({}, x.s, eff), p = SM.plan(s, { noSens: true }), gpus = p.chosen ? p.chosen.gpus : Infinity;
  return { measuredGpus: b.gpus, predicted: gpus, err: Number.isFinite(gpus) ? (gpus - b.gpus) / b.gpus : null, inputs: { qps: b.qps, ttftMs: s.ttft, tpotMs: s.tpot } };
}

// ---------- runs over the store ----------

const isInteractive = b => /interactive/i.test(b.model);
// Calibrate from every benchmark in the store. Runs whose model name says "interactive" (low-latency) are held out:
// each is checked against the profile fitted on the same system's regular run.
export function calibrateBenchmarks(store, { islMean = 300, fleetscope = true, maxS = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  const all = store.query('benchmark'), fit = all.filter(b => !isInteractive(b)), held = all.filter(isInteractive);
  const profile = { version: 1, generatedAt: now, assumptions: { islMean, note: 'Benchmark summaries do not report mean input length; islMean is an assumption, see the sensitivity in the output.' }, fleetscope: {}, sizer: {} };
  const runs = [], records = [];
  for (const b of fit) {
    const run = { system: b.system, submitter: b.submitter, gpu: b.gpu, gpus: b.gpus, model: b.model, qps: b.qps };
    const sz = fitSizer(b, { islMean });
    run.sizer = sz;
    if (!sz.error) {
      profile.sizer[`${sz.gpu}|${sz.model}`] = Object.assign({}, sz.eff, { fitOn: `${b.submitter}/${b.system} ${b.model} ${b.scenario}`, measuredGpus: sz.measuredGpus, before: sz.before, after: sz.after, reached: sz.reached });
      records.push({ t: now, target: `sizer:${sz.gpu}|${sz.model}`, tool: 'inference-sizer', eff: sz.eff, multiplier: sz.multiplier, before: sz.before, after: sz.after, measuredGpus: sz.measuredGpus, reached: sz.reached, fitOn: b.system, source: 'fleetops-calibrate' });
    }
    if (fleetscope) {
      const bg = benchGraph(b);
      if (bg.error) run.fleetscope = { error: bg.error };
      else {
        const f = fitFleetScopePool(bg.graph, bg.poolId, benchTarget(b, { islMean }), { instances: bg.instances, maxS });
        run.fleetscope = Object.assign({ instances: bg.instances, tp: bg.tp }, f);
        profile.fleetscope[`${b.gpu}|${modelFor(b.model, 'fleetscope')}`] = { calib: f.calib, pass: f.pass, diagnosis: f.diagnosis, fitOn: `${b.submitter}/${b.system}` };
        records.push({ t: now, target: `fleetscope:${b.gpu}|${modelFor(b.model, 'fleetscope')}`, tool: 'fleetscope', calib: f.calib, pass: f.pass, diagnosis: f.diagnosis, after: f.after, before: f.before, fitOn: b.system, source: 'fleetops-calibrate' });
      }
    }
    runs.push(run);
  }
  const heldOut = held.map(b => {
    const p = profile.sizer[`${b.gpu}|${modelFor(b.model, 'sizer')}`];
    const out = { system: b.system, gpu: b.gpu, model: b.model, qps: b.qps };
    if (p) {
      const x = sizerInputs(b, { islMean });
      out.sizerSpecSheet = x.error ? { error: x.error } : checkSizer(b, Object.fromEntries(EFF.map(e => [e, x.s[e]])), { islMean });
      out.sizerCalibrated = checkSizer(b, Object.fromEntries(EFF.map(e => [e, p[e]])), { islMean });
    }
    const fp = profile.fleetscope[`${b.gpu}|${modelFor(b.model, 'fleetscope')}`], bg = benchGraph(b);
    if (fleetscope && fp && !bg.error) {
      out.fleetscopeSpecSheet = checkFleetScopePool(bg.graph, bg.poolId, benchTarget(b, { islMean }), { prefill: 1, decode: 1 }, { instances: bg.instances, maxS });
      out.fleetscopeCalibrated = checkFleetScopePool(bg.graph, bg.poolId, benchTarget(b, { islMean }), fp.calib, { instances: bg.instances, maxS });
    }
    return out;
  });
  return { profile, runs, heldOut, records };
}

// Fit FleetScope pools of a graph to the serving records in a window. Pools are matched by node id or name.
// With `holdout` (0–1), the last share of the window is kept out of the fit and used to check it.
export function calibrateServing(store, graph, { from, to, holdout = 0, maxS = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  const pools = graph.nodes.filter(n => n.type === 'pool');
  const out = { profile: { version: 1, generatedAt: now, fleetscope: {} }, pools: [], records: [] };
  const recs = store.query('serving', { from, to });
  for (const n of pools) {
    const mine = recs.filter(r => r.pool === n.id || r.pool === n.cfg.name);
    if (!mine.length) { out.pools.push({ pool: n.id, name: n.cfg.name, skipped: 'no serving records' }); continue; }
    const cut = holdout > 0 ? mine[Math.floor(mine.length * (1 - holdout))].t : Infinity;
    const fitRecs = mine.filter(r => r.t < cut), testRecs = mine.filter(r => r.t >= cut);
    const target = servingTarget(fitRecs.length ? fitRecs : mine);
    const f = fitFleetScopePool(graph, n.id, target, { instances: n.cfg.autoscale ? undefined : n.cfg.instances, maxS });
    const row = { pool: n.id, name: n.cfg.name, gpu: n.cfg.gpu, target, ...f };
    if (testRecs.length && holdout > 0) row.heldOut = checkFleetScopePool(graph, n.id, servingTarget(testRecs), f.calib, { instances: n.cfg.autoscale ? undefined : n.cfg.instances, maxS });
    out.pools.push(row);
    out.profile.fleetscope[n.id] = { name: n.cfg.name, gpu: n.cfg.gpu, calib: f.calib, pass: f.pass, diagnosis: f.diagnosis, fitOn: { from: target.from, to: target.to, records: target.records } };
    out.records.push({ t: now, target: `fleetscope:${n.id}`, tool: 'fleetscope', pool: n.id, calib: f.calib, pass: f.pass, diagnosis: f.diagnosis, after: f.after, heldOut: row.heldOut, fitOn: { from: target.from, to: target.to, records: target.records }, source: 'fleetops-calibrate' });
  }
  return out;
}

// The latest window, simulated with the stored multipliers: outside the acceptance bar → a drift record.
export function driftCheck(store, graph, profile, { from, to, now = Math.floor(Date.now() / 1000), maxS = 300 } = {}) {
  const out = [];
  for (const n of graph.nodes.filter(x => x.type === 'pool')) {
    const p = (profile.fleetscope || {})[n.id] || (profile.fleetscope || {})[n.cfg.name];
    if (!p) continue;
    const recs = store.query('serving', { from, to, where: r => r.pool === n.id || r.pool === n.cfg.name });
    if (!recs.length) continue;
    const t = servingTarget(recs), chk = checkFleetScopePool(graph, n.id, t, p.calib, { instances: n.cfg.autoscale ? undefined : n.cfg.instances, maxS });
    const worst = chk.rows.filter(r => !r.pass).sort((a, b) => Math.abs(b.err) - Math.abs(a.err))[0];
    out.push({ t: now, target: `fleetscope:${n.id}`, pool: n.id, drifted: !chk.pass, rows: chk.rows, window: { from: t.from, to: t.to, records: t.records },
      why: worst ? `${worst.metric} measured ${worst.measured.toFixed(3)} s vs ${worst.simulated.toFixed(3)} s predicted (${(worst.err * 100).toFixed(0)}%, bar ${(worst.bar * 100).toFixed(0)}%): re-fit` : 'within the acceptance bar', source: 'fleetops-drift' });
  }
  return out;
}
