// Record kinds in the shared data layer. Every record has `t` (epoch seconds) and a `source` saying where it came from.
// The formats reuse what the tools already read, so exporting to a tool is a projection, not a translation:
//   device     one accelerator at one moment: gpu-health's normalized sample (node, gpu, vendor, kind, sku, tensor, sm, dram,
//              memUsedGB, tempC, powerW, eccSbeTotal, …, faults)
//   inventory  a node and what it holds: { node, site?, vendor, kind, sku, devices, deviceMemGB? }
//   placement  a job on devices: { job, class?, owner?, namespace?, start, end?, devices: [{ node, gpu }] | gpuCount + node }
//   job        how a job ended: { job, status: ok|failed|killed|cancelled|timeout, cause: device|app|infra|unknown, start?, end?, devices?, gpus? }
//   serving    a serving pool over a window: { pool, model?, gpu?, windowS, rate, islMean, oslMean, ttftP50, ttftP99, tpotP50, tpotP99,
//              kvUsage?, running?, queued?, preemptions? }
//   request    one inference request: { pool?, isl, osl, cached?, ttft?, e2e? }   (FleetScope trace rows)
//   change     something that changed: { kind: deploy|driver|firmware|config|scale|model|policy, target, summary, from?, to?, by?, id? }
//   health     a device state change: { key, node, gpu, from, to, why, faultClass? }   (gpu-health events)
//   benchmark  a measured run at a known load: { system, gpu, gpus, model, scenario, qps, tokPerS, ttftP50, ttftP99, tpotP50, tpotP99, islMean?, oslMean? }
//   log        one meaningful log line: { node, gpu?, pci?, job?, rank?, code, class, severity: hard|soft|ignore|info, msg }
//              (kernel: XID, AER, NVLink, AMD RAS, MCE, IB link, NFS/Lustre, OOM; app: NCCL/PyTorch; Kubernetes events)
//   topology   an edge: { kind: nvlink|pcie|ib|rack|row|pdu|site, from, to, … }  (node/gpuN, switch:NAME, rack:NAME, …)
//   inventory records may carry versions: { driver, cuda, vbios, inforom, firmware, kernel, os, runtime, kubelet, image }
// Later PRs add calibration, drift, incident and optimization records.

export const KINDS = {
  device: ['node', 'gpu'],
  inventory: ['node'],
  placement: ['job'],
  job: ['job', 'status'],
  serving: ['pool'],
  request: ['isl', 'osl'],
  change: ['kind', 'target'],
  health: ['key', 'to'],
  benchmark: ['gpu', 'gpus', 'model'],
  calibration: ['target'],
  drift: ['target'],
  incident: ['id'],
  optimization: ['id'],
  log: ['node', 'code', 'class'],
  topology: ['kind', 'from', 'to'],
};

export const JOB_STATUS = new Set(['ok', 'failed', 'killed', 'cancelled', 'timeout', 'retried']);
export const CAUSES = new Set(['device', 'app', 'infra', 'unknown']);
export const LOG_CLASSES = new Set(['ecc', 'bus', 'link', 'firmware', 'pcie', 'network', 'storage', 'host-memory', 'cpu', 'node', 'app', 'info']);
export const SEVERITIES = new Set(['hard', 'soft', 'ignore', 'info']);
export const CHANGE_KINDS = new Set(['deploy', 'driver', 'firmware', 'config', 'scale', 'model', 'policy', 'hardware', 'other']);

// Problems with one record, or [] when it is fine.
export function validate(kind, r) {
  const req = KINDS[kind];
  if (!req) return [`unknown kind "${kind}"`];
  const out = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (typeof r.t !== 'number' || !Number.isFinite(r.t)) out.push('t must be epoch seconds');
  for (const f of req) if (r[f] == null || r[f] === '') out.push(`${f} is required`);
  if (kind === 'job' && r.status && !JOB_STATUS.has(r.status)) out.push(`status "${r.status}" is not one of ${[...JOB_STATUS].join(', ')}`);
  if (kind === 'job' && r.cause && !CAUSES.has(r.cause)) out.push(`cause "${r.cause}" is not one of ${[...CAUSES].join(', ')}`);
  if (kind === 'change' && r.kind && !CHANGE_KINDS.has(r.kind)) out.push(`change kind "${r.kind}" is not one of ${[...CHANGE_KINDS].join(', ')}`);
  if (kind === 'log' && r.class && !LOG_CLASSES.has(r.class)) out.push(`log class "${r.class}" is not one of ${[...LOG_CLASSES].join(', ')}`);
  if (kind === 'log' && r.severity && !SEVERITIES.has(r.severity)) out.push(`severity "${r.severity}" is not one of ${[...SEVERITIES].join(', ')}`);
  return out;
}
