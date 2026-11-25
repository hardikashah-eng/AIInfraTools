import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeCode, codex, otel, langfuse, detect, importText } from '../src/importers.mjs';
import { ledger } from '../src/ledger.mjs';
import { analyzeSession } from '../src/waste.mjs';
import { priceTable, priceCalls } from '../src/prices.mjs';
import { call } from '../src/record.mjs';
import { demoInputs } from '../src/demo.mjs';
import { html } from '../src/html.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url)), FX = f => fs.readFileSync(path.join(DIR, 'fixtures', f), 'utf8');
const CLI = path.join(DIR, '..', 'tools', 'harness-ledger.mjs');
const sumBy = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0);
const J = o => JSON.stringify(o);

// ---------- importers ----------
test('claude code: Anthropic usage → inclusive input, one record per response, tool results attached, subagents apart', () => {
  const L = [
    { type: 'assistant', sessionId: 's1', timestamp: '2026-11-01T10:00:00Z', requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 50 } } },
    { type: 'assistant', sessionId: 's1', timestamp: '2026-11-01T10:00:01Z', requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }], usage: { input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 90 } } },
    { type: 'user', sessionId: 's1', timestamp: '2026-11-01T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(4000) }], is_error: true }] } },
    { type: 'assistant', sessionId: 's1', isSidechain: true, agentId: 'agent-a', timestamp: '2026-11-01T10:00:03Z', requestId: 'r2', message: { id: 'm2', model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'assistant', sessionId: 's1', timestamp: '2026-11-01T10:00:04Z', isApiErrorMessage: true, uuid: 'e1', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
  ].map(J).join('\n');
  assert.equal(detect(L, 'x.jsonl'), 'claude-code');
  const cs = claudeCode(L);
  const main = cs.find(c => c.session === 's1' && c.model), sub = cs.find(c => c.session === 's1:agent-a');
  assert.equal(main.input, 21004); assert.equal(main.cacheRead, 20000); assert.equal(main.cacheWrite, 1000); assert.equal(main.output, 90);
  assert.deepEqual(main.toolCalls.map(t => [t.name, t.resultTokens, t.error]), [['Read', 1000, true]]);
  assert.equal(sub.parent, 's1'); assert.equal(sub.agent, 'agent-a');
  assert.ok(cs.some(c => c.error === 'api_error'));
  assert.ok(!J(cs).includes('yyyy'), 'no tool output text in records');
});

test('codex: ccusage fixtures give the same totals ccusage reports (subagent; fork with inherited history)', () => {
  const a = codex(FX('codex-ccusage-issue_1970.jsonl'));
  assert.equal(sumBy(a, 'input') + sumBy(a, 'output'), 1010);   // ccusage: totalTokens 1010
  assert.equal(a[0].agent, 'subagent'); assert.equal(a[0].parent, 'missing-parent');
  const b = codex(FX('codex-ccusage-issue_2046.jsonl'));
  assert.equal(sumBy(b, 'input') - sumBy(b, 'cacheRead'), 16000); // ccusage: inputTokens (non-cached) 16 000
  assert.equal(sumBy(b, 'cacheRead'), 4000); assert.equal(sumBy(b, 'output'), 200);
  assert.ok(b.every(c => c.model === 'gpt-6-astra'));
});

test('codex: function calls pair with their outputs; a non-zero exit code is an error', () => {
  const L = [
    { timestamp: '2026-11-01T10:00:00Z', type: 'session_meta', payload: { id: 'cx' } },
    { timestamp: '2026-11-01T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-5' } },
    { timestamp: '2026-11-01T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
    { timestamp: '2026-11-01T10:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 20 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 20 } } } },
    { timestamp: '2026-11-01T10:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 20 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 20 } } } },
    { timestamp: '2026-11-01T10:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'z'.repeat(800), metadata: { exit_code: 2 } }) } },
  ].map(J).join('\n');
  const cs = codex(L, { file: 'rollout-2026-11-01T10-00-00-cx.jsonl' });
  assert.equal(cs.length, 1, 'a repeated snapshot is one call');
  assert.equal(cs[0].toolCalls[0].name, 'shell'); assert.equal(cs[0].toolCalls[0].error, true); assert.ok(cs[0].toolCalls[0].resultTokens > 200);
});

test('otel: GenAI spans (flat lines, as Copilot writes them) and OTLP with tool definitions and execute_tool spans', () => {
  const cp = otel(FX('otel-ccusage-copilot.jsonl'));
  assert.equal(cp.length, 3); assert.deepEqual([...new Set(cp.map(c => c.session))].sort(), ['session-a', 'session-c']);
  const kv = o => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
  const defs = JSON.stringify([{ name: 'search', parameters: {} }, { name: 'email', parameters: {} }, { name: 'sql', parameters: {} }]);
  const body = { resourceSpans: [{ resource: { attributes: kv({ 'service.name': 'my-agent' }) }, scopeSpans: [{ spans: [
    { traceId: 'T', spanId: 'A', name: 'invoke_agent x', startTimeUnixNano: '1000000000000', endTimeUnixNano: '1010000000000', attributes: kv({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'triage' }) },
    { traceId: 'T', spanId: 'C1', parentSpanId: 'A', name: 'chat m', startTimeUnixNano: '1000000000000', endTimeUnixNano: '1001000000000', attributes: kv({ 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5', 'gen_ai.usage.input_tokens': 3000, 'gen_ai.usage.cache_read.input_tokens': 1000, 'gen_ai.usage.output_tokens': 40, 'gen_ai.tool.definitions': defs }) },
    { traceId: 'T', spanId: 'X1', parentSpanId: 'A', name: 'execute_tool search', startTimeUnixNano: '1001500000000', endTimeUnixNano: '1002000000000', status: { code: 2 }, attributes: kv({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search', 'gen_ai.tool.call.id': 'k1' }) },
  ] }] }] };
  const [c] = otel(J(body));
  assert.equal(c.harness, 'my-agent'); assert.equal(c.agent, 'triage'); assert.equal(c.session, 'T');
  assert.deepEqual(c.toolsOffered, ['search', 'email', 'sql']); assert.ok(c.toolDefTokens > 0);
  assert.equal(c.toolCalls[0].name, 'search'); assert.equal(c.toolCalls[0].error, true);
});

test('otel: OpenInference attributes (prompt includes cache; llm.tools.N)', () => {
  const span = { traceId: 'T', spanId: 'S', name: 'llm', startTime: '2026-11-01T10:00:00Z', endTime: '2026-11-01T10:00:02Z', attributes: {
    'openinference.span.kind': 'LLM', 'llm.model_name': 'gpt-5', 'session.id': 'sess', 'llm.token_count.prompt': 1200, 'llm.token_count.prompt_details.cache_read': 1000,
    'llm.token_count.completion': 30, 'llm.tools.0.tool.json_schema': '{"type":"function","function":{"name":"get_weather"}}' } };
  const [c] = otel(J(span) + '\n');
  assert.equal(c.session, 'sess'); assert.equal(c.input, 1200); assert.equal(c.cacheRead, 1000); assert.deepEqual(c.toolsOffered, ['get_weather']);
});

test('langfuse: canonical keys are exclusive of cache, OpenAI-style prompt_tokens inclusive; TOOL observations attach', () => {
  const obs = [
    { id: 'g1', traceId: 't', sessionId: 's', type: 'GENERATION', model: 'gpt-5', startTime: '2026-11-01T10:00:00Z', endTime: '2026-11-01T10:00:01Z', usageDetails: { input: 200, input_cached_tokens: 800, output: 10 } },
    { id: 'tool1', traceId: 't', type: 'TOOL', name: 'lookup', startTime: '2026-11-01T10:00:02Z', output: 'q'.repeat(400) },
    { id: 'g2', traceId: 't', sessionId: 's', type: 'GENERATION', model: 'gpt-5', startTime: '2026-11-01T10:00:03Z', usageDetails: { prompt_tokens: 1500, input_cached_tokens: 1000, completion_tokens: 5 }, level: 'ERROR' },
  ];
  const cs = langfuse(J({ data: obs }));
  assert.equal(cs[0].input, 1000); assert.equal(cs[0].cacheRead, 800);
  assert.equal(cs[1].input, 1500); assert.equal(cs[1].error, 'error');
  assert.deepEqual(cs[0].toolCalls.map(t => [t.name, t.resultTokens]), [['lookup', 100]]);
});

// ---------- waste ----------
const priced = (cs, prices) => priceCalls(cs, priceTable(prices || { models: { m: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } } }));
const mk = (i, o) => call({ t: 1000 + i * 10, harness: 'h', session: 's', id: `c${i}`, model: 'm', input: 10000, cacheRead: 9000, cacheWrite: 0, output: 100, ...o });

test('cache: a miss and an expiry are told apart; a compaction is not a miss', () => {
  const cs = priced([mk(0, { cacheRead: 0 }), mk(1, { input: 20000, cacheRead: 10000 }), mk(2, { input: 30000, cacheRead: 2000, cacheWrite: 28000 }),
    mk(3, { t: 2000, input: 32000, cacheRead: 0 }), mk(4, { t: 2010, input: 8000, cacheRead: 0 })]);
  const f = analyzeSession(cs);
  const miss = f.filter(x => x.cause === 'cache-miss'), exp = f.filter(x => x.cause === 'cache-expired');
  assert.deepEqual(miss.map(x => x.at), ['c2']); assert.equal(miss[0].tokens, 18000);
  // 18 000 missed: 18 000 of it re-written at 1.25 instead of read at 0.1, per million
  assert.ok(Math.abs(miss[0].cost - 18000 * (1.25 - 0.1) / 1e6) < 1e-12);
  assert.deepEqual(exp.map(x => x.at), ['c3']);
  assert.ok(!f.some(x => x.at === 'c4' && x.cause.startsWith('cache-')), 'the drop to 8k is a compaction');
});

test('tools: bloat is charged for every call that carries it; repeats, error loops and unused tool definitions', () => {
  const tc = (name, o = {}) => ({ name, argHash: o.arg || name, resultTokens: o.res ?? 500, error: o.error });
  const cs = priced([
    mk(0, { toolCalls: [tc('Read', { res: 30000 })], toolsOffered: ['Read', 'Grep', 'Web', 'Mail'], toolDefTokens: 4000 }),
    mk(1, { toolCalls: [tc('Grep', { arg: 'g1' })] }), mk(2, { toolCalls: [tc('Grep', { arg: 'g1' })] }),
    mk(3, { toolCalls: [tc('Bash', { error: true })] }), mk(4, { toolCalls: [tc('Bash', { error: true })] }), mk(5, { toolCalls: [tc('Bash', { error: true })] }), mk(6, { toolCalls: [tc('Bash', { error: true })] }),
    mk(7, { toolCalls: [tc('TodoWrite')] }), mk(8, { toolCalls: [tc('TodoWrite')] }),
  ]);
  const f = analyzeSession(cs), by = c => f.filter(x => x.cause === c);
  const bloat = by('tool-output-bloat')[0];
  assert.equal(bloat.detail.carried, 8); assert.equal(bloat.tokens, (30000 - 1500) * 9); assert.equal(bloat.fullPrice, 30000 - 1500);
  assert.deepEqual(by('repeated-tool-call').map(x => x.at), ['c2'], 'TodoWrite repeats are expected');
  assert.deepEqual(by('error-loop').map(x => x.at), ['c5', 'c6'], 'the first retry is fine');
  const unused = by('unused-tools')[0]; assert.equal(unused.tokens, 2000); assert.deepEqual(unused.detail.unused, ['Web', 'Mail']);
  for (const c of cs) assert.ok(f.filter(x => x.at === c.id).reduce((s, x) => s + x.cost, 0) <= c.cost + 1e-12, 'findings never cost more than the call');
});

test('model tier: a candidate only when it still saves after the cheaper model re-reads the context uncached', () => {
  const prices = { models: { big: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15, downshift: 'small' }, small: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } } };
  const tc = [{ name: 'Read', argHash: 'a' }];
  const short = priced([call({ t: 1, harness: 'h', session: 's', id: 'a', model: 'big', input: 3000, cacheRead: 0, output: 80, toolCalls: tc })], prices);
  assert.equal(analyzeSession(short).filter(f => f.cause === 'model-tier').length, 1);
  const longCached = priced([call({ t: 1, harness: 'h', session: 's', id: 'b', model: 'big', input: 400000, cacheRead: 399000, cacheWrite: 0, output: 80, toolCalls: tc })], prices);
  assert.equal(analyzeSession(longCached).filter(f => f.cause === 'model-tier').length, 0);
});

// ---------- end to end ----------
test('demo: three harnesses, every cause found, GPU time joined, nothing from the transcripts leaks', () => {
  const d = demoInputs();
  const calls = d.files.flatMap(f => importText(f.text, { file: f.name }));
  assert.deepEqual([...new Set(calls.map(c => c.harness))].sort(), ['claude-code', 'codex', 'langgraph-support']);
  const r = ledger(calls, { engineSpans: d.engine, replicas: d.replicas, outcomes: new Map(Object.entries(d.outcomes)) });
  const causes = new Set(r.findings.map(f => f.cause));
  for (const c of ['cache-miss', 'cache-expired', 'cache-write-unread', 'tool-output-bloat', 'repeated-tool-call', 'error-loop', 'unused-tools']) assert.ok(causes.has(c), c);
  assert.equal(r.report.gpu.matched, 21); assert.equal(r.report.gpu.priced, 21);
  const rep = r.report.gpu.replicas.find(x => x.replica === 'vllm-llama70b-0');
  assert.ok(rep.busyShare < 0.1 && rep.idleCost > rep.busyCost, 'a replica idle between two runs: idle is the replica\'s, not the agent\'s');
  const otelCost = calls.filter(c => c.harness === 'langgraph-support').reduce((s, c) => s + c.cost, 0);
  assert.ok(Math.abs(otelCost - r.report.gpu.replicas.reduce((s, x) => s + x.busyCost, 0)) < 1e-9, 'busy GPU cost is fully charged to the calls');
  assert.ok(r.report.totals.avoidableCost > 0 && r.report.totals.avoidableCost < r.report.totals.cost);
  assert.equal(r.report.outcomes.failures, 1);
  const out = J(r.calls) + J(r.report) + html(r.report);
  for (const s of ['xxxxxxxx', 'placeholder', 'select broken', 'package-lock']) assert.ok(!out.includes(s), `leaked ${s}`);
});

test('cli: demo, import → report round trip, help', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  assert.match(run('--help').stdout, /harness-ledger/);
  const j = JSON.parse(run('demo', '--json').stdout);
  assert.ok(j.totals.calls > 50 && j.byCause.length >= 7);
  const tmp = fs.mkdtempSync(path.join(DIR, '.tmp-')), out = path.join(tmp, 'calls.jsonl');
  try {
    const imp = run('import', path.join(DIR, 'fixtures'), '--out', out); assert.equal(imp.status, 0, imp.stderr);
    const a = JSON.parse(run('report', path.join(DIR, 'fixtures'), '--json').stdout), b = JSON.parse(run('report', out, '--json').stdout);
    assert.equal(a.totals.tokens, b.totals.tokens); assert.equal(a.totals.calls, 6);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.notEqual(run('report').status, 0);
});
