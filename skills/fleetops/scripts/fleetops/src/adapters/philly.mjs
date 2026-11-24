// Microsoft Philly traces (msr-fiddle/philly-traces, CC BY 4.0): a 2017 multi-tenant GPU training cluster.
//   cluster_machine_list   machineId, number of GPUs, single GPU mem          → inventory
//   cluster_gpu_util       per-minute nvidia-smi utilization per GPU ("NA" = GPU offline) → device samples
//   cluster_job_log        jobs with scheduling attempts (machine + GPUs) and final status → placement + job
// Times in the util file carry PST/PDT; the job log has none and is read as US Pacific too.
// nvidia-smi "utilization" is the share of time a kernel was running. It is the only activity metric in the trace,
// so it fills `sm` and stands in for `tensor` (flagged `utilSource: "nvidia-smi"`): an upper bound on real use.
import { toEpoch } from './time.mjs';

export function machines(text, { t = 0 } = {}) {
  return String(text).split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => {
    const [node, n, mem] = l.split(',').map(s => s.trim());
    const gb = parseFloat(mem);
    return { t, node, vendor: 'nvidia', kind: 'gpu', sku: `${gb}GB GPU`, devices: +n, deviceMemGB: gb, source: 'philly' };
  });
}

// Per-minute rows → one sample per GPU per `stepMin` (mean of the minutes that reported). A GPU with no reading in a
// step gets no sample, which is how gpu-health sees a GPU that went offline. `machines`: a Set to keep.
export function* gpuUtil(lines, { from = -Infinity, to = Infinity, stepMin = 10, machines: keep = null, skus = {} } = {}) {
  // The file is grouped by machine, then time; each GPU keeps its own open step, emitted when the next step starts.
  const step = stepMin * 60, open = new Map();
  const emit = (k, a) => {
    if (!a.n) return null; // no reading in the whole step: no sample (the GPU was offline)
    const [node, gpu] = k.split('/'), u = a.sum / a.n / 100;
    return { t: a.b + step, node, gpu, vendor: 'nvidia', kind: 'gpu', sku: skus[node] || '', sm: +u.toFixed(4), tensor: +u.toFixed(4), utilSource: 'nvidia-smi',
      offlineMinutes: a.na, faults: [], source: 'philly' };
  };
  for (const line of lines) {
    if (!line || line[0] === 't') continue; // header
    const c = line.split(',');
    const t = toEpoch(c[0]);
    if (t == null || t <= from || t > to) continue;
    const node = c[1];
    if (keep && !keep.has(node)) continue;
    const b = Math.floor(t / step) * step;
    for (let g = 0; g < 8; g++) {
      const v = c[2 + g];
      if (v === undefined || v === '') continue;
      const k = node + '/' + g;
      let a = open.get(k);
      if (a && a.b !== b) { const s = emit(k, a); if (s) yield s; a = null; }
      if (!a) { a = { b, sum: 0, n: 0, na: 0 }; open.set(k, a); }
      if (v === 'NA') a.na++; else { a.sum += +v; a.n++; }
    }
  }
  for (const [k, a] of open) { const s = emit(k, a); if (s) yield s; }
}

const STATUS = { Pass: 'ok', Failed: 'failed', Killed: 'killed' };
// Jobs that overlap the window → placements (one per attempt) and outcomes (one per job that ended in the window).
export function jobLog(jobs, { from = -Infinity, to = Infinity } = {}) {
  const placements = [], outcomes = [];
  for (const j of jobs) {
    const atts = (j.attempts || []).filter(a => a.start_time);
    atts.forEach((a, i) => {
      const s = toEpoch(a.start_time, { tz: 'pacific' }), e = toEpoch(a.end_time, { tz: 'pacific' });
      if (s == null || s > to || (e != null && e <= from)) return;
      const devices = (a.detail || []).flatMap(d => (d.gpus || []).map(g => ({ node: d.ip, gpu: String(g).replace(/^gpu/, '') })));
      if (!devices.length) return;
      placements.push({ t: s, job: j.jobid + (atts.length > 1 ? `#${i + 1}` : ''), class: 'training', owner: j.user, namespace: j.vc, start: s, end: e ?? undefined, devices, source: 'philly' });
      if (i < atts.length - 1 && e != null && e > from && e <= to) outcomes.push({ t: e, job: j.jobid + `#${i + 1}`, status: 'retried', cause: 'unknown', start: s, end: e, devices, gpus: devices.length, source: 'philly' });
    });
    const last = atts[atts.length - 1];
    const end = last && toEpoch(last.end_time, { tz: 'pacific' });
    if (!last || end == null || end <= from || end > to || !STATUS[j.status]) continue;
    const devices = (last.detail || []).flatMap(d => (d.gpus || []).map(g => ({ node: d.ip, gpu: String(g).replace(/^gpu/, '') })));
    outcomes.push({ t: end, job: j.jobid + (atts.length > 1 ? `#${atts.length}` : ''), status: STATUS[j.status], cause: 'unknown', start: toEpoch(last.start_time, { tz: 'pacific' }), end, devices, gpus: devices.length, attempts: atts.length, source: 'philly' });
  }
  return { placements, outcomes };
}
