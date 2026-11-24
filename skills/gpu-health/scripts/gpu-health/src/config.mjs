// Defaults. Override any part with a JSON config file (deep-merged). See docs/CONFIG.md.
import { VENDORS } from './vendors.mjs';

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
    memTempOverPeersC: 8,     // HBM hotter than peers (same node and job, else same SKU at similar power)
    memTempRiseC: 6,          // HBM warmer than the GPU's own earlier days at the same power
    powerBrakeBusy: 0.05,     // share of busy time in power-brake slowdown
    telemetryGapFrac: 0.3,    // share of expected samples missing in the last hour (one GPU, node-mates fine)
    persistN: 3, persistK: 4, persistWindowMin: 60, // windowed signals must fire in N of the last K windows
    signalCooldownMin: 120,   // a cleared soft signal stays quiet this long
    sdcSoft: 1, sdcHard: 2, sdcWindowDays: 7, // silent-data-corruption events per GPU: suspect / quarantine
  },
  // Fault codes that mean the same on every vendor. Vendor-specific codes (NVIDIA XIDs, AMD RAS events, SambaNova and
  // TPU fault types) live in the vendor profiles (src/vendors.mjs). Codes listed here win over a vendor's, so this is
  // also where to override one: fault code -> { class, severity: hard (quarantine now) | soft (suspect) | ignore }.
  faults: {
    gpu_lost: { class: 'bus', severity: 'hard' }, device_lost: { class: 'bus', severity: 'hard' },
    // Codes fleetops reads from kernel logs (any vendor). A corrected PCIe error alone is normal; a degraded link
    // shows up in the PCIe width/gen signals instead.
    pcie_aer_uncorrected: { class: 'pcie', severity: 'hard' }, pcie_aer_corrected: { class: 'pcie', severity: 'ignore' },
    nvlink_error: { class: 'link', severity: 'hard' }, cuda_ecc_uncorrectable: { class: 'ecc', severity: 'hard' },
    amd_gpu_reset: { class: 'firmware', severity: 'soft' },
  },
  vendors: VENDORS,
  // Remediation ladder by fault class: the cheapest step first. Each step is an action kind (see executors).
  ladder: {
    ecc: ['gpu-reset', 'node-reboot', 'rma'], bus: ['node-reboot', 'rma'], link: ['fabric-restart', 'node-reboot', 'rma'],
    firmware: ['gpu-reset', 'firmware-align', 'rma'], pcie: ['node-reboot', 'reseat', 'rma'], thermal: ['facilities-check', 'reseat', 'rma'],
    slow: ['config-reset', 'gpu-reset', 'reseat', 'rma'], stale: ['exporter-check'], default: ['gpu-reset', 'node-reboot', 'rma'],
    power: ['facilities-check', 'reseat', 'rma'], telemetry: ['exporter-check', 'node-reboot', 'rma'], sdc: ['gpu-reset', 'rma'],
    platform: ['gpu-reset', 'node-reboot', 'rma'],
  },
  diagLevelByClass: { ecc: 3, bus: 3, link: 3, firmware: 2, pcie: 2, thermal: 3, slow: 3, stale: 1, power: 3, telemetry: 2, sdc: 4, platform: 3, default: 2 },
  // What may happen without a person. auto = executes at once; approve = queued for approval; never = suggestion only.
  policy: {
    dryRun: true,             // commands run only with this false AND --live
    limits: { maxQuarantineShare: 0.1, minQuarantinePerRun: 2, maxNodeRebootsPerRun: 1, maxNodeCordonsPerRun: 2, maxScaleOutStep: 4, maxActionAgeSec: 3600 },
    cooldownSec: { rejected: 7 * 86400, executed: 86400 },
    actions: {
      'quarantine': 'auto', 'release': 'approve', 'notify-owner': 'auto', 'run-diag': 'auto', 'config-reset': 'auto',
      'gpu-reset': 'approve', 'node-reboot': 'approve', 'fabric-restart': 'approve', 'firmware-align': 'approve',
      'rma': 'approve', 'reseat': 'approve', 'facilities-check': 'approve', 'exporter-check': 'auto',
      'reclaim-idle': 'approve', 'scale-in': 'approve', 'resize': 'approve',
      'deep-diag-next-boundary': 'auto', 'avoid-large-jobs': 'approve', 'label-capability': 'approve', 'repartition': 'approve',
      'swap-at-checkpoint': 'approve', 'drain-inference': 'approve',
      // used by the fleetops live agent: stopping new work on a node and telling people is automatic; anything that
      // moves running work, adds cost or undoes a change waits for a person (see fleetops examples/agent-policy.realtime.json)
      'cordon-node': 'auto', 'uncordon-node': 'approve', 'link-check': 'auto', 'hold-rollout': 'auto',
      'drain-replica': 'approve', 'scale-out': 'approve', 'rollback-change': 'approve', 'restart-without-node': 'approve',
      // fleetops power: a cap slows work, so it needs a person (the plan says by how much)
      'power-cap': 'approve', 'power-cap-node': 'approve',
      // fleetops admission: releasing a node into the pool needs a person; keeping a failed node out is automatic
      'admit-node': 'approve', 'reject-node': 'auto', 'rollout-stage': 'approve',
    },
    // Per workload class overrides. Training jobs are never stopped automatically.
    classes: {
      training: { 'reclaim-idle': 'never', 'swap-at-checkpoint': 'approve' },
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
    // The training launcher (elastic agent) watches this label: checkpoint, then restart without the node.
    'swap-at-checkpoint': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/swap-at-checkpoint={job}', '--overwrite']],
    // The Service selects gpu-health.aiinfra/serving=true (set in the pod template); flipping it stops new requests
    // reaching the replica while in-flight ones finish.
    'drain-inference': [['kubectl', '-n', '{namespace}', 'label', 'pods', '-l', 'app={job}', '--field-selector=spec.nodeName={node}', 'gpu-health.aiinfra/serving=false', '--overwrite']],
    'avoid-large-jobs': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/gpu-{gpu}-risk=high', '--overwrite']],
    'label-capability': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/capability={reason}', '--overwrite']],
    // fleetops live agent. cordon stops new pods landing on the node; running work is untouched.
    'cordon-node': [['kubectl', 'cordon', '{node}']],
    'uncordon-node': [['kubectl', 'uncordon', '{node}']],
    // one serving replica out of the Service (same label as drain-inference), by pod name
    'drain-replica': [['kubectl', '-n', '{namespace}', 'label', 'pod', '{replica}', 'gpu-health.aiinfra/serving=false', '--overwrite']],
    'scale-out': [['kubectl', '-n', '{namespace}', 'scale', 'deployment', '{job}', '--replicas={replicas}']],
    'rollback-change': [['helm', 'rollback', '{release}', '{revision}', '-n', '{namespace}', '--wait']],
    // the training launcher (elastic agent) watches this label: restart from the last checkpoint without the node
    'restart-without-node': [['kubectl', 'label', 'node', '{node}', 'gpu-health.aiinfra/restart-without={job}', '--overwrite']],
    // a GPU power limit in watts; the undo sets it back to the default limit
    'power-cap': [['ssh', '{node}', 'sudo', 'nvidia-smi', '-i', '{gpu}', '-pl', '{watts}']],
    'power-cap-node': [['ssh', '{node}', 'sudo', 'nvidia-smi', '-pl', '{watts}']],
    // fleetops admission. New and repaired nodes join with the taint aiinfra.dev/admission=pending:NoSchedule
    // (kubelet --register-with-taints, or set it when the node goes to repair); admitting removes it.
    'admit-node': [['kubectl', 'taint', 'node', '{node}', 'aiinfra.dev/admission-'], ['kubectl', 'label', 'node', '{node}', 'aiinfra.dev/admission=admitted', '--overwrite']],
    'reject-node': [['kubectl', 'label', 'node', '{node}', 'aiinfra.dev/admission=rejected', '--overwrite']],
    'link-check': { webhook: 'check the node\'s NICs and cables (ibstat / ethtool counters, link speed and width, PCIe AER) and the switch port' },
    'hold-rollout': { webhook: 'pause the rollout of this version until a node rolled back to the fleet version passes the failed job' },
    'notify-owner': 'webhook', 'rma': 'webhook', 'reseat': 'webhook', 'facilities-check': 'webhook', 'exporter-check': 'webhook',
    'resize': 'webhook', 'repartition': 'webhook', 'firmware-align': 'webhook', 'fabric-restart': 'webhook',
  },
  ingest: { mappings: {} },   // per vendor, merged over vendors.<v>.mapping: { nvidia: { fields: { METRIC: [field, scale] }, node: [labels], ... } }
  // Flakiness dashboard (gpu-health flakiness): see src/flakiness.mjs.
  flakiness: {
    windowDays: 60,           // history to look back over
    bounceDays: 7,            // failing again within this many days of returning to service is a bounce
    holdDays: [7, 30],        // a repair holds if the GPU stays in service this long
    rmaHardFailures: 3,       // hard failures in the window that make a GPU an RMA candidate
    warnHours: 72,            // a hard failure counts as warned if the GPU was suspect within this many hours before
    cohortRatio: 2,           // a group failing at this multiple of the fleet rate is flagged…
    cohortMinDevices: 3,      // …when at least this many of its GPUs failed (one bad GPU is not a cohort)
    minRepairs: 3,            // repairs needed before judging whether a repair kind holds
    lostHoursPerFailure: 1,   // GPU-hours lost per GPU of a job when a device failure kills it (when results don't say)
  },
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
