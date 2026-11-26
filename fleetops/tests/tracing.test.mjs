import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../src/store.mjs';
import { MemStore } from '../src/memstore.mjs';
import * as T from '../src/traces.mjs';
import * as G from '../src/ingest.mjs';
import * as D from '../src/detect.mjs';
import * as I from '../src/inject.mjs';
import * as B from '../src/bench.mjs';
import { diagnose } from '../src/rca.mjs';
import { startServer as startCorrector } from '../../hybrid-tracing/src/service.mjs';
import { generate as hybridTraces } from '../../hybrid-tracing/src/synth.mjs';

const T0 = Date.UTC(2026, 0, 20) / 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-tr-'));
const span = (traceId, spanId, parent, name, t, dur, extra = {}) => Object.assign({ t, traceId, spanId, parentSpanId: parent, name, durS: dur, service: 'router', attrs: {} }, extra);

test('traces: child spans give the stages; vLLM latency attributes fill in; tokens, pool and replica from attributes', () => {
  const spans = [
    span('a', 'r', undefined, 'POST /v1/chat/completions', T0, 1.5, { attrs: { 'gen_ai.request.model': 'llama-70b', 'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 200 } }),
    span('a', 'q', 'r', 'scheduler.queue', T0 + 0.01, 0.05), span('a', 'p', 'r', 'prefill', T0 + 0.06, 0.2, { node: 'gpu-a01', attrs: { 'k8s.pod.name': 'vllm-0' } }), span('a', 'd', 'r', 'decode', T0 + 0.26, 1.2),
    span('b', 'r2', undefined, 'llm_request', T0 + 5, 2, { service: 'vllm', attrs: { 'gen_ai.request.model': 'llama-70b', 'gen_ai.usage.prompt_tokens': 100, 'gen_ai.usage.completion_tokens': 50, 'gen_ai.latency.time_in_queue': 0.1, 'gen_ai.latency.time_to_first_token': 0.4, 'gen_ai.latency.time_in_model_prefill': 0.3, 'gen_ai.latency.e2e': 2 } }),
  ];
  const [a, b] = T.requestsFromSpans(spans);
  assert.deepEqual([a.pool, a.replica, a.node, a.isl, a.osl, a.stages], ['llama-70b', 'vllm-0', 'gpu-a01', 900, 200, { queue: 0.05, prefill: 0.2, decode: 1.2 }]);
  assert.ok(Math.abs(a.ttft - 0.25) < 1e-9); assert.equal(a.e2e, 1.5);
  assert.deepEqual([b.ttft, b.e2e, b.stages.queue, b.stages.prefill, b.isl], [0.4, 2, 0.1, 0.3, 100]);
});

test('training: PyTorch profiler trace → per-rank steps with NCCL time; JSON-lines step logs', () => {
  const kin = { distributedInfo: { backend: 'nccl', rank: 3, world_size: 8 }, traceEvents: [
    { ph: 'X', name: 'ProfilerStep#10', ts: 1000, dur: 500000, cat: 'user_annotation' },
    { ph: 'X', name: 'ncclDevKernel_AllReduce_Sum_bf16_RING_LL', ts: 300000, dur: 120000, cat: 'kernel' },
    { ph: 'X', name: 'enumerate(DataLoader)#_SingleProcessDataLoaderIter.__next__', ts: 2000, dur: 30000, cat: 'user_annotation' },
    { ph: 'X', name: 'ProfilerStep#11', ts: 501000, dur: 480000, cat: 'user_annotation' },
    { ph: 'X', name: 'ncclDevKernel_AllReduce_Sum_bf16_RING_LL', ts: 800000, dur: 100000, cat: 'kernel' }] };
  const st = T.kineto(kin, { job: 'llm', node: 'gpu-a03', t0: T0 });
  assert.deepEqual(st.map(s => [s.rank, s.step, s.durS, s.commS, s.dataS, s.computeS]), [[3, 10, 0.5, 0.12, 0.03, 0.35], [3, 11, 0.48, 0.1, 0, 0.38]]);
  assert.equal(st[0].t, T0 + 0.501);
  const sl = T.stepLog('{"t":1,"rank":0,"node":"n","step":5,"step_time":0.9,"comm_time":0.2,"mfu":0.41}\nnot json\n{"t":2,"rank":1}', { job: 'llm' });
  assert.deepEqual(sl.map(s => [s.job, s.rank, s.step, s.durS, s.commS, s.mfu, +s.computeS.toFixed(3)]), [['llm', 0, 5, 0.9, 0.2, 0.41, 0.7]]);
});

test('detect: a training slowdown from step times, a hang from watchdog timeouts', () => {
  const s = new MemStore(), steps = [];
  for (let i = 0; i < 120; i++) for (let r = 0; r < 8; r++) steps.push({ t: T0 + i * 60, job: 'llm', rank: r, node: `n${r >> 2}`, step: i, durS: (i > 90 ? 1.6 : 1) * (1 + ((i * 7 + r) % 5) / 100) });
  s.append('step', steps);
  s.append('log', [0, 1, 2].map(r => ({ t: T0 + 8000, node: 'n0', job: 'llm', rank: r, code: 'nccl_timeout', class: 'network', severity: 'hard', ms: 600000, seq: 10, msg: 'x' })));
  const inc = D.detectTraining(s, {});
  const slow = inc.find(i => i.symptom === 'training-slow'), hang = inc.find(i => i.symptom === 'training-hang');
  assert.ok(slow && slow.job === 'llm' && Math.abs(slow.from - (T0 + 90 * 60)) <= 120, JSON.stringify(slow));
  assert.ok(hang && hang.from === T0 + 8000 - 600 && hang.job === 'llm');
});

test('done-when: an injected slow GPU is pinned to its rank and node; a TTFT regression to its replica and to its stage', async () => {
  // gpu-slow injected (fake runner), then the job's step records show the effect
  const base = B.generate({ perCause: 1, seed: 4, only: ['straggler'] })[0], s = new MemStore();
  for (const k of Object.keys(base.store.data)) s.append(k, base.store.query(k));
  const bad = base.component;
  let clock = T0 - 0; // the scenario's onset is its own T0 (2026-01-15 12:00)
  clock = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  await I.run(I.prepare('gpu-slow', { node: bad, gpu: '0' }, { allow: [bad] }), { live: true, forS: 3600, store: s, log: () => {}, now: () => clock, runner: () => ({ status: 0 }), sleep: async x => { clock += x; } });
  const r = B.evalInjections(s);
  assert.equal(r.rows[0].cause, 'straggler'); assert.equal(r.rows[0].rank, 1, JSON.stringify(r.rows[0].hyps)); assert.equal(r.rows[0].componentOk, true);
  for (const kind of ['replica-tail: one serving replica slow', 'slow-stage: prefill slows on every replica']) {
    for (const l of B.generate({ perCause: 5, seed: 9, only: [kind] })) {
      const d = diagnose(l.store, l.incident);
      assert.equal(d.hypotheses[0].rule, l.cause, `${l.id}: ${d.hypotheses.map(h => h.rule + ' ' + h.score.toFixed(2)).join(' | ')}`);
      if (l.component) assert.match(d.hypotheses[0].title, new RegExp(l.component));
    }
  }
});

test('collective hang: the rank that never joined, from the ranks that did', () => {
  for (const l of B.generate({ perCause: 6, seed: 5, only: ['collective-hang'] })) {
    const d = diagnose(l.store, l.incident), top = d.hypotheses[0];
    assert.equal(top.rule, 'collective-hang'); assert.match(top.title, new RegExp(`on ${l.component} never joined`));
  }
});

test('hybrid-tracing → fleetops: clock-corrected spans forwarded into the store, requests derived', async () => {
  const st = new DataStore(tmp()), pipe = new G.Pipeline(st, { batch: 1e6 }), fo = G.server(pipe);
  await new Promise(r => fo.listen(0, '127.0.0.1', r));
  const { server: hc, corrector } = startCorrector({ downstream: `http://127.0.0.1:${fo.address().port}/v1/traces`, resolveMs: 3600000 });
  await new Promise(r => hc.listen(0, '127.0.0.1', r));
  try {
    const { request } = hybridTraces({ requests: 60 });
    const post = body => fetch(`http://127.0.0.1:${hc.address().port}/v1/traces`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.equal((await post(request)).status, 200);  // learn
    corrector.resolve();
    assert.equal((await post(request)).status, 200);  // corrected and forwarded
    pipe.flush();
    const spans = st.query('span');
    assert.ok(spans.length > 0);
    assert.ok(spans.some(x => x.attrs && x.attrs['clock.skew_corrected_ns'] != null), 'corrected spans carry the correction');
    const reqs = T.requestsFromSpans(spans);
    assert.ok(reqs.length >= 60 && reqs.every(r => Number.isFinite(r.e2e)));
  } finally { hc.close(); fo.close(); }
});
