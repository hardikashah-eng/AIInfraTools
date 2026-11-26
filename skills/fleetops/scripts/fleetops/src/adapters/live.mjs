// Production sources: exporter scrapes, vLLM metrics, Kubernetes and Slurm inventory, job accounting, change feeds,
// and gpu-health's own history. Each turns what a system already emits into data-layer records.
import { createRequire } from 'node:module';
import { samplesFromExporter, samplesFromCloudMonitoring } from '../../../gpu-health/src/ingest.mjs';
import { cloudIdentity } from '../../../gpu-health/src/platforms.mjs';
import { toEpoch } from './time.mjs';

const require = createRequire(import.meta.url);
const Cal = require('../../../fleetscope/src/calibrate.js');
const REG = require('../../../inference-sizer/src/accelerators.js');

// DCGM, AMD or SambaNova exporter text → device samples (gpu-health's parser; the vendor is detected from metric names).
export const exporterScrape = (text, opts = {}) => samplesFromExporter(text, opts).map(s => Object.assign(s, { source: opts.source || `exporter:${s.vendor}` }));
// Google Cloud Monitoring accelerator metrics (GKE nodes, TPU VMs) → device samples (gpu-health's parser)
export const cloudMonitoring = (json, opts = {}) => samplesFromCloudMonitoring(json, opts).map(s => Object.assign(s, { source: 'cloud-monitoring' }));

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

// accelerator resources and product labels from the shared registry's vendor adapters
const GPU_RESOURCES = Object.assign({ 'google.com/tpu': ['tpu', 'tpu'] }, ...Object.entries(REG.VENDORS).map(([k, v]) => ({ [v.k8sResource]: [k, v.kind] })));
const SKU_LABELS = [...new Set(Object.values(REG.VENDORS).flatMap(v => v.productLabels).concat(['cloud.google.com/gke-tpu-accelerator', 'node.kubernetes.io/instance-type']))];
// spec.providerID → the cloud's own identity for the node (aws:///zone/i-…, gce://project/zone/name): see gpu-health/src/platforms.mjs
export { cloudIdentity };
// `kubectl get nodes -o json` → inventory;  `kubectl get pods -A -o json` → placements for pods that request accelerators.
export function k8sNodes(json, { t = Math.floor(Date.now() / 1000) } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  return (j.items || []).flatMap(n => {
    const cap = (n.status || {}).capacity || {}, labels = (n.metadata || {}).labels || {};
    const res = Object.keys(GPU_RESOURCES).find(r => +cap[r] > 0);
    if (!res) return [];
    const [vendor, kind] = GPU_RESOURCES[res];
    const info = (n.status || {}).nodeInfo || {}, lab = (...ks) => ks.map(k => labels[k]).find(Boolean);
    // GPU feature discovery publishes the driver and CUDA versions as labels (full string, or major/minor/rev)
    const ver = (full, base) => lab(full) || (labels[`${base}.major`] ? [labels[`${base}.major`], labels[`${base}.minor`], labels[`${base}.rev`]].filter(x => x != null && x !== '').join('.') : undefined);
    const versions = { driver: ver('nvidia.com/cuda.driver-version.full', 'nvidia.com/cuda.driver'), cuda: ver('nvidia.com/cuda.runtime-version.full', 'nvidia.com/cuda.runtime'),
      firmware: lab('amd.com/gpu.firmware', 'nvidia.com/gpu.firmware'), kernel: info.kernelVersion, os: info.osImage, runtime: info.containerRuntimeVersion, kubelet: info.kubeletVersion };
    for (const k of Object.keys(versions)) if (!versions[k]) delete versions[k];
    const itype = labels['node.kubernetes.io/instance-type'] || labels['beta.kubernetes.io/instance-type'], inst = REG.instanceOf(itype), cloud = cloudIdentity((n.spec || {}).providerID);
    const sku = SKU_LABELS.filter(k => k !== 'node.kubernetes.io/instance-type').map(k => labels[k]).find(Boolean) || (inst && inst.chip) || itype || '';
    return [{ t, node: n.metadata.name, vendor, kind, sku, devices: +cap[res],
      site: labels['topology.kubernetes.io/region'] || labels['topology.kubernetes.io/zone'] || '', rack: lab(...RACK_LABELS) || undefined,
      ...(itype ? { instanceType: itype } : {}), ...(cloud ? { cloud } : {}),
      ...(Object.keys(versions).length ? { versions } : {}), source: 'kubernetes' }];
  });
}
// Node conditions that report hardware trouble, as log records: the EKS node monitoring agent's AcceleratedHardwareReady,
// NetworkingReady, StorageReady and KernelReady (bad when False; the reason names the fault, e.g. NvidiaXID79Error),
// and node-problem-detector's conditions on any cloud (KernelDeadlock, ReadonlyFilesystem, … bad when True).
const STD_CONDITIONS = new Set(['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']);
const COND_CLASS = { AcceleratedHardwareReady: 'hardware', NetworkingReady: 'network', StorageReady: 'storage', KernelReady: 'node' };
export function k8sNodeConditions(json, { t: t0 = Math.floor(Date.now() / 1000) } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json, out = [];
  for (const n of j.items || []) for (const c of (n.status || {}).conditions || []) {
    if (STD_CONDITIONS.has(c.type)) continue;
    const bad = /Ready$/.test(c.type) ? c.status === 'False' : c.status === 'True';
    if (!bad) continue;
    const reason = String(c.reason || c.type), xid = reason.match(/NvidiaXID(\d+)Error/);
    const cls = xid ? 'gpu' : /DoubleBit|ECC|PageRetire|RowRemap/i.test(reason) ? 'ecc' : /Neuron/.test(reason) ? 'hardware' : COND_CLASS[c.type] || 'node';
    out.push({ t: toEpoch(c.lastTransitionTime || c.lastHeartbeatTime) ?? t0, node: n.metadata.name, code: xid ? `xid${xid[1]}` : `k8s_${c.type}`, class: cls, severity: 'hard',
      reason, condition: c.type, msg: String(c.message || '').slice(0, 300), source: 'k8s-condition' });
  }
  // GKE: host maintenance scheduled for a GPU or TPU node (they don't live-migrate): planned, not a fault
  for (const n of j.items || []) {
    const at = +(((n.metadata || {}).labels || {})['cloud.google.com/scheduled-maintenance-time']);
    if (at > 0) out.push({ t: t0, node: n.metadata.name, code: 'scheduled_maintenance', class: 'maintenance', severity: 'info', at, msg: `host maintenance scheduled for ${new Date(at * 1000).toISOString()}`, source: 'k8s-label' });
  }
  return out;
}
// Rack labels people use; Kubernetes has no standard one.
export const RACK_LABELS = ['topology.kubernetes.io/rack', 'node.kubernetes.io/rack', 'rack', 'topology.aiinfra/rack'];
// Rack and zone of each accelerator node, as topology edges (from the same `kubectl get nodes -o json`).
export function k8sNodeTopology(json, opts = {}) {
  return k8sNodes(json, opts).flatMap(n => [
    ...(n.rack ? [{ t: n.t, kind: 'rack', from: n.node, to: `rack:${n.rack}`, source: 'kubernetes' }] : []),
    ...(n.site ? [{ t: n.t, kind: 'site', from: n.node, to: `site:${n.site}`, source: 'kubernetes' }] : []),
  ]);
}

// `kubectl get events -A -o json` → { changes, logs }.
//   changes: cordon/uncordon, reboots, scaling.   logs: node not ready, node/system OOM, mount failures, evictions.
const EVENT_MAP = {
  NodeNotSchedulable: { change: 'config', summary: 'cordoned' }, NodeSchedulable: { change: 'config', summary: 'uncordoned' },
  Rebooted: { change: 'hardware', summary: 'rebooted' }, ScalingReplicaSet: { change: 'scale' },
  NodeNotReady: { log: { code: 'node_not_ready', class: 'node', severity: 'hard' } },
  OOMKilling: { log: { code: 'host_oom', class: 'host-memory', severity: 'soft' } }, SystemOOM: { log: { code: 'host_oom', class: 'host-memory', severity: 'soft' } },
  FailedMount: { log: { code: 'mount_failed', class: 'storage', severity: 'hard' } }, FailedAttachVolume: { log: { code: 'mount_failed', class: 'storage', severity: 'hard' } },
  Evicted: { log: { code: 'evicted', class: 'node', severity: 'soft' } },
};
export function k8sEvents(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json, changes = [], logs = [];
  for (const e of j.items || []) {
    const m = EVENT_MAP[e.reason];
    if (!m) continue;
    const t = toEpoch(e.lastTimestamp || e.eventTime || e.firstTimestamp || (e.metadata || {}).creationTimestamp);
    if (t == null) continue;
    const o = e.involvedObject || {}, ns = o.namespace || (e.metadata || {}).namespace;
    const node = o.kind === 'Node' ? o.name : (e.source || {}).host || e.reportingInstance || undefined;
    if (m.change) changes.push({ t, kind: m.change, target: o.kind === 'Node' ? o.name : `${ns}/${o.name}`, summary: m.summary || e.message || e.reason, by: (e.source || {}).component || e.reportingComponent, id: (e.metadata || {}).uid, source: 'kubernetes-events' });
    else if (node) logs.push(Object.assign({ t, node }, m.log, { pod: o.kind === 'Pod' ? `${ns}/${o.name}` : undefined, count: e.count, msg: String(e.message || '').slice(0, 300), source: 'kubernetes-events' }));
  }
  for (const l of logs) for (const k of Object.keys(l)) if (l[k] === undefined) delete l[k];
  return { changes, logs };
}

// `helm history RELEASE -n NS -o json` → deploy changes, one per revision.
export function helmHistory(json, { release, namespace = 'default' } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const revs = (Array.isArray(j) ? j : []).slice().sort((a, b) => a.revision - b.revision);
  return revs.map((r, i) => ({ t: toEpoch(r.updated), kind: 'deploy', target: `${namespace}/${release}`, summary: `${r.chart}${r.app_version ? ` (app ${r.app_version})` : ''}: ${r.description || r.status}`,
    from: i ? revs[i - 1].chart : undefined, to: r.chart, status: r.status, id: `${namespace}/${release}#${r.revision}`, source: 'helm' })).filter(r => r.t != null)
    .map(r => { if (r.from === undefined) delete r.from; return r; });
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
    // OS=Linux 5.15.0-91-generic #101-Ubuntu …  (the value runs to the next Key=, so it's re-read from the line)
    const os = (l.match(/\bOS=Linux (\S+)/) || [])[1];
    return [{ t, node: f.NodeName, vendor: /mi\d|amd/i.test(g[1] || '') ? 'amd' : 'nvidia', kind: 'gpu', sku: g[1] || '', devices: +g[2], state: f.State,
      ...(os ? { versions: { kernel: os } } : {}), source: 'slurm' }];
  });
}
// "gpu[01-03,07],cpu5" → ["gpu01","gpu02","gpu03","gpu07","cpu5"]
export function expandNodes(list) {
  const out = [];
  for (const part of String(list || '').match(/[^,[]+(\[[^\]]*\])?/g) || []) {
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
