/* FleetScope planning: the cheapest graph that meets the targets, a 24-month buy-vs-rent plan, and MIG packing. */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const E = node ? require('./engine.js') : root.FleetEngine;
  const SC = node ? require('./scenario.js') : root.FleetScenarioLib;
  const clone = o => JSON.parse(JSON.stringify(o));

  // ---------- optimiser ----------
  // Decision variables: each pool's instance count (fixed pools) or max (autoscaled), each pool's GPU type when
  // `gpuChoices` is given, and the router policies. Constraints: SLO attainment ≥ target, no residency breaches when
  // traffic is restricted, and optionally an N-1 floor (SLO with the largest pool down). Objective: serving $/hour.
  function evaluate(graph, lookup, opt) {
    const c = E.compileGraph(graph, lookup);
    if (c.errors.length) return { ok: false, cost: Infinity, errors: c.errors };
    const R = E.simulate(c.spec), s = R.summary;
    let breaches = 0;
    if (opt.residency) { const B = E.securityBreakdown(R, 0, R.D); breaches = B.total.viol; }
    let n1 = null;
    if (opt.n1Floor) {
      const big = c.spec.pools.slice().sort((a, b) => b.max - a.max)[0];
      n1 = E.simulate(c.spec, { name: 'N-1', outages: [{ target: big.id, fraction: 1, start: 0, dur: 1e9, recovery: 0 }] }).summary.slo;
    }
    const ok = s.slo >= opt.target && breaches === 0 && (!opt.n1Floor || n1 >= opt.n1Floor);
    return { ok, cost: s.costPerHr, slo: s.slo, n1, breaches, gpus: s.peakGpus, bottleneck: s.bottleneck.first, summary: s };
  }
  const pools = g => g.nodes.filter(n => n.type === 'pool');
  const sizeOf = n => (n.cfg.autoscale ? n.cfg.max : n.cfg.instances);
  const setSize = (n, v) => { if (n.cfg.autoscale) { n.cfg.max = v; n.cfg.min = Math.min(n.cfg.min, v); } else n.cfg.instances = v; };

  function* optimizeIter(graph0, opt) {
    opt = Object.assign({ target: 0.95, n1Floor: 0, maxEvals: 60, gpuChoices: null, policies: ['primary-first', 'least-wait'], residency: true }, opt || {});
    const lookup = opt.traceLookup || ((k, s) => E.scaleTrace(E.genTrace(k === 'uploaded' || k === 'live' ? 'chat' : k, 7), s || 1, 7));
    let evals = 0;
    const tried = new Map();
    const ev = g => { const key = JSON.stringify(g.nodes.map(n => n.cfg)); if (tried.has(key)) return tried.get(key); evals++; const r = evaluate(g, lookup, opt); tried.set(key, r); return r; };
    const start = clone(graph0), base = ev(start);
    let best = clone(start), bestR = base;
    yield { done: evals, total: opt.maxEvals, text: 'Starting point: ' + (base.ok ? 'meets the targets' : 'misses them') + ', $' + base.cost.toFixed(2) + '/h' };
    // 1. feasibility: grow the pool that breaks first until the targets are met
    let guard = 0;
    while (!bestR.ok && evals < opt.maxEvals && guard++ < 40) {
      const g = clone(best);
      const b = bestR.bottleneck && pools(g).find(n => n.id === bestR.bottleneck.id);
      const target = b || pools(g).sort((x, y) => sizeOf(y) - sizeOf(x))[0];
      setSize(target, Math.max(sizeOf(target) + 1, Math.ceil(sizeOf(target) * 1.25)));
      if (b && b.cfg.autoscale && b.cfg.min === 0) b.cfg.min = 1;   // a cold pool that breaks first needs a warm instance
      const r = ev(g);
      best = g; bestR = r;
      yield { done: evals, total: opt.maxEvals, text: 'Growing ' + target.cfg.name + ' to ' + sizeOf(target) + (r.ok ? ': targets met' : '') };
    }
    if (!bestR.ok) return finish(start, base, best, bestR, evals, opt, 'infeasible');
    // 2. trim: shrink each pool while the targets still hold, cheapest-first by $/instance-hour saved
    let improved = true;
    while (improved && evals < opt.maxEvals) {
      improved = false;
      const cands = pools(best).filter(n => sizeOf(n) > (n.cfg.autoscale ? 0 : 1)).sort((a, b) => sizeOf(b) - sizeOf(a));
      for (const n of cands) {
        if (evals >= opt.maxEvals) break;
        const g = clone(best), m = pools(g).find(x => x.id === n.id), step = Math.max(1, Math.floor(sizeOf(m) * 0.15));
        setSize(m, sizeOf(m) - step);
        const r = ev(g);
        yield { done: evals, total: opt.maxEvals, text: 'Trying ' + m.cfg.name + ' at ' + sizeOf(m) + ': ' + (r.ok ? '$' + r.cost.toFixed(2) + '/h' : 'misses') };
        if (r.ok && r.cost < bestR.cost) { best = g; bestR = r; improved = true; }
      }
    }
    // 3. GPU type swaps, each re-trimmed once
    if (opt.gpuChoices) for (const n of pools(best)) for (const gpu of opt.gpuChoices) {
      if (evals >= opt.maxEvals || gpu === n.cfg.gpu) continue;
      const g = clone(best), m = pools(g).find(x => x.id === n.id);
      m.cfg.gpu = gpu;
      let r = ev(g);
      while (r.ok && sizeOf(m) > 1 && evals < opt.maxEvals) { const g2 = clone(g), m2 = pools(g2).find(x => x.id === n.id); setSize(m2, sizeOf(m2) - 1); const r2 = ev(g2); if (!r2.ok || r2.cost >= r.cost) break; Object.assign(m.cfg, m2.cfg); r = r2; }
      yield { done: evals, total: opt.maxEvals, text: n.cfg.name + ' on ' + gpu + ': ' + (r.ok ? '$' + r.cost.toFixed(2) + '/h' : 'misses') };
      if (r.ok && r.cost < bestR.cost) { best = g; bestR = r; }
    }
    // 4. router policies
    for (const rt of best.nodes.filter(n => n.type === 'router')) for (const pol of opt.policies) {
      if (evals >= opt.maxEvals || pol === rt.cfg.policy) continue;
      const g = clone(best); g.nodes.find(x => x.id === rt.id).cfg.policy = pol;
      const r = ev(g);
      yield { done: evals, total: opt.maxEvals, text: rt.cfg.name + ' ' + pol + ': ' + (r.ok ? '$' + r.cost.toFixed(2) + '/h' : 'misses') };
      if (r.ok && r.cost < bestR.cost) { best = g; bestR = r; }
    }
    return finish(start, base, best, bestR, evals, opt, 'ok');
  }
  function finish(start, base, best, bestR, evals, opt, status) {
    return { status, evals, target: opt.target, n1Floor: opt.n1Floor, before: strip(base), after: strip(bestR), graph: best, changes: SC.describeGraph(start, best) };
  }
  const strip = r => ({ ok: r.ok, cost: r.cost, slo: r.slo, n1: r.n1, breaches: r.breaches, gpus: r.gpus, bottleneck: r.bottleneck ? r.bottleneck.name + ': ' + r.bottleneck.label : null });
  const optimize = (g, o) => { const it = optimizeIter(g, o); let x; do x = it.next(); while (!x.done); return x.value; };

  // ---------- buy vs rent ----------
  // Monthly peak GPU demand grows from today's; three strategies are costed over the horizon:
  // rent on demand, rent reserved (1-year commitments) with on-demand burst, and hybrid (buy on-prem for the
  // base load with a lead time, reserve nothing, burst the rest on demand). On-prem cost: capex (paid at
  // delivery), power at PUE, and operations; hardware keeps its residual value at the end.
  const CAP_DEFAULTS = { months: 24, gpusNow: 64, growthPct: 4, baseShare: 0.6, peakHoursShare: 0.35, gpuCapex: 32000, amortMonths: 48, kwPerGpu: 1.1, pue: 1.3, kwhPrice: 0.09, opsPerGpuMonth: 120, leadMonths: 3, reservedPerGpuH: 2.2, onDemandPerGpuH: 3.5, onPremStart: 0 };
  function capacityPlan(o) {
    o = Object.assign({}, CAP_DEFAULTS, o || {});
    const H = 730, months = [];
    const strat = { demand: [], rent: [], reserved: [], hybrid: [], owned: [] };
    let owned = o.onPremStart;
    const deliveries = [];
    for (let m = 0; m < o.months; m++) {
      const peak = o.gpusNow * Math.pow(1 + o.growthPct / 100, m), base = peak * o.baseShare;
      // average GPUs busy: base all month, the rest only during the peak hours
      const avgUse = base + (peak - base) * o.peakHoursShare;
      const rent = avgUse * H * o.onDemandPerGpuH;
      const reserved = base * H * o.reservedPerGpuH + (peak - base) * o.peakHoursShare * H * o.onDemandPerGpuH;
      // hybrid: order on-prem GPUs so that, after the lead time, owned capacity covers the base load
      const futureBase = o.gpusNow * Math.pow(1 + o.growthPct / 100, m + o.leadMonths) * o.baseShare;
      const pipeline = deliveries.filter(d => d.at >= m).reduce((a, d) => a + d.n, 0);
      const order = Math.max(0, Math.ceil(futureBase - owned - pipeline));
      if (order > 0) deliveries.push({ at: m + o.leadMonths, n: order });
      let capex = 0;
      for (const d of deliveries) if (d.at === m) { owned += d.n; capex += d.n * o.gpuCapex; }
      const onprem = owned * (o.kwPerGpu * o.pue * H * o.kwhPrice + o.opsPerGpuMonth);
      const uncovered = Math.max(0, base - owned) * H + (peak - Math.max(base, Math.min(owned, peak))) * o.peakHoursShare * H;
      const hybrid = capex + onprem + Math.max(0, uncovered) * o.onDemandPerGpuH;
      months.push({ m, peak, base, owned, order, capex, rent, reserved, hybrid });
    }
    const residual = owned => owned * o.gpuCapex * Math.max(0, 1 - o.months / o.amortMonths);
    const sum = k => months.reduce((a, x) => a + x[k], 0);
    const totals = { rent: sum('rent'), reserved: sum('reserved'), hybrid: sum('hybrid') - residual(owned), hybridCash: sum('hybrid') };
    const ranked = Object.entries({ rent: totals.rent, reserved: totals.reserved, hybrid: totals.hybrid }).sort((a, b) => a[1] - b[1]);
    // break-even: first month where cumulative hybrid cash spend falls below cumulative renting
    let cr = 0, ch = 0, breakEven = null;
    for (const x of months) { cr += x.rent; ch += x.hybrid; if (breakEven == null && x.owned > 0 && ch <= cr) breakEven = x.m; }
    return { opt: o, months, totals, best: ranked[0][0], ranked, breakEven, ownedEnd: owned, residual: residual(owned) };
  }

  // ---------- MIG packing ----------
  // H100/H200 MIG profiles: compute slices (of 7) and memory. Each small workload replica takes the smallest
  // profile whose memory holds its weights plus KV headroom; slices are packed first-fit-decreasing into GPUs.
  const MIG = {
    H100: [['1g.10gb', 1, 10], ['1g.20gb', 1, 20], ['2g.20gb', 2, 20], ['3g.40gb', 3, 40], ['4g.40gb', 4, 40], ['7g.80gb', 7, 80]],
    H200: [['1g.18gb', 1, 18], ['1g.35gb', 1, 35], ['2g.35gb', 2, 35], ['3g.71gb', 3, 71], ['4g.71gb', 4, 71], ['7g.141gb', 7, 141]],
    A100: [['1g.10gb', 1, 10], ['2g.20gb', 2, 20], ['3g.40gb', 3, 40], ['4g.40gb', 4, 40], ['7g.80gb', 7, 80]]
  };
  function migPlan(workloads, gpu, opt) {
    opt = Object.assign({ headroom: 1.3 }, opt || {});
    const profs = MIG[gpu] || MIG.H100, memTotal = profs[profs.length - 1][2];
    const items = [];
    for (const w of workloads) {
      const need = w.memoryGB * opt.headroom, minSlices = w.minSlices || 1;
      const p = profs.find(x => x[2] >= need && x[1] >= minSlices);
      for (let i = 0; i < (w.replicas || 1); i++) items.push({ name: w.name, profile: p ? p[0] : null, slices: p ? p[1] : 7, mem: p ? p[2] : memTotal, fits: !!p });
    }
    items.sort((a, b) => b.slices - a.slices || b.mem - a.mem);
    const gpus = [];
    for (const it of items) {
      let g = gpus.find(x => x.slices + it.slices <= 7 && x.mem + it.mem <= memTotal);
      if (!g) { g = { slices: 0, mem: 0, parts: [] }; gpus.push(g); }
      g.slices += it.slices; g.mem += it.mem; g.parts.push(it);
    }
    const whole = workloads.reduce((a, w) => a + (w.replicas || 1) * Math.max(1, Math.ceil(w.memoryGB * opt.headroom / memTotal)), 0);
    return { gpu, gpus, used: gpus.length, whole, saved: whole - gpus.length, sliceUse: gpus.length ? gpus.reduce((a, g) => a + g.slices, 0) / (7 * gpus.length) : 0, unfit: items.filter(i => !i.fits).map(i => i.name) };
  }

  const api = { evaluate, optimizeIter, optimize, CAP_DEFAULTS, capacityPlan, MIG, migPlan };
  if (node) module.exports = api; else root.FleetOptimize = api;
})(typeof window !== 'undefined' ? window : this);
