// Projections of the data layer into each tool's existing inputs, so the tools run unchanged on shared data.
import fs from 'node:fs';
import path from 'node:path';
import { toGpuHealthFaults } from './adapters/logs.mjs';
import { remediating } from './adapters/nvsentinel.mjs';
import { findSdc, toGpuHealthResults } from './sdc.mjs';

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

// gpu-health: samples.jsonl, jobs.json, results.jsonl (job ends and fault events), plus faults from health records.
export function toGpuHealth(store, { from, to } = {}) {
  const samples = store.query('device', { from, to }).map(({ source, utilSource, offlineMinutes, ...s }) => Object.assign(s, { gpu: String(s.gpu), faults: s.faults || [] }));
  // jobs: placements with device lists that overlap the window (latest attempt wins per job)
  const jobs = new Map();
  for (const p of store.query('placement', { to })) {
    if (p.end != null && from != null && p.end <= from) continue;
    if (!p.devices || !p.devices.length) continue;
    jobs.set(p.job, { id: p.job, class: p.class || 'batch', owner: p.owner || '', namespace: p.namespace || 'default', start: p.start ?? p.t, end: p.end, gpus: p.devices.map(d => ({ node: d.node, gpu: String(d.gpu) })) });
  }
  // a device in two overlapping jobs breaks gpu-health's one-job-per-GPU join: keep the later job
  const owner = new Map();
  for (const j of [...jobs.values()].sort((a, b) => a.start - b.start)) for (const g of j.gpus) owner.set(g.node + '/' + g.gpu, j.id);
  const jobList = [...jobs.values()].map(j => Object.assign(j, { gpus: j.gpus.filter(g => owner.get(g.node + '/' + g.gpu) === j.id) })).filter(j => j.gpus.length);
  const results = store.query('job', { from, to }).filter(j => j.status !== 'retried').map(j => {
    const d = (j.devices || [])[0];
    return Object.assign({ t: j.t, kind: 'job-end', job: j.job, status: j.status === 'ok' ? 'ok' : 'failed', cause: j.cause || 'unknown' }, d ? { node: d.node, gpu: String(d.gpu) } : {}, j.lostGpuHours != null ? { lostGpuHours: j.lostGpuHours } : {});
  });
  // device faults seen only in logs (dmesg XIDs, AER, AMD RAS) reach gpu-health as fault results
  const logs = store.query('log', { from, to });
  results.push(...toGpuHealthFaults(logs));
  // nodes NVSentinel is remediating: gpu-health defers to it rather than queue its own repairs
  for (const [k, r] of remediating(logs, { now: to ?? Infinity })) { const [node, gpu] = k.split('/'); results.push(Object.assign({ t: r.t, kind: 'external-remediation', node, by: r.by, action: r.action, check: r.check }, gpu != null ? { gpu } : {})); }
  // silent data corruption found in the store reaches gpu-health as sdc results (it quarantines with fault class sdc)
  results.push(...toGpuHealthResults(findSdc(store, { from, to })));
  return { samples, jobs: jobList, results };
}
export function writeGpuHealth(store, dir, opts) {
  const x = toGpuHealth(store, opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), jsonl(x.samples));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(x.jobs));
  fs.writeFileSync(path.join(dir, 'results.jsonl'), jsonl(x.results));
  return { dir, samples: x.samples.length, jobs: x.jobs.length, results: x.results.length };
}

// FleetScope trace replay: CSV the Trace replay node reads (timestamp, input_tokens, output_tokens).
export function toFleetScopeTrace(store, { from, to, pool } = {}) {
  const rows = store.query('request', { from, to, where: pool ? r => r.pool === pool : undefined });
  return 'timestamp,input_tokens,output_tokens\n' + rows.map(r => `${new Date(r.t * 1000).toISOString()},${r.isl},${r.osl}`).join('\n') + '\n';
}

// gpu-ledger: one usage record per placement (job attempt or pod), with its status, the GPU type from inventory, and
// utilization from the device samples on its GPUs (busy = samples above 5% SM activity, SM while busy, peak memory).
// Returns { usage, capacity } (capacity: GPUs per node SKU from the latest inventory).
export function toGpuLedger(store, { from, to, cluster = null } = {}) {
  const sku = new Map(), cap = new Map();
  for (const i of store.query('inventory', { to })) sku.set(i.node, i.sku);
  for (const i of store.query('inventory', { to })) cap.set(i.node, { sku: i.sku, devices: i.devices || 0 });
  const status = new Map();
  for (const j of store.query('job', { to })) status.set(j.job, j.status);
  const dev = new Map();
  for (const s of store.query('device', { from, to })) { const k = `${s.node}|${s.gpu}`; if (!dev.has(k)) dev.set(k, []); dev.get(k).push(s); }
  const ST = { ok: 'succeeded', failed: 'failed', timeout: 'failed', retried: 'failed', killed: 'cancelled', cancelled: 'cancelled' };
  const usage = [];
  for (const p of store.query('placement', { to })) {
    const start = p.start ?? p.t, end = p.end ?? null;
    if (end != null && from != null && end <= from) continue;
    const devices = p.devices || [], gpus = devices.length || p.gpuCount || 0; if (!gpus) continue;
    let n = 0, busy = 0, smSum = 0, memPeak = null, run = 0, idleLong = 0, step = 60;
    for (const d of devices) {
      const xs = (dev.get(`${d.node}|${d.gpu}`) || []).filter(s => s.t >= start && (end == null || s.t < end));
      if (xs.length > 1) step = xs[1].t - xs[0].t;
      run = 0;
      for (const s of xs) {
        const u = s.sm ?? s.tensor; if (u == null) continue; n++;
        if (u > 0.05) { busy++; smSum += u; if (run * step >= 1800) idleLong += run * step; run = 0; } else run++;
        if (s.memUsedGB != null && s.memTotalGB) memPeak = Math.max(memPeak || 0, s.memUsedGB / s.memTotalGB);
      }
      if (run * step >= 1800) idleLong += run * step;
    }
    const node = (devices[0] || {}).node || p.node, base = String(p.job).replace(/#\d+$/, '');
    const st = status.get(p.job) ?? status.get(base);
    usage.push({ id: String(p.job), start, end, gpus, gpuType: sku.get(node) || null, cluster, node, kind: p.class === 'inference' || p.class === 'serving' ? 'deployment' : 'job', name: base, group: base,
      user: p.owner || undefined, namespace: p.namespace || undefined, useCase: p.class === 'training' ? 'training' : undefined, status: end == null ? 'running' : ST[st] || 'succeeded',
      util: n ? { busy: busy / n, sm: busy ? smSum / busy : 0, idleLong, samples: n, ...(memPeak != null ? { memPeak } : {}) } : (memPeak != null ? { memPeak } : undefined) });
  }
  const bySku = new Map(); for (const c of cap.values()) if (c.sku) bySku.set(c.sku, (bySku.get(c.sku) || 0) + c.devices);
  return { usage, capacity: [...bySku].map(([gpuType, gpus]) => ({ cluster, gpuType, gpus })) };
}
