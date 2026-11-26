// Agent unit economics: what a successful task costs, what each fix is worth per successful task, and where hosting an
// open model yourself beats paying an API for the same work.
//
//   cost per resolved task   priced calls (list prices, recorded cost, or GPU time) over sessions with outcomes
//   fixes, ranked            each waste cause's avoidable cost, per resolved task, and what a step cap on sessions saves
//                            against the successes it costs (exact, from each session's own calls)
//   self-host vs API         the same workload (its real arrivals, prompt growth and cache reuse) sized with the
//                            Inference Sizer for an open model on a GPU, through FleetScope's agentic profile path
//                            (compute and the KV working set), against the API bill for it; or measured self-host
//                            prices per million tokens (OpenCost's llm_cost_per_million_tokens) instead of sizing.
//                            tokenScale: the open model needs k× the calls per task (e.g. SWE-bench's calls ratio).
//                            The answer is a break-even: the GPU-hour price under which self-hosting is cheaper per
//                            resolved task, and the volume at which it becomes cheaper at a given GPU-hour price.
//
// Everything here is a model. The self-host side is provisioned for the busiest day's peak, kept on all month
// (allocation-based cost), and assumes the open model needs as many calls per task as the API one unless told otherwise.
import { createRequire } from 'node:module';
import { sessionsOf, fresh } from './record.mjs';

const require = createRequire(import.meta.url);
const A = require('../../fleetscope/src/agentic.js'), C = require('../../inference-sizer/src/catalog.js'), M = require('../../inference-sizer/src/model.js');
const HOURS_PER_MONTH = 730, DAY = 86400;
const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);

// ---------- the workload ----------
export function period(calls, days = null) {
  const ts = calls.map(c => c.t).filter(Number.isFinite); let a = Infinity, b = -Infinity; for (const t of ts) { if (t < a) a = t; if (t > b) b = t; }
  const span = ts.length ? (b - a) / DAY : 0;
  return { from: ts.length ? a : null, to: ts.length ? b : null, days: days || Math.max(1, span), measured: !days, short: !days && span < 1 };
}
// llm_call records → FleetScope trace rows (prompt, output, cache hit, session, time)
export const rowsOf = calls => calls.filter(c => Number.isFinite(c.t) && c.input > 0).map(c => ({ t: c.t, isl: c.input, osl: Math.max(1, c.output || 1), cached: c.cacheRead ?? undefined, session: `${c.harness}|${c.session}`, agent: c.agent && c.agent !== 'main' ? c.agent : undefined, api: c.durS }));
// calendar days (UTC) by calls: the median active day, for a second sizing beside the busiest
export function typicalDay(rows) {
  const by = new Map(); for (const r of rows) { const d = Math.floor(r.t / DAY); if (!by.has(d)) by.set(d, []); by.get(d).push(r); }
  const days = [...by.values()].sort((a, b) => a.length - b.length); return days.length ? days[Math.floor((days.length - 1) / 2)] : [];
}
// the 24 hours with the most calls: self-hosted capacity is bought for the peak, not the average
export function busiestDay(rows) {
  const s = [...rows].sort((a, b) => a.t - b.t); let best = [0, 0], j = 0;
  for (let i = 0; i < s.length; i++) { while (s[i].t - s[j].t >= DAY) j++; if (i - j + 1 > best[1] - best[0]) best = [j, i + 1]; }
  return s.slice(best[0], best[1]);
}
// a workload x times as large: the same shape, x times the arrivals
export function scaleStats(st, x) {
  const k = (o, f) => (o ? Object.fromEntries(Object.entries(o).map(([a, v]) => [a, typeof v === 'number' ? f(v) : v])) : o);
  return Object.assign({}, st, { rps: k(st.rps, v => v * x), prefillTps: k(st.prefillTps, v => v * x), decodeTps: k(st.decodeTps, v => v * x), kvTokens: k(st.kvTokens, v => v * x), inflight: k(st.inflight, v => Math.max(1, Math.round(v * x))) });
}

// ---------- self-hosting: GPUs from the Inference Sizer ----------
// The sizer's production defaults: whole nodes, plus one spare node (spare: false drops it)
// calibration: a sizer profile ({ sizer: { "<gpu>|<model>": { effPrefill, effDecodeBW, effDecodeComp } } }) from fleetops
// calibrate or a promoted shadow upgrade: measured engine efficiencies instead of spec-sheet defaults
export function sizerSettings({ model = 'deepseek-v3', gpu = 'H200', ttft = 2000, tpot = 50, spare = true, calibration = null } = {}) {
  const m = C.MODELS.find(x => x.id === model), g = C.GPUS.find(x => x.id === gpu);
  if (!m) throw new Error(`unknown model ${model}: one of ${C.MODELS.map(x => x.id).join(', ')}`);
  if (!g) throw new Error(`unknown GPU ${gpu}: one of ${C.GPUS.map(x => x.id).join(', ')}`);
  const cal = calibration && calibration.sizer && (calibration.sizer[`${g.id}|${m.id}`] || calibration.sizer[`${g.id}|*`]);
  const eff = cal ? Object.fromEntries(['effPrefill', 'effDecodeBW', 'effDecodeComp', 'stepMs'].filter(k => typeof cal[k] === 'number').map(k => [k, cal[k]])) : {};
  return Object.assign({}, M.SETTINGS, m, g, eff, { ttft: +ttft, tpot: +tpot, ctx: m.maxCtx || M.SETTINGS.ctx, modelId: m.id, gpuId: g.id, nPlus1: spare !== false, calibrated: cal ? (cal.fitOn || 'calibration profile') : null });
}
// calls longer than the open model's context are capped to it (and counted: the open model can't serve them as they are)
export function peakStats(rows, s, { cacheTtlS = 300 } = {}) {
  let over = 0; const fit = rows.map(r => (r.isl + r.osl > s.ctx ? (over++, Object.assign({}, r, { isl: Math.max(1, s.ctx - r.osl), cached: r.cached != null ? Math.min(r.cached, s.ctx - r.osl - 1) : r.cached })) : r));
  const day = busiestDay(fit), typ = typicalDay(fit);
  return { stats: A.workloadStats(day, { cacheTtlS }), typical: typ.length ? A.workloadStats(typ, { cacheTtlS }) : null, overContext: over, calls: rows.length, peakDayCalls: day.length, typicalDayCalls: typ.length };
}
export function gpusFor(stats, s, x = 1) { const r = A.sizeFor(scaleStats(stats, x), s, M); return r; }

// ---------- outcomes and fixes ----------
export function perResolved(report) {
  const o = report.outcomes, t = report.totals, tasks = o.successes + o.failures + o.unknown;
  return { tasks, successes: o.successes, failures: o.failures, unknown: o.unknown, known: o.known, successRate: o.successes + o.failures ? o.successes / (o.successes + o.failures) : null,
    cost: t.cost, costPerTask: tasks ? t.cost / tasks : null, costPerResolved: o.successes ? t.cost / o.successes : null, spentOnFailures: o.costOnFailure, failShare: t.cost ? o.costOnFailure / t.cost : null };
}
// Exact step caps: stop each session after `cap` calls. The cost is its first `cap` calls' cost; a success that needed
// more calls is lost. (outcomes.mjs estimates the same from task totals when there are no per-call records.)
export function exactCaps(calls, caps = [10, 20, 30, 40, 50, 75, 100, 150, 200, 300]) {
  const sess = [...sessionsOf(calls).values()].map(cs => ({ calls: cs.length, cum: cs.reduce((a, c) => (a.push((a.at(-1) || 0) + (c.cost || 0)), a), []), outcome: (cs.find(c => c.outcome) || {}).outcome }));
  const known = sess.filter(s => s.outcome === 'success' || s.outcome === 'failure'); if (!known.length) return null;
  const cost0 = sum(known, s => s.cum.at(-1)), succ0 = known.filter(s => s.outcome === 'success').length, maxCalls = Math.max(...known.map(s => s.calls));
  return caps.filter(c => c < maxCalls).map(cap => {
    const cost = sum(known, s => s.cum[Math.min(cap, s.calls) - 1]), succ = known.filter(s => s.outcome === 'success' && s.calls <= cap).length;
    return { cap, saved: cost0 ? 1 - cost / cost0 : 0, successesLost: succ0 - succ, rateLossPts: 100 * (succ0 - succ) / known.length, costPerResolved: succ ? cost / succ : null };
  });
}
export function rankFixes(report, calls, { maxLossPts = 1 } = {}) {
  const t = report.totals, s = report.outcomes.successes || null, per = x => (s ? x / s : null);
  const rows = report.byCause.filter(c => !c.candidate && c.cost > 0).map(c => ({ cause: c.cause, label: c.label, fix: c.fix, saves: c.cost, share: t.cost ? c.cost / t.cost : null, perResolved: per(c.cost), kind: 'waste' }));
  const caps = exactCaps(calls), cap = caps && caps.filter(c => c.rateLossPts <= maxLossPts).sort((a, b) => b.saved - a.saved)[0];
  if (cap && cap.saved > 0) rows.push({ cause: 'step-cap', label: `Stop sessions after ${cap.cap} calls`, fix: `Cap agent loops at ${cap.cap} calls (or a spend limit): ${cap.successesLost} successes lost (${cap.rateLossPts.toFixed(1)} points).`, saves: cap.saved * t.cost, share: cap.saved, perResolved: per(cap.saved * t.cost), kind: 'cap', lostPts: cap.rateLossPts });
  rows.sort((a, b) => b.saves - a.saves);
  // fixes overlap (a capped session's waste is gone too), so the running total is bounded by the spend, and the step cap
  // is not added on top of the waste it would also remove: the cumulative column is an upper bound
  let cum = 0; for (const r of rows) { cum = Math.min(t.cost, cum + r.saves); r.cumulative = cum; r.costPerResolvedAfter = s ? (t.cost - cum) / s : null; }
  const candidates = report.byCause.filter(c => c.candidate && c.cost > 0).map(c => ({ cause: c.cause, label: c.label, saves: c.cost, perResolved: per(c.cost), fix: c.fix }));
  return { rows, candidates, caps };
}

// ---------- self-host vs API ----------
// api: { monthly } in the report's currency (or units, with unitPrice $ per unit); self: { gpus, rate? } or
// { pricePerM: { input, cacheRead?, output } } from measured self-host prices; success rates scale cost per resolved.
export function breakEven({ apiMonthly, apiRate = null, selfRate = null, gpus = null, gpuRate = null, unit = 1 }) {
  const q = apiRate && selfRate ? selfRate / apiRate : 1; // successes per task, self-host over API: fewer successes make each cost more
  const api$ = apiMonthly * unit;
  const rateStar = gpus ? api$ * q / (gpus * HOURS_PER_MONTH) : null; // the GPU-hour price at which both cost the same per resolved task
  const self$ = gpus && gpuRate != null ? gpus * gpuRate * HOURS_PER_MONTH : null;
  return { apiMonthly: api$, selfMonthly: self$, qualityRatio: q, breakEvenGpuRate: rateStar, cheaper: self$ == null ? null : self$ / q < api$ ? 'self-host' : 'api', perResolvedRatio: self$ == null || !api$ ? null : (self$ / q) / api$ };
}
// the volume (× today's) from which self-hosting is cheaper per resolved task at gpuRate: API cost grows with volume,
// self-hosted cost in steps of GPUs
export function breakEvenVolume(stats, s, { apiMonthly, gpuRate, q = 1, unit = 1, base = 1, lo = 1 / 64, hi = 256 } = {}) {
  const pts = []; for (let x = lo; x <= hi * 1.0001; x *= Math.SQRT2) pts.push(x);
  const at = x => { const r = gpusFor(stats, s, base * x); return { x, gpus: r.gpus, api: apiMonthly * unit * x, self: r.gpus == null ? null : r.gpus * gpuRate * HOURS_PER_MONTH / q }; };
  const curve = pts.map(at), first = curve.find(p => p.self != null && p.self < p.api);
  return { curve, from: first ? first.x : null, note: first ? null : `not cheaper anywhere up to ${hi / base >= 1 ? Math.round(hi / base) : hi}× today's volume` };
}

export function economics(calls, report, opt = {}) {
  const P = period(calls, opt.days), scale = opt.tasksPerDay ? opt.tasksPerDay / (report.totals.sessions / P.days) : opt.scale || 1;
  const monthly = report.totals.cost / P.days * 30.4 * scale, units = report.pricing && report.pricing.currency === 'units';
  const tok = k => sum(calls, k) / P.days * 30.4 * scale;
  const volume = { days: P.days, measured: P.measured, short: P.short, scale, sessionsPerDay: report.totals.sessions / P.days * scale, callsPerDay: calls.length / P.days * scale,
    monthTokens: { fresh: tok(fresh), cacheRead: tok(c => c.cacheRead), cacheWrite: tok(c => c.cacheWrite), output: tok(c => c.output) }, apiMonthly: monthly, currency: report.pricing ? report.pricing.currency : 'USD' };
  const out = { volume, perResolved: perResolved(report), fixes: rankFixes(report, calls, opt), selfHost: null };
  const apiRate = opt.apiSuccessRate ?? out.perResolved.successRate ?? null, selfRate = opt.selfSuccessRate ?? apiRate;
  const tokenScale = opt.tokenScale || 1;
  if (opt.selfHostPrice) { // measured self-host prices: no sizing
    const p = opt.selfHostPrice, m = volume.monthTokens, self = tokenScale * ((m.fresh + m.cacheWrite) * p.input + m.cacheRead * (p.cacheRead ?? 0) + m.output * p.output) / 1e6;
    const q = apiRate && selfRate ? selfRate / apiRate : 1, api$ = monthly * (units ? (opt.unitPrice || 1) : 1);
    out.selfHost = { source: p.source || 'measured self-host prices per million tokens', monthly: self, apiMonthly: api$, qualityRatio: q, cheaper: self / q < api$ ? 'self-host' : 'api', perResolvedRatio: api$ ? (self / q) / api$ : null };
    return out;
  }
  if (opt.model || opt.gpu) {
    // tokenScale: the open model makes k× the calls per task (same shape), so it serves k× the arrivals for the same work
    const s = sizerSettings(opt), rows = rowsOf(calls), k = scale * tokenScale;
    const pk = peakStats(rows, s, opt), sized = gpusFor(pk.stats, s, k), sizedTyp = pk.typical ? gpusFor(pk.typical, s, k) : null;
    const unit = units ? (opt.unitPrice || 1) : 1, be = breakEven({ apiMonthly: monthly, apiRate, selfRate, gpus: sized.gpus, gpuRate: opt.gpuRate ?? null, unit });
    out.selfHost = { model: s.modelId, gpu: s.gpuId, ttft: s.ttft, tpot: s.tpot, calibrated: s.calibrated, gpus: sized.gpus, compute: sized.compute, kvGpus: sized.kvGpus, bound: sized.bound, mode: sized.mode,
      peak: { calls: pk.peakDayCalls, rpsP95: pk.stats.rps.p95 * k, cacheHit: pk.stats.cacheHit, kvTokensP95: pk.stats.kvTokens.p95 * k }, overContext: pk.overContext, overContextShare: pk.calls ? pk.overContext / pk.calls : 0, tokenScale, spare: s.nPlus1,
      typicalDay: sizedTyp ? { calls: pk.typicalDayCalls, gpus: sizedTyp.gpus, breakEvenGpuRate: breakEven({ apiMonthly: monthly, apiRate, selfRate, gpus: sizedTyp.gpus, unit: units ? (opt.unitPrice || 1) : 1 }).breakEvenGpuRate } : null,
      successRates: { api: apiRate, self: selfRate, assumed: opt.selfSuccessRate == null }, gpuRate: opt.gpuRate ?? null, unitPrice: units ? unit : null, ...be };
    if (opt.gpuRate != null && sized.gpus) {
      out.selfHost.volume = breakEvenVolume(pk.stats, s, { apiMonthly: monthly, gpuRate: opt.gpuRate, q: be.qualityRatio, unit, base: k });
      // many teams' bursts don't line up: sized on a typical day's shape, the crossover is an optimistic bound
      if (pk.typical) out.selfHost.volumeTypical = breakEvenVolume(pk.typical, s, { apiMonthly: monthly, gpuRate: opt.gpuRate, q: be.qualityRatio, unit, base: k });
    }
  }
  return out;
}

// ---------- text ----------
const $f = (n, cur) => (n == null || !Number.isFinite(n) ? '–' : cur === 'units' ? (n >= 100 ? n.toFixed(0) : n.toFixed(2)) + ' u' : n >= 1e4 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 100 ? '$' + n.toFixed(0) : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3));
const P = x => (x == null || !Number.isFinite(x) ? '–' : `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`);
const N = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
export function economicsText(E) {
  const v = E.volume, r = E.perResolved, cur = v.currency, $ = n => $f(n, cur), L = [];
  L.push(`Agent unit economics over ${v.days.toFixed(v.days < 10 ? 1 : 0)} days${v.scale !== 1 ? ` (scaled ×${v.scale.toFixed(2)})` : ''}${v.short ? ' (under a day of timestamps: pass --days or --tasks-per-day for monthly figures)' : ''}`);
  L.push(`  ${v.sessionsPerDay.toFixed(1)} sessions and ${N(v.callsPerDay)} calls a day; ${$(v.apiMonthly)} a month at this rate`);
  if (r.known) L.push(`  ${r.successes} of ${r.successes + r.failures} tasks succeeded (${P(r.successRate)}): ${$(r.costPerResolved)} per resolved task, ${$(r.costPerTask)} per task; ${P(r.failShare)} of spend went to tasks that failed`);
  else L.push('  no outcomes: pass --outcomes (session → success/failure) for cost per resolved task');
  L.push('', 'Fixes, ranked by what they save' + (r.known ? ' (per resolved task)' : '') + ':');
  for (const f of E.fixes.rows.slice(0, 8)) L.push(`  ${$(f.saves).padStart(10)}  ${P(f.share).padStart(4)}${r.known ? `  ${$(f.perResolved).padStart(8)}/resolved → ${$(f.costPerResolvedAfter).padStart(8)}` : ''}  ${f.label}`);
  if (!E.fixes.rows.length) L.push('  nothing found');
  if (E.fixes.rows.length) L.push(`  together at most ${$(E.fixes.rows.at(-1).cumulative)} (${P(E.fixes.rows.at(-1).cumulative / r.cost)}): fixes overlap, so this is an upper bound`);
  for (const c of E.fixes.candidates) L.push(`  candidate: ${c.label}, ${$(c.saves)}: check task success before switching`);
  const S = E.selfHost;
  if (S && S.model) {
    L.push('', `Self-hosting ${S.model} on ${S.gpu} (TTFT ${S.ttft} ms, TPOT ${S.tpot} ms${S.calibrated ? `; measured efficiencies: ${S.calibrated}` : '; spec-sheet efficiencies'}) for the busiest day's peak: ${S.gpus ?? 'no layout meets the targets'} GPUs (compute ${S.compute ?? '–'}, KV working set ${S.kvGpus}; bound by ${S.bound}; whole nodes${S.spare ? ', one spare' : ''})`);
    L.push(`  peak ${S.peak.rpsP95.toFixed(2)} calls/s (p95 minute of the busiest day, ${N(S.peak.calls)} calls), cache hit ${P(S.peak.cacheHit)}${S.typicalDay ? `; a typical day (${N(S.typicalDay.calls)} calls) needs ${S.typicalDay.gpus ?? '–'}` : ''}`);
    if (S.overContext) L.push(`  ${P(S.overContextShare)} of calls are longer than ${S.model}'s context: capped here, which flatters self-hosting (the open model would need compaction, or can't do those tasks as they are)`);
    if (S.successRates.api != null) L.push(`  success: API ${P(S.successRates.api)}, self-hosted ${P(S.successRates.self)}${S.successRates.assumed ? ' (assumed the same: pass --self-host-success-rate)' : ''}`);
    const r$ = x => (x == null ? '–' : '$' + (x >= 0.1 ? x.toFixed(2) : x.toPrecision(2)));
    if (S.breakEvenGpuRate != null) L.push(`  break-even: self-hosting is cheaper per resolved task below ${r$(S.breakEvenGpuRate)} per GPU-hour${S.typicalDay ? ` (${r$(S.typicalDay.breakEvenGpuRate)} if sized for a typical day)` : ''}${cur === 'units' ? `, at $${S.unitPrice} per relative unit (--unit-price)` : ''}`);
    if (S.selfMonthly != null) L.push(`  at $${S.gpuRate}/GPU-hour: ${$f(S.selfMonthly, 'USD')} a month self-hosted vs ${$f(S.apiMonthly, 'USD')} on the API → ${S.cheaper === 'self-host' ? 'self-hosting' : 'the API'} is cheaper (${(S.perResolvedRatio).toFixed(2)}× per resolved task)`);
    const xf = v => (v.from == null ? null : `${v.from < 1 ? v.from.toFixed(2) : v.from.toFixed(1)}×`);
    if (S.volume) L.push(`  volume where self-hosting becomes cheaper: ${xf(S.volume) ? `about ${xf(S.volume)} this volume with this workload's own bursts` : S.volume.note.replace(/^not cheaper anywhere/, 'never with this workload\'s own bursts,')}${S.volumeTypical ? `; ${xf(S.volumeTypical) ? `about ${xf(S.volumeTypical)}` : 'never'} if peaks were like a typical day (many teams' bursts don't line up)` : ''}`);
  } else if (S) L.push('', `Self-hosted at measured prices (${S.source}): ${$f(S.monthly, 'USD')} a month vs ${$f(S.apiMonthly, 'USD')} on the API → ${S.cheaper === 'self-host' ? 'self-hosting' : 'the API'} is cheaper (${S.perResolvedRatio.toFixed(2)}× per resolved task)`, '  measured prices hold at the utilization they were measured at: a much smaller or larger volume changes them (size it with --self-host-model instead)');
  return L.join('\n') + '\n';
}
