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
    steady: { label: 'Sample: steady 10 req/s' },
    sessions: { label: 'Sample: agent sessions log (session ids, recorded latency)' }
  };
  // A synthetic "recorded" agent log: 150 sessions whose turns follow the previous answer plus tool time,
  // with recorded TTFT and end-to-end latency, cache hits, and occasional parallel tool calls.
  function genSessionLog(seed) {
    const rng = makeRng((seed * 7919 + 4) >>> 0);
    const rows = [];
    for (let sid = 0; sid < 150; sid++) {
      let t = rng.u() * 420, ctx = Math.round(4000 + 26000 * rng.u());
      const turns = Math.max(2, Math.round(rng.logn(8, 0.5)));
      for (let k = 0; k < turns && t < 600; k++) {
        const add = Math.round(rng.logn(2000, 0.8));
        const isl = Math.min(120000, ctx + add), osl = clamp(Math.round(rng.logn(300, 0.7)), 8, 4000);
        const ttft = 0.25 + isl * (1 - 0.85) / 15000 + rng.u() * 0.3, e2e = ttft + osl * 0.03;
        rows.push({ t, isl, osl, cached: Math.round(ctx * 0.85), ttft, e2e, session: 'agent-' + sid });
        if (rng.u() < 0.1) rows.push({ t: t + 0.2, isl: Math.round(isl * 0.6), osl: Math.round(osl * 0.5), cached: Math.round(ctx * 0.5), ttft: ttft * 0.8, e2e: ttft * 0.8 + osl * 0.015, session: 'agent-' + sid });
        ctx = isl + osl;
        t += e2e + Math.max(0.3, rng.logn(4, 0.6));
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }
  function genTrace(kind, seed) {
    if (kind === 'sessions') return genSessionLog(seed);
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
  // ----- lenses: where cost and latency go, and what each failure would cost -----
  // Spend per pool (with the share paid for idle GPUs), egress per link and training spend over seconds [s0, s1).
  function costBreakdown(R, s0, s1) {
    s0 = Math.max(0, Math.floor(s0)); s1 = Math.min(R.D, Math.ceil(s1));
    const out = { nodes: {}, total: 0, idle: 0, egress: 0, seconds: Math.max(0, s1 - s0), bySite: { onprem: 0, neo: 0 } };
    for (const p of R.pools) {
      let spend = 0, idle = 0, gpuS = 0, tok = 0;
      for (let s = s0; s < s1; s++) { const f = R.frames[s].pools[p.id]; if (!f) continue; spend += f.cost; gpuS += f.gpus; tok += f.tok; if (f.gpus > 0) idle += f.cost * Math.max(0, 1 - f.busyGpu / f.gpus); }
      out.nodes[p.id] = { kind: 'pool', spend, idle, gpuHours: gpuS / 3600, tokens: tok, perMTok: tok ? spend / (tok / 1e6) : NaN };
      out.total += spend; out.idle += idle; out.bySite[p.siteKind === 'neo' ? 'neo' : 'onprem'] += spend;
    }
    for (const L of R.links) {
      if (L.fabric) continue;
      let egr = 0, tegr = 0;
      for (let s = s0; s < s1; s++) { const f = R.frames[s].links[L.id]; if (f) { egr += f.egr || 0; tegr += f.tegr || 0; } }
      out.nodes[L.id] = { kind: 'link', spend: egr + tegr, egress: egr, trainEgress: tegr };
      out.total += egr + tegr; out.egress += egr + tegr;
    }
    const T = R.spec.train;
    if (T && R.summary.train) {
      const spend = R.summary.train.gpuCostPerHr * out.seconds / 3600;
      out.nodes[T.id] = { kind: 'train', spend };
      out.total += spend;
    }
    out.perHour = out.seconds ? out.total * 3600 / out.seconds : NaN;
    return out;
  }
  // Where time to first token goes, node by node, for requests that arrived in [t0, t1).
  function latencyBreakdown(R, t0, t1) {
    const nodes = {}, add = (id, k, v) => { if (!id || !(v > 0)) return; const n = nodes[id] || (nodes[id] = { sec: 0, parts: {} }); n.sec += v; n.parts[k] = (n.parts[k] || 0) + v; };
    const src = {};
    let n = 0, total = 0, lo = 0, hi = R.reqs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (R.reqs[m].t < t0) lo = m + 1; else hi = m; }
    for (let i = lo; i < R.reqs.length; i++) {
      const q = R.reqs[i];
      if (q.t >= t1) break;
      if (!isFinite(q.ttft)) continue;
      n++; total += q.ttft;
      const S = src[q.src] || (src[q.src] = { n: 0, sum: 0, miss: 0, list: [] });
      S.n++; S.sum += q.ttft; S.list.push(q.ttft); if (q.ttft > R.spec.slo.ttft) S.miss++;
      add(q.pPool, 'queue', q.bQueue); add(q.pPool, 'prefill', q.bPrefill);
      if (q.dPool && q.dPool !== q.pPool) { add(q.xLink, 'transfer', q.tXferEnd - q.tPrefEnd); add(q.inLink || q.xLink, 'network', q.net); add(q.dPool, 'decode wait', q.bDwait); add(q.dPool, 'thinking', q.bThink); }
      else { add(q.inLink, 'network', q.net); add(q.pPool, 'thinking', q.bThink); }
    }
    for (const id in nodes) { nodes[id].perReq = n ? nodes[id].sec / n : 0; nodes[id].share = total ? nodes[id].sec / total : 0; }
    for (const id in src) { const S = src[id]; S.list.sort((a, b) => a - b); nodes[id] = { kind: 'source', perReq: S.sum / S.n, p99: pct(S.list, 0.99), miss: S.miss / S.n, n: S.n, share: 0 }; delete S.list; }
    return { nodes, n, meanTtft: n ? total / n : NaN };
  }
  // N-1: fail each pool, link and site in turn for the whole run and measure the damage.
  function* blastIter(spec, stressIn) {
    const base = normStress(stressIn);
    const targets = [];
    for (const p of spec.pools) targets.push({ kind: 'pool', target: p.id, id: p.id, name: p.name });
    for (const L of spec.links) targets.push({ kind: 'link', target: L.id, id: L.id, name: L.name });
    const sites = [...new Set(spec.pools.map(p => p.site))];
    if (sites.length > 1) for (const st of sites) { const ps = spec.pools.filter(p => p.site === st); if (ps.length > 1) targets.push({ kind: 'site', target: 'site:' + st, id: null, ids: ps.map(p => p.id), name: st }); }
    const total = targets.length + 1;
    yield { done: 0, total, text: 'Baseline' };
    const b = simulate(spec, base).summary;
    const rows = [];
    for (let i = 0; i < targets.length; i++) {
      const T = targets[i];
      yield { done: i + 1, total, text: 'Losing ' + T.name };
      const st = Object.assign({}, base, { outages: (base.outages || []).concat([{ target: T.target, fraction: 1, start: 0, dur: 1e9, recovery: 0 }]) });
      const s = simulate(spec, st).summary;
      const failed = Math.max(0, s.requests - s.completed); // rejected, cut off, or never served before the run ended
      rows.push(Object.assign({}, T, { slo: s.slo, dSlo: s.slo - b.slo, ttftP99: s.ttftP99, failed, failedShare: s.requests ? failed / s.requests : 0, costPerHr: s.costPerHr, bottleneck: s.bottleneck.first }));
    }
    rows.sort((a, b) => a.dSlo - b.dSlo || b.failedShare - a.failedShare);
    return { base: { slo: b.slo, ttftP99: b.ttftP99, costPerHr: b.costPerHr }, rows };
  }
  const blastRadius = (spec, st) => drain(blastIter(spec, st));

  // Turns a recorded trace into session chains for closed-loop replay.
  // Within a session, a turn that starts after the previous turn finished waits for the simulated finish plus the
  // recorded think time; a turn that overlaps it (a parallel tool call) is a branch timed from the previous turn's issue.
  // Without recorded latency, the think time is the arrival gap (the recorded fleet is assumed fast) and is flagged.
  function planSessions(rows) {
    const by = new Map(), loose = [];
    for (const x of rows) { if (x.session == null || x.session === '') { loose.push(x); continue; } if (!by.has(x.session)) by.set(x.session, []); by.get(x.session).push(x); }
    const sessions = [];
    let turns = 0, branches = 0, estimated = 0;
    const recFinish = x => (x.e2e != null ? x.t + x.e2e : x.ttft != null ? x.t + x.ttft + x.osl * 0.03 : NaN);
    for (const [id, list] of by) {
      list.sort((a, b) => a.t - b.t);
      const T = list.map(x => ({ x, next: null, gap: 0, branches: [], branchOf: null }));
      let anchor = 0;
      for (let i = 1; i < T.length; i++) {
        const prev = T[anchor].x, fin = recFinish(prev);
        if (isFinite(fin) && T[i].x.t < fin - 0.05) { T[i].branchOf = anchor; T[anchor].branches.push({ idx: i, offset: Math.max(0, T[i].x.t - prev.t) }); branches++; continue; }
        let gap;
        if (isFinite(fin)) gap = Math.max(0, T[i].x.t - fin); else { gap = Math.max(0.2, T[i].x.t - prev.t); estimated++; }
        T[anchor].next = i; T[i].gap = gap; anchor = i;
      }
      turns += T.length;
      sessions.push({ id: String(id), turns: T });
    }
    return { sessions, loose, turns, branches, estimated };
  }

  // Potential issues found before running: misconfigurations and risks visible from the graph and traffic alone.
  function lintSpec(spec) {
    const out = [], P = {}, m = spec.model;
    if (!m) return out;
    for (const p of spec.pools) P[p.id] = profile(p.gpu, m);
    // rough traffic estimate: requests/s and token sizes per router
    const est = {};
    for (const S of spec.sources) {
      let rate = 0, peak = 0, isl = 0, osl = 0, maxCtx = 0, uncached = 0;
      if (S.kind === 'open') {
        const tr = S.trace || [];
        const dur = tr.length ? Math.max(60, tr[tr.length - 1].t) : 1;
        rate = tr.length / dur;
        for (let i = 0, j = 0; i < tr.length; i++) { while (tr[i].t - tr[j].t > 10) j++; peak = Math.max(peak, (i - j + 1) / 10); }
        for (const x of tr) { isl += x.isl; osl += x.osl; maxCtx = Math.max(maxCtx, x.isl + x.osl); uncached += x.isl - (S.useRecordedCache && x.cached != null ? x.cached : x.isl * S.prefixHit); }
        if (tr.length) { isl /= tr.length; osl /= tr.length; uncached /= tr.length; }
      } else {
        const ctx = S.systemTokens + S.contextTokens + S.turnTokens * S.turns / 2;
        isl = ctx; osl = S.outTokens; uncached = ctx * (1 - S.prefixHit) + S.turnTokens * S.prefixHit;
        maxCtx = Math.min(128000, (S.systemTokens + S.contextTokens * 1.4 + S.turnTokens * S.turns * 2.5 + S.outTokens * S.turns) * 1.0);
        rate = S.users / (S.thinkS + 4); peak = rate;
      }
      const e = est[S.router] || (est[S.router] = { rate: 0, peak: 0, isl: 0, osl: 0, uncached: 0, maxCtx: 0 });
      e.peak += Math.max(peak, rate);
      const w = e.rate + rate;
      if (w > 0) { e.isl = (e.isl * e.rate + isl * rate) / w; e.osl = (e.osl * e.rate + osl * rate) / w; e.uncached = (e.uncached * e.rate + uncached * rate) / w; }
      e.rate = w; e.maxCtx = Math.max(e.maxCtx, maxCtx);
    }
    const name = id => { const p = spec.pools.find(x => x.id === id); return p ? p.name : id; };
    const fmtK = v => (v >= 1e4 ? Math.round(v / 1e3) + 'k' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v)));
    for (const R of spec.routers) {
      const e = est[R.id];
      if (R.targets.length === 1) out.push({ node: R.targets[0].pool, level: 'info', kind: 'spof', msg: name(R.targets[0].pool) + ' is the only pool behind ' + R.name + ': if it fails, its traffic has nowhere to go.', fix: 'Add a second pool or site behind the router.' });
      for (const x of R.targets) {
        const p = spec.pools.find(q => q.id === x.pool), pr = P[x.pool];
        if (!p || !e) continue;
        if (e.maxCtx + (m.thinkTokens || 0) > pr.kvCap && p.role !== 'prefill') out.push({ node: p.id, level: 'warn', kind: 'kv', msg: 'Longest contexts (~' + fmtK(e.maxCtx) + ' tokens) exceed ' + p.name + '\u2019s KV cache per instance (' + fmtK(pr.kvCap) + '): those requests will be rejected.', fix: 'Use more GPUs per instance, a GPU with more memory, FP8 KV cache, or cap context.' });
        if (p.auto && p.min === 0 && p.coldStart >= 60 && R.policy === 'primary-first' && x !== R.targets[0]) out.push({ node: p.id, level: 'warn', kind: 'cold', msg: p.name + ' starts empty and needs ' + p.coldStart + ' s to come up: bursts shorter than that end before its capacity arrives.', fix: 'Keep at least one instance warm (min ≥ 1) or cut the cold start.' });
      }
      if (e && R.targets.length) {
        // prefill demand against front-pool capacity
        let cap = 0;
        for (const x of R.targets) { const p = spec.pools.find(q => q.id === x.pool); if (p) cap += (p.max || p.min) * P[p.id].prefill * (p.role === 'agg' ? 0.6 : 1); }
        const need = e.peak * e.uncached;
        if (cap > 0 && need > 0.8 * cap) out.push({ node: R.targets[0].pool, level: 'warn', kind: 'prefill', msg: 'At peak, traffic needs about ' + fmtK(need) + ' prefill tokens/s but the pools behind ' + R.name + ' manage about ' + fmtK(cap) + ' at full size.', fix: 'Add instances or prefill capacity, or raise prefix-cache hits.' });
      }
    }
    for (const p of spec.pools) {
      const pr = P[p.id];
      if (pr.multiNode) out.push({ node: p.id, level: 'warn', kind: 'multinode', msg: p.name + ': the model needs more than 8 GPUs per instance on ' + p.gpu + ', so every instance spans nodes.', fix: 'Use a GPU with more memory or FP8 weights.' });
      if (pr.kvCap < 20000) out.push({ node: p.id, level: 'warn', kind: 'kvsmall', msg: p.name + ' keeps only ' + fmtK(pr.kvCap) + ' tokens of KV cache per instance after weights.', fix: 'Use more GPUs per instance or a larger GPU.' });
      for (const d of p.decode || []) {
        if (!d.link) continue;
        const L = spec.links.find(l => l.id === d.link);
        const e = Object.values(est).reduce((a, b) => (b.peak > a.peak ? b : a), { peak: 0, isl: 0 });
        const demand = e.peak * e.isl * pr.kvBytesPerToken * 8 / 1e9;
        if (L && demand > 0.7 * L.gbps) out.push({ node: L.id, level: 'warn', kind: 'link', msg: 'At peak, KV caches from ' + p.name + ' need about ' + Math.round(demand) + ' Gbps across ' + L.name + ' (' + L.gbps + ' Gbps).', fix: 'Raise link bandwidth, keep prefill and decode in one site, or cut prompt sizes.' });
      }
    }
    if (spec.train && spec.train.link && spec.pools.some(p => (p.decode || []).some(d => d.link === spec.train.link))) out.push({ node: spec.train.link, level: 'warn', kind: 'contention', msg: 'The training job\u2019s gradient sync shares a link with serving KV transfers.', fix: 'Give training its own link or keep the job in one site.' });
    return out;
  }

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

  // Attributes each second where more than 10% of first tokens missed the TTFT target to the most likely cause.
  const CAUSE = {
    down: { rank: 6, label: 'instances down (outage)' }, linkdown: { rank: 5, label: 'link degraded (outage)' },
    link: { rank: 4, label: 'link saturated' }, kv: { rank: 3, label: 'KV cache full' },
    compute: { rank: 2, label: 'compute saturated' }, cold: { rank: 1, label: 'waiting on cold starts' }, queue: { rank: 0, label: 'queueing' },
    tpot: { rank: -1, label: 'decode batches too large (slow tokens)' }
  };
  // Seconds where TPOT breaches dominate are put down to the pool decoding the largest batches.
  function findBottleneck(frames, pools, links, viol, firsts, slo, tviol, fins) {
    const tally = {}, blame = new Array(frames.length).fill(null);
    let first = null, breach = 0;
    for (let s = 0; s < frames.length; s++) {
      const ttftBreach = firsts[s] && viol[s] / firsts[s] > 0.1;
      const tpotBreach = tviol && fins[s] && tviol[s] / fins[s] > 0.1;
      if (!ttftBreach && !tpotBreach) continue;
      breach++;
      const fr = frames[s];
      let best = null;
      if (!ttftBreach) {
        for (const p of pools) { const f = fr.pools[p.id]; if (f && f.batch > 0 && (!best || f.batch > best.weight)) best = { kind: 'tpot', id: p.id, name: p.name || p.id, rank: -1, weight: f.batch }; }
        if (best) {
          blame[s] = { kind: best.kind, id: best.id };
          const key = best.kind + '|' + best.id;
          (tally[key] = tally[key] || { kind: best.kind, id: best.id, name: best.name, label: CAUSE.tpot.label, seconds: 0, first: s }).seconds++;
          if (!first) first = { t: s, kind: best.kind, id: best.id, name: best.name, label: CAUSE.tpot.label };
        }
        continue;
      }
      const consider = (kind, id, name, weight) => {
        const c = { kind, id, name, rank: CAUSE[kind].rank, weight };
        if (!best || c.rank > best.rank || (c.rank === best.rank && c.weight > best.weight)) best = c;
      };
      for (const p of pools) {
        const f = fr.pools[p.id];
        if (!f) continue;
        const nm = p.name || p.id;
        if (f.down > 0) consider('down', p.id, nm, f.q);
        if (f.kv >= 0.95 && f.q > 0) consider('kv', p.id, nm, f.q);
        if (f.util >= 0.9 && f.q > 0) consider('compute', p.id, nm, f.q);
        if (f.starting > 0 && f.q > 0) consider('cold', p.id, nm, f.q);
        if (f.q > 0 && f.head > slo.ttft / 2) consider('queue', p.id, nm, f.q);
      }
      for (const L of links) {
        const f = fr.links[L.id];
        if (!f || L.fabric && f.util < 0.9) continue;
        if (f.factor < 1) consider('linkdown', L.id, L.name, f.xfers);
        else if (f.util >= 0.9) consider('link', L.id, L.name, f.xfers);
      }
      if (!best) continue;
      blame[s] = { kind: best.kind, id: best.id };
      const key = best.kind + '|' + best.id;
      (tally[key] = tally[key] || { kind: best.kind, id: best.id, name: best.name, label: CAUSE[best.kind].label, seconds: 0, first: s }).seconds++;
      if (!first) first = { t: s, kind: best.kind, id: best.id, name: best.name, label: CAUSE[best.kind].label };
    }
    const top = Object.values(tally).sort((a, b) => b.seconds - a.seconds);
    return { breachSeconds: breach, first, top, blame };
  }

  // Health of every node, second by second: 0 healthy, 1 strained, 2 failing, with the cause.
  // The node blamed for an SLO breach in a second is always marked failing with the breach cause.
  const HEALTH_LABEL = { down: 'instances down', linkdown: 'link degraded', link: 'link saturated', kv: 'KV cache full', compute: 'compute saturated', cold: 'waiting on cold starts', queue: 'requests queueing', tpot: 'slow tokens', slo: 'missing the latency target', sync: 'waiting on gradient sync', upstream: 'a pool behind it is struggling' };
  function healthOf(R) {
    const D = R.D, spec = R.spec, slo = spec.slo, lvl = {}, cause = {}, sum = {};
    const mk = id => { lvl[id] = new Uint8Array(D); cause[id] = new Array(D).fill(null); };
    const set = (id, s, l, c) => { if (l > lvl[id][s]) { lvl[id][s] = l; cause[id][s] = c; } };
    for (const p of spec.pools) mk(p.id);
    for (const L of spec.links) mk(L.id);
    for (const r of spec.routers) mk(r.id);
    for (const S of spec.sources) mk(S.id);
    if (spec.train) mk(spec.train.id);
    const blame = (R.summary.bottleneck && R.summary.bottleneck.blame) || [];
    for (let s = 0; s < D; s++) {
      const fr = R.frames[s];
      for (const p of spec.pools) {
        const f = fr.pools[p.id];
        if (!f) continue;
        if (f.down > 0) set(p.id, s, 2, 'down');
        if (f.kv >= 0.95 && f.q > 0) set(p.id, s, 2, 'kv');
        if (f.q > 0 && f.head > slo.ttft) set(p.id, s, 2, f.util >= 0.9 ? 'compute' : 'queue');
        if (f.starting > 0 && f.q > 0) set(p.id, s, 1, 'cold');
        if (f.util >= 0.85) set(p.id, s, 1, 'compute');
        if (f.kv >= 0.85) set(p.id, s, 1, 'kv');
        if (f.q > 0 && f.head > slo.ttft / 3) set(p.id, s, 1, 'queue');
      }
      for (const L of spec.links) {
        const f = fr.links[L.id];
        if (!f) continue;
        if (f.factor < 1) set(L.id, s, 2, 'linkdown');
        else if (f.util >= 0.9) set(L.id, s, 2, 'link');
        else if (f.util >= 0.7) set(L.id, s, 1, 'link');
      }
      const b = blame[s];
      if (b && lvl[b.id]) { lvl[b.id][s] = 2; cause[b.id][s] = b.kind; }
      for (const r of spec.routers) {
        let w = 0;
        for (const x of r.targets) { w = Math.max(w, lvl[x.pool][s]); if (x.link) w = Math.max(w, lvl[x.link][s]); }
        if (w) set(r.id, s, w === 2 ? 1 : 0, 'upstream');
      }
      if (spec.train && spec.train.link && fr.train && fr.train.syncing && lvl[spec.train.link][s]) set(spec.train.id, s, lvl[spec.train.link][s], 'sync');
    }
    // traffic sources: share of their first tokens that missed TTFT in each second
    const firsts = {}, miss = {};
    for (const q of R.reqs) {
      if (!isFinite(q.tFirst) || !lvl[q.src]) continue;
      const s = Math.floor(q.tFirst); if (s >= D) continue;
      (firsts[q.src] || (firsts[q.src] = new Uint16Array(D)))[s]++;
      if (q.tFirst - q.t > slo.ttft) (miss[q.src] || (miss[q.src] = new Uint16Array(D)))[s]++;
    }
    for (const id in firsts) for (let s = 0; s < D; s++) { const f = firsts[id][s], m = miss[id] ? miss[id][s] : 0; if (f && m / f > 0.1) set(id, s, 2, 'slo'); else if (f && m / f > 0.02) set(id, s, 1, 'slo'); }
    for (const id in lvl) {
      const a = lvl[id], cnt = {}; let warn = 0, crit = 0;
      for (let s = 0; s < D; s++) { if (a[s] === 1) warn++; else if (a[s] === 2) crit++; if (a[s]) cnt[cause[id][s]] = (cnt[cause[id][s]] || 0) + (a[s] === 2 ? 3 : 1); }
      const top = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0] || null;
      sum[id] = { warn, crit, cause: top, level: crit >= Math.max(3, D * 0.01) ? 2 : warn + crit >= Math.max(5, D * 0.02) ? 1 : 0 };
    }
    return { lvl, cause, sum };
  }

  const drain = it => { let x; do x = it.next(); while (!x.done); return x.value; };
  const clone = o => JSON.parse(JSON.stringify(o));

  // Raises one stress dimension until SLO attainment drops below the target. Yields after every run.
  // kind: 'load' (surge on all traffic for the whole run), 'users' (sessions only) or 'ctx' (context multiplier).
  function* headroomIter(spec, opts) {
    const o = Object.assign({ kind: 'load', target: 0.99, lo: 1, hi: 8, iters: 6, base: null }, opts);
    const mk = mult => {
      const st = clone(o.base || {});
      if (o.kind === 'ctx') st.ctx = { mult, add: 0 };
      else st.surge = { mult, start: 0, dur: 0, target: o.kind === 'users' ? 'sessions' : 'all' };
      return st;
    };
    const runs = [];
    const total = 2 + o.iters;
    function* run(mult) {
      const s = simulate(spec, mk(mult)).summary;
      const rec = { mult, slo: s.slo, ttftP99: s.ttftP99, peakGpus: s.peakGpus, costPerHr: s.costPerHr, rejected: s.rejected, bottleneck: s.bottleneck.first };
      runs.push(rec);
      yield { done: runs.length, total, last: rec };
      return rec;
    }
    const base = yield* run(o.lo);
    if (!(base.slo >= o.target)) return { kind: o.kind, target: o.target, limit: null, belowAtStart: true, breaksOn: base.bottleneck, runs };
    let lo = o.lo, hi = o.hi;
    const top = yield* run(hi);
    if (top.slo >= o.target) return { kind: o.kind, target: o.target, limit: hi, beyondRange: true, runs };
    for (let i = 0; i < o.iters; i++) {
      const mid = Math.round(((lo + hi) / 2) * 100) / 100;
      if (mid <= lo || mid >= hi) break;
      if ((yield* run(mid)).slo >= o.target) lo = mid; else hi = mid;
    }
    const fail = runs.find(r => r.mult === hi);
    return { kind: o.kind, target: o.target, limit: lo, failsAt: hi, breaksOn: fail ? fail.bottleneck : null, runs: runs.sort((a, b) => a.mult - b.mult) };
  }
  const findHeadroom = (spec, opts) => drain(headroomIter(spec, opts));

  // Scales every pool's instance counts by a factor (fixed size, min and max) and returns a new spec.
  function scaleFleet(spec, f) {
    const s2 = clone(spec);
    for (const p of s2.pools) {
      const fixed = p.min === p.max;
      if (fixed) { p.min = p.max = Math.max(1, Math.round(p.min * f)); }
      else { p.min = Math.round(p.min * f); p.max = Math.max(1, p.min, Math.round(p.max * f)); }
    }
    return s2;
  }
  // Smallest fleet scale (0.125x to 8x of the drawn graph) that meets the SLO target. Yields after every run.
  function* sizeFleetIter(spec, opts) {
    const o = Object.assign({ target: 0.99, stress: null, iters: 6, lo: 0.125, hi: 8 }, opts);
    const runs = [];
    function* run(f) {
      const r = simulate(scaleFleet(spec, f), o.stress);
      const s = r.summary;
      const rec = { factor: f, slo: s.slo, ttftP99: s.ttftP99, tpotP99: s.tpotP99, peakGpus: s.peakGpus, costPerHr: s.costPerHr, costPerMTok: s.costPerMTok, costPerKReq: s.costPerKReq, rejected: s.rejected, thinkShare: s.thinkShare, requests: s.requests, bottleneck: s.bottleneck.first };
      runs.push(rec);
      yield rec;
      return rec;
    }
    let hiRec = yield* run(o.hi);
    if (!(hiRec.slo >= o.target)) return { meets: false, at: hiRec, runs };
    let lo = o.lo, hi = o.hi;
    const loRec = yield* run(lo);
    if (loRec.slo >= o.target) return { meets: true, at: loRec, runs };
    for (let i = 0; i < o.iters; i++) {
      const mid = Math.sqrt(lo * hi);
      const rec = yield* run(mid);
      if (rec.slo >= o.target) { hi = mid; hiRec = rec; } else lo = mid;
    }
    return { meets: true, at: hiRec, runs };
  }
  const sizeFleet = (spec, opts) => drain(sizeFleetIter(spec, opts));

  // Model advisor: for each candidate model and reasoning level, right-size the drawn fleet so this traffic
  // meets the SLO, then rank by cost. candidates: [{ key, thinkTokens }]; quality: optional { key: score }.
  function* adviseIter(spec, opts) {
    const o = Object.assign({ target: 0.99, stress: null, candidates: [], quality: {}, minQuality: null, iters: 5 }, opts);
    const rows = [];
    let step = 0;
    const total = o.candidates.length * (o.iters + 2);
    for (const c of o.candidates) {
      const base = MODELS[c.key];
      if (!base) continue;
      const s2 = clone(spec);
      s2.model = Object.assign({}, spec.model, base, { key: c.key, thinkTokens: c.thinkTokens || 0 });
      const prof = profile((s2.pools[0] || {}).gpu || 'H100', s2.model);
      const it = sizeFleetIter(s2, { target: o.target, stress: o.stress, iters: o.iters });
      let x;
      while (!(x = it.next()).done) { step++; yield { done: step, total, model: base.label, thinkTokens: c.thinkTokens || 0 }; }
      const res = x.value;
      const q = o.quality[c.key];
      rows.push({ key: c.key, label: base.label, thinkTokens: c.thinkTokens || 0, tp: prof.tp, kvCap: prof.kvCap, meets: res.meets,
        factor: res.at.factor, peakGpus: res.at.peakGpus, costPerHr: res.at.costPerHr, costPerMTok: res.at.costPerMTok, costPerKReq: res.at.costPerKReq,
        slo: res.at.slo, ttftP99: res.at.ttftP99, tpotP99: res.at.tpotP99, rejected: res.at.rejected, thinkShare: res.at.thinkShare, bottleneck: res.at.bottleneck,
        quality: q == null || q === '' ? null : +q, belowQuality: o.minQuality != null && q != null && q !== '' && +q < o.minQuality });
    }
    const ok = rows.filter(r => r.meets && !r.belowQuality).sort((a, b) => a.costPerKReq - b.costPerKReq);
    const rest = rows.filter(r => !ok.includes(r)).sort((a, b) => (b.meets - a.meets) || (a.costPerKReq - b.costPerKReq));
    const ranked = ok.concat(rest);
    if (ok.length) ok[0].pick = true;
    return { target: o.target, rows: ranked, pick: ok[0] || null };
  }
  const adviseModels = (spec, opts) => drain(adviseIter(spec, opts));

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
    const spec = { seed: 7, model: modelN ? Object.assign({}, modelN.cfg) : null, slo: sloN ? { ttft: sloN.cfg.ttft, tpot: sloN.cfg.tpotMs / 1000, thinkingStreamed: !!sloN.cfg.thinkingStreamed } : { ttft: 2, tpot: 0.06, thinkingStreamed: false },
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
      const s = { id: n.id, name: c.name, kind: n.type === 'trace' ? 'open' : n.type, router: e.to, edge: e.id, prefixHit: c.prefixHit / 100, useRecordedCache: c.useRecordedCache !== false, userBase: uidBase,
        replay: c.replay === 'sessions' ? 'sessions' : 'timestamps', onFail: c.onFail === 'giveup' ? 'giveup' : 'retry' };
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
  // A stress overlay changes a run without editing the graph:
  // { name, surge: { mult, start, dur, target: 'all' | 'sessions' | 'traces' },
  //   ctx: { mult, add }, outages: [{ target: poolId | linkId | 'site:<name>', fraction, start, dur, recovery }] }
  // dur 0 means the whole run. recovery = seconds for failed instances to serve again after the window.
  function normStress(st) {
    st = st || {};
    const surge = st.surge && st.surge.mult && st.surge.mult !== 1 ? Object.assign({ start: 0, dur: 0, target: 'all' }, st.surge) : null;
    const ctx = st.ctx && ((st.ctx.mult && st.ctx.mult !== 1) || st.ctx.add) ? Object.assign({ mult: 1, add: 0 }, st.ctx) : null;
    const outages = (st.outages || []).filter(o => o && o.target && o.fraction > 0).map(o => Object.assign({ start: 0, dur: 0, recovery: 60 }, o));
    return { name: st.name || '', surge, ctx, outages, active: !!(surge || ctx || outages.length) };
  }
  const inWin = (t, w) => t >= w.start && (!w.dur || t < w.start + w.dur);

  function simulate(spec, stressIn) {
    const T0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const stress = normStress(stressIn);
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
      Object.assign(p, { inst: [], q: new Q(), qTokens: 0, lastUp: -1e9, utilHist: [], nextId: 0, tokSec: 0, spillFrom: [], down: 0, capLoss: 0 });
      pools.push(p); byId[p.id] = p;
      for (let i = 0; i < p.min; i++) addInst(p, 0, true);
    }
    const links = {};
    function addLink(id, name, gbps, rtt, egress, fabric, site) {
      links[id] = { id, name, gbps, bps0: gbps * 1e9 / 8, bps: gbps * 1e9 / 8, factor: 1, rtt, egress, fabric, site, xfers: [], bytesSec: 0, trainSec: 0, totalBytes: 0, trainBytes: 0, egressBytes: 0, egrSec: 0 };
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
    // A target behind a link that is down, or with no serving instance, is skipped while any other target can serve.
    const targetWait = x => (x.link && links[x.link].factor <= 0 ? Infinity : estWait(x.P));
    function route(R) {
      const T = R.targets;
      if (T.length === 1) return T[0];
      if (R.policy === 'round-robin') { const o = T.filter(x => isFinite(targetWait(x))); const pick = o.length ? o : [T[0]]; return pick[(R.rr++) % pick.length]; }
      let best = T[0], bw = targetWait(T[0]);
      if (R.policy === 'primary-first' && bw <= R.burstWait) return T[0];
      for (const x of T.slice(1)) { const w = targetWait(x); if (w < bw) { bw = w; best = x; } }
      return best;
    }

    // ----- workload -----
    const reqs = [];
    const future = new Heap();
    const rng = makeRng(((spec.seed || 7) * 2654435761) >>> 0);
    // Reasoning models decode hidden thinking tokens before the first visible token.
    const thinkMed = Math.max(0, +(m.thinkTokens || 0));
    // When thinking is streamed to the user, the first thinking token counts as the first token.
    const streamThink = !!(spec.slo && spec.slo.thinkingStreamed);
    const trng = makeRng(((spec.seed || 7) * 7919 + 101) >>> 0);
    function mkReq(src, t, isl, osl, cached, user) {
      const think = thinkMed > 0 ? clamp(Math.round(trng.logn(thinkMed, 0.6)), 16, 64000) : 0;
      const r = { id: reqs.length, src: src.id, router: src.router, t, isl, osl, think, dec: think + osl, tTok1: NaN, cached: Math.max(0, Math.min(cached, isl - 1)), user,
        site: '', pPool: '', dPool: '', inLink: '', net: 0, tEnq: NaN, tAdmit: NaN, tPrefEnd: NaN, tXferStart: NaN, tXferEnd: NaN, tFirst: NaN, tFinish: NaN,
        gen: 0, preRem: 0, kvRes: 0, xLink: '', fail: '', recTtft: NaN, recQueue: NaN, recE2e: NaN };
      reqs.push(r);
      return r;
    }
    let horizon = spec.horizon || 0;
    const replayStats = { sources: 0, sessions: 0, turns: 0, branches: 0, estimated: 0, abandoned: 0, retried: 0, drift: [] };
    const users = [];
    let surgeBase = spec.sources.reduce((m, S) => Math.max(m, (S.userBase || 0) + (S.users || 0)), 0) + 100000;
    const srcById = {};
    for (const S of spec.sources) {
      srcById[S.id] = S;
      if (S.kind === 'open') {
        const sg = stress.surge && stress.surge.target !== 'sessions' ? stress.surge : null;
        const srng = makeRng(((spec.seed || 7) * 977 + 13) >>> 0);
        let openRows = S.trace;
        if (S.replay === 'sessions') {
          const plan = planSessions(S.trace);
          openRows = plan.loose;
          replayStats.sources++;
          replayStats.sessions += plan.sessions.length; replayStats.turns += plan.turns; replayStats.branches += plan.branches; replayStats.estimated += plan.estimated;
          for (const ses of plan.sessions) {
            const copies = sg && inWin(ses.turns[0].x.t, sg) ? (() => { let e = Math.floor(sg.mult - 1); if (srng.u() < sg.mult - 1 - e) e++; return 1 + e; })() : 1;
            for (let c = 0; c < copies; c++) {
              const run = { S, ses, issued: [], done: 0, ended: false, clone: c > 0, offset: c ? srng.u() * 0.5 : 0 };
              future.push({ t: ses.turns[0].x.t + run.offset, replayTurn: { run, idx: 0 } });
            }
          }
          horizon = Math.max(horizon, S.trace.length ? S.trace[S.trace.length - 1].t : 0);
        }
        for (const x of openRows) {
          let isl = x.isl, cachedIn = S.useRecordedCache && x.cached != null ? x.cached : Math.round(x.isl * S.prefixHit);
          if (stress.ctx) { isl = Math.min(200000, Math.round(x.isl * stress.ctx.mult + stress.ctx.add)); cachedIn = Math.round(cachedIn * stress.ctx.mult); }
          const r = mkReq(S, x.t, isl, x.osl, cachedIn, -1);
          if (!stress.ctx) {
            if (x.ttft != null) r.recTtft = x.ttft;
            if (x.queue != null) r.recQueue = x.queue;
            if (x.e2e != null) r.recE2e = x.e2e;
          }
          future.push(r);
          if (sg && inWin(x.t, sg)) {
            // Surge: extra copies of requests inside the window (copies carry no recorded latency).
            let extra = Math.floor(sg.mult - 1);
            if (srng.u() < sg.mult - 1 - extra) extra++;
            for (let k = 0; k < extra; k++) { const c = mkReq(S, x.t + srng.u() * 0.5, isl, x.osl, cachedIn, -1); c.surge = true; future.push(c); }
          }
        }
        horizon = Math.max(horizon, S.trace.length ? S.trace[S.trace.length - 1].t : 0);
      } else {
        horizon = Math.max(horizon, S.duration);
        const ramp = Math.min(120, S.duration / 4);
        for (let u = 0; u < S.users; u++) {
          const st = { id: S.userBase + u, src: S, ctx: 0, turns: 0, until: S.duration };
          users[st.id] = st;
          future.push({ t: rng.u() * ramp, user: st.id, fresh: true, pending: true });
        }
        const sg = stress.surge && stress.surge.target !== 'traces' ? stress.surge : null;
        if (sg && sg.mult > 1) {
          // Surge: extra users join over the first part of the window and stop starting turns when it ends.
          const n = Math.round(S.users * (sg.mult - 1));
          const until = sg.dur ? Math.min(S.duration, sg.start + sg.dur) : S.duration;
          const join = sg.dur ? Math.min(30, sg.dur / 4) : ramp;
          for (let u = 0; u < n; u++) {
            const st = { id: surgeBase + u, src: S, ctx: 0, turns: 0, until, surge: true };
            users[st.id] = st;
            future.push({ t: sg.start + rng.u() * join, user: st.id, fresh: true, pending: true });
          }
          surgeBase += n;
        }
      }
    }
    const maxCtx = 128000;
    function newSession(st) {
      const S = st.src;
      st.ctx = Math.round(S.systemTokens + (S.kind === 'agent' ? S.contextTokens * (0.6 + 0.8 * rng.u()) : 0));
      if (stress.ctx) st.ctx = Math.min(maxCtx - 1024, Math.round(st.ctx * stress.ctx.mult + stress.ctx.add));
      st.turns = Math.max(1, Math.round(rng.logn(S.turns, 0.45)));
    }
    function issue(st, t) {
      const S = st.src;
      const add = Math.max(16, Math.round(rng.logn(S.turnTokens, 0.8) * (stress.ctx ? stress.ctx.mult : 1)));
      const isl = Math.min(maxCtx - 512, st.ctx + add);
      const osl = clamp(Math.round(rng.logn(S.outTokens, 0.7)), 4, 8192);
      const r = mkReq(S, t, isl, osl, Math.round(Math.min(st.ctx, isl) * S.prefixHit), st.id);
      if (st.surge) r.surge = true;
      return r;
    }
    function after(uid, isl, osl, t) {
      const st = users[uid];
      st.ctx = isl + osl + (m.thinkKeep ? (users[uid].lastThink || 0) : 0);
      if (st.ctx > maxCtx * 0.8) st.ctx = Math.round(st.ctx * 0.3);
      st.turns--;
      const next = st.turns > 0 ? t + Math.max(0.2, rng.logn(st.src.thinkS, 0.5)) : t + Math.max(1, rng.logn(st.src.gapS, 0.6));
      if (next < st.until) future.push({ t: next, user: uid, fresh: st.turns <= 0, pending: true });
    }

    // ----- closed-loop replay of recorded sessions -----
    function replayReq(item, t) {
      const { run, idx } = item, x = run.ses.turns[idx].x, S = run.S;
      let isl = x.isl, cached = S.useRecordedCache && x.cached != null ? x.cached : Math.round(x.isl * S.prefixHit);
      if (stress.ctx) { isl = Math.min(200000, Math.round(x.isl * stress.ctx.mult + stress.ctx.add)); cached = Math.round(cached * stress.ctx.mult); }
      const r = mkReq(S, t, isl, x.osl, cached, -1);
      r.sess = run; r.turn = idx; r.retryOf = item.retry ? 1 : 0;
      if (!stress.ctx && !run.clone && !item.retry) { if (x.ttft != null) r.recTtft = x.ttft; if (x.queue != null) r.recQueue = x.queue; if (x.e2e != null) r.recE2e = x.e2e; }
      if (run.clone) r.surge = true;
      if (!item.retry) {
        run.issued[idx] = t;
        if (!run.clone) replayStats.drift.push(t - x.t);
        // Parallel tool calls recorded inside this turn's window start relative to this issue.
        for (const b of run.ses.turns[idx].branches) future.push({ t: t + b.offset, replayTurn: { run, idx: b.idx } });
      }
      return r;
    }
    function sessionTurnDone(r, t, ok) {
      const run = r.sess;
      if (!ok && run.S.onFail === 'retry' && !r.retryOf) { replayStats.retried++; future.push({ t: t + 5, replayTurn: { run, idx: r.turn, retry: true } }); return; }
      if (!ok && run.S.onFail === 'giveup') { if (!run.ended) { run.ended = true; replayStats.abandoned += run.ses.turns.filter((tn, i) => i > r.turn && !tn.branchOf).length; } return; }
      if (run.ended) return;
      const nx = run.ses.turns[r.turn].next;
      if (nx != null) future.push({ t: t + run.ses.turns[nx].gap, replayTurn: { run, idx: nx } });
    }
    function enq(p, r, t) {
      if (p.role === 'decode') { r.tXferEnd = t; r.dPool = p.id; } else r.tEnq = t;
      r._t = t;
      p.q.push(r);
      if (p.role !== 'decode') p.qTokens += Math.max(1, r.isl - r.cached);
    }
    let doneCount = 0, outTokens = 0, genTokens = 0;
    function finish(r, t) {
      r.tFinish = t; doneCount++; outTokens += r.osl; genTokens += r.dec;
      if (r.sess) sessionTurnDone(r, t, true);
      const dp = byId[r.dPool];
      if (dp && dp.siteKind === 'neo') { const L = links[r.inLink] || links[r.xLink]; if (L && !L.fabric) { L.egressBytes += r.osl * 4; L.egrSec += r.osl * 4; L.totalBytes += r.osl * 4; } }
      if (r.user >= 0) after(r.user, r.isl, r.osl, t);
    }
    const failCounts = { kv: 0, outage: 0, route: 0 };
    function failReq(r, t, why, kind) {
      r.fail = why; r.failKind = kind || 'kv'; failCounts[r.failKind]++; dropped++; doneCount++;
      if (r.sess) sessionTurnDone(r, t, false);
      if (r.user >= 0) { users[r.user].turns = 1; after(r.user, 0, 0, t + 5); }
    }
    function pickDecode(p) {
      let best = null, bs = Infinity;
      for (const d of p.decode) {
        const D = byId[d.pool];
        const s = servingCount(D) + D.inst.filter(x => x.state === 'starting').length * 0.3;
        const score = (d.link && links[d.link].factor <= 0 ? 1e6 : 0) + (D.q.length + 1) / Math.max(0.3, s) + (d.link ? 0.5 : 0);
        if (score < bs) { bs = score; best = d; }
      }
      return best;
    }
    function onPrefillDone(p, x, r, t) {
      if (p.role === 'agg') {
        r.tTok1 = t; if (!r.think || streamThink) r.tFirst = t; r.gen = 1; r.dPool = p.id; x.ctxTok += r.isl + 1;
        if (r.dec <= 1) { x.kvUsed -= r.kvRes; x.ctxTok -= r.isl + 1; finish(r, t); } else x.batch.push(r);
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
        if (p.role !== 'prefill' && r.isl + r.dec > p.P.kvCap) { p.q.shift(); if (p.role !== 'decode') p.qTokens -= Math.max(1, r.isl - r.cached); failReq(r, t, 'Context does not fit in one instance’s KV cache', 'kv'); continue; }
        let best = null, bl = Infinity;
        for (const x of cand) {
          let l;
          if (p.role === 'prefill') { if (x.pre.length >= 16) continue; l = x.preTok; }
          else {
            const load = x.batch.length + x.pre.length;
            if (load >= p.maxBatch) continue;
            if (x.kvUsed + r.isl + r.dec > x.kvCap) continue;
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
          if (p.role === 'agg') { r.kvRes = r.isl + r.dec; best.kvUsed += r.kvRes; }
        } else {
          r.tTok1 = t; if (!r.think || streamThink) r.tFirst = t; r.gen = 1; r.kvRes = r.isl + r.dec; best.kvUsed += r.kvRes; best.ctxTok += r.isl + 1;
          if (r.dec <= 1) { best.kvUsed -= r.kvRes; best.ctxTok -= r.isl + 1; finish(r, t); } else best.batch.push(r);
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
            if (r.think && !isFinite(r.tFirst) && r.gen >= r.think + 1) r.tFirst = tEnd;
            if (r.gen >= r.dec) { x.kvUsed -= r.kvRes; x.ctxTok -= r.isl + r.gen; finish(r, tEnd); }
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
        if (up && live.length < p.max - p.capLoss) { addInst(p, t, false); p.lastUp = t; continue; }
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

    // ----- outages -----
    const outs = stress.outages.map(o => {
      const tg = o.target.startsWith('site:') ? { site: o.target.slice(5) } : byId[o.target] ? { pool: byId[o.target] } : links[o.target] ? { link: links[o.target] } : null;
      return Object.assign({}, o, tg, { begun: false, ended: false, failed: [] });
    }).filter(o => o.site != null || o.pool || o.link);
    let retried = 0;
    function failInstances(p, n, t, o) {
      const cands = p.inst.filter(x => x.state !== 'draining').sort((a, b) => a.id - b.id).slice(0, n);
      for (const x of cands) {
        // Prefilling requests are re-queued (no token has streamed yet); decoding ones lose their stream.
        for (const r of x.pre) {
          if (p.role === 'agg') x.kvUsed -= r.kvRes;
          r.tAdmit = NaN; r.retries = (r.retries || 0) + 1; retried++;
          p.q.push(r); p.qTokens += Math.max(1, r.isl - r.cached);
        }
        for (const r of x.batch) failReq(r, t, 'Stream lost: its instance failed during the outage', 'outage');
        x.pre = []; x.batch = []; x.preTok = 0; x.kvUsed = 0; x.ctxTok = 0;
      }
      p.inst = p.inst.filter(x => !cands.includes(x));
      p.down += cands.length;
      o.failed.push({ p, n: cands.length });
    }
    function applyOutages(t) {
      for (const o of outs) {
        if (!o.begun && t >= o.start) {
          o.begun = true;
          const ps = o.pool ? [o.pool] : o.site != null ? pools.filter(p => p.site === o.site) : [];
          for (const p of ps) {
            const n = Math.round(o.fraction * p.inst.filter(x => x.state !== 'draining').length);
            p.capLoss += Math.round(o.fraction * p.max);
            if (n > 0) failInstances(p, n, t, o);
            o.capLosses = (o.capLosses || []).concat([{ p, n: Math.round(o.fraction * p.max) }]);
          }
          if (o.link) { o.link.factor = Math.max(0, 1 - o.fraction); o.link.bps = o.link.bps0 * o.link.factor; }
        }
        if (o.begun && !o.ended && o.dur && t >= o.start + o.dur) {
          o.ended = true;
          for (const f of o.failed) {
            f.p.down -= f.n;
            // Fixed pools get their instances back after the recovery time; autoscaled pools regain headroom and rescale.
            if (!f.p.auto) for (let i = 0; i < f.n; i++) { addInst(f.p, t, false); f.p.inst[f.p.inst.length - 1].readyAt = t + o.recovery; }
          }
          for (const c of o.capLosses || []) c.p.capLoss -= c.n;
          if (o.link) { o.link.factor = 1; o.link.bps = o.link.bps0; }
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
        if (r.pending) { const st = users[r.user]; if (r.fresh) newSession(st); r = issue(st, r.t); st.lastThink = r.think; }
        else if (r.replayTurn) r = replayReq(r.replayTurn, r.t);
        const R = routerById[r.router];
        if (!R || !R.targets.length) { failReq(r, t, 'No route', 'route'); continue; }
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
      if (outs.length) applyOutages(t);
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
          for (let i = 0; i < p.down; i++) inst.push({ st: 3, u: 0, kv: 0, cold: 0 });
          fr.pools[p.id] = { serving, starting, draining, down: p.down, util, q: p.q.length, head: Math.max(0, head), batch, pre, kv: kvC ? kvU / kvC : 0,
            tok: p.tokSec, gpus: gg, cost: gg * p.price / 3600, busyGpu: busy * p.P.tp, inst };
          p.tokSec = 0;
          p.inst = p.inst.filter(x => !(x.state === 'draining' && x.batch.length === 0 && x.pre.length === 0));
        }
        for (const L of linkList) {
          fr.links[L.id] = { factor: L.factor, util: L.bps > 0 ? Math.min(1, L.bytesSec / L.bps) : (L.xfers.length ? 1 : 0), gbps: L.bytesSec * 8 / 1e9, trainGbps: L.trainSec * 8 / 1e9, xfers: L.xfers.filter(x => !x.train).length, trainXfer: L.xfers.some(x => x.train),
            egr: L.fabric ? 0 : L.egrSec / 1e9 * L.egress, tegr: L.fabric ? 0 : L.trainSec / 2 / 1e9 * L.egress };
          L.bytesSec = 0; L.trainSec = 0; L.egrSec = 0;
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
    const tviol = new Float64Array(D), fins = new Float64Array(D);
    const byFirst = Array.from({ length: D }, () => []);
    const tpotByFin = Array.from({ length: D }, () => []);
    let ok = 0;
    const ttftAll = [], tpotAll = [];
    for (const r of reqs) {
      const sa = Math.floor(r.t); if (sa < D) arrivals[sa]++;
      const done = isFinite(r.tFinish);
      r.ttft = isFinite(r.tFirst) ? r.tFirst - r.t : NaN;
      const streamed = streamThink ? r.dec : r.osl;
      r.tpot = done && streamed > 1 ? (r.tFinish - r.tFirst) / (streamed - 1) : (done ? 0 : NaN);
      r.bQueue = r.tAdmit - r.tEnq; r.bPrefill = r.tPrefEnd - r.tAdmit;
      r.bThink = r.think && isFinite(r.tFirst) ? r.tFirst - r.tTok1 : 0;
      if (r.dPool === r.pPool) { r.bXfer = r.net; r.bDwait = 0; }
      else { r.bXfer = (r.tXferEnd - r.tPrefEnd) + r.net; r.bDwait = r.tTok1 - r.tXferEnd; }
      if (isFinite(r.tFirst)) {
        const sf = Math.min(D - 1, Math.floor(r.tFirst));
        if (sf >= 0) { byFirst[sf].push(r); firsts[sf]++; if (r.ttft > slo.ttft) viol[sf]++; }
        ttftAll.push(r.ttft);
      }
      if (done) {
        const sd = Math.min(D - 1, Math.floor(r.tFinish)); completions[sd]++;
        if (r.osl > 1) { tpotByFin[sd].push(r.tpot); tpotAll.push(r.tpot); fins[sd]++; if (r.tpot > slo.tpot) tviol[sd]++; }
        if (r.ttft <= slo.ttft && r.tpot <= slo.tpot) ok++;
        if (r.user >= 0) { const a0 = Math.max(0, Math.floor(r.t)), a1 = Math.min(D - 1, Math.floor(r.tFinish)); for (let s = a0; s <= a1; s++) activeUsers[s]++; }
      }
      r.ok = done && r.ttft <= slo.ttft && r.tpot <= slo.tpot;
    }
    const p50 = new Float64Array(D), p99 = new Float64Array(D), tp99 = new Float64Array(D);
    const bq = new Float64Array(D), bp = new Float64Array(D), bx = new Float64Array(D), bd = new Float64Array(D), bt = new Float64Array(D);
    for (let s = 0; s < D; s++) {
      const win = [], twin = [];
      for (let j = Math.max(0, s - 29); j <= s; j++) { for (const r of byFirst[j]) win.push(r.ttft); for (const v of tpotByFin[j]) twin.push(v); }
      win.sort((a, b) => a - b); twin.sort((a, b) => a - b);
      p50[s] = win.length ? pct(win, 0.5) : NaN; p99[s] = win.length ? pct(win, 0.99) : NaN; tp99[s] = twin.length ? pct(twin, 0.99) : NaN;
      let n = 0, q = 0, pp = 0, x = 0, d = 0, th = 0;
      for (let j = Math.max(0, s - 9); j <= s; j++) for (const r of byFirst[j]) { n++; q += r.bQueue || 0; pp += r.bPrefill || 0; x += r.bXfer || 0; d += r.bDwait || 0; th += r.bThink || 0; }
      bq[s] = n ? q / n : 0; bp[s] = n ? pp / n : 0; bx[s] = n ? x / n : 0; bd[s] = n ? d / n : 0; bt[s] = n ? th / n : 0;
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
        commShare: mean ? Math.max(0, 1 - tr.compute / mean) : NaN, tokPerS: tokS, gpuCostPerHr: tr.gpus * tr.price, costPerHr: tr.gpus * tr.price + trainEgress / hrs,
        daysPer100B: 1e11 / tokS / 86400, crossGB: tr.L ? tr.L.trainBytes / 1e9 : 0 };
    }
    const recorded = compareRecorded(reqs, D);
    const bottleneck = findBottleneck(frames, pools, linkList, viol, firsts, slo, tviol, fins);
    const summary = {
      requests: reqs.length, completed, dropped, rejected: failCounts.kv, lost: failCounts.outage, retried,
      surgeRequests: reqs.filter(r => r.surge).length, bottleneck,
      replay: replayStats.sources ? (() => { const d = replayStats.drift.map(Math.abs).sort((a, b) => a - b); return { sessions: replayStats.sessions, turns: replayStats.turns, branches: replayStats.branches, estimatedGaps: replayStats.estimated, abandoned: replayStats.abandoned, retried: replayStats.retried, issued: replayStats.drift.length, driftP50: pct(d, 0.5), driftP90: pct(d, 0.9), meanDrift: replayStats.drift.length ? replayStats.drift.reduce((a, b) => a + b, 0) / replayStats.drift.length : NaN }; })() : null,
      slo: reqs.length ? ok / reqs.length : NaN,
      ttftP50: pct(ttftAll, 0.5), ttftP99: pct(ttftAll, 0.99), tpotP99: pct(tpotAll, 0.99),
      util: gpuSec ? busyGpuSec / gpuSec : 0, peakGpus: peak,
      cost: cost + egress, costPerHr: (cost + egress) / hrs,
      costPerMTok: outTokens ? (cost + egress) / (outTokens / 1e6) : NaN,
      costPerKReq: completed ? (cost + egress) / (completed / 1000) : NaN,
      outTokens, genTokens, thinkShare: genTokens ? 1 - outTokens / genTokens : 0,
      crossGB, egress, duration: D, simMs: 0, train: trainSum, users: users.filter(Boolean).length
    };
    summary.recorded = recorded.summary;
    summary.simMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - T0);
    const slim = reqs.map(r => ({ id: r.id, src: r.src, router: r.router, t: r.t, isl: r.isl, osl: r.osl, cached: r.cached, user: r.user, site: r.site, pPool: r.pPool, dPool: r.dPool, inLink: r.inLink, xLink: r.xLink,
      tEnq: r.tEnq, tAdmit: r.tAdmit, tPrefEnd: r.tPrefEnd, tXferEnd: r.tXferEnd, tFirst: r.tFirst, tFinish: r.tFinish, net: r.net, fail: r.fail,
      ttft: r.ttft, tpot: r.tpot, ok: r.ok, bQueue: r.bQueue, bPrefill: r.bPrefill, bXfer: r.bXfer, bDwait: r.bDwait,
      think: r.think, tTok1: r.tTok1, bThink: r.bThink, session: r.sess ? r.sess.ses.id : null, turn: r.sess ? r.turn : null, retryOf: r.retryOf || 0,
      recTtft: r.recTtft, recQueue: r.recQueue, recE2e: r.recE2e, failKind: r.failKind || '', retries: r.retries || 0, surge: !!r.surge }));
    return {
      spec,
      pools: pools.map(p => ({ id: p.id, name: p.name, site: p.site, siteKind: p.siteKind, role: p.role, gpu: p.gpu, min: p.min, max: p.max, price: p.price, auto: p.auto, coldStart: p.coldStart, P: p.P })),
      links: linkList.map(L => ({ id: L.id, name: L.name, gbps: L.gbps, rtt: L.rtt, fabric: L.fabric, site: L.site })),
      frames, reqs: slim, train: tr ? { steps: tr.steps } : null,
      stress: { name: stress.name, active: stress.active, surge: stress.surge, ctx: stress.ctx, outages: stress.outages },
      series: { arrivals, completions, viol, firsts, activeUsers, p50, p99, tp99, bq, bp, bx, bd, bt, gpus, util, recP99: recorded.p99 },
      summary, D
    };
  }

  const api = { GPUS, MODELS, TRACES, NODE_RULES, CAUSE, profile, genTrace, scaleTrace, compileGraph, simulate, normStress, findBottleneck,
    headroomIter, findHeadroom, healthOf, HEALTH_LABEL, costBreakdown, latencyBreakdown, blastIter, blastRadius, scaleFleet, sizeFleetIter, sizeFleet, adviseIter, adviseModels, compareRecorded, planSessions, lintSpec, makeRng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetEngine = api;
})(typeof window !== 'undefined' ? window : this);
