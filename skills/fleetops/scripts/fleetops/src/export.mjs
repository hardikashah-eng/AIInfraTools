// Projections of the data layer into each tool's existing inputs, so the tools run unchanged on shared data.
import fs from 'node:fs';
import path from 'node:path';
import { toGpuHealthFaults } from './adapters/logs.mjs';

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
  results.push(...toGpuHealthFaults(store.query('log', { from, to })));
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
