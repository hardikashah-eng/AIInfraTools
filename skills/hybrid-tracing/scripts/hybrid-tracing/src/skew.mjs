// Clock-skew estimation and correction for OTLP traces that span several machines and sites.
//
// Every span is stamped by the clock of the machine that recorded it (its "clock domain"). When a CLIENT span on
// machine A has a SERVER child on machine B, the four timestamps form an NTP exchange:
//   t1 = client start (A)   t2 = server start (B)   t3 = server end (B)   t4 = client end (A)
//   offset  θ = ((t2 - t1) + (t3 - t4)) / 2      (B's clock minus A's clock)
//   delay   δ = (t4 - t1) - (t3 - t2)            (network round trip; error of θ is at most δ/2)
// The samples with the smallest δ give the tightest estimate (as in NTP's clock filter). Pairwise estimates are
// combined in a weighted least-squares solve over all machines, anchored to the reference site (on-prem, PTP-synced).
// Producer/consumer and other one-way hops only bound the offset; they are used for machines that have no
// two-way exchange, and reported as violations otherwise.

export const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
const KIND_NAMES = { SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5 };
export const DOMAIN_KEYS = ['host.name', 'k8s.node.name', 'host.id', 'service.instance.id', 'service.name'];
export const CORRECTED_ATTR = 'clock.skew_corrected_ns';

export function kindOf(k) {
  if (typeof k === 'number') return k;
  if (typeof k === 'string') return KIND_NAMES[k] || (Number(k) || 0);
  return 0;
}
function attrValue(v) {
  if (!v) return undefined;
  for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (k in v) return v[k];
  return undefined;
}
export function attrs(list) { const o = {}; for (const a of list || []) o[a.key] = attrValue(a.value); return o; }

// OTLP/JSON: one ExportTraceServiceRequest object, an array of them, or JSON lines (the collector's file exporter).
export function readRequests(text) {
  const t = String(text).trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.resourceSpans)) return [j];
  } catch (e) { /* fall through to JSON lines */ }
  return t.split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`Line ${i + 1} is not valid JSON: ${e.message}`); }
  });
}

// Flattens requests into span records that keep the timestamps as recorded (BigInt ns) and a handle to the raw span.
export function collect(requests, opts = {}) {
  const siteKey = opts.siteKey || 'site';
  const spans = [];
  for (const req of requests || []) {
    for (const rs of req.resourceSpans || []) {
      const ra = attrs(rs.resource && rs.resource.attributes);
      const key = DOMAIN_KEYS.find(k => ra[k] != null && ra[k] !== '');
      const domain = key ? String(ra[key]) : 'unknown';
      const site = ra[siteKey] != null ? String(ra[siteKey]) : '';
      for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
        for (const sp of ss.spans || []) {
          if (sp.startTimeUnixNano == null || sp.endTimeUnixNano == null) continue;
          spans.push({
            traceId: sp.traceId, spanId: sp.spanId, parent: sp.parentSpanId || '', kind: kindOf(sp.kind), name: sp.name,
            start: BigInt(sp.startTimeUnixNano), end: BigInt(sp.endTimeUnixNano), domain, site, raw: sp,
          });
        }
      }
    }
  }
  return spans;
}

// One parent/child pair across clock domains -> a sample (or null).
export function sampleOf(p, c) {
  if (!p || !c || p.domain === c.domain) return null;
  const d1 = Number(c.start - p.start), d2 = Number(c.end - p.end);
  if (p.kind === KIND.CLIENT && c.kind === KIND.SERVER) {
    const delay = Number(p.end - p.start) - Number(c.end - c.start);
    if (delay < 0) return null; // server outlasted its client: no usable exchange (rate drift or a bad span)
    return { two: true, a: p.domain, b: c.domain, theta: (d1 + d2) / 2, delay };
  }
  return { two: false, a: p.domain, b: c.domain, bound: d1 }; // clock(b) - clock(a) <= d1: a child cannot start before its parent
}

export function pairSamples(spans) {
  const byId = new Map();
  for (const s of spans) byId.set(s.traceId + '/' + s.spanId, s);
  const two = [], one = [];
  for (const c of spans) {
    if (!c.parent) continue;
    const smp = sampleOf(byId.get(c.traceId + '/' + c.parent), c);
    if (smp) (smp.two ? two : one).push(smp);
  }
  return { two, one };
}

const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Per unordered pair of domains: estimate from the lowest-delay samples.
export function pairEstimates(two, opts = {}) {
  const frac = opts.bestFraction || 0.2, minBest = opts.minBest || 3;
  const groups = new Map();
  for (const s of two) {
    const [a, b, th] = s.a < s.b ? [s.a, s.b, s.theta] : [s.b, s.a, -s.theta];
    const k = a + '\u0000' + b;
    if (!groups.has(k)) groups.set(k, { a, b, s: [] });
    groups.get(k).s.push({ theta: th, delay: s.delay });
  }
  const out = [];
  for (const g of groups.values()) {
    g.s.sort((x, y) => x.delay - y.delay);
    const k = Math.min(g.s.length, Math.max(minBest, Math.ceil(g.s.length * frac)));
    const best = g.s.slice(0, k), theta = median(best.map(x => x.theta));
    const spread = median(best.map(x => Math.abs(x.theta - theta)));
    const err = best[0].delay / 2 + spread;
    out.push({ a: g.a, b: g.b, theta, err, n: g.s.length, used: k, w: k / Math.max(err * err, 1e6) });
  }
  return out;
}

// Weighted least squares over the domain graph, anchored to the reference site.
export function solve(domains, edges, opts = {}) {
  const refSite = opts.refSite == null ? 'onprem' : opts.refSite;
  const adj = new Map([...domains.keys()].map(d => [d, []]));
  for (const e of edges) { adj.get(e.a).push({ u: e.b, theta: e.theta, w: e.w, err: e.err }); adj.get(e.b).push({ u: e.a, theta: -e.theta, w: e.w, err: e.err }); }
  const x = new Map(), info = new Map(), seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start) || !adj.get(start).length) continue;
    const comp = []; const q = [start]; seen.add(start);
    while (q.length) { const v = q.shift(); comp.push(v); for (const n of adj.get(v)) if (!seen.has(n.u)) { seen.add(n.u); q.push(n.u); } }
    const wsum = v => adj.get(v).reduce((s, n) => s + n.w, 0);
    const refs = comp.filter(v => domains.get(v).site === refSite);
    const anchor = (refs.length ? refs : comp).slice().sort((p, q2) => wsum(q2) - wsum(p))[0];
    // initial guess along a BFS tree, then Gauss-Seidel
    x.set(anchor, 0); const q2 = [anchor], done = new Set([anchor]);
    while (q2.length) { const v = q2.shift(); for (const n of adj.get(v)) if (!done.has(n.u)) { done.add(n.u); x.set(n.u, x.get(v) + n.theta); q2.push(n.u); } }
    for (let it = 0; it < 500; it++) {
      let delta = 0;
      for (const v of comp) {
        if (v === anchor) continue;
        let num = 0, den = 0;
        for (const n of adj.get(v)) { num += n.w * (x.get(n.u) - n.theta); den += n.w; }
        const nv = num / den; delta = Math.max(delta, Math.abs(nv - x.get(v))); x.set(v, nv);
      }
      if (delta < 0.5) break;
    }
    if (refs.length) { const shift = median(refs.map(v => x.get(v))); for (const v of comp) x.set(v, x.get(v) - shift); }
    for (const v of comp) {
      const ns = adj.get(v);
      const err = ns.length ? Math.min(...ns.map(n => n.err)) : 0;
      const samples = edges.filter(e => e.a === v || e.b === v).reduce((t, e) => t + e.n, 0);
      info.set(v, { method: v === anchor && refs.length ? 'reference' : 'two-way', anchored: refs.length > 0, err, samples });
    }
  }
  return { x, info };
}

// Full estimate from span records: pairwise two-way exchanges, then one-way bounds, then measured offsets (known).
export function estimate(spans, opts = {}) {
  const { two, one } = pairSamples(spans);
  return estimateFromSamples(spans.map(s => [s.domain, s.site]), two, one, opts);
}
export function estimateFromSamples(domainSites, two, one, opts = {}) {
  const domains = new Map();
  for (const [d, site] of domainSites) if (!domains.has(d) || (!domains.get(d).site && site)) domains.set(d, { site: site || '' });
  for (const s of two.concat(one)) for (const d of [s.a, s.b]) if (!domains.has(d)) domains.set(d, { site: '' });
  const edges = pairEstimates(two, opts);
  const { x, info } = solve(domains, edges, opts);
  // one-way bounds for domains the two-way solve could not anchor. A one-way hop also took network time, so the
  // bound is tightened by the smallest one-way latency seen between the same two sites (half the minimum round trip).
  const anchored = d => info.has(d) && info.get(d).anchored;
  const siteOf = d => domains.get(d).site, sk = (p, q) => [p, q].sort().join('\u0000');
  const minHop = new Map();
  for (const s of two) { const k = sk(siteOf(s.a), siteOf(s.b)); minHop.set(k, Math.min(minHop.has(k) ? minHop.get(k) : Infinity, s.delay / 2)); }
  const hop = s => opts.oneWayLatencyNs != null ? opts.oneWayLatencyNs : (minHop.get(sk(siteOf(s.a), siteOf(s.b))) || 0);
  // Each one-way hop gives a candidate; the tightest is used, less a margin equal to the jitter between the
  // tightest few, so that a later, slightly faster hop does not land before its parent.
  const upper = new Map(), lower = new Map();
  const push = (m, d, v) => { if (!m.has(d)) m.set(d, []); m.get(d).push(v); };
  for (const s of one) {
    if (anchored(s.a) && !anchored(s.b)) push(upper, s.b, x.get(s.a) + s.bound - hop(s));
    if (anchored(s.b) && !anchored(s.a)) push(lower, s.a, x.get(s.b) - s.bound + hop(s));
  }
  const tight = (vals, dir) => {
    const v = vals.slice().sort((p, q) => dir * (p - q)); // dir 1: ascending (upper bounds), -1: descending (lower)
    const k = Math.min(v.length - 1, 4), margin = Math.max(1000, Math.abs(v[k] - v[0]));
    return v[0] - dir * margin;
  };
  for (const d of new Set([...upper.keys(), ...lower.keys()])) {
    const u = upper.has(d) ? tight(upper.get(d), 1) : null, l = lower.has(d) ? tight(lower.get(d), -1) : null;
    const v = u != null && l != null ? (u >= l ? (u + l) / 2 : u) : u != null ? u : l;
    const n = (upper.get(d) || []).length + (lower.get(d) || []).length;
    x.set(d, v); info.set(d, { method: 'bound', anchored: true, err: u != null && l != null && u >= l ? (u - l) / 2 : null, samples: n });
  }
  for (const [d, ns] of Object.entries(opts.known || {})) {
    if (!domains.has(d) || anchored(d) && info.get(d).method !== 'bound') continue;
    x.set(d, Number(ns)); info.set(d, { method: 'measured', anchored: true, err: null, samples: 0 });
  }
  // one-way bounds that the solution still breaks
  let boundViolations = 0;
  for (const s of one) if (anchored(s.a) && anchored(s.b) && x.get(s.b) - x.get(s.a) > s.bound + 1000) boundViolations++;
  const rows = [...domains.entries()].map(([d, v]) => {
    const i = info.get(d);
    const ok = i && i.anchored;
    return { domain: d, site: v.site, offsetNs: ok ? Math.round(x.get(d)) : null, errNs: ok && i.err != null ? Math.round(i.err) : null, method: i ? (i.anchored ? i.method : 'unanchored') : 'none', samples: i ? i.samples : 0 };
  }).sort((p, q) => (p.site + p.domain).localeCompare(q.site + q.domain));
  return { rows, offsets: Object.fromEntries(rows.filter(r => r.offsetNs != null).map(r => [r.domain, r.offsetNs])), edges, boundViolations, twoWaySamples: two.length, oneWaySamples: one.length };
}

// Shifts every span of a domain by its offset (corrected = recorded - offset). Mutates the raw OTLP spans.
export function apply(spans, offsets, opts = {}) {
  const min = opts.minCorrectionNs || 0;
  let corrected = 0;
  for (const s of spans) {
    const off = offsets[s.domain];
    if (off == null || Math.abs(off) < min || off === 0) continue;
    const o = BigInt(Math.round(off));
    s.raw.startTimeUnixNano = String(s.start - o);
    s.raw.endTimeUnixNano = String(s.end - o);
    s.raw.attributes = (s.raw.attributes || []).filter(a => a.key !== CORRECTED_ATTR);
    s.raw.attributes.push({ key: CORRECTED_ATTR, value: { intValue: String(Math.round(off)) } });
    corrected++;
  }
  return corrected;
}

// Cross-domain causality checks: a child must start after its parent; a server must end before its client.
export function violations(spans) {
  const byId = new Map();
  for (const s of spans) byId.set(s.traceId + '/' + s.spanId, s);
  let checked = 0, startBeforeParent = 0, endAfterParent = 0;
  for (const c of spans) {
    const p = c.parent && byId.get(c.traceId + '/' + c.parent);
    if (!p || p.domain === c.domain) continue;
    checked++;
    if (c.start < p.start) startBeforeParent++;
    if (p.kind === KIND.CLIENT && c.kind === KIND.SERVER && c.end > p.end) endAfterParent++;
  }
  return { checked, startBeforeParent, endAfterParent };
}

// Estimate and correct in one go. Returns the corrected requests and a report.
export function fix(requests, opts = {}) {
  const spans = collect(requests, opts);
  const before = violations(spans);
  const est = estimate(spans, opts);
  const corrected = opts.dryRun ? 0 : apply(spans, est.offsets, opts);
  const after = opts.dryRun ? before : violations(collect(requests, opts));
  return { requests, report: Object.assign({ spans: spans.length, corrected, before, after }, est) };
}
