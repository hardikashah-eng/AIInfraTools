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
    if (wt === 0) { let v = 0; shift = 0; do { b = buf[p++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); yield { no, wt, v }; }
    else if (wt === 1) { yield { no, wt, v: buf.readDoubleLE(p) }; p += 8; }
    else if (wt === 2) { let n = 0; shift = 0; do { b = buf[p++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); yield { no, wt, start: p, end: p + n }; p += n; }
    else if (wt === 5) { p += 4; }
    else throw new Error(`protobuf: wire type ${wt} not supported`);
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
