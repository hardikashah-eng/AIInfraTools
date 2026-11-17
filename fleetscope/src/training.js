/* FleetScope training model: one training job, step by step, with data loading, compute, gradient sync,
   checkpoints, stragglers, GPU faults and restarts. Deterministic for a given spec and seed. */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.FleetEngine;

  const DEFAULTS = {
    seed: 3, horizonH: 12, model: 'llama-70b', gpu: 'H100', gpus: 160, gpusPerNode: 8, tp: 8, pp: 1, microbatches: 8,
    batchMTokens: 4, kernelEff: 0.55, overlap: 0.7, ibGbpsPerGpu: 400, nvlinkGBs: 450,
    storageGBs: 40, remoteGBs: 1, cacheHit: 0.2, workersPerGpu: 8, prefetch: true,
    mixes: [
      { name: 'Text, pre-tokenized', tokensPerSample: 4096, bytesPerToken: 2, remoteShare: 0, samplesPerWorkerS: 400 },
      { name: 'Video + images, 70% in a cloud bucket', tokensPerSample: 2000, bytesPerToken: 600, remoteShare: 0.7, samplesPerWorkerS: 0.06 }
    ],
    switchMixAtH: 4,
    ckptMin: 45, ckptGBs: 20, asyncCkpt: false, restartMin: 12, faultPerGpuDay: 0.03, repairH: 4, spares: 1,
    stragglerShare: 0.01, stragglerSlow: 0.12, queueWaitS: 0, faultLog: null,
    elastic: false, powerCapPct: 100, sites: 1, wanGbps: 400
  };
  // Board power per GPU (W), for power caps and energy.
  const TDP = { A100: 400, L40S: 350, H100: 700, H200: 700, MI300X: 750, B200: 1000 };
  const PHASES = ['queue', 'data', 'compute', 'straggler', 'sync', 'optimizer', 'checkpoint', 'restart', 'lost'];
  const PHASE_LABEL = { queue: 'waiting to be scheduled', data: 'waiting on data loading', compute: 'computing', straggler: 'waiting on slow GPUs', sync: 'waiting on gradient sync', optimizer: 'optimizer step', checkpoint: 'writing checkpoints', restart: 'restarting after faults', lost: 'redoing work lost to faults' };

  function norm(spec) {
    const s = Object.assign({}, DEFAULTS, JSON.parse(JSON.stringify(spec || {})));
    s.mixes = (s.mixes && s.mixes.length ? s.mixes : DEFAULTS.mixes).map(m => Object.assign({ tokensPerSample: 4096, bytesPerToken: 2, remoteShare: 0, samplesPerWorkerS: 400, name: 'mix' }, m));
    s.tp = Math.max(1, Math.min(s.tp, s.gpusPerNode));
    s.pp = Math.max(1, s.pp);
    return s;
  }

  // Per-step phase durations for the job on a given data mix (seconds), before stragglers.
  function stepModel(s, mix) {
    const M = E.MODELS[s.model] || E.MODELS['llama-70b'], G = E.GPUS[s.gpu] || E.GPUS.H100;
    const N = s.gpus, tokens = s.batchMTokens * 1e6, dp = Math.max(1, Math.floor(N / (s.tp * s.pp)));
    // a power cap below board power costs throughput sub-linearly (clocks drop less than power)
    const powerFactor = s.powerCapPct < 100 ? Math.pow(Math.max(0.3, s.powerCapPct / 100), 0.35) : 1;
    const compute = 6 * M.active * 1e9 * tokens / (N * G.bf16 * 1e12 * s.kernelEff * powerFactor);
    const tpOver = s.tp > 1 ? compute * 0.06 * Math.log2(s.tp) : 0;
    const bubble = s.pp > 1 ? compute * (s.pp - 1) / (s.microbatches + s.pp - 1) : 0;
    const gradBytes = 2 * M.params * 1e9 / (s.tp * s.pp);
    const multiNode = N > s.gpusPerNode;
    const bw = (multiNode ? s.ibGbpsPerGpu / 8 : s.nvlinkGBs) * 1e9;
    // split across two sites, the reduced gradients also cross the WAN once per step (hierarchical all-reduce)
    const cross = s.sites > 1 ? 2 * M.params * 1e9 / (s.wanGbps * 1e9 / 8) : 0;
    const comm = (dp > 1 ? 2 * (dp - 1) / dp * gradBytes / bw : 0) + cross;
    const sync = comm * (1 - s.overlap);
    const optimizer = 16 * M.params * 1e9 / N / (G.bw * 1e12 * 0.5);
    const bytes = tokens * mix.bytesPerToken, miss = 1 - s.cacheHit;
    const io = bytes * miss * (1 - mix.remoteShare) / (s.storageGBs * 1e9) + bytes * miss * mix.remoteShare / (s.remoteGBs * 1e9);
    const cpu = tokens / mix.tokensPerSample / (N * s.workersPerGpu * mix.samplesPerWorkerS);
    const dataRaw = Math.max(io, cpu);
    const busy = compute + tpOver + bubble;
    const data = s.prefetch ? Math.max(0, dataRaw - busy) : dataRaw;
    const ckptBytes = 14 * M.params * 1e9;
    const ckptWrite = ckptBytes / (s.ckptGBs * 1e9);
    const minGpus = Math.ceil(16 * M.params * 1e9 / (0.75 * G.hbm * 1e9));
    return { compute, tpOver, bubble, busy, comm, cross, powerFactor, sync, optimizer, dataRaw, io, cpu, data, dataBound: cpu >= io ? 'cpu' : 'io', bytes, tokens, dp, ckptWrite, ckptBytes, minGpus, multiNode, flops: 6 * M.active * 1e9 * tokens };
  }

  // Parses a GPU fault log: CSV or JSON lines with a node/host, a GPU index and optionally a time and Xid.
  function parseFaultLog(text) {
    const out = [];
    const lines = String(text).split(/\r?\n/).filter(l => l.trim());
    let header = null;
    for (const line of lines) {
      let o = null;
      if (line.trim().startsWith('{')) { try { o = JSON.parse(line); } catch (e) { continue; } }
      else if (!header && /(^|,)\s*(node|hostname|host|instance)\s*(,|$)/i.test(line)) { header = line.split(',').map(x => x.trim().toLowerCase()); continue; }
      else if (header) { const v = line.split(','); o = {}; header.forEach((h, i) => { o[h] = (v[i] || '').trim(); }); }
      else {
        // syslog style: "... NVRM: Xid (PCI:0000:3b:00): 79, ..." with a hostname first
        const m = line.match(/^(\S+\s+\S+\s+\S+\s+)?(\S+).*Xid.*?\(PCI:([0-9a-f:.]+)\):\s*(\d+)/i);
        if (m) out.push({ node: m[2], gpu: m[3], xid: +m[4], t: null });
        continue;
      }
      if (!o) continue;
      const node = o.node || o.hostname || o.host || o.Hostname || o.instance;
      const gpu = o.gpu != null ? o.gpu : o.gpu_index != null ? o.gpu_index : o.index != null ? o.index : o.device;
      if (node == null) continue;
      out.push({ node: String(node), gpu: String(gpu == null ? '?' : gpu), xid: o.xid != null ? +o.xid : o.Xid != null ? +o.Xid : null, t: o.timestamp || o.time || o.ts || null });
    }
    const byGpu = new Map(), byNode = new Map();
    for (const f of out) { const k = f.node + '/' + f.gpu; byGpu.set(k, (byGpu.get(k) || 0) + 1); byNode.set(f.node, (byNode.get(f.node) || 0) + 1); }
    const xids = {}; for (const f of out) if (f.xid != null) xids[f.xid] = (xids[f.xid] || 0) + 1;
    return { events: out, byGpu: [...byGpu].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n), byNode: [...byNode].map(([k, n]) => ({ node: k, n })).sort((a, b) => b.n - a.n), xids };
  }

  function simulateTraining(specIn) {
    const s = norm(specIn), rng = E.makeRng(s.seed >>> 0), N = s.gpus, H = s.horizonH * 3600;
    const nodes = Math.ceil(N / s.gpusPerNode);
    // per-GPU speed: a few stragglers, the rest within ±1%
    const slow = new Float64Array(N);
    for (let g = 0; g < N; g++) slow[g] = Math.exp(0.004 * rng.normal()) * (rng.u() < s.stragglerShare ? 1 + s.stragglerSlow * (0.6 + 0.8 * rng.u()) : 1);
    const maxSlow = slow.reduce((a, b) => Math.max(a, b), 1);
    // fault weights: uniform, or skewed toward GPUs/nodes that fault in an imported log
    const weight = new Float64Array(N).fill(1);
    if (s.faultLog && s.faultLog.byGpu && s.faultLog.byGpu.length) {
      const top = s.faultLog.byGpu.slice(0, N);
      top.forEach((x, i) => { const g = Math.floor(rng.u() * N); weight[g] += x.n * 4; void i; });
    }
    const wsum = weight.reduce((a, b) => a + b, 0);
    // fault times over the horizon (Poisson, total rate N × per-GPU rate)
    const faults = [];
    const rate = N * s.faultPerGpuDay / 86400;
    if (rate > 0) for (let t = s.queueWaitS - Math.log(1 - rng.u()) / rate; t < H; t += -Math.log(1 - rng.u()) / rate) {
      let r = rng.u() * wsum, g = 0; while (g < N - 1 && r > weight[g]) { r -= weight[g]; g++; }
      faults.push({ t, gpu: g, node: Math.floor(g / s.gpusPerNode) });
    }
    const per = {}; for (const p of PHASES) per[p] = 0;           // wall seconds by phase
    const gpuS = {}; for (const k of ['compute', 'straggler', 'data', 'sync', 'optimizer', 'checkpoint', 'restart', 'queue', 'faulted']) gpuS[k] = new Float64Array(N);
    const steps = [], segs = [];
    let t = 0, tokens = 0, ckptTokens = 0, lastCkpt = 0, fi = 0, sparesLeft = s.spares;
    const sparesBack = [];
    if (s.queueWaitS > 0) { segs.push({ t0: 0, t1: Math.min(H, s.queueWaitS), kind: 'queue' }); per.queue += Math.min(H, s.queueWaitS); for (let g = 0; g < N; g++) gpuS.queue[g] += Math.min(H, s.queueWaitS); t = s.queueWaitS; lastCkpt = t; }
    const models = s.mixes.map(m => stepModel(s, m));
    const mixAt = tt => (s.mixes.length > 1 && tt >= s.switchMixAtH * 3600 ? 1 : 0);
    let stepsSinceCkpt = [];
    const shrunk = [];
    let shrunkS = 0;
    while (t < H) {
      const mi = mixAt(t), m = models[mi];
      const jitter = 1 + 0.01 * rng.normal();
      for (let i = shrunk.length - 1; i >= 0; i--) if (shrunk[i].until <= t) shrunk.splice(i, 1);
      const lost = shrunk.reduce((a, x) => a + x.gpus, 0), scale = lost ? N / Math.max(1, N - lost) : 1;
      const compute = (m.compute + m.tpOver + m.bubble) * jitter * scale;
      const strag = compute * (maxSlow - 1);
      const total = m.data + compute + strag + m.sync + m.optimizer;
      // a fault during this step?
      while (sparesBack.length && sparesBack[0] <= t) { sparesBack.shift(); sparesLeft++; }
      while (fi < faults.length && faults[fi].t < t) fi++;   // faults while the job was already down or checkpointing do not stop it again
      if (fi < faults.length && faults[fi].t < t + total) {
        const f = faults[fi++], tf = Math.max(t, f.t);
        // work since the last checkpoint is lost; those steps are marked
        for (const st of stepsSinceCkpt) st.lost = true;
        const lostS = stepsSinceCkpt.reduce((a, st) => a + st.total, 0) + (tf - t);
        per.lost += lostS;
        tokens = ckptTokens; stepsSinceCkpt = [];
        let down = s.restartMin * 60;
        if (sparesLeft > 0) { sparesLeft--; sparesBack.push(tf + s.repairH * 3600); sparesBack.sort((a, b) => a - b); }
        else if (s.elastic) { shrunk.push({ until: tf + s.repairH * 3600, gpus: s.gpusPerNode }); f.elastic = true; }   // elastic: carry on without the node
        else down += s.repairH * 3600;   // no spare: wait for the node to be repaired
        f.lostS = lostS; f.down = down; f.spare = sparesLeft >= 0 && down === s.restartMin * 60;
        const t1 = Math.min(H, tf + down);
        segs.push({ t0: tf, t1, kind: 'restart', gpu: f.gpu, lostS, waitedRepair: down > s.restartMin * 60 });
        per.restart += t1 - tf;
        for (let g = 0; g < N; g++) gpuS.restart[g] += t1 - tf;
        gpuS.faulted[f.gpu] += Math.min(H, tf + s.repairH * 3600) - tf;
        t = t1; lastCkpt = t; ckptTokens = tokens;
        continue;
      }
      if (t + total > H) break;
      const st = { t, mix: mi, data: m.data, compute, straggler: strag, sync: m.sync, optimizer: m.optimizer, total, tokens: m.tokens, bytes: m.bytes, lost: false, shrunk: lost };
      if (lost) shrunkS += total;
      steps.push(st); stepsSinceCkpt.push(st);
      per.data += m.data; per.compute += compute; per.straggler += strag; per.sync += m.sync; per.optimizer += m.optimizer;
      for (let g = 0; g < N; g++) { gpuS.compute[g] += compute * slow[g]; gpuS.straggler[g] += compute * (maxSlow - slow[g]); gpuS.data[g] += m.data; gpuS.sync[g] += m.sync; gpuS.optimizer[g] += m.optimizer; }
      t += total; tokens += m.tokens;
      if (s.ckptMin > 0 && t - lastCkpt >= s.ckptMin * 60) {
        const w = s.asyncCkpt ? m.ckptWrite * 0.1 : m.ckptWrite, t1 = Math.min(H, t + w);
        segs.push({ t0: t, t1, kind: 'checkpoint' });
        per.checkpoint += t1 - t;
        for (let g = 0; g < N; g++) gpuS.checkpoint[g] += t1 - t;
        t = t1; lastCkpt = t; ckptTokens = tokens; stepsSinceCkpt = [];
      }
    }
    // steps lost were counted in both their phases and `lost`; move them to `lost` only
    for (const st of steps) if (st.lost) { per.data -= st.data; per.compute -= st.compute; per.straggler -= st.straggler; per.sync -= st.sync; per.optimizer -= st.optimizer; }
    const wall = Math.min(H, Math.max(t, steps.length ? steps[steps.length - 1].t + steps[steps.length - 1].total : t));
    const kept = steps.filter(x => !x.lost);
    const keptTokens = kept.reduce((a, x) => a + x.tokens, 0);
    const G = E.GPUS[s.gpu] || E.GPUS.H100;
    const usefulFlops = kept.length ? keptTokens * 6 * (E.MODELS[s.model] || E.MODELS['llama-70b']).active * 1e9 : 0;
    const shares = {}; for (const p of PHASES) shares[p] = wall ? Math.max(0, per[p]) / wall : 0;
    const losses = PHASES.filter(p => p !== 'compute' && p !== 'optimizer').map(p => [p, shares[p]]).sort((a, b) => b[1] - a[1]);
    const byMix = s.mixes.map((mx, i) => {
      const ss = steps.filter(x => x.mix === i);
      const avg = k => (ss.length ? ss.reduce((a, x) => a + x[k], 0) / ss.length : NaN);
      return { name: mx.name, steps: ss.length, stepS: avg('total'), dataS: avg('data'), computeS: avg('compute'), syncS: avg('sync'), stragglerS: avg('straggler'), model: models[i] };
    });
    const nodeFaults = {}; for (const f of faults) if (f.lostS != null) nodeFaults[f.node] = (nodeFaults[f.node] || 0) + 1;
    const gpuFaultN = new Uint16Array(N); for (const f of faults) if (f.lostS != null) gpuFaultN[f.gpu]++;
    const slowRank = [...slow].map((v, g) => ({ gpu: g, node: Math.floor(g / s.gpusPerNode), slow: v })).sort((a, b) => b.slow - a.slow);
    const idleGpuH = {}; for (const k in gpuS) if (k !== 'compute') idleGpuH[k] = gpuS[k].reduce((a, b) => a + b, 0) / 3600;
    const summary = {
      wallH: wall / 3600, steps: steps.length, keptSteps: kept.length, tokensB: keptTokens / 1e9, tokensPerS: wall ? keptTokens / wall : 0,
      goodput: shares.compute + shares.optimizer, mfu: wall ? usefulFlops / (wall * N * G.bf16 * 1e12) : 0,
      faults: faults.filter(f => f.lostS != null).length, lostH: per.lost / 3600, restartH: per.restart / 3600,
      shrunkH: shrunkS / 3600, elasticFaults: faults.filter(f => f.elastic).length,
      energyMWh: N * (TDP[s.gpu] || 700) * (s.powerCapPct / 100) * wall * (0.35 + 0.65 * Math.min(1, shares.compute + shares.optimizer + shares.straggler)) / 3.6e9,
      dataGBs: steps.length ? steps.reduce((a, x) => a + x.bytes, 0) / steps.reduce((a, x) => a + x.total, 0) / 1e9 : 0,
      bottleneck: losses[0] && losses[0][1] > 0.02 ? { phase: losses[0][0], share: losses[0][1], label: PHASE_LABEL[losses[0][0]] } : null,
      losses, shares, minGpus: models[0].minGpus, nodes, dp: models[0].dp, maxSlow, stragglers: slowRank.filter(x => x.slow > 1.03).length
    };
    return { spec: s, N, nodes, slow, steps, TDP: TDP[s.gpu] || 700, segs, faults: faults.filter(f => f.lostS != null), shares, per, byMix, gpuS, idleGpuH, nodeFaults, gpuFaultN, slowRank, models, summary, PHASE_LABEL };
  }

  // Training job state at time t: which phase each GPU is in (for the GPU-centric view).
  // Returns { phase, step, frac } plus per-GPU state codes: 0 compute, 1 waiting on stragglers, 2 data, 3 sync,
  // 4 optimizer, 5 checkpoint, 6 restart (idle), 7 faulted, 8 queued, 9 done.
  function stateAt(R, t, out) {
    const N = R.N, st = out || new Uint8Array(N);
    const seg = R.segs.find(x => x.t0 <= t && t < x.t1);
    const faulted = new Set(R.faults.filter(f => f.t <= t && t < f.t + R.spec.repairH * 3600).map(f => f.gpu));
    if (seg) {
      const code = seg.kind === 'checkpoint' ? 5 : seg.kind === 'queue' ? 8 : 6;
      for (let g = 0; g < N; g++) st[g] = faulted.has(g) ? 7 : code;
      return { phase: seg.kind, seg, st };
    }
    let lo = 0, hi = R.steps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (R.steps[m].t <= t) lo = m + 1; else hi = m; }
    const x = R.steps[lo - 1];
    if (!x || t > x.t + x.total) { for (let g = 0; g < N; g++) st[g] = faulted.has(g) ? 7 : 9; return { phase: 'done', st }; }
    const o = t - x.t;
    let phase;
    if (o < x.data) { phase = 'data'; for (let g = 0; g < N; g++) st[g] = 2; }
    else if (o < x.data + x.compute + x.straggler) {
      phase = 'compute';
      const c = o - x.data;
      for (let g = 0; g < N; g++) st[g] = c < x.compute * R.slow[g] ? 0 : 1;
    } else if (o < x.data + x.compute + x.straggler + x.sync) { phase = 'sync'; for (let g = 0; g < N; g++) st[g] = 3; }
    else { phase = 'optimizer'; for (let g = 0; g < N; g++) st[g] = 4; }
    for (const g of faulted) st[g] = 7;
    return { phase, step: x, st };
  }

  const api = { DEFAULTS, PHASES, PHASE_LABEL, stepModel: (s, m) => stepModel(norm(s), m || norm(s).mixes[0]), simulateTraining, stateAt, parseFaultLog, normalizeTraining: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetTraining = api;
})(typeof window !== 'undefined' ? window : this);
