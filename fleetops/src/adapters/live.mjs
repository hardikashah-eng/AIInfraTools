// Production sources: exporter scrapes, vLLM metrics, Kubernetes and Slurm inventory, job accounting, change feeds,
// and gpu-health's own history. Each turns what a system already emits into data-layer records.
import { createRequire } from 'node:module';
import { samplesFromExporter } from '../../../gpu-health/src/ingest.mjs';
import { toEpoch } from './time.mjs';

const require = createRequire(import.meta.url);
const Cal = require('../../../fleetscope/src/calibrate.js');

// DCGM, AMD or SambaNova exporter text → device samples (gpu-health's parser; the vendor is detected from metric names).
export const exporterScrape = (text, opts = {}) => samplesFromExporter(text, opts).map(s => Object.assign(s, { source: opts.source || `exporter:${s.vendor}` }));

// Two vLLM /metrics snapshots (or one with the window it covers) → one serving record for the pool.
export function vllmSnapshot(text, { before, windowS, t, pool, model, gpu } = {}) {
  const m = Cal.fromVllmMetrics(text, { before, windowS, model });
  return { t: t ?? Math.floor(Date.now() / 1000), pool, model, gpu, windowS: m.windowS, rate: m.rate, islMean: m.islMean, oslMean: m.oslMean,
    ttftP50: m.ttftP50, ttftP99: m.ttftP99, tpotP50: m.tpotP50, tpotP99: m.tpotP99, kvUsage: m.kvUsage, running: m.running, source: 'vllm-metrics' };
}

// A Prometheus query_range answer (JSON) for one serving metric → serving records, one per point.
//   field: the serving field the query computes, e.g. ttftP99 for histogram_quantile(0.99, rate(vllm:time_to_first_token_seconds_bucket[5m]))
export function promRange(json, { field, pool, label = 'model_name' } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const out = [];
  for (const s of ((j.data || {}).result || [])) for (const [t, v] of s.values || []) {
    const x = +v;
    if (!Number.isFinite(x)) continue;
    out.push({ t: +t, pool: pool || s.metric[label] || s.metric.instance || 'default', [field]: x, windowS: 300, source: 'prometheus' });
  }
  return out;
}

const GPU_RESOURCES = { 'nvidia.com/gpu': ['nvidia', 'gpu'], 'amd.com/gpu': ['amd', 'gpu'], 'google.com/tpu': ['tpu', 'tpu'] };
const SKU_LABELS = ['nvidia.com/gpu.product', 'amd.com/gpu.product-name', 'cloud.google.com/gke-tpu-accelerator', 'node.kubernetes.io/instance-type'];
// `kubectl get nodes -o json` → inventory;  `kubectl get pods -A -o json` → placements for pods that request accelerators.
export function k8sNodes(json, { t = Math.floor(Date.now() / 1000) } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  return (j.items || []).flatMap(n => {
    const cap = (n.status || {}).capacity || {}, labels = (n.metadata || {}).labels || {};
    const res = Object.keys(GPU_RESOURCES).find(r => +cap[r] > 0);
    if (!res) return [];
    const [vendor, kind] = GPU_RESOURCES[res];
    return [{ t, node: n.metadata.name, vendor, kind, sku: SKU_LABELS.map(k => labels[k]).find(Boolean) || '', devices: +cap[res],
      site: labels['topology.kubernetes.io/region'] || labels['topology.kubernetes.io/zone'] || '', source: 'kubernetes' }];
  });
}
export function k8sPods(json, { t = Math.floor(Date.now() / 1000) } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  return (j.items || []).flatMap(p => {
    const req = (p.spec.containers || []).reduce((n, c) => n + Object.keys(GPU_RESOURCES).reduce((m, r) => m + (+((c.resources || {}).limits || {})[r] || +((c.resources || {}).requests || {})[r] || 0), 0), 0);
    if (!req || !p.spec.nodeName || ['Succeeded', 'Failed'].includes((p.status || {}).phase)) return [];
    const labels = p.metadata.labels || {}, owner = ((p.metadata.ownerReferences || [])[0] || {});
    const start = toEpoch((p.status || {}).startTime) ?? t;
    return [{ t: start, job: labels.app || labels['app.kubernetes.io/name'] || owner.name || p.metadata.name, pod: p.metadata.name, namespace: p.metadata.namespace,
      class: labels['gpu-health.aiinfra/class'] || labels['workload-class'] || (owner.kind === 'Job' ? 'batch' : 'inference'), owner: labels.team || labels.owner || '',
      node: p.spec.nodeName, gpuCount: req, start, source: 'kubernetes' }];
  });
}

// `scontrol show node -o` → inventory.
export function slurmNodes(text, { t = Math.floor(Date.now() / 1000) } = {}) {
  return String(text).split(/\r?\n/).filter(l => /NodeName=/.test(l)).flatMap(l => {
    const f = Object.fromEntries([...l.matchAll(/(\w+)=(\S*)/g)].map(m => [m[1], m[2]]));
    const g = (f.Gres || '').match(/gpu:(?:([\w.-]+):)?(\d+)/);
    if (!g) return [];
    return [{ t, node: f.NodeName, vendor: /mi\d|amd/i.test(g[1] || '') ? 'amd' : 'nvidia', kind: 'gpu', sku: g[1] || '', devices: +g[2], state: f.State, source: 'slurm' }];
  });
}
// "gpu[01-03,07],cpu5" → ["gpu01","gpu02","gpu03","gpu07","cpu5"]
export function expandNodes(list) {
  const out = [];
  for (const part of String(list || '').match(/[^,\[]+(\[[^\]]*\])?/g) || []) {
    const m = part.match(/^(.*)\[(.*)\]$/);
    if (!m) { if (part) out.push(part); continue; }
    for (const r of m[2].split(',')) {
      const [a, b] = r.split('-');
      if (b == null) { out.push(m[1] + a); continue; }
      for (let i = +a; i <= +b; i++) out.push(m[1] + String(i).padStart(a.length, '0'));
    }
  }
  return out;
}
const SLURM_STATE = { COMPLETED: ['ok', 'unknown'], FAILED: ['failed', 'app'], CANCELLED: ['cancelled', 'unknown'], TIMEOUT: ['timeout', 'app'], NODE_FAIL: ['failed', 'infra'], OUT_OF_MEMORY: ['failed', 'app'], PREEMPTED: ['killed', 'unknown'], BOOT_FAIL: ['failed', 'infra'] };
// `sacct -P -X --format=JobID,JobName,State,ExitCode,Start,End,NodeList,AllocTRES` → job outcomes.
export function slurmSacct(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean), h = lines[0].split('|').map(s => s.toLowerCase());
  const ix = k => h.indexOf(k);
  return lines.slice(1).flatMap(l => {
    const c = l.split('|'), state = (c[ix('state')] || '').split(' ')[0], st = SLURM_STATE[state];
    const end = toEpoch(c[ix('end')]);
    if (!st || end == null) return [];
    const gpus = +((c[ix('alloctres')] || '').match(/gres\/gpu(?::[\w.-]+)?=(\d+)/) || [])[1] || 0;
    return [{ t: end, job: c[ix('jobid')], name: c[ix('jobname')], status: st[0], cause: st[1], start: toEpoch(c[ix('start')]), end, nodes: expandNodes(c[ix('nodelist')]), gpus, exitCode: c[ix('exitcode')], source: 'slurm' }];
  });
}

// Change feed. JSON lines of { t, kind, target, summary, … } as is, or `git log` of a GitOps / infra repo:
//   git log --date=unix --pretty=format:'@@%H|%ad|%an|%s' --name-only
// Each commit becomes a change; its target is the deepest folder it touched (e.g. clusters/prod/pools/h200).
export function changesJsonl(text) { return String(text).split(/\r?\n/).filter(l => l.trim()).map(l => Object.assign({ source: 'change-feed' }, JSON.parse(l))); }
const KIND_HINTS = [[/driver|cuda|nvidia-smi|rocm/i, 'driver'], [/firmware|vbios|bios/i, 'firmware'], [/replica|scale|autoscal|instances/i, 'scale'], [/model|checkpoint|weights/i, 'model'], [/quota|policy|kueue|priority/i, 'policy'], [/deploy|image|release|rollout|version/i, 'deploy']];
export function gitLog(text, { repo = 'infra' } = {}) {
  const out = [];
  for (const block of String(text).split('@@').filter(b => b.trim())) {
    const [head, ...files] = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const [id, t, by, ...subj] = head.split('|'), summary = subj.join('|');
    const dirs = files.map(f => f.split('/').slice(0, -1).join('/')).filter(Boolean);
    const target = dirs.sort((a, b) => b.split('/').length - a.split('/').length)[0] || repo;
    const kind = (KIND_HINTS.find(([re]) => re.test(summary + ' ' + files.join(' '))) || [])[1] || 'config';
    out.push({ t: +t, id: id.slice(0, 12), kind, target, summary, by, files, source: `git:${repo}` });
  }
  return out;
}

// gpu-health's state directory: events.jsonl (state changes) → health; results.jsonl job-end and fault events → job.
export function gpuHealthEvents(text) {
  return String(text).split(/\r?\n/).filter(l => l.trim()).map(l => Object.assign({ source: 'gpu-health' }, JSON.parse(l)));
}
export function gpuHealthResults(text) {
  return String(text).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).filter(r => r.kind === 'job-end')
    .map(r => ({ t: r.t, job: r.job, status: r.status === 'failed' ? 'failed' : 'ok', cause: r.cause || 'unknown', devices: r.node != null ? [{ node: r.node, gpu: String(r.gpu) }] : undefined, rank: r.rank, lostGpuHours: r.lostGpuHours, source: 'gpu-health' }));
}
