/* FleetScope engine: time-stepped fleet simulation for LLM serving and training.
   Pure functions, no DOM. Deterministic for (workload, scenario, seed).
   Performance is derived from model and GPU spec-sheet figures with fixed efficiency factors:
   a first-order roofline model, not calibrated. */
(function (root) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    const u = mulberry32(seed >>> 0);
    const rng = {
      u,
      normal() { let x = 0; while (x === 0) x = u(); const y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); },
      logn(med, sig) { return med * Math.exp(sig * rng.normal()); }
    };
    return rng;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Approximate public spec-sheet figures (dense TFLOPS, HBM GB, HBM TB/s). Prices are placeholders, $/GPU-hour.
  const GPUS = {
    A100: { label: 'A100 80GB', hbm: 80, bw: 2.0, bf16: 312, fp8: 312, onprem: 0.9, rent: 1.6 },
    L40S: { label: 'L40S 48GB', hbm: 48, bw: 0.864, bf16: 362, fp8: 733, onprem: 0.7, rent: 1.1 },
    H100: { label: 'H100 80GB', hbm: 80, bw: 3.35, bf16: 989, fp8: 1979, onprem: 1.4, rent: 2.4 },
    H200: { label: 'H200 141GB', hbm: 141, bw: 4.8, bf16: 989, fp8: 1979, onprem: 2.0, rent: 3.5 },
    MI300X: { label: 'MI300X 192GB', hbm: 192, bw: 5.3, bf16: 1307, fp8: 2615, onprem: 1.5, rent: 2.6 },
    B200: { label: 'B200 180GB', hbm: 180, bw: 8.0, bf16: 2250, fp8: 4500, onprem: 3.2, rent: 5.5 }
  };
  // Approximate architecture figures. kvDim = per-token, per-layer K+V width (2 x kv_heads x head_dim, or MLA latent).
  const MODELS = {
    'llama-8b': { label: 'Llama 3.1 8B', params: 8, active: 8, layers: 32, kvHeads: 8, headDim: 128, mla: 0 },
    'coder-32b': { label: 'Qwen2.5-Coder 32B', params: 32.8, active: 32.8, layers: 64, kvHeads: 8, headDim: 128, mla: 0 },
    'llama-70b': { label: 'Llama 3.3 70B', params: 70.6, active: 70.6, layers: 80, kvHeads: 8, headDim: 128, mla: 0 },
    'llama-405b': { label: 'Llama 3.1 405B', params: 405, active: 405, layers: 126, kvHeads: 8, headDim: 128, mla: 0 },
    'moe-671b': { label: 'MoE 671B, 37B active (MLA)', params: 671, active: 37, layers: 61, kvHeads: 0, headDim: 0, mla: 576 }
  };

  // ---------- performance profile ----------
  function profile(gpuKey, m) {
    const G = GPUS[gpuKey];
    const wBytes = m.params * 1e9 * (m.wPrec === 'bf16' ? 2 : 1);
    const kvElem = m.kvPrec === 'bf16' ? 2 : 1;
    const kvBytesPerToken = m.mla ? m.layers * m.mla * kvElem : 2 * m.layers * m.kvHeads * m.headDim * kvElem;
    let tp = 1;
    while (tp < 16 && wBytes / tp > 0.65 * G.hbm * 1e9) tp *= 2;
    const tflops = (m.wPrec === 'bf16' ? G.bf16 : G.fp8) * 1e12;
    const bw = G.bw * 1e12 * 0.75;
    const prefill = tp * tflops * 0.45 / (2 * m.active * 1e9);
    const weightRead = Math.min(wBytes, m.active * 1e9 * (m.wPrec === 'bf16' ? 2 : 1) * (m.params > m.active ? 3 : 1));
    const a = weightRead / (tp * bw) + 0.003;
    const b0 = 2 * m.active * 1e9 / (tp * tflops * 0.5);
    const c = kvBytesPerToken / (tp * bw);
    const kvCap = Math.max(0, Math.floor((tp * G.hbm * 1e9 * 0.9 - wBytes) / kvBytesPerToken));
    return { gpu: gpuKey, tp, prefill, a, b0, c, kvCap, kvBytesPerToken, wBytes, multiNode: tp > 8 };
  }

  // ---------- recorded traces ----------
  const TRACES = {
    chat: { label: 'Sample: chat, daily ramp with a spike' },
    agentic: { label: 'Sample: agentic, long prompts in bursts' },
    steady: { label: 'Sample: steady 10 req/s' }
  };
  function genTrace(kind, seed) {
    const rng = makeRng((seed * 7919 + (kind === 'chat' ? 1 : kind === 'agentic' ? 2 : 3)) >>> 0);
    const D = 600;
    let rate, isl, osl, peak;
    if (kind === 'chat') {
      rate = t => 9 + 7 * Math.sin(Math.PI * t / D) + (t >= 330 && t < 390 ? 14 : 0); peak = 30;
      isl = () => clamp(Math.round(rng.logn(1100, 0.9)), 32, 16000);
      osl = () => clamp(Math.round(rng.logn(220, 0.8)), 8, 2048);
    } else if (kind === 'agentic') {
      rate = t => 2.5 + (t >= 40 && ((t - 40) % 100) < 20 ? 12 : 0); peak = 14.5;
      isl = () => clamp(Math.round(rng.logn(7000, 0.6)), 500, 60000);
      osl = () => clamp(Math.round(rng.logn(150, 0.7)), 8, 1500);
    } else {
      rate = () => 10; peak = 10;
      isl = () => clamp(Math.round(rng.logn(800, 0.7)), 32, 8000);
      osl = () => clamp(Math.round(rng.logn(300, 0.7)), 8, 2048);
    }
    const out = [];
    let t = 0;
    for (;;) {
      t += -Math.log(1 - rng.u()) / peak;
      if (t >= D) break;
      if (rng.u() < rate(t) / peak) out.push({ t, isl: isl(), osl: osl() });
    }
    return out;
  }
  // Scales load by thinning or duplicating requests. Copies keep token counts and cache hits but
  // drop recorded latencies and sessions, which only describe the original request.
  function scaleTrace(tr, f, seed) {
    if (Math.abs(f - 1) < 1e-9) return tr.map(r => Object.assign({}, r));
    const rng = makeRng((seed + 101) >>> 0);
    const out = [];
    for (const r of tr) {
      let n = Math.floor(f);
      if (rng.u() < f - n) n++;
      for (let k = 0; k < n; k++) {
        if (k === 0) { out.push(Object.assign({}, r)); continue; }
        const c = { t: r.t + rng.u() * 0.5, isl: r.isl, osl: r.osl };
        if (r.cached != null) c.cached = r.cached;
        out.push(c);
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  // ---------- helpers ----------
  class Q {
    constructor() { this.a = []; this.h = 0; }
    push(x) { this.a.push(x); }
    get length() { return this.a.length - this.h; }
    peek() { return this.a[this.h]; }
    shift() { const x = this.a[this.h++]; if (this.h > 1024 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; } return x; }
  }
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].t <= a[i].t) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    peek() { return this.a[0]; }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].t < a[m].t) m = l; if (r < a.length && a[r].t < a[m].t) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    }
  }
  function pct(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  }

  // ---------- simulation ----------
  // Compares recorded TTFT (from real logs) with simulated TTFT on the same requests.
  // Returns a per-second rolling p99 of recorded TTFT and a summary, or null summary when the trace has none.
  function compareRecorded(reqs, D) {
    const withRec = reqs.filter(r => isFinite(r.recTtft));
    const p99 = new Float64Array(D).fill(NaN);
    if (!withRec.length) return { p99, summary: null };
    const byFirst = Array.from({ length: D }, () => []);
    for (const r of withRec) { const s = Math.floor(r.t + r.recTtft); if (s >= 0 && s < D) byFirst[s].push(r.recTtft); }
    for (let s = 0; s < D; s++) {
      const w = [];
      for (let j = Math.max(0, s - 29); j <= s; j++) for (const v of byFirst[j]) w.push(v);
      if (w.length) { w.sort((a, b) => a - b); p99[s] = pct(w, 0.99); }
    }
    const pairs = withRec.filter(r => isFinite(r.ttft));
    const rec = pairs.map(r => r.recTtft).sort((a, b) => a - b), sim = pairs.map(r => r.ttft).sort((a, b) => a - b);
    const recQ = withRec.filter(r => isFinite(r.recQueue)).map(r => r.recQueue).sort((a, b) => a - b);
    const err = (a, b) => (b > 0 ? (a - b) / b : NaN);
    const summary = {
      requests: withRec.length, compared: pairs.length,
      ttftP50: pct(rec, 0.5), ttftP99: pct(rec, 0.99), simTtftP50: pct(sim, 0.5), simTtftP99: pct(sim, 0.99),
      errP50: err(pct(sim, 0.5), pct(rec, 0.5)), errP99: err(pct(sim, 0.99), pct(rec, 0.99)),
      queueP99: recQ.length ? pct(recQ, 0.99) : NaN
    };
    return { p99, summary };
  }

  // ---------- graph compile ----------
  // graph = { nodes: [{id, type, x, y, cfg}], edges: [{id, from, to}] }
  const NODE_RULES = {
    agent: ['router'], chat: ['router'], trace: ['router'],
    router: ['pool', 'link'], link: ['pool'], pool: ['pool', 'link'], train: ['link'], model: [], slo: []
  };
  function compileGraph(g, traceLookup) {
    const errors = [], warn = [];
    const byId = {};
    for (const n of g.nodes) byId[n.id] = n;
    const outs = id => g.edges.filter(e => e.from === id);
    const ins = id => g.edges.filter(e => e.to === id);
    const modelN = g.nodes.find(n => n.type === 'model');
    const sloN = g.nodes.find(n => n.type === 'slo');
    if (!modelN) errors.push({ msg: 'Add a Model node: every pool serves that model.' });
    const spec = { seed: 7, model: modelN ? Object.assign({}, modelN.cfg) : null, slo: sloN ? { ttft: sloN.cfg.ttft, tpot: sloN.cfg.tpotMs / 1000 } : { ttft: 2, tpot: 0.06 },
      sources: [], routers: [], pools: [], links: [], train: null, horizon: 0, paths: {} };
    for (const n of g.nodes) if (n.type === 'link') spec.links.push({ id: n.id, name: n.cfg.name, gbps: n.cfg.gbps, rttMs: n.cfg.rttMs, egressPerGB: n.cfg.egressPerGB });
    // resolve a pool reached from an edge, possibly through one link node
    function reach(e) {
      const t = byId[e.to];
      if (!t) return [];
      if (t.type === 'pool') return [{ pool: t.id, link: null, edges: [e.id] }];
      if (t.type === 'link') return outs(t.id).filter(e2 => byId[e2.to] && byId[e2.to].type === 'pool').map(e2 => ({ pool: e2.to, link: t.id, edges: [e.id, e2.id] }));
      return [];
    }
    for (const n of g.nodes) {
      if (n.type !== 'pool') continue;
      const c = n.cfg;
      const p = { id: n.id, name: c.name, site: c.site, siteKind: c.siteKind, role: c.role, gpu: c.gpu,
        min: c.autoscale ? c.min : c.instances, max: c.autoscale ? Math.max(c.min, c.max, 1) : c.instances,
        auto: !!c.autoscale, coldStart: c.coldStart, upWait: c.upWait, downUtil: c.downUtil / 100, maxBatch: c.maxBatch, fabricGbps: c.fabricGbps, decode: [] };
      if (c.role === 'prefill') {
        for (const e of outs(n.id)) for (const r of reach(e)) {
          const d = byId[r.pool];
          if (d.cfg.role !== 'decode') { errors.push({ node: n.id, msg: n.cfg.name + ': a prefill pool can only feed decode pools.' }); continue; }
          if (!r.link && d.cfg.site !== c.site) errors.push({ node: n.id, msg: n.cfg.name + ' and ' + d.cfg.name + ' are in different sites: connect them through a Link node.' });
          p.decode.push(r);
        }
        if (!p.decode.length) errors.push({ node: n.id, msg: n.cfg.name + ': connect this prefill pool to a decode pool.' });
      } else if (outs(n.id).length) warn.push({ node: n.id, msg: n.cfg.name + ': only prefill pools have outputs; extra wires are ignored.' });
      if (c.role !== 'decode' && !ins(n.id).length && !g.edges.some(e => byId[e.from] && byId[e.from].type === 'link' && e.to === n.id)) warn.push({ node: n.id, msg: n.cfg.name + ' gets no traffic: wire a Router (or a Link) into it.' });
      if (c.role === 'decode' && !g.nodes.some(m => m.type === 'pool' && m.cfg.role === 'prefill' && outs(m.id).some(e => reach(e).some(r => r.pool === n.id)))) warn.push({ node: n.id, msg: n.cfg.name + ': decode pools need a prefill pool feeding them.' });
      spec.pools.push(p);
    }
    for (const n of g.nodes) {
      if (n.type !== 'router') continue;
      const targets = [];
      for (const e of outs(n.id)) for (const r of reach(e)) {
        const d = byId[r.pool];
        if (d.cfg.role === 'decode') { errors.push({ node: n.id, msg: 'A router feeds aggregated or prefill pools, not ' + d.cfg.name + ' (decode).' }); continue; }
        targets.push(r);
      }
      if (!targets.length) errors.push({ node: n.id, msg: n.cfg.name + ' has no pool to send requests to.' });
      spec.routers.push({ id: n.id, name: n.cfg.name, policy: n.cfg.policy, burstWait: n.cfg.burstWait, targets });
    }
    let uidBase = 0;
    for (const n of g.nodes) {
      if (!['agent', 'chat', 'trace'].includes(n.type)) continue;
      const e = outs(n.id)[0];
      if (!e) { errors.push({ node: n.id, msg: n.cfg.name + ': wire it to a Router.' }); continue; }
      const c = n.cfg;
      const s = { id: n.id, name: c.name, kind: n.type === 'trace' ? 'open' : n.type, router: e.to, edge: e.id, prefixHit: c.prefixHit / 100, useRecordedCache: c.useRecordedCache !== false, userBase: uidBase };
      if (n.type === 'trace') { s.trace = traceLookup ? traceLookup(c.trace, c.scale) : []; }
      else { Object.assign(s, { users: c.users, turns: c.turns, systemTokens: c.systemTokens, contextTokens: n.type === 'agent' ? c.contextTokens : 0, turnTokens: c.turnTokens, outTokens: c.outTokens, thinkS: c.thinkS, gapS: c.gapS, duration: c.durationMin * 60 }); uidBase += c.users; }
      spec.sources.push(s);
    }
    const tn = g.nodes.find(n => n.type === 'train');
    if (tn) {
      const le = outs(tn.id).find(e => byId[e.to] && byId[e.to].type === 'link');
      const c = tn.cfg;
      spec.train = { id: tn.id, model: c.model, gpus: c.gpus, gpu: c.gpu, site: c.site, siteKind: c.siteKind, link: le ? le.to : null, tokensPerStepM: c.tokensPerStepM, mfu: c.mfu / 100, overlap: c.overlap, horizonMin: c.horizonMin };
    }
    if (!spec.sources.length && !spec.train) errors.push({ msg: 'Add a traffic source (Coding agents, Chat users or Trace replay) or a Training job.' });
    if (spec.train && !spec.sources.length) spec.horizon = (tn.cfg.horizonMin || 10) * 60;
    return { spec, errors, warn };
  }

  // ---------- simulation ----------
  function simulate(spec) {
    const T0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = 0.05, STEPS = 20;
    const m = spec.model;
    const profs = {};
    const prof = gk => profs[gk] || (profs[gk] = profile(gk, m));
    const pools = [], byId = {};
    let dropped = 0;

    function addInst(p, t, ready) {
      p.inst.push({ id: p.nextId++, state: ready ? 'serving' : 'starting', readyAt: ready ? 0 : t + p.coldStart,
        batch: [], pre: [], preTok: 0, kvUsed: 0, ctxTok: 0, kvCap: p.P.kvCap, busy: 0, work: 0 });
    }
    for (const sp of spec.pools) {
      const p = Object.assign({}, sp);
      p.P = prof(p.gpu);
      p.price = p.siteKind === 'neo' ? GPUS[p.gpu].rent : GPUS[p.gpu].onprem;
      Object.assign(p, { inst: [], q: new Q(), qTokens: 0, lastUp: -1e9, utilHist: [], nextId: 0, tokSec: 0, spillFrom: [] });
      pools.push(p); byId[p.id] = p;
      for (let i = 0; i < p.min; i++) addInst(p, 0, true);
    }
    const links = {};
    function addLink(id, name, gbps, rtt, egress, fabric, site) {
      links[id] = { id, name, gbps, bps: gbps * 1e9 / 8, rtt, egress, fabric, site, xfers: [], bytesSec: 0, trainSec: 0, totalBytes: 0, trainBytes: 0, egressBytes: 0 };
    }
    const sites = {};
    for (const p of pools) sites[p.site] = Math.max(sites[p.site] || 0, p.fabricGbps || 400);
    for (const s in sites) addLink('fab:' + s, s + ' fabric', sites[s], 0.00002, 0, true, s);
    for (const L of spec.links) addLink(L.id, L.name, L.gbps, L.rttMs / 1000, L.egressPerGB, false, null);
    const linkList = Object.values(links);

    const routers = spec.routers.map(r => Object.assign({}, r, { rr: 0, targets: r.targets.map(x => Object.assign({}, x, { P: byId[x.pool] })) }));
    const routerById = {};
    for (const r of routers) { routerById[r.id] = r; if (r.policy === 'primary-first') for (const x of r.targets.slice(1)) x.P.spillFrom.push(r); }

    const servingCount = p => { let n = 0; for (const x of p.inst) if (x.state === 'serving') n++; return n; };
    function estWait(p) {
      const s = servingCount(p);
      if (s === 0) return Infinity;
      return p.qTokens / (s * p.P.prefill * (p.role === 'agg' ? 0.6 : 1));
    }
    function route(R) {
      const T = R.targets;
      if (T.length === 1) return T[0];
      if (R.policy === 'round-robin') { const o = T.filter(x => servingCount(x.P) > 0); const pick = o.length ? o : [T[0]]; return pick[(R.rr++) % pick.length]; }
      let best = T[0], bw = estWait(T[0].P);
      if (R.policy === 'primary-first' && bw <= R.burstWait) return T[0];
      for (const x of T.slice(1)) { const w = estWait(x.P); if (w < bw) { bw = w; best = x; } }
      return best;
    }

    // ----- workload -----
    const reqs = [];
    const future = new Heap();
    const rng = makeRng(((spec.seed || 7) * 2654435761) >>> 0);
    function mkReq(src, t, isl, osl, cached, user) {
      const r = { id: reqs.length, src: src.id, router: src.router, t, isl, osl, cached: Math.max(0, Math.min(cached, isl - 1)), user,
        site: '', pPool: '', dPool: '', inLink: '', net: 0, tEnq: NaN, tAdmit: NaN, tPrefEnd: NaN, tXferStart: NaN, tXferEnd: NaN, tFirst: NaN, tFinish: NaN,
        gen: 0, preRem: 0, kvRes: 0, xLink: '', fail: '', recTtft: NaN, recQueue: NaN, recE2e: NaN };
      reqs.push(r);
      return r;
    }
    let horizon = spec.horizon || 0;
    const users = [];
    const srcById = {};
    for (const S of spec.sources) {
      srcById[S.id] = S;
      if (S.kind === 'open') {
        for (const x of S.trace) {
          const cached = S.useRecordedCache && x.cached != null ? x.cached : Math.round(x.isl * S.prefixHit);
          const r = mkReq(S, x.t, x.isl, x.osl, cached, -1);
          if (x.ttft != null) r.recTtft = x.ttft;
          if (x.queue != null) r.recQueue = x.queue;
          if (x.e2e != null) r.recE2e = x.e2e;
          future.push(r);
        }
        horizon = Math.max(horizon, S.trace.length ? S.trace[S.trace.length - 1].t : 0);
      } else {
        horizon = Math.max(horizon, S.duration);
        const ramp = Math.min(120, S.duration / 4);
        for (let u = 0; u < S.users; u++) {
          const st = { id: S.userBase + u, src: S, ctx: 0, turns: 0 };
          users[st.id] = st;
          future.push({ t: rng.u() * ramp, user: st.id, fresh: true, pending: true });
        }
      }
    }
    const maxCtx = 128000;
    function newSession(st) {
      const S = st.src;
      st.ctx = Math.round(S.systemTokens + (S.kind === 'agent' ? S.contextTokens * (0.6 + 0.8 * rng.u()) : 0));
      st.turns = Math.max(1, Math.round(rng.logn(S.turns, 0.45)));
    }
    function issue(st, t) {
      const S = st.src;
      const add = Math.max(16, Math.round(rng.logn(S.turnTokens, 0.8)));
      const isl = Math.min(maxCtx - 512, st.ctx + add);
      const osl = clamp(Math.round(rng.logn(S.outTokens, 0.7)), 4, 8192);
      return mkReq(S, t, isl, osl, Math.round(Math.min(st.ctx, isl) * S.prefixHit), st.id);
    }
    function after(uid, isl, osl, t) {
      const st = users[uid];
      st.ctx = isl + osl;
      if (st.ctx > maxCtx * 0.8) st.ctx = Math.round(st.ctx * 0.3);
      st.turns--;
      const next = st.turns > 0 ? t + Math.max(0.2, rng.logn(st.src.thinkS, 0.5)) : t + Math.max(1, rng.logn(st.src.gapS, 0.6));
      if (next < st.src.duration) future.push({ t: next, user: uid, fresh: st.turns <= 0, pending: true });
    }

    function enq(p, r, t) {
      if (p.role === 'decode') { r.tXferEnd = t; r.dPool = p.id; } else r.tEnq = t;
      r._t = t;
      p.q.push(r);
      if (p.role !== 'decode') p.qTokens += Math.max(1, r.isl - r.cached);
    }
    let doneCount = 0, outTokens = 0;
    function finish(r, t) {
      r.tFinish = t; doneCount++; outTokens += r.osl;
      const dp = byId[r.dPool];
      if (dp && dp.siteKind === 'neo') { const L = links[r.inLink] || links[r.xLink]; if (L && !L.fabric) { L.egressBytes += r.osl * 4; L.totalBytes += r.osl * 4; } }
      if (r.user >= 0) after(r.user, r.isl, r.osl, t);
    }
    function failReq(r, t, why) {
      r.fail = why; dropped++; doneCount++;
      if (r.user >= 0) { users[r.user].turns = 1; after(r.user, 0, 0, t + 5); }
    }
    function pickDecode(p) {
      let best = null, bs = Infinity;
      for (const d of p.decode) {
        const D = byId[d.pool];
        const s = servingCount(D) + D.inst.filter(x => x.state === 'starting').length * 0.3;
        const score = (D.q.length + 1) / Math.max(0.3, s) + (d.link ? 0.5 : 0);
        if (score < bs) { bs = score; best = d; }
      }
      return best;
    }
    function onPrefillDone(p, x, r, t) {
      if (p.role === 'agg') {
        r.tFirst = t; r.gen = 1; r.dPool = p.id; x.ctxTok += r.isl + 1;
        if (r.osl <= 1) { x.kvUsed -= r.kvRes; x.ctxTok -= r.isl + 1; finish(r, t); } else x.batch.push(r);
        return;
      }
      const d = pickDecode(p);
      const L = d.link ? links[d.link] : links['fab:' + p.site];
      r.tXferStart = t; r.xLink = L.id;
      L.xfers.push({ r, rem: r.isl * p.P.kvBytesPerToken, d: byId[d.pool] });
    }
    function admit(p, t) {
      const cand = p.inst.filter(x => x.state === 'serving');
      if (!cand.length) return;
      while (p.q.length) {
        const r = p.q.peek();
        if (p.role !== 'prefill' && r.isl + r.osl > p.P.kvCap) { p.q.shift(); if (p.role !== 'decode') p.qTokens -= Math.max(1, r.isl - r.cached); failReq(r, t, 'Context does not fit in one instance’s KV cache'); continue; }
        let best = null, bl = Infinity;
        for (const x of cand) {
          let l;
          if (p.role === 'prefill') { if (x.pre.length >= 16) continue; l = x.preTok; }
          else {
            const load = x.batch.length + x.pre.length;
            if (load >= p.maxBatch) continue;
            if (x.kvUsed + r.isl + r.osl > x.kvCap) continue;
            l = x.kvUsed / x.kvCap + x.preTok / 1e5;
          }
          if (l < bl) { bl = l; best = x; }
        }
        if (!best) break;
        p.q.shift();
        if (p.role !== 'decode') {
          const work = Math.max(1, r.isl - r.cached);
          p.qTokens -= work;
          r.tAdmit = t; r.preRem = work;
          best.pre.push(r); best.preTok += work;
          if (p.role === 'agg') { r.kvRes = r.isl + r.osl; best.kvUsed += r.kvRes; }
        } else {
          r.tFirst = t; r.gen = 1; r.kvRes = r.isl + r.osl; best.kvUsed += r.kvRes; best.ctxTok += r.isl + 1;
          if (r.osl <= 1) { best.kvUsed -= r.kvRes; best.ctxTok -= r.isl + 1; finish(r, t); } else best.batch.push(r);
        }
      }
    }
    function stepInst(p, x, t0) {
      const P = p.P;
      const chunkMax = p.role === 'prefill' ? 16384 : 2048;
      let left = dt, busy = 0, it = 0;
      while (left > 1e-9 && it < 64) {
        it++;
        const B = x.batch.length;
        const chunk = Math.min(x.preTok, chunkMax);
        const iterT = (B > 0 ? P.a + P.b0 * B + P.c * x.ctxTok : 0) + (chunk > 0 ? chunk / P.prefill + (B > 0 ? 0 : P.a * 0.5) : 0);
        if (iterT <= 0) break;
        const frac = Math.min(1, left / iterT);
        const tEnd = t0 + (dt - left) + iterT * frac;
        if (B > 0) {
          let w = 0;
          for (let i = 0; i < B; i++) {
            const r = x.batch[i];
            r.gen += frac; x.ctxTok += frac;
            if (r.gen >= r.osl) { x.kvUsed -= r.kvRes; x.ctxTok -= r.isl + r.gen; finish(r, tEnd); }
            else x.batch[w++] = r;
          }
          x.batch.length = w;
          p.tokSec += B * frac;
          if (x.ctxTok < 0) x.ctxTok = 0;
        }
        if (chunk > 0) {
          let tok = chunk * frac;
          x.preTok -= tok;
          while (tok > 1e-9 && x.pre.length) {
            const r = x.pre[0];
            const use = Math.min(tok, r.preRem);
            r.preRem -= use; tok -= use;
            if (r.preRem <= 1e-6) { x.pre.shift(); r.tPrefEnd = tEnd; onPrefillDone(p, x, r, tEnd); }
          }
          if (x.preTok < 1e-6) x.preTok = 0;
        }
        busy += iterT * frac;
        x.work += (iterT - (B > 0 ? P.a : 0) - (chunk > 0 && B === 0 ? P.a * 0.5 : 0)) * frac;
        left -= iterT * frac;
        if (frac < 1) break;
      }
      x.busy += busy;
    }

    let pend = [];
    // ----- training job (step-level model) -----
    let tr = null;
    if (spec.train) {
      const S = spec.train;
      const tm = MODELS[S.model] || MODELS['llama-70b'];
      const Gt = GPUS[S.gpu] || GPUS.H100;
      const tokens = S.tokensPerStepM * 1e6;
      const compute = 6 * tm.active * 1e9 * tokens / (S.gpus * Gt.bf16 * 1e12 * S.mfu);
      const gradBytes = tm.params * 1e9 * 2;
      const fab = sites[S.site] || 400;
      const intra = 2 * (gradBytes / 8) / (fab * 1e9 / 8);
      const L = S.link ? links[S.link] : null;
      const price = L ? (Gt.onprem + Gt.rent) / 2 : (S.siteKind === 'neo' ? Gt.rent : Gt.onprem);
      tr = { model: tm.label, compute, intra, crossBytes: L ? gradBytes : 0, L, price, gpus: S.gpus, tokens, steps: [], cur: null, overlap: S.overlap, split: !!L, site: S.site };
    }
    function trainTick(t) {
      if (!tr) return;
      if (!tr.cur) {
        tr.cur = { start: t, compEnd: t + tr.compute, commEnd: NaN, sent: false };
        if (!tr.crossBytes) tr.cur.commEnd = t + tr.compute + tr.intra * (tr.overlap ? 0.3 : 1);
      }
      const c = tr.cur;
      if (tr.crossBytes && !c.sent && (tr.overlap ? t >= c.start + tr.compute * 0.3 : t >= c.compEnd)) {
        c.sent = true;
        tr.L.xfers.push({ train: true, rem: tr.crossBytes, d: null });
      }
      const end = Math.max(c.compEnd, isFinite(c.commEnd) ? c.commEnd : Infinity);
      if (t >= end) { tr.steps.push({ start: c.start, end: t, comm: Math.max(0, t - c.compEnd) }); tr.cur = null; }
    }
    function stepLink(L, t0) {
      const n = L.xfers.length;
      if (!n) return;
      L.xfers.sort((a, b) => a.rem - b.rem);
      let cap = L.bps * dt;
      const keep = [];
      for (let i = 0; i < n; i++) {
        const xf = L.xfers[i];
        const mv = Math.min(cap / (n - i), xf.rem);
        xf.rem -= mv; cap -= mv;
        L.bytesSec += mv; L.totalBytes += mv;
        if (xf.train) { L.trainSec += mv; L.trainBytes += mv; }
        if (xf.rem <= 1e-6) {
          if (xf.train) { if (tr && tr.cur) tr.cur.commEnd = t0 + dt + L.rtt + tr.intra * 0.5; }
          else pend.push({ at: t0 + dt + L.rtt, pool: xf.d, req: xf.r });
        } else keep.push(xf);
      }
      L.xfers = keep;
    }

    function autoscale(t) {
      for (const p of pools) {
        if (!p.auto) continue;
        const live = p.inst.filter(x => x.state !== 'draining');
        const serving = live.filter(x => x.state === 'serving').length;
        const head = p.q.length ? t - p.q.peek()._t : 0;
        const recent = p.utilHist.slice(-5);
        const busyRecent = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
        let up = head > p.upWait;
        if (!up) for (const R of p.spillFrom) if (estWait(R.targets[0].P) > R.burstWait && (serving === 0 || busyRecent > 0.6)) up = true;
        if (up && live.length < p.max) { addInst(p, t, false); p.lastUp = t; continue; }
        if (t - p.lastUp >= 60 && serving > p.min && p.q.length === 0) {
          const h = p.utilHist.slice(-30);
          const avg = h.length ? h.reduce((s, v) => s + v, 0) / h.length : 1;
          if (avg < p.downUtil) {
            let pick = null, pl = Infinity;
            for (const x of live) if (x.state === 'serving') { const l = x.batch.length + x.pre.length; if (l < pl) { pl = l; pick = x; } }
            if (pick) { pick.state = 'draining'; p.lastUp = t - 50; }
          }
        }
      }
    }

    const frames = [];
    const tMax = horizon + 900;
    let k = 0;
    for (;;) {
      const t = k * dt;
      if (t > tMax) break;
      while (future.size && future.peek().t <= t) {
        let r = future.pop();
        if (r.pending) { const st = users[r.user]; if (r.fresh) newSession(st); r = issue(st, r.t); }
        const R = routerById[r.router];
        if (!R || !R.targets.length) { failReq(r, t, 'No route'); continue; }
        const x = route(R);
        const p = x.P;
        r.site = p.site; r.pPool = p.id;
        if (x.link) {
          const L = links[x.link];
          r.inLink = L.id; r.net = L.rtt;
          const b = (r.isl - r.cached) * 4;
          L.bytesSec += b; L.totalBytes += b;
          pend.push({ at: r.t + r.net, pool: p, req: r });
        } else enq(p, r, r.t);
      }
      if (pend.length) {
        const keep = [];
        for (const e of pend) { if (e.at <= t) enq(e.pool, e.req, e.at); else keep.push(e); }
        pend = keep;
      }
      for (const p of pools) for (const x of p.inst) if (x.state === 'starting' && x.readyAt <= t) x.state = 'serving';
      for (const p of pools) admit(p, t);
      for (const p of pools) for (const x of p.inst) if (x.state !== 'starting') stepInst(p, x, t);
      trainTick(t);
      for (const L of linkList) stepLink(L, t);
      k++;
      if (k % STEPS === 0) {
        const s = k / STEPS - 1;
        const fr = { s, pools: {}, links: {}, train: null };
        for (const p of pools) {
          let serving = 0, starting = 0, draining = 0, busy = 0, kvU = 0, kvC = 0, batch = 0, pre = 0;
          const inst = [];
          for (const x of p.inst) {
            if (x.state === 'serving') serving++; else if (x.state === 'starting') starting++; else draining++;
            if (x.state !== 'starting') { busy += x.work; kvU += x.kvUsed; kvC += x.kvCap; }
            batch += x.batch.length; pre += x.pre.length;
            inst.push({ st: x.state === 'serving' ? 0 : x.state === 'starting' ? 1 : 2, u: Math.min(1, x.work), kv: x.kvCap ? x.kvUsed / x.kvCap : 0, cold: x.state === 'starting' ? Math.max(0, x.readyAt - (s + 1)) : 0 });
            x.busy = 0; x.work = 0;
          }
          const active = serving + draining;
          const util = active ? Math.min(1, busy / active) : 0;
          p.utilHist.push(util);
          const head = p.q.length ? (s + 1) - p.q.peek()._t : 0;
          const gg = (serving + starting + draining) * p.P.tp;
          fr.pools[p.id] = { serving, starting, draining, util, q: p.q.length, head: Math.max(0, head), batch, pre, kv: kvC ? kvU / kvC : 0,
            tok: p.tokSec, gpus: gg, cost: gg * p.price / 3600, busyGpu: busy * p.P.tp, inst };
          p.tokSec = 0;
          p.inst = p.inst.filter(x => !(x.state === 'draining' && x.batch.length === 0 && x.pre.length === 0));
        }
        for (const L of linkList) {
          fr.links[L.id] = { util: Math.min(1, L.bytesSec / L.bps), gbps: L.bytesSec * 8 / 1e9, trainGbps: L.trainSec * 8 / 1e9, xfers: L.xfers.filter(x => !x.train).length, trainXfer: L.xfers.some(x => x.train) };
          L.bytesSec = 0; L.trainSec = 0;
        }
        if (tr) {
          const last = tr.steps[tr.steps.length - 1];
          fr.train = { steps: tr.steps.length, lastStep: last ? last.end - last.start : NaN, syncing: !!(tr.cur && tr.cur.sent && !isFinite(tr.cur.commEnd)), computing: !!(tr.cur && (s + 1) < tr.cur.compEnd) };
        }
        frames.push(fr);
        autoscale(s + 1);
        if (!future.size && doneCount === reqs.length && pend.length === 0 && s + 1 >= horizon) break;
      }
    }

    // ---------- post-processing ----------
    const D = frames.length;
    const slo = spec.slo;
    const arrivals = new Float64Array(D), completions = new Float64Array(D), viol = new Float64Array(D), firsts = new Float64Array(D), activeUsers = new Float64Array(D);
    const byFirst = Array.from({ length: D }, () => []);
    const tpotByFin = Array.from({ length: D }, () => []);
    let ok = 0;
    const ttftAll = [], tpotAll = [];
    for (const r of reqs) {
      const sa = Math.floor(r.t); if (sa < D) arrivals[sa]++;
      const done = isFinite(r.tFinish);
      r.ttft = isFinite(r.tFirst) ? r.tFirst - r.t : NaN;
      r.tpot = done && r.osl > 1 ? (r.tFinish - r.tFirst) / (r.osl - 1) : (done ? 0 : NaN);
      r.bQueue = r.tAdmit - r.tEnq; r.bPrefill = r.tPrefEnd - r.tAdmit;
      if (r.dPool === r.pPool) { r.bXfer = r.net; r.bDwait = 0; }
      else { r.bXfer = (r.tXferEnd - r.tPrefEnd) + r.net; r.bDwait = r.tFirst - r.tXferEnd; }
      if (isFinite(r.tFirst)) {
        const sf = Math.min(D - 1, Math.floor(r.tFirst));
        if (sf >= 0) { byFirst[sf].push(r); firsts[sf]++; if (r.ttft > slo.ttft) viol[sf]++; }
        ttftAll.push(r.ttft);
      }
      if (done) {
        const sd = Math.min(D - 1, Math.floor(r.tFinish)); completions[sd]++;
        if (r.osl > 1) { tpotByFin[sd].push(r.tpot); tpotAll.push(r.tpot); }
        if (r.ttft <= slo.ttft && r.tpot <= slo.tpot) ok++;
        if (r.user >= 0) { const a0 = Math.max(0, Math.floor(r.t)), a1 = Math.min(D - 1, Math.floor(r.tFinish)); for (let s = a0; s <= a1; s++) activeUsers[s]++; }
      }
      r.ok = done && r.ttft <= slo.ttft && r.tpot <= slo.tpot;
    }
    const p50 = new Float64Array(D), p99 = new Float64Array(D), tp99 = new Float64Array(D);
    const bq = new Float64Array(D), bp = new Float64Array(D), bx = new Float64Array(D), bd = new Float64Array(D);
    for (let s = 0; s < D; s++) {
      const win = [], twin = [];
      for (let j = Math.max(0, s - 29); j <= s; j++) { for (const r of byFirst[j]) win.push(r.ttft); for (const v of tpotByFin[j]) twin.push(v); }
      win.sort((a, b) => a - b); twin.sort((a, b) => a - b);
      p50[s] = win.length ? pct(win, 0.5) : NaN; p99[s] = win.length ? pct(win, 0.99) : NaN; tp99[s] = twin.length ? pct(twin, 0.99) : NaN;
      let n = 0, q = 0, pp = 0, x = 0, d = 0;
      for (let j = Math.max(0, s - 9); j <= s; j++) for (const r of byFirst[j]) { n++; q += r.bQueue || 0; pp += r.bPrefill || 0; x += r.bXfer || 0; d += r.bDwait || 0; }
      bq[s] = n ? q / n : 0; bp[s] = n ? pp / n : 0; bx[s] = n ? x / n : 0; bd[s] = n ? d / n : 0;
    }
    ttftAll.sort((a, b) => a - b); tpotAll.sort((a, b) => a - b);
    let cost = 0, gpuSec = 0, busyGpuSec = 0, peak = 0;
    const gpus = {}, util = {};
    for (const p of pools) { gpus[p.id] = new Float64Array(D); util[p.id] = new Float64Array(D); }
    for (const fr of frames) {
      let gsum = 0;
      for (const p of pools) {
        const f = fr.pools[p.id];
        cost += f.cost; gsum += f.gpus; busyGpuSec += f.busyGpu; gpuSec += f.gpus;
        gpus[p.id][fr.s] = f.gpus; util[p.id][fr.s] = f.util;
      }
      peak = Math.max(peak, gsum);
    }
    let crossGB = 0, egress = 0, trainEgress = 0;
    for (const L of linkList) if (!L.fabric) { crossGB += (L.totalBytes - L.trainBytes) / 1e9; egress += L.egressBytes / 1e9 * L.egress; trainEgress += L.trainBytes / 2 / 1e9 * L.egress; }
    const completed = reqs.filter(r => isFinite(r.tFinish)).length;
    const hrs = Math.max(1, D) / 3600;
    let trainSum = null;
    if (tr) {
      const st = tr.steps.length > 1 ? tr.steps.slice(1) : tr.steps;
      const mean = st.length ? st.reduce((s, x) => s + (x.end - x.start), 0) / st.length : NaN;
      const tokS = tr.tokens / mean;
      trainSum = { model: tr.model, gpus: tr.gpus, split: tr.split, site: tr.site, steps: tr.steps.length, stepS: mean, computeS: tr.compute,
        commShare: mean ? Math.max(0, 1 - tr.compute / mean) : NaN, tokPerS: tokS, costPerHr: tr.gpus * tr.price + trainEgress / hrs,
        daysPer100B: 1e11 / tokS / 86400, crossGB: tr.L ? tr.L.trainBytes / 1e9 : 0 };
    }
    const recorded = compareRecorded(reqs, D);
    const summary = {
      requests: reqs.length, completed, dropped,
      slo: reqs.length ? ok / reqs.length : NaN,
      ttftP50: pct(ttftAll, 0.5), ttftP99: pct(ttftAll, 0.99), tpotP99: pct(tpotAll, 0.99),
      util: gpuSec ? busyGpuSec / gpuSec : 0, peakGpus: peak,
      cost: cost + egress, costPerHr: (cost + egress) / hrs,
      costPerMTok: outTokens ? (cost + egress) / (outTokens / 1e6) : NaN,
      crossGB, egress, duration: D, simMs: 0, train: trainSum, users: users.filter(Boolean).length
    };
    summary.recorded = recorded.summary;
    summary.simMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - T0);
    const slim = reqs.map(r => ({ id: r.id, src: r.src, router: r.router, t: r.t, isl: r.isl, osl: r.osl, cached: r.cached, user: r.user, site: r.site, pPool: r.pPool, dPool: r.dPool, inLink: r.inLink, xLink: r.xLink,
      tEnq: r.tEnq, tAdmit: r.tAdmit, tPrefEnd: r.tPrefEnd, tXferEnd: r.tXferEnd, tFirst: r.tFirst, tFinish: r.tFinish, net: r.net, fail: r.fail,
      ttft: r.ttft, tpot: r.tpot, ok: r.ok, bQueue: r.bQueue, bPrefill: r.bPrefill, bXfer: r.bXfer, bDwait: r.bDwait,
      recTtft: r.recTtft, recQueue: r.recQueue, recE2e: r.recE2e }));
    return {
      spec,
      pools: pools.map(p => ({ id: p.id, name: p.name, site: p.site, siteKind: p.siteKind, role: p.role, gpu: p.gpu, min: p.min, max: p.max, price: p.price, auto: p.auto, coldStart: p.coldStart, P: p.P })),
      links: linkList.map(L => ({ id: L.id, name: L.name, gbps: L.gbps, rtt: L.rtt, fabric: L.fabric, site: L.site })),
      frames, reqs: slim, train: tr ? { steps: tr.steps } : null,
      series: { arrivals, completions, viol, firsts, activeUsers, p50, p99, tp99, bq, bp, bx, bd, gpus, util, recP99: recorded.p99 },
      summary, D
    };
  }

  const api = { GPUS, MODELS, TRACES, NODE_RULES, profile, genTrace, scaleTrace, compileGraph, simulate, compareRecorded, makeRng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetEngine = api;
})(typeof window !== 'undefined' ? window : this);
