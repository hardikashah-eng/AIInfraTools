// Ingest: turns exporter output into normalized per-GPU samples, so every later step is vendor-neutral.
//
// A sample (one GPU, one moment):
//   { t, site, node, gpu, vendor, sku,
//     tensor, sm, dram,                 // fractions 0..1 of peak: tensor-pipe active, SM/CU active, HBM bandwidth active
//     memUsedGB, memTotalGB, frameworkPeakGB?,   // device memory as the driver sees it; the framework's own peak if exported
//     clockMHz, maxClockMHz, throttle,  // throttle: 0..1 share of the interval spent clock-limited (thermal/power)
//     tempC, memTempC, powerW, powerBrake (0..1 share of the interval in power-brake slowdown), eccSbeTotal, eccDbeTotal, remapPending, remapFailed, remapUsed, remapSpare,
//     pcieWidth, pcieWidthMax, pcieGen, pcieGenMax, linkErrTotal (correctable NVLink/XGMI), linkUeTotal (uncorrectable),
//     faults: [codes], cpuWait? }
// Jobs are joined later by (node, gpu); exporters that carry pod labels can set `job` directly.

export const NUM_FIELDS = ['tensor', 'sm', 'dram', 'memUsedGB', 'memTotalGB', 'frameworkPeakGB', 'clockMHz', 'maxClockMHz', 'throttle', 'tempC', 'memTempC', 'powerW', 'powerBrake',
  'eccSbeTotal', 'eccDbeTotal', 'remapPending', 'remapFailed', 'remapUsed', 'remapSpare', 'pcieWidth', 'pcieWidthMax', 'pcieGen', 'pcieGenMax', 'linkErrTotal', 'linkUeTotal', 'cpuWait'];

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

// Default metric maps. Names follow dcgm-exporter and AMD's device-metrics-exporter; check them against the
// versions you run and override any of them in the config file (`ingest.mappings`).
export const MAPPINGS = {
  nvidia: {
    node: ['Hostname', 'hostname', 'instance'], gpu: ['gpu', 'device'], sku: ['modelName'], job: ['pod', 'exported_pod'],
    fields: {
      DCGM_FI_PROF_PIPE_TENSOR_ACTIVE: ['tensor', 1], DCGM_FI_PROF_SM_ACTIVE: ['sm', 1], DCGM_FI_PROF_DRAM_ACTIVE: ['dram', 1],
      DCGM_FI_DEV_FB_USED: ['memUsedGB', 1 / 1024], DCGM_FI_DEV_FB_TOTAL: ['memTotalGB', 1 / 1024],
      DCGM_FI_DEV_SM_CLOCK: ['clockMHz', 1], DCGM_FI_DEV_MAX_SM_CLOCK: ['maxClockMHz', 1], DCGM_FI_DEV_GPU_TEMP: ['tempC', 1], DCGM_FI_DEV_POWER_USAGE: ['powerW', 1],
      DCGM_FI_DEV_MEMORY_TEMP: ['memTempC', 1],
      DCGM_FI_DEV_CLOCKS_EVENT_REASONS: ['clockReasons', 1], DCGM_FI_DEV_CLOCK_THROTTLE_REASONS: ['clockReasons', 1], // bitmask, decoded below
      DCGM_FI_DEV_ECC_SBE_AGG_TOTAL: ['eccSbeTotal', 1], DCGM_FI_DEV_ECC_DBE_AGG_TOTAL: ['eccDbeTotal', 1],
      DCGM_FI_DEV_ROW_REMAP_PENDING: ['remapPending', 1], DCGM_FI_DEV_ROW_REMAP_FAILURE: ['remapFailed', 1],
      DCGM_FI_DEV_CORRECTABLE_REMAPPED_ROWS: ['remapUsed', 1],
      DCGM_FI_DEV_PCIE_LINK_WIDTH: ['pcieWidth', 1], DCGM_FI_DEV_PCIE_MAX_LINK_WIDTH: ['pcieWidthMax', 1],
      DCGM_FI_DEV_PCIE_LINK_GEN: ['pcieGen', 1], DCGM_FI_DEV_PCIE_MAX_LINK_GEN: ['pcieGenMax', 1],
      DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL: ['linkErrTotal', 1],
    },
    fault: 'DCGM_FI_DEV_XID_ERRORS', // value = last XID seen in the interval (0 = none)
  },
  amd: {
    node: ['hostname', 'Hostname', 'instance'], gpu: ['gpu_id', 'gpu'], sku: ['card_model', 'card_series'], job: ['pod'],
    fields: {
      gpu_gfx_activity: ['sm', 0.01], gpu_umc_activity: ['dram', 0.01],
      gpu_used_vram: ['memUsedGB', 1 / 1024], gpu_total_vram: ['memTotalGB', 1 / 1024],
      gpu_clock: ['clockMHz', 1], gpu_junction_temperature: ['tempC', 1], gpu_memory_temperature: ['memTempC', 1], gpu_power_usage: ['powerW', 1],
      gpu_ecc_correct_total: ['eccSbeTotal', 1], gpu_ecc_uncorrect_total: ['eccDbeTotal', 1],
      // On MI300-series and later the XGMI health field isn't evaluated; link faults show up as RAS errors on the XGMI_WAFL block.
      gpu_ecc_correct_xgmi_wafl: ['linkErrTotal', 1], gpu_ecc_uncorrect_xgmi_wafl: ['linkUeTotal', 1],
      pcie_speed: ['pcieGen', 1], pcie_max_speed: ['pcieGenMax', 1],
    },
    // AMD exposes no separate matrix-core counter in the default set; GFX activity stands in for tensor activity.
    tensorFrom: 'sm',
    fault: null,
  },
};

const pick = (labels, keys) => { for (const k of keys) if (labels[k] != null && labels[k] !== '') return labels[k]; return undefined; };

// Exporter text from one scrape -> normalized samples.
export function samplesFromExporter(text, opts = {}) {
  const vendor = opts.vendor || (/DCGM_FI_/.test(text) ? 'nvidia' : 'amd');
  const over = (opts.mappings || {})[vendor] || {};
  const map = Object.assign({}, MAPPINGS[vendor], over, { fields: Object.assign({}, MAPPINGS[vendor].fields, over.fields || {}) });
  const t = opts.t != null ? opts.t : Math.floor(Date.now() / 1000);
  const byGpu = new Map();
  for (const s of parsePrometheus(text)) {
    const f = map.fields[s.name];
    const isFault = map.fault && s.name === map.fault;
    if (!f && !isFault) continue;
    const node = String(pick(s.labels, map.node) || opts.node || 'unknown').replace(/:\d+$/, '');
    const gpu = String(pick(s.labels, map.gpu) ?? '0');
    const k = node + '/' + gpu;
    if (!byGpu.has(k)) byGpu.set(k, { t, site: opts.site || '', node, gpu, vendor, sku: pick(s.labels, map.sku) || '', faults: [] });
    const smp = byGpu.get(k);
    const job = pick(s.labels, map.job || []);
    if (job) smp.job = job;
    if (isFault) { if (s.value > 0) smp.faults.push(String(vendor === 'nvidia' ? 'xid' + s.value : s.value)); continue; }
    smp[f[0]] = s.value * f[1];
  }
  for (const smp of byGpu.values()) {
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
