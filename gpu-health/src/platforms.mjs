// Platforms: where a node runs, which changes what can be done about it. The accelerator vendor (vendors.mjs) says
// how to read a device and reset it; the platform says who owns the hardware. On a cloud you can't reseat a card or
// align firmware, and rebooting or replacing a node means acting on the cloud's instance, not on the node name.
//
// A node's platform: cfg.nodes[node].platform, else the first cfg.platformByNode regex that matches, else cfg.platform.
// cfg.nodes[node] also carries the instance, zone and project the executors fill in ({instance}, {zone}, {project}).
// cfg.nodesFrom: a `kubectl get nodes -o json` file whose spec.providerID fills cfg.nodes (loadPlatformNodes).
//
// A profile has executors (they win over the vendor's and the global ones), unsupported action kinds, and
// autoRepair: when the cloud's own node repair is on (EKS node auto repair, GKE node auto-repair), reboot and replace
// are left to it: they become notes, so gpu-health and the cloud don't both act on one node.
import fs from 'node:fs';

const OWNED_BY_PROVIDER = ['reseat', 'firmware-align', 'facilities-check'];
export const PLATFORMS = {
  aws: {
    name: 'AWS EC2',
    executors: {
      'node-reboot': [['aws', 'ec2', 'reboot-instances', '--instance-ids', '{instance}']],
      // marking the instance unhealthy makes its Auto Scaling group (EKS managed node groups use one) replace it
      'rma': [['aws', 'autoscaling', 'set-instance-health', '--instance-id', '{instance}', '--health-status', 'Unhealthy', '--no-should-respect-grace-period']],
    },
    unsupported: OWNED_BY_PROVIDER,
    autoRepairNote: 'EKS node auto repair reboots or replaces this node itself once the node monitoring agent sets AcceleratedHardwareReady=False (after about 10 minutes): check the node condition and events.',
  },
  // Compute Engine VMs (Slurm or VM-based clusters): reset the VM; report the host as faulty so Compute Engine repairs
  // it (gcloud compute instances report-host-as-faulty: behaviors PERFORMANCE, SILENT_DATA_CORRUPTION,
  // UNRECOVERABLE_GPU_ERROR, CHIP_ERROR for TPUs).
  gcp: {
    name: 'Google Compute Engine',
    executors: {
      'node-reboot': [['gcloud', 'compute', 'instances', 'reset', '{instance}', '--zone={zone}', '--project={project}']],
      'rma': [['gcloud', 'compute', 'instances', 'report-host-as-faulty', '{instance}', '--zone={zone}', '--project={project}', '--disruption-schedule=IMMEDIATE', '--fault-reasons=behavior={behavior},description=gpu-health']],
    },
    behaviors: { sdc: 'SILENT_DATA_CORRUPTION', performance: 'PERFORMANCE', tpu: 'CHIP_ERROR', default: 'UNRECOVERABLE_GPU_ERROR' },
    unsupported: OWNED_BY_PROVIDER,
  },
  // GKE: label the node with the fault and GKE drains it, reports the host and brings it back repaired
  // (docs.cloud.google.com/ai-hypercomputer/docs/manage/manage-gke-clusters: PERFORMANCE, SDC, XID).
  gke: {
    name: 'Google Kubernetes Engine',
    executors: {
      'node-reboot': [['gcloud', 'compute', 'instances', 'reset', '{instance}', '--zone={zone}', '--project={project}']],
      'rma': [['kubectl', 'label', 'node', '{node}', 'cloud.google.com/fault-behavior={behavior}', '--overwrite']],
    },
    behaviors: { sdc: 'SDC', performance: 'PERFORMANCE', default: 'XID' },
    // GKE's faulty-host label is documented for GPU nodes; TPU slices keep the TPU profile's steps
    skipKinds: ['tpu'],
    unsupported: OWNED_BY_PROVIDER,
    autoRepairNote: 'GKE node auto-repair recreates this node itself when it stays unhealthy (about 10 minutes); a multi-host TPU slice is recreated as a whole node pool.',
  },
};

export function platformOf(cfg, node) {
  if (!cfg) return null;
  const n = (cfg.nodes || {})[node];
  if (n && n.platform) return n.platform;
  for (const [re, p] of Object.entries(cfg.platformByNode || {})) if (node != null && new RegExp(re).test(String(node))) return p;
  return cfg.platform || null;
}
// the profile with any per-config overrides merged in ({ platforms: { aws: { autoRepair: true } } })
export function platformProfile(cfg, node) {
  const k = platformOf(cfg, node); if (!k) return null;
  const base = PLATFORMS[k] || {}, over = ((cfg && cfg.platforms) || {})[k] || {};
  const p = Object.assign({ key: k }, base, over, { executors: Object.assign({}, base.executors, over.executors) });
  if (p.autoRepair) for (const kind of ['node-reboot', 'rma']) p.executors[kind] = { webhook: p.autoRepairNote || `${p.name || k} repairs this node itself: check its repair status.` };
  return p;
}
// spec.providerID → { provider, zone?, project?, instance }: aws:///us-east-1a/i-0abc…, gce://project/zone/name, azure:///…/name
export function cloudIdentity(providerID) {
  const p = String(providerID || ''), m = p.match(/^(\w+):\/\/(.*)$/);
  if (!m) return null;
  const parts = m[2].split('/').filter(Boolean);
  if (m[1] === 'aws') return { provider: 'aws', zone: parts.length > 1 ? parts[parts.length - 2] : undefined, instance: parts[parts.length - 1] };
  if (m[1] === 'gce') return { provider: 'gcp', project: parts[0], zone: parts[1], instance: parts[2] };
  if (m[1] === 'azure') return { provider: 'azure', instance: parts[parts.length - 1] };
  return { provider: m[1], instance: parts[parts.length - 1] };
}
// `kubectl get nodes -o json` → { node: { platform, instance, zone, project } } for cfg.nodes
export function nodesFromK8s(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json, out = {};
  for (const n of j.items || []) {
    const c = cloudIdentity((n.spec || {}).providerID); if (!c) continue;
    const gke = c.provider === 'gcp' && Object.keys((n.metadata || {}).labels || {}).some(k => k.startsWith('cloud.google.com/gke-'));
    const r = { platform: gke ? 'gke' : c.provider, instance: c.instance, zone: c.zone, project: c.project };
    for (const k of Object.keys(r)) if (r[k] == null) delete r[k];
    out[n.metadata.name] = r;
  }
  return out;
}
// cfg.nodesFrom (a file path) → cfg.nodes, with nodes already in the config winning
export function loadPlatformNodes(cfg, read = f => fs.readFileSync(f, 'utf8')) {
  if (!cfg || !cfg.nodesFrom) return cfg;
  const found = nodesFromK8s(read(cfg.nodesFrom)), nodes = Object.assign({}, found);
  for (const [k, v] of Object.entries(cfg.nodes || {})) nodes[k] = Object.assign({}, found[k], v);
  return Object.assign({}, cfg, { nodes });
}
// what executors may fill in for an action: the node's instance, zone and project on the cloud, and the fault
// behavior the cloud's repair API wants for the action's fault class
export function nodeVars(cfg, node, a = {}) {
  const n = ((cfg && cfg.nodes) || {})[node] || {}, p = platformProfile(cfg, node);
  const out = {};
  for (const k of ['instance', 'zone', 'project']) if (n[k] != null) out[k] = n[k];
  if (p && p.behaviors) {
    const cls = String(a.faultClass || ''), b = p.behaviors;
    out.behavior = /sdc|corrupt/i.test(cls) ? b.sdc : /perf|slow|straggl|throttl/i.test(cls) ? b.performance : a.kind === 'tpu' || a.devKind === 'tpu' || a.vendor === 'tpu' ? (b.tpu || b.default) : b.default;
  }
  return out;
}
