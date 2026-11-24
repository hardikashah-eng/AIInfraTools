// Streaming ingestion: Prometheus remote_write and OTLP/HTTP (JSON) into the store, with a bounded queue,
// backpressure, idempotent dedupe and the server's own metrics.
//
//   POST /api/v1/write   Prometheus remote_write (snappy + protobuf): DCGM, AMD and SambaNova exporter series → device
//   POST /v1/metrics     OTLP metrics (JSON): the same exporter metrics through an OpenTelemetry collector → device
//   POST /v1/logs        OTLP logs (JSON): kernel and NCCL/PyTorch lines → log (same classifier as the file importers)
//   POST /v1/traces      OTLP traces (JSON) → span
//   GET  /metrics        fleetops' own metrics (Prometheus text);  GET /healthz
//
// OTLP/HTTP in protobuf (the collector default) or JSON, gzip or not. OTLP/gRPC (port 4317) is not served: use the
// collector's otlphttp exporter.
import http from 'node:http';
import { VENDORS } from '../../gpu-health/src/vendors.mjs';
import { exporterScrape } from './adapters/live.mjs';
import { kernelLog, ncclLog } from './adapters/logs.mjs';
import zlib from 'node:zlib';
import { snappyDecompress, decodeWriteRequest, decodeOtlp } from './proto.mjs';
import { authenticate, can, redact } from './security.mjs';
import { handleApi } from './api.mjs';

const VENDOR_RE = Object.entries(VENDORS).filter(([, p]) => p.detect).map(([k, p]) => [k, new RegExp(p.detect)]);
const vendorOf = name => (VENDOR_RE.find(([, re]) => re.test(name)) || [])[0];
const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Series (labels + samples) → device records: one exporter "scrape" per vendor and timestamp, through gpu-health's
// own mapping, so remote_write and a scraped /metrics give identical records.
export function seriesToDevices(series, { site } = {}) {
  const byKey = new Map(); // vendor|t → lines
  let unmapped = 0;
  for (const s of series) {
    const name = s.labels.__name__, vendor = name && vendorOf(name);
    if (!vendor) { unmapped += s.samples.length; continue; }
    const lab = Object.entries(s.labels).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${esc(v)}"`).join(',');
    for (const x of s.samples) {
      if (!Number.isFinite(x.v)) continue;
      const k = `${vendor}|${Math.round(x.t)}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(`${name}{${lab}} ${x.v}`);
    }
  }
  const out = [];
  for (const [k, lines] of byKey) {
    const [vendor, t] = k.split('|');
    try { out.push(...exporterScrape(lines.join('\n'), { vendor, t: +t, site, source: `remote-write:${vendor}` })); } catch { unmapped += lines.length; }
  }
  return { devices: out, unmapped };
}

const attrs = list => Object.fromEntries((list || []).map(a => [a.key, a.value && (a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue)]));
const nano = v => (v == null ? null : Number(BigInt(String(v)) / 1000000n) / 1000);
const hostOf = r => r['k8s.node.name'] || r['host.name'] || r['host'] || r['hostname'];

// OTLP metrics (JSON) → the series shape above (gauge and sum data points).
export function otlpMetricsToSeries(body) {
  const series = [];
  for (const rm of body.resourceMetrics || []) {
    const res = attrs((rm.resource || {}).attributes);
    for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
      const pts = ((m.gauge || m.sum || {}).dataPoints) || [];
      for (const p of pts) {
        const v = p.asDouble ?? (p.asInt != null ? Number(p.asInt) : NaN);
        const labels = Object.assign({ __name__: m.name }, hostOf(res) ? { Hostname: hostOf(res) } : {}, res, attrs(p.attributes));
        series.push({ labels, samples: [{ v, t: nano(p.timeUnixNano) ?? Date.now() / 1000 }] });
      }
    }
  }
  return series;
}

// OTLP logs (JSON) → log records, classified by the same patterns as kernel-log and app-log imports.
export function otlpLogsToRecords(body) {
  const out = [];
  let unmatched = 0;
  for (const rl of body.resourceLogs || []) {
    const res = attrs((rl.resource || {}).attributes), node = hostOf(res);
    for (const sl of rl.scopeLogs || []) for (const lr of sl.logRecords || []) {
      const text = lr.body && (lr.body.stringValue ?? JSON.stringify(lr.body)), t = nano(lr.timeUnixNano) ?? nano(lr.observedTimeUnixNano);
      const a = attrs(lr.attributes), n = node || hostOf(a);
      if (!text || t == null || !n) { unmatched++; continue; }
      const iso = new Date(t * 1000).toISOString();
      const recs = kernelLog(`${iso} ${n} ${text}`);
      const got = recs.length ? recs : ncclLog(text, { node: n, job: a['k8s.pod.name'] || res['k8s.pod.name'] || res['service.name'], t });
      if (got.length) out.push(...got.map(r => Object.assign(r, { source: `otlp:${r.source}` }))); else unmatched++;
    }
  }
  return { logs: out, unmatched };
}

// OTLP traces (JSON) → span records: { t (start), traceId, spanId, parentSpanId?, name, durS, service, node?, kind?, status?, attrs }.
export function otlpTracesToSpans(body) {
  const out = [];
  for (const rs of body.resourceSpans || []) {
    const res = attrs((rs.resource || {}).attributes);
    for (const ss of rs.scopeSpans || []) for (const sp of ss.spans || []) {
      const t = nano(sp.startTimeUnixNano), end = nano(sp.endTimeUnixNano);
      if (t == null || !sp.traceId || !sp.spanId) continue;
      const a = attrs(sp.attributes);
      const durS = sp.endTimeUnixNano != null ? Number(BigInt(String(sp.endTimeUnixNano)) - BigInt(String(sp.startTimeUnixNano))) / 1e9 : null; // exact, from integer nanoseconds
      out.push({ t, traceId: sp.traceId, spanId: sp.spanId, parentSpanId: sp.parentSpanId || undefined, name: sp.name, durS,
        service: res['service.name'], node: hostOf(res) || hostOf(a), kind: sp.kind, status: sp.status && sp.status.code, attrs: a, source: 'otlp' });
      for (const k of Object.keys(out.at(-1))) if (out.at(-1)[k] === undefined) delete out.at(-1)[k];
    }
  }
  return out;
}

// NCCL Inspector's Prometheus mode (nccl_collective_exec_time_microseconds, nccl_bus_bandwidth_gbs, …) → collective
// records, one per node, GPU, communicator, collective, message size and time.
export function seriesToCollectives(series) {
  const by = new Map();
  for (const s of series) {
    const n = s.labels.__name__, f = { nccl_collective_exec_time_microseconds: 'execUs', nccl_bus_bandwidth_gbs: 'busbw', nccl_p2p_exec_time_microseconds: 'execUs', nccl_p2p_bus_bandwidth_gbs: 'busbw' }[n];
    if (!f) continue;
    const L = s.labels, op = L.collective || L.p2p_operation;
    for (const x of s.samples) {
      const k = [L.node, L.gpu, L.comm_name, op, L.message_size, Math.round(x.t)].join('|');
      let r = by.get(k);
      if (!r) by.set(k, (r = { t: Math.round(x.t), node: L.node, gpu: L.gpu, comm: L.comm_name, op, msgSize: L.message_size, nranks: L.nranks != null ? +L.nranks : undefined, job: L.slurm_job_id, algoProto: L.algo_proto, source: 'nccl-inspector-prom' }));
      if (f === 'execUs') r.execS = x.v / 1e6; else r.busbw = x.v;
    }
  }
  return [...by.values()].map(r => { for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]; return r; });
}

// The queue between receivers and the store. Bounded (backpressure), dedupes repeated deliveries by record content
// within a window (remote_write and OTLP clients retry), flushes in batches.
export class Pipeline {
  constructor(store, { maxQueue = 200000, flushMs = 1000, batch = 50000, dedupeWindowS = 900, now = () => Date.now() / 1000 } = {}) {
    Object.assign(this, { store, maxQueue, flushMs, batch, dedupeWindowS, now });
    this.q = new Map(); this.depth = 0; this.seen = new Map();
    this.m = { received: {}, written: {}, duplicate: 0, rejected: 0, invalid: 0, unmapped: 0, late: 0, redacted: 0, flushes: 0, flushSeconds: 0 };
  }
  // Accept records of one kind, or refuse the whole batch when the queue is full (the sender retries).
  offer(kind, recs) {
    // dedupe first (a retry of an accepted batch is all duplicates and must not be refused), then check room; a refused
    // batch is not marked seen, so its retry is accepted
    const now = this.now(), lo = now - this.dedupeWindowS, keep = [], keys = [], inBatch = new Set();
    let dup = 0, late = 0;
    for (const r of recs) {
      if (r.t >= lo) {
        const key = kind + JSON.stringify(r), b = Math.floor(r.t / 60), s = this.seen.get(b);
        if ((s && s.has(key)) || inBatch.has(key)) { dup++; continue; }
        inBatch.add(key); keys.push([b, key]);
      } else late++;
      keep.push(r);
    }
    if (this.depth + keep.length > this.maxQueue) { this.m.rejected += keep.length; return false; }
    for (const [b, key] of keys) { let s = this.seen.get(b); if (!s) this.seen.set(b, (s = new Set())); s.add(key); }
    this.m.duplicate += dup; this.m.late += late;
    this.m.received[kind] = (this.m.received[kind] || 0) + keep.length;
    if (!this.q.has(kind)) this.q.set(kind, []);
    this.q.get(kind).push(...keep);
    this.depth += keep.length;
    for (const b of this.seen.keys()) if (b < Math.floor(lo / 60)) this.seen.delete(b);
    if (this.depth >= this.batch) this.flush();
    return true;
  }
  flush() {
    const t0 = process.hrtime.bigint();
    for (const [kind, recs] of this.q) {
      if (!recs.length) continue;
      const r = this.store.append(kind, recs);
      this.m.written[kind] = (this.m.written[kind] || 0) + r.written; this.m.invalid += r.invalid;
      this.q.set(kind, []);
    }
    if (this.store.flush) this.store.flush();
    this.depth = 0; this.m.flushes++; this.m.flushSeconds += Number(process.hrtime.bigint() - t0) / 1e9;
  }
  start() { this.timer = setInterval(() => { if (this.depth) this.flush(); }, this.flushMs); this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); this.flush(); }
  metrics() {
    const L = [];
    const c = (n, h, rows) => { L.push(`# HELP ${n} ${h}`, `# TYPE ${n} ${n.endsWith('_total') ? 'counter' : 'gauge'}`); for (const [lab, v] of rows) L.push(`${n}${lab} ${v}`); };
    c('fleetops_ingest_received_total', 'Records accepted into the queue, by kind.', Object.entries(this.m.received).map(([k, v]) => [`{kind="${k}"}`, v]));
    c('fleetops_ingest_written_total', 'Records written to the store, by kind.', Object.entries(this.m.written).map(([k, v]) => [`{kind="${k}"}`, v]));
    c('fleetops_ingest_dropped_total', 'Records not written, by reason.', [['{reason="duplicate"}', this.m.duplicate], ['{reason="queue_full"}', this.m.rejected], ['{reason="invalid"}', this.m.invalid], ['{reason="unmapped"}', this.m.unmapped]]);
    c('fleetops_ingest_late_total', 'Records older than the dedupe window (accepted, not deduped).', [['', this.m.late]]);
    c('fleetops_ingest_redacted_total', 'Request-content attributes dropped and secrets masked at ingest.', [['', this.m.redacted]]);
    c('fleetops_ingest_queue_depth', 'Records waiting to be written.', [['', this.depth]]);
    c('fleetops_ingest_flush_seconds_total', 'Time spent writing batches.', [['', this.m.flushSeconds.toFixed(3)]]);
    return L.join('\n') + '\n';
  }
}

// HTTP server over a pipeline: ingest endpoints, the read API (api.mjs), auth by token when `tokens` is given, every
// API call audited.
export function server(pipe, { site, maxBody = 32 << 20, tokens = null, audit = null, store = pipe.store } = {}) {
  const read = req => new Promise((res, rej) => { const parts = []; let n = 0; req.on('data', d => { n += d.length; if (n > maxBody) { rej(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); } else parts.push(d); }); req.on('end', () => res(Buffer.concat(parts))); req.on('error', rej); });
  const send = (res, code, body = '', type = 'text/plain') => { res.writeHead(code, Object.assign({ 'content-type': type }, code === 429 ? { 'retry-after': '1' } : {})); res.end(body); };
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, 'ok\n');
      const who = authenticate(tokens, req.headers.authorization);
      if (!who) return send(res, 401, 'a valid bearer token is required\n');
      if (req.method === 'GET' && req.url === '/metrics') return can(who, 'read') ? send(res, 200, pipe.metrics(), 'text/plain; version=0.0.4') : send(res, 403, 'needs the read role\n');
      if (req.method === 'GET' && req.url.startsWith('/api/')) {
        if (!can(who, 'read')) { if (audit) audit({ who: who.name, method: 'GET', path: req.url, status: 403 }); return send(res, 403, 'needs the read role\n'); }
        const r = handleApi(store, who, req.method, req.url);
        if (audit) audit({ who: who.name, tenant: who.tenant === '*' ? '*' : who.tenant, method: 'GET', path: req.url, status: r.status, records: r.records });
        return send(res, r.status, r.body, r.type);
      }
      if (req.method !== 'POST') return send(res, 404, 'not found\n');
      if (!can(who, 'ingest')) return send(res, 403, 'needs the ingest role\n');
      let body = await read(req);
      const enc = String(req.headers['content-encoding'] || '').toLowerCase(); // collectors gzip by default
      if (enc === 'gzip') body = zlib.gunzipSync(body); else if (enc === 'deflate') body = zlib.inflateSync(body); else if (enc && enc !== 'identity' && enc !== 'snappy') return send(res, 415, `content-encoding ${enc} not supported\n`);
      let kind, recs;
      if (req.url === '/api/v1/write') {
        const series = decodeWriteRequest(snappyDecompress(body)), coll = seriesToCollectives(series);
        if (coll.length && !pipe.offer('collective', coll)) return send(res, 429, 'queue full, retry\n');
        const r = seriesToDevices(series.filter(x => !/^nccl_/.test(x.labels.__name__ || '')), { site }); pipe.m.unmapped += r.unmapped; kind = 'device'; recs = r.devices;
      } else if (/^\/v1\/(metrics|logs|traces)$/.test(req.url)) {
        const ct = req.headers['content-type'] || '', kindOf = req.url.slice(4);
        if (!/json|protobuf/.test(ct)) return send(res, 415, 'OTLP must be application/json or application/x-protobuf\n');
        const proto = /protobuf/.test(ct), j = proto ? decodeOtlp(kindOf, body) : JSON.parse(body.toString('utf8'));
        if (req.url === '/v1/metrics') { const r = seriesToDevices(otlpMetricsToSeries(j), { site }); pipe.m.unmapped += r.unmapped; kind = 'device'; recs = r.devices; }
        else if (req.url === '/v1/logs') { const r = otlpLogsToRecords(j); pipe.m.unmapped += r.unmatched; kind = 'log'; recs = r.logs; }
        else { kind = 'span'; recs = otlpTracesToSpans(j); }
      } else return send(res, 404, 'not found\n');
      pipe.m.redacted += redact(kind, recs); // request content never reaches the store
      if (!pipe.offer(kind, recs)) return send(res, 429, 'queue full, retry\n');
      // OTLP/HTTP: answer in the request's encoding (an empty Export*ServiceResponse is zero bytes in protobuf)
      if (req.url === '/api/v1/write') return send(res, 204, '', 'text/plain');
      return /protobuf/.test(req.headers['content-type'] || '') ? send(res, 200, Buffer.alloc(0), 'application/x-protobuf') : send(res, 200, '{}', 'application/json');
    } catch (e) { return send(res, e.code === 413 ? 413 : 400, `${e.message}\n`); }
  });
}
