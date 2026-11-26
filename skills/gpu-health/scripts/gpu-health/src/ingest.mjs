// Ingest: turns exporter output into normalized per-device samples, so every later step is vendor-neutral.
import { VENDORS } from './vendors.mjs';
//
// A sample (one GPU, one moment):
//   { t, site, node, gpu (the device id on the node: GPU, TPU chip, RDU…), vendor, kind (gpu|tpu|rdu…), sku,
//     tensor, sm, dram,                 // fractions 0..1 of peak: tensor-pipe active, SM/CU active, HBM bandwidth active
//     memUsedGB, memTotalGB, frameworkPeakGB?,   // device memory as the driver sees it; the framework's own peak if exported
//     clockMHz, maxClockMHz, throttle,  // throttle: 0..1 share of the interval spent clock-limited (thermal/power)
//     tempC, memTempC, powerW, powerBrake (0..1 share of the interval in power-brake slowdown), eccSbeTotal, eccDbeTotal, remapPending, remapFailed, remapUsed, remapSpare,
//     pcieWidth, pcieWidthMax, pcieGen, pcieGenMax, linkErrTotal (correctable NVLink/XGMI), linkUeTotal (uncorrectable),
//     faultCountTotal (a vendor's own cumulative fault counter), faults: [codes], cpuWait? }
// Fields a vendor doesn't report are simply absent; the checks that need them don't run (see coverage in vendors.mjs).
// Jobs are joined later by (node, gpu); exporters that carry pod labels can set `job` directly.

// NVML clock event (throttle) reason bits, as exported in DCGM_FI_DEV_CLOCKS_EVENT_REASONS
export const CLOCK_REASON = { swPowerCap: 0x4, hwSlowdown: 0x8, swThermal: 0x20, hwThermal: 0x40, hwPowerBrake: 0x80 };

// Prometheus exposition text -> [{ name, labels, value }]
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+([^\s]+)(\s+\d+)?$/);
    if (!m) continue;
    const labels = {};
    if (m[3]) for (const lm of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const value = Number(m[4]);
    if (!Number.isNaN(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

// Metric maps live in the vendor profiles (src/vendors.mjs). MAPPINGS is kept for callers that imported it.
export const MAPPINGS = Object.fromEntries(Object.entries(VENDORS).filter(([, v]) => v.mapping).map(([k, v]) => [k, v.mapping]));

const pick = (labels, keys) => { for (const k of keys || []) if (labels[k] != null && labels[k] !== '') return labels[k]; return undefined; };

// Which vendor wrote this exporter text: the first profile whose `detect` pattern matches. AMD is the fallback, as before.
export function detectVendor(text, vendors = VENDORS) {
  for (const [k, v] of Object.entries(vendors)) if (v && v.detect && new RegExp(v.detect, 'm').test(text)) return k;
  return 'amd';
}

// Exporter text from one scrape -> normalized samples.
//   opts: { vendor?, vendors? (cfg.vendors), mappings? (cfg.ingest.mappings), t?, site?, node? }
export function samplesFromExporter(text, opts = {}) {
  const vendors = opts.vendors || VENDORS;
  const vendor = opts.vendor || detectVendor(text, vendors);
  const profile = vendors[vendor];
  if (!profile || !profile.mapping) throw new Error(`no exporter mapping for vendor "${vendor}"${profile ? ': send its samples as JSONL (--samples)' : ''}`);
  const over = (opts.mappings || {})[vendor] || {};
  const map = Object.assign({}, profile.mapping, over, { fields: Object.assign({}, profile.mapping.fields, over.fields || {}) });
  const t = opts.t != null ? opts.t : Math.floor(Date.now() / 1000);
  const byGpu = new Map(), means = new Map(), nodeVals = new Map();
  for (const s of parsePrometheus(text)) {
    const f = map.fields[s.name];
    const isFault = map.fault && s.name === map.fault;
    if (!f && !isFault) continue;
    const node = String(pick(s.labels, map.node) || opts.node || 'unknown').replace(/:\d+$/, '');
    if (f && f[2] === 'node') { if (!nodeVals.has(node)) nodeVals.set(node, {}); nodeVals.get(node)[f[0]] = (nodeVals.get(node)[f[0]] || 0) + s.value * f[1]; continue; }
    const gpu = String(pick(s.labels, map.gpu) ?? '0');
    const k = node + '/' + gpu;
    if (!byGpu.has(k)) byGpu.set(k, { t, site: opts.site || '', node, gpu, vendor, kind: profile.kind || 'gpu', sku: pick(s.labels, map.sku) || map.defaultSku || '', faults: [] });
    const smp = byGpu.get(k);
    const job = pick(s.labels, map.job || []);
    if (job) smp.job = job;
    if (isFault) { if (s.value > 0) smp.faults.push((map.faultPrefix || '') + String(s.value)); continue; }
    if (f[2] === 'mean') { const mk = k + '|' + f[0]; const a = means.get(mk) || { smp, field: f[0], sum: 0, n: 0 }; a.sum += s.value * f[1]; a.n++; means.set(mk, a); continue; }
    smp[f[0]] = s.value * f[1];
  }
  for (const a of means.values()) a.smp[a.field] = a.sum / a.n;
  for (const smp of byGpu.values()) {
    Object.assign(smp, nodeVals.get(smp.node) || {});
    if (smp.tensor == null && map.tensorFrom && smp[map.tensorFrom] != null) smp.tensor = smp[map.tensorFrom];
    if (smp.clockReasons != null) { // one scrape is a point in time: the share over an interval comes from averaging samples
      const b = smp.clockReasons;
      smp.powerBrake = b & CLOCK_REASON.hwPowerBrake ? 1 : 0;
      if (smp.throttle == null) smp.throttle = b & (CLOCK_REASON.hwSlowdown | CLOCK_REASON.swThermal | CLOCK_REASON.hwThermal) ? 1 : 0;
      delete smp.clockReasons;
    }
  }
  return [...byGpu.values()];
}

// JSON lines of samples (already normalized) -> array; validates the essentials.
// Google Cloud Monitoring timeSeries.list JSON (projects.timeSeries.list, or `gcloud monitoring time-series list
// --format=json`) → samples, for GKE node accelerators (kubernetes.io/node/accelerator/*, resource k8s_node) and TPU
// VMs (…/accelerator/* on tpu_worker or gce_instance). Duty cycle stands in for SM activity, TensorCore utilization for
// tensor activity, memory bandwidth utilization for HBM activity; values in % become fractions, bytes become GB.
// make = nvidia → vendor nvidia, kind gpu; otherwise (a TPU model or a TPU resource) vendor tpu, kind tpu.
const CM_FIELDS = { duty_cycle: ['sm', 100], tensorcore_utilization: ['tensor', 100], memory_bandwidth_utilization: ['dram', 100], memory_used: ['memUsedGB', 1e9], memory_total: ['memTotalGB', 1e9] }; // [field, divisor]
export function samplesFromCloudMonitoring(json, { site } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json, list = Array.isArray(j) ? j : (j.timeSeries || []), by = new Map();
  for (const ts of list) {
    const type = (ts.metric || {}).type || '', f = CM_FIELDS[(type.match(/accelerator\/(\w+)$/) || [])[1]];
    if (!f) continue;
    const ml = (ts.metric || {}).labels || {}, rl = (ts.resource || {}).labels || {}, rtype = (ts.resource || {}).type || '';
    const node = rl.node_name || ml.instance_name || rl.instance_name || (rl.node_id ? `${rl.node_id}${rl.worker_id != null ? '-w' + rl.worker_id : ''}` : rl.instance_id);
    if (!node) continue;
    const make = String(ml.make || '').toLowerCase(), model = ml.model || '', tpu = make ? make !== 'nvidia' : /tpu/i.test(rtype + ' ' + model);
    for (const pt of ts.points || []) {
      const t = Math.floor(Date.parse((pt.interval || {}).endTime) / 1000), v = pt.value || {};
      const x = v.doubleValue != null ? +v.doubleValue : v.int64Value != null ? +v.int64Value : null;
      if (!Number.isFinite(t) || x == null || !Number.isFinite(x)) continue;
      const k = `${node}|${ml.accelerator_id ?? 0}|${t}`;
      if (!by.has(k)) by.set(k, { t, ...(site ? { site } : {}), node, gpu: String(ml.accelerator_id ?? 0), vendor: tpu ? 'tpu' : 'nvidia', kind: tpu ? 'tpu' : 'gpu', sku: model || (tpu ? 'TPU' : ''), ...(ml.tpu_topology ? { topology: ml.tpu_topology } : {}) });
      by.get(k)[f[0]] = x / f[1];
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t || a.node.localeCompare(b.node));
}

export function readSamples(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    if (!l.trim()) return;
    let s;
    try { s = JSON.parse(l); } catch (e) { throw new Error(`samples line ${i + 1}: not JSON (${e.message})`); }
    if (s.t == null || !s.node || s.gpu == null) throw new Error(`samples line ${i + 1}: needs t, node and gpu`);
    s.gpu = String(s.gpu);
    s.faults = s.faults || [];
    out.push(s);
  });
  return out;
}

export const gpuKey = s => s.node + '/' + s.gpu;
