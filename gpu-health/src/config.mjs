// Defaults. Override any part with a JSON config file (deep-merged). See docs/CONFIG.md.

export const DEFAULTS = {
  pricePerGpuHour: { default: 4.0 },               // by sku; used for savings
  partitions: [0.125, 0.25, 0.5, 1],               // GPU fractions a workload can be given (MIG / compute-partition sizes, roughly)
  efficiency: {
    warmupMin: 15,            // ignore the first minutes of a job (load, compile, warm-up)
    idleTensor: 0.05, idleDram: 0.10, idleAlertMin: 10, // idle-allocated: both below for this long
    underused: 0.20,          // effective utilization p50 below this = underused
    computeBound: 0.30,       // tensor-active at or above: compute-bound
    memoryBound: 0.50,        // HBM-bandwidth-active at or above: memory-bound
    starvedCpuWait: 0.30,     // low use plus this much CPU/I-O wait = starved
    nonTensorSm: 0.50,        // SM busy at or above with tensor below 0.10 = busy on non-tensor work
    headroom: 1.2,            // memory headroom when recommending a smaller shape
  },
  savings: { minObservedHours: 24, highConfidenceHours: 72, minWeeklySavings: 50 },
  health: {
    staleSec: 300,            // no sample for this long: fail closed (not schedulable)
    staleCircuitBreaker: 0.2, // if more than this share of the fleet is stale at once, suspect monitoring, not GPUs
    sbeRatePerHour: 10,       // corrected ECC errors/hour that make a GPU Suspect
    throttleBusy: 0.2,        // share of busy time clock-limited
    tempOverPeersC: 10,       // hotter than same-SKU peers at similar power
    linkErrPerHour: 100,
    speedIndexMin: 0.92,      // probe result vs cohort median below this = Suspect
    strikeWindowDays: 30, strikesForRma: 2,
  },
  faults: {
    // fault code -> { class, severity: hard (quarantine now) | soft (Suspect) }
    xid48: { class: 'ecc', severity: 'hard' }, xid64: { class: 'ecc', severity: 'hard' }, xid95: { class: 'ecc', severity: 'hard' },
    xid94: { class: 'ecc', severity: 'hard' }, xid63: { class: 'ecc', severity: 'soft' }, xid92: { class: 'ecc', severity: 'soft' },
    xid79: { class: 'bus', severity: 'hard' }, xid74: { class: 'link', severity: 'hard' },
    xid119: { class: 'firmware', severity: 'hard' }, xid120: { class: 'firmware', severity: 'hard' },
    xid13: { class: 'app', severity: 'ignore' }, xid31: { class: 'app', severity: 'ignore' }, xid43: { class: 'app', severity: 'ignore' },
    ras_uncorrectable: { class: 'ecc', severity: 'hard' }, ras_correctable: { class: 'ecc', severity: 'soft' },
    gpu_lost: { class: 'bus', severity: 'hard' },
  },
  // Remediation ladder by fault class: the cheapest step first. Each step is an action kind (see executors).
  ladder: {
    ecc: ['gpu-reset', 'node-reboot', 'rma'], bus: ['node-reboot', 'rma'], link: ['fabric-restart', 'node-reboot', 'rma'],
    firmware: ['gpu-reset', 'firmware-align', 'rma'], pcie: ['node-reboot', 'reseat', 'rma'], thermal: ['facilities-check', 'reseat', 'rma'],
    slow: ['config-reset', 'gpu-reset', 'reseat', 'rma'], stale: ['exporter-check'], default: ['gpu-reset', 'node-reboot', 'rma'],
  },
  diagLevelByClass: { ecc: 3, bus: 3, link: 3, firmware: 2, pcie: 2, thermal: 3, slow: 3, stale: 1, default: 2 },
  // What may happen without a person. auto = executes at once; approve = queued for approval; never = suggestion only.
  policy: {
    dryRun: true,             // commands run only with this false AND --live
    limits: { maxQuarantineShare: 0.1, minQuarantinePerRun: 2, maxNodeRebootsPerRun: 1, maxActionAgeSec: 3600 },
    cooldownSec: { rejected: 7 * 86400, executed: 86400 },
    actions: {
      'quarantine': 'auto', 'release': 'approve', 'notify-owner': 'auto', 'run-diag': 'auto', 'config-reset': 'auto',
      'gpu-reset': 'approve', 'node-reboot': 'approve', 'fabric-restart': 'approve', 'firmware-align': 'approve',
      'rma': 'approve', 'reseat': 'approve', 'facilities-check': 'approve', 'exporter-check': 'auto',
      'reclaim-idle': 'approve', 'scale-in': 'approve', 'resize': 'approve', 'requeue-at-checkpoint': 'approve',
      'deep-diag-next-boundary': 'auto', 'avoid-large-jobs': 'approve', 'label-capability': 'approve', 'repartition': 'approve',
    },
    // Per workload class overrides. Training jobs are never stopped automatically.
    classes: {
      training: { 'reclaim-idle': 'never', 'requeue-at-checkpoint': 'approve' },
      interactive: { 'reclaim-idle': 'approve' },
      inference: { 'scale-in': 'approve', 'resize': 'approve' },
      batch: {},
    },
  },
  // Executors: argv templates (never run through a shell). {node} {gpu} {job} {reason} {replicas} {level} {fraction} are filled
  // from the action and checked against a safe pattern. Replace with your environment's commands.
  executors: {
    'quarantine': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}=quarantined', '--overwrite'], ['kubectl', 'taint', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}=quarantined:NoSchedule', '--overwrite']],
    'release': [['kubectl', 'taint', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}-'], ['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}=serving', '--overwrite']],
    'run-diag': [['kubectl', 'create', 'job', 'gpu-diag-{node}-{gpu}', '--image=registry.example.internal/gpu-diag:1', '--', 'diag', '--node', '{node}', '--gpu', '{gpu}', '--level', '{level}']],
    'deep-diag-next-boundary': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/deep-diag-{gpu}=next-boundary', '--overwrite']],
    'gpu-reset': [['ssh', '{node}', 'sudo', 'nvidia-smi', '-r', '-i', '{gpu}']],
    'node-reboot': [['kubectl', 'drain', '{node}', '--ignore-daemonsets', '--delete-emptydir-data', '--timeout=30m'], ['ssh', '{node}', 'sudo', 'systemctl', 'reboot']],
    'config-reset': [['ssh', '{node}', 'sudo', 'nvidia-smi', '-i', '{gpu}', '-rgc']],
    'scale-in': [['kubectl', '-n', '{namespace}', 'scale', 'deployment', '{job}', '--replicas={replicas}']],
    'reclaim-idle': [['kubectl', '-n', '{namespace}', 'delete', 'pod', '{job}', '--wait=false']],
    'avoid-large-jobs': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}-risk=high', '--overwrite']],
    'label-capability': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/capability={reason}', '--overwrite']],
    'notify-owner': 'webhook', 'rma': 'webhook', 'reseat': 'webhook', 'facilities-check': 'webhook', 'exporter-check': 'webhook',
    'resize': 'webhook', 'repartition': 'webhook', 'requeue-at-checkpoint': 'webhook', 'firmware-align': 'webhook', 'fabric-restart': 'webhook',
  },
  ingest: { mappings: {} },   // per vendor: { nvidia: { fields: { METRIC: [field, scale] }, node: [labels], ... } }
  notify: { webhook: '' }, // Lark/Feishu or Slack incoming-webhook URL; empty = print only
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
export const loadConfig = (over) => merge(DEFAULTS, over || {});

// Mode for an action kind in a workload class: auto | approve | never
export function modeFor(cfg, kind, cls) {
  const c = (cfg.policy.classes || {})[cls] || {};
  return c[kind] || cfg.policy.actions[kind] || 'approve';
}
export const priceFor = (cfg, sku) => cfg.pricePerGpuHour[sku] != null ? cfg.pricePerGpuHour[sku] : cfg.pricePerGpuHour.default;
