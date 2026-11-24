import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../src/store.mjs';
import * as G from '../src/ingest.mjs';
import * as S from '../src/security.mjs';
import * as Inc from '../src/incidents.mjs';
import * as O from '../src/optimize.mjs';
import { exporterScrape, vllmSnapshot } from '../src/adapters/live.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), fx = f => fs.readFileSync(path.join(here, 'fixtures', 'contracts', f), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-svc-'));
const T0 = Math.floor(Date.now() / 1000) - 3600;
const kv = (k, v) => ({ key: k, value: { stringValue: v } });

async function service(tokens) {
  const dir = tmp(), store = new DataStore(dir), pipe = new G.Pipeline(store, { batch: 1e6 }), srv = G.server(pipe, { tokens, audit: S.auditor(dir) });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const call = (p, { token, method = 'GET', body, type = 'application/json' } = {}) => fetch(url + p, { method, body, headers: Object.assign({ 'content-type': type }, token ? { authorization: `Bearer ${token}` } : {}) });
  return { dir, store, pipe, srv, call };
}

test('tokens: hashed at rest, roles enforced, tenant scopes applied to every read, every read audited', async () => {
  const file = path.join(tmp(), 'tokens.jsonl');
  const admin = S.addToken(file, { name: 'platform', roles: ['admin'] }).token;
  const ingest = S.addToken(file, { name: 'collector', roles: ['ingest'] }).token;
  const team = S.addToken(file, { name: 'team-chat', roles: ['read'], tenant: { pools: ['chat'], namespaces: ['ns-chat'] } }).token;
  assert.ok(!fs.readFileSync(file, 'utf8').includes(admin), 'only hashes are stored');
  const svc = await service(S.loadTokens(file));
  try {
    const now = Date.now() / 1000;
    svc.store.append('serving', [{ t: now - 60, pool: 'chat', ttftP99: 0.5 }, { t: now - 60, pool: 'billing-llm', ttftP99: 0.9 }]);
    svc.store.append('device', [{ t: now - 60, node: 'g1', gpu: '0', tempC: 60 }]);
    svc.store.append('placement', [{ t: now - 900, job: 'j1', namespace: 'ns-chat', start: now - 900 }, { t: now - 900, job: 'j2', namespace: 'ns-other', start: now - 900 }]);
    svc.store.append('job', [{ t: now - 60, job: 'j1', status: 'failed' }, { t: now - 60, job: 'j2', status: 'failed' }]);
    assert.equal((await svc.call('/api/query?kind=serving')).status, 401);
    assert.equal((await svc.call('/api/query?kind=serving', { token: 'fo_wrong' })).status, 401);
    assert.equal((await svc.call('/api/query?kind=serving', { token: ingest })).status, 403, 'ingest tokens cannot read');
    assert.equal((await svc.call('/v1/logs', { token: team, method: 'POST', body: '{}' })).status, 403, 'read tokens cannot ingest');
    const mine = await (await svc.call('/api/query?kind=serving', { token: team })).json();
    assert.deepEqual(mine.map(r => r.pool), ['chat']);
    assert.deepEqual(await (await svc.call('/api/query?kind=device', { token: team })).json(), [], 'hardware records need an infra scope');
    assert.deepEqual((await (await svc.call('/api/query?kind=job', { token: team })).json()).map(r => r.job), ['j1'], 'jobs scoped through their placement namespace');
    assert.equal((await svc.call('/api/summary', { token: team })).status, 403);
    assert.equal((await (await svc.call('/api/query?kind=serving', { token: admin })).json()).length, 2);
    const series = await (await svc.call('/api/series?kind=serving&field=ttftP99&pool=chat&step=60', { token: team })).json();
    assert.equal(series.length, 1); assert.equal(series[0].value, 0.5);
    const audit = fs.readFileSync(path.join(svc.dir, 'audit', 'api.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(audit.some(a => a.who === 'team-chat' && a.path === '/api/query?kind=serving' && a.records === 1));
    assert.ok(audit.some(a => a.who === 'collector' && a.status === 403));
  } finally { svc.srv.close(); }
});

test('redaction: no request content and no secrets reach the store', async () => {
  const svc = await service(null);
  try {
    const ns = String(BigInt(T0) * 1000000000n);
    const traces = { resourceSpans: [{ resource: { attributes: [kv('service.name', 'router')] }, scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', name: 'chat', startTimeUnixNano: ns, endTimeUnixNano: ns,
      attributes: [kv('gen_ai.prompt', 'my secret medical question'), kv('gen_ai.completion.0.content', 'the answer'), kv('llm.input_messages', '[...]'), kv('http.request.body', '{"messages":[]}'), kv('gen_ai.request.model', 'llama'), kv('note', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')] }] }] }] };
    assert.equal((await svc.call('/v1/traces', { method: 'POST', body: JSON.stringify(traces) })).status, 200);
    const logs = { resourceLogs: [{ resource: { attributes: [kv('host.name', 'g1')] }, scopeLogs: [{ logRecords: [{ timeUnixNano: ns, body: { stringValue: 'NVRM: Xid (PCI:0000:3b:00): 79, pid=1, name=python user=jane.doe@example.com token=sk-ABCDEFGHIJKLMNOPQRSTUV' } }] }] }] };
    assert.equal((await svc.call('/v1/logs', { method: 'POST', body: JSON.stringify(logs) })).status, 200);
    svc.pipe.flush();
    const raw = fs.readdirSync(svc.dir, { recursive: true }).filter(f => f.endsWith('.jsonl') && !f.includes('audit')).map(f => fs.readFileSync(path.join(svc.dir, f), 'utf8')).join('\n');
    for (const s of ['medical question', 'the answer', 'input_messages', '"messages"', 'abcdefghijklmnopqrstuvwxyz0123', 'jane.doe@example.com', 'sk-ABCDEFGHIJ']) assert.ok(!raw.includes(s), `"${s}" must not be stored`);
    assert.match(raw, /"gen_ai.request.model":"llama"/, 'non-content attributes stay');
    assert.match(raw, /xid79/, 'the log line is still classified');
    assert.match(svc.pipe.metrics(), /fleetops_ingest_redacted_total [5-9]/);
  } finally { svc.srv.close(); }
});

test('on-prem mode: outbound calls only to listed hosts (paging, Prometheus guards)', async () => {
  const before = process.env.FLEETOPS_EGRESS_ALLOW;
  process.env.FLEETOPS_EGRESS_ALLOW = 'prometheus.monitoring.svc';
  try {
    assert.equal(S.egressAllowed('https://events.pagerduty.com/v2/enqueue'), false);
    assert.equal(S.egressAllowed('http://prometheus.monitoring.svc:9090/api/v1/query'), true);
    assert.equal(S.egressAllowed('http://localhost:9400/x'), true);
    const s = new DataStore(tmp());
    s.append('incident', [{ t: 10, id: 'i', incident: { symptom: 'job-failures', from: 1, to: 10, failures: 5 }, hypotheses: [], confidence: 'none' }]); Inc.open(s, { id: 'i', incident: { symptom: 'job-failures', from: 1, to: 10, failures: 5 } }, { now: 20 });
    await assert.rejects(Inc.page(s, 'i', 'pagerduty', 'trigger', { live: true, key: 'k', poster: () => ({ status: 202 }) }), /egress to events.pagerduty.com is not allowed/);
    const g = await O.promGuard({ prometheus: 'http://prometheus.monitoring.svc:9090', query: 'histogram_quantile(0.99, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[5m])))', limit: 1 }, { fetcher: async u => { assert.match(u, /\/api\/v1\/query\?query=histogram_quantile/); return { data: { result: [{ value: [0, '1.7'] }] } }; } });
    assert.equal(g.ok, false); assert.equal(g.value, 1.7);
    await assert.rejects(O.promGuard({ prometheus: 'https://metrics.saas.example', query: 'up', limit: 1 }, { fetcher: async () => ({}) }), /not allowed/);
  } finally { if (before == null) delete process.env.FLEETOPS_EGRESS_ALLOW; else process.env.FLEETOPS_EGRESS_ALLOW = before; }
});

test('optimizer: a Prometheus guard read at advance time rolls back on regression', async () => {
  const s = new DataStore(tmp()), state = tmp();
  const cand = [{ id: 'c', resource: 'job:embed', title: 'scale-in embed', savingsWeekly: 9, risk: 'low', protected: false, slo: {}, change: { action: 'scale-in', job: 'embed', namespace: 'serving', replicasNow: 2, replicasTarget: 1 } }];
  const plan = O.planRollout(O.select(cand, {}), { id: 'p', guards: { 'job:embed': { prometheus: 'http://localhost:9090', query: 'ttft_p99', limit: 1 } }, bakeS: 60 });
  const ids = O.enqueue(plan, state, 1000);
  const { Store } = await import('../../gpu-health/src/actions.mjs');
  new Store(state).approve(ids[0], 'ana', 1000);
  await O.advance(plan, { store: s, stateDir: state, now: 1010 });
  const r = await O.advance(plan, { store: s, stateDir: state, now: 1100, fetcher: async () => ({ data: { result: [{ value: [0, '2.5'] }] } }) });
  assert.equal(plan.status, 'rolled-back'); assert.match(r.log[0], /Prometheus, now/);
});

test('contracts: pinned exporter formats map every field the tools need', () => {
  for (const [file, need] of [['dcgm-exporter-3.3.prom', ['tempC', 'powerW', 'clockMHz', 'memUsedGB', 'sm', 'tensor', 'eccDbeTotal']], ['dcgm-exporter-4.x.prom', ['tempC', 'powerW', 'clockMHz', 'memUsedGB', 'sm', 'tensor', 'eccDbeTotal']], ['amd-device-metrics-exporter-1.x.prom', ['sm', 'dram', 'memUsedGB', 'tempC', 'powerW', 'eccDbeTotal', 'tensor']]]) {
    const [d] = exporterScrape(fx(file), { t: T0 });
    for (const f of need) assert.ok(Number.isFinite(d[f]), `${file}: ${f} not mapped (${JSON.stringify(d)})`);
  }
  const d4 = exporterScrape(fx('dcgm-exporter-4.x.prom'), { t: T0 })[0];
  assert.deepEqual([d4.node, d4.gpu, d4.faults, d4.job], ['gpu-b07', '1', ['xid48'], 'vllm-70b-0'], 'node, index, XID and pod from 4.x labels');
  assert.ok(d4.clockReasons != null || Object.keys(d4).some(k => /throttl|clockEvent|power/i.test(k)), 'clock event reasons decoded');
  for (const v of ['0.6', '0.11']) {
    const r = vllmSnapshot(fx(`vllm-${v}-after.prom`), { before: fx(`vllm-${v}-before.prom`), windowS: 60, t: T0, pool: 'chat' });
    for (const f of ['ttftP99', 'tpotP99', 'rate', 'kvUsage', 'islMean']) assert.ok(Number.isFinite(r[f]), `vLLM ${v}: ${f} (${JSON.stringify(r)})`);
    assert.equal(r.kvUsage, 0.63); assert.equal(r.rate, 10);
  }
});
