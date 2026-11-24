/* Export an Inference Sizer result as a FleetScope graph (../fleetscope), so the steady-state answer can be
   replayed over time: bursts, cold starts, links and failures. Load it with "Load graph JSON" in FleetScope,
   or drop it into fleetscope/scenarios/<name>/graph.json for the CI plan. */
(function (root) {
  'use strict';

  // GPUs and models FleetScope knows by key (fleetscope/src/engine.js GPUS and MODELS).
  const FS_GPUS = { A100: 'A100', L40S: 'L40S', H100: 'H100', H200: 'H200', MI300X: 'MI300X', B200: 'B200', B300: 'B300', 'GB200-NVL72': 'GB200' };
  const FS_MODELS = { 'llama31-8b': 'llama-8b', 'llama33-70b': 'llama-70b', 'llama31-405b': 'llama-405b', 'deepseek-v3': 'moe-671b' };
  // FleetScope's chat source draws prompt additions and output lengths from log-normals (sigma 0.8 and 0.7);
  // these factors turn the sizer's means into the medians it expects.
  const MEAN_OVER_MEDIAN_IN = Math.exp(0.8 * 0.8 / 2), MEAN_OVER_MEDIAN_OUT = Math.exp(0.7 * 0.7 / 2), GAP_S = 30, MEAN_GAP_S = GAP_S * Math.exp(0.6 * 0.6 / 2);

  function toGraph(r, opts) {
    opts = opts || {};
    const s = r.s, errors = [], notes = [];
    if (!r.chosen) return { ok: false, errors: ['There is no recommended layout to export. Change the inputs until a layout meets the targets.'] };
    const gpu = FS_GPUS[s.gpu];
    if (!gpu) errors.push(`FleetScope has no profile for "${s.gpuLabel || s.gpu}". Pick one of ${Object.keys(FS_GPUS).join(', ')}, or add the GPU to the GPUS table in fleetscope/src/engine.js.`);
    if (s.total > 2000) errors.push('FleetScope models up to 2,000B parameters.');
    if (errors.length) return { ok: false, errors };

    const mla = s.attn === 'mla';
    const key = FS_MODELS[s.model] || 'custom';
    if (s.wprec === 'fp4') notes.push('FleetScope has no FP4 path; the model is exported with FP8 weights, so FleetScope will be more conservative.');
    if (s.swaWindow > 0 && s.swaFrac > 0) notes.push('FleetScope sizes KV for full attention on every layer; sliding-window savings are not carried over.');
    notes.push('FleetScope picks prompt and output lengths from log-normal distributions with these means, so peak prompts come from the distribution\'s tail rather than your peak figures.');

    // Traffic: single-turn chat sessions arriving at the sized peak rate (without headroom), gaps between sessions ~30 s.
    const lam = r.load.lam0;
    const cycle = MEAN_GAP_S + s.ttft / 1000 + s.avgOut * s.tpot / 1000;
    const users = Math.max(1, Math.round(lam * cycle));
    const hit = Math.min(95, s.prefixHit || 0) / 100;
    const aIn = Math.min(s.avgIn, s.ctx);
    const systemTokens = Math.round(aIn * hit);
    const turnTokens = Math.max(16, Math.round((aIn - systemTokens) / MEAN_OVER_MEDIAN_IN));
    const outTokens = Math.max(4, Math.round(s.avgOut / MEAN_OVER_MEDIAN_OUT));

    const nodes = [], edges = [];
    const add = (id, type, x, y, cfg) => nodes.push({ id, type, x, y, cfg });
    add('model', 'model', 40, 20, {
      name: 'Model', key, label: s.modelLabel || s.model, wPrec: s.wprec === 'bf16' ? 'bf16' : 'fp8', kvPrec: s.kvprec,
      thinkTokens: 0, thinkKeep: false, specK: 0, specAccept: 0.7,
      params: +s.total, active: +s.active, layers: s.layers, kvHeads: mla ? 0 : s.kvHeads, headDim: mla ? 0 : s.headDim, mla: mla ? (s.mlaLatent || 512) + (s.mlaRope == null ? 64 : s.mlaRope) : 0,
    });
    add('slo', 'slo', 310, 20, { name: 'SLO targets', ttft: s.ttft / 1000, tpotMs: s.tpot, thinkingStreamed: false, confidentialIn: 'private', internalIn: 'any', requireEncryption: true });
    add('src', 'chat', 40, 250, {
      name: 'Sized traffic', users, turns: 1, systemTokens, contextTokens: 0, turnTokens, outTokens, thinkS: 5, gapS: GAP_S,
      prefixHit: hit > 0 ? 100 : 0, durationMin: opts.durationMin || 10, dataClass: 'internal', owner: '', oncall: '',
    });
    add('rt', 'router', 330, 250, { name: 'Router', policy: 'least-wait', burstWait: 1.5, affinity: 'ideal', enforceResidency: false, owner: '', oncall: '' });
    edges.push({ id: 'e:src>rt', from: 'src', to: 'rt' });

    const D = r.md.D;
    const pool = (id, name, role, row, x) => {
      const g = row.c.g;
      add(id, 'pool', x, 180, {
        name, site: opts.site || 'On-prem DC', siteKind: 'onprem', role, gpu, tp: g, instances: row.N, autoscale: false, min: 0, max: Math.max(8, row.N),
        coldStart: 90, upWait: 1, downUtil: 30, maxBatch: Math.max(8, Math.round(role === 'prefill' ? 256 : (row.Binst || row.Bop || 256))),
        fabricGbps: s.nicGbps * Math.min(g, D), zone: 'auto', owner: '', oncall: '', calibPrefill: 1, calibDecode: 1, clusterWorkload: '', clusterAtH: 0,
        offloadGB: 0, offloadGBs: 50, loraAdapters: 0, loraSlots: 8,
      });
    };
    if (r.chosen.mode === 'disagg') {
      pool('pre', `Prefill ${r.dis.P.N} × ${r.dis.P.label}`, 'prefill', r.dis.P, 620);
      pool('dec', `Decode ${r.dis.D.N} × ${r.dis.D.label}`, 'decode', r.dis.D, 940);
      edges.push({ id: 'e:rt>pre', from: 'rt', to: 'pre' }, { id: 'e:pre>dec', from: 'pre', to: 'dec' });
    } else {
      pool('agg', `Serving ${r.agg.best.N} × ${r.agg.best.label}`, 'agg', r.agg.best, 620);
      edges.push({ id: 'e:rt>agg', from: 'rt', to: 'agg' });
    }
    if (r.chosen.spareNodes) notes.push('The N+1 spare is not exported: FleetScope pools hold serving instances only. Use its Reliability lens to test losing an instance.');
    return { ok: true, graph: { nodes, edges }, notes, users };
  }

  const api = { toGraph, FS_GPUS, FS_MODELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SizerFleetScope = api;
})(this);
