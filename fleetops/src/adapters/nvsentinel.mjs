// NVSentinel (NVIDIA's GPU fault detection and remediation for Kubernetes) health events → `log` records.
//
// NVSentinel already detects GPU faults (DCGM health watches, XIDs from syslog, NVLink, NICs, CSP maintenance) and can
// cordon, drain and remediate nodes on its own. fleetops takes its events as evidence for root-cause analysis, and
// gpu-health defers to it: a node NVSentinel is remediating gets no second repair ladder from gpu-health.
//
// Reads, in any mix (JSON, JSON lines, or a Kubernetes List):
//   - CloudEvents from the event exporter: { specversion, type: "com.nvidia.nvsentinel.health.v1", data: { healthEvent } }
//   - datastore documents: { createdAt, healthEvent, healthEventStatus } (nodeQuarantined, faultRemediated, …)
//   - HealthEventResource objects (healthevents.dgxc.nvidia.com): { spec: HealthEvent, status: HealthEventStatus }
//   - bare HealthEvent objects (protobuf JSON: camelCase; enums as names or numbers; timestamps RFC 3339 or {seconds})
// Fields as in NVSentinel v1.33.0's data-models/protobufs/health_event.proto and event-exporter.
import { xidClass, DEVICE_CLASSES } from './logs.mjs';

const ACTIONS = { 0: 'NONE', 2: 'COMPONENT_RESET', 5: 'CONTACT_SUPPORT', 6: 'RUN_FIELDDIAG', 15: 'RESTART_VM', 24: 'RESTART_BM', 25: 'REPLACE_VM', 26: 'RUN_DCGMEUD', 27: 'CUSTOM', 99: 'UNKNOWN' };
const STRATEGIES = { 0: 'UNSPECIFIED', 1: 'EXECUTE_REMEDIATION', 2: 'STORE_ONLY', 3: 'STORE_AND_ANALYSE' };
const enumName = (v, table) => (v == null || v === '' ? null : typeof v === 'number' || /^\d+$/.test(String(v)) ? table[+v] || String(v) : String(v));
const ts = v => { if (v == null) return null; if (typeof v === 'object') { if (v.$date) return ts(v.$date); if (v.seconds != null) return +v.seconds + (+v.nanos || 0) / 1e9; } const t = Date.parse(v); return Number.isFinite(t) ? t / 1000 : typeof v === 'number' ? (v > 1e12 ? v / 1000 : v) : null; };

// a check → the log class it belongs to (XIDs by their number, through gpu-health's fault table)
function classify(e) {
  const check = String(e.checkName || ''), comp = String(e.componentClass || ''), codes = (e.errorCode || []).map(String);
  const xid = codes.map(c => (c.match(/^(?:XID[_ ]?)?(\d+)$/i) || [])[1]).find(Boolean);
  if (xid && /xid|syslog/i.test(check + ' ' + e.agent)) { const [cls, sev] = xidClass(+xid); return { code: `xid${xid}`, class: cls, severity: sev }; }
  if (/fallen ?off|gpufallenoff/i.test(check)) return { code: 'xid79', class: 'bus', severity: 'hard' };
  const code = `nvsentinel:${check || comp || 'event'}`;
  if (/sxid|nvswitch|nvlink|link/i.test(check)) return { code, class: 'link', severity: 'hard' };
  if (/mem|ecc|row ?remap|sram|dbe|sbe/i.test(check)) return { code, class: 'ecc', severity: 'hard' };
  if (/pci/i.test(check)) return { code, class: 'pcie', severity: 'hard' };
  if (/ethernet|nic|infiniband|\bib\b|network/i.test(check + ' ' + comp)) return { code, class: 'network', severity: 'soft' };
  if (/thermal|power|clock/i.test(check)) return { code, class: 'firmware', severity: 'soft' };
  if (/dcgm|driver|firmware|inforom/i.test(check)) return { code, class: 'firmware', severity: 'soft' };
  if (/^gpu$/i.test(comp)) return { code, class: 'firmware', severity: 'soft' };
  return { code, class: 'node', severity: 'soft' };
}

export function toLog(e, status = null, { cluster = null } = {}) {
  if (!e || !e.nodeName) return null;
  const t = ts(e.generatedTimestamp); if (t == null) return null;
  const c = classify(e), ents = e.entitiesImpacted || [], ent = k => (ents.find(x => x.entityType === k) || {}).entityValue;
  const action = enumName(e.recommendedAction, ACTIONS), strategy = enumName(e.processingStrategy, STRATEGIES);
  const r = { t, node: e.nodeName, code: c.code, class: c.class, severity: e.isHealthy ? 'info' : e.isFatal ? 'hard' : c.severity, msg: String(e.message || '').slice(0, 300), source: 'nvsentinel',
    check: e.checkName || undefined, agent: e.agent || undefined, recommendedAction: action || undefined, healthy: !!e.isHealthy, strategy: strategy || undefined };
  const gpu = ent('GPU'); if (gpu != null && /^\d+$/.test(gpu)) r.gpu = gpu; else if (gpu) r.gpuUuid = gpu;
  if (ent('GPU_UUID')) r.gpuUuid = ent('GPU_UUID'); if (ent('PCI')) r.pci = ent('PCI');
  if (cluster) r.cluster = cluster;
  // NVSentinel acts on this event itself: it remediates unless told only to store, and only for unhealthy events that recommend something
  r.remediating = !e.isHealthy && strategy !== 'STORE_ONLY' && strategy !== 'STORE_AND_ANALYSE' && !!action && !['NONE', 'UNKNOWN'].includes(action);
  if (status) {
    if (status.nodeQuarantined) r.quarantine = status.nodeQuarantined;
    const fr = status.faultRemediated; if (fr != null) r.remediated = typeof fr === 'object' ? !!fr.value : !!fr;
    if (status.remediationDecision && status.remediationDecision.action) r.remediationAction = status.remediationDecision.action;
  }
  if (!DEVICE_CLASSES.has(r.class)) delete r.gpu;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return r;
}

function* objects(text) {
  const s = String(text).trim(); if (!s) return;
  let docs;
  try { const j = JSON.parse(s); docs = Array.isArray(j) ? j : j && Array.isArray(j.items) ? j.items : [j]; }
  catch { docs = s.split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }); }
  for (const d of docs) if (d && typeof d === 'object') yield d;
}

export function nvsentinelEvents(text) {
  const logs = []; let unmatched = 0;
  for (const d of objects(text)) {
    let e = null, status = null, cluster = null;
    if (d.specversion && d.data && d.data.healthEvent) { e = d.data.healthEvent; cluster = d.data.metadata && d.data.metadata.cluster; }
    else if (d.healthEvent) { e = d.healthEvent; status = d.healthEventStatus || null; }
    else if (d.kind === 'HealthEventResource' || (d.spec && d.spec.nodeName)) { e = d.spec; status = d.status || null; }
    else if (d.nodeName && (d.checkName || d.componentClass)) e = d;
    const r = e && toLog(e, status, { cluster });
    if (r) logs.push(r); else unmatched++;
  }
  return { logs: logs.sort((a, b) => a.t - b.t), unmatched };
}

// Nodes NVSentinel is remediating now: the latest unhealthy, remediating event per node (and GPU) that no later healthy
// event for the same check has cleared and NVSentinel hasn't marked remediated.
export function remediating(logs, { now = Infinity, withinS = 24 * 3600 } = {}) {
  const last = new Map();
  for (const l of logs.filter(x => x.source === 'nvsentinel' && x.t <= now).sort((a, b) => a.t - b.t)) {
    const k = `${l.node}|${l.check || l.code}`;
    if (l.healthy) last.delete(k); else last.set(k, l);
  }
  const out = new Map();
  for (const l of last.values()) if (l.remediating && !l.remediated && now - l.t <= withinS) {
    const k = l.gpu != null ? `${l.node}/${l.gpu}` : l.node;
    out.set(k, { by: 'nvsentinel', action: l.remediationAction || l.recommendedAction, check: l.check || l.code, t: l.t, quarantine: l.quarantine || null });
  }
  return out;
}
