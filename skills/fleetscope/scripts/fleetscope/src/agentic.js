/* FleetScope agentic workloads: fit a profile of how agent sessions behave from a real trace, generate synthetic sessions
   from it at any load, measure what a workload asks of a fleet, and size GPUs for it.

   Why: agent traffic is not "N requests/s of ISL×OSL". A session is a loop of model calls whose context grows turn by
   turn and is mostly re-read from the prefix cache, separated by tool runs (seconds) and human pauses (minutes), with
   occasional compactions and subagent bursts. Sizing from average ISL/OSL ignores the reuse (overstating prefill) and
   ignores the KV cache that idle sessions hold between turns (understating memory).

   Profile: per stream kind (a session's main loop, or a subagent), a table of per-stream parameters sampled whole
   (turns, first prompt, context growth and prefill per turn as 13-point quantiles, tool-loop pace, share and length of long pauses, compaction point, output length, model time) and pooled per-turn
   distributions as quantile tables (growth, gaps, output and model time normalized by the stream's own means;  the share of context
   still cached after a pause longer than the cache lifetime, the first call's cache hit, how much a compaction
   keeps), plus subagents per session.

   Rows are FleetScope trace rows: { t, isl, osl, cached?, session?, agent?, api? } (see ingest.js). */
(function (root) {
  'use strict';

  // ---------- distributions ----------
  // Quantile tables on a fixed probability grid, finer in the tail (agent traces are heavy-tailed: a uniform 101-point
  // table interpolating from p99 to the maximum would inflate means several-fold). The top point is p99.99, not the max.
  const GRID = (() => { const g = []; for (let i = 0; i <= 90; i++) g.push(i / 100); for (let i = 1; i <= 90; i++) g.push(0.9 + i / 1000); for (let i = 1; i <= 9; i++) g.push(0.99 + i / 1000); g.push(0.9995, 0.9999); return g; })();
  function quantiles(xs) {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    return GRID.map(p => { const x = p * (s.length - 1), lo = Math.floor(x), hi = Math.min(s.length - 1, lo + 1); return +(s[lo] + (s[hi] - s[lo]) * (x - lo)).toFixed(4); });
  }
  // inverse CDF: u in [0,1) → value, interpolating between grid points
  function draw(q, u) {
    if (!q) return 0;
    const p = u * GRID[GRID.length - 1];
    let lo = 0, hi = GRID.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (GRID[mid] <= p) lo = mid; else hi = mid; }
    const f = (p - GRID[lo]) / (GRID[hi] - GRID[lo] || 1);
    return q[lo] + (q[hi] - q[lo]) * f;
  }
  const at = (q, p) => { if (!q) return NaN; const i = GRID.findIndex(x => x >= p - 1e-12); return q[i < 0 ? q.length - 1 : i]; };
  function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
  function hashStr(x) { let h = 2166136261; for (const ch of String(x)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }

  // ---------- streams ----------
  function streams(rows) {
    const m = new Map();
    for (const r of rows) {
      const sess = r.session != null ? r.session : 'all', k = sess + '\u0000' + (r.agent || '');
      if (!m.has(k)) m.set(k, { session: sess, agent: r.agent || null, rows: [] });
      m.get(k).rows.push(r);
    }
    for (const s of m.values()) s.rows.sort((a, b) => a.t - b.t);
    return [...m.values()];
  }

  // ---------- fit ----------
  // Two levels, so sessions keep their character: a table of per-stream parameters (how many turns, how big the first
  // prompt, how fast context grows, how quick the tool loop is, how often the stream waits on a person, where it
  // compacts), sampled whole; and pooled per-turn distributions, normalized by those parameters, for the variation
  // inside a stream (normalized by the stream's means, so a stream keeps its own averages). Gaps follow a two-state chain (short: tool loop; long: a person or a slow tool), because long
  // pauses come in runs.
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  // a stream's own growth and prefill per turn, as 13 points (p0, p10 … p90, p95, p99, max): they are the stream's
  // character (a session reading big files vs one making small edits), and pooling them across streams blurs the tails.
  // The fine top keeps a stream's one-off largest turn to about 1% of draws.
  const SQ = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1];
  function streamQ(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return SQ.map(p => Math.round(s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))])); }
  function drawSQ(q, u) { const p = u; let i = 0; while (i < SQ.length - 2 && SQ[i + 1] <= p) i++; const f = (p - SQ[i]) / (SQ[i + 1] - SQ[i]); return q[i] + (q[i + 1] - q[i]) * Math.min(1, f); }
  function fitStreams(ss, o) {
    const params = [], appendQ = [], uncachedQ = [], appendN = [], shortN = [], longGap = [], longN = [], firstReuse = [], missTokens = [], shrinkRatio = [], shrinkMiss = [], osl = [], api = [], reuseShort = [], reuseLong = [], compactRatio = [], preCompact = [];
    let ll = 0, lAny = 0, grows = 0;
    for (const s of ss) {
      const rs = s.rows, app = [], unc = [], sg = [], lg = [], states = [], so = [], sa = [];
      if (rs[0].cached != null) firstReuse.push(Math.min(1, rs[0].cached / Math.max(1, rs[0].isl)));
      const cAt = [], cR = [];
      rs.forEach((r, i) => {
        so.push(r.osl); if (Number.isFinite(r.api)) sa.push(r.api);
        if (!i) return;
        const p = rs[i - 1], g = Math.max(0, r.t - (p.t + (Number.isFinite(p.api) ? p.api : 0))), long = g > o.longGapS;
        states.push(long); if (long) { longGap.push(g); lg.push(g); } else sg.push(g);
        if (r.isl < p.isl * o.compaction) { compactRatio.push(r.isl / Math.max(1, p.isl)); preCompact.push(p.isl); cAt.push(p.isl); cR.push(r.isl / Math.max(1, p.isl)); return; }
        // a smaller cut (old tool output cleared, history edited): the edited part is prefilled again
        if (r.isl < p.isl) { shrinkRatio.push(r.isl / Math.max(1, p.isl)); if (r.cached != null) shrinkMiss.push(Math.min(1, (r.isl - r.cached) / Math.max(1, r.isl))); return; }
        grows++;
        const add = Math.max(0, r.isl - p.isl); app.push(add);
        if (r.cached != null) {
          if (g > o.cacheTtlS) reuseLong.push(Math.min(1, r.cached / Math.max(1, r.isl)));
          else { reuseShort.push(Math.min(1, r.cached / Math.max(1, p.isl))); missTokens.push(r.isl - r.cached - add); unc.push(Math.max(0, r.isl - r.cached)); }
        }
      });
      for (let i = 1; i < states.length; i++) if (states[i - 1]) { lAny++; if (states[i]) ll++; }
      // scales are the stream's means, so the pooled normalized draws average 1 and the stream keeps its own mean
      const am = Math.max(1, mean(app) || 1), gm = Math.max(0.05, mean(sg) || 0.05), lm = lg.length ? mean(lg) : 0;
      const om = Math.max(1, mean(so)), pm = sa.length ? Math.max(0.01, mean(sa)) : 0;
      for (const a of app) appendN.push(a / am); for (const g of sg) shortN.push(g / gm); if (lm) for (const g of lg) longN.push(g / lm);
      for (const x of so) osl.push(x / om); if (pm) for (const x of sa) api.push(x / pm);
      appendQ.push(streamQ(app)); uncachedQ.push(streamQ(unc));
      params.push([rs.length, rs[0].isl, am, gm, states.length ? states.filter(Boolean).length / states.length : 0, cAt.length ? Math.max(...cAt) : 0, lm, om, pm, cR.length ? +mean(cR).toFixed(4) : 0, app.length ? Math.max(...app) : 0, Math.max(...rs.map(x => x.isl))]);
    }
    // keep at most 4000 streams' parameters (evenly spaced) to bound the profile's size
    const step = Math.max(1, params.length / 4000), table = [], aq = [], uq = [];
    for (let i = 0; i < params.length && table.length < 4000; i += step) { table.push(params[Math.floor(i)].map(x => +(+x).toFixed(3))); aq.push(appendQ[Math.floor(i)]); uq.push(uncachedQ[Math.floor(i)]); }
    return { streams: ss.length, params: table, appendQ: aq, uncachedQ: uq, paramsCols: ['turns', 'firstIsl', 'appendMean', 'shortGapMean', 'longShare', 'compactAt', 'longGapMean', 'outputMean', 'modelTimeMean', 'compactKeeps', 'appendMax', 'islMax'],
      appendNorm: quantiles(appendN), shortGapNorm: quantiles(shortN), longGap: quantiles(longGap), longGapNorm: quantiles(longN), firstReuse: quantiles(firstReuse), missTokens: quantiles(missTokens), pLongAfterLong: lAny ? ll / lAny : 0,
      oslNorm: quantiles(osl), apiNorm: quantiles(api), reuseShort: quantiles(reuseShort), reuseLong: quantiles(reuseLong),
      compactRatio: quantiles(compactRatio), preCompact: quantiles(preCompact), compactions: compactRatio.length,
      pShrink: shrinkRatio.length / Math.max(1, shrinkRatio.length + grows), shrinkRatio: quantiles(shrinkRatio), shrinkMiss: quantiles(shrinkMiss) };
  }
  function fitProfile(rows, opt) {
    const o = Object.assign({ cacheTtlS: 300, compaction: 0.5, longGapS: 30, source: '' }, opt || {});
    const ss = streams(rows), main = ss.filter(s => !s.agent), sub = ss.filter(s => s.agent);
    const subPer = new Map(main.map(s => [s.session, 0])); for (const s of sub) subPer.set(s.session, (subPer.get(s.session) || 0) + 1);
    const cached = rows.filter(r => r.cached != null);
    return { kind: 'fleetscope.agentic-profile', version: 11, source: o.source, cacheTtlS: o.cacheTtlS, compaction: o.compaction, longGapS: o.longGapS,
      sessions: main.length, requests: rows.length, cacheHit: cached.length ? cached.reduce((a, r) => a + r.cached, 0) / cached.reduce((a, r) => a + r.isl, 0) : null,
      main: fitStreams(main, o), sub: sub.length ? fitStreams(sub, o) : null, subPerSession: sub.length ? quantiles([...subPer.values()]) : null };
  }

  // ---------- synthesize ----------
  // A session per arrival (Poisson at sessionsPerHour, or given start times): pick a stream's parameters, then draw each
  // turn's growth, gap, output and model time around them.
  function synthStream(P, r, t0, sess, agent, horizon, o, out) {
    const pi0 = Math.floor(r() * P.params.length), pr = P.params[pi0], aq = P.appendQ && P.appendQ[pi0], uq = P.uncachedQ && P.uncachedQ[pi0], [turns, first, am, gm, longShare, compactAt, lm, om, pm, ck, aMax, iMax] = pr;
    const pLL = P.pLongAfterLong, pi = Math.min(0.99, longShare), pLS = pi >= 1 ? 1 : Math.min(1, pi * (1 - pLL) / Math.max(1e-6, 1 - pi));
    let isl = Math.max(1, Math.round(first)), t = t0, prev = null, long = false;
    for (let i = 0; i < turns && t < horizon; i++) {
      let uncached = isl;
      if (prev) {
        long = r() < (long ? pLL : pLS);
        const g = long ? (lm > 0 && P.longGapNorm ? draw(P.longGapNorm, r()) * lm : draw(P.longGap, r())) : draw(P.shortGapNorm, r()) * gm;
        t += g; if (t >= horizon) break;
        let shrink = false;
        if (compactAt > 0 && prev.isl >= compactAt) isl = Math.max(1, Math.round(prev.isl * (ck || draw(P.compactRatio, r()))));
        else if (P.shrinkRatio && r() < P.pShrink) { shrink = true; isl = Math.max(1, Math.round(prev.isl * draw(P.shrinkRatio, r()))); }
        // growth stays within what this stream was seen to do: no single turn adds more, and the context gets no longer
        else isl = Math.min(o.maxIsl, iMax || Infinity, prev.isl + Math.round(aq ? drawSQ(aq, r()) : Math.min(aMax || Infinity, draw(P.appendNorm, r()) * am)));
        // prefill this turn: within the cache lifetime, drawn from the stream's own uncached tokens per turn (mostly the
        // tokens appended, sometimes a miss); after it, a drawn share of the whole context
        if (shrink && P.shrinkMiss) uncached = Math.round(isl * draw(P.shrinkMiss, r()));
        else if (g > o.cacheTtlS && P.reuseLong) uncached = Math.round(isl * (1 - draw(P.reuseLong, r())));
        else if (uq) uncached = Math.min(isl, Math.round(drawSQ(uq, r())));
        else if (P.missTokens) uncached = Math.max(0, Math.round(Math.max(0, isl - prev.isl) + Math.min(prev.isl, draw(P.missTokens, r()))));
        else uncached = isl;
      }
      const osl = Math.max(1, Math.round(draw(P.oslNorm, r()) * om)), api = pm && P.apiNorm ? draw(P.apiNorm, r()) * pm : NaN;
      const row = { t, isl, osl, session: sess, cached: prev ? Math.max(0, Math.min(isl - 1, isl - uncached)) : P.firstReuse ? Math.min(isl - 1, Math.round(draw(P.firstReuse, r()) * isl)) : 0 };
      if (agent) row.agent = agent;
      if (Number.isFinite(api)) row.api = api;
      out.push(row); prev = row; t += Number.isFinite(api) ? api : 0;
    }
    return t;
  }
  function arrivals(n, perHour, horizon, r) {
    const out = []; let t = 0;
    if (perHour > 0) { while (true) { t += -Math.log(1 - r()) * 3600 / perHour; if (t >= horizon) break; out.push(t); } }
    else for (let i = 0; i < n; i++) out.push(r() * horizon);
    return out;
  }
  function synthesize(profile, opt) {
    const o = Object.assign({ seed: 1, horizonS: 3600, sessionsPerHour: 0, sessions: 100, starts: null, maxIsl: 2e6, cacheTtlS: profile.cacheTtlS || 300 }, opt || {});
    const r = rng(o.seed), starts = o.starts || arrivals(o.sessions, o.sessionsPerHour, o.horizonS, r), out = [];
    starts.forEach((t0, i) => {
      const sess = 'synth-' + i, end = synthStream(profile.main, r, t0, sess, null, o.horizonS, o, out);
      if (profile.sub && profile.subPerSession) {
        const k = Math.round(draw(profile.subPerSession, r()));
        for (let j = 0; j < k; j++) synthStream(profile.sub, r, t0 + r() * Math.max(1, end - t0), sess, 'sub-' + j, o.horizonS, o, out);
      }
    });
    return out.sort((a, b) => a.t - b.t);
  }
  // The same arrival process, filled with real sessions (each keeps its own internal timing): the replay to compare a
  // synthetic workload against.
  function replay(rows, opt) {
    const o = Object.assign({ seed: 1, horizonS: 3600 }, opt || {});
    const r = rng(o.seed), byS = new Map();
    for (const x of rows) { const k = x.session != null ? x.session : 'all'; if (!byS.has(k)) byS.set(k, []); byS.get(k).push(x); }
    const sess = [...byS.values()].map(rs => { const t0 = Math.min(...rs.map(x => x.t)); return rs.map(x => Object.assign({}, x, { t: x.t - t0 })); });
    const starts = o.starts || arrivals(o.sessions || 100, o.sessionsPerHour || 0, o.horizonS, r), out = [];
    starts.forEach((t0, i) => { const s = sess[Math.floor(r() * sess.length)]; for (const x of s) { const t = t0 + x.t; if (t < o.horizonS) out.push(Object.assign({}, x, { t, session: 'replay-' + i + ':' + x.session })); } });
    return out.sort((a, b) => a.t - b.t);
  }

  // ---------- what a workload asks of a fleet ----------
  // Per window: arrivals, prefill tokens (input not served from cache), decode tokens; in-flight calls; and the KV
  // working set: tokens of contexts that must stay resident to be re-read, i.e. each stream's latest context from its
  // call until its next call (or the cache lifetime, whichever comes first).
  function workloadStats(rows, opt) {
    const o = Object.assign({ windowS: 60, cacheTtlS: 300, ideal: false }, opt || {});
    if (!rows.length) return null;
    // windows span the arrivals (or the given horizon); a call still running past the end isn't stretched over more windows
    let t0 = Infinity, t1 = -Infinity; for (const r of rows) { if (r.t < t0) t0 = r.t; if (r.t > t1) t1 = r.t; }
    if (o.horizonS) { t0 = Math.min(t0, 0); t1 = t0 + o.horizonS; } else t1 += o.windowS;
    const W = Math.max(1, Math.ceil((t1 - t0) / o.windowS));
    const arr = new Float64Array(W), pre = new Float64Array(W), dec = new Float64Array(W), kv = new Float64Array(W + 1), fl = new Float64Array(W + 1);
    const ix = t => Math.min(W - 1, Math.max(0, Math.floor((t - t0) / o.windowS)));
    let cachedSum = 0, islSum = 0;
    for (const s of streams(rows)) {
      s.rows.forEach((r, i) => {
        const next = s.rows[i + 1], cached = o.ideal ? (i ? Math.min(r.isl, s.rows[i - 1].isl) : 0) : (r.cached || 0);
        cachedSum += cached; islSum += r.isl;
        const w = ix(r.t); arr[w]++; pre[w] += r.isl - cached; dec[w] += r.osl;
        // resident from the call until the next call or the TTL; sampled at window edges
        const end = Math.min(next ? next.t : Infinity, r.t + (r.api || 0) + o.cacheTtlS);
        for (let e = Math.ceil((r.t - t0) / o.windowS); e * o.windowS + t0 < end && e <= W; e++) kv[e] += r.isl + r.osl;
        if (r.api > 0) for (let e = Math.ceil((r.t - t0) / o.windowS); e * o.windowS + t0 < r.t + r.api && e <= W; e++) fl[e]++;
      });
    }
    const Q = (a, p) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
    const per = a => ({ mean: Array.from(a).reduce((x, y) => x + y, 0) / a.length / o.windowS, p50: Q(a, 0.5) / o.windowS, p95: Q(a, 0.95) / o.windowS, max: Q(a, 1) / o.windowS });
    const isl = rows.map(r => r.isl), osl = rows.map(r => r.osl);
    return { requests: rows.length, sessions: new Set(rows.map(r => r.session)).size, seconds: t1 - t0, cacheHit: islSum ? cachedSum / islSum : 0,
      isl: { mean: isl.reduce((a, b) => a + b, 0) / isl.length, p50: Q(isl, 0.5), p90: Q(isl, 0.9), p99: Q(isl, 0.99) },
      osl: { mean: osl.reduce((a, b) => a + b, 0) / osl.length, p50: Q(osl, 0.5), p90: Q(osl, 0.9), p99: Q(osl, 0.99) },
      rps: per(arr), prefillTps: per(pre), decodeTps: per(dec),
      kvTokens: { p50: Q(kv, 0.5), p95: Q(kv, 0.95), max: Q(kv, 1) }, inflight: { p50: Q(fl, 0.5), p95: Q(fl, 0.95), max: Q(fl, 1) } };
  }
  const KEYS = ['cacheHit', 'isl.mean', 'isl.p90', 'osl.mean', 'rps.mean', 'rps.p95', 'prefillTps.mean', 'prefillTps.p95', 'decodeTps.mean', 'decodeTps.p95', 'kvTokens.p95'];
  const getp = (o, k) => k.split('.').reduce((a, x) => (a == null ? a : a[x]), o);
  function compare(real, synth, keys) {
    const out = {};
    for (const k of keys || KEYS) { const a = getp(real, k), b = getp(synth, k); out[k] = { real: a, synth: b, err: a ? (b - a) / a : null }; }
    return out;
  }

  // ---------- GPUs for a workload ----------
  // The sizer for compute (peak arrivals, mean and p99 prompts, cache hit from the workload), and the KV working set
  // against what's left of HBM after weights for memory. Agentic fleets are often bound by the second.
  // KV offload defaults: host memory for KV per GPU, the cap InferenceX AgentX allows (3 TB per server, in proportion to
  // the GPUs used: 375 GB for an 8-GPU server), and reload over PCIe 5.0 x16 (64 GB/s per direction) at 70% of it.
  const OFFLOAD = { cpuGBPerGpu: 375, pcieGBs: 64, eff: 0.7 };
  function sizeFor(stats, s0, M, opt) {
    const o = Object.assign({ kvBound: true, kvOffload: false }, opt || {});
    // the arrival rate goes in directly (the sizer's "DAU" path: requests/s at peak, output tokens/s), so prefill and
    // decode are sized from the workload's own peak-minute rate rather than from a concurrency guess
    const s = Object.assign({}, s0, { avgIn: Math.round(stats.isl.mean), peakIn: Math.round(stats.isl.p99), avgOut: Math.round(stats.osl.mean), peakOut: Math.round(stats.osl.p99),
      ctx: Math.max(s0.ctx || 0, Math.round(stats.isl.p99 + stats.osl.p99)), prefixHit: Math.round(100 * stats.cacheHit), concSource: 'dau', dau: Math.max(1, stats.rps.p95 * 86400), rpu: 1, peakFactor: 1 });
    const r = M.plan(s, { noSens: true }), md = M.derive(s);
    const perTok = M.kvBytes(md, 1e6) / 1e6;
    // KV lives on the decode (or aggregated) instances: what's left per GPU after that layout's share of the weights
    const g = r.chosen ? (r.chosen.mode === 'disagg' ? r.dis.D.c.g : r.agg.best.c.g) : md.D;
    const freePerGpu = Math.max(1e9, (md.hbm - md.reserve) * (s.kvMaxUtil || 0.9) - (md.Wd + md.We) / g);
    const kvGpus = Math.ceil(stats.kvTokens.p95 * perTok / freePerGpu / g) * g;
    const compute = r.chosen ? r.chosen.provGPUs : null;
    // KV offload: contexts that don't fit in HBM wait in host memory and are reloaded over PCIe when their session comes
    // back. The GPUs then only need to hold the hot part; a reload slower than the TTFT target means offload can't be used.
    const off = Object.assign({}, OFFLOAD, o.offload || {}), W = stats.kvTokens.p95 * perTok;
    const kvGpusOff = Math.ceil(W / (freePerGpu + off.cpuGBPerGpu * 1e9) / g) * g;
    const gOff = compute == null ? null : Math.max(compute, kvGpusOff), hbmAtOff = gOff ? gOff * freePerGpu : 0;
    const reloadMs = 1000 * stats.isl.mean * (stats.cacheHit || 0) * perTok / (off.pcieGBs * 1e9 * off.eff * g); // a returning session's cached prefix, the instance's GPUs reloading in parallel
    const offShare = W > 0 ? Math.max(0, 1 - hbmAtOff / W) : 0;
    // and all of them together: the reload traffic at the peak minute against the PCIe the GPUs have
    const pcieUtil = gOff ? stats.rps.p95 * offShare * stats.isl.mean * (stats.cacheHit || 0) * perTok / (gOff * off.pcieGBs * 1e9 * off.eff) : null;
    const offload = { cpuGBPerGpu: off.cpuGBPerGpu, kvGpus: kvGpusOff, gpus: gOff, offloadedShare: offShare, reloadMs, fitsTtft: reloadMs < s.ttft, pcieUtil, pcieGBs: off.pcieGBs };
    offload.usable = offload.fitsTtft && pcieUtil != null && pcieUtil < 0.8; // headroom: reloads compete with weights and activations for the bus
    const useOff = o.kvOffload && offload.usable && gOff != null;
    const kvNeed = useOff ? kvGpusOff : kvGpus, gpus = compute == null ? null : Math.max(compute, o.kvBound ? kvNeed : 0);
    // tokens per megawatt (AgentX's headline metric): peak-minute output tokens/s over the provisioned power, from the
    // published per-node power (the whole server) when there is one, else the GPU's board power alone
    const perGpuKW = s.nodeKW ? s.nodeKW / (s.domain || 8) : s.tdpW ? s.tdpW / 1000 : null;
    const powerKW = gpus != null && perGpuKW ? gpus * perGpuKW : null;
    return { compute, kvGpus, gpus, bound: compute == null ? 'none' : kvNeed > compute ? (useOff ? 'KV working set (with offload)' : 'KV working set') : 'compute',
      kvGB: W / 1e9, mode: r.chosen && r.chosen.mode, offload, kvOffloadUsed: useOff,
      power: powerKW == null ? null : { kw: powerKW, basis: s.nodeKW ? 'published node power' : 'GPU board power only', tokensPerSecPerMW: stats.decodeTps && stats.decodeTps.p95 != null ? stats.decodeTps.p95 / (powerKW / 1000) : null },
      inputs: { avgIn: s.avgIn, peakIn: s.peakIn, avgOut: s.avgOut, prefixHit: s.prefixHit, requestsPerS: stats.rps.p95 } };
  }
  // The traditional sizing input: the same request rate and mean ISL/OSL, no prefix reuse, no idle sessions.
  function flatStats(stats) {
    return Object.assign({}, stats, { cacheHit: 0, kvTokens: { p50: stats.inflight.p50 * (stats.isl.mean + stats.osl.mean), p95: stats.inflight.p95 * (stats.isl.mean + stats.osl.mean), max: stats.inflight.max * (stats.isl.mean + stats.osl.mean) } });
  }

  // ---------- validation: fit on some sessions, compare synthetic against replay of the others ----------
  function validate(rows, opt) {
    const o = Object.assign({ holdout: 0.3, seeds: [1, 2, 3], sessionsPerHour: 600, horizonS: 3600, cacheTtlS: 300 }, opt || {});
    const isTest = r => (hashStr(r.session) % 1000) / 1000 < o.holdout;
    const train = rows.filter(r => !isTest(r)), test = rows.filter(isTest);
    const profile = fitProfile(train, { cacheTtlS: o.cacheTtlS, source: o.source });
    const runs = o.seeds.map(seed => {
      const starts = arrivals(0, o.sessionsPerHour, o.horizonS, rng(seed * 7919));
      const real = workloadStats(replay(test, { seed, starts, horizonS: o.horizonS }), o), synth = workloadStats(synthesize(profile, { seed, starts, horizonS: o.horizonS }), o);
      return { seed, real, synth, cmp: compare(real, synth) };
    });
    const agg = {};
    for (const k of KEYS) { const e = runs.map(x => x.cmp[k].err).filter(Number.isFinite); agg[k] = { meanAbsErr: e.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, e.length), meanErr: e.reduce((a, b) => a + b, 0) / Math.max(1, e.length) }; }
    const res = { profile, train: { rows: train.length, sessions: new Set(train.map(r => r.session)).size }, test: { rows: test.length, sessions: new Set(test.map(r => r.session)).size }, runs, agg, settings: o };
    Object.defineProperty(res, 'testRows', { value: test, enumerable: false });
    return res;
  }

  const api = { GRID, at, quantiles, draw, fitProfile, synthesize, replay, workloadStats, compare, sizeFor, flatStats, validate, streams, arrivals, rng, KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FleetAgentic = api;
})(typeof window !== 'undefined' ? window : globalThis);
