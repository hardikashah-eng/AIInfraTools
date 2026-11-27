import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const IN = require('../src/ingest.js');
const E = require('../src/engine.js');
const here = dirname(fileURLToPath(import.meta.url));
const fx = name => readFileSync(join(here, 'fixtures', name), 'utf8');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('vLLM OTLP spans: request spans only, with recorded latencies', () => {
  const r = IN.parseTrace(fx('vllm-otlp.jsonl'));
  assert.match(r.format, /vLLM OpenTelemetry/);
  assert.equal(r.trace.length, 3, 'the FastAPI span is ignored');
  assert.deepEqual(r.trace.map(x => [x.isl, x.osl]), [[1200, 250], [5400, 80], [300, 40]]);
  close(r.trace[1].t, 0.8);
  close(r.trace[2].t, 2.5);
  close(r.trace[0].ttft, 0.31);
  close(r.trace[1].queue, 0.15);
  close(r.trace[0].e2e, 6.2);
  assert.equal(r.stats.withTtft, 3);
});

test('vLLM spans exported from Jaeger', () => {
  const r = IN.parseTrace(fx('vllm-jaeger.json'));
  assert.match(r.format, /Jaeger/);
  assert.equal(r.trace.length, 2);
  close(r.trace[1].t, 1.5);
  close(r.trace[0].ttft, 0.31);
  assert.equal(r.trace[1].ttft, undefined, 'a span without TTFT keeps none');
});

test('LiteLLM spend logs: TTFT from completionStartTime, sessions from end_user', () => {
  const r = IN.parseTrace(fx('litellm-spendlogs.json'));
  assert.equal(r.format, 'Gateway JSON logs');
  assert.equal(r.trace.length, 2, 'the embedding call without completion tokens is skipped');
  close(r.trace[0].ttft, 0.45, 1e-3);
  close(r.trace[1].t, 3);
  close(r.trace[0].e2e, 5, 1e-3);
  assert.equal(r.stats.sessions, 2);
  assert.ok(r.notes.some(n => /1 record without timing or token usage/.test(n)));
});

test('OpenAI-style gateway JSONL: cached tokens, ms durations, bad lines skipped', () => {
  const r = IN.parseTrace(fx('openai-gateway.jsonl'));
  assert.equal(r.trace.length, 2);
  assert.equal(r.trace[0].cached, 2048);
  close(r.trace[0].ttft, 0.34);
  close(r.trace[0].e2e, 2.9);
  close(r.trace[1].t, 1.75);
  assert.ok(r.notes.some(n => /malformed JSON line/.test(n)));
  assert.ok(r.notes.some(n => /without timing or token usage/.test(n)));
});

test('Anthropic-style usage: prompt size includes cache reads and writes', () => {
  const r = IN.parseTrace(fx('anthropic-gateway.jsonl'));
  assert.equal(r.trace[0].isl, 120 + 30000 + 2000);
  assert.equal(r.trace[0].cached, 30000);
  assert.equal(r.trace[1].isl, 2600 + 32000);
  assert.equal(r.trace[0].session, 'agent-7');
  close(r.trace[1].t, 9);
  close(r.trace[0].ttft, 1.1);
});

test('CSV: Azure and generic formats, optional columns, errors', () => {
  const azure = IN.parseTrace('TIMESTAMP,ContextTokens,GeneratedTokens\n2023-11-16 18:15:46.6805900,374,44\n2023-11-16 18:15:50.9951690,396,109\n');
  assert.equal(azure.format, 'Azure trace CSV');
  close(azure.trace[1].t, 4.315, 0.01);
  const gen = IN.parseTrace('timestamp_ms,input_tokens,output_tokens,ttft_ms\n1000,10,5,250\n3500,20,7,\nbad,1,1,\n');
  assert.deepEqual(gen.trace.map(r => r.t), [0, 2.5]);
  close(gen.trace[0].ttft, 0.25);
  assert.equal(gen.trace[1].ttft, undefined);
  assert.ok(gen.notes.some(n => /1 unreadable record/.test(n)));
  assert.throws(() => IN.parseTrace('a,b,c\n1,2,3\n'), /Columns not found/);
  assert.throws(() => IN.parseTrace('{"hello": "world"}'), /No request records recognised/);
});

test('canonical CSV round-trips every field', () => {
  const a = IN.parseTrace(fx('openai-gateway.jsonl')).trace;
  const b = IN.parseTrace(IN.toCSV(a)).trace;
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) for (const k of ['t', 'isl', 'osl', 'cached', 'ttft', 'e2e', 'session']) {
    if (a[i][k] == null) assert.equal(b[i][k], undefined, k);
    else if (typeof a[i][k] === 'number') close(b[i][k], a[i][k], 1e-5);
    else assert.equal(b[i][k], a[i][k]);
  }
});

test('limits and window offset', () => {
  const rows = ['timestamp,input_tokens,output_tokens'];
  for (let i = 0; i < 100; i++) rows.push(`${i * 10},100,10`);
  const r = IN.parseTrace(rows.join('\n'), { startOffsetS: 200, maxSeconds: 95, maxRows: 1000 });
  assert.equal(r.trace[0].t, 0);
  assert.equal(r.trace.length, 10, 'window 200 s .. 295 s holds ten requests');
  assert.ok(r.notes.some(n => /kept the first/.test(n)));
});

test('engine uses recorded cache hits and compares recorded with simulated TTFT', () => {
  const trace = IN.parseTrace(fx('vllm-otlp.jsonl')).trace.concat(IN.parseTrace(fx('openai-gateway.jsonl')).trace.map(r => Object.assign({}, r, { t: r.t + 5 })));
  const TP = require('../src/templates.js');
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  const c = E.compileGraph(g, () => trace);
  const run = E.simulate(c.spec);
  const cachedReq = run.reqs.find(q => q.isl === 3000);
  assert.equal(cachedReq.cached, 2048, 'recorded cache hit used');
  const rc = run.summary.recorded;
  assert.equal(rc.requests, 4);
  assert.ok(isFinite(rc.errP50) && isFinite(rc.ttftP99));
  g.nodes.find(n => n.id === 'src').cfg.useRecordedCache = false;
  const off = E.simulate(E.compileGraph(g, () => trace).spec);
  assert.equal(off.reqs.find(q => q.isl === 3000).cached, 0, 'switch off: falls back to the prefix-hit knob (0%)');
});

test('load scaling copies cache hits but not recorded latencies', () => {
  const trace = IN.parseTrace(fx('openai-gateway.jsonl')).trace;
  const scaled = E.scaleTrace(trace, 3, 7);
  assert.equal(scaled.length, 6);
  assert.equal(scaled.filter(r => r.ttft != null).length, 1, 'only the original keeps its recorded TTFT');
  assert.equal(scaled.filter(r => r.cached === 2048).length, 3);
});

test('CLI converts a log to canonical CSV with a window and sampling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetscope-'));
  const out = join(dir, 'trace.csv');
  const msg = execFileSync(process.execPath, [join(here, '..', 'tools', 'convert-trace.mjs'), join(here, 'fixtures', 'vllm-otlp.jsonl'), '-o', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(msg, '');
  const back = IN.parseTrace(readFileSync(out, 'utf8'));
  assert.equal(back.trace.length, 3);
  close(back.trace[0].ttft, 0.31, 1e-5);
});

test('the rarer inputs: Tempo batches, Jaeger without request spans, AgentX arrays and spacing, Mooncake, TraceLab rows without input events', () => {
  const IN2 = createRequire(import.meta.url)('../src/ingest.js');
  const span = (t, attrs) => ({ startTimeUnixNano: String(t * 1e9), endTimeUnixNano: String((t + 1) * 1e9), attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } })) });
  const tempo = IN2.parseTrace(JSON.stringify({ batches: [{ instrumentationLibrarySpans: [{ spans: [span(1800000000, { 'gen_ai.usage.prompt_tokens': 100, 'gen_ai.usage.completion_tokens': 10 }), span(1800000005, { 'gen_ai.usage.prompt_tokens': 200, 'gen_ai.usage.completion_tokens': 20 })] }] }] }));
  assert.match(tempo.format, /OTLP/); assert.equal(tempo.trace.length, 2);
  assert.throws(() => IN2.parseTrace(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span(1, { other: 1 })] }] }] })), /No vLLM request spans found/);
  assert.throws(() => IN2.parseTrace(JSON.stringify({ data: [{ spans: [{ startTime: 1, duration: 1, tags: [{ key: 'x', value: 1 }] }] }] })), /Jaeger/);
  const ax = IN2.parseAgentX([[{ t: 0, in: 128, out: 2, hash_ids: [1, 2] }], { requests: [{ t: 0, in: 64, out: 1 }, { type: 'subagent', requests: [{ t: 1, in: 64, out: 1 }] }, null] }], { sessionGapS: 100 });
  assert.deepEqual(ax.trace.map(r => [r.t, r.session, r.agent || null]), [[0, 'session-0', null], [100, 'session-1', null], [101, 'session-1', 'subagent']]);
  assert.equal(ax.stats.sessions, 2);
  const mc = IN2.parseMooncake([{ timestamp: 2000, input_length: 512, output_length: 0 }, { input_length: 1024, hash_ids: [0, 1] }, { nope: 1 }]);
  assert.deepEqual(mc.trace.map(r => r.osl), [1, 1]);
  assert.equal(IN2.tracelabRow({ timing_events: [] }), null);
  const tl = IN2.tracelabRow({ timing_events: [{ event_type: 'x', timestamp: '2026-11-20T10:00:00Z' }], input_tokens_total: 10, prefix_tokens: 3, provider: 'openai' });
  assert.deepEqual([tl.cached, tl.osl, tl.api, tl.tools], [3, 1, 0, 0]);
});
