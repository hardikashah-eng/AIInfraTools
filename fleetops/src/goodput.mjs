// Goodput: where every allocated GPU-second of training went, and how to get more of it back.
//
// Each attempt of a job (a placement: GPUs held from start to end) is split, GPU-seconds = wall seconds × GPUs:
//   productive   steps at the job's own ideal pace that were kept (a later checkpoint, or the job finished)
//   slow-steps   step time above the ideal pace: stragglers, slow links, contention, jitter
//   data-stall   time steps waited on the input pipeline (step dataS)
//   checkpoint   time training was blocked saving checkpoints (step ckptS, or checkpoint records)
//   lost-work    steps after the last checkpoint of an attempt that failed, plus the time from its last step to the
//                failure (a hang before the watchdog): work that had to be redone
//   restart      from the start of a restarted attempt to its first step: scheduling, init, checkpoint load
//   startup      the same for a job's first attempt
//   idle         the rest of the allocation: gaps between steps (eval, logging), and after the last step
// The categories sum to the allocation, per attempt. With no step records (job traces such as Philly) an attempt is
// either productive (it finished or is running: an upper bound) or lost-work (it failed), and the result says so
// (resolution: "attempt").
//
// Step records may cover several steps: `n` steps at an average of durS each (frameworks log every N steps).
//
// Checkpoint advice (Young/Daly): with checkpoint cost δ (blocking seconds), mean time between interruptions M for the
// job (measured: interruptions per GPU-hour on this fleet × the job's GPUs), and restart cost R, the expected
// badput of interval τ is δ/τ + (τ/2 + R)/M, smallest at τ* = √(2δM).

export const CATEGORIES = ['productive', 'slow-steps', 'data-stall', 'checkpoint', 'lost-work', 'restart', 'startup', 'idle'];
const BAD = CATEGORIES.slice(1);
const FAILED = new Set(['failed', 'timeout', 'retried']); // killed and cancelled are someone's choice, not an interruption
const H = 3600;
const base = j => String(j).split('#')[0];
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };
const med = a => q(a, 0.5);
const zero = () => Object.fromEntries(CATEGORIES.map(c => [c, 0]));
const add = (a, b, k = 1) => { for (const c of CATEGORIES) a[c] += (b[c] || 0) * k; return a; };
const sum = o => CATEGORIES.reduce((t, c) => t + o[c], 0);

// Attempts: placements of training jobs (job "name#n" = attempt n), or, with no placements, runs of step records.
function attempts(store, from, to) {
  const out = [], outcomes = new Map();
  for (const j of store.query('job', { from, to: to + 30 * 86400 })) outcomes.set(j.job, j);
  const places = store.query('placement', { to, where: p => (p.end == null || p.end > from) && (p.class == null || p.class === 'training') });
  for (const p of places) {
    const id = String(p.job), b = base(id), n = id.includes('#') ? +id.split('#')[1] : 1;
    const gpus = (p.devices || []).length || p.gpuCount || p.gpus || 0;
    if (!gpus) continue;
    out.push({ id, job: b, n, start: p.start ?? p.t, end: p.end ?? null, gpus, owner: p.owner || '', namespace: p.namespace || '', nodes: [...new Set((p.devices || []).map(d => d.node).concat(p.node || []))], outcome: outcomes.get(id) || (n === 1 ? outcomes.get(b) : null) });
  }
  // a job's attempts in order; an attempt followed by another ended abnormally even if no outcome says so
  const byJob = new Map();
  for (const a of out) { if (!byJob.has(a.job)) byJob.set(a.job, []); byJob.get(a.job).push(a); }
  for (const list of byJob.values()) {
    list.sort((x, y) => x.start - y.start).forEach((a, i) => { a.n = i + 1; a.next = list[i + 1] || null; a.of = list.length; });
    // an attempt with no end that was followed by another ended when the next began
    for (const a of list) if (a.end == null && a.next) a.end = a.next.start;
    const last = list[list.length - 1];
    if (!last.outcome) last.outcome = outcomes.get(last.job) || null;
  }
  return { list: out, byJob };
}

// Steps of a job, one entry per record: { t0, t1, n, dur, data, ckpt, step }
function stepsOf(store, job, from, to) {
  const recs = store.query('step', { from, to, where: s => base(s.job) === job });
  // one row per (step) across ranks: the slowest rank sets the wall time; components are medians across ranks
  // a restarted job repeats step numbers: ranks of one step finish close together, a repeat comes much later
  const groups = [], open = new Map();
  for (const s of recs.slice().sort((x, y) => x.t - y.t)) {
    const g = open.get(s.step), tol = Math.max(30, 0.5 * (s.n ?? 1) * s.durS);
    if (g && s.t - g.t <= tol) { g.ss.push(s); continue; }
    const ng = { step: s.step, t: s.t, ss: [s] }; groups.push(ng); open.set(s.step, ng);
  }
  return groups.map(({ step, ss }) => {
    const n = Math.max(1, med(ss.map(s => s.n ?? 1)) || 1), dur = Math.max(...ss.map(s => s.durS)), t1 = Math.max(...ss.map(s => s.t));
    return { step, n, dur, t1, t0: t1 - n * dur, data: (med(ss.map(s => s.dataS ?? 0)) || 0) * n, ckpt: Math.max(...ss.map(s => s.ckptS ?? 0)), ranks: new Set(ss.map(s => s.rank)).size };
  }).sort((a, b) => a.t1 - b.t1);
}

// Split one attempt. ideal: the job's ideal seconds per step. ckpts: checkpoint save records { t, step, saveS }.
function splitAttempt(a, steps, ideal, ckpts, now) {
  const end = a.end ?? now, wall = Math.max(0, end - a.start), g = a.gpus, out = zero();
  const mine = steps.filter(s => s.t1 > a.start && s.t1 <= end + 1);
  const failed = !!(a.outcome && FAILED.has(a.outcome.status)) || (!!a.next && !(a.outcome && a.outcome.status === 'ok'));
  if (!mine.length && steps.length) {
    // the job logs steps but this attempt never reached one: it spent its allocation trying to start
    out[a.n > 1 ? 'restart' : 'startup'] = wall;
    return { gpuS: add(zero(), out, g), resolution: 'step', failed, wall };
  }
  if (!mine.length) {
    // no end and no steps: nothing says whether it is running or what it did (job traces leave these behind)
    if (a.end == null) return { gpuS: zero(), resolution: 'open', failed: false, wall, open: wall * g };
    // no step records: the attempt as a whole
    // a running or finished attempt counts as productive (an upper bound: nothing says how it used the GPUs)
    if (failed && a.end != null) out['lost-work'] = wall; else out.productive = wall;
    return { gpuS: add(zero(), out, g), resolution: 'attempt', failed, wall };
  }
  // checkpoints in this attempt: steps with blocking save time, and checkpoint records
  const marks = [...mine.filter(s => s.ckpt > 0).map(s => s.t1), ...ckpts.filter(c => c.t > a.start && c.t <= end).map(c => c.t)].sort((x, y) => x - y);
  const extraCkpt = ckpts.filter(c => c.t > a.start && c.t <= end && !mine.some(s => s.ckpt > 0 && Math.abs(s.t1 - c.t) < 1)).reduce((t, c) => t + (c.saveS || 0), 0);
  const lastMark = marks.length ? marks[marks.length - 1] : -Infinity;
  const kept = s => !failed || s.t1 <= lastMark;
  let stepWall = 0;
  for (const s of mine) {
    const w = s.n * s.dur, ck = Math.min(s.ckpt, w), da = Math.min(s.data, w - ck), work = w - ck - da;
    const good = Math.min(work, ideal * s.n), slow = work - good;
    stepWall += w;
    out.checkpoint += ck;
    if (kept(s)) { out.productive += good; out['slow-steps'] += slow; out['data-stall'] += da; }
    else out['lost-work'] += good + slow + da;
  }
  out.checkpoint += extraCkpt;
  const first = Math.max(a.start, Math.min(...mine.map(s => s.t0)));
  out[a.n > 1 ? 'restart' : 'startup'] += first - a.start;
  const lastStep = Math.max(...mine.map(s => s.t1));
  if (failed && a.end != null) out['lost-work'] += Math.max(0, end - lastStep); // hung or dying before the failure was seen
  // whatever is left of the allocation: gaps between steps, teardown
  const acc = sum(out), rest = wall - acc;
  if (rest >= 0) out.idle += rest;
  else { const k = wall / acc; for (const c of CATEGORIES) out[c] *= k; } // overlapping records: scale into the allocation
  return { gpuS: add(zero(), out, g), resolution: 'step', failed, wall, lastMark: Number.isFinite(lastMark) ? lastMark : null, marks };
}

// Interruptions per GPU-hour of training on this fleet: attempts that ended abnormally, over training GPU-hours.
export function interruptionRate(store, { from, to, now = to } = {}) {
  const { list } = attempts(store, from, to);
  let gpuH = 0, n = 0;
  for (const a of list) {
    const s = Math.max(a.start, from), e = Math.min(a.end ?? now, to);
    if (e <= s) continue;
    gpuH += (e - s) * a.gpus / H;
    const failed = (a.outcome && FAILED.has(a.outcome.status) && a.outcome.cause !== 'app') || (a.next && !(a.outcome && a.outcome.status === 'ok'));
    if (failed && a.end != null && a.end > from && a.end <= to) n++;
  }
  return { interruptions: n, gpuHours: gpuH, perGpuHour: gpuH ? n / gpuH : null };
}

// Young/Daly checkpoint interval for one job.
export function adviseCheckpoint({ deltaS, intervalS, mtbiS, restartS = 0, gpus }) {
  if (!(deltaS > 0) || !(mtbiS > 0)) return null;
  const f = tau => deltaS / tau + (tau / 2 + restartS) / mtbiS;
  const best = Math.max(2 * deltaS, Math.sqrt(2 * deltaS * mtbiS));
  const now = intervalS > 0 ? f(intervalS) : null, then = f(best);
  return { deltaS, intervalS: intervalS || null, mtbiS, restartS, bestIntervalS: best, badputNow: now, badputBest: then,
    gpuHoursPerWeekSaved: now != null ? Math.max(0, (now - then) * gpus * 168) : null,
    verdict: now == null ? 'no checkpoints seen' : Math.abs(intervalS - best) / best < 0.25 ? 'about right' : intervalS > best ? 'checkpoint more often' : 'checkpoint less often' };
}

// The whole report: per attempt, per job, per owner and namespace, fleet totals, per day, and checkpoint advice.
export function goodput(store, { from, to, now = to, job: only, serving = true, targets = {} } = {}) {
  if (from == null || to == null) throw new Error('goodput needs a window (from, to)');
  if (store.flush) store.flush();
  const { byJob } = attempts(store, from, to);
  const rate = interruptionRate(store, { from: from - 7 * 86400, to, now });
  const ckRecs = store.query('log', { from, to, where: l => l.code === 'checkpoint_saved' });
  const jobs = [], days = new Map();
  let openGpuS = 0;
  for (const [name, list] of byJob) {
    if (only && name !== only) continue;
    const steps = stepsOf(store, name, from - 86400, to);
    // ideal pace: the fast end of the job's own step times without data and checkpoint waits
    const per = steps.map(s => (s.dur * s.n - s.ckpt - s.data) / s.n).filter(v => v > 0);
    const ideal = per.length ? q(per, 0.1) : 0;
    const ckpts = ckRecs.filter(l => base(l.job || '') === name).map(l => ({ t: l.t, saveS: l.saveS || 0 }));
    const tot = zero(), atts = [];
    let gpus = 0, resolution = 'step';
    for (const a of list) {
      const s = Math.max(a.start, from), e = Math.min(a.end ?? now, to);
      if (e <= s) continue;
      const r = splitAttempt(a, steps, ideal, ckpts, now);
      if (r.resolution === 'open') { openGpuS += (e - s) * a.gpus; continue; }
      // clip to the window in proportion (an attempt that started before the window counts only its share)
      const share = r.wall ? (e - s) / r.wall : 0;
      add(tot, r.gpuS, share);
      gpus = Math.max(gpus, a.gpus);
      if (r.resolution === 'attempt') resolution = 'attempt';
      atts.push({ id: a.id, n: a.n, start: a.start, end: a.end, gpus: a.gpus, failed: r.failed, cause: a.outcome ? a.outcome.cause : null, gpuHours: Object.fromEntries(CATEGORIES.map(c => [c, +(r.gpuS[c] * share / H).toFixed(6)])) });
      const d = Math.floor(s / 86400) * 86400;
      if (!days.has(d)) days.set(d, zero());
      add(days.get(d), r.gpuS, share);
    }
    const all = sum(tot);
    if (!all) continue;
    // checkpoint advice from this job's own numbers and the fleet's interruption rate
    const ckSteps = steps.filter(s => s.ckpt > 0), marks = [...ckSteps.map(s => s.t1), ...ckpts.map(c => c.t)].sort((x, y) => x - y);
    const gaps = marks.slice(1).map((t, i) => t - marks[i]).filter(g => g > 60);
    const delta = med([...ckSteps.map(s => s.ckpt), ...ckpts.map(c => c.saveS).filter(v => v > 0)]);
    const restarts = list.filter(a => a.n > 1).map(a => { const st = steps.filter(s => s.t1 > a.start && s.t1 <= (a.end ?? now)); return st.length ? Math.min(...st.map(s => s.t0)) - a.start : NaN; });
    const mtbi = rate.perGpuHour ? H / (rate.perGpuHour * gpus) : null;
    const advice = mtbi ? adviseCheckpoint({ deltaS: delta, intervalS: med(gaps), mtbiS: mtbi, restartS: med(restarts) || 0, gpus }) : null;
    const first = list[0];
    jobs.push({ job: name, owner: first.owner, namespace: first.namespace, gpus, attempts: atts.length, failures: atts.filter(x => x.failed).length, resolution,
      gpuHours: Object.fromEntries(CATEGORIES.map(c => [c, +(tot[c] / H).toFixed(6)])), totalGpuHours: +(all / H).toFixed(6), goodput: tot.productive / all,
      idealStepS: ideal || null, top: BAD.map(c => [c, tot[c]]).sort((x, y) => y[1] - x[1])[0][0], advice, attemptsList: atts });
  }
  jobs.sort((a, b) => b.totalGpuHours - a.totalGpuHours);
  const roll = key => {
    const m = new Map();
    for (const j of jobs) { const k = j[key] || '(none)'; if (!m.has(k)) m.set(k, { [key]: k, jobs: 0, gpuHours: zero() }); const x = m.get(k); x.jobs++; for (const c of CATEGORIES) x.gpuHours[c] += j.gpuHours[c]; }
    return [...m.values()].map(x => Object.assign(x, { totalGpuHours: sum(x.gpuHours), goodput: x.gpuHours.productive / (sum(x.gpuHours) || 1) })).sort((a, b) => b.totalGpuHours - a.totalGpuHours);
  };
  const fleet = zero();
  for (const j of jobs) for (const c of CATEGORIES) fleet[c] += j.gpuHours[c];
  const total = sum(fleet);
  return {
    window: { from, to }, categories: CATEGORIES,
    fleet: { gpuHours: fleet, totalGpuHours: total, goodput: total ? fleet.productive / total : null, badputGpuHours: total - fleet.productive,
      biggest: BAD.map(c => ({ category: c, gpuHours: fleet[c] })).sort((a, b) => b.gpuHours - a.gpuHours).slice(0, 3),
      checkpointSavingsGpuHoursPerWeek: jobs.reduce((t, j) => t + ((j.advice && j.advice.gpuHoursPerWeekSaved) || 0), 0),
      stepResolution: jobs.filter(j => j.resolution === 'step').length, attemptResolution: jobs.filter(j => j.resolution === 'attempt').length,
      // allocations with no end and no step records: left out of the totals (nothing says what they did)
      openGpuHours: openGpuS / H },
    interruptions: rate,
    jobs, owners: roll('owner'), namespaces: roll('namespace'),
    days: [...days.entries()].sort((a, b) => a[0] - b[0]).map(([t, g]) => ({ t, gpuHours: Object.fromEntries(CATEGORIES.map(c => [c, g[c] / H])), goodput: g.productive / (sum(g) || 1) })),
    serving: serving ? servingGoodput(store, { from, to, targets }) : [],
  };
}

// Inference goodput: the share of requests (or windows) that met the latency targets.
export function servingGoodput(store, { from, to, targets = {} }) {
  const out = [];
  const reqs = store.query('request', { from, to, where: r => r.pool && Number.isFinite(r.ttft) });
  for (const pool of [...new Set(reqs.map(r => r.pool))]) {
    const tg = targets[pool] || {}, rs = reqs.filter(r => r.pool === pool);
    const tpot = r => (Number.isFinite(r.e2e) && r.osl > 1 ? (r.e2e - r.ttft) / (r.osl - 1) : null);
    const ok = r => (!Number.isFinite(tg.ttftP99) || r.ttft <= tg.ttftP99) && (!Number.isFinite(tg.tpotP99) || tpot(r) == null || tpot(r) <= tg.tpotP99);
    const good = rs.filter(ok);
    out.push({ pool, basis: 'requests', targets: tg, requests: rs.length, good: good.length, goodput: rs.length ? good.length / rs.length : null,
      goodTokens: good.reduce((t, r) => t + (r.osl || 0), 0), allTokens: rs.reduce((t, r) => t + (r.osl || 0), 0), hasTargets: Number.isFinite(tg.ttftP99) || Number.isFinite(tg.tpotP99) });
  }
  // pools with only windowed metrics: the share of windows whose p99 met the targets
  const wins = store.query('serving', { from, to });
  for (const pool of [...new Set(wins.map(r => r.pool))].filter(p => !out.some(o => o.pool === p))) {
    const tg = targets[pool] || {}, ws = wins.filter(r => r.pool === pool);
    if (!Number.isFinite(tg.ttftP99) && !Number.isFinite(tg.tpotP99)) { out.push({ pool, basis: 'windows', targets: tg, windows: ws.length, goodput: null, hasTargets: false }); continue; }
    const ok = r => (!Number.isFinite(tg.ttftP99) || !(r.ttftP99 > tg.ttftP99)) && (!Number.isFinite(tg.tpotP99) || !(r.tpotP99 > tg.tpotP99));
    out.push({ pool, basis: 'windows', targets: tg, windows: ws.length, good: ws.filter(ok).length, goodput: ws.length ? ws.filter(ok).length / ws.length : null, hasTargets: true });
  }
  return out;
}

// A demo fleet's week of training: three jobs, each with a planted source of badput, logged every 100 steps.
//   pretrain-70b  256 GPUs, checkpoints every 3 h (blocking 2 min) on a fleet that interrupts it every ~6 h: lost work
//   sft-8b        64 GPUs, a slow input pipeline: data stalls
//   rl-policy     32 GPUs, one slow node for two days: slow steps
export function synthTraining({ t0, days = 7, seed = 7 } = {}) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const end = t0 + days * 86400, rec = { placement: [], job: [], step: [], log: [] };
  const run = ({ job, gpus, owner, namespace, ideal, every = 100, ckptEvery, ckptS, data = 0, slow = null, mtbiH, restartS, loadS }) => {
    const nodes = Array.from({ length: Math.ceil(gpus / 8) }, (_, i) => `${job}-n${String(i + 1).padStart(2, '0')}`);
    const devices = nodes.flatMap(n => Array.from({ length: Math.min(8, gpus) }, (_, g) => ({ node: n, gpu: String(g) })));
    let t = t0 + 600, attempt = 0, step = 0, lastCkptStep = 0;
    while (t < end - 3600) {
      attempt++;
      const start = t, fail = start + -Math.log(1 - u()) * mtbiH * H;
      let cur = start + (attempt > 1 ? restartS : loadS), sinceCk = 0;
      step = lastCkptStep;
      let failedAt = null;
      while (cur < end) {
        const slowNow = slow && cur >= slow.from && cur < slow.to ? slow.factor : 1;
        const per = ideal * slowNow * (1 + 0.02 * u()) + data;
        const dur = every * per;
        if (cur + dur > fail) { failedAt = fail; break; }
        cur += dur; step += every; sinceCk += dur;
        let ck = 0;
        if (sinceCk >= ckptEvery) { ck = ckptS; cur += ck; sinceCk = 0; lastCkptStep = step; }
        rec.step.push({ t: Math.round(cur), job, rank: 0, node: nodes[0], step, n: every, durS: +(per + ck / every).toFixed(4), dataS: data || undefined, ckptS: ck || undefined, source: 'demo' });
      }
      const aEnd = failedAt != null ? Math.round(failedAt + 300) : Math.round(Math.min(cur, end)); // the watchdog fires 5 min later
      rec.placement.push({ t: start, job: `${job}#${attempt}`, class: 'training', owner, namespace, start, end: aEnd, devices, source: 'demo' });
      if (failedAt != null) rec.job.push({ t: aEnd, job: `${job}#${attempt}`, status: 'failed', cause: u() < 0.7 ? 'device' : 'infra', start, end: aEnd, gpus, source: 'demo' });
      else rec.job.push({ t: aEnd, job: `${job}#${attempt}`, status: 'ok', cause: 'unknown', start, end: aEnd, gpus, source: 'demo' });
      t = aEnd + 120; // requeued
    }
  };
  run({ job: 'pretrain-70b', gpus: 256, owner: 'foundation', namespace: 'pretrain', ideal: 4.0, ckptEvery: 3 * H, ckptS: 120, mtbiH: 6, restartS: 900, loadS: 600 });
  run({ job: 'sft-8b', gpus: 64, owner: 'post-training', namespace: 'sft', ideal: 1.2, data: 0.6, ckptEvery: 1 * H, ckptS: 20, mtbiH: 24, restartS: 300, loadS: 180 });
  run({ job: 'rl-policy', gpus: 32, owner: 'post-training', namespace: 'rl', ideal: 2.0, ckptEvery: 0.5 * H, ckptS: 15, mtbiH: 48, restartS: 240, loadS: 120, slow: { from: t0 + 2 * 86400, to: t0 + 4 * 86400, factor: 1.6 } });
  return rec;
}
