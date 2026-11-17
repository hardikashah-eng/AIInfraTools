/* FleetScope calibration: fit the spec-sheet performance model to measurements.
   Sources: a recorded trace with TTFT/e2e, a vLLM /metrics snapshot, or a vLLM benchmark_serving result.
   The fit adjusts two multipliers per pool (prefill throughput, decode step time) by re-simulating. */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.FleetEngine;
  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))] : NaN);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- Prometheus text exposition ----------
  function parseProm(text) {
    const series = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const m = line.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+([-+0-9.eEInfNa]+)/);
      if (!m) continue;
      const labels = {};
      if (m[3]) for (const kv of m[3].match(/(\w+)="((?:[^"\\]|\\.)*)"/g) || []) { const i = kv.indexOf('='); labels[kv.slice(0, i)] = kv.slice(i + 2, -1); }
      series.push({ name: m[1], labels, value: m[4] === '+Inf' ? Infinity : +m[4] });
    }
    return series;
  }
  // Quantiles from a cumulative histogram (Prometheus buckets), linear inside a bucket.
  function histQuantiles(buckets, qs) {
    const b = buckets.slice().sort((x, y) => x.le - y.le), total = b.length ? b[b.length - 1].count : 0;
    const out = {};
    for (const q of qs) {
      const target = q * total;
      let prevLe = 0, prevC = 0, v = NaN;
      for (const x of b) {
        if (x.count >= target) { const le = isFinite(x.le) ? x.le : prevLe * 2 || 1; v = x.count === prevC ? le : prevLe + (le - prevLe) * (target - prevC) / (x.count - prevC); break; }
        prevLe = isFinite(x.le) ? x.le : prevLe; prevC = x.count;
      }
      out[q] = v;
    }
    return { q: out, count: total };
  }
  // vLLM /metrics snapshot → measured latency quantiles and load. windowS: the period the counters cover
  // (the server's uptime, or the gap between two snapshots when `before` is given).
  function fromVllmMetrics(text, opt) {
    opt = opt || {};
    const cur = parseProm(text), prev = opt.before ? parseProm(opt.before) : null;
    const model = opt.model || null;
    const keep = s => !model || !s.labels.model_name || s.labels.model_name === model;
    const sum = (arr, name) => arr.filter(s => s.name === name && keep(s)).reduce((a, s) => a + s.value, 0);
    const delta = name => sum(cur, name) - (prev ? sum(prev, name) : 0);
    const hist = base => {
      const by = new Map();
      for (const s of cur) if (s.name === base + '_bucket' && keep(s)) { const le = s.labels.le === '+Inf' ? Infinity : +s.labels.le; by.set(le, (by.get(le) || 0) + s.value); }
      if (prev) for (const s of prev) if (s.name === base + '_bucket' && keep(s)) { const le = s.labels.le === '+Inf' ? Infinity : +s.labels.le; by.set(le, (by.get(le) || 0) - s.value); }
      return [...by].map(([le, count]) => ({ le, count }));
    };
    const ttft = histQuantiles(hist('vllm:time_to_first_token_seconds'), [0.5, 0.9, 0.99]);
    const tpot = histQuantiles(hist('vllm:time_per_output_token_seconds'), [0.5, 0.9, 0.99]);
    const reqs = delta('vllm:request_success_total') || delta('vllm:e2e_request_latency_seconds_count') || ttft.count;
    const prompt = delta('vllm:prompt_tokens_total'), gen = delta('vllm:generation_tokens_total');
    const windowS = opt.windowS || 3600;
    if (!ttft.count) throw new Error('No vllm:time_to_first_token_seconds histogram found');
    return {
      source: 'vLLM /metrics', requests: reqs, windowS, rate: reqs / windowS,
      islMean: reqs ? prompt / reqs : NaN, oslMean: reqs ? gen / reqs : NaN,
      ttftP50: ttft.q[0.5], ttftP99: ttft.q[0.99], tpotP50: tpot.q[0.5], tpotP99: tpot.q[0.99],
      running: sum(cur, 'vllm:num_requests_running'), kvUsage: sum(cur, 'vllm:gpu_cache_usage_perc') || sum(cur, 'vllm:kv_cache_usage_perc')
    };
  }
  // vLLM benchmarks/benchmark_serving.py --save-result JSON.
  function fromBenchmark(json) {
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    const ms = v => (v == null ? NaN : v / 1000);
    const isl = j.input_lens || null, osl = j.output_lens || null;
    const completed = j.completed || (isl ? isl.length : 0);
    const out = {
      source: 'benchmark_serving', requests: completed, windowS: j.duration, rate: j.request_throughput || completed / j.duration,
      islMean: j.total_input_tokens && completed ? j.total_input_tokens / completed : isl ? isl.reduce((a, b) => a + b, 0) / isl.length : NaN,
      oslMean: j.total_output_tokens && completed ? j.total_output_tokens / completed : osl ? osl.reduce((a, b) => a + b, 0) / osl.length : NaN,
      ttftP50: ms(j.median_ttft_ms), ttftP99: ms(j.p99_ttft_ms), tpotP50: ms(j.median_tpot_ms), tpotP99: ms(j.p99_tpot_ms),
      maxConcurrency: j.max_concurrency || null, isl, osl, ttfts: j.ttfts || null
    };
    if (!isFinite(out.ttftP50) || !isFinite(out.tpotP50)) throw new Error('The result has no median_ttft_ms / median_tpot_ms');
    return out;
  }
  // A trace that reproduces a measured load: Poisson arrivals at the measured rate, prompt and output sizes
  // from the benchmark's own lists or log-normal around the measured means.
  function traceFor(target, opt) {
    opt = opt || {};
    const rng = E.makeRng((opt.seed || 17) >>> 0), dur = Math.min(opt.maxS || 600, target.windowS || 600), rate = target.rate || 1;
    const rows = [];
    let i = 0;
    for (let t = 0; t < dur; t += -Math.log(1 - rng.u()) / rate, i++) {
      // log-normal with the measured mean: median = mean / e^(σ²/2)
      const isl = target.isl ? target.isl[i % target.isl.length] : Math.max(16, Math.round(rng.logn((target.islMean || 1000) / Math.exp(0.245), 0.7)));
      const osl = target.osl ? target.osl[i % target.osl.length] : Math.max(2, Math.round(rng.logn((target.oslMean || 200) / Math.exp(0.18), 0.6)));
      rows.push({ t, isl, osl, cached: 0 });
    }
    return rows;
  }

  // ---------- fitting ----------
  function measure(R, poolId) {
    const rs = R.reqs.filter(q => (q.pPool === poolId || q.dPool === poolId) && isFinite(q.ttft));
    const tt = rs.map(q => q.ttft).sort((a, b) => a - b), tp = rs.filter(q => q.osl > 1 && isFinite(q.tpot) && q.tpot > 0).map(q => q.tpot).sort((a, b) => a - b);
    const mean = (a, f) => (a.length ? a.reduce((x, q) => x + (f(q) || 0), 0) / a.length : 0);
    const queueShare = rs.length ? mean(rs, q => Math.max(0, q.bQueue)) / Math.max(1e-9, mean(rs, q => q.ttft)) : 0;
    return { n: rs.length, ttftP50: pct(tt, 0.5), ttftP99: pct(tt, 0.99), tpotP50: pct(tp, 0.5), tpotP99: pct(tp, 0.99), queueShare };
  }
  // The measured side of a recorded trace already in the spec (requests with recTtft / recE2e).
  function recordedTarget(R, poolId) {
    const rs = R.reqs.filter(q => (!poolId || q.pPool === poolId) && isFinite(q.recTtft));
    if (!rs.length) return null;
    const tt = rs.map(q => q.recTtft).sort((a, b) => a - b);
    const tp = rs.filter(q => isFinite(q.recE2e) && q.osl > 1).map(q => (q.recE2e - q.recTtft) / (q.osl - 1)).filter(v => v > 0).sort((a, b) => a - b);
    return { source: 'recorded trace', requests: rs.length, ttftP50: pct(tt, 0.5), ttftP99: pct(tt, 0.99), tpotP50: pct(tp, 0.5), tpotP99: pct(tp, 0.99) };
  }
  function acceptance(target, sim) {
    const e = (a, b) => (isFinite(a) && isFinite(b) && b > 0 ? (a - b) / b : NaN);
    const rows = [
      { metric: 'TTFT p50', rec: target.ttftP50, sim: sim.ttftP50, err: e(sim.ttftP50, target.ttftP50), bar: 0.10 },
      { metric: 'TTFT p99', rec: target.ttftP99, sim: sim.ttftP99, err: e(sim.ttftP99, target.ttftP99), bar: 0.20 },
      { metric: 'TPOT p50', rec: target.tpotP50, sim: sim.tpotP50, err: e(sim.tpotP50, target.tpotP50), bar: 0.10 },
      { metric: 'TPOT p99', rec: target.tpotP99, sim: sim.tpotP99, err: e(sim.tpotP99, target.tpotP99), bar: 0.20 }
    ].filter(r => isFinite(r.rec));
    for (const r of rows) r.pass = isFinite(r.err) && Math.abs(r.err) <= r.bar;
    return { rows, pass: rows.length > 0 && rows.every(r => r.pass) };
  }
  // A spec that serves the measured load on one pool alone: same model, the pool as drawn, a synthetic trace.
  function benchSpec(spec, poolId, target, opt) {
    const s = JSON.parse(JSON.stringify(spec, (k, v) => (k === 'trace' ? undefined : v)));
    const pool = s.pools.find(p => p.id === poolId);
    if (!pool) throw new Error('No pool ' + poolId);
    if (opt && opt.instances) { pool.min = pool.max = opt.instances; pool.auto = false; }
    pool.decode = []; pool.role = 'agg';
    s.pools = [pool]; s.links = []; s.train = null;
    s.routers = [{ id: 'calib-rt', name: 'Calibration router', policy: 'least-wait', burstWait: 1, targets: [{ pool: poolId, link: null, edges: [] }] }];
    s.sources = [{ id: 'calib-src', name: 'Measured load', kind: 'open', router: 'calib-rt', edge: '', prefixHit: 0, useRecordedCache: true, userBase: 0, replay: 'timestamps', cls: 'internal', trace: traceFor(target, opt) }];
    return s;
  }
  // Fits {prefill, decode} for one pool. spec: a compiled spec; target: measured quantiles.
  // When the target came from the spec's own recorded trace, the spec is simulated as is; otherwise on benchSpec.
  function* fitPoolIter(spec, poolId, target, opt) {
    opt = opt || {};
    const base = opt.useSpec ? JSON.parse(JSON.stringify(spec)) : benchSpec(spec, poolId, target, opt);
    const pool = base.pools.find(p => p.id === poolId);
    let cal = Object.assign({ prefill: 1, decode: 1 }, pool.calib || {});
    const history = [];
    const runWith = c => { pool.calib = c; const R = E.simulate(base); return measure(R, poolId); };
    const before = runWith(Object.assign({}, cal));
    history.push({ cal: Object.assign({}, cal), sim: before });
    const iters = opt.iters || 10;
    for (let i = 0; i < iters; i++) {
      yield { done: i + 1, total: iters, text: 'Iteration ' + (i + 1) + ': prefill ×' + cal.prefill.toFixed(2) + ', decode ×' + cal.decode.toFixed(2) };
      const last = history[history.length - 1].sim;
      const dErr = isFinite(target.tpotP50) && last.tpotP50 > 0 ? target.tpotP50 / last.tpotP50 : 1;
      // TTFT left after decode is fixed mostly scales with prefill time; damped because queueing is non-linear
      const pErr = isFinite(target.ttftP50) && target.ttftP50 > 0 ? last.ttftP50 / target.ttftP50 : 1;
      if (Math.abs(dErr - 1) < 0.02 && Math.abs(pErr - 1) < 0.03) break;
      cal = { decode: clamp(cal.decode * Math.pow(dErr, 0.9), 0.2, 5), prefill: clamp(cal.prefill * Math.pow(pErr, 0.7), 0.1, 10) };
      history.push({ cal: Object.assign({}, cal), sim: runWith(cal) });
    }
    const best = history.reduce((b, h) => { const sc = x => Math.abs(Math.log((x.sim.ttftP50 || 1) / (target.ttftP50 || 1))) + (isFinite(target.tpotP50) ? Math.abs(Math.log((x.sim.tpotP50 || 1) / target.tpotP50)) : 0); return sc(h) < sc(b) ? h : b; });
    const acc = acceptance(target, best.sim);
    // When simulated TTFT is mostly queueing, speed multipliers cannot close the gap: the graph has less capacity
    // than the fleet that was measured (instances, max batch, KV cache), so say that instead of forcing a fit.
    const diagnosis = acc.pass ? 'fit' : target.ttftP99 > 8 * target.ttftP50 ? 'overloaded' : best.sim.queueShare > 0.5 && best.sim.ttftP50 > (target.ttftP50 || 0) * 1.3 ? 'capacity' : (best.cal.prefill >= 9.9 || best.cal.prefill <= 0.11 || best.cal.decode >= 4.9 || best.cal.decode <= 0.21) ? 'limit' : 'tail';
    return { poolId, target, before, after: best.sim, calib: { prefill: +best.cal.prefill.toFixed(3), decode: +best.cal.decode.toFixed(3) }, history,
      acceptanceBefore: acceptance(target, before), acceptance: acc, diagnosis };
  }
  const fitPool = (spec, poolId, target, opt) => { const it = fitPoolIter(spec, poolId, target, opt); let x; do x = it.next(); while (!x.done); return x.value; };

  // ---------- training ----------
  // Step timing CSV (from a training loop or the PyTorch profiler): step, step_time and, when logged, data_time,
  // compute (forward+backward) and comm (exposed all-reduce) in seconds. Returns medians.
  function parseStepLog(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim());
    const head = lines.shift().split(',').map(h => h.trim().toLowerCase());
    const col = names => head.findIndex(h => names.includes(h));
    const ix = { step: col(['step', 'iteration']), total: col(['step_time', 'step_time_s', 'iter_time', 'time']), data: col(['data_time', 'data', 'dataloader_time']), compute: col(['compute', 'fwd_bwd', 'forward_backward', 'compute_time']), comm: col(['comm', 'allreduce', 'comm_time', 'sync']) };
    if (ix.total < 0) throw new Error('Need a step_time column');
    const rows = lines.map(l => l.split(',').map(x => +x));
    const med = k => { if (ix[k] < 0) return NaN; const v = rows.map(r => r[ix[k]]).filter(isFinite).sort((a, b) => a - b); return pct(v, 0.5); };
    return { steps: rows.length, stepS: med('total'), dataS: med('data'), computeS: med('compute'), commS: med('comm') };
  }
  // Fits kernel efficiency (compute), comm overlap and dataloader rate to measured step timings.
  function fitTraining(T, spec, meas) {
    const s = T.normalizeTraining(spec), m0 = T.stepModel(s, s.mixes[0]);
    const out = Object.assign({}, spec);
    const comp = isFinite(meas.computeS) ? meas.computeS : meas.stepS - (meas.dataS || 0) - (meas.commS || 0);
    if (comp > 0) out.kernelEff = +clamp(s.kernelEff * (m0.compute + m0.tpOver + m0.bubble) / comp, 0.05, 0.95).toFixed(3);
    if (isFinite(meas.commS) && m0.comm > 0) out.overlap = +clamp(1 - meas.commS / m0.comm, 0, 1).toFixed(3);
    if (isFinite(meas.dataS) && meas.dataS > 0.01 && m0.cpu > 0) {
      // exposed data time d = raw − busy → raw = d + compute; scale the worker rate so the model's raw time matches
      const raw = meas.dataS + comp, mix = Object.assign({}, s.mixes[0]);
      mix.samplesPerWorkerS = +(mix.samplesPerWorkerS * m0.cpu / raw).toFixed(4);
      out.mixes = [mix].concat(s.mixes.slice(1));
    }
    const fitted = T.stepModel(T.normalizeTraining(out), (out.mixes || s.mixes)[0]);
    return { spec: out, before: m0, after: fitted, measured: meas };
  }
  // Fault rate per GPU-day from a fault log with timestamps, over the GPUs the log covers.
  function faultRate(log, gpusCovered) {
    const ts = log.events.map(e => Date.parse(e.t)).filter(isFinite).sort((a, b) => a - b);
    if (ts.length < 2) return null;
    const days = Math.max(1, (ts[ts.length - 1] - ts[0]) / 86400000);
    const gpus = gpusCovered || Math.max(8, log.byNode.length * 8);
    return { faults: ts.length, days, gpus, perGpuDay: ts.length / (gpus * days) };
  }

  const api = { parseProm, histQuantiles, fromVllmMetrics, fromBenchmark, traceFor, recordedTarget, measure, acceptance, benchSpec, fitPoolIter, fitPool, parseStepLog, fitTraining, faultRate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetCalibrate = api;
})(typeof window !== 'undefined' ? window : this);
