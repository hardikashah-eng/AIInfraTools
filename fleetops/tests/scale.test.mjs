import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore, openStore, writeMeta, readMeta, SCHEMA } from '../src/store.mjs';
import * as P from '../src/proto.mjs';
import * as G from '../src/ingest.mjs';
import { exporterScrape } from '../src/adapters/live.mjs';
import * as R from '../src/retention.mjs';
import { migrate } from '../src/migrate.mjs';
import { duckdbAvailable } from '../src/parquet-store.mjs';
import * as B from '../src/bench.mjs';
import { diagnose } from '../src/rca.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-scale-'));
const T0 = Date.UTC(2026, 0, 10) / 1000;
const ns = t => (BigInt(Math.round(t * 1000)) * 1000000n).toString();
const kv = (k, v) => ({ key: k, value: { stringValue: v } });

// ---------- remote_write ----------

test('remote_write: snappy and protobuf round-trip; copies in snappy streams decode', () => {
  const s = [{ labels: { __name__: 'DCGM_FI_DEV_GPU_TEMP', Hostname: 'g1', gpu: '3' }, samples: [{ v: 61.5, t: T0 }, { v: 62, t: T0 + 10 }] }];
  assert.deepEqual(P.decodeWriteRequest(P.snappyDecompress(P.snappyCompressLiteral(P.encodeWriteRequest(s)))), s);
  assert.equal(P.snappyDecompress(Buffer.from([12, 8, 97, 98, 99, 34, 3, 0])).toString(), 'abcabcabcabc', 'overlapping copy');
  const big = Buffer.from('x'.repeat(70000));
  assert.ok(P.snappyDecompress(P.snappyCompressLiteral(big)).equals(big), 'literals longer than 64 KiB');
  assert.throws(() => P.snappyDecompress(Buffer.from([5, 0, 97])), /bytes decoded/);
});

test('remote_write: series map to the same device records as a scraped /metrics; unknown metrics are counted', () => {
  const series = [
    { labels: { __name__: 'DCGM_FI_DEV_GPU_TEMP', Hostname: 'g1', gpu: '0', modelName: 'NVIDIA H100' }, samples: [{ v: 60, t: T0 }] },
    { labels: { __name__: 'DCGM_FI_DEV_XID_ERRORS', Hostname: 'g1', gpu: '0', modelName: 'NVIDIA H100' }, samples: [{ v: 79, t: T0 }] },
    { labels: { __name__: 'gpu_gfx_activity', hostname: 'a1', gpu_id: '2' }, samples: [{ v: 50, t: T0 }] },
    { labels: { __name__: 'node_load1', instance: 'x' }, samples: [{ v: 1, t: T0 }] },
  ];
  const r = G.seriesToDevices(series);
  assert.equal(r.unmapped, 1);
  const nv = r.devices.find(d => d.vendor === 'nvidia'), amd = r.devices.find(d => d.vendor === 'amd');
  assert.equal(nv.tempC, 60); assert.deepEqual(nv.faults, ['xid79']); assert.equal(amd.sm, 0.5); assert.equal(amd.node, 'a1');
  const scraped = exporterScrape('DCGM_FI_DEV_GPU_TEMP{Hostname="g1",gpu="0",modelName="NVIDIA H100"} 60\nDCGM_FI_DEV_XID_ERRORS{Hostname="g1",gpu="0",modelName="NVIDIA H100"} 79', { t: T0 })[0];
  for (const k of ['node', 'gpu', 'tempC', 'faults', 'sku']) assert.deepEqual(nv[k], scraped[k], k);
});

test('OTLP: metrics, logs (same classifier as the importers) and traces', () => {
  const m = G.otlpMetricsToSeries({ resourceMetrics: [{ resource: { attributes: [kv('host.name', 'g2')] }, scopeMetrics: [{ metrics: [{ name: 'DCGM_FI_DEV_POWER_USAGE', gauge: { dataPoints: [{ timeUnixNano: ns(T0), asDouble: 350, attributes: [kv('gpu', '1')] }] } }] }] }] });
  const d = G.seriesToDevices(m).devices[0];
  assert.deepEqual([d.node, d.gpu, d.powerW, d.t], ['g2', '1', 350, T0]);
  const l = G.otlpLogsToRecords({ resourceLogs: [{ resource: { attributes: [kv('k8s.node.name', 'g2')] }, scopeLogs: [{ logRecords: [
    { timeUnixNano: ns(T0), body: { stringValue: 'NVRM: Xid (PCI:0000:3b:00): 79, pid=1, name=p, GPU has fallen off the bus.' } },
    { timeUnixNano: ns(T0 + 1), body: { stringValue: '[Rank 2] Watchdog caught collective operation timeout: WorkNCCL(SeqNum=9, OpType=ALLREDUCE, NumelIn=1) ran for 600000 milliseconds before timing out.' } },
    { timeUnixNano: ns(T0 + 2), body: { stringValue: 'GET /healthz 200' } }] }] }] });
  assert.deepEqual(l.logs.map(x => [x.code, x.node, x.source]), [['xid79', 'g2', 'otlp:kernel'], ['nccl_timeout', 'g2', 'otlp:app-log']]);
  assert.equal(l.unmatched, 1);
  const sp = G.otlpTracesToSpans({ resourceSpans: [{ resource: { attributes: [kv('service.name', 'router')] }, scopeSpans: [{ spans: [{ traceId: 't1', spanId: 's1', parentSpanId: '', name: 'prefill', startTimeUnixNano: ns(T0), endTimeUnixNano: ns(T0 + 0.25), attributes: [kv('gen_ai.request.model', 'llama')] }] }] }] });
  assert.deepEqual([sp[0].service, sp[0].name, sp[0].durS, sp[0].attrs['gen_ai.request.model'], sp[0].parentSpanId], ['router', 'prefill', 0.25, 'llama', undefined]);
});

test('pipeline: dedupes retried deliveries, refuses a batch when full, counts late data, exposes metrics', () => {
  const s = new DataStore(tmp()), p = new G.Pipeline(s, { maxQueue: 5, batch: 1000, now: () => T0 + 60 });
  const recs = [1, 2, 3].map(i => ({ t: T0 + i, node: 'g', gpu: String(i) }));
  assert.equal(p.offer('device', recs), true); assert.equal(p.offer('device', recs), true);
  assert.equal(p.m.duplicate, 3); assert.equal(p.depth, 3);
  assert.equal(p.offer('device', [4, 5, 6].map(i => ({ t: T0 + i, node: 'g', gpu: String(i) }))), false, 'over the bound: refused whole');
  assert.equal(p.m.rejected, 3);
  assert.equal(p.offer('device', [{ t: T0 + 4, node: 'g', gpu: '4' }]), true, 'a refused record was not marked seen: its retry is accepted');
  p.offer('device', [{ t: T0 - 3600, node: 'g', gpu: '9' }]);
  assert.equal(p.m.late, 1);
  p.flush();
  assert.equal(s.query('device').length, 5);
  assert.match(p.metrics(), /fleetops_ingest_dropped_total\{reason="duplicate"\} 3/);
  assert.match(p.metrics(), /fleetops_ingest_written_total\{kind="device"\} 5/);
});

test('server: remote_write 204, OTLP JSON 200, protobuf OTLP 415, 429 when the queue is full, /metrics', async () => {
  const s = new DataStore(tmp()), p = new G.Pipeline(s, { maxQueue: 3, batch: 1000 }), srv = G.server(p);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const rw = gpus => P.snappyCompressLiteral(P.encodeWriteRequest(gpus.map(g => ({ labels: { __name__: 'DCGM_FI_DEV_GPU_TEMP', Hostname: 'h', gpu: String(g) }, samples: [{ v: 50, t: Date.now() / 1000 }] }))));
  try {
    assert.equal((await fetch(`${url}/api/v1/write`, { method: 'POST', body: rw([0, 1]) })).status, 204);
    const full = await fetch(`${url}/api/v1/write`, { method: 'POST', body: rw([2, 3]) });
    assert.equal(full.status, 429); assert.equal(full.headers.get('retry-after'), '1');
    assert.equal((await fetch(`${url}/v1/traces`, { method: 'POST', body: 'x', headers: { 'content-type': 'application/x-protobuf' } })).status, 415);
    assert.equal((await fetch(`${url}/v1/logs`, { method: 'POST', body: '{"resourceLogs":[]}', headers: { 'content-type': 'application/json' } })).status, 200);
    assert.equal((await fetch(`${url}/api/v1/write`, { method: 'POST', body: Buffer.from([1, 2, 3]) })).status, 400);
    assert.match(await (await fetch(`${url}/metrics`)).text(), /fleetops_ingest_queue_depth 2/);
    p.flush();
    assert.equal(s.query('device').length, 2);
  } finally { srv.close(); }
});

// ---------- rollups, retention, migrations ----------

function deviceDays(s, days = 3) {
  const recs = [];
  for (let t = T0; t < T0 + days * 86400; t += 600) for (const g of ['0', '1']) recs.push({ t, node: 'n1', gpu: g, vendor: 'nvidia', kind: 'gpu', sm: g === '0' ? 0.5 : 0.9, tempC: 60 + (t % 3600 === 0 ? 10 : 0), faults: g === '1' && t === T0 + 3600 ? ['xid48'] : [] });
  s.append('device', recs);
  return recs;
}

test('rollup: means, maxima, unioned faults, sample counts', () => {
  const r = R.rollupDevices([{ t: 10, node: 'a', gpu: 0, sm: 0.2, tempC: 50, faults: [] }, { t: 50, node: 'a', gpu: '0', sm: 0.6, tempC: 70, faults: ['xid79'] }, { t: 70, node: 'a', gpu: '0', sm: 1, faults: [] }], 60);
  assert.deepEqual(r.map(x => [x.t, x.n, x.sm, x.tempC, x.tempCMax, x.faults]), [[0, 2, 0.4, 60, 70, ['xid79']], [60, 1, 1, undefined, undefined, []]]);
});

test('compact: dry-run by default; --apply rolls up, keeps incident windows at full resolution, drops old raw days only', async () => {
  const s = new DataStore(tmp()); deviceDays(s, 3);
  s.append('log', [{ t: T0 + 100, node: 'n1', code: 'xid48', class: 'ecc', severity: 'hard', msg: 'x' }]);
  s.append('incident', [{ t: T0 + 2 * 3600, id: 'inc1', incident: { symptom: 'job-failures', from: T0 + 3600, to: T0 + 2 * 3600 } }]);
  const now = T0 + 10 * 86400;
  const dry = await R.compact(s, { rawDays: 7, now });
  assert.equal(dry.applied, false); assert.equal(dry.plan.length, 3); assert.equal(s.days('device').length, 3, 'nothing dropped');
  const done = await R.compact(s, { rawDays: 7, now });
  assert.equal(done.applied, false);
  const r = await R.compact(s, { rawDays: 7, now, apply: true });
  assert.ok(r.plan.every(p => p.dropped)); assert.equal(s.days('device').length, 0);
  assert.equal(s.query('log').length, 1, 'logs stay');
  const keep = new DataStore(path.join(s.dir, 'keep')).query('device');
  assert.equal(keep.length, 2 * 25, 'the incident window ±2 h (T0 … T0+4 h, the store starts at T0), two GPUs every 10 min');
  assert.ok(keep.every(k => k.t >= T0 + 3600 - 7200 && k.t <= T0 + 2 * 3600 + 7200));
  const hour = new DataStore(path.join(s.dir, 'rollup-3600')).query('device');
  assert.equal(hour.length, 3 * 24 * 2); assert.ok(hour.some(h => h.faults.includes('xid48')));
});

test('migrate: old stores are schema 1, migration rewrites day by day, newer stores are refused', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'device'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'device', '2026-01-10.jsonl'), [{ t: T0, node: 'a', gpu: 0 }, { t: T0 + 1, node: 'a', gpu: '1' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  const s = new DataStore(dir);
  assert.equal(readMeta(dir).schema, 1);
  const plan = migrate(s);
  assert.equal(plan.applied, false); assert.deepEqual(plan.steps.filter(x => x.changed).map(x => [x.kind, x.day, x.changed]), [['device', '2026-01-10', 1]]);
  assert.equal(s.query('device')[0].gpu, 0, 'dry run changes nothing');
  migrate(s, { apply: true });
  assert.deepEqual(s.query('device').map(r => r.gpu), ['0', '1']); assert.equal(readMeta(dir).schema, SCHEMA);
  assert.equal(migrate(s).steps.length, 0);
  assert.equal(readMeta(new DataStore(tmp()).dir).schema, SCHEMA, 'a new store starts current');
  const future = tmp(); writeMeta(future, { schema: SCHEMA + 1, backend: 'jsonl' });
  assert.throws(() => new DataStore(future), /newer than this fleetops/);
});

// ---------- Parquet backend (skipped when @duckdb/node-api isn't installed) ----------

test('parquet: answers like the JSON-lines store, prunes by SQL, dedupes, drops days; diagnoses the same', { skip: !duckdbAvailable() && 'npm install --no-save @duckdb/node-api@2.0.1-r.1 to run' }, async () => {
  const j = new DataStore(tmp()), pdir = tmp(), p = await openStore(pdir, { backend: 'parquet' });
  try {
    assert.equal(readMeta(pdir).backend, 'parquet');
    await assert.rejects(openStore(pdir, { backend: 'jsonl' }), /uses the parquet backend/);
    const recs = deviceDays(j, 2); p.append('device', recs);
    for (const q of [{}, { from: T0 + 3000, to: T0 + 9000 }, { where: r => r.gpu === '1' }]) assert.deepEqual(p.query('device', q), j.query('device', q));
    assert.deepEqual(p.query('device', { sql: 'bad', where: r => r.faults.length > 0 }).map(r => r.t), [T0 + 3600]);
    assert.deepEqual(p.distinct('device', ['node', 'gpu']).sort((a, b) => a.gpu.localeCompare(b.gpu)), j.distinct('device', ['node', 'gpu']));
    assert.equal(p.append('device', recs.slice(0, 5), { dedupe: true }).skipped, 5);
    assert.equal(p.summary().device.records, recs.length);
    assert.deepEqual(p.days('device'), j.days('device'));
    p.dropDay('device', p.days('device')[0]);
    assert.equal(p.query('device').length, recs.filter(r => r.t >= T0 + 86400).length);
    // a benchmark scenario copied into Parquet gets the same diagnosis
    const l = B.generate({ perCause: 1, seed: 3, only: ['shared-component: bad leaf'] })[0], q = await openStore(tmp(), { backend: 'parquet' });
    for (const k of Object.keys(l.store.data)) q.append(k, l.store.query(k));
    const a = diagnose(l.store, l.incident), b = diagnose(q, l.incident);
    assert.deepEqual(b.hypotheses.map(h => [h.rule, h.score]), a.hypotheses.map(h => [h.rule, h.score]));
    q.close();
  } finally { p.close(); }
});
