/* FleetScope live twin: forecast traffic from metrics history, project it through the graph, and turn
   predicted SLO breaches into alerts. Works on Prometheus query_range results (or any [{t, rate}] series). */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.FleetEngine;
  const DAY = 86400;

  // Prometheus /api/v1/query_range JSON → [{t, v}] (summed over series). Accepts the raw response,
  // its data object, or a plain [{t, rate}] array.
  function seriesFrom(json) {
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    if (Array.isArray(j)) return j.map(x => ({ t: +(x.t != null ? x.t : x[0]), v: +(x.v != null ? x.v : x.rate != null ? x.rate : x[1]) })).filter(x => isFinite(x.t) && isFinite(x.v));
    const res = (j.data || j).result || [];
    const by = new Map();
    for (const s of res) for (const [t, v] of s.values || (s.value ? [s.value] : [])) by.set(+t, (by.get(+t) || 0) + +v);
    return [...by].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })).filter(x => isFinite(x.v));
  }
  // A bundle: request rate plus optional prompt and generation token rates, keyed as in the CLI's export.
  function bundleFrom(json) {
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    if (j.requests) return { requests: seriesFrom(j.requests), prompt: j.prompt ? seriesFrom(j.prompt) : null, generation: j.generation ? seriesFrom(j.generation) : null, meta: j.meta || {} };
    return { requests: seriesFrom(j), prompt: null, generation: null, meta: {} };
  }

  // Additive Holt-Winters with a daily season (when there is at least two days of history), else Holt's linear trend.
  // Returns the fitted state and a function giving the forecast at a future time, with a residual spread for bands.
  function fit(series, opt) {
    opt = opt || {};
    const pts = series.filter(x => isFinite(x.v));
    if (pts.length < 4) throw new Error('Need at least a few points of history');
    const step = Math.max(1, Math.round(median(pts.slice(1).map((p, i) => p.t - pts[i].t))));
    const m = Math.round(DAY / step), seasonal = pts.length >= 2 * m && !opt.noSeason;
    const a = opt.alpha != null ? opt.alpha : 0.3, b = opt.beta != null ? opt.beta : 0.01, g = opt.gamma != null ? opt.gamma : 0.15;
    let level = mean(pts.slice(0, Math.min(pts.length, seasonal ? m : 10)).map(p => p.v)), trend = 0;
    const season = new Float64Array(seasonal ? m : 1);
    if (seasonal) { for (let i = 0; i < m; i++) season[i] = pts[i].v - level; }
    const resid = [];
    for (let i = seasonal ? m : 1; i < pts.length; i++) {
      const s = seasonal ? season[i % m] : 0, yhat = level + trend + s, y = pts[i].v;
      resid.push(y - yhat);
      const pl = level;
      level = a * (y - s) + (1 - a) * (level + trend);
      trend = b * (level - pl) + (1 - b) * trend;
      if (seasonal) season[i % m] = g * (y - level) + (1 - g) * s;
    }
    const lastI = pts.length - 1, t0 = pts[lastI].t;
    const sd = Math.sqrt(mean(resid.slice(-Math.max(10, Math.min(resid.length, seasonal ? m : 200))).map(r => r * r)));
    const at = t => { const h = (t - t0) / step; const s = seasonal ? season[Math.round(lastI + h) % m] : 0; return Math.max(0, level + trend * h + s); };
    return { at, sd, step, seasonal, t0, level, trend };
  }
  function forecast(series, horizonS, opt) {
    const F = fit(series, opt), out = [];
    // one-step residuals understate multi-step error: widen the 80% band with the horizon
    for (let t = F.t0 + F.step; t <= F.t0 + horizonS + 1e-9; t += F.step) { const v = F.at(t), w = 1.28 * F.sd * Math.sqrt(1 + (t - F.t0) / 3600); out.push({ t, v, lo: Math.max(0, v - w), hi: v + w }); }
    return { points: out, sd: F.sd, step: F.step, seasonal: F.seasonal, t0: F.t0 };
  }
  // Backtest: fit on everything before `cut`, forecast to the end, compare with what happened.
  function backtest(series, cutT, horizonS, opt) {
    const hist = series.filter(p => p.t <= cutT), actual = series.filter(p => p.t > cutT && p.t <= cutT + horizonS);
    const fc = forecast(hist, horizonS, opt);
    const pairs = actual.map(a => { const f = fc.points.reduce((b, p) => (Math.abs(p.t - a.t) < Math.abs(b.t - a.t) ? p : b), fc.points[0]); return { t: a.t, actual: a.v, predicted: f.v, lo: f.lo, hi: f.hi }; });
    const ape = pairs.filter(p => p.actual > 0).map(p => Math.abs(p.predicted - p.actual) / p.actual);
    const inBand = pairs.filter(p => p.actual >= p.lo && p.actual <= p.hi).length;
    return { forecast: fc, pairs, mape: ape.length ? mean(ape) : NaN, coverage: pairs.length ? inBand / pairs.length : NaN };
  }

  // Arrivals for a forecast: Poisson at the forecast rate (or its upper band), sizes from recent token rates.
  function traceFrom(fc, opt) {
    opt = opt || {};
    const rng = E.makeRng((opt.seed || 23) >>> 0), rows = [], pts = fc.points, t0 = fc.t0;
    const isl = opt.islMean || 1500, osl = opt.oslMean || 300;
    for (let i = 0; i < pts.length; i++) {
      const r = opt.band === 'hi' ? pts[i].hi : pts[i].v, a = (i ? pts[i - 1].t : t0) - t0, bnd = pts[i].t - t0;
      if (r <= 0) continue;
      for (let t = a - Math.log(1 - rng.u()) / r; t < bnd; t += -Math.log(1 - rng.u()) / r) rows.push({ t, isl: Math.max(16, Math.round(rng.logn(isl / 1.28, 0.7))), osl: Math.max(2, Math.round(rng.logn(osl / 1.2, 0.6))), cached: 0 });
    }
    return rows;
  }
  // Runs a forecast through a compiled spec: its first traffic source replays the forecast, the others are dropped.
  function project(spec, fc, opt) {
    opt = opt || {};
    const s = JSON.parse(JSON.stringify(spec, (k, v) => (k === 'trace' ? undefined : v)));
    const src = Object.assign({}, s.sources[0], { kind: 'open', replay: 'timestamps', trace: traceFrom(fc, opt), prefixHit: s.sources[0].prefixHit || 0, useRecordedCache: false });
    s.sources = [src];
    s.train = s.train ? Object.assign({}, s.train) : null;
    const R = E.simulate(s, opt.stress || null);
    return { R, alerts: alertsFrom(R, fc.t0, opt) };
  }
  // Predicted breaches: minutes where more than `share` of first tokens miss TTFT or of answers miss TPOT,
  // merged across gaps of up to `gapMin` minutes, kept when at least `minMin` minutes long.
  function alertsFrom(R, t0, opt) {
    opt = opt || {};
    const share = opt.share || 0.1, gapMin = opt.gapMin != null ? opt.gapMin : 3, minMin = opt.minMin || 2, slo = R.spec.slo;
    const B = Math.ceil(R.D / 60), f = new Float64Array(B), v = new Float64Array(B), fin = new Float64Array(B), tb = new Float64Array(B);
    for (const q of R.reqs) {
      if (isFinite(q.tFirst)) { const b = Math.min(B - 1, Math.floor(q.tFirst / 60)); f[b]++; if (q.ttft > slo.ttft) v[b]++; }
      if (isFinite(q.tFinish) && q.osl > 1) { const b = Math.min(B - 1, Math.floor(q.tFinish / 60)); fin[b]++; if (q.tpot > slo.tpot) tb[b]++; }
    }
    const runs = [];
    let cur = null;
    for (let b = 0; b < B; b++) {
      const ts = f[b] ? v[b] / f[b] : 0, tp = fin[b] ? tb[b] / fin[b] : 0;
      if (ts > share || tp > share) { if (cur && b - cur.end <= gapMin + 1) { cur.end = b; } else { if (cur) runs.push(cur); cur = { start: b, end: b }; } }
    }
    if (cur) runs.push(cur);
    const blame = (R.summary.bottleneck && R.summary.bottleneck.blame) || [], Sr = R.series;
    return runs.filter(a => a.end - a.start + 1 >= minMin).map(a => {
      let worstT = 0, worstP = 0, p99 = 0, tp99 = 0; const cause = {};
      for (let b = a.start; b <= a.end; b++) { worstT = Math.max(worstT, f[b] ? v[b] / f[b] : 0); worstP = Math.max(worstP, fin[b] ? tb[b] / fin[b] : 0); }
      for (let s = a.start * 60; s < Math.min(R.D, (a.end + 1) * 60); s++) { p99 = Math.max(p99, Sr.p99[s] || 0); tp99 = Math.max(tp99, Sr.tp99[s] || 0); const bl = blame[s]; if (bl) { const k = bl.kind + '|' + bl.id; cause[k] = (cause[k] || 0) + 1; } }
      const top = Object.entries(cause).sort((x, y) => y[1] - x[1])[0];
      const [kind, id] = top ? top[0].split('|') : [null, null];
      const node = R.pools.find(p => p.id === id) || R.links.find(l => l.id === id);
      return { start: t0 + a.start * 60, end: t0 + (a.end + 1) * 60, startS: a.start * 60, endS: (a.end + 1) * 60, missShare: worstT, tpotMissShare: worstP, ttftP99: p99, tpotP99: tp99,
        metric: worstP > worstT ? 'tpot' : 'ttft', cause: kind, causeLabel: kind ? (E.CAUSE[kind] || {}).label : null, node: id, nodeName: node ? node.name : id };
    });
  }
  function alertText(a, opt) {
    const fmt = (opt && opt.fmt) || (t => new Date(t * 1000).toISOString().slice(11, 16) + ' UTC');
    const worst = a.metric === 'tpot' ? 'in the worst minute ' : 'in the worst minute ';
    const what = a.metric === 'tpot' ? worst + Math.round(a.tpotMissShare * 100) + '% of answers stream slower than the TPOT target (p99 up to ' + Math.round(a.tpotP99 * 1000) + ' ms per token)' : worst + Math.round(a.missShare * 100) + '% of requests miss the TTFT target (p99 up to ' + a.ttftP99.toFixed(1) + ' s)';
    return 'FleetScope predicts SLO breaches ' + fmt(a.start) + '–' + fmt(a.end) + ': ' + what + (a.nodeName ? '. Where: ' + a.nodeName + ', ' + a.causeLabel : '') + '.';
  }

  // A synthetic week of request-rate history: a daily cycle with a weekday bump, slow growth and noise,
  // with a launch spike in the last day. Used for the sample and the tests.
  function sampleHistory(opt) {
    opt = opt || {};
    const rng = E.makeRng((opt.seed || 5) >>> 0), step = opt.step || 300, days = opt.days || 7, base = opt.base || 4, end = opt.end || 1794960000;
    const start = end - days * DAY, out = [];
    for (let t = start; t <= end; t += step) {
      const h = ((t % DAY) / 3600 + 24 - 8) % 24;            // local hour, UTC−8
      const d = (t - start) / DAY;
      const daily = 0.35 + 0.65 * Math.exp(-Math.pow((h - 14) / 4.2, 2)) + 0.25 * Math.exp(-Math.pow((h - 10) / 2, 2));
      const growth = 1 + 0.03 * d;
      out.push({ t, v: Math.max(0, base * daily * growth * (1 + 0.06 * rng.normal())) });
    }
    return out;
  }

  // Local clock text for a unix time, given a UTC offset in hours.
  function clock(t, offsetH) { const m = Math.floor((((t / 60) + (offsetH || 0) * 60) % 1440 + 1440) % 1440); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
  function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; }

  const api = { clock, seriesFrom, bundleFrom, fit, forecast, backtest, traceFrom, project, alertsFrom, alertText, sampleHistory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetForecast = api;
})(typeof window !== 'undefined' ? window : this);
