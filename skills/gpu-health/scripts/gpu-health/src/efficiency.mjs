// Efficiency: how much of each allocated GPU a job really uses, and why not more.
//
// Effective utilization = max(tensor-active, HBM-bandwidth-active), both as fractions of the SKU's peak. Every workload
// is limited by compute or by memory bandwidth, so the larger of the two is how much of the binding resource it uses.
// A ratio of the two misleads: healthy decode has a low tensor:HBM ratio, and when both are near zero the ratio is noise.
import { gpuKey } from './ingest.mjs';

export const pct = (arr, p) => { if (!arr.length) return NaN; const s = arr.slice().sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1)); return s[i]; };
const med = a => pct(a, 0.5);
const num = v => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
export const effective = s => Math.max(num(s.tensor) ?? 0, num(s.dram) ?? 0);

export function indexByGpu(samples) {
  const m = new Map();
  for (const s of samples) { const k = gpuKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  for (const arr of m.values()) arr.sort((a, b) => a.t - b.t);
  return m;
}
export const intervalSec = arr => { const d = []; for (let i = 1; i < Math.min(arr.length, 50); i++) d.push(arr[i].t - arr[i - 1].t); return d.length ? med(d) : 60; };

// Stats for one GPU over [from, to].
export function gpuStats(arr, from, to, cfg) {
  const e = cfg.efficiency;
  const w = arr.filter(s => s.t >= from && s.t <= to);
  const dt = intervalSec(arr);
  const isIdle = s => (num(s.tensor) ?? 0) < e.idleTensor && (num(s.dram) ?? 0) < e.idleDram;
  let tail = 0; for (let i = w.length - 1; i >= 0 && isIdle(w[i]); i--) tail++;
  const used = w.map(s => num(s.memUsedGB)).filter(v => v != null);
  const fw = w.map(s => num(s.frameworkPeakGB)).filter(v => v != null);
  const memTotal = med(w.map(s => num(s.memTotalGB)).filter(v => v != null));
  return {
    samples: w.length, hours: w.length * dt / 3600,
    tensorP50: med(w.map(s => num(s.tensor) ?? 0)), smP50: med(w.map(s => num(s.sm) ?? 0)), dramP50: med(w.map(s => num(s.dram) ?? 0)),
    dramP95: pct(w.map(s => num(s.dram) ?? 0), 0.95),
    effP50: med(w.map(effective)), effP95: pct(w.map(effective), 0.95),
    idleFrac: w.length ? w.filter(isIdle).length / w.length : 0, idleHours: w.filter(isIdle).length * dt / 3600, idleTailMin: tail * dt / 60,
    throttleBusy: (() => { const b = w.filter(s => (num(s.sm) ?? 0) > 0.2); return b.length ? b.reduce((t, s) => t + (num(s.throttle) ?? 0), 0) / b.length : 0; })(),
    cpuWait: (() => { const c = w.map(s => num(s.cpuWait)).filter(v => v != null); return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null; })(),
    memPeakGB: fw.length ? Math.max(...fw) : used.length ? pct(used, 0.99) : null,
    memSource: fw.length ? 'framework' : used.length ? 'driver (upper bound: frameworks reserve memory)' : 'none',
    memTotalGB: memTotal,
  };
}

// Classify a job from the median of its GPUs' stats.
export function classify(st, cfg) {
  const e = cfg.efficiency;
  if (st.idleTailMin >= e.idleAlertMin) return 'idle';
  if (st.effP50 < e.underused && st.cpuWait != null && st.cpuWait >= e.starvedCpuWait) return 'starved';
  if (st.tensorP50 >= e.computeBound) return 'compute-bound';
  if (st.dramP50 >= e.memoryBound) return 'memory-bound';
  if (st.smP50 >= e.nonTensorSm && st.tensorP50 < 0.10) return 'busy-non-tensor';
  if (st.effP50 < e.underused) return 'underused';
  return 'moderate';
}
export const CLASS_TEXT = {
  'idle': 'Allocated with no kernels running', 'starved': 'Waiting on CPU, storage or network', 'compute-bound': 'Compute-bound: good',
  'memory-bound': 'Memory-bandwidth-bound: normal for decode', 'busy-non-tensor': 'Busy, but not on tensor cores',
  'underused': 'Underused: likely oversized', 'moderate': 'Moderate use',
};

// Straggler from step timings (framework hook): a rank whose compute time per step sits well above its job's median.
export function stragglersFromSteps(steps, jobs, opts = {}) {
  const out = [];
  const byJob = new Map();
  for (const s of steps || []) { if (!byJob.has(s.job)) byJob.set(s.job, new Map()); const r = byJob.get(s.job); if (!r.has(s.rank)) r.set(s.rank, []); r.get(s.rank).push(s); }
  for (const [job, ranks] of byJob) {
    if (ranks.size < 3) continue;
    const perRank = [...ranks.entries()].map(([rank, arr]) => ({ rank: +rank, ms: med(arr.slice().sort((a, b) => a.step - b.step).slice(-(opts.lastSteps || 50)).map(x => x.computeMs)) }));
    const m = med(perRank.map(r => r.ms));
    const mad = med(perRank.map(r => Math.abs(r.ms - m))) * 1.4826 || 1e-9;
    const j = (jobs || []).find(x => x.id === job);
    for (const r of perRank) {
      const z = (r.ms - m) / mad;
      if (z > (opts.z || 3) && r.ms > m * 1.05) {
        const g = j && j.gpus[r.rank];
        out.push({ job, rank: r.rank, node: g && g.node, gpu: g && String(g.gpu), slowdown: r.ms / m, source: 'step timings' });
      }
    }
  }
  return out;
}
// Fallback signature without step timings: in a synchronous job the healthy ranks wait (low SM) on the slow one (high SM).
export function stragglersFromUtil(jobStats) {
  const out = [];
  for (const js of jobStats) {
    if (js.job.class !== 'training' || js.gpus.length < 4) continue;
    const sms = js.gpus.map(g => g.st.smP50), m = med(sms);
    js.gpus.forEach((g, i) => { if (g.st.smP50 > m + 0.25 && m < 0.5) out.push({ job: js.job.id, rank: i, node: g.node, gpu: g.gpu, slowdown: null, source: 'utilization signature' }); });
  }
  return out;
}

// Speed index: a GPU's micro-benchmark results vs the median of its cohort (same SKU, firmware and site).
export function speedIndex(probes) {
  const latest = new Map();
  for (const p of probes || []) { const k = p.node + '/' + p.gpu; if (!latest.has(k) || latest.get(k).t < p.t) latest.set(k, p); }
  const cohorts = new Map();
  for (const p of latest.values()) { const c = [p.sku, p.firmware || '', p.site || ''].join('|'); if (!cohorts.has(c)) cohorts.set(c, []); cohorts.get(c).push(p); }
  const out = new Map();
  for (const arr of cohorts.values()) {
    const metrics = ['gemmTflops', 'hbmGBs', 'linkGBs'].filter(k => arr.some(p => p[k] != null));
    const medians = Object.fromEntries(metrics.map(k => [k, med(arr.map(p => p[k]).filter(v => v != null))]));
    for (const p of arr) {
      const ratios = metrics.filter(k => p[k] != null && medians[k] > 0).map(k => ({ k, r: p[k] / medians[k] }));
      const worst = ratios.sort((a, b) => a.r - b.r)[0];
      out.set(p.node + '/' + p.gpu, { index: worst ? worst.r : 1, metric: worst ? worst.k : null, cohortSize: arr.length });
    }
  }
  return out;
}

// Per-job analysis over a window.
export function analyzeJobs(samples, jobs, cfg, window) {
  const byGpu = indexByGpu(samples);
  const res = [];
  for (const job of jobs) {
    const from = Math.max(window.from, (job.start || window.from) + cfg.efficiency.warmupMin * 60);
    const to = Math.min(window.to, job.end || window.to);
    if (to <= from) continue;
    const gpus = job.gpus.map((g, rank) => ({ node: g.node, gpu: String(g.gpu), rank, st: gpuStats(byGpu.get(g.node + '/' + g.gpu) || [], from, to, cfg) })).filter(g => g.st.samples > 0);
    if (!gpus.length) continue;
    const pick = k => med(gpus.map(g => g.st[k]).filter(v => v != null && !Number.isNaN(v)));
    const st = {
      tensorP50: pick('tensorP50'), smP50: pick('smP50'), dramP50: pick('dramP50'), dramP95: pick('dramP95'), effP50: pick('effP50'), effP95: pick('effP95'),
      idleTailMin: Math.min(...gpus.map(g => g.st.idleTailMin)), cpuWait: pick('cpuWait'),
      hours: pick('hours'), idleGpuHours: gpus.reduce((t, g) => t + g.st.idleHours, 0),
      memPeakGB: Math.max(...gpus.map(g => g.st.memPeakGB ?? 0)), memTotalGB: pick('memTotalGB'),
      memSource: gpus.every(g => g.st.memSource === 'framework') ? 'framework' : gpus[0].st.memSource,
    };
    const cls = classify(Object.assign({}, st, { cpuWait: Number.isNaN(st.cpuWait) ? null : st.cpuWait }), cfg);
    res.push({ job, gpus, st, cls, sku: (byGpu.get(gpus[0].node + '/' + gpus[0].gpu) || [{}])[0].sku || '' });
  }
  return res;
}
