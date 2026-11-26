/* Inference Sizer model: how many GPUs, in what layout, serve a model at TTFT/TPOT targets.
   First-order roofline per layout, M/D/1 queueing for prefill, disaggregated vs aggregated serving.
   Pure functions over one flat input object `s` (model + GPU + traffic + targets + assumptions). See docs/METHOD.md. */
(function (root) {
  'use strict';

  // Engine and traffic defaults. Model and GPU fields come from the catalog entry the user picks.
  const SETTINGS = {
    kvprec: 'fp8', ctx: 32768,
    conc: 500, dau: 50000, rpu: 20, peakFactor: 3, concSource: 'max',
    avgIn: 2000, peakIn: 16000, avgOut: 400, peakOut: 2000,
    ttft: 1000, tpot: 30,
    mode: 'auto', kvPolicy: 'paged', prefixHit: 0,
    memUtil: 0.9, reserveGB: 8,
    effPrefill: 0.40, effDecodeBW: 0.65, effDecodeComp: 0.30, stepMs: 1.5,
    maxSeqPerGPU: 256, headroom: 15, nPlus1: true, kvMaxUtil: 0.9, sloMargin: 10,
  };

  function derive(s) {
    const bpp = { bf16: 2, fp8: 1.0, fp4: 0.5625 }[s.wprec] || 1;
    const kvb = { bf16: 2, fp8: 1 }[s.kvprec] || 1;
    const isMoE = s.experts > 0 && s.topk > 0 && s.topk < s.experts && s.active < s.total;
    let Eall = 0, dense = s.total;
    if (isMoE) { Eall = Math.min((s.total - s.active) / (1 - s.topk / s.experts), s.total * 0.98); dense = s.total - Eall; }
    const mla = s.attn === 'mla';
    const lat = s.mlaLatent || 512, rope = s.mlaRope == null ? 64 : s.mlaRope, nope = s.mlaNope == null ? 128 : s.mlaNope, vh = s.mlaV || 128;
    const swaLayers = s.swaWindow > 0 ? Math.round(s.layers * (s.swaFrac || 0)) : 0;
    // tensor-core rate for the weight precision; fall back when the GPU lacks that precision
    const tf = { bf16: s.tfBf16, fp8: s.tfFp8 || s.tfBf16, fp4: s.tfFp4 || s.tfFp8 || s.tfBf16 }[s.wprec] || s.tfBf16;
    const computeFallback = (s.wprec === 'fp4' && !s.tfFp4) ? (s.tfFp8 ? 'fp8' : 'bf16') : (s.wprec === 'fp8' && !s.tfFp8) ? 'bf16' : null;
    return {
      bpp, kvb, isMoE, mla, computeFallback,
      Wd: dense * 1e9 * bpp, We: Eall * 1e9 * bpp,
      denseP: dense * 1e9, activeP: (isMoE ? s.active : s.total) * 1e9,
      kvTokLayer: mla ? (lat + rope) * kvb : 2 * s.kvHeads * s.headDim * kvb,
      swaLayers, fullLayers: s.layers - swaLayers, win: s.swaWindow || 0,
      // attention FLOPs per (query token, context token) per layer
      Apre: mla ? s.qHeads * (2 * (nope + rope) + 2 * vh) : 4 * s.qHeads * s.headDim,
      Adec: mla ? s.qHeads * (2 * (lat + rope) + 2 * lat) : 4 * s.qHeads * s.headDim,
      Fw: tf * 1e12, Fa: s.tfBf16 * 1e12,
      BW: s.hbmTBs * 1e12, nvl: s.scaleUpGBs * 1e9 * 0.8, nic: s.nicGbps / 8 * 1e9 * 0.8,
      hbm: s.hbmGB * 1e9 * s.memUtil, reserve: s.reserveGB * 1e9,
      D: Math.max(1, Math.round(s.domain || 8)),
    };
  }

  function kvBytes(md, L) {
    const w = md.win || L;
    return md.kvTokLayer * (md.fullLayers * L + md.swaLayers * Math.min(L, w));
  }
  function attnPre(md, Lc, L) {
    const W = md.win;
    const f = x => x * x / 2;
    const g = x => x <= W ? x * x / 2 : W * W / 2 + W * (x - W);
    return md.Apre * (md.fullLayers * (f(L) - f(Lc)) + md.swaLayers * (g(L) - g(Lc)));
  }
  function attnDec(md, L) { return md.Adec * (md.fullLayers * L + md.swaLayers * Math.min(L, md.win || L)); }

  // ---------- parallel layouts ----------
  // Instances of g GPUs. Inside one scale-up domain (D GPUs): TP, or TP+EP for MoE, or DP-attention+EP for MLA.
  // Larger than a domain: dense models pipeline across domains (TP=D × PP), MoE models use wide EP.
  function configs(s, md) {
    const out = [], D = md.D;
    for (const g of [1, 2, 4, 8, 16, 32, 64]) {
      const inDomain = g <= D;
      if (!inDomain && g % D !== 0) continue;
      let kind;
      if (!md.isMoE) { if (g > 32 && !inDomain) continue; kind = inDomain ? 'TP' : 'TPPP'; }
      else if (md.mla) kind = 'DPEP';
      else kind = inDomain ? 'TPEP' : 'DPEP';
      out.push({ g, kind, pp: kind === 'TPPP' ? g / D : 1, tpl: kind === 'TPPP' ? D : g });
    }
    return out;
  }
  function decodeLabel(c) {
    if (c.g === 1) return '1 GPU';
    if (c.kind === 'TP') return 'TP' + c.g;
    if (c.kind === 'TPPP') return 'TP' + c.tpl + ' × PP' + c.pp;
    if (c.kind === 'TPEP') return 'TP' + c.g + ' · EP' + c.g;
    return 'DP' + c.g + ' attn · EP' + c.g;
  }

  // ---------- memory (decode-side layout) ----------
  function memInfo(s, md, c) {
    let wGPU, rep, cap, single;
    if (c.kind === 'DPEP') { wGPU = md.Wd + md.We / c.g; rep = 1; }
    else { wGPU = (md.Wd + md.We) / c.g; rep = md.mla ? c.tpl : Math.max(1, c.tpl / s.kvHeads); }
    const avail = md.hbm - md.reserve - wGPU;
    if (c.kind === 'DPEP') { cap = avail * c.g; single = avail; }
    else { cap = avail * c.g / rep; single = cap; }
    const ctxBytes = kvBytes(md, s.ctx);
    const perSeq = s.kvPolicy === 'reserve' ? ctxBytes : kvBytes(md, Math.min(s.ctx, s.avgIn + s.avgOut)) * 1.1;
    const fitsW = avail > 2e9;
    const fitsCtx = fitsW && single >= ctxBytes;
    const Bmem = fitsW ? Math.floor(cap * (s.kvMaxUtil || 1) / perSeq) : 0;
    return { wGPU, rep, avail, cap, single, ctxBytes, perSeq, fitsW, fitsCtx, Bmem };
  }

  function allreduce(s, md, tp, tokens) {
    if (tp <= 1) return 0;
    const bw = tp <= md.D ? md.nvl : md.nic;
    return 2 * s.layers * (8e-6 + 2 * (tp - 1) / tp * tokens * s.hidden * 2 / bw);
  }

  // One decode step with B sequences (per micro-batch when pipelined).
  function decodeStep(s, md, c, B) {
    const L = Math.min(s.ctx, s.avgIn + s.avgOut / 2);
    const kvL = kvBytes(md, L);
    const frac = md.isMoE ? 1 - Math.pow(1 - s.topk / s.experts, B) : 1;
    const linF = 2 * md.activeP * B, atF = B * attnDec(md, L);
    let bytes, gl = c.g, comm = 0;
    if (c.kind === 'DPEP') {
      const imb = c.g > 1 ? 1.15 : 1;
      bytes = md.Wd + md.We * frac / c.g * imb + (B / c.g) * kvL;
      const tok = (B / c.g) * s.topk * s.hidden * 1.5;
      if (c.g > 1) comm = c.g <= md.D ? 2 * s.layers * (10e-6 + tok / md.nvl) : 2 * s.layers * (25e-6 + tok / md.nic) * 0.6;
    } else {
      const rep = md.mla ? c.tpl : Math.max(1, c.tpl / s.kvHeads);
      gl = c.tpl;
      bytes = (md.Wd + md.We * frac) / gl + B * kvL * rep / gl;
      comm = allreduce(s, md, gl, B) * (c.kind === 'TPEP' ? 1.3 : 1);
      if (c.kind === 'TPPP') comm += (c.pp - 1) * (15e-6 + B * s.hidden * 2 / md.nic);
    }
    const tm = bytes / (md.BW * s.effDecodeBW);
    const tc = linF / gl / (md.Fw * s.effDecodeComp) + atF / gl / (md.Fa * s.effDecodeComp);
    const ovh = s.stepMs / 1000;
    return { t: Math.max(tm, tc) + comm + ovh, tm, tc, comm, ovh, bytes, bound: tm >= tc ? 'memory' : 'compute' };
  }

  function decodeCap(s, md, c, mi) {
    return Math.max(0, Math.min(Math.floor(mi.Bmem / c.pp), s.maxSeqPerGPU * c.tpl));
  }
  // Largest per-micro-batch B whose step time stays within the TPOT target.
  function bmax(s, md, c, mi, tpotS) {
    const cap = decodeCap(s, md, c, mi);
    if (cap < 1) return { B: 0, limit: 'memory' };
    if (decodeStep(s, md, c, 1).t > tpotS) return { B: 0, limit: 'latency' };
    if (decodeStep(s, md, c, cap).t <= tpotS) return { B: cap, limit: cap === Math.floor(mi.Bmem / c.pp) ? 'kv-memory' : 'seq-cap' };
    let lo = 1, hi = cap;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (decodeStep(s, md, c, mid).t <= tpotS) lo = mid; else hi = mid; }
    return { B: lo, limit: 'tpot' };
  }

  // ---------- prefill: TP inside a domain, context parallel (CP) across domains, EP for MoE ----------
  function preCfg(md, c) { const tp = Math.min(c.g, md.D); return { g: c.g, tp, cp: Math.max(1, Math.round(c.g / tp)) }; }
  function prefillLabel(c, md) {
    const p = preCfg(md, c);
    let l = p.g === 1 ? '1 GPU' : 'TP' + p.tp + (p.cp > 1 ? ' × CP' + p.cp : '');
    if (md.isMoE && p.g > 1) l += ' · EP' + p.g;
    return l;
  }
  function prefillTime(s, md, c, Lnew, Lc, n) {
    const p = preCfg(md, c);
    const lin = 2 * md.activeP * Lnew * n;
    const at = n * attnPre(md, Lc, Lc + Lnew);
    const par = p.cp > 1 ? 0.85 : 1;
    const tc = lin / p.g / (md.Fw * s.effPrefill * par) + at / p.g / (md.Fa * s.effPrefill * par);
    const tm = (md.Wd / p.tp + md.We / p.g) / (md.BW * s.effDecodeBW);
    const tokens = Lnew * n;
    let comm = allreduce(s, md, p.tp, tokens / p.cp) * 0.5;
    if (md.isMoE && p.g > 1) comm += 2 * s.layers * (10e-6 + tokens / p.g * s.topk * s.hidden * 1.5 / (p.g > md.D ? md.nic : md.nvl)) * 0.5;
    if (p.cp > 1) comm += (kvBytes(md, Lc + Lnew) * n * (p.cp - 1) / p.cp / (p.tp * md.nic) + s.layers * 20e-6) * 0.5;
    return Math.max(tc, tm) + comm + 0.004;
  }
  function prefillStats(s, md, c) {
    const hit = s.prefixHit / 100;
    const aIn = Math.min(s.avgIn, s.ctx), pIn = Math.min(s.peakIn, s.ctx);
    const Lavg = Math.max(1, aIn * (1 - hit)), LcA = aIn * hit;
    const Lpk = Math.max(1, pIn * (1 - hit)), LcP = pIn * hit;
    const budget = Math.max(Lavg, 8192);
    const n = budget / Lavg;
    const tBatch = prefillTime(s, md, c, Lavg, LcA, n);
    const cap = n * Lavg / tBatch; // new prompt tokens / s
    const Speak = prefillTime(s, md, c, Lpk, LcP, 1);
    const p = preCfg(md, c);
    const wGPU = md.Wd / p.tp + md.We / p.g;
    const rep = md.mla ? p.tp : Math.max(1, p.tp / s.kvHeads);
    const avail = md.hbm - md.reserve - wGPU;
    const fits = avail > 2e9 && kvBytes(md, pIn) * rep / p.g * 2 <= avail;
    return { cap, Sbatch: tBatch, Speak, Lavg, Lpk, fits, wGPU, avail };
  }
  function kvXfer(s, md, gP, L) { return kvBytes(md, L) / (Math.min(md.D, gP) * md.nic) + 0.002; }
  const mdWait = (rho, S) => rho * S / (2 * (1 - rho));

  // ---------- load ----------
  // Cs   concurrent decode streams to hold at the TPOT target (from "concurrent sessions")
  // Dtok output tokens/s to deliver (from DAU traffic)
  // lam  request arrivals/s driving prefill
  function computeLoad(s) {
    const dur = s.avgOut * s.tpot / 1000 + s.ttft / 1000;
    const lamDau = s.dau * s.rpu / 86400 * s.peakFactor;
    const lamConc = s.conc / dur;
    const useC = s.concSource !== 'dau', useD = s.concSource !== 'conc';
    const h = 1 + s.headroom / 100;
    const lam0 = Math.max(useC ? lamConc : 0, useD ? lamDau : 0);
    const binding = !useD ? 'concurrency' : !useC ? 'DAU' : (lamDau * dur > s.conc ? 'DAU' : 'concurrency');
    return { dur, lamDau, lamConc, h, binding, Cs: useC ? s.conc * h : 0, Dtok: useD ? lamDau * s.avgOut * h : 0, lam: lam0 * h, lam0 };
  }
  // Smallest per-micro-batch B whose throughput pp*B/t(B) reaches `rate`.
  function minBforRate(c, tfun, rate, capBm) {
    if (rate <= 0) return 1;
    const thr = B => c.pp * B / tfun(B);
    if (thr(capBm) < rate) return Infinity;
    let lo = 0, hi = capBm;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (thr(mid) >= rate) hi = mid; else lo = mid; }
    return hi;
  }

  // ---------- sizing ----------
  const fmtMs = t => { const ms = t * 1000; return ms >= 100 ? Math.round(ms) + ' ms' : ms.toFixed(1) + ' ms'; };

  function sizeDisagg(s, md, load, cfgs) {
    const m = 1 - (s.sloMargin || 0) / 100, T = s.ttft / 1000 * m, P = s.tpot / 1000 * m; // size to targets less the safety margin
    const pre = cfgs.map(c => {
      const ps = prefillStats(s, md, c);
      const xa = kvXfer(s, md, c.g, Math.min(s.avgIn, s.ctx)), xp = kvXfer(s, md, c.g, Math.min(s.peakIn, s.ctx));
      const r = { c, label: prefillLabel(c, md), ps, xferAvg: xa, xferPeak: xp, feasible: false, why: '' };
      if (!ps.fits) { r.why = 'weights + prompt KV do not fit'; return r; }
      if (ps.Speak + xp > T) { r.why = 'peak prompt TTFT ' + fmtMs(ps.Speak + xp) + ' > target'; return r; }
      const budget = T - xa, S = ps.Sbatch;
      if (S >= budget) { r.why = 'avg prompt service time exceeds TTFT budget'; return r; }
      const x = (budget - S) / S, rhoMax = Math.min(0.85, 2 * x / (1 + 2 * x));
      const need = load.lam * ps.Lavg;
      const N = Math.max(1, Math.ceil(need / (ps.cap * rhoMax)));
      const rho = need / (N * ps.cap);
      Object.assign(r, { feasible: true, N, gpus: N * c.g, rho, rhoMax, ttftAvg: S + mdWait(rho, S) + xa, ttftPeak: ps.Speak + xp });
      return r;
    });
    const dec = cfgs.map(c => {
      const mi = memInfo(s, md, c);
      const r = { c, label: decodeLabel(c), mi, feasible: false, why: '' };
      if (!mi.fitsW) { r.why = 'weights do not fit'; return r; }
      if (!mi.fitsCtx) { r.why = 'one full-context sequence does not fit'; return r; }
      const bm = bmax(s, md, c, mi, P);
      r.bm = bm;
      if (bm.B < 1) { r.why = bm.limit === 'latency' ? 'TPOT floor ' + fmtMs(decodeStep(s, md, c, 1).t) + ' > target' : 'no KV room'; return r; }
      const Binst = bm.B * c.pp;
      const tfun = B => decodeStep(s, md, c, B).t;
      const thrInst = Binst / tfun(bm.B);
      const N = Math.max(1, Math.ceil(load.Cs / Binst), Math.ceil(load.Dtok / thrInst));
      const Bm = Math.max(1, Math.ceil(load.Cs / N / c.pp), minBforRate(c, tfun, load.Dtok / N, bm.B));
      const st = decodeStep(s, md, c, Bm), Bop = Bm * c.pp;
      Object.assign(r, { feasible: true, N, gpus: N * c.g, Binst, Bop, st, tpotOp: st.t, thrInst, kvUse: Bop * mi.perSeq / 1.1 / mi.cap });
      return r;
    });
    const best = arr => arr.filter(r => r.feasible).sort((a, b) => a.gpus - b.gpus || a.c.g - b.c.g)[0] || null;
    return { pre, dec, P: best(pre), D: best(dec) };
  }

  // Aggregated: each step carries the decode batch plus a prefill chunk sized to keep the step within TPOT.
  function sizeAgg(s, md, load, cfgs) {
    const m = 1 - (s.sloMargin || 0) / 100, T = s.ttft / 1000 * m, P = s.tpot / 1000 * m; // size to targets less the safety margin
    const rows = cfgs.map(c => {
      const mi = memInfo(s, md, c);
      const r = { c, label: decodeLabel(c), mi, feasible: false, why: '' };
      if (!mi.fitsW) { r.why = 'weights do not fit'; return r; }
      if (!mi.fitsCtx) { r.why = 'one full-context sequence does not fit'; return r; }
      const capBm = decodeCap(s, md, c, mi), capB = capBm * c.pp;
      if (capB < 1) { r.why = 'no KV room'; return r; }
      const ps = prefillStats(s, md, c);
      if (!ps.fits) { r.why = 'weights + prompt KV do not fit'; return r; }
      if (ps.Speak + s.stepMs / 1000 > T) { r.why = 'peak prompt TTFT ' + fmtMs(ps.Speak) + ' > target'; return r; }
      if (decodeStep(s, md, c, 1).t > P) { r.why = 'TPOT floor ' + fmtMs(decodeStep(s, md, c, 1).t) + ' > target'; return r; }
      const Nmin = Math.max(1, Math.ceil(load.Cs / capB));
      const Nmax = Math.max(Nmin * 64, 4096);
      for (let N = Nmin; N <= Nmax; N++) {
        const fp0 = load.lam * ps.Lavg / N / ps.cap;
        if (fp0 >= 0.85) continue;
        const tAvgF = B => { const q = decodeStep(s, md, c, B); return Math.max(q.tm, q.tc / (1 - fp0)) * 1.1 + q.comm + q.ovh; };
        const Bm = Math.max(1, Math.ceil(load.Cs / N / c.pp), minBforRate(c, tAvgF, load.Dtok / N, capBm));
        if (!isFinite(Bm) || Bm > capBm) continue;
        const st = decodeStep(s, md, c, Bm);
        const Pcore = (P - st.comm - st.ovh) / 1.1;
        if (Math.max(st.tm, st.tc) >= Pcore) continue;
        const chunk = (Pcore - st.tc) * ps.cap;
        const mu = chunk / P;
        const rArr = load.lam * ps.Lavg / N;
        const rho = rArr / mu;
        if (rho >= 0.85) continue;
        const S = ps.Lavg / mu;
        const ttftAvg = S + mdWait(rho, S) + P, ttftPeak = ps.Lpk / mu + P;
        if (ttftAvg > T || ttftPeak > T) continue;
        const tAvg = Math.min(P, tAvgF(Bm)), Bop = Bm * c.pp;
        Object.assign(r, { feasible: true, N, gpus: N * c.g, Bop, st, tpotOp: tAvg, ttftAvg, ttftPeak, fp: fp0, rho, chunk, ps, kvUse: Bop * mi.perSeq / 1.1 / mi.cap, thrInst: Bop / tAvg });
        return r;
      }
      r.why = 'no instance count meets both targets';
      return r;
    });
    const best = rows.filter(r => r.feasible).sort((a, b) => a.gpus - b.gpus || a.c.g - b.c.g)[0] || null;
    return { rows, best };
  }

  // The operating point of one fixed layout at a fixed concurrency: what an engine running config c with B sequences
  // in flight delivers, by the same physics sizeAgg uses (each step carries the decode batch plus prefill chunks; the
  // prefill share fp slows the compute part). For checking the model against measured runs (e.g. InferenceX):
  // returns TPOT, TTFT, and output tokens/s per GPU.
  function operatingPoint(s, md, c, B) {
    const st = decodeStep(s, md, c, B), ps = prefillStats(s, md, c), osl = s.avgOut, isl = Math.min(s.avgIn, s.ctx);
    let tpot = st.t, ttft = ps.Sbatch, fp = 0;
    for (let i = 0; i < 50; i++) {
      const lam = B / (osl * tpot + ttft);              // requests/s through this instance
      fp = Math.min(0.95, lam * isl / ps.cap);          // share of compute spent on prefill
      const t = Math.max(st.tm, st.tc / (1 - fp)) * 1.1 + st.comm + st.ovh;
      // a new prompt is prefilled in chunks between decode steps: its share of each step is what decode leaves
      const free = Math.max(0.05, 1 - Math.max(st.tm, st.tc) / t);
      const tt = prefillTime(s, md, c, isl, 0, 1) / free + mdWait(Math.min(0.85, fp), isl / ps.cap) + t;
      if (Math.abs(t - tpot) < 1e-7 && Math.abs(tt - ttft) < 1e-6) { tpot = t; ttft = tt; break; }
      tpot = t; ttft = tt;
    }
    const outPerGpu = B * osl / (osl * tpot + ttft) / c.g;
    return { tpot, ttft, outPerGpu, prefillShare: fp, bound: st.bound, step: st };
  }

  // Nodes (scale-up domains) needed: instances that span domains take whole domains; smaller ones pack first-fit-decreasing.
  function packNodes(pools, D) {
    const items = [];
    let whole = 0;
    for (const p of pools) for (let i = 0; i < p.N; i++) { if (p.g >= D) whole += Math.ceil(p.g / D); else items.push(p.g); }
    items.sort((a, b) => b - a);
    const bins = [];
    for (const g of items) { const b = bins.findIndex(x => x + g <= D); if (b >= 0) bins[b] += g; else bins.push(g); }
    return whole + bins.length;
  }

  function plan(s, opts) {
    opts = opts || {};
    const md = derive(s);
    const load = computeLoad(s);
    const cfgs = configs(s, md);
    const dis = sizeDisagg(s, md, load, cfgs);
    const agg = sizeAgg(s, md, load, cfgs);
    const D = md.D;
    // N+1: room for one more instance of the largest layout, using free GPUs in existing nodes first
    const spareFor = pools => s.nPlus1 ? packNodes(pools.concat([{ N: 1, g: Math.max(...pools.map(p => p.g)) }]), D) - packNodes(pools, D) : 0;
    let disOpt = null, aggOpt = null;
    if (dis.P && dis.D) {
      const pools = [{ N: dis.P.N, g: dis.P.c.g }, { N: dis.D.N, g: dis.D.c.g }];
      const nodes = packNodes(pools, D), sp = spareFor(pools);
      disOpt = { mode: 'disagg', gpus: dis.P.gpus + dis.D.gpus, nodes, spareNodes: sp, totalNodes: nodes + sp };
    }
    if (agg.best) {
      const pools = [{ N: agg.best.N, g: agg.best.c.g }];
      const nodes = packNodes(pools, D), sp = spareFor(pools);
      aggOpt = { mode: 'agg', gpus: agg.best.gpus, nodes, spareNodes: sp, totalNodes: nodes + sp };
    }
    const plural = n => n === 1 ? '' : 's', U = D > 8 ? 'rack' : 'node';
    let chosen = null, reason = '';
    if (s.mode === 'disagg') { chosen = disOpt; reason = 'Disaggregated serving selected.'; }
    else if (s.mode === 'agg') { chosen = aggOpt; reason = 'Aggregated serving selected.'; }
    else if (disOpt && (!aggOpt || disOpt.totalNodes < aggOpt.totalNodes * 0.9)) {
      chosen = disOpt;
      reason = aggOpt ? `Disaggregated prefill/decode needs ${aggOpt.totalNodes - disOpt.totalNodes} fewer ${U}${plural(aggOpt.totalNodes - disOpt.totalNodes)} than aggregated (${disOpt.totalNodes} vs ${aggOpt.totalNodes}).` : 'Aggregated serving cannot meet both targets on any layout; splitting prefill and decode can.';
    } else if (aggOpt) {
      chosen = aggOpt;
      reason = disOpt ? (aggOpt.totalNodes <= disOpt.totalNodes ? `Aggregated serving with chunked prefill fits in ${aggOpt.totalNodes} ${U}${plural(aggOpt.totalNodes)} (disaggregated: ${disOpt.totalNodes}), with fewer moving parts.` : `Disaggregation would save under 10% (${disOpt.totalNodes} vs ${aggOpt.totalNodes} ${U}s); aggregated is simpler to run.`) : 'Only aggregated serving meets both targets.';
    } else if (disOpt) { chosen = disOpt; reason = 'Only disaggregated serving meets both targets.'; }
    const res = { s, md, load, cfgs, dis, agg, disOpt, aggOpt, chosen, reason };
    if (chosen) { chosen.nodeGPUs = D; chosen.provGPUs = chosen.totalNodes * D; chosen.kw = chosen.totalNodes * (s.nodeKW || 0); }
    res.tpotFloor = Math.min(...cfgs.map(c => memInfo(s, md, c).fitsW ? decodeStep(s, md, c, 1).t : Infinity));
    res.ttftFloor = Math.min(...cfgs.map(c => { const p = prefillStats(s, md, c); return p.fits ? p.Speak : Infinity; }));
    const reqDay = s.dau * s.rpu;
    res.econ = { reqDay, inDay: reqDay * s.avgIn, outDay: reqDay * s.avgOut };
    if (chosen) {
      const costDay = chosen.provGPUs * 24 * (s.price || 0);
      res.econ.costDay = costDay;
      res.econ.perMOut = res.econ.outDay > 0 ? costDay / (res.econ.outDay / 1e6) : NaN;
      res.econ.avgVsPeak = load.lam > 0 ? (reqDay / 86400) / load.lam : NaN;
    }
    if (!opts.noSens) {
      res.sens = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100].map(tp => {
        const r = plan(Object.assign({}, s, { tpot: tp }), { noSens: true });
        return { tpot: tp, gpus: r.chosen ? r.chosen.provGPUs : null };
      });
    }
    return res;
  }

  const api = { SETTINGS, plan, derive, kvBytes, decodeStep, memInfo, prefillStats, prefillTime, configs, computeLoad, decodeLabel, prefillLabel, decodeCap, packNodes, operatingPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SizerModel = api;
})(this);
