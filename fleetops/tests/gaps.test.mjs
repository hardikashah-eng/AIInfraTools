import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../src/store.mjs';
import * as P from '../src/proto.mjs';
import * as G from '../src/ingest.mjs';
import * as T from '../src/traces.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs');
const fx = f => fs.readFileSync(path.join(here, 'fixtures', 'otlp', f));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-gaps-'));
const run = promisify(execFile);

test('OTLP protobuf: payloads encoded by protobufjs from the official .proto files decode like the JSON mapping', () => {
  const tr = P.decodeOtlp('traces', fx('traces.pb')), sp = G.otlpTracesToSpans(tr);
  assert.deepEqual(sp.map(s => [s.traceId, s.spanId, s.parentSpanId, s.name, s.durS, s.kind, s.status, s.node, s.service]),
    [['0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', undefined, 'llm_request', 1.5, 2, 1, 'gpu-a01', 'vllm-router'], ['0af7651916cd43dd8448eb211c80319c', '00f067aa0ba902b7', 'b7ad6b7169203331', 'prefill', 0.2, 1, undefined, 'gpu-a01', 'vllm-router']]);
  const rq = T.requestsFromSpans(sp)[0];
  assert.deepEqual([rq.pool, rq.replica, rq.isl, rq.osl, rq.ttft, rq.e2e, rq.stages.queue, rq.stages.prefill], ['llama-70b', 'vllm-0', 900, 200, 0.25, 1.5, 0.05, 0.2]);
  const lg = G.otlpLogsToRecords(P.decodeOtlp('logs', fx('logs.pb'))).logs;
  assert.deepEqual(lg.map(l => [l.code, l.node, l.rank ?? null]), [['xid79', 'gpu-a02', null], ['nccl_timeout', 'gpu-a02', 5]]);
  const d = G.seriesToDevices(G.otlpMetricsToSeries(P.decodeOtlp('metrics', fx('metrics.pb')))).devices[0];
  assert.deepEqual([d.node, d.gpu, d.tempC, d.powerW, d.faults], ['gpu-a03', '2', 64, 401.5, ['xid48']], 'gauge double, gauge int (sfixed64) and sum');
  assert.throws(() => P.decodeOtlp('traces', Buffer.from([0x0a, 0x10, 0x01])), /truncated/);
});

test('OTLP protobuf over HTTP, gzip-compressed (the collector defaults), answered in protobuf', async () => {
  const s = new DataStore(tmp()), pipe = new G.Pipeline(s, { batch: 1e6 }), srv = G.server(pipe);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const post = (p, body, enc) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: 'POST', body, headers: Object.assign({ 'content-type': 'application/x-protobuf' }, enc ? { 'content-encoding': enc } : {}) });
    const r = await post('/v1/traces', zlib.gzipSync(fx('traces.pb')), 'gzip');
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/x-protobuf'); assert.equal((await r.arrayBuffer()).byteLength, 0);
    assert.equal((await post('/v1/logs', fx('logs.pb'))).status, 200);
    assert.equal((await post('/v1/metrics', zlib.gzipSync(fx('metrics.pb')), 'gzip')).status, 200);
    assert.equal((await post('/v1/logs', fx('logs.pb'), 'br')).status, 415);
    pipe.flush();
    assert.equal(s.query('span').length, 2); assert.equal(s.query('log').length, 2); assert.equal(s.query('device')[0].tempC, 64);
  } finally { srv.close(); }
});

test('NCCL Inspector: JSON records (concatenated or JSON lines) and Prometheus-mode series → collectives', () => {
  const rec = (rank, sn, us, bw) => ({ header: { id: '0x7f3a', comm_name: 'unknown', rank, n_ranks: 16, nnodes: 2 }, metadata: { inspector_output_format_version: 'v4.0', git_rev: 'x', rec_mechanism: 'nccl_profiler_interface', dump_timestamp_us: 1768478400000000 + sn * 1000, hostname: 'gpu-a01', pid: 4242 },
    coll_perf: { coll: 'AllReduce', coll_sn: sn, coll_msg_size_bytes: 268435456, coll_exec_time_us: us, coll_timing_source: 'kernel_gpu', coll_algobw_gbs: bw * 0.53, coll_busbw_gbs: bw } });
  const text = JSON.stringify(rec(0, 1, 1200, 380), null, 2) + JSON.stringify(rec(0, 2, 1300, 370)) + '\n' + JSON.stringify({ header: { id: '0x7f3a', rank: 0 }, metadata: { dump_timestamp_us: 1768478400100000, hostname: 'gpu-a01' }, p2p_perf: { p2p: 'Send', p2p_sn: 3, p2p_peer: 8, p2p_msg_size_bytes: 1048576, p2p_exec_time_us: 40, p2p_busbw_gbs: 25 } }) + '\n{"torn":';
  const c = T.ncclInspector(text, { job: 'train-7b' });
  assert.deepEqual(c.map(x => [x.op, x.sn, x.rank, x.nranks, x.node, x.execS, x.busbw, x.job]), [['AllReduce', 1, 0, 16, 'gpu-a01', 0.0012, 380, 'train-7b'], ['AllReduce', 2, 0, 16, 'gpu-a01', 0.0013, 370, 'train-7b'], ['Send', 3, 0, undefined, 'gpu-a01', 0.00004, 25, 'train-7b']]);
  assert.equal(c[2].peer, 8);
  const prom = G.seriesToCollectives([
    { labels: { __name__: 'nccl_bus_bandwidth_gbs', version: 'v5.1', slurm_job_id: '1670760', node: 'n1', gpu: 'GPU0', comm_name: 'unknown', n_nodes: '1', nranks: '64', collective: 'AllReduce', message_size: '8-9MB', algo_proto: 'Ring_Simple' }, samples: [{ t: 100, v: 360 }] },
    { labels: { __name__: 'nccl_collective_exec_time_microseconds', version: 'v5.1', slurm_job_id: '1670760', node: 'n1', gpu: 'GPU0', comm_name: 'unknown', n_nodes: '1', nranks: '64', collective: 'AllReduce', message_size: '8-9MB' }, samples: [{ t: 100, v: 250 }] }]);
  assert.deepEqual(prom.map(x => [x.node, x.gpu, x.op, x.msgSize, x.busbw, x.execS, x.job, x.nranks]), [['n1', 'GPU0', 'AllReduce', '8-9MB', 360, 0.00025, '1670760', 64]]);
});

// A fake Prometheus + Loki with one GPU fault and one KV-cache incident in their history.
function fakeMonitoring(t0) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams.get('query') || '', start = +u.searchParams.get('start'), end = +u.searchParams.get('end');
    seen.push({ path: u.pathname, auth: req.headers.authorization });
    const ok = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data })); };
    if (u.pathname === '/api/v1/query_range') {
      const step = +u.searchParams.get('step'), ts = []; for (let t = start; t <= end; t += step) ts.push(t);
      if (q.includes('DCGM_FI_DEV_GPU_TEMP')) {
        const result = [];
        for (const n of ['gpu-01', 'gpu-02', 'gpu-03']) {
          const L = { Hostname: n, gpu: '0', modelName: 'NVIDIA H100 80GB HBM3' };
          result.push({ metric: Object.assign({ __name__: 'DCGM_FI_DEV_GPU_TEMP' }, L), values: ts.map(t => [t, '61']) });
          result.push({ metric: Object.assign({ __name__: 'DCGM_FI_DEV_XID_ERRORS' }, L), values: ts.map(t => [t, n === 'gpu-03' && t >= t0 ? '79' : '0']) });
        }
        return ok({ resultType: 'matrix', result });
      }
      const sv = { ttftP99: t => (t >= t0 + 86400 ? 2.4 : 0.6), kvUsage: t => (t >= t0 + 86400 ? 0.97 : 0.55), rate: () => 20, preemptions: t => (t >= t0 + 86400 ? 12 : 0) };
      const field = q.startsWith('histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:time_to_first') ? 'ttftP99' : q.includes('cache_usage') ? 'kvUsage' : q.includes('request_success_total[5m]))') && !q.includes('/') ? 'rate' : q.includes('preemptions') ? 'preemptions' : null;
      if (field) return ok({ resultType: 'matrix', result: [{ metric: { model_name: 'chat-70b' }, values: ts.map(t => [t, String(sv[field](t))]) }] });
      return ok({ resultType: 'matrix', result: [] });
    }
    if (u.pathname === '/loki/api/v1/query_range') {
      const s0 = BigInt(u.searchParams.get('start')), e0 = BigInt(u.searchParams.get('end')), at = BigInt(t0 + 30) * 1000000000n;
      const values = q.includes('kernel') && at >= s0 && at <= e0 ? [[String(at), 'kernel: NVRM: Xid (PCI:0000:3b:00): 79, pid=1, name=python3, GPU has fallen off the bus.']] : [];
      return ok({ resultType: 'streams', result: values.length ? [{ stream: { job: 'node/kernel', host: 'gpu-03' }, values }] : [] });
    }
    res.writeHead(404); res.end();
  });
  return { srv, seen };
}

test('backtest: each confirmed incident\'s window pulled from Prometheus and Loki, then scored', async () => {
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1000), { srv, seen } = fakeMonitoring(t0);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`, dir = tmp(), labels = path.join(dir, 'pm.jsonl');
  fs.writeFileSync(labels, [
    { incident: { id: 'PM-101', symptom: 'device', nodes: ['gpu-03'], from: t0, to: t0 + 1800 }, cause: 'hardware', component: 'gpu-03' },
    { incident: { id: 'PM-102', symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: t0 + 86400, to: t0 + 86400 + 1800 }, cause: 'kv-pressure' },
  ].map(x => JSON.stringify(x)).join('\n'));
  try {
    const { stdout } = await run(process.execPath, [cli, 'backtest', '--labels', labels, '--prom', url, '--loki', url, '--header', 'Authorization: Bearer test-token', '--store', path.join(dir, 's'), '--json']);
    const r = JSON.parse(stdout);
    assert.deepEqual(r.backtest.rows.map(x => [x.id, x.cause, x.rank]), [['PM-101', 'hardware', 1], ['PM-102', 'kv-pressure', 1]], JSON.stringify(r.backtest.rows.map(x => x.ranked)));
    assert.equal(r.backtest.top1, 1);
    assert.ok(r.pulled[0].loki.logs >= 1 && r.pulled[0].prometheus.device > 0);
    assert.ok(seen.every(x => x.auth === 'Bearer test-token'), 'auth header on every call');
    // on-prem mode refuses an unlisted monitoring host
    await assert.rejects(run(process.execPath, [cli, 'pull', '--from', String(t0), '--prom', 'https://prom.saas.example', '--store', path.join(dir, 's2')], { env: Object.assign({}, process.env, { FLEETOPS_EGRESS_ALLOW: 'prometheus.monitoring.svc' }) }), /egress to prom.saas.example is not allowed/);
  } finally { srv.close(); }
});

test('game day: every step checked against the allowlist before any runs; dry run by default', async () => {
  const dir = tmp(), plan = path.join(dir, 'plan.json'), allow = path.join(dir, 'allow');
  fs.writeFileSync(allow, 'gpu-t01\ngpu-t02\nnfs-test\n');
  fs.writeFileSync(plan, JSON.stringify({ cooldownS: 600, steps: [{ fault: 'gpu-slow', node: 'gpu-t01', gpu: '0', forS: 900 }, { fault: 'nfs-block', nodes: 'gpu-t01,gpu-t02', server: 'nfs-test', forS: 600 }] }));
  const { stdout } = await run(process.execPath, [cli, 'gameday', plan, '--allow', allow, '--store', path.join(dir, 's')]);
  assert.match(stdout, /step 1\/2: gpu-slow on gpu-t01 for 900 s \(expect straggler\)/); assert.match(stdout, /nvidia-smi -i 0 -lgc 600,600/); assert.match(stdout, /dry run: nothing was run/);
  assert.equal(new DataStore(path.join(dir, 's')).query('injection').length, 0);
  fs.writeFileSync(plan, JSON.stringify([{ fault: 'cordon', node: 'gpu-t01' }, { fault: 'cordon', node: 'prod-db-1' }]));
  await assert.rejects(run(process.execPath, [cli, 'gameday', plan, '--allow', allow, '--live', '--store', path.join(dir, 's')]), /not in the allowlist: prod-db-1/);
  assert.equal(new DataStore(path.join(dir, 's')).query('injection').length, 0, 'the allowed first step did not run either');
});

test('demo: every scenario written to a store is diagnosed as its planted cause by the commands it prints', async () => {
  const dir = tmp();
  const { stdout: l } = await run(process.execPath, [cli, 'demo', '--list', '--json', '--store', path.join(dir, 'x')]);
  const names = JSON.parse(l).scenarios;
  assert.equal(names.length, 17);
  for (const [i, name] of names.entries()) {
    const { stdout } = await run(process.execPath, [cli, 'demo', '--scenario', name, '--store', path.join(dir, `s${i}`), '--json']);
    const demo = JSON.parse(stdout).demo;
    assert.ok(Object.values(demo.written).reduce((a, b) => a + b, 0) > 0);
    const argv = demo.next[1].replace(/^fleetops /, '').split(' ');
    const { stdout: d } = await run(process.execPath, [cli, ...argv, '--json']);
    assert.equal(JSON.parse(d).incidents[0].hypotheses[0].rule, demo.planted.cause, name);
  }
  await assert.rejects(run(process.execPath, [cli, 'demo', '--scenario', 'nope', '--store', path.join(dir, 'n')]), /no demo scenario/);
});
