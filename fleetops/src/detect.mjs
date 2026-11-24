// Incident detection that adapts to the fleet: seasonal baselines and CUSUM change-point detection, then grouping.
//
// Fixed thresholds ("4× the trailing median and at least 50 an hour") are noisy on a real fleet: a busy hour of the
// day looks like a spike and a slow ramp never crosses. Here:
//   - each series gets a baseline for its time of day (the median of the same bin on previous days), falling back to
//     the trailing day's median while there is less history;
//   - a CUSUM accumulates evidence that the series moved above its baseline. Poisson for failure counts, a robust
//     z-score for latency. It alarms when the evidence passes h. The onset is where the accumulation started, so the
//     incident window begins at the change, not at the alarm;
//   - incidents with overlapping windows and the same symptom (and pool) fold into one; others that overlap are linked.

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

// Baseline for each bin start: median of the same time-of-day bin on up to `days` previous days (needs ≥ 2 of them),
// else median of the previous `trailing` seconds of bins. `values` maps bin start → value (missing bins count as 0
// when zeroFill, for counts).
//   first: where observation starts (earlier bins are unknown, not zero); defaults to the first bin with a value
export function seasonalBaseline(values, bins, { binS, days = 7, trailing = 86400, zeroFill = true, first } = {}) {
  const get = b => (values.has(b) ? values.get(b) : zeroFill ? 0 : NaN);
  first = first ?? Math.min(...values.keys());
  return bins.map(b => {
    const same = [];
    for (let d = 1; d <= days; d++) { const p = b - d * 86400; if (p >= first) same.push(get(p)); }
    if (same.filter(Number.isFinite).length >= 2) return median(same);
    const trail = [];
    for (let p = b - binS; p >= b - trailing && p >= first; p -= binS) trail.push(get(p));
    return median(trail);
  });
}

// Poisson CUSUM over [{ t (bin start), x (count), base (expected count) }]. Tests an upward shift to
// λ1 = max(ratio·λ0, λ0 + minExcess). Returns runs: { from (onset), alarmAt (bin end where S > h), to (S back to 0), sum,
// peak, base }. S is capped at cap·h: one huge bin then can't keep an incident open for days after the rate is back.
export function poissonCusum(series, { binS, ratio = 3, minExcess = 3, h = 6, floor = 0.2, cap = 3 } = {}) {
  const out = [];
  let S = 0, start = null, cur = null;
  for (const p of series) {
    const l0 = Math.max(floor, p.base || 0), l1 = Math.max(ratio * l0, l0 + minExcess);
    const inc = p.x * Math.log(l1 / l0) - (l1 - l0);
    const prev = S;
    S = Math.min(cap * h, Math.max(0, S + inc));
    if (prev === 0 && S > 0) start = p.t;
    if (!cur && S > h) cur = { from: start ?? p.t, alarmAt: p.t + binS, sum: 0, peak: 0, base: l0 };
    if (cur) { cur.sum += p.x; cur.peak = Math.max(cur.peak, p.x); }
    if (S === 0) { if (cur) { cur.to = p.t; out.push(cur); cur = null; } start = null; }
  }
  if (cur) { cur.to = series.length ? series[series.length - 1].t + binS : cur.alarmAt; out.push(cur); }
  // counts before the alarm (from onset) belong to the incident too
  for (const r of out) r.sum = series.filter(p => p.t >= r.from && p.t < r.to).reduce((t, p) => t + p.x, 0);
  return out;
}

// One-sided CUSUM on robust z-scores: z = (v − median) / max(1.4826·MAD, minScale·|median|).
export function zCusum(series, { k = 0.5, h = 5, minScale = 0.05, cap = 3 } = {}) {
  const out = [];
  let S = 0, start = null, cur = null;
  for (const p of series) {
    const z = (p.v - p.med) / Math.max(p.scale, minScale * Math.abs(p.med), 1e-9);
    const prev = S;
    S = Math.min(cap * h, Math.max(0, S + z - k));
    if (prev === 0 && S > 0) start = p.t0;
    if (!cur && S > h) cur = { from: start ?? p.t0, alarmAt: p.t, peak: p.v, base: p.med };
    if (cur) cur.peak = Math.max(cur.peak, p.v);
    if (S === 0) { if (cur) { cur.to = p.t; out.push(cur); cur = null; } start = null; }
  }
  if (cur) { cur.to = series.length ? series[series.length - 1].t : cur.alarmAt; out.push(cur); }
  return out;
}

// Job-failure incidents from the store. Failed jobs only (retries are attempts of a job that may still succeed).
//   where: limit to some jobs (one cluster, one source)
export function detectJobFailures(store, { from, to, binS = 300, ratio = 3, minExcess = 3, h = 6, minFailures = 5, days = 7, where } = {}) {
  const hist = Math.max(days, 1) * 86400 + 86400;
  const jobs = store.query('job', { from: from != null ? from - hist : undefined, to, where: j => j.status === 'failed' && (!where || where(j)) });
  if (!jobs.length) return [];
  const counts = new Map();
  for (const j of jobs) { const b = Math.floor(j.t / binS) * binS; counts.set(b, (counts.get(b) || 0) + 1); }
  // observation starts with the first job of any outcome: quiet bins before the first failure are zeros, not unknown
  const firstSeen = (store.query('job', { from: from != null ? from - hist : undefined, to, limit: 1, where: j => !where || where(j) })[0] || {}).t;
  const lo = Math.floor(Math.min(firstSeen ?? Infinity, ...counts.keys()) / binS) * binS, hi = Math.floor((to ?? Math.max(...jobs.map(j => j.t))) / binS) * binS;
  const bins = []; for (let b = lo; b <= hi; b += binS) bins.push(b);
  const base = seasonalBaseline(counts, bins, { binS, days, first: lo });
  const series = bins.map((t, i) => ({ t, x: counts.get(t) || 0, base: base[i] }));
  return poissonCusum(series, { binS, ratio, minExcess, h })
    .filter(r => r.sum >= minFailures && (from == null || r.to > from))
    .map(r => ({ symptom: 'job-failures', from: r.from, to: r.to, alarmAt: r.alarmAt, failures: r.sum, peak: r.peak, baselinePerBin: +r.base.toFixed(2), binS, method: 'cusum', id: `job-failures@${iso(r.from)}` }));
}

// Serving latency incidents: CUSUM on each pool's TTFT and TPOT p99 against its seasonal median; with `targets`,
// windows above the target are incidents as well (the SLO is broken whatever the baseline says).
export function detectServing(store, { from, to, targets = {}, k = 0.5, h = 5, days = 7, metrics = ['ttftP99', 'tpotP99'] } = {}) {
  const recs = store.query('serving', { from: from != null ? from - (days + 1) * 86400 : undefined, to });
  const out = [];
  for (const pool of [...new Set(recs.map(r => r.pool))]) {
    const rs = recs.filter(r => r.pool === pool);
    for (const m of metrics) {
      const pts = rs.filter(r => Number.isFinite(r[m]));
      if (pts.length < 6) continue;
      const series = pts.map(r => {
        const same = [], trail = pts.filter(x => x.t < r.t && x.t >= r.t - 86400).map(x => x[m]);
        for (let d = 1; d <= days; d++) for (const x of pts) if (Math.abs(x.t - (r.t - d * 86400)) <= (r.windowS || 300) / 2) same.push(x[m]);
        const ref = same.length >= 6 ? same : trail;
        const med = median(ref), mad = median(ref.map(v => Math.abs(v - med)));
        return { t: r.t, t0: r.t - (r.windowS || 300), v: r[m], med, scale: 1.4826 * (mad || 0) };
      }).filter(p => Number.isFinite(p.med));
      for (const r of zCusum(series, { k, h })) if (from == null || r.to > from) out.push({ symptom: 'latency', pool, metric: m, from: r.from, to: r.to, alarmAt: r.alarmAt, peak: r.peak, baseline: r.base, method: 'cusum' });
      const lim = (targets[pool] || {})[m];
      if (Number.isFinite(lim)) {
        let cur = null;
        for (const r of pts) {
          if (from != null && r.t <= from) continue;
          if (r[m] > lim) { if (cur && r.t - cur.to <= 2 * (r.windowS || 300)) { cur.to = r.t; cur.peak = Math.max(cur.peak, r[m]); } else { cur = { symptom: 'latency', pool, metric: m, from: r.t - (r.windowS || 300), to: r.t, alarmAt: r.t, peak: r[m], limit: lim, method: 'target' }; out.push(cur); } }
        }
      }
    }
  }
  return out.map(i => Object.assign(i, { id: `latency:${i.pool}:${i.metric}@${iso(i.from)}` }));
}

// Fold incidents that are one event: same symptom (and pool) with windows that overlap or sit within `gapS`. Different
// symptoms that overlap are linked (`related`), not merged, since each may need its own diagnosis.
export function groupIncidents(list, { gapS = 1800 } = {}) {
  const key = i => `${i.symptom}|${i.pool || ''}`;
  const sorted = list.slice().sort((a, b) => a.from - b.from), out = [];
  for (const i of sorted) {
    const g = out.find(x => key(x) === key(i) && i.from <= x.to + gapS);
    if (g) {
      g.to = Math.max(g.to, i.to); g.alarmAt = Math.min(g.alarmAt ?? Infinity, i.alarmAt ?? Infinity);
      if (i.failures) g.failures = (g.failures || 0) + i.failures;
      g.peak = Math.max(g.peak || 0, i.peak || 0);
      g.metrics = [...new Set([...(g.metrics || [g.metric]), i.metric].filter(Boolean))];
      g.merged = [...(g.merged || []), i.id];
    } else out.push(Object.assign({}, i));
  }
  for (const a of out) a.related = out.filter(b => b !== a && b.from < a.to + gapS && a.from < b.to + gapS).map(b => b.id);
  for (const a of out) if (!a.related.length) delete a.related;
  return out;
}
