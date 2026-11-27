// What the main suites don't reach: the CLI's other commands, options and errors; OpenCost answers with several
// models or namespaces; GPU-time joins by time and replicas from gpu-ledger records; outcome rows in other shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demoInputs } from '../src/demo.mjs';
import { fromRest, fromPrometheus } from '../src/opencost.mjs';
import { engineRequests, replicaRates, joinGpu } from '../src/gpu.mjs';
import { tasksFromRows, tasksFromSwebench, outcomeReport, outcomeText } from '../src/outcomes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(here, '..', 'tools', 'harness-ledger.mjs'), FX = path.join(here, 'fixtures');
const run = (a, env) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hl-e-'));
function demoDir() { const d = tmp(); for (const f of demoInputs().files) { fs.mkdirSync(path.join(d, path.dirname(f.name)), { recursive: true }); fs.writeFileSync(path.join(d, f.name), f.text); } return d; }

test('CLI: formats, demo to HTML (and text), JSON with findings, calls out', () => {
  assert.match(run(['formats']).stdout, /^Inputs/);
  const d = tmp(), h = path.join(d, 'r.html'), c = path.join(d, 'calls.jsonl');
  const r = run(['demo', '--html', h, '--text', '--calls-out', c]); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /wrote .*r\.html/); assert.ok(fs.readFileSync(h, 'utf8').includes('<html')); assert.ok(r.stdout.length > 100, '--text with --html prints the text too');
  assert.ok(fs.readFileSync(c, 'utf8').trim().split('\n').every(l => JSON.parse(l).kind === 'llm_call'));
  const only = run(['demo', '--html', path.join(d, 'x.html')]); assert.equal(only.stdout, '', 'HTML alone: nothing on stdout');
  const j = JSON.parse(run(['demo', '--json', '--findings', '--cache-ttl', '600', '--big-result', '2000']).stdout); assert.ok(Array.isArray(j.findings) && j.findings.length > 0);
});

test('CLI: import a folder to stdout or a file, re-read the normalized calls, scan, and what it skips', () => {
  const d = demoDir(); fs.writeFileSync(path.join(d, 'other.json'), JSON.stringify({ hello: 'world' })); fs.writeFileSync(path.join(d, '.hidden.jsonl'), 'x');
  const r = run(['import', d]); assert.equal(r.status, 0); assert.match(r.stderr, /not recognised \(pass --format\): .*other\.json/);
  const calls = r.stdout.trim().split('\n').map(l => JSON.parse(l)); assert.ok(calls.length > 10);
  const out = path.join(tmp(), 'calls.jsonl'); run(['import', d, '--out', out]);
  const back = JSON.parse(run(['report', out, '--json']).stdout); assert.equal(back.totals.calls, calls.length, 'normalized calls read back as they are');
  assert.equal(run(['report', d, '--since', '1h', '--json']).status, 1, 'nothing in the last hour: no calls');
  assert.match(run(['report', d, '--since', 'yesterday-ish']).stderr, /--since: can't read/);
  const s = run(['scan', '--claude', path.join(d, 'claude-code'), '--codex', path.join(d, 'codex'), '--since', '2000-01-01', '--json']);
  assert.equal(s.status, 0, s.stderr); assert.match(s.stderr, /scanned 2 files/); assert.ok(JSON.parse(s.stdout).totals.calls > 0);
  const none = run(['scan'], { HOME: tmp(), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }); assert.equal(none.status, 1); assert.match(none.stderr, /no ~\/\.claude\/projects/);
});

test('CLI: usage errors and outcomes from CSV and JSON task lists', () => {
  for (const [a, code, re] of [[['import'], 2, /give files or folders/], [['report', FX, '--format', 'nope'], 2, /--format: one of/], [['economics'], 2, /give files or folders \(or --demo\)/],
    [['outcomes'], 2, /per_instance_details/], [['bogus'], 2, /unknown command "bogus"/]]) { const r = run(a); assert.equal(r.status, code, a.join(' ')); assert.match(r.stderr, re); }
  const d = tmp(); fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify([{ task: 't1', cost: 1, calls: 10, outcome: 'success' }, { task: 't2', cost: 2, calls: 40, outcome: 'failure' }]));
  fs.writeFileSync(path.join(d, 'b.csv'), 'session,costUSD,steps,resolved\ns1,0.5,5,true\ns2,1.5,30,false\ns3,0.7,8,1\n');
  const t = run(['outcomes', d]); assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /a\b/); assert.match(t.stdout, /b\b/);
  const j = JSON.parse(run(['outcomes', path.join(d, 'b.csv'), '--json']).stdout); assert.equal(j.runs[0].successes, 2);
  const empty = tmp(); fs.writeFileSync(path.join(empty, 'z.json'), JSON.stringify([{ task: 'x', cost: 0, outcome: 'failure' }])); assert.equal(run(['outcomes', empty]).status, 1, 'no usable run');
});

test('OpenCost: several models need a choice, several namespaces are token-weighted, cost sets read', async () => {
  const v = (input, output, tok) => ({ inputCostPerMillionTokens: input, outputCostPerMillionTokens: output, promptTokens: tok, generationTokens: 0, cacheSavingsFraction: 0.5 });
  const two = { data: { inferenceCosts: { 'a:ns1': v(1, 2, 100), 'b:ns1': v(3, 4, 100) } } };
  assert.throws(() => fromRest(two), /several models .*--opencost-model/); assert.equal(fromRest(two, { model: 'org/b' }).input, 3, 'matched on the last path part');
  const ns = fromRest({ data: { inferenceCostSets: [{ inferenceCosts: { 'm:x': v(1, 1, 300), 'm:y': v(5, 5, 100) } }] } }, { model: 'm' });
  assert.equal(ns.input, 2); assert.equal(ns.namespace, 'x,y'); assert.equal(ns.key, 'm:x+m:y');
  assert.equal(fromRest({ inferenceCosts: { solo: v(1, 1, 1) } }).namespace, null, 'a key without a namespace');
  await assert.rejects(fromPrometheus('http://p/', { fetcher: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('GPU time: requests matched by time within the trace, replicas from gpu-ledger records priced from the rate card', () => {
  const B = 1_800_000_000, span = (id, t, attrs, name = 'llm_request') => ({ traceId: 'T', spanId: id, name, startTimeUnixNano: String((B + t) * 1e9), endTimeUnixNano: String((B + t + 2) * 1e9), attributes: attrs });
  const reqs = engineRequests([span('e1', 100, { 'k8s.pod.name': 'r0', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100 }), span('e2', 105, { 'gen_ai.latency.e2e': 1, 'host.name': 'r1' }, 'other'), span('x', 1, {}, 'http')]);
  assert.equal(reqs.length, 2, 'llm_request spans, or any span with an e2e latency'); assert.equal(reqs[0].e2e, 2, 'no e2e attribute: the span length');
  const rates = replicaRates([{ labels: { pod: 'r0' }, gpus: 2, gpuType: 'H100' }, { name: 'r1', gpus: 1, rate: 4 }, { id: 'none', gpus: 0 }], { gpus: { H100: { aws: 6 } } });
  assert.equal(rates.get('r0').rate, 6, 'rate from the rate card'); assert.equal(rates.get('r1').rate, 4); assert.ok(!rates.has('none'));
  const calls = [{ traceId: 'T', t: B + 99.5, input: 1000, cacheRead: 200, output: 100 }, { traceId: 'T', t: B + 104.8, input: 10, output: 0 }, { traceId: 'U', t: B }];
  const j = joinGpu(calls, reqs, rates);
  assert.equal(j.matched, 2); assert.equal(calls[0].engine.replica, 'r0'); assert.equal(calls[1].engine.replica, 'r1');
  const p = j.prices.get(calls[0]); assert.ok(Math.abs(p.in * 800 + p.out * 100 - p.total) < 1e-12, 'no prefill/decode split: half and half, over prefilled and output tokens');
  assert.deepEqual(j.replicas.map(r => r.priced), [true, true]);
});

test('outcomes: rows and SWE-bench entries in their other spellings', () => {
  const rows = tasksFromRows([{ instance: 'i', cost: '2', api_calls: '7', resolved: 'passed', run: 'r', model: 'm' }, { id: 3, outcome: 'nope' }]);
  assert.deepEqual(rows.map(r => [r.task, r.run, r.cost, r.calls, r.outcome]), [['i', 'r', 2, 7, 'success'], ['3', 'run', 0, 0, 'failure']]);
  const sw = tasksFromSwebench({ a: { instance_cost: 1, calls: 3, resolved: true }, b: null });
  assert.deepEqual(sw.map(t => [t.task, t.cost, t.calls]), [['a', 1, 3]]);
  const R = outcomeReport([...rows, { task: 'z', run: 'free', cost: 0, calls: 1, outcome: 'success' }]);
  assert.deepEqual(R.skipped, ['run', 'free']); assert.match(outcomeText(R), /r/);
  assert.equal(outcomeReport([]).pooled, null);
});

test('importers: the rarer shapes each harness writes', async () => {
  const I = await import('../src/importers.mjs');
  // Claude Code: API error lines, sidechains without an agent id, synthetic messages skipped, image and object results
  const cc = [{ type: 'assistant', sessionId: 's', uuid: 'u1', timestamp: '2026-11-20T10:00:00Z', isSidechain: true, message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { f: 1 } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'image' }, { type: 'text', text: 'x' }, { a: 1 }] }, { type: 'tool_result', tool_use_id: 'nope', content: 'y' }] } },
    { type: 'assistant', sessionId: 's', uuid: 'u2', timestamp: '2026-11-20T10:00:01Z', isApiErrorMessage: true, message: {} },
    { type: 'assistant', sessionId: 's', uuid: 'u3', message: { model: '<synthetic>', usage: { input_tokens: 1 } } }].map(x => JSON.stringify(x)).join('\n') + '\n{"partial';
  const c = I.claudeCode(cc, { file: '/p/s.jsonl' });
  assert.equal(c.length, 2); assert.equal(c[0].agent, 'subagent'); assert.equal(c[0].session, 's:subagent'); assert.equal(c[0].toolCalls[0].error, true); assert.equal(c[1].error, 'api_error');
  assert.equal(I.detect(cc), 'claude-code');
  // Codex: token_count snapshots (repeats dropped), tool outputs as objects with exit codes or success false, text exit codes
  const ev = (type, payload, ts = '2026-11-20T10:00:00Z') => JSON.stringify({ type, timestamp: ts, payload });
  const cx = [ev('session_meta', { id: 'cx', source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } }), ev('turn_context', { model: 'gpt-5' }),
    ev('response_item', { type: 'local_shell_call', call_id: 'a', action: { cmd: 'ls' } }), ev('response_item', { type: 'function_call_output', call_id: 'a', output: { content: 'out', metadata: { exit_code: 2 } } }),
    ev('response_item', { type: 'custom_tool_call', call_id: 'b', input: 'x' }), ev('response_item', { type: 'custom_tool_call_output', call_id: 'b', output: '{"success":false}' }),
    ev('response_item', { type: 'function_call', name: 'sh', call_id: 'c', arguments: '{}' }), ev('response_item', { type: 'function_call_output', call_id: 'c', output: 'Process exited with exit code: 1' }),
    ev('response_item', { type: 'function_call_output', call_id: 'zz', output: 'orphan' }),
    ev('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 }, total_token_usage: { input_tokens: 100, output_tokens: 10 } } }),
    ev('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 }, total_token_usage: { input_tokens: 100, output_tokens: 10 } } }),
    ev('event_msg', { type: 'token_count', info: {} })].join('\n');
  const x = I.codex(cx);
  assert.equal(x.length, 1, 'a repeated snapshot is one call'); assert.equal(x[0].agent, 'subagent'); assert.equal(x[0].parent, 'p'); assert.equal(x[0].model, 'gpt-5');
  assert.deepEqual(x[0].toolCalls.map(t => [t.name, !!t.error]), [['local_shell_call', true], ['custom_tool_call', true], ['sh', true]]);
  // token_usage_record lines win, and lines a fork copied from its parent are skipped
  const rec = I.codex([ev('session_meta', { id: 'me', forked_from_id: 'par' }), ev('token_usage_record', { thread_id: 'par', usage: { input_tokens: 9 } }), ev('token_usage_record', { thread_id: 'me', response_id: 'r', model: 'o3', usage: { input_tokens: 7, output_tokens: 1 } })].join('\n'));
  assert.deepEqual(rec.map(r => [r.input, r.model, r.parent]), [[7, 'o3', 'par']]);
  // OTel: OTLP with typed values, status codes, OpenInference tool schemas without names, string tool definitions
  const kv = (key, value) => ({ key, value });
  const otlp = { resourceSpans: [{ resource: { attributes: [kv('service.name', { stringValue: 'svc' })] }, scopeSpans: [{ spans: [
    { traceId: 'T', spanId: 'a', name: 'chat', startTimeUnixNano: '1800000000000000000', endTimeUnixNano: '1800000001000000000', status: { code: 2 },
      attributes: [kv('gen_ai.operation.name', { stringValue: 'chat' }), kv('gen_ai.usage.prompt_tokens', { intValue: '100' }), kv('gen_ai.usage.completion_tokens', { doubleValue: 5 }), kv('stream', { boolValue: true }),
        kv('gen_ai.tool.definitions', { stringValue: '[{"function":{"name":"f"}}]' }), kv('gen_ai.response.finish_reasons', { arrayValue: { values: [{ stringValue: 'stop' }] } }), kv('meta', { kvlistValue: { values: [kv('k', { stringValue: 'v' })] } }), kv('nil', {})] },
    { traceId: 'T', spanId: 'b', name: 'llm', startTimeUnixNano: '1800000002000000000', endTimeUnixNano: '1800000003000000000',
      attributes: [kv('openinference.span.kind', { stringValue: 'LLM' }), kv('llm.token_count.prompt', { intValue: '50' }), kv('llm.tools.0.tool.json_schema', { stringValue: '{"function":{"name":"g"}}' }), kv('llm.tools.1.tool.json_schema', { stringValue: 'not json' })] },
    { traceId: 'T', spanId: 't', name: 'tool', startTimeUnixNano: '1800000003500000000', status: { code: 'STATUS_CODE_ERROR' }, attributes: [kv('openinference.span.kind', { stringValue: 'TOOL' }), kv('tool.name', { stringValue: 'g' }), kv('output.value', { stringValue: 'res' })] },
    { traceId: 'T', spanId: 'early', name: 'tool0', startTimeUnixNano: '1799999999000000000', attributes: [kv('gen_ai.operation.name', { stringValue: 'execute_tool' })] }] }] }] };
  const o = I.otel(otlp);
  assert.equal(o.length, 2); assert.equal(o[0].harness, 'svc'); assert.equal(o[0].input, 100); assert.equal(o[0].output, 5); assert.equal(o[0].error, 'error'); assert.deepEqual(o[0].toolsOffered, ['f']); assert.equal(o[0].finish, 'stop');
  assert.deepEqual(o[1].toolsOffered, ['g']); assert.equal(o[1].toolCalls[0].error, true); assert.ok(o[1].toolCalls[0].resultTokens > 0);
  assert.equal(I.flattenSpans({ spans: [{ trace_id: 'x', span_id: 'y', name: 'n', start_time: '2026-11-20T10:00:00Z' }] }).length, 1, 'arrays of spans with snake_case ids');
  assert.equal(I.flattenSpans('{"name":"n","context":{"trace_id":"a","span_id":"b"},"start_time":"2026-11-20T10:00:00Z"}\n').length, 1, 'one span per line');
  // Langfuse: traces holding observations, OpenAI-style inclusive usage, errors, tool observations matched to a call's tool_calls
  const lf = I.langfuse({ data: [{ id: 'tr', sessionId: 'ss', observations: [
    { id: 'g', type: 'GENERATION', startTime: '2026-11-20T10:00:00Z', endTime: '2026-11-20T10:00:01Z', providedModelName: 'm', level: 'ERROR', usage: { promptTokens: 30, completionTokens: 3 }, costDetails: { total: 0.1 },
      output: { toolCalls: [{ function: { name: 'f', arguments: '{}' }, id: 'c1' }] }, input: { tools: [{ function: { name: 'f' } }] } },
    { id: 'u', type: 'TOOL', name: 'f', startTime: '2026-11-20T10:00:02Z', output: 'done', level: 'ERROR' }, { id: 'v', type: 'TOOL', name: 'h', startTime: '2026-11-20T10:00:03Z', input: { q: 1 } },
    { id: 'w', type: 'TOOL', name: 'early', startTime: '2026-11-20T09:00:00Z' }] }, null] });
  assert.equal(lf.length, 1); assert.deepEqual([lf[0].input, lf[0].output, lf[0].error, lf[0].costUSD, lf[0].session], [30, 3, 'error', 0.1, 'ss']);
  assert.deepEqual(lf[0].toolCalls.map(t => [t.name, !!t.error]), [['f', true], ['h', false]]);
  assert.equal(I.langfuse('{"type":"GENERATION","id":"z","startTime":"2026-11-20T10:00:00Z","usageDetails":{"input":5,"input_cached_tokens":5}}\n').at(0).input, 10, 'exclusive keys add up');
  // TraceLab: no timing events, Codex prefix cache, tools with errors
  assert.equal(I.tracelabCall({ timing_events: [] }), null);
  const tl = I.tracelab(JSON.stringify({ input_tokens_total: 10, prefix_tokens: 4, output_tokens: 1, timing_events: [{ event_type: 'request', timestamp: '2026-11-20T10:00:00Z' }], tools: [{ tool_name: 'x', is_error: true }] }) + '\n{"x":1}');
  assert.deepEqual([tl[0].harness, tl[0].cacheRead, tl[0].toolCalls[0].error], ['codex', 4, true]);
  assert.equal(I.detect('{"usageDetails":{}}'), 'langfuse'); assert.equal(I.detect('{}', 'a/rollout-2026-x.jsonl'), 'codex'); assert.equal(I.detect('{"a":1}'), null);
  assert.throws(() => I.importText('{"a":1}', { file: 'f.json' }), /can't tell what f\.json is/);
});
