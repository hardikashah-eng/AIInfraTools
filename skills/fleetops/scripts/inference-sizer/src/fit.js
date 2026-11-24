// The Inference Sizer, the other way round.
//   capacity(): a model on hardware you have → the most load it carries within the latency targets, the longest
//               prompt it can take, and the layout that does it
//   fitModels(): hardware you have (+ a workload) → which catalog models fit, ranked
// Both run the sizer's plan() and search on its inputs, so they inherit its model and its calibration (or lack of it).
// Two answers each: "production" (the sizer's 15% headroom, an N+1 spare, a 10% margin under the targets) and "edge"
// (none of those: what a benchmark would show).
(function (root) {
  const SM = typeof require === 'function' ? require('./model.js') : root.SizerModel;
  const SC = typeof require === 'function' ? require('./catalog.js') : root.SizerCatalog;

  const PROFILE = { production: {}, edge: { headroom: 0, nPlus1: false, sloMargin: 0 } };

  // Sizer settings for one model on one GPU type and a workload. hw: { gpu, nodes, gpusPerNode? } ; wl: { isl, osl,
  // islP99?, oslP99?, rate? } ; tg: { ttftS, tpotS } ; extra: any sizer field (kvprec, wprec, eff…, calibration)
  function settings(model, hw, wl, tg, extra) {
    const g = typeof hw.gpu === 'object' ? hw.gpu : SC.GPUS.find(x => x.id === hw.gpu);
    const m = typeof model === 'object' ? model : SC.MODELS.find(x => x.id === model);
    if (!g) throw new Error(`unknown GPU ${hw.gpu}; known: ${SC.GPUS.map(x => x.id).join(', ')}`);
    if (!m) throw new Error(`unknown model ${model}; known: ${SC.MODELS.map(x => x.id).join(', ')}`);
    const isl = wl.isl || 2000, osl = wl.osl || 400, islP99 = Math.max(isl, wl.islP99 || isl * 4), oslP99 = Math.max(osl, wl.oslP99 || osl * 4);
    return Object.assign({}, SM.SETTINGS, m, g, {
      model: m.id, gpu: g.id, domain: hw.gpusPerNode || g.domain,
      dau: (wl.rate || 1) * 86400, rpu: 1, peakFactor: 1, concSource: 'dau', conc: 0,
      avgIn: isl, peakIn: islP99, avgOut: osl, peakOut: oslP99,
      ctx: Math.min(m.maxCtx || 131072, Math.max(SM.SETTINGS.ctx, islP99 + oslP99)),
      ttft: Math.round((tg.ttftS || 2) * 1000), tpot: Math.round((tg.tpotS || 0.05) * 1000), mode: 'auto',
    }, extra || {});
  }

  // The layout plan() chose, as deployable parallelism.
  function layout(p) {
    if (!p || !p.chosen) return null;
    if (p.chosen.mode === 'agg') { const b = p.agg.best; return { mode: 'agg', tp: b.c.tpl, pp: b.c.pp, gpusPerInstance: b.c.g, instances: b.N, concurrency: b.Bop * b.N, kvUse: b.kvUse, label: b.label }; }
    const P = p.dis.P, D = p.dis.D;
    return { mode: 'disagg', prefill: { tp: P.c.tpl, pp: P.c.pp, gpusPerInstance: P.c.g, instances: P.N, label: P.label }, decode: { tp: D.c.tpl, pp: D.c.pp, gpusPerInstance: D.c.g, instances: D.N, label: D.label }, concurrency: D.Bop * D.N, instances: P.N + D.N };
  }

  // Does the plan for settings s fit on hw? (provisioned nodes, spare included, within the nodes there are)
  function fits(s, hw) {
    const p = SM.plan(s, { noSens: true });
    if (!p.chosen) return { ok: false, p };
    const D = s.domain, have = hw.nodes != null ? hw.nodes : Math.floor((hw.gpus || 0) / D);
    const ok = have >= 1 ? p.chosen.totalNodes <= have : (p.chosen.gpus + (s.nPlus1 ? p.chosen.gpus : 0)) <= (hw.gpus || 0);
    return { ok, p };
  }

  // The highest request rate (req/s) the hardware carries within the targets: a doubling then a bisection on rate.
  function maxRate(model, hw, wl, tg, opts) {
    opts = opts || {};
    const prof = PROFILE[opts.profile || 'production'];
    const at = r => fits(settings(model, hw, Object.assign({}, wl, { rate: r }), tg, Object.assign({}, opts.extra, prof)), hw);
    let lo = 0, hi = 0.05, best = null;
    const first = at(hi);
    if (!first.ok) {
      // can't carry even a trickle: say why (weights, one full-context sequence, a latency floor)
      const rows = (first.p.agg && first.p.agg.rows) || [];
      const why = first.p.chosen ? `needs ${first.p.chosen.totalNodes} node(s) even at the lowest load` : (rows.find(r => r.why) || {}).why || 'no layout meets the targets';
      return { rate: 0, why, floors: { ttftS: first.p.ttftFloor, tpotS: first.p.tpotFloor } };
    }
    best = { rate: hi, p: first.p };
    while (hi < 1e5) { const x = at(hi * 2); if (!x.ok) break; hi *= 2; best = { rate: hi, p: x.p }; }
    lo = hi; hi = hi * 2;
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2, x = at(mid); if (x.ok) { lo = mid; best = { rate: mid, p: x.p }; } else hi = mid; }
    return { rate: best.rate, layout: layout(best.p), nodes: best.p.chosen.totalNodes, gpus: best.p.chosen.gpus, provGPUs: best.p.chosen.provGPUs, reason: best.p.reason };
  }

  // The longest prompt (tokens) one request can bring at a light load: memory for weights and KV, and TTFT.
  function maxPrompt(model, hw, wl, tg, opts) {
    opts = opts || {};
    const m = typeof model === 'object' ? model : SC.MODELS.find(x => x.id === model);
    const prof = PROFILE[opts.profile || 'production'], osl = wl.osl || 400;
    const ok = L => fits(settings(model, hw, Object.assign({}, wl, { rate: 0.05, isl: Math.min(L, wl.isl || L), islP99: L, oslP99: osl }), tg, Object.assign({}, opts.extra, prof, { ctx: L + osl })), hw).ok;
    const cap = (m.maxCtx || 131072) - osl;
    if (!ok(1024)) return 0;
    if (ok(cap)) return cap;
    let lo = 1024, hi = cap;
    while (hi - lo > 256) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid; }
    return lo;
  }

  // Everything about one model on given hardware.
  function capacity(model, hw, wl, tg, opts) {
    opts = opts || {};
    const m = typeof model === 'object' ? model : SC.MODELS.find(x => x.id === model);
    const g = SC.GPUS.find(x => x.id === (typeof hw.gpu === 'object' ? hw.gpu.id : hw.gpu));
    const gpus = hw.nodes != null ? hw.nodes * (hw.gpusPerNode || g.domain) : hw.gpus;
    const prod = maxRate(m, hw, wl, tg, Object.assign({}, opts, { profile: 'production' }));
    const edge = maxRate(m, hw, wl, tg, Object.assign({}, opts, { profile: 'edge' }));
    const out = { model: m.id, name: m.name, params: m.total, active: m.active, gpu: g.id, gpus, wl: { isl: wl.isl || 2000, osl: wl.osl || 400 }, tg: { ttftS: tg.ttftS || 2, tpotS: tg.tpotS || 0.05 },
      production: prod, edge, maxPrompt: opts.noPrompt ? null : maxPrompt(m, hw, wl, tg, opts), modelMaxCtx: m.maxCtx };
    const tps = r => r * (wl.osl || 400);
    if (prod.rate > 0) {
      out.production.outTokensPerS = tps(prod.rate);
      out.production.usersAt = rpu => prod.rate * 86400 / rpu; // daily active users at `rpu` requests each, flat load
      const price = g.price || 0;
      out.production.dollarsPerMOut = price && gpus ? gpus * price / (tps(prod.rate) * 3600 / 1e6) : null;
    }
    return out;
  }

  // Which catalog models fit on the hardware, for a workload. rank: 'largest' (most parameters that still carry the
  // needed rate: a proxy for capability, not a quality score) or 'throughput'.
  function fitModels(hw, wl, tg, opts) {
    opts = opts || {};
    const rows = SC.MODELS.map(m => {
      try { return capacity(m, hw, wl, tg, Object.assign({}, opts, { noPrompt: !opts.prompt })); } catch (e) { return { model: m.id, name: m.name, params: m.total, error: e.message, production: { rate: 0, why: e.message }, edge: { rate: 0 } }; }
    });
    const need = wl.rate || 0;
    for (const r of rows) r.meetsRate = r.production.rate > 0 && r.production.rate >= need;
    const rank = opts.rank || (need ? 'largest' : 'throughput');
    rows.sort((a, b) => (b.meetsRate - a.meetsRate) || (rank === 'largest' ? (b.params - a.params) : (b.production.rate - a.production.rate)));
    return { hw, wl, tg, need, rank, rows };
  }

  const api = { settings, capacity, maxRate, maxPrompt, fitModels, layout, PROFILE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SizerFit = api;
})(typeof self !== 'undefined' ? self : this);
