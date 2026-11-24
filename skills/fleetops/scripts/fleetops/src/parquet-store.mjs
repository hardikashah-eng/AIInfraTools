// The DataStore interface on Parquet files queried with DuckDB, for production volume.
//
//   <dir>/<kind>/day=YYYY-MM-DD/cluster=NAME/part-<uuid>.parquet     (zstd; hive partitions prune day and cluster)
//
// Columns: t, day, cluster, node, gpu, job, pool, code, source, bad (a faulty/offline device sample or a hard log line),
// h (content hash for dedupe) and rec (the full record as JSON). Queries push the time window, partitions and an
// optional SQL predicate (`sql`) down to DuckDB; `where` (a JS function) still runs on what comes back.
//
// DuckDB's Node API is asynchronous and the store interface is synchronous, so DuckDB runs in a worker thread and each
// call waits for it with Atomics.wait. Appends are buffered and written in batches; any read flushes first.
// Needs the optional dependency @duckdb/node-api (npm install in fleetops/).
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, validate } from './schema.mjs';
import { readMeta, writeMeta, SCHEMA } from './store.mjs';

const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const fnv = s => { let h1 = 0x811c9dc5, h2 = 0x01000193; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; } return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
const str = v => (v == null ? null : String(v));
const isBad = (kind, r) => (kind === 'device' ? !!((r.faults && r.faults.length) || (r.offlineMinutes || 0) > 0) : kind === 'log' ? r.severity === 'hard' : false);

export function duckdbAvailable() { try { import.meta.resolve('@duckdb/node-api'); return true; } catch { return false; } }

export class ParquetStore {
  constructor(dir, { batch = 100000 } = {}) {
    this.dir = path.resolve(dir); this.batch = batch; this.buf = {}; this.hashes = new Map();
    const empty = !fs.existsSync(this.dir) || !fs.readdirSync(this.dir).length;
    fs.mkdirSync(this.dir, { recursive: true });
    this.meta = readMeta(this.dir) || (writeMeta(this.dir, { schema: empty ? SCHEMA : 1, backend: 'parquet' }), readMeta(this.dir));
    if (this.meta.schema > SCHEMA) throw new Error(`store ${this.dir} is schema ${this.meta.schema}, newer than this fleetops (${SCHEMA})`);
    const { port1, port2 } = new MessageChannel();
    this.signal = new SharedArrayBuffer(4); this.flag = new Int32Array(this.signal); this.port = port1;
    this.worker = new Worker(new URL('./duck-worker.mjs', import.meta.url), { workerData: { port: port2, signal: this.signal, dir: this.dir }, transferList: [port2] });
    this.worker.unref();
    process.on('exit', () => { try { this.flush(); } catch { /* best effort */ } });
  }
  call(msg) {
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(msg);
    while (Atomics.load(this.flag, 0) === 0) Atomics.wait(this.flag, 0, 0, 1000);
    const r = receiveMessageOnPort(this.port).message;
    if (!r.ok) throw new Error(`parquet store: ${r.error}`);
    return r.result;
  }
  append(kind, records, { dedupe = false, source } = {}) {
    if (!KINDS[kind]) throw new Error(`unknown kind "${kind}"`);
    const out = this.buf[kind] || (this.buf[kind] = []), errors = [];
    let i = 0, written = 0, skipped = 0;
    for (const r0 of records) {
      i++;
      const r = source && r0.source == null ? Object.assign({ source }, r0) : r0;
      const bad = validate(kind, r);
      if (bad.length) { if (errors.length < 20) errors.push(`#${i}: ${bad.join('; ')}`); continue; }
      const rec = JSON.stringify(r), h = fnv(rec), d = day(r.t);
      if (dedupe) { const s = this.hashSet(kind, d); if (s.has(h)) { skipped++; continue; } s.add(h); }
      out.push({ t: r.t, day: d, cluster: str(r.cluster || r.site) || 'default', node: str(r.node), gpu: str(r.gpu), job: str(r.job), pool: str(r.pool), code: str(r.code), source: str(r.source), bad: isBad(kind, r), h, rec });
      written++;
    }
    if (out.length >= this.batch) this.flushKind(kind);
    return { kind, written, skipped, invalid: i - written - skipped, errors };
  }
  hashSet(kind, d) {
    const k = `${kind}|${d}`;
    if (!this.hashes.has(k)) { this.flushKind(kind); this.hashes.set(k, new Set(this.call({ op: 'hashes', kind, day: d }))); }
    return this.hashes.get(k);
  }
  flushKind(kind) { const rows = this.buf[kind]; if (rows && rows.length) { this.buf[kind] = []; this.call({ op: 'write', kind, rows }); } }
  flush() { for (const k of Object.keys(this.buf)) this.flushKind(k); }
  window(from, to) { return { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null, dayFrom: Number.isFinite(from) ? day(from) : null, dayTo: Number.isFinite(to) ? day(to) : null }; }
  // { from, to, where (JS), sql (pushed down: columns t, day, cluster, node, gpu, job, pool, code, source, bad), limit }
  *scan(kind, { from = -Infinity, to = Infinity, where, sql, limit } = {}) {
    this.flushKind(kind);
    for (const s of this.call(Object.assign({ op: 'query', kind, sql, limit: where ? undefined : limit }, this.window(from, to)))) { const r = JSON.parse(s); if (!where || where(r)) yield r; }
  }
  query(kind, opts = {}) {
    const out = [];
    for (const r of this.scan(kind, opts)) { out.push(r); if (opts.limit && out.length >= opts.limit) break; }
    return out;
  }
  distinct(kind, fields, { from = -Infinity, to = Infinity, sql } = {}) {
    this.flushKind(kind);
    return this.call(Object.assign({ op: 'distinct', kind, fields, sql }, this.window(from, to)));
  }
  rollupDay(kind, d, step, dstDir) { this.flushKind(kind); return this.call({ op: 'rollup', kind, day: d, step, dst: path.resolve(dstDir) }); }
  summary() { this.flush(); return this.call({ op: 'summary', kinds: Object.keys(KINDS) }); }
  days(kind) { const d = path.join(this.dir, kind); return fs.existsSync(d) ? fs.readdirSync(d).filter(x => x.startsWith('day=')).map(x => x.slice(4)).sort() : []; }
  rewriteDay(kind, d, records) { this.dropDay(kind, d); this.append(kind, records); this.flushKind(kind); }
  dropDay(kind, d) { this.flushKind(kind); fs.rmSync(path.join(this.dir, kind, `day=${d}`), { recursive: true, force: true }); for (const k of this.hashes.keys()) if (k === `${kind}|${d}`) this.hashes.delete(k); }
  close() { this.flush(); this.worker.terminate(); }
}
