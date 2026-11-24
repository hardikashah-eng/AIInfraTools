/* FleetScope scenario: one clock and one change set across the Fleet, Cluster, Training and Inference views,
   and fleet pools whose capacity follows a cluster workload's ready replicas. */
(function (root) {
  'use strict';

  // ---------- linking a fleet pool to a cluster workload ----------
  // The cluster's shortfall of ready replicas over the window [startS, startS + durS) becomes outages on the fleet pool:
  // a replica the cluster cannot keep ready is an instance the pool loses. Shares are rounded to `quantum` and
  // consecutive seconds at the same share are merged.
  function linkOutages(readiness, step, poolId, startS, durS, opt) {
    opt = opt || {};
    const q = opt.quantum || 0.05, out = [];
    let cur = null;
    for (let s = 0; s < durS; s++) {
      const k = Math.floor((startS + s) / step);
      const tgt = readiness.target[k] || 0, rdy = readiness.ready[k] || 0;
      const frac = tgt > 0 ? Math.round(Math.max(0, tgt - rdy) / tgt / q) * q : 0;
      if (cur && cur.fraction === frac) { cur.dur++; continue; }
      if (cur && cur.fraction > 0) out.push(cur);
      cur = { target: poolId, fraction: frac, start: s, dur: 1, recovery: 0, linked: true };
    }
    if (cur && cur.fraction > 0) out.push(cur);
    return out.map(o => Object.assign(o, { fraction: Math.min(1, +o.fraction.toFixed(2)) }));
  }

  // ---------- diffs for the change set ----------
  function diff(a, b, path, out) {
    out = out || []; path = path || '';
    if (a === b) return out;
    const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb || ta !== 'object' && ta !== 'array' || a === null || b === null) { out.push({ path, from: a, to: b }); return out; }
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) diff(a[k], b[k], path ? path + '.' + k : k, out);
    return out;
  }
  const show = v => (v === undefined || v === '' || v === null ? '—' : typeof v === 'number' ? (Math.round(v * 1000) / 1000).toString() : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v));
  const HIDE = /(^|\.)(x|y|trace|label|key)$/;
  // Fleet graph: by node name; added/removed nodes and wires
  function describeGraph(a, b) {
    const out = [], byId = g => Object.fromEntries(g.nodes.map(n => [n.id, n]));
    const A = byId(a), B = byId(b), nameOf = n => (n.cfg && n.cfg.name) || n.id;
    for (const id in B) if (!A[id]) out.push('added ' + nameOf(B[id]));
    for (const id in A) if (!B[id]) out.push('removed ' + nameOf(A[id]));
    for (const id in B) if (A[id]) for (const d of diff(A[id].cfg, B[id].cfg)) if (!HIDE.test(d.path)) out.push(nameOf(B[id]) + ': ' + d.path + ' ' + show(d.from) + ' → ' + show(d.to));
    const ek = g => new Set(g.edges.map(e => e.from + '>' + e.to));
    const EA = ek(a), EB = ek(b), nm = (g, id) => { const n = g.nodes.find(x => x.id === id); return n ? nameOf(n) : id; };
    for (const e of EB) if (!EA.has(e)) { const [f, t] = e.split('>'); out.push('wired ' + nm(b, f) + ' → ' + nm(b, t)); }
    for (const e of EA) if (!EB.has(e)) { const [f, t] = e.split('>'); out.push('unwired ' + nm(a, f) + ' → ' + nm(a, t)); }
    return out;
  }
  // Specs with named lists (cluster pools, queues, workloads; training mixes)
  function describeSpec(a, b) {
    const out = [];
    for (const d of diff(a, b)) {
      if (HIDE.test(d.path)) continue;
      const m = d.path.match(/^(pools|queues|workloads|mixes)\.(\d+)\.(.+)$/);
      if (m) { const it = (b[m[1]] || [])[+m[2]] || (a[m[1]] || [])[+m[2]] || {}; out.push((it.name || m[1] + ' ' + m[2]) + ': ' + m[3] + ' ' + show(d.from) + ' → ' + show(d.to)); }
      else out.push(d.path + ' ' + show(d.from) + ' → ' + show(d.to));
    }
    return out;
  }

  // ---------- the shared store (browser) ----------
  function createStore() {
    const views = {}, listeners = [];
    const store = {
      clock: 0, baseline: null, views,
      register(name, api) { views[name] = api; },
      setClock(t, from) { store.clock = Math.max(0, t); for (const f of listeners) f(store.clock, from); },
      onClock(f) { listeners.push(f); },
      pinAll() {
        const snap = {};
        for (const k in views) { try { snap[k] = JSON.parse(JSON.stringify(views[k].snapshot())); if (views[k].pin) views[k].pin(); } catch (e) { /* a view not started yet has nothing to pin */ } }
        store.baseline = snap;
        return snap;
      },
      changes() {
        if (!store.baseline) return [];
        const out = [];
        for (const k in views) {
          const b = store.baseline[k]; if (!b) continue;
          let cur; try { cur = views[k].snapshot(); } catch (e) { continue; }
          for (const line of (views[k].describe || describeSpec)(b, cur)) out.push({ view: k, text: line });
        }
        return out;
      },
      resetAll() { if (!store.baseline) return; for (const k in views) if (store.baseline[k] && views[k].restore) views[k].restore(JSON.parse(JSON.stringify(store.baseline[k]))); }
    };
    return store;
  }

  const api = { linkOutages, diff, describeGraph, describeSpec, createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.FleetScenarioLib = api; root.FleetScenario = root.FleetScenario || createStore(); }
})(typeof window !== 'undefined' ? window : this);
