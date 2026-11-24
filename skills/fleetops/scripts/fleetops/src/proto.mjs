// Prometheus remote_write without dependencies: Snappy block decompression and the protobuf WriteRequest.
//   WriteRequest { repeated TimeSeries timeseries = 1; }
//   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
//   Label        { string name = 1; string value = 2; }
//   Sample       { double value = 1; int64 timestamp = 2; }   (milliseconds)
// The encoders exist for tests and the ingest benchmark (Snappy output is literal-only, which every decoder accepts).

// ---------- Snappy (block format) ----------
export function snappyDecompress(buf) {
  let p = 0, len = 0, shift = 0, b;
  do { b = buf[p++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  const out = Buffer.allocUnsafe(len);
  let o = 0;
  while (p < buf.length) {
    const tag = buf[p++], type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n |= buf[p++] << (8 * i); }
      n += 1;
      buf.copy(out, o, p, p + n); p += n; o += n;
    } else {
      let n, off;
      if (type === 1) { n = 4 + ((tag >> 2) & 7); off = ((tag >> 5) << 8) | buf[p++]; }
      else if (type === 2) { n = 1 + (tag >> 2); off = buf[p] | (buf[p + 1] << 8); p += 2; }
      else { n = 1 + (tag >> 2); off = buf.readUInt32LE(p); p += 4; }
      if (!off || off > o) throw new Error('snappy: bad copy offset');
      for (let i = 0; i < n; i++, o++) out[o] = out[o - off]; // byte by byte: copies may overlap
    }
  }
  if (o !== len) throw new Error(`snappy: ${o} bytes decoded, header said ${len}`);
  return out;
}
export function snappyCompressLiteral(buf) {
  const parts = [varintBuf(buf.length)];
  for (let p = 0; p < buf.length; p += 65536) {
    const chunk = buf.subarray(p, Math.min(buf.length, p + 65536)), n = chunk.length - 1;
    parts.push(n < 60 ? Buffer.from([n << 2]) : n < 256 ? Buffer.from([60 << 2, n]) : Buffer.from([61 << 2, n & 255, n >> 8]), chunk);
  }
  return Buffer.concat(parts);
}

// ---------- protobuf ----------
function varintBuf(n) { const a = []; while (n > 127) { a.push((n & 127) | 128); n = Math.floor(n / 128); } a.push(n); return Buffer.from(a); }
function* fields(buf, start = 0, end = buf.length) {
  let p = start;
  while (p < end) {
    let key = 0, shift = 0, b;
    do { b = buf[p++]; key += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    const no = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { let v = 0n, sh = 0n; do { b = buf[p++]; v |= BigInt(b & 0x7f) << sh; sh += 7n; } while (b & 0x80); yield { no, wt, v: Number(v), big: v }; }
    else if (wt === 1) { yield { no, wt, v: buf.readDoubleLE(p), raw: p }; p += 8; }
    else if (wt === 2) { let n = 0; shift = 0; do { b = buf[p++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); if (!(p + n <= end) || p > end) throw new Error('protobuf: truncated message'); yield { no, wt, start: p, end: p + n }; p += n; }
    else if (wt === 5) { yield { no, wt, raw: p }; p += 4; }
    else throw new Error(`protobuf: wire type ${wt} not supported`);
    if (p > end) throw new Error('protobuf: truncated message');
  }
}

// WriteRequest bytes (already decompressed) → [{ labels: { __name__, … }, samples: [{ v, t (seconds) }] }]
export function decodeWriteRequest(buf) {
  const out = [];
  for (const f of fields(buf)) {
    if (f.no !== 1 || f.wt !== 2) continue;
    const ts = { labels: {}, samples: [] };
    for (const g of fields(buf, f.start, f.end)) {
      if (g.no === 1 && g.wt === 2) {
        let name = '', value = '';
        for (const h of fields(buf, g.start, g.end)) if (h.wt === 2) { const s = buf.toString('utf8', h.start, h.end); if (h.no === 1) name = s; else if (h.no === 2) value = s; }
        ts.labels[name] = value;
      } else if (g.no === 2 && g.wt === 2) {
        let v = NaN, t = 0;
        for (const h of fields(buf, g.start, g.end)) { if (h.no === 1 && h.wt === 1) v = h.v; else if (h.no === 2 && h.wt === 0) t = h.v; }
        ts.samples.push({ v, t: t / 1000 });
      }
    }
    out.push(ts);
  }
  return out;
}
const ld = (no, b) => Buffer.concat([varintBuf(no * 8 + 2), varintBuf(b.length), b]);
export function encodeWriteRequest(series) {
  return Buffer.concat(series.map(s => ld(1, Buffer.concat([
    ...Object.entries(s.labels).map(([k, v]) => ld(1, Buffer.concat([ld(1, Buffer.from(k)), ld(2, Buffer.from(String(v)))]))),
    ...s.samples.map(x => { const d = Buffer.alloc(8); d.writeDoubleLE(x.v); return ld(2, Buffer.concat([Buffer.from([9]), d, Buffer.from([16]), varintBuf(Math.round(x.t * 1000))])); }),
  ]))));
}

// ---------- OTLP over HTTP, protobuf ----------
// ExportTraceServiceRequest / ExportLogsServiceRequest / ExportMetricsServiceRequest decoded into the OTLP JSON
// mapping (hex trace and span ids, 64-bit integers as strings), so the JSON converters handle both encodings.
// Field numbers from opentelemetry-proto (checked against fixtures encoded by protobufjs from the official .proto files).
const L = true;
const OTLP = {
  traces: { 1: ['resourceSpans', 'ResourceSpans', L] }, logs: { 1: ['resourceLogs', 'ResourceLogs', L] }, metrics: { 1: ['resourceMetrics', 'ResourceMetrics', L] },
  ResourceSpans: { 1: ['resource', 'Resource'], 2: ['scopeSpans', 'ScopeSpans', L], 3: ['schemaUrl', 'string'] },
  ResourceLogs: { 1: ['resource', 'Resource'], 2: ['scopeLogs', 'ScopeLogs', L], 3: ['schemaUrl', 'string'] },
  ResourceMetrics: { 1: ['resource', 'Resource'], 2: ['scopeMetrics', 'ScopeMetrics', L], 3: ['schemaUrl', 'string'] },
  Resource: { 1: ['attributes', 'KeyValue', L] },
  Scope: { 1: ['name', 'string'], 2: ['version', 'string'], 3: ['attributes', 'KeyValue', L] },
  ScopeSpans: { 1: ['scope', 'Scope'], 2: ['spans', 'Span', L] }, ScopeLogs: { 1: ['scope', 'Scope'], 2: ['logRecords', 'LogRecord', L] }, ScopeMetrics: { 1: ['scope', 'Scope'], 2: ['metrics', 'Metric', L] },
  Span: { 1: ['traceId', 'hex'], 2: ['spanId', 'hex'], 3: ['traceState', 'string'], 4: ['parentSpanId', 'hex'], 5: ['name', 'string'], 6: ['kind', 'enum'], 7: ['startTimeUnixNano', 'fixed64'], 8: ['endTimeUnixNano', 'fixed64'], 9: ['attributes', 'KeyValue', L], 15: ['status', 'Status'], 16: ['flags', 'fixed32'] },
  Status: { 2: ['message', 'string'], 3: ['code', 'enum'] },
  LogRecord: { 1: ['timeUnixNano', 'fixed64'], 11: ['observedTimeUnixNano', 'fixed64'], 2: ['severityNumber', 'enum'], 3: ['severityText', 'string'], 5: ['body', 'AnyValue'], 6: ['attributes', 'KeyValue', L], 9: ['traceId', 'hex'], 10: ['spanId', 'hex'], 12: ['eventName', 'string'] },
  Metric: { 1: ['name', 'string'], 2: ['description', 'string'], 3: ['unit', 'string'], 5: ['gauge', 'Gauge'], 7: ['sum', 'Sum'] },
  Gauge: { 1: ['dataPoints', 'NumberDataPoint', L] }, Sum: { 1: ['dataPoints', 'NumberDataPoint', L], 2: ['aggregationTemporality', 'enum'], 3: ['isMonotonic', 'bool'] },
  NumberDataPoint: { 7: ['attributes', 'KeyValue', L], 2: ['startTimeUnixNano', 'fixed64'], 3: ['timeUnixNano', 'fixed64'], 4: ['asDouble', 'double'], 6: ['asInt', 'sfixed64'], 8: ['flags', 'uint32'] },
  KeyValue: { 1: ['key', 'string'], 2: ['value', 'AnyValue'] },
  AnyValue: { 1: ['stringValue', 'string'], 2: ['boolValue', 'bool'], 3: ['intValue', 'int64'], 4: ['doubleValue', 'double'], 5: ['arrayValue', 'ArrayValue'], 6: ['kvlistValue', 'KeyValueList'], 7: ['bytesValue', 'base64'] },
  ArrayValue: { 1: ['values', 'AnyValue', L] }, KeyValueList: { 1: ['values', 'KeyValue', L] },
};
function decodeMsg(buf, type, start, end) {
  const spec = OTLP[type], out = {};
  for (const f of fields(buf, start, end)) {
    const d = spec[f.no];
    if (!d) continue;
    const [name, t, rep] = d;
    let v;
    if (OTLP[t]) v = decodeMsg(buf, t, f.start, f.end);
    else if (t === 'string') v = buf.toString('utf8', f.start, f.end);
    else if (t === 'hex') v = buf.toString('hex', f.start, f.end);
    else if (t === 'base64') v = buf.toString('base64', f.start, f.end);
    else if (t === 'fixed64') v = buf.readBigUInt64LE(f.raw).toString();
    else if (t === 'sfixed64') v = buf.readBigInt64LE(f.raw).toString();
    else if (t === 'fixed32') v = buf.readUInt32LE(f.raw);
    else if (t === 'double') v = f.v;
    else if (t === 'int64') v = BigInt.asIntN(64, f.big).toString();
    else if (t === 'bool') v = f.v !== 0;
    else v = f.v; // enum, uint32
    if (rep) (out[name] = out[name] || []).push(v); else out[name] = v;
  }
  return out;
}
export const decodeOtlp = (kind, buf) => decodeMsg(buf, kind, 0, buf.length);
