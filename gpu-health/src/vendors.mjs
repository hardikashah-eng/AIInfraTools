// Vendors: what each accelerator family reports, what its fault codes mean, and what can be done about a bad device.
//
// Everything after ingest works on normalized samples and vendor-neutral fault classes, so adding a vendor means
// adding a profile here (or under `vendors` in the config file), not changing the health or risk logic.
//
// A profile has:
//   name, kind         display name; device kind: gpu | tpu | rdu | …
//   detect             regex (as a string) that recognizes the vendor's exporter text; null = no exporter (JSONL only)
//   mapping            exporter metric → normalized sample field (see ingest.mjs). Each field entry is
//                      [field, scale, agg?] where agg is 'mean' (several series per device, e.g. per tile, averaged)
//                      or 'node' (one series per node, copied to every device on it)
//   faults             native fault code → { class, severity: hard | soft | ignore }
//   executors          action kind → argv templates, 'webhook', or { webhook: 'what a person should do' }
//   unsupported        action kinds that don't exist on this platform (never proposed; skipped on the repair ladder)
//   ladder             repair steps by fault class, overriding the global ladder (`default` applies to every class)
//
// Metric names follow each vendor's published exporter. Check them against the versions you run and override any of
// them in the config file.

export const VENDORS = {
  nvidia: {
    name: 'NVIDIA', kind: 'gpu',
    detect: 'DCGM_FI_',
    mapping: {
      node: ['Hostname', 'hostname', 'instance'], gpu: ['gpu', 'device'], sku: ['modelName'], job: ['pod', 'exported_pod'],
      fields: {
        DCGM_FI_PROF_PIPE_TENSOR_ACTIVE: ['tensor', 1], DCGM_FI_PROF_SM_ACTIVE: ['sm', 1], DCGM_FI_PROF_DRAM_ACTIVE: ['dram', 1],
        DCGM_FI_DEV_FB_USED: ['memUsedGB', 1 / 1024], DCGM_FI_DEV_FB_TOTAL: ['memTotalGB', 1 / 1024],
        DCGM_FI_DEV_SM_CLOCK: ['clockMHz', 1], DCGM_FI_DEV_MAX_SM_CLOCK: ['maxClockMHz', 1], DCGM_FI_DEV_GPU_TEMP: ['tempC', 1], DCGM_FI_DEV_POWER_USAGE: ['powerW', 1],
        DCGM_FI_DEV_MEMORY_TEMP: ['memTempC', 1],
        DCGM_FI_DEV_CLOCKS_EVENT_REASONS: ['clockReasons', 1], DCGM_FI_DEV_CLOCK_THROTTLE_REASONS: ['clockReasons', 1], // bitmask, decoded in ingest
        DCGM_FI_DEV_ECC_SBE_AGG_TOTAL: ['eccSbeTotal', 1], DCGM_FI_DEV_ECC_DBE_AGG_TOTAL: ['eccDbeTotal', 1],
        DCGM_FI_DEV_ROW_REMAP_PENDING: ['remapPending', 1], DCGM_FI_DEV_ROW_REMAP_FAILURE: ['remapFailed', 1],
        DCGM_FI_DEV_CORRECTABLE_REMAPPED_ROWS: ['remapUsed', 1],
        DCGM_FI_DEV_PCIE_LINK_WIDTH: ['pcieWidth', 1], DCGM_FI_DEV_PCIE_MAX_LINK_WIDTH: ['pcieWidthMax', 1],
        DCGM_FI_DEV_PCIE_LINK_GEN: ['pcieGen', 1], DCGM_FI_DEV_PCIE_MAX_LINK_GEN: ['pcieGenMax', 1],
        DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL: ['linkErrTotal', 1],
      },
      fault: 'DCGM_FI_DEV_XID_ERRORS', faultPrefix: 'xid', // value = last XID seen in the interval (0 = none)
    },
    faults: {
      xid48: { class: 'ecc', severity: 'hard' }, xid64: { class: 'ecc', severity: 'hard' }, xid95: { class: 'ecc', severity: 'hard' },
      xid94: { class: 'ecc', severity: 'hard' }, xid63: { class: 'ecc', severity: 'soft' }, xid92: { class: 'ecc', severity: 'soft' },
      xid79: { class: 'bus', severity: 'hard' }, xid74: { class: 'link', severity: 'hard' }, xid145: { class: 'link', severity: 'hard' },
      xid119: { class: 'firmware', severity: 'hard' }, xid120: { class: 'firmware', severity: 'hard' },
      xid13: { class: 'app', severity: 'ignore' }, xid31: { class: 'app', severity: 'ignore' }, xid43: { class: 'app', severity: 'ignore' },
      xid109: { class: 'app', severity: 'soft' }, // can be a driver issue: confirm with a diag
    },
    executors: {}, // the global defaults are written for NVIDIA
    unsupported: [],
  },

  amd: {
    name: 'AMD', kind: 'gpu',
    detect: '^gpu_(gfx_activity|used_vram|junction_temperature|umc_activity)',
    mapping: {
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
      // No separate matrix-core counter in the default set: GFX activity stands in for tensor activity.
      tensorFrom: 'sm',
      fault: null,
    },
    faults: { ras_uncorrectable: { class: 'ecc', severity: 'hard' }, ras_correctable: { class: 'ecc', severity: 'soft' } },
    executors: {
      'gpu-reset': [['ssh', '{node}', 'sudo', 'amd-smi', 'reset', '--gpureset', '--gpu', '{gpu}']],
      'config-reset': { webhook: 'Reset clocks and power limits to defaults with amd-smi on the node.' },
    },
    unsupported: [],
  },

  sambanova: {
    name: 'SambaNova', kind: 'rdu',
    detect: '^sambanova_',
    // SambaNova's hardware-monitoring exporter reports per tile; tiles are averaged per RDU. The platform fault count is
    // per node, so an increase marks every RDU on the node suspect until a deep diag or SNFM says which one it was.
    mapping: {
      node: ['instance'], gpu: ['rdu'], sku: ['model'], defaultSku: 'RDU', job: ['pod'],
      fields: {
        sambanova_tile_aload_percent: ['tensor', 0.01, 'mean'], sambanova_tile_exec_percent: ['sm', 0.01, 'mean'],
        sambanova_tile_frequency_mhz: ['clockMHz', 1, 'mean'],
        sambanova_platform_fault_count: ['faultCountTotal', 1, 'node'],
      },
      fault: null,
    },
    // Fault types from the SambaNova runtime / SNFM, fed in as results: { t, kind: "fault", node, gpu, code }.
    faults: {
      FTYPE_RDU_REMOVED: { class: 'bus', severity: 'hard' }, FTYPE_RDU_INIT: { class: 'firmware', severity: 'hard' },
      FTYPE_RDU_RESET: { class: 'firmware', severity: 'soft' },
    },
    executors: {
      'gpu-reset': { webhook: 'Reset the RDU with the SambaNova Fault Management (SNFM) utility on the host, or ask SambaNova support.' },
      'rma': { webhook: 'Open a SambaNova support case with the SNFM diagnostic bundle.' },
    },
    unsupported: ['config-reset', 'repartition'],
  },

  tpu: {
    name: 'Google Cloud TPU', kind: 'tpu',
    detect: null, // no Prometheus exporter by default: tools/tpu-collect.py writes JSONL samples from libtpu's monitoring API
    mapping: null,
    // Cloud TPU hardware belongs to the provider: no device reset, reseat or firmware work. Repair is "get it off the
    // slice and tell the provider". Fault events come in as results ({ kind: "fault", code }).
    faults: {
      tpu_chip_unhealthy: { class: 'hardware', severity: 'hard' }, tpu_runtime_error: { class: 'firmware', severity: 'soft' },
      tpu_maintenance: { class: 'app', severity: 'ignore' }, // planned host maintenance is not a device fault
    },
    executors: {
      'node-reboot': { webhook: 'Restart or recreate the TPU VM (or the slice) so the workload lands on healthy chips.' },
      'rma': { webhook: 'Open a Google Cloud support case for the TPU, with the chip, slice and fault times.' },
      'run-diag': { webhook: 'Run the TPU health check workload on the slice (deterministic JAX matmul + collectives).' },
    },
    unsupported: ['gpu-reset', 'config-reset', 'reseat', 'firmware-align', 'fabric-restart', 'facilities-check', 'repartition'],
    ladder: { default: ['node-reboot', 'rma'] },
  },
};

// Checks the health logic can run, and the sample fields each one needs. Coverage shows which a vendor can't see.
export const CHECKS = {
  utilization: ['tensor', 'sm', 'dram'], memory: ['memUsedGB'], ecc: ['eccSbeTotal', 'eccDbeTotal'], rowRemap: ['remapUsed', 'remapPending', 'remapFailed'],
  temperature: ['tempC'], hbmTemperature: ['memTempC'], power: ['powerW'], throttle: ['throttle', 'powerBrake'], pcie: ['pcieWidth', 'pcieGen'],
  interconnect: ['linkErrTotal', 'linkUeTotal'],
};

const vendorOf = (cfg, vendor) => ((cfg && cfg.vendors) || VENDORS)[vendor] || null;

// Fault code → { class, severity }. Global `faults` in the config win, then the device's vendor, then any vendor
// (normalized JSONL may not say which vendor a sample came from).
export function faultDef(cfg, vendor, code) {
  if (cfg.faults && cfg.faults[code]) return cfg.faults[code];
  const v = vendorOf(cfg, vendor);
  if (v && v.faults && v.faults[code]) return v.faults[code];
  for (const p of Object.values((cfg && cfg.vendors) || VENDORS)) if (p && p.faults && p.faults[code]) return p.faults[code];
  return { class: 'default', severity: 'soft' };
}

// What to call one device in messages.
export const noun = kind => ({ tpu: 'TPU chip', rdu: 'RDU' }[kind] || 'GPU');

export const supports = (cfg, vendor, kind) => !((vendorOf(cfg, vendor) || {}).unsupported || []).includes(kind);

// Repair ladder for a fault class on a vendor, with steps the platform can't do left out.
export function ladderFor(cfg, vendor, cls) {
  const v = vendorOf(cfg, vendor) || {}, vl = v.ladder || {};
  const l = (vl[cls] || vl.default || cfg.ladder[cls] || cfg.ladder.default).filter(k => supports(cfg, vendor, k));
  return l.length ? l : ['rma'];
}

// Executor for an action: the vendor's own if it has one, else the global one.
export function executorFor(cfg, vendor, kind) {
  const v = vendorOf(cfg, vendor);
  if (v && v.executors && v.executors[kind] != null) return v.executors[kind];
  return cfg.executors[kind];
}

// Which checks each vendor's telemetry supports, from the fields actually present in the samples.
export function coverage(samples, cfg) {
  const by = new Map();
  for (const s of samples) {
    const v = s.vendor || 'unknown';
    if (!by.has(v)) by.set(v, { devices: new Map(), kind: s.kind || (vendorOf(cfg, v) || {}).kind || 'gpu' });
    const d = by.get(v).devices, k = s.node + '/' + s.gpu;
    if (!d.has(k)) d.set(k, new Set());
    for (const [f, val] of Object.entries(s)) if (typeof val === 'number' && !Number.isNaN(val)) d.get(k).add(f);
  }
  return [...by.entries()].map(([vendor, { devices, kind }]) => {
    const seen = c => [...devices.values()].filter(fs => CHECKS[c].some(f => fs.has(f))).length / Math.max(1, devices.size) >= 0.5;
    const checks = Object.keys(CHECKS).filter(seen), blind = Object.keys(CHECKS).filter(c => !seen(c));
    return { vendor, name: (vendorOf(cfg, vendor) || {}).name || vendor, kind, devices: devices.size, checks, blind };
  }).sort((a, b) => b.devices - a.devices);
}
