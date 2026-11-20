// Savings: compare what each job was allocated with what it used, and turn the gap into a concrete lever.
//
// Memory need comes from the framework's own peak when exported (torch.cuda.max_memory_allocated, vLLM KV usage);
// otherwise from driver-reported use, which is an upper bound because frameworks reserve memory up front.
// Compute need is the p95 of effective utilization. A job is right-sized to max(memory need, compute need) x headroom.
// Memory-bound jobs (high HBM bandwidth) are not shrunk onto partitions: a slice gets a slice of the bandwidth too.
import { priceFor } from './config.mjs';

export const roundUpTo = (x, sizes) => sizes.find(s => s >= x - 1e-9) ?? sizes[sizes.length - 1];

export function rightSize(js, cfg) {
  const e = cfg.efficiency, st = js.st, G = js.gpus.length;
  const memFrac = st.memPeakGB != null && st.memTotalGB ? st.memPeakGB / st.memTotalGB : 1;
  const cmpFrac = Math.max(st.effP95 || 0, 0);
  const perGpu = Math.min(1, Math.max(memFrac, cmpFrac) * e.headroom);
  const total = perGpu * G;
  const memoryBound = (st.dramP95 || 0) >= e.memoryBound;
  let target, shape;
  if (total >= G - 0.5 || memoryBound && total > 0.5) { target = G; shape = `${G} GPU`; }
  else if (total <= 1 && !memoryBound) { target = roundUpTo(total, cfg.partitions); shape = target < 1 ? `${target} GPU partition` : '1 GPU'; }
  else { target = Math.ceil(total); shape = `${target} GPU`; }
  return { memFrac, cmpFrac, perGpu, total, target, shape, memoryBound };
}

const confidence = (js, cfg) => {
  const h = js.st.hours || 0;
  if (h < cfg.savings.minObservedHours) return 'low';
  if (js.st.memSource === 'framework' && h >= cfg.savings.highConfidenceHours) return 'high';
  return 'medium';
};

// One recommendation per job (or none when the job is using its GPUs well).
export function recommend(jobStats, stragglers, cfg, window) {
  const out = [];
  const weekScale = 168 / Math.max(1, (window.to - window.from) / 3600);
  for (const js of jobStats) {
    const j = js.job, G = js.gpus.length, price = priceFor(cfg, js.sku), cls = j.class || 'batch';
    const activeShare = Math.min(1, (js.st.hours || 0) / Math.max(1, (window.to - window.from) / 3600)); // how much of the week the job ran
    const rs = rightSize(js, cfg);
    const base = { job: j.id, owner: j.owner || '', class: cls, sku: js.sku, gpus: G, gpuList: js.gpus.map(g => g.node + '/' + g.gpu), usage: js.cls, rightSize: rs, confidence: confidence(js, cfg),
      memPeakGB: js.st.memPeakGB, memTotalGB: js.st.memTotalGB, memSource: js.st.memSource, effP50: js.st.effP50, effP95: js.st.effP95, tensorP50: js.st.tensorP50, dramP50: js.st.dramP50 };
    const st = stragglers.find(s => s.job === j.id);
    if (st) {
      const lost = st.slowdown ? (1 - 1 / st.slowdown) : 0.1;
      out.push(Object.assign(base, { lever: 'fix-straggler', action: 'swap-at-checkpoint', target: `${st.node}/${st.gpu}`, gpusFreed: G * lost, weekly: G * lost * price * 168 * activeShare,
        text: `Rank ${st.rank} on ${st.node}/gpu${st.gpu} is ${st.slowdown ? Math.round((st.slowdown - 1) * 100) + '% slower than the job median' : 'holding the job back'} (${st.source}); every rank waits for it. At the next checkpoint, swap that node for a spare and send the GPU for a deep diag.` }));
      continue;
    }
    if (js.cls === 'idle') {
      out.push(Object.assign(base, { lever: 'reclaim', action: cls === 'training' ? 'notify-owner' : 'reclaim-idle', gpusFreed: G, weekly: js.st.idleGpuHours * weekScale * price,
        text: `${G} GPU(s) allocated with no kernels for ${Math.round(js.st.idleTailMin)} min (${js.st.idleGpuHours.toFixed(0)} idle GPU-hours in the window). Release them${cls === 'interactive' ? ' and let the session re-request on next use' : ''}.` }));
      continue;
    }
    if (js.cls === 'starved') {
      out.push(Object.assign(base, { lever: 'fix-input', action: 'notify-owner', gpusFreed: 0, weekly: 0,
        text: `GPUs wait on CPU/I-O (${Math.round((js.st.cpuWait || 0) * 100)}% wait, ${Math.round(js.st.effP50 * 100)}% effective use). More GPUs won't help; speed up the data loader, storage or network first.` }));
      continue;
    }
    if (js.cls === 'busy-non-tensor') {
      out.push(Object.assign(base, { lever: 'fix-kernels', action: 'notify-owner', gpusFreed: 0, weekly: 0,
        text: `SMs are busy (${Math.round(js.st.smP50 * 100)}%) but tensor cores almost idle (${Math.round(js.st.tensorP50 * 100)}%). Check precision (FP32 math, missing fused kernels): the same work should need far less GPU time.` }));
      continue;
    }
    if (js.cls === 'memory-bound' || js.cls === 'compute-bound' || rs.target >= G) continue; // using what it has
    const freed = G - rs.target;
    if (freed < 0.25) continue;
    const weekly = freed * price * 168 * activeShare;
    if (weekly < cfg.savings.minWeeklySavings) continue;
    const memTxt = js.st.memPeakGB != null ? `peak memory ${js.st.memPeakGB.toFixed(1)} of ${(js.st.memTotalGB || 0).toFixed(0)} GB per GPU (${js.st.memSource === 'framework' ? 'framework peak' : 'driver-reported; an upper bound'})` : 'no memory data';
    let lever, action, text;
    if (cls === 'training') {
      lever = 'fewer-gpus'; action = 'resize';
      text = `Effective use ${Math.round(js.st.effP50 * 100)}% (p95 ${Math.round(js.st.effP95 * 100)}%), ${memTxt}. Raise the per-GPU batch size and run on ${rs.target} GPU(s) instead of ${G}; apply at the next restart.`;
    } else if (rs.target < 1) {
      lever = 'partition'; action = 'resize';
      text = `Effective use ${Math.round(js.st.effP50 * 100)}% (p95 ${Math.round(js.st.effP95 * 100)}%), ${memTxt}. Fits a ${rs.target} GPU partition: move it there and free ${freed.toFixed(2)} GPU(s).`;
    } else {
      lever = 'fewer-gpus'; action = cls === 'inference' ? 'scale-in' : 'resize';
      text = `Effective use ${Math.round(js.st.effP50 * 100)}% (p95 ${Math.round(js.st.effP95 * 100)}%), ${memTxt}. ${rs.target} GPU(s) cover the observed peak with ${Math.round((cfg.efficiency.headroom - 1) * 100)}% headroom.`;
    }
    out.push(Object.assign(base, { lever, action, replicas: cls === 'inference' && rs.target >= 1 ? Math.max(1, Math.round(rs.target / Math.max(1, j.gpusPerReplica || 1))) : undefined, fraction: rs.target < 1 ? rs.target : undefined, gpusFreed: freed, weekly, text }));
  }
  return out.sort((a, b) => b.weekly - a.weekly);
}
