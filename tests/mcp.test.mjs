// The MCP server over real stdio, as a client sees it: the handshake, the tool list, real calls whose
// structuredContent matches each tool's outputSchema, errors, and the refusal to act on infrastructure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/schemas.mjs';
import { generate } from '../hybrid-tracing/src/synth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));

class Client {
  constructor(argv) {
    this.p = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiting = new Map(); this.id = 0; this.unsolicited = [];
    this.p.stdout.on('data', d => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (!line.trim()) continue;
        const m = JSON.parse(line), w = this.waiting.get(m.id);
        if (w) { this.waiting.delete(m.id); w(m); } else this.unsolicited.push(m);
      }
    });
  }
  send(method, params) { const id = ++this.id; this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise(r => this.waiting.set(id, r)); }
  notify(method, params) { this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  raw(line) { this.p.stdin.write(line + '\n'); }
  close() { this.p.stdin.end(); this.p.kill(); }
}

let c, tools;
before(async () => { c = new Client([path.join(ROOT, 'bin', 'aiinfra.mjs'), 'mcp']); });
after(() => c && c.close());

test('handshake: negotiates the protocol, names the server, answers ping; notifications get no reply', async () => {
  const r = await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'aiinfra-tools'); assert.ok(r.result.capabilities.tools);
  c.notify('notifications/initialized');
  assert.deepEqual((await c.send('ping')).result, {});
  const old = await c.send('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(old.result.protocolVersion, '2025-06-18', 'an unknown version gets the latest we speak');
  assert.equal(c.unsolicited.length, 0);
});

test('tools/list: 19 tools, valid input and output schemas, nothing that acts on infrastructure', async () => {
  tools = (await c.send('tools/list')).result.tools;
  assert.equal(tools.length, 19); assert.equal(new Set(tools.map(t => t.name)).size, 19);
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/); assert.ok(t.description.length > 30, t.name);
    assert.equal(t.inputSchema.type, 'object');
    for (const k of Object.keys(t.inputSchema.properties || {})) assert.doesNotMatch(k, /live|apply|approve|execute/i, `${t.name}.${k}`);
    if (t.outputSchema) assert.equal(t.outputSchema.type, 'object');
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

const call = async (name, args) => (await c.send('tools/call', { name, arguments: args })).result;
const checked = (name, r) => {
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text?.slice(0, 300)}`);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, 'the text and structured results agree');
  const s = tools.find(t => t.name === name).outputSchema;
  if (s) assert.deepEqual(validate(s, r.structuredContent), [], `${name} matches its outputSchema`);
  return r.structuredContent;
};

test('calls: sizing, fit and capacity, a fleet simulation, a what-if', { timeout: 300000 }, async () => {
  assert.ok(checked('list_catalog', await call('list_catalog', {})));
  const plan = checked('size_inference', await call('size_inference', { model: 'llama33-70b', gpu: 'H100', inputs: { conc: 200, tpot: 40 } }));
  assert.ok(plan);
  const cmp = await call('size_inference', { model: 'llama33-70b', compare: ['H100', 'H200', 'B200'] });
  assert.ok(!cmp.isError && cmp.structuredContent);
  const fit = checked('what_fits', await call('what_fits', { gpu: 'H100', nodes: 2, rate: 5 }));
  assert.ok(JSON.stringify(fit).includes('llama33-70b'));
  checked('model_capacity', await call('model_capacity', { model: 'llama33-70b', gpu: 'H100', nodes: 2 }));
  const tpl = await call('fleetscope_templates', {}); assert.ok(!tpl.isError);
  checked('fleetscope_run', await call('fleetscope_run', { template: 'burst' }));
  checked('fleetscope_ask', await call('fleetscope_ask', { question: 'What if traffic doubles?', template: 'xpd' }));
});

test('calls on data: GPU health, the ledger, root cause, power, trace skew', { timeout: 300000 }, async () => {
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'aiinfra.mjs'), ...a], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 });
  cli('gpu-health', 'demo', '--out', path.join(dir, 'g'));
  checked('gpu_health_analyze', await call('gpu_health_analyze', { samples: path.join(dir, 'g/data/samples.jsonl'), jobs: path.join(dir, 'g/data/jobs.json'), state: path.join(dir, 'gs') }));
  cli('ledger', 'demo', '--out', path.join(dir, 'l'));
  const L = { usage: path.join(dir, 'l/usage.jsonl'), config: path.join(dir, 'l/ledger.json') };
  checked('ledger_report', await call('ledger_report', L)); checked('ledger_insights', await call('ledger_insights', L));
  const hw = await call('harness_waste', { paths: path.join(ROOT, 'harness-ledger/tests/fixtures') });
  assert.ok(!hw.isError, hw.content[0].text); assert.equal(hw.structuredContent.totals.calls, 6);
  const demo = JSON.parse(cli('fleetops', 'demo', '--store', path.join(dir, 'f'), '--json')).demo;
  const d = checked('rca_diagnose', await call('rca_diagnose', { store: path.join(dir, 'f'), symptom: demo.incident.symptom, from: String(demo.incident.from), to: String(demo.incident.to) }));
  assert.ok(JSON.stringify(d).length > 100);
  const pw = JSON.parse(cli('fleetops', 'power', 'demo', '--store', path.join(dir, 'p'), '--json')).demo;
  const P = { store: path.join(dir, 'p'), budgets: pw.budgets, from: String(pw.from), to: String(pw.to) };
  checked('power_report', await call('power_report', P));
  checked('power_plan', await call('power_plan', Object.assign({ out: path.join(dir, 'plan.json') }, P)));
  assert.ok(fs.existsSync(path.join(dir, 'plan.json')), 'the plan is written; nothing is applied');
  const g = generate({ requests: 60 }); fs.writeFileSync(path.join(dir, 'traces.json'), JSON.stringify(g.request));
  const sk = checked('fix_trace_skew', await call('fix_trace_skew', { traces: path.join(dir, 'traces.json') }));
  assert.ok(sk.after.startBeforeParent <= sk.before.startBeforeParent);
});

test('calls for the loop: a shadow verdict (store and Prometheus), a canary\'s status, agent economics', { timeout: 300000 }, async () => {
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'aiinfra.mjs'), ...a], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 });
  const store = path.join(dir, 'sh'); cli('fleetops', 'shadow', 'demo', '--store', store, '--json');
  const v = await call('shadow_verdict', { store, baseline: 'variant=baseline', candidate: 'variant=candidate' });
  assert.ok(!v.isError, v.content[0].text); assert.equal(v.structuredContent.shadow.decision, 'roll back');
  const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'fleetops.shadow.compare.schema.json'), 'utf8'));
  assert.deepEqual(validate(sc, v.structuredContent), [], 'matches the compare schema');
  const unreachable = await call('shadow_verdict', { store, prom: 'http://127.0.0.1:1', baselineMatchers: 'llm_isvc_name="a"', candidateMatchers: 'llm_isvc_name="b"' });
  assert.ok(unreachable.isError, 'Prometheus mode reports an unreachable server as an error');
  // a canary started outside the server (`true` stands in for kubectl); the server only reads it
  cli('fleetops', 'shadow', 'canary', 'start', '--name', 'chat', '--group', 'chat', '--baseline', 'v1', '--candidate', 'v2', '--live', '--kubectl', 'true', '--store', store, '--json');
  const cs = checked('canary_status', await call('canary_status', { store, name: 'chat' }));
  assert.equal(cs.canary.status, 'running'); assert.equal(cs.canary.steps[0], 1);
  assert.ok(!tools.some(t => /canary_(advance|approve)/.test(t.name)), 'advancing or approving a canary is a person\'s, outside the server');
  const e = checked('agent_economics', await call('agent_economics', { paths: path.join(ROOT, 'harness-ledger/tests/fixtures'), days: 30, selfHostModel: 'qwen3-32b', gpu: 'H100', gpuRate: 2 }));
  assert.ok(e.fixes && e.selfHost && e.selfHost.gpus > 0);
  const sneaky = await call('canary_status', { store, name: '--live' }); assert.ok(sneaky.isError);
});

test('errors: unknown tool and method, a missing argument, bad JSON; and a smuggled --live is refused', async () => {
  const u = await c.send('tools/call', { name: 'drain_node', arguments: {} }); assert.equal(u.error.code, -32602);
  assert.equal((await c.send('resources/list')).error.code, -32601);
  const m = await call('size_inference', {}); assert.ok(m.isError); assert.match(m.content[0].text, /missing required argument: model/);
  const bad = new Promise(r => { const n = c.unsolicited.length; const t = setInterval(() => { if (c.unsolicited.length > n) { clearInterval(t); r(c.unsolicited.at(-1)); } }, 10); });
  c.raw('{not json'); assert.equal((await bad).error.code, -32700);
  const sneaky = await call('ledger_report', { usage: 'u.jsonl', config: 'c.json', by: '--live' });
  assert.ok(sneaky.isError); assert.match(sneaky.content[0].text, /never acts on infrastructure/);
  const sneaky2 = await call('rca_diagnose', { store: 's', symptom: 'latency', from: '1', to: '2', pool: '--apply' });
  assert.ok(sneaky2.isError);
});
