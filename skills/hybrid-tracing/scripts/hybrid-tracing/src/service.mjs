// skew-corrector: an OTLP/HTTP (JSON) pass-through that corrects clock skew on the way to the trace store.
//
//   collector (otlphttp, encoding: json) --> POST /v1/traces --> skew-corrector --> POST <downstream> (Tempo, Jaeger, …)
//
// It learns offsets continuously from cross-machine client/server pairs (kept for `sampleTtlMs`), re-solves them
// every `resolveMs`, and shifts each span by its machine's current offset before forwarding. Requests are forwarded
// as they arrive (no batching delay); until enough exchanges have been seen, spans pass through unchanged.
//
//   GET /offsets   current offsets as JSON      GET /metrics   Prometheus text      GET /healthz
import http from 'node:http';
import zlib from 'node:zlib';
import { collect, sampleOf, estimateFromSamples, apply, violations } from './skew.mjs';

export function createCorrector(opts = {}) {
  const o = Object.assign({ windowMs: 60_000, sampleTtlMs: 15 * 60_000, resolveMs: 30_000, maxSamplesPerPair: 4000, refSite: 'onprem', siteKey: 'site', minCorrectionNs: 0, headers: {} }, opts);
  const traces = new Map();        // traceId -> { seen, spans: Map(spanId -> span) }   recent spans, as recorded
  const pairs = new Map();         // "a\0b" -> [{t, sample}]
  const domainSite = new Map();
  let offsets = Object.assign({}, o.known || {}), last = null;
  const m = { requests: 0, spans: 0, corrected: 0, forwardErrors: 0, rejected: 0, violationsBefore: 0, violationsAfter: 0, solves: 0 };

  function remember(sp, now) {
    domainSite.set(sp.domain, sp.site || domainSite.get(sp.domain) || '');
    let tr = traces.get(sp.traceId);
    if (!tr) { tr = { seen: now, spans: new Map() }; traces.set(sp.traceId, tr); }
    tr.seen = now;
    tr.spans.set(sp.spanId, sp);
    const add = smp => {
      if (!smp) return;
      const k = smp.a + '\u0000' + smp.b;
      if (!pairs.has(k)) pairs.set(k, []);
      const arr = pairs.get(k); arr.push({ t: now, s: smp });
      if (arr.length > o.maxSamplesPerPair) arr.splice(0, arr.length - o.maxSamplesPerPair);
    };
    if (sp.parent) add(sampleOf(tr.spans.get(sp.parent), sp));
    for (const c of tr.spans.values()) if (c.parent === sp.spanId) add(sampleOf(sp, c));
  }
  function prune(now) {
    for (const [k, tr] of traces) if (now - tr.seen > o.windowMs) traces.delete(k);
    for (const [k, arr] of pairs) { const keep = arr.filter(x => now - x.t <= o.sampleTtlMs); if (keep.length) pairs.set(k, keep); else pairs.delete(k); }
  }
  function resolve(now = Date.now()) {
    prune(now);
    const two = [], one = [];
    for (const arr of pairs.values()) for (const x of arr) (x.s.two ? two : one).push(x.s);
    last = estimateFromSamples([...domainSite.entries()], two, one, o);
    offsets = Object.assign({}, o.known || {}, last.offsets);
    m.solves++;
    return last;
  }
  // Corrects one OTLP request object in place and returns it.
  function ingest(req, now = Date.now()) {
    const spans = collect([req], o);
    for (const sp of spans) remember(sp, now);
    m.requests++; m.spans += spans.length;
    const vb = violations(spans);
    m.corrected += apply(spans, offsets, o);
    const va = violations(collect([req], o));
    m.violationsBefore += vb.startBeforeParent + vb.endAfterParent;
    m.violationsAfter += va.startBeforeParent + va.endAfterParent;
    return req;
  }
  function metricsText() {
    const lines = [];
    const g = (name, help, type, rows) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows); };
    const lbl = r => `domain="${r.domain.replace(/"/g, '')}",site="${(r.site || '').replace(/"/g, '')}",method="${r.method}"`;
    const rows = last ? last.rows : [];
    g('clock_skew_offset_seconds', 'Estimated clock offset of the machine relative to the reference site (positive = clock ahead)', 'gauge', rows.filter(r => r.offsetNs != null).map(r => `clock_skew_offset_seconds{${lbl(r)}} ${r.offsetNs / 1e9}`));
    g('clock_skew_uncertainty_seconds', 'Bound on the offset estimate (half the best round trip)', 'gauge', rows.filter(r => r.errNs != null).map(r => `clock_skew_uncertainty_seconds{${lbl(r)}} ${r.errNs / 1e9}`));
    g('clock_skew_exchanges', 'Cross-machine exchanges behind the estimate', 'gauge', rows.map(r => `clock_skew_exchanges{${lbl(r)}} ${r.samples || 0}`));
    g('skew_corrector_spans_total', 'Spans received', 'counter', [`skew_corrector_spans_total ${m.spans}`]);
    g('skew_corrector_spans_corrected_total', 'Spans shifted', 'counter', [`skew_corrector_spans_corrected_total ${m.corrected}`]);
    g('skew_corrector_causality_violations_total', 'Cross-machine parent/child ordering violations seen in incoming batches', 'counter', [`skew_corrector_causality_violations_total{phase="before"} ${m.violationsBefore}`, `skew_corrector_causality_violations_total{phase="after"} ${m.violationsAfter}`]);
    g('skew_corrector_forward_errors_total', 'Batches the downstream refused or could not be reached for', 'counter', [`skew_corrector_forward_errors_total ${m.forwardErrors}`]);
    return lines.join('\n') + '\n';
  }
  return { ingest, resolve, metricsText, metrics: m, get offsets() { return offsets; }, get report() { return last; }, opts: o };
}

export function startServer(opts = {}) {
  const c = createCorrector(opts);
  const timer = setInterval(() => { try { c.resolve(); } catch (e) { console.error('resolve failed:', e.message); } }, c.opts.resolveMs);
  timer.unref();
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
    if (req.method === 'GET' && req.url === '/metrics') return send(200, c.metricsText(), 'text/plain; version=0.0.4');
    if (req.method === 'GET' && req.url === '/offsets') return send(200, { offsets: c.offsets, rows: c.report ? c.report.rows : [], metrics: c.metrics });
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/traces') return send(404, { error: 'POST OTLP/JSON to /v1/traces' });
    if (!/json/.test(req.headers['content-type'] || '')) { c.metrics.rejected++; return send(415, { error: 'Send OTLP/JSON: set `encoding: json` on the collector\'s otlphttp exporter.' }); }
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      let body;
      try {
        let buf = Buffer.concat(chunks);
        if (/gzip/.test(req.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf);
        body = JSON.parse(buf.toString('utf8'));
      } catch (e) { c.metrics.rejected++; return send(400, { error: 'Body is not OTLP/JSON: ' + e.message }); }
      try { c.ingest(body); } catch (e) { c.metrics.rejected++; return send(400, { error: 'Could not read spans: ' + e.message }); }
      if (!c.opts.downstream) return send(200, {});
      try {
        const r = await fetch(c.opts.downstream, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, c.opts.headers), body: JSON.stringify(body) });
        if (!r.ok) { c.metrics.forwardErrors++; return send(r.status === 429 || r.status >= 500 ? 503 : 502, { error: `downstream answered ${r.status}` }); }
        send(200, {});
      } catch (e) { c.metrics.forwardErrors++; send(503, { error: 'downstream unreachable: ' + e.message }); }
    });
  });
  server.on('close', () => clearInterval(timer));
  return { server, corrector: c };
}
