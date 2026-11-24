// Tuning: what to change in the infrastructure, from the traces, with the effect each change should have and how to
// measure whether it had it.
//
// Every recommendation carries:
//   evidence   the numbers from the traces that led to it
//   change     the knobs, from → to
//   impact     the expected effect, with its basis:
//                measured     a contrast in the data itself (windows with and without the condition)
//                model        a model fed with measured inputs (Young/Daly; the Inference Sizer; calibrated or not)
//                upper bound  the most the change can recover (all the time lost to the cause)
//   verify     the metric that should move, so `tune verify` can measure it after the change
// Recommendations are ranked by GPU-hours a week (latency items by how far they are from target).
import { createRequire } from 'node:module';
import { goodput } from './goodput.mjs';
import { fromGpuHealth } from './optimize.mjs';
import { loadConfig as ghLoad, priceFor } from '../../gpu-health/src/config.mjs';

const require = createRequire(import.meta.url);
const SM = require('../../inference-sizer/src/model.js'), SC = require('../../inference-sizer/src/catalog.js');
const H = 3600, D = 86400, WEEK = 7 * D;
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };
const med = a => q(a, 0.5);
const r1 = v => Math.round(v * 10) / 10, pct = v => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const mins = s => (s >= 5400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
const ms = s => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);

// ---------- training ----------
function training(g, store, win, perWeek) {
  const out = [];
  for (const j of g.jobs) {
    if (j.resolution !== 'step') continue;
    const tot = j.totalGpuHours, share = c => j.gpuHours[c] / tot;
    // checkpoint interval (Young/Daly with the measured save cost and interruption rate)
    const a = j.advice;
    if (a && a.verdict !== 'about right' && a.gpuHoursPerWeekSaved >= 1) out.push({
      id: `checkpoint:${j.job}`, area: 'training', target: j.job, title: `${a.verdict === 'checkpoint more often' ? 'Checkpoint more often' : 'Checkpoint less often'}: every ${mins(a.bestIntervalS)} instead of ${mins(a.intervalS)}`,
      evidence: [`saves block training ${Math.round(a.deltaS)} s each`, `the fleet interrupts a ${j.gpus}-GPU job every ${mins(a.mtbiS)} on average`, `lost work ${pct(share('lost-work'))} and checkpoint saves ${pct(share('checkpoint'))} of the job's GPU-hours`],
      change: { summary: `checkpoint interval ${mins(a.intervalS)} → ${mins(a.bestIntervalS)}`, knobs: [{ name: 'checkpoint interval (e.g. save_interval / --save-interval steps)', from: mins(a.intervalS), to: mins(a.bestIntervalS) }] },
      impact: { gpuHoursPerWeek: a.gpuHoursPerWeekSaved, metric: 'lost work + checkpoint + restart share', now: (j.gpuHours['lost-work'] + j.gpuHours.checkpoint + j.gpuHours.restart) / tot, expected: Math.max(0, (j.gpuHours['lost-work'] + j.gpuHours.checkpoint + j.gpuHours.restart) / tot - a.gpuHoursPerWeekSaved / (tot * perWeek)), basis: 'model', note: 'Young/Daly with the measured save cost and interruption rate' },
      confidence: j.attempts >= 5 ? 'high' : 'medium', verify: { metric: 'job.share', scope: j.job, categories: ['lost-work', 'checkpoint', 'restart'], direction: 'down' },
    });
    // input pipeline
    if (share('data-stall') >= 0.03) out.push({
      id: `data-pipeline:${j.job}`, area: 'training', target: j.job, title: `Feed ${j.job} faster: ${pct(share('data-stall'))} of its GPU-hours wait on data`,
      evidence: [`steps wait ${pct(share('data-stall'))} of the time on the input pipeline (step dataS)`, `${r1(j.gpuHours['data-stall'] * perWeek)} GPU-hours a week`],
      change: { summary: 'more loader parallelism and prefetch; data closer to the GPUs', knobs: [{ name: 'DataLoader num_workers', to: '2× now (up to CPU cores per GPU)' }, { name: 'prefetch_factor', to: '4' }, { name: 'pin_memory / persistent_workers', to: 'true' }, { name: 'dataset location', to: 'local NVMe cache or a faster tier, if reads are remote' }] },
      impact: { gpuHoursPerWeek: j.gpuHours['data-stall'] * perWeek, metric: 'waiting-on-data share', now: share('data-stall'), expected: 0, basis: 'upper bound', note: 'all of the data wait; a faster pipeline recovers most of it once it outpaces the steps' },
      confidence: 'high', verify: { metric: 'job.share', scope: j.job, categories: ['data-stall'], direction: 'down' },
    });
    // slow steps: one node, or a period
    if (share('slow-steps') >= 0.05) {
      const s = slowSteps(store, j, win);
      out.push({
        id: `slow-steps:${j.job}`, area: 'training', target: s.node ? `${j.job} on ${s.node}` : j.job,
        title: s.node ? `Take ${s.node} out of ${j.job}: its steps are ${s.ratio.toFixed(2)}× the others'` : s.period ? `Find what slowed ${j.job} from ${s.period}` : `Steady the step time of ${j.job}`,
        evidence: [`${pct(share('slow-steps'))} of the job's GPU-hours are step time above its own best pace (${j.idealStepS ? ms(j.idealStepS) : '?'} a step)`, ...s.evidence],
        change: s.node ? { summary: `replace ${s.node} (swap at the next checkpoint) and run gpu-health diag on it`, knobs: [{ name: 'node', from: s.node, to: 'a healthy spare' }] }
          : s.period ? { summary: `diagnose the window (fleetops rca diagnose --symptom training-slow --job ${j.job} --from … --to …); undo or fix what it names`, knobs: [] }
            : { summary: 'look for jitter: locked or throttled clocks, thermal limits, noisy neighbours, NCCL settings', knobs: [] },
        impact: { gpuHoursPerWeek: j.gpuHours['slow-steps'] * perWeek, metric: 'slow-step share', now: share('slow-steps'), expected: 0, basis: 'upper bound', note: 'all time above the job\'s own best pace' },
        confidence: s.node || s.period ? 'medium' : 'low', verify: { metric: 'job.share', scope: j.job, categories: ['slow-steps'], direction: 'down' },
      });
    }
    // restarts: time from a restarted attempt's start to its first step
    // whole restarts only (an attempt that began before the window has only part of its restart inside it)
    const ra = (j.attemptsList || []).filter(x => x.n > 1 && x.start >= win.from && x.toFirstStepS > 0), rs = ra.map(x => x.toFirstStepS);
    const best = rs.length ? Math.min(...rs) : 0, excess = ra.reduce((t, x) => t + Math.max(0, x.toFirstStepS - best) * x.gpus / H, 0);
    if (rs.length >= 2 && share('restart') >= 0.02 && excess * perWeek >= Math.max(10, 0.01 * tot * perWeek)) {
      out.push({
        id: `restart:${j.job}`, area: 'training', target: j.job, title: `Restart ${j.job} faster: median ${mins(med(rs))} from a new attempt to its first step`,
        evidence: [`${rs.length} restarts: median ${mins(med(rs))}, fastest ${mins(best)}`, `${pct(share('restart'))} of the job's GPU-hours`],
        change: { summary: 'keep restarts near the fastest one: warm spare nodes, images already pulled, checkpoints loaded from local or peer storage', knobs: [{ name: 'spare nodes', to: '1–2 warm, already passed burn-in' }, { name: 'checkpoint load', to: 'local NVMe or peer copy (async save keeps one)' }, { name: 'image', to: 'pre-pulled on every node' }] },
        impact: { gpuHoursPerWeek: excess * perWeek, metric: 'restart share', now: share('restart'), expected: share('restart') - excess / tot, basis: 'measured', note: `every restart as fast as the fastest seen (${mins(best)})` },
        confidence: 'medium', verify: { metric: 'job.share', scope: j.job, categories: ['restart'], direction: 'down' },
      });
    }
    // exposed communication, from step commS when logged
    const comm = commShare(store, j.job, win);
    if (comm && comm.share >= 0.2) out.push({
      id: `comm:${j.job}`, area: 'training', target: j.job, title: `Hide more of ${j.job}'s communication: ${pct(comm.share)} of a step waits on it`,
      evidence: [`median exposed communication ${ms(comm.commS)} of a ${ms(comm.durS)} step`, ...(comm.busbw ? [`NCCL bus bandwidth median ${comm.busbw.med.toFixed(0)} GB/s, best ${comm.busbw.p95.toFixed(0)} GB/s for the same operations`] : [])],
      change: { summary: 'overlap communication with compute and check the fabric', knobs: [{ name: 'DDP bucket_cap_mb / FSDP backward_prefetch', to: 'larger buckets; BACKWARD_PRE' }, { name: 'NCCL', to: 'check NCCL_IB_HCA, NCCL_NET_GDR_LEVEL, NCCL_NCHANNELS_PER_NET_PEER against the topology' }, ...(comm.busbw && comm.busbw.med < 0.7 * comm.busbw.p95 ? [{ name: 'fabric', to: `bandwidth varies (median ${Math.round(comm.busbw.med / comm.busbw.p95 * 100)}% of best): run fleetops rca on slow-link` }] : [])] },
      impact: { gpuHoursPerWeek: comm.excess * j.gpus * perWeek / H, metric: 'exposed communication per step', now: comm.share, expected: comm.floor, basis: 'upper bound', note: 'communication above the job\'s best 10% of steps' },
      confidence: 'low', verify: { metric: 'job.comm', scope: j.job, direction: 'down' },
    });
  }
  return out;
}

// Which node (from per-rank step records) or which period made the steps slow.
function slowSteps(store, j, win) {
  const steps = store.query('step', { from: win.from, to: win.to, where: s => String(s.job).split('#')[0] === j.job && Number.isFinite(s.durS) });
  const byNode = new Map();
  for (const s of steps) if (s.node) { if (!byNode.has(s.node)) byNode.set(s.node, []); byNode.get(s.node).push(s.durS); }
  if (byNode.size >= 3) {
    const meds = [...byNode].map(([n, v]) => [n, med(v)]).sort((a, b) => b[1] - a[1]), others = med(meds.slice(1).map(x => x[1]));
    if (meds[0][1] >= 1.15 * others) return { node: meds[0][0], ratio: meds[0][1] / others, evidence: [`median step on ${meds[0][0]} ${ms(meds[0][1])}, others ${ms(others)} (${byNode.size} nodes logging)`] };
  }
  // a period: days whose median step time stands out from the job's best days
  const byDay = new Map();
  for (const s of steps) { const d = Math.floor(s.t / D) * D; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(s.durS); }
  const days = [...byDay].map(([d, v]) => [d, med(v)]).sort((a, b) => a[0] - b[0]), best = q(days.map(x => x[1]), 0.25);
  const bad = days.filter(x => x[1] > 1.15 * best);
  if (bad.length && bad.length < days.length) {
    const day = t => new Date(t * 1000).toISOString().slice(0, 10);
    return { period: `${day(bad[0][0])} to ${day(bad[bad.length - 1][0] + D)}`, evidence: [`median step ${ms(med(bad.map(x => x[1])))} on ${bad.length} day(s), against ${ms(best)} on its better days`] };
  }
  return { evidence: [] };
}
function commShare(store, job, win) {
  const st = store.query('step', { from: win.from, to: win.to, where: s => String(s.job).split('#')[0] === job && Number.isFinite(s.commS) && s.durS > 0 });
  if (st.length < 20) return null;
  const sh = st.map(s => s.commS / s.durS), floor = q(sh, 0.1), commS = med(st.map(s => s.commS)), durS = med(st.map(s => s.durS));
  const coll = store.query('collective', { from: win.from, to: win.to, where: c => c.job === job && Number.isFinite(c.busbw) });
  return { share: med(sh), floor, commS, durS, excess: st.reduce((t, s) => t + Math.max(0, s.commS - floor * s.durS) * (s.n || 1), 0), // seconds of wall time per GPU
    busbw: coll.length >= 10 ? { med: med(coll.map(c => c.busbw)), p95: q(coll.map(c => c.busbw), 0.95) } : null };
}

// ---------- inference ----------
function sizerSettings(pool, cfg, load, targets, calibration) {
  const g = SC.GPUS.find(x => x.id === cfg.gpu), m = SC.MODELS.find(x => x.id === cfg.model);
  if (!g || !m) return null;
  const s = Object.assign({}, SM.SETTINGS, m, g, { model: m.id, gpu: g.id, dau: load.rate * 86400, rpu: 1, peakFactor: 1, concSource: 'dau', conc: 0,
    avgIn: load.isl, peakIn: load.islP99, avgOut: load.osl, peakOut: load.oslP99, ttft: Math.round((targets.ttftP99 || 2) * 1000), tpot: Math.round((targets.tpotP99 || 0.05) * 1000),
    mode: cfg.mode || 'auto', kvprec: cfg.kvprec || 'fp8', wprec: cfg.wprec || SM.SETTINGS.wprec || 'fp8' });
  const cal = (calibration || []).filter(c => c.target === `sizer:${g.id}|${m.id}`).sort((a, b) => b.t - a.t)[0];
  if (cal && cal.eff) Object.assign(s, cal.eff);
  return { s, calibrated: !!(cal && cal.eff) };
}
function inference(store, win, { pools = {}, targets = {}, calibration }) {
  const out = [], perWeek = WEEK / (win.to - win.from);
  const serving = store.query('serving', { from: win.from, to: win.to });
  const reqs = store.query('request', { from: win.from, to: win.to, where: r => r.pool && r.isl > 0 && r.osl > 0 });
  const names = [...new Set([...serving.map(r => r.pool), ...reqs.map(r => r.pool)])];
  for (const pool of names) {
    const sv = serving.filter(r => r.pool === pool), rq = reqs.filter(r => r.pool === pool), tg = targets[pool] || {}, cfg = pools[pool] || {};
    // KV cache pressure: latency in full-cache windows against the rest (a contrast in the data itself)
    const kv = sv.filter(r => Number.isFinite(r.kvUsage) && Number.isFinite(r.ttftP99));
    if (kv.length >= 6) {
      const hi = kv.filter(r => r.kvUsage >= 0.9), lo = kv.filter(r => r.kvUsage < 0.8), pre = sv.reduce((t, r) => t + (r.preemptions || 0), 0);
      if (hi.length >= 3 && lo.length >= 3 && med(hi.map(r => r.ttftP99)) > 1.3 * med(lo.map(r => r.ttftP99))) out.push({
        id: `kv-cache:${pool}`, area: 'inference', target: pool, title: `Give ${pool} more KV cache: TTFT p99 is ${(med(hi.map(r => r.ttftP99)) / med(lo.map(r => r.ttftP99))).toFixed(1)}× when the cache is full`,
        evidence: [`KV cache ≥ 90% full in ${pct(hi.length / kv.length)} of windows`, `TTFT p99 ${ms(med(hi.map(r => r.ttftP99)))} then, ${ms(med(lo.map(r => r.ttftP99)))} below 80%`, ...(pre ? [`${pre} preemptions in the window`] : [])],
        change: { summary: 'more KV room per replica, or more replicas', knobs: [{ name: '--kv-cache-dtype', to: 'fp8 (half the bytes per token), if not already' }, { name: '--gpu-memory-utilization', to: '0.92–0.95 if headroom allows' }, { name: '--max-num-seqs', to: 'lower, so admitted requests keep their cache' }, { name: 'replicas', to: 'one more, if the above is not enough' }] },
        impact: { metric: 'TTFT p99', now: med(kv.map(r => r.ttftP99)), expected: med(lo.map(r => r.ttftP99)), unit: 's', basis: 'measured', note: 'the pool\'s own TTFT p99 when its cache was below 80% full', latency: true, fromTarget: tg.ttftP99 ? med(hi.map(r => r.ttftP99)) / tg.ttftP99 : null },
        confidence: hi.length >= 10 ? 'high' : 'medium', verify: { metric: 'pool.ttftP99', scope: pool, direction: 'down' },
      });
    }
    // sizing with the Inference Sizer: per 5-minute window of measured load
    const rate = loadSeries(rq, sv, win);
    if (!rate || !cfg.model || !cfg.gpu) continue;
    const isl = rq.length ? med(rq.map(r => r.isl)) : med(sv.map(r => r.islMean)), osl = rq.length ? med(rq.map(r => r.osl)) : med(sv.map(r => r.oslMean));
    const islP99 = rq.length ? q(rq.map(r => r.isl), 0.99) : isl * 4, oslP99 = rq.length ? q(rq.map(r => r.osl), 0.99) : osl * 4;
    if (!(isl > 0 && osl > 0)) continue;
    const cache = new Map(), gpusFor = lam => {
      const k = +lam.toPrecision(2);
      if (!cache.has(k)) { const x = sizerSettings(pool, cfg, { rate: k, isl, osl, islP99, oslP99 }, tg, calibration); const p = x && SM.plan(x.s, { noSens: true }); cache.set(k, p && p.chosen ? { gpus: p.chosen.provGPUs, mode: p.chosen.mode, reason: p.reason, calibrated: x.calibrated } : null); }
      return cache.get(k);
    };
    const peak = gpusFor(q(rate.map(r => r.rate), 0.99)), mean = gpusFor(med(rate.map(r => r.rate)));
    if (!peak) { out.push({ id: `size:${pool}`, area: 'inference', target: pool, title: `${pool}: no layout of ${cfg.model} on ${cfg.gpu} meets the targets at this load`, evidence: [`p99 load ${q(rate.map(r => r.rate), 0.99).toFixed(1)} req/s, ISL ${Math.round(isl)}, OSL ${Math.round(osl)}`], change: { summary: 'relax the targets, a bigger GPU, or a smaller model', knobs: [] }, impact: { metric: 'meets targets', basis: 'model' }, confidence: 'low', verify: null }); continue; }
    const basis = peak.calibrated ? 'model (calibrated)' : 'model (spec sheets, uncalibrated)';
    if (cfg.gpus) {
      if (cfg.gpus > peak.gpus * 1.15) out.push({
        id: `size:${pool}`, area: 'inference', target: pool, title: `Shrink ${pool} from ${cfg.gpus} to ${peak.gpus} GPUs: that still meets the targets at its p99 load`,
        evidence: [`load p99 ${q(rate.map(r => r.rate), 0.99).toFixed(2)} req/s (5-minute windows), ISL ${Math.round(isl)} / OSL ${Math.round(osl)} tokens`, `Inference Sizer: ${peak.gpus} ${cfg.gpu} for ${cfg.model} (${peak.mode}) with its 15% headroom and N+1 spare`, peak.reason],
        change: { summary: `${pool}: ${cfg.gpus} → ${peak.gpus} GPUs (${peak.mode})`, knobs: [{ name: 'replicas × GPUs', from: cfg.gpus, to: peak.gpus }] },
        impact: { gpuHoursPerWeek: (cfg.gpus - peak.gpus) * 168, metric: 'TTFT p99 within target', basis, note: 'check with a FleetScope replay of this window before applying' },
        confidence: peak.calibrated ? 'medium' : 'low', verify: { metric: 'pool.ttftP99', scope: pool, direction: 'flat', target: tg.ttftP99 },
      });
      else if (cfg.gpus < peak.gpus) out.push({
        id: `size:${pool}`, area: 'inference', target: pool, title: `Grow ${pool} from ${cfg.gpus} to ${peak.gpus} GPUs to meet its targets at p99 load`,
        evidence: [`load p99 ${q(rate.map(r => r.rate), 0.99).toFixed(2)} req/s, ISL ${Math.round(isl)} / OSL ${Math.round(osl)}`, `Inference Sizer: ${peak.gpus} ${cfg.gpu} needed (${peak.mode})`],
        change: { summary: `${pool}: ${cfg.gpus} → ${peak.gpus} GPUs`, knobs: [{ name: 'replicas × GPUs', from: cfg.gpus, to: peak.gpus }] },
        impact: { gpuHoursPerWeek: -(peak.gpus - cfg.gpus) * 168, metric: 'TTFT p99', basis, latency: true }, confidence: 'medium', verify: { metric: 'pool.ttftP99', scope: pool, direction: 'down' },
      });
    }
    // autoscaling: GPUs the measured load needs window by window, against a pool sized for the peak
    const need = rate.map(r => ({ t: r.t, g: (gpusFor(r.rate) || peak).gpus }));
    const saved = need.reduce((t, x) => t + (peak.gpus - x.g), 0) * (rate.length > 1 ? (rate[1].t - rate[0].t) : 300) / H;
    if (peak.gpus > (mean ? mean.gpus : peak.gpus) && saved * perWeek >= 8) out.push({
      id: `autoscale:${pool}`, area: 'inference', target: pool, title: `Autoscale ${pool} between ${Math.min(...need.map(x => x.g))} and ${peak.gpus} GPUs: its load swings ${(q(rate.map(r => r.rate), 0.99) / Math.max(1e-9, med(rate.map(r => r.rate)))).toFixed(1)}× from median to p99`,
      evidence: [`requests per 5 minutes: median ${med(rate.map(r => r.rate)).toFixed(2)} req/s, p99 ${q(rate.map(r => r.rate), 0.99).toFixed(2)} req/s`, `the Inference Sizer needs ${mean ? mean.gpus : '?'} GPUs at the median and ${peak.gpus} at p99`],
      change: { summary: `scale on load between ${Math.min(...need.map(x => x.g))} and ${peak.gpus} GPUs (scale up ahead of the peak; keep N+1)`, knobs: [{ name: 'autoscaler min / max', to: `${Math.min(...need.map(x => x.g))} / ${peak.gpus} GPUs` }, { name: 'scale-up signal', to: 'queue depth or KV usage, not CPU' }] },
      impact: { gpuHoursPerWeek: saved * perWeek, metric: 'GPU-hours against a pool sized for p99', basis, note: 'assumes scaling keeps up with the load; replay the window in FleetScope to check TTFT during ramps' },
      confidence: 'low', verify: { metric: 'pool.ttftP99', scope: pool, direction: 'flat', target: tg.ttftP99 },
    });
  }
  return out;
}
// Requests per second per 5-minute window: from request records, else from serving windows' rate.
function loadSeries(rq, sv, win, step = 300) {
  if (rq.length >= 50) {
    const b = new Map();
    for (const r of rq) { const k = Math.floor(r.t / step) * step; b.set(k, (b.get(k) || 0) + 1); }
    let lo = Infinity, hi = -Infinity;
    for (const r of rq) { if (r.t < lo) lo = r.t; if (r.t > hi) hi = r.t; }
    const t0 = Math.floor(lo / step) * step, t1 = Math.floor(hi / step) * step, out = [];
    for (let t = t0; t <= t1; t += step) out.push({ t, rate: (b.get(t) || 0) / step });
    return out;
  }
  const w = sv.filter(r => Number.isFinite(r.rate));
  return w.length >= 6 ? w.map(r => ({ t: r.t, rate: r.rate })) : null;
}

// ---------- fleet ----------
function fleet(store, win, g, { prices = {}, cfg } = {}) {
  const out = [], perWeek = WEEK / (win.to - win.from);
  // nodes in far more failed attempts than their share of the GPU-hours
  const failed = store.query('job', { from: win.from, to: win.to, where: j => ['failed', 'timeout', 'retried'].includes(j.status) && j.cause !== 'app' });
  const places = new Map(store.query('placement', { to: win.to, where: p => p.end == null || p.end > win.from }).map(p => [String(p.job), p]));
  const blame = new Map(), hours = new Map();
  for (const p of places.values()) { const s = Math.max(p.start ?? p.t, win.from), e = Math.min(p.end ?? win.to, win.to); if (e <= s) continue; const ns = [...new Set((p.devices || []).map(d => d.node).concat(p.node || []))]; for (const n of ns) hours.set(n, (hours.get(n) || 0) + (e - s) * (p.devices || []).filter(d => d.node === n).length / H); }
  let attributed = 0;
  for (const j of failed) {
    const p = places.get(String(j.job)), ns = j.node ? [j.node] : [...new Set(((p && p.devices) || []).map(d => d.node).concat((j.nodes || [])))];
    if (!ns.length) continue;
    attributed++;
    for (const n of ns) blame.set(n, (blame.get(n) || 0) + 1 / ns.length);
  }
  const totH = [...hours.values()].reduce((a, b) => a + b, 0), lostH = g.fleet.gpuHours['lost-work'] + g.fleet.gpuHours.restart;
  if (attributed >= 10 && totH > 0) {
    const rows = [...blame].map(([n, b]) => ({ n, b, exp: attributed * (hours.get(n) || 0) / totH })).filter(r => r.b >= 3 && r.exp > 0 && r.b / r.exp >= 3).sort((a, b) => b.b - a.b).slice(0, 10);
    if (rows.length) {
      const share = rows.reduce((t, r) => t + r.b, 0) / attributed, hShare = rows.reduce((t, r) => t + (hours.get(r.n) || 0), 0) / totH;
      out.push({
        id: 'flaky-nodes', area: 'fleet', target: rows.map(r => r.n).join(', '), title: `Drain and test ${rows.length} node(s) that share in ${pct(share)} of failed attempts with ${pct(hShare)} of the GPU-hours`,
        evidence: rows.slice(0, 5).map(r => `${r.n}: ${r.b.toFixed(1)} failed attempts against ${r.exp.toFixed(1)} expected (${(r.b / r.exp).toFixed(1)}×)`).concat([`${attributed} failed attempts with known nodes in the window (an attempt on several nodes counts a share against each)`, 'job outcomes don\'t say whether the node or the job\'s code failed: the diag decides']),
        change: { summary: 'drain them, run gpu-health diag (level 3) and the SDC canary, return the ones that pass after burn-in', knobs: rows.map(r => ({ name: 'node', from: r.n, to: 'drained, tested' })) },
        impact: { gpuHoursPerWeek: lostH * Math.max(0, share - hShare) * perWeek, metric: 'interruptions per 1,000 GPU-hours', unit: 'per 1k GPU-h', now: g.interruptions.perGpuHour ? g.interruptions.perGpuHour * 1000 : null, expected: g.interruptions.perGpuHour ? g.interruptions.perGpuHour * 1000 * (1 - Math.max(0, share - hShare)) : null,
          basis: g.fleet.attemptResolution ? 'upper bound' : 'measured', note: `their excess share of failures × the GPU-hours lost to failed attempts and restarts${g.fleet.attemptResolution ? ' (job traces count a failed attempt whole)' : ''}, if every excess failure was the node's` },
        confidence: attributed >= 50 ? 'high' : 'medium', verify: { metric: 'fleet.interruptions', direction: 'down' },
      });
    }
  }
  // idle or oversized GPUs, from gpu-health's view of the device records: one recommendation per kind of action
  try {
    const gcfg = cfg || ghLoad(), price = prices.gpuHour || priceFor(gcfg, 'default') || 4;
    const cands = fromGpuHealth(store, { from: win.from, to: win.to, cfg: gcfg }).filter(c => c.savingsWeekly > 0 && !c.protected);
    const LABEL = { 'notify-owner': 'Release GPUs that jobs hold without running anything', 'reclaim-idle': 'Reclaim idle GPUs', 'scale-in': 'Scale in over-provisioned services', resize: 'Right-size jobs that use a fraction of their GPUs' };
    for (const kind of [...new Set(cands.map(c => c.kind))]) {
      const cs = cands.filter(c => c.kind === kind).sort((a, b) => b.savingsWeekly - a.savingsWeekly), gpuH = cs.reduce((t, c) => t + c.savingsWeekly / price, 0);
      if (gpuH < 8) continue;
      out.push({
        id: `reclaim:${kind}`, area: 'fleet', target: `${cs.length} job(s)`, title: `${LABEL[kind] || kind}: ${cs.length} job(s), about ${Math.round(gpuH)} GPU-hours a week`,
        evidence: cs.slice(0, 5).map(c => `${c.resource.replace(/^job:/, '')}: ${c.detail}`).concat(cs.length > 5 ? [`and ${cs.length - 5} more`] : []),
        change: { summary: kind === 'notify-owner' ? 'tell each owner, with an idle timeout that releases GPUs after N hours with no kernels' : `${kind} through fleetops optimize (staged, approved, rolled back on an SLO breach)`, knobs: kind === 'notify-owner' ? [{ name: 'idle timeout (scheduler or a gpu-health reclaim-idle policy)', to: '2–4 h with no kernels' }] : [] },
        impact: { gpuHoursPerWeek: gpuH, dollarsPerWeek: cs.reduce((t, c) => t + c.savingsWeekly, 0), metric: 'GPU-hours held idle', basis: 'measured', note: `gpu-health utilization over the window, at $${price}/GPU-hour${kind === 'notify-owner' ? '; realized only if owners act' : ''}` },
        confidence: 'high', verify: null, apply: kind === 'notify-owner' ? null : 'fleetops optimize plan', jobs: cs.map(c => c.resource.replace(/^job:/, '')),
      });
    }
  } catch { /* no device data */ }
  return out;
}

// ---------- all of it ----------
export function tune(store, { from, to, now = to, targets = {}, pools = {}, prices = {}, cfg } = {}) {
  if (store.flush) store.flush();
  const win = { from, to }, perWeek = WEEK / (to - from);
  const g = goodput(store, { from, to, now, targets, serving: false });
  const calibration = store.query('calibration', { to });
  const recs = [...training(g, store, win, perWeek), ...inference(store, win, { pools, targets, calibration }), ...fleet(store, win, g, { prices, cfg })];
  const score = r => (r.impact && Number.isFinite(r.impact.gpuHoursPerWeek) ? r.impact.gpuHoursPerWeek : 0) + (r.impact && r.impact.latency ? 1000 * Math.max(1, r.impact.fromTarget || 1) : 0);
  recs.sort((a, b) => score(b) - score(a));
  // what more data would unlock
  const have = k => store.query(k, { from, to, limit: 1 }).length > 0;
  const missing = [];
  if (!have('step')) missing.push('training step logs (step-log, kineto): goodput, checkpoint, data-pipeline, straggler and restart advice');
  if (!have('serving') && !have('request')) missing.push('serving metrics (vLLM /metrics) or request logs: KV-cache, sizing and autoscaling advice');
  else if (!Object.keys(pools).length) missing.push('pool definitions (--pools: model, GPU and current GPU count per pool): sizing and autoscaling advice');
  if (!have('device')) missing.push('device telemetry (DCGM / AMD exporters): idle and oversized GPUs');
  if (!have('job')) missing.push('job outcomes (sacct, Kubernetes): flaky nodes and interruption rates');
  return { window: win, generatedAt: now, recommendations: recs, totals: { gpuHoursPerWeek: recs.reduce((t, r) => t + Math.max(0, (r.impact && r.impact.gpuHoursPerWeek) || 0), 0), count: recs.length }, goodput: { fleet: g.fleet.goodput, gpuHours: g.fleet.totalGpuHours }, missing };
}

export function tuneMarkdown(t) {
  const day = x => new Date(x * 1000).toISOString().slice(0, 10), gh = v => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  const L = [`# Tuning, ${day(t.window.from)} → ${day(t.window.to)}`, ''];
  if (!t.recommendations.length) L.push('No change stands out in this window.', '');
  else L.push(`${t.recommendations.length} recommendation(s), about **${gh(t.totals.gpuHoursPerWeek)} GPU-hours a week** in total where it can be counted.`, '');
  t.recommendations.forEach((r, i) => {
    L.push(`## ${i + 1}. ${r.title}`, '', `*${r.area} · ${r.target} · confidence ${r.confidence} · \`${r.id}\`*`, '');
    for (const e of r.evidence) L.push(`- ${e}`);
    L.push('', `**Change:** ${r.change.summary}`);
    for (const k of r.change.knobs || []) L.push(`- ${k.name}${k.from != null ? `: ${k.from} →` : ':'} ${k.to}`);
    const im = r.impact || {};
    L.push('', `**Expected:** ${Number.isFinite(im.gpuHoursPerWeek) ? `${gh(im.gpuHoursPerWeek)} GPU-hours a week` : ''}${Number.isFinite(im.now) && Number.isFinite(im.expected) ? `${Number.isFinite(im.gpuHoursPerWeek) ? '; ' : ''}${im.metric} ${im.unit === 's' ? `${im.now.toFixed(2)} s → ${im.expected.toFixed(2)} s` : im.unit ? `${im.now.toFixed(2)} → ${im.expected.toFixed(2)} ${im.unit}` : `${pct(im.now)} → ${pct(im.expected)}`}` : ''} (${im.basis}${im.note ? `: ${im.note}` : ''})`);
    if (r.verify) L.push('', `After the change: \`fleetops tune apply ${r.id} --by NAME\`, then \`fleetops tune verify ${r.id}\`.`);
    L.push('');
  });
  if (t.missing.length) { L.push('## More data would add', ''); for (const m of t.missing) L.push(`- ${m}`); L.push(''); }
  return L.join('\n');
}

// ---------- after a change: did it work? ----------

// Record that a recommendation was applied (a change record, so root-cause analysis sees it too).
export function applyTune(store, rec, { by, at = Math.floor(Date.now() / 1000), note } = {}) {
  if (!by) throw new Error('who applied it? (--by NAME)');
  const c = { t: at, kind: 'tune', target: rec.target, summary: `${rec.change.summary}${note ? ` (${note})` : ''}`, id: `tune:${rec.id}@${at}`, by, source: 'fleetops-tune',
    tune: { id: rec.id, title: rec.title, area: rec.area, verify: rec.verify, impact: rec.impact } };
  const r = store.append('change', [c]);
  if (r.invalid) throw new Error(`could not record the change: ${r.errors.join('; ')}`);
  if (store.flush) store.flush();
  return c;
}
export const applied = store => store.query('change', { where: c => c.kind === 'tune' && c.tune }).sort((a, b) => a.t - b.t);

// The metric a recommendation should move, as samples over [from, to): per day for training shares and the fleet,
// per hour for serving latency and communication.
export function metricSeries(store, v, from, to) {
  const out = [];
  if (v.metric === 'job.share') {
    for (let d = Math.floor(from / D) * D; d < to; d += D) {
      const a = Math.max(d, from), b = Math.min(d + D, to);
      if (b - a < 6 * H) continue; // a partial day says little
      const g = goodput(store, { from: a, to: b, now: b, job: v.scope, serving: false }), j = g.jobs[0];
      if (j && j.totalGpuHours > 0) out.push({ t: a, v: v.categories.reduce((t, c) => t + j.gpuHours[c], 0) / j.totalGpuHours });
    }
  } else if (v.metric === 'job.comm') {
    const st = store.query('step', { from, to, where: s => String(s.job).split('#')[0] === v.scope && Number.isFinite(s.commS) && s.durS > 0 });
    hourly(st, s => s.commS / s.durS, out);
  } else if (v.metric === 'pool.ttftP99') {
    const sv = store.query('serving', { from, to, where: r => r.pool === v.scope && Number.isFinite(r.ttftP99) });
    if (sv.length) hourly(sv, r => r.ttftP99, out);
    else { const rq = store.query('request', { from, to, where: r => r.pool === v.scope && Number.isFinite(r.ttft) }); hourly(rq, r => r.ttft, out, 0.99); }
  } else if (v.metric === 'fleet.interruptions') {
    for (let d = Math.floor(from / D) * D; d < to; d += D) { const a = Math.max(d, from), b = Math.min(d + D, to); if (b - a < 6 * H) continue; const g = goodput(store, { from: a, to: b, now: b, serving: false }); if (g.interruptions.perGpuHour != null) out.push({ t: a, v: g.interruptions.perGpuHour * 1000 }); }
  }
  return out;
}
function hourly(recs, f, out, p = 0.5) {
  const b = new Map();
  for (const r of recs) { const k = Math.floor(r.t / H) * H, x = f(r); if (!Number.isFinite(x)) continue; if (!b.has(k)) b.set(k, []); b.get(k).push(x); }
  for (const [t, v] of [...b].sort((x, y) => x[0] - y[0])) out.push({ t, v: q(v, p) });
}

// Before/after: the metric over the same length before the change and after it settles, a bootstrap 95% interval for
// the difference of means, and a verdict against the direction the recommendation expected.
export function verifyTune(store, id, { beforeS = 7 * D, afterS = 7 * D, settleS = H, now = Math.floor(Date.now() / 1000), seed = 1 } = {}) {
  const c = applied(store).filter(x => x.tune.id === id).pop();
  if (!c) return { id, verdict: 'not applied', note: `no change record for ${id}: run fleetops tune apply ${id} --by NAME when the change is made` };
  const v = c.tune.verify;
  if (!v) return { id, at: c.t, verdict: 'no metric', note: 'this recommendation has no metric to verify; check it with fleetops optimize verify or by hand' };
  const before = metricSeries(store, v, c.t - beforeS, c.t), after = metricSeries(store, v, c.t + settleS, Math.min(now, c.t + settleS + afterS));
  const res = { id, at: c.t, by: c.by, metric: v.metric, scope: v.scope, direction: v.direction, before: summ(before), after: summ(after) };
  if (before.length < 3 || after.length < 3) return Object.assign(res, { verdict: 'not enough data', note: `${before.length} sample(s) before and ${after.length} after; need 3 of each (${v.metric.startsWith('job.share') || v.metric === 'fleet.interruptions' ? 'days' : 'hours'})` });
  const diff = res.after.mean - res.before.mean, rel = res.before.mean ? diff / Math.abs(res.before.mean) : null;
  // bootstrap the difference of means
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const mean = xs => xs.reduce((t, x) => t + x, 0) / xs.length, pick = xs => xs[Math.floor(u() * xs.length)];
  const bv = before.map(x => x.v), av = after.map(x => x.v), ds = [];
  for (let i = 0; i < 2000; i++) ds.push(mean(av.map(() => pick(av))) - mean(bv.map(() => pick(bv))));
  ds.sort((x, y) => x - y);
  const ci = [ds[49], ds[1949]];
  let verdict;
  if (v.direction === 'down') verdict = ci[1] < 0 ? 'improved' : ci[0] > 0 ? 'worse' : 'no clear effect';
  else if (v.direction === 'up') verdict = ci[0] > 0 ? 'improved' : ci[1] < 0 ? 'worse' : 'no clear effect';
  else { // flat: the change should not hurt this metric (a smaller pool's latency)
    const lim = Number.isFinite(v.target) ? v.target : res.before.mean * 1.1;
    verdict = q(av, 0.9) <= lim && ci[0] <= Math.abs(res.before.mean) * 0.1 ? 'held' : 'worse';
  }
  const imp = c.tune.impact || {};
  const predicted = Number.isFinite(imp.now) && Number.isFinite(imp.expected) && imp.now ? (imp.expected - imp.now) / Math.abs(imp.now) : null;
  return Object.assign(res, { diff, rel, ci, verdict, predicted, basis: imp.basis,
    note: predicted != null && rel != null ? `measured ${(rel * 100).toFixed(0)}% against ${(predicted * 100).toFixed(0)}% predicted (${imp.basis})` : null });
}
const summ = xs => ({ n: xs.length, mean: xs.length ? xs.reduce((t, x) => t + x.v, 0) / xs.length : null, from: xs.length ? xs[0].t : null, to: xs.length ? xs[xs.length - 1].t : null });

// ---------- does the premise hold out of sample? ----------
// Recommendations from [from, split), checked on [split, to) before anything is changed: is the problem each one names
// still there? A recommendation whose evidence disappears in the next days was chasing noise.
export function holdout(store, { from, split, to, targets = {}, pools = {}, cfg } = {}) {
  const t = tune(store, { from, to: split, now: split, targets, pools, cfg }), out = [];
  for (const r of t.recommendations) {
    const row = { id: r.id, title: r.title, area: r.area };
    if (r.id === 'flaky-nodes') {
      const nodes = r.target.split(', '), x = nodeFailures(store, split, to);
      const f = nodes.reduce((s, n) => s + (x.blame.get(n) || 0), 0), e = nodes.reduce((s, n) => s + x.attributed * (x.hours.get(n) || 0) / (x.totH || 1), 0);
      Object.assign(row, { inSample: r.evidence[0], outOfSample: { failed: f, expected: e, ratio: e ? f / e : null, share: x.attributed ? f / x.attributed : null }, held: e > 0 && f / e >= 2 });
    } else if (r.id.startsWith('reclaim:') && r.jobs) {
      // the same jobs still flagged in the next days
      let later = [];
      try { later = fromGpuHealth(store, { from: split, to, cfg: cfg || ghLoad() }).filter(c => c.kind === r.id.split(':')[1]).map(c => c.resource.replace(/^job:/, '')); } catch { later = []; }
      const still = r.jobs.filter(j => later.includes(j));
      Object.assign(row, { inSample: r.jobs.length, outOfSample: { still: still.length, of: r.jobs.length }, held: still.length >= r.jobs.length / 2 });
    } else if (r.verify && r.verify.metric !== 'pool.ttftP99') {
      const a = metricSeries(store, r.verify, from, split), b = metricSeries(store, r.verify, split, to);
      const m = xs => (xs.length ? xs.reduce((s, x) => s + x.v, 0) / xs.length : null);
      Object.assign(row, { inSample: m(a), outOfSample: m(b), held: m(a) != null && m(b) != null && m(b) >= 0.5 * m(a) });
    } else Object.assign(row, { held: null, note: 'no out-of-sample check for this kind' });
    out.push(row);
  }
  return { from, split, to, rows: out };
}
function nodeFailures(store, from, to) {
  const failed = store.query('job', { from, to, where: j => ['failed', 'timeout', 'retried'].includes(j.status) && j.cause !== 'app' });
  const places = new Map(store.query('placement', { to, where: p => p.end == null || p.end > from }).map(p => [String(p.job), p]));
  const blame = new Map(), hours = new Map();
  for (const p of places.values()) { const s = Math.max(p.start ?? p.t, from), e = Math.min(p.end ?? to, to); if (e <= s) continue; for (const n of new Set((p.devices || []).map(d => d.node))) hours.set(n, (hours.get(n) || 0) + (e - s) * (p.devices || []).filter(d => d.node === n).length / H); }
  let attributed = 0;
  for (const j of failed) { const p = places.get(String(j.job)), ns = j.node ? [j.node] : [...new Set(((p && p.devices) || []).map(d => d.node))]; if (!ns.length) continue; attributed++; for (const n of ns) blame.set(n, (blame.get(n) || 0) + 1 / ns.length); }
  return { blame, hours, attributed, totH: [...hours.values()].reduce((a, b) => a + b, 0) };
}
