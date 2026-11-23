// Demo fleet: 7 days of telemetry with known problems planted, so every rule has something to find.
//   on-prem  n1,n2  B200 x8   train-llm (16 GPUs); rank 13 = n2/gpu5 is thermally throttled (straggler)
//   neocloud n3     H200 x8   serve-chat (4, memory-bound decode: must NOT be flagged), embed-svc (4, oversized)
//   neocloud n4     H200 x8   notebook-ana (2, idle most of the day), etl-feature (2, starved on CPU/I-O),
//                             rerank-svc (gpu4, corrected ECC rising), batch-sim (gpu5: XID 79 then silent; gpu6: PCIe x8 of x16),
//                             ocr-svc (gpu7, tiny)
// early-warning plants:
//   n1/gpu3  HBM running hotter than its node-mates and than its own last week, plus power-brake slowdowns
//   n1/gpu2  two silent-data-corruption events reported by train-llm (rank 2): loss spike, then NaN
//   n3/gpu6  half of its samples missing in the last hour while the rest of n3 reports normally
// Deterministic (seeded) so tests can assert on it.

export function rng(seed = 42) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const DEMO_NOW = Date.UTC(2026, 10, 19, 12, 0, 0) / 1000;

const SKU = { B200: { mem: 180, clock: 1965, power: 1000, gemm: 2250, hbm: 7700 }, H200: { mem: 141, clock: 1980, power: 700, gemm: 990, hbm: 4800 } };

export function demoJobs(now = DEMO_NOW) {
  const start = now - 8 * 86400;
  const g = (node, list) => list.map(gpu => ({ node, gpu: String(gpu) }));
  return [
    { id: 'train-llm', class: 'training', owner: 'pretrain-team', namespace: 'train', start, gpus: [...g('n1', [0, 1, 2, 3, 4, 5, 6, 7]), ...g('n2', [0, 1, 2, 3, 4, 5, 6, 7])] },
    { id: 'serve-chat', class: 'inference', owner: 'serving-team', namespace: 'serving', gpusPerReplica: 4, start, gpus: g('n3', [0, 1, 2, 3]) },
    { id: 'embed-svc', class: 'inference', owner: 'search-team', namespace: 'serving', gpusPerReplica: 1, start, gpus: g('n3', [4, 5, 6, 7]) },
    { id: 'notebook-ana', class: 'interactive', owner: 'alice', namespace: 'notebooks', start, gpus: g('n4', [0, 1]) },
    { id: 'etl-feature', class: 'batch', owner: 'data-eng', namespace: 'batch', start, gpus: g('n4', [2, 3]) },
    { id: 'rerank-svc', class: 'inference', owner: 'search-team', namespace: 'serving', gpusPerReplica: 1, start, gpus: g('n4', [4]) },
    { id: 'batch-sim', class: 'batch', owner: 'sim-team', namespace: 'batch', start, gpus: g('n4', [5, 6]) },
    { id: 'ocr-svc', class: 'inference', owner: 'docs-team', namespace: 'serving', gpusPerReplica: 1, start, gpus: g('n4', [7]) },
  ];
}

export function demoSamples({ now = DEMO_NOW, days = 7, step = 600, seed = 7 } = {}) {
  const R = rng(seed), out = [];
  const jitter = (v, a) => Math.max(0, Math.min(1, v + (R() - 0.5) * 2 * a));
  const nodes = [['n1', 'onprem', 'B200'], ['n2', 'onprem', 'B200'], ['n3', 'neocloud', 'H200'], ['n4', 'neocloud', 'H200']];
  const sbe = {}, link = {};
  for (let t = now - days * 86400; t <= now; t += step) {
    const hour = ((t % 86400) / 3600);
    const day = 0.5 + 0.5 * Math.sin((hour - 9) / 24 * 2 * Math.PI); // 0..1 daily load curve, peak ~15:00 UTC
    for (const [node, site, sku] of nodes) {
      const S = SKU[sku];
      for (let gpu = 0; gpu < 8; gpu++) {
        const k = node + '/' + gpu;
        let u = { tensor: 0, sm: 0, dram: 0, mem: 1, fw: null, throttle: 0, cpuWait: null };
        if (node === 'n1' || node === 'n2') u = { tensor: jitter(0.55, 0.05), sm: jitter(0.82, 0.04), dram: jitter(0.36, 0.05), mem: 168, fw: 152, throttle: jitter(0.02, 0.02) };
        if (node === 'n2' && gpu === 5) Object.assign(u, { throttle: jitter(0.45, 0.05) });
        if (node === 'n3' && gpu < 4) u = { tensor: jitter(0.06 + 0.10 * day, 0.03), sm: jitter(0.25 + 0.25 * day, 0.04), dram: jitter(0.42 + 0.35 * day, 0.05), mem: 128, fw: 126 };
        if (node === 'n3' && gpu >= 4) u = { tensor: jitter(0.04 + 0.06 * day, 0.015), sm: jitter(0.1 + 0.08 * day, 0.02), dram: jitter(0.08 + 0.05 * day, 0.02), mem: 125, fw: 9.5 };
        if (node === 'n4' && gpu < 2) { const active = hour >= 2 && hour < 8 && t < now - 86400 * 0.2; u = active ? { tensor: jitter(0.3, 0.1), sm: jitter(0.45, 0.1), dram: jitter(0.3, 0.1), mem: 60, fw: 41 } : { tensor: jitter(0.005, 0.005), sm: jitter(0.01, 0.01), dram: jitter(0.01, 0.01), mem: 60, fw: 41 }; }
        if (node === 'n4' && (gpu === 2 || gpu === 3)) u = { tensor: jitter(0.08, 0.03), sm: jitter(0.15, 0.04), dram: jitter(0.1, 0.03), mem: 70, fw: 52, cpuWait: jitter(0.55, 0.08) };
        if (node === 'n4' && gpu === 4) u = { tensor: jitter(0.06 + 0.08 * day, 0.02), sm: jitter(0.12 + 0.1 * day, 0.03), dram: jitter(0.08 + 0.08 * day, 0.02), mem: 110, fw: 19 };
        if (node === 'n4' && (gpu === 5 || gpu === 6)) u = { tensor: jitter(0.42, 0.05), sm: jitter(0.7, 0.05), dram: jitter(0.3, 0.05), mem: 90, fw: 80 };
        if (node === 'n4' && gpu === 7) u = { tensor: jitter(0.04 + 0.07 * day, 0.015), sm: jitter(0.08 + 0.06 * day, 0.02), dram: jitter(0.06 + 0.06 * day, 0.02), mem: 100, fw: 13 };
        if (node === 'n4' && gpu === 5 && t > now - 3 * 3600) continue; // fell off the bus: silent after the XID
        if (node === 'n3' && gpu === 6 && t > now - 3600 && Math.floor(t / step) % 2 === 0) continue; // telemetry thinning
        u.throttle = u.throttle || 0;
        const eff = Math.max(u.tensor, u.dram);
        const powerW = S.power * (0.12 + 0.75 * Math.max(eff, u.sm * 0.8));
        let tempC = 32 + 40 * powerW / S.power + (R() - 0.5) * 2;
        if (node === 'n2' && gpu === 5) tempC += 18;
        let memTempC = tempC + 6 + (R() - 0.5) * 2;
        const hbmHot = node === 'n1' && gpu === 3 && t > now - 2 * 86400;
        if (hbmHot) memTempC += 14;
        const powerBrake = hbmHot && t > now - 86400 && R() < 0.15 ? 1 : 0;
        // corrected ECC: n4/gpu4 starts rising one day ago
        sbe[k] = (sbe[k] || (node === 'n4' && gpu === 4 ? 120 : 2)) + (node === 'n4' && gpu === 4 && t > now - 86400 ? 40 * step / 3600 : R() < 0.002 ? 1 : 0);
        link[k] = (link[k] || 0) + (R() < 0.01 ? 1 : 0);
        const faults = node === 'n4' && gpu === 5 && Math.abs(t - (now - 3 * 3600)) < step / 2 ? ['xid79'] : [];
        out.push({
          t, site, node, gpu: String(gpu), vendor: 'nvidia', sku,
          tensor: +u.tensor.toFixed(3), sm: +u.sm.toFixed(3), dram: +u.dram.toFixed(3),
          memUsedGB: u.mem === 1 ? 1 : u.mem, memTotalGB: S.mem, ...(u.fw != null ? { frameworkPeakGB: u.fw } : {}),
          clockMHz: Math.round(S.clock * (1 - 0.25 * u.throttle)), maxClockMHz: S.clock, throttle: +u.throttle.toFixed(3),
          tempC: +tempC.toFixed(1), memTempC: +memTempC.toFixed(1), powerW: Math.round(powerW), powerBrake,
          eccSbeTotal: Math.floor(sbe[k]), eccDbeTotal: 0, remapPending: 0, remapFailed: 0, remapUsed: node === 'n4' && gpu === 4 ? 180 : 2, remapSpare: node === 'n4' && gpu === 4 ? 332 : 510,
          pcieWidth: node === 'n4' && gpu === 6 ? 8 : 16, pcieWidthMax: 16, pcieGen: 5, pcieGenMax: 5, linkErrTotal: link[k],
          ...(u.cpuWait != null ? { cpuWait: +u.cpuWait.toFixed(3) } : {}), faults,
        });
      }
    }
  }
  return out;
}

export function demoSteps({ now = DEMO_NOW, seed = 11 } = {}) {
  const R = rng(seed), out = [];
  for (let step = 0; step < 200; step++) for (let rank = 0; rank < 16; rank++)
    out.push({ job: 'train-llm', rank, step, t: now - (200 - step) * 60, computeMs: +((rank === 13 ? 1030 : 820) * (1 + (R() - 0.5) * 0.03)).toFixed(1) });
  return out;
}

export function demoProbes({ now = DEMO_NOW, seed = 5 } = {}) {
  const R = rng(seed), out = [];
  for (const [node, site, sku] of [['n1', 'onprem', 'B200'], ['n2', 'onprem', 'B200'], ['n3', 'neocloud', 'H200'], ['n4', 'neocloud', 'H200']])
    for (let gpu = 0; gpu < 8; gpu++) {
      if (node === 'n4' && gpu === 5) continue;
      const S = SKU[sku], slow = node === 'n2' && gpu === 5 ? 0.86 : 1;
      out.push({ t: now - 6 * 3600, node, gpu: String(gpu), site, sku, firmware: sku === 'B200' ? '570.86' : '565.57', gemmTflops: +(S.gemm * slow * (1 + (R() - 0.5) * 0.02)).toFixed(0), hbmGBs: +(S.hbm * (1 + (R() - 0.5) * 0.02)).toFixed(0) });
    }
  return out;
}

// Results from outside the telemetry: here, SDC events reported by the training loop's checks.
export function demoResults({ now = DEMO_NOW } = {}) {
  return [
    { t: now - 5 * 3600, kind: 'sdc', job: 'train-llm', rank: 2, step: 41870, type: 'loss-spike', detail: 'loss 2.31 -> 9.8, recovered next step' },
    { t: now - 2 * 3600, kind: 'sdc', job: 'train-llm', rank: 2, step: 42011, type: 'nan', detail: 'non-finite gradient on rank 2 only' },
  ];
}

export function demoCluster() {
  const nodes = [];
  const jobs = demoJobs();
  for (const n of ['n1', 'n2', 'n3', 'n4']) nodes.push({ node: n, gpus: Array.from({ length: 8 }, (_, i) => ({ gpu: String(i), alloc: jobs.some(j => j.gpus.some(g => g.node === n && g.gpu === String(i))) ? 1 : 0 })) });
  nodes.push({ node: 'n5', gpus: Array.from({ length: 8 }, (_, i) => ({ gpu: String(i), alloc: [0, 3].includes(i) ? 0 : 1 })) });
  nodes.push({ node: 'n6', gpus: Array.from({ length: 8 }, (_, i) => ({ gpu: String(i), alloc: [1, 5].includes(i) ? 0 : 1 })) });
  return { nodes, pending: [{ job: 'train-ft', gpus: 4 }, { job: 'rerank-canary', fraction: 0.25 }] };
}

export const toJsonl = arr => arr.map(x => JSON.stringify(x)).join('\n') + '\n';

// Mixed-vendor demo: one node each of AMD MI300X, SambaNova RDUs and Cloud TPU chips, two days of telemetry.
//   a1/1  AMD GPU with an uncorrectable RAS error (fault event)        → quarantined; first repair step amd-smi reset
//   s1/2  SambaNova RDU removed by the runtime (FTYPE_RDU_REMOVED)     → quarantined
//   t1/3  TPU chip reported unhealthy                                  → quarantined; no device reset on Cloud TPU
//   t1/0  planned TPU host maintenance                                 → ignored (not a device fault)
// Each vendor reports only what its real telemetry has, so the coverage table shows each one's blind spots.
export function demoMixed({ now = DEMO_NOW, days = 2, step = 600, seed = 21 } = {}) {
  const R = rng(seed), samples = [];
  const j = (v, a) => +Math.max(0, Math.min(1, v + (R() - 0.5) * 2 * a)).toFixed(3);
  const sbe = {};
  for (let t = now - days * 86400; t <= now; t += step) {
    for (let d = 0; d < 4; d++) {
      const g = String(d), k = 'a1/' + g;
      sbe[k] = (sbe[k] || 3) + (R() < 0.003 ? 1 : 0);
      const sm = j(0.78, 0.04), powerW = Math.round(750 * (0.2 + 0.7 * sm));
      samples.push({ t, site: 'onprem', node: 'a1', gpu: g, vendor: 'amd', kind: 'gpu', sku: 'MI300X', sm, tensor: sm, dram: j(0.4, 0.05), memUsedGB: 170, memTotalGB: 192,
        clockMHz: 2100, tempC: +(40 + 30 * sm + (R() - 0.5) * 2).toFixed(1), memTempC: +(48 + 30 * sm + (R() - 0.5) * 2).toFixed(1), powerW,
        eccSbeTotal: Math.floor(sbe[k]), eccDbeTotal: 0, linkErrTotal: 0, linkUeTotal: 0, pcieGen: 5, pcieGenMax: 5, faults: [] });
      samples.push({ t, site: 'onprem', node: 's1', gpu: g, vendor: 'sambanova', kind: 'rdu', sku: 'RDU', tensor: j(0.35, 0.05), sm: j(0.6, 0.05), clockMHz: 1600, faultCountTotal: 4, faults: [] });
      samples.push({ t, site: 'gcp', node: 't1', gpu: g, vendor: 'tpu', kind: 'tpu', sku: 'v5p', tensor: j(0.5, 0.05), sm: j(0.9, 0.03), memUsedGB: 80, memTotalGB: 95, faults: [] });
    }
  }
  const jobs = [
    { id: 'train-amd', class: 'training', owner: 'pretrain-team', namespace: 'train', start: now - 3 * 86400, gpus: [0, 1, 2, 3].map(i => ({ node: 'a1', gpu: String(i) })) },
    { id: 'serve-rdu', class: 'inference', owner: 'serving-team', namespace: 'serving', gpusPerReplica: 4, start: now - 3 * 86400, gpus: [0, 1, 2, 3].map(i => ({ node: 's1', gpu: String(i) })) },
    { id: 'train-tpu', class: 'training', owner: 'research', namespace: 'train', start: now - 3 * 86400, gpus: [0, 1, 2, 3].map(i => ({ node: 't1', gpu: String(i) })) },
  ];
  const results = [
    { t: now - 2 * 3600, kind: 'fault', node: 'a1', gpu: '1', code: 'ras_uncorrectable', detail: 'UMC uncorrectable error' },
    { t: now - 3600, kind: 'fault', node: 's1', gpu: '2', code: 'FTYPE_RDU_REMOVED', detail: 'SNFM: RDU removed' },
    { t: now - 90 * 60, kind: 'fault', node: 't1', gpu: '3', code: 'tpu_chip_unhealthy' },
    { t: now - 5 * 3600, kind: 'fault', node: 't1', gpu: '0', code: 'tpu_maintenance' },
  ];
  return { samples, jobs, results };
}

// Sixty days of history for the demo fleet, so the flakiness view has something to find. Each GPU's story ends back
// in service, and today's analysis adds the current state changes on top.
//   n1/2  SDC: suspect, deep diag passed, back in service; corrupts again today. Two training crashes on it.
//   n2/5  thermal: leaves service five times, once within days of coming back (the straggler today).
//   n2/*  six more short thermal suspects: node n2 fails at about twice the fleet rate (cooling).
//   n4/4  ECC: quarantined, reset, back; ECC rate rising 6 days later (suspect), quarantined, node reboot, back; suspect again today.
//   n4/5  XID 79 twice, node reboot each time; falls off the bus again today: third hard failure.
//   n2/1, n1/6  ECC once, reset held.   n2/7  ECC, reset failed within days, reseat held.
//   n3/6  telemetry thinning once before today.
export function demoHistory({ now = DEMO_NOW } = {}) {
  const D = 86400, at = d => Math.round(now - d * D);
  const sku = n => (n === 'n1' || n === 'n2' ? ['B200', 'onprem'] : ['H200', 'neocloud']);
  const events = [], audit = [], results = [];
  const ev = (key, d, from, to, why, faultClass = '') => { const [node, gpu] = key.split('/'), [s, site] = sku(node); events.push({ t: at(d), key, node, gpu, sku: s, site, vendor: 'nvidia', from, to, why, faultClass }); };
  const fix = (key, d, kind) => audit.push({ t: at(d), id: `${kind}:${key}`, kind, target: key, event: 'executed', commands: [] });
  // quarantine → repair → burn-in → ready → serving
  const repairCycle = (key, d, why, cls, kind, from = 'serving') => { ev(key, d, from, 'quarantined', why, cls); fix(key, d - 0.1, kind); ev(key, d - 0.5, 'quarantined', 'burnin', 'diag level 3 passed; burn-in next', cls); ev(key, d - 1, 'burnin', 'ready', 'burn-in passed; waiting for release approval', cls); ev(key, d - 1.2, 'ready', 'serving', 'released by ops', cls); };
  const blip = (key, d, back, why, cls, how = 'signal cleared') => { ev(key, d, 'serving', 'suspect', why, cls); ev(key, back, 'suspect', 'serving', how, cls); };

  blip('n1/2', 6, 5, '1 silent-data-corruption event(s) in 7 days (nan)', 'sdc', 'deep diag passed; watching');
  results.push({ t: at(5.1), kind: 'diag', node: 'n1', gpu: '2', pass: true, level: 4 });
  results.push({ t: at(6), kind: 'job-end', job: 'train-llm', rank: 2, status: 'failed', cause: 'device', detail: 'NaN loss on rank 2', lostGpuHours: 24 });
  results.push({ t: at(0.1), kind: 'job-end', job: 'train-llm', rank: 2, status: 'failed', cause: 'device', detail: 'non-finite gradient on rank 2' });
  results.push({ t: at(30), kind: 'job-end', job: 'train-llm', rank: 7, status: 'failed', cause: 'app', detail: 'OOM after config change' });

  blip('n2/5', 40, 39.5, 'clock-limited 41% of busy time', 'thermal'); blip('n2/5', 34, 33.5, 'clock-limited 44% of busy time', 'thermal');
  blip('n2/5', 20, 19.5, '17°C hotter than peers (same node and job)', 'thermal', 'deep diag passed; watching'); blip('n2/5', 12, 11.5, 'clock-limited 39% of busy time', 'thermal');
  results.push({ t: at(19.6), kind: 'diag', node: 'n2', gpu: '5', pass: true, level: 3 });
  for (const [g, d] of [['0', 28], ['2', 31], ['3', 15], ['4', 24], ['6', 10], ['6', 36]]) blip('n2/' + g, d, d - 0.3, 'clock-limited 23% of busy time', 'thermal');

  repairCycle('n4/4', 21, 'fault xid48', 'ecc', 'gpu-reset');
  ev('n4/4', 14, 'serving', 'suspect', 'corrected ECC errors rising: 38/h', 'ecc'); repairCycle('n4/4', 13.5, 'fault xid48', 'ecc', 'node-reboot', 'suspect');
  results.push({ t: at(13.5), kind: 'job-end', job: 'rerank-svc', node: 'n4', gpu: '4', status: 'failed', cause: 'device', detail: 'replica crashed on uncorrectable ECC error' });
  repairCycle('n4/5', 48, 'fault xid79', 'bus', 'node-reboot'); repairCycle('n4/5', 27, 'fault xid79', 'bus', 'node-reboot');
  results.push({ t: at(27), kind: 'job-end', job: 'batch-sim', node: 'n4', gpu: '5', status: 'failed', cause: 'device', detail: 'GPU fell off the bus' });

  repairCycle('n2/1', 50, 'fault xid48', 'ecc', 'gpu-reset'); repairCycle('n1/6', 42, 'fault xid48', 'ecc', 'gpu-reset');
  repairCycle('n2/7', 45, 'fault xid48', 'ecc', 'gpu-reset'); repairCycle('n2/7', 40.5, 'fault xid48', 'ecc', 'reseat');
  blip('n3/6', 22, 21.8, '45% of samples missing in the last hour while node-mates report normally', 'telemetry');

  return { events: events.sort((a, b) => a.t - b.t), audit: audit.sort((a, b) => a.t - b.t), results };
}
