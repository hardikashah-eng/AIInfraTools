// The command-line tools end to end: fleetscope (templates, run, ask, compare, power), convert-trace, fleetscope-plan,
// live-twin on its synthetic week, and agentic.mjs's other commands and inputs. Usage errors exit 2 (1 for a failed
// check or a question not understood).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url)), T = n => path.join(here, '..', 'tools', n), FX = path.join(here, 'fixtures'), SC = path.join(here, '..', 'scenarios', 'hybrid-chat');
const A = createRequire(import.meta.url)('../src/agentic.js');
const run = (tool, a) => spawnSync(process.execPath, [T(tool), ...a], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-cli-'));
const J = JSON.parse;

test('fleetscope: templates, a template written out, examples, run on a graph file with a replayed trace', () => {
  assert.match(run('fleetscope.mjs', ['templates']).stdout, /^burst +Hybrid chat burst/m);
  const d = tmp(), g = path.join(d, 'g.json');
  assert.match(run('fleetscope.mjs', ['template', 'burst', '-o', g]).stderr, /wrote/); assert.ok(J(fs.readFileSync(g, 'utf8')).nodes.length > 0);
  assert.equal(J(run('fleetscope.mjs', ['template', '--template', 'agent', '-o', path.join(d, 'a.json'), '--json']).stdout).wrote, path.join(d, 'a.json'));
  assert.ok(J(run('fleetscope.mjs', ['template', 'blank']).stdout).nodes);
  assert.ok(J(run('fleetscope.mjs', ['examples', '--json']).stdout).length > 5);
  const t = run('fleetscope.mjs', ['run', '--graph', g, '--trace', path.join(FX, 'openai-gateway.jsonl')]); assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /replaying \d+ requests from/); assert.match(t.stdout, /Uncalibrated/);
  const j = J(run('fleetscope.mjs', ['run', '--scenario', SC, '--json']).stdout); assert.ok(j.fleet.length > 0);
});

test('fleetscope: ask (understood, edited graph written; or not understood), compare, power with caps and budgets', () => {
  const d = tmp(), out = path.join(d, 'edited.json');
  const a = run('fleetscope.mjs', ['ask', 'What if traffic doubles?', '--template', 'burst', '-o', out]); assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^Read as: /); assert.match(a.stdout, /Edited graph written/); assert.ok(fs.existsSync(out));
  const n = run('fleetscope.mjs', ['ask', 'bake me a cake', '--template', 'burst', '--json']); assert.equal(n.status, 1); assert.equal(J(n.stdout).understood, false);
  const c = run('fleetscope.mjs', ['compare', '--base', SC, '--head', SC, '--json']); assert.equal(c.status, 0, c.stderr); assert.notEqual(J(c.stdout).verdict, 'fail');
  const p = run('fleetscope.mjs', ['power', '--template', 'burst', '--cap', '*=70', '--budget', 'onprem=50']); assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /With the caps: SLO/); assert.match(p.stdout, /^Site +IT kW peak/m);
  const pj = J(run('fleetscope.mjs', ['power', '--template', 'burst', '--alpha-compute', '0.4', '--json']).stdout); assert.equal(pj.capped, null); assert.ok(pj.base.tokensPerMWh > 0);
  assert.match(run('fleetscope.mjs', ['power', '--template', 'burst']).stdout, /Try --cap POOL=70/);
});

test('fleetscope: usage errors', () => {
  const d = tmp(), bad = path.join(d, 'bad.json'), empty = tmp(); fs.writeFileSync(bad, '{');
  const tr = path.join(d, 'empty.csv'); fs.writeFileSync(tr, 'timestamp,input_tokens,output_tokens\n');
  for (const [a, re] of [[['run'], /Give a source/], [['run', '--template', 'nope'], /Unknown template "nope"/], [['run', '--graph', bad], /bad\.json: /], [['run', '--scenario', empty], /no graph\.json/],
    [['ask', '--template', 'burst'], /Give the question/], [['compare', '--base', SC], /compare needs --base DIR and --head DIR/], [['power', '--template', 'burst', '--cap', 'nope=50'], /no pool named nope/],
    [['run', '--template', 'burst', '--trace', tr], /empty\.csv: /], [['frobnicate'], /Unknown command "frobnicate"/]]) {
    const r = run('fleetscope.mjs', a); assert.equal(r.status, 2, a.join(' ')); assert.match(r.stderr, re);
  }
  assert.match(J(run('fleetscope.mjs', ['run', '--json']).stdout).error, /Give a source/);
  assert.match(run('fleetscope.mjs', ['--help']).stdout, /FleetScope without the browser/);
});

test('convert-trace: a window, a row cap and a sample; fleetscope-plan between two folders; live-twin on the synthetic week', () => {
  const d = tmp(), o = path.join(d, 'out.csv');
  const r = run('convert-trace.mjs', [path.join(FX, 'vllm-otlp.jsonl'), '-o', o, '--start-offset', '0', '--minutes', '60', '--max-rows', '2', '--sample', '1']); assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(o, 'utf8').trim().split('\n'); assert.match(rows[0], /^timestamp/); assert.ok(rows.length - 1 <= 2);
  assert.match(run('convert-trace.mjs', [path.join(FX, 'anthropic-gateway.jsonl')]).stdout, /^timestamp/);
  assert.match(run('convert-trace.mjs', []).stderr, /^Usage: /); const bad = run('convert-trace.mjs', [path.join(FX, 'vllm-otlp.jsonl'), '--sample', '2']); assert.equal(bad.status, 1); assert.match(bad.stderr, /^Error: /);
  const md = path.join(d, 'plan.md'), p = run('fleetscope-plan.mjs', ['--base', SC, '--head', SC, '--out', md]); assert.equal(p.status, 0, p.stderr); assert.ok(fs.readFileSync(md, 'utf8').length > 50);
  assert.equal(run('fleetscope-plan.mjs', []).status, 2);
  const lt = run('live-twin.mjs', ['--sample', '--hours', '2', '--band', 'hi', '--json']); assert.equal(lt.status, J(lt.stdout).alerts.length ? 1 : 0, 'exit 1 when a breach is predicted');
  assert.equal(run('live-twin.mjs', []).status, 2);
  assert.equal(run('live-twin.mjs', ['--sample', '--hours', '2']).status, 0);
});

test('agentic: stats with --ideal and a load, a Mooncake trace, CSV rows, validate as Markdown, and its errors', () => {
  const d = tmp(), r = A.rng(3), rows = [];
  for (let s = 0; s < 120; s++) { let t = r() * 3600, isl = 8000; for (let i = 0; i < 6; i++) { rows.push({ t, isl, osl: 100, cached: i ? isl - 600 : 0, session: 'u' + s, api: 3 }); isl += 600; t += 10; } }
  const f = path.join(d, 'rows.jsonl'); fs.writeFileSync(f, rows.sort((a, b) => a.t - b.t).map(x => JSON.stringify(x)).join('\n') + '\n');
  const st = J(run('agentic.mjs', ['stats', f, '--ideal', '--sessions-per-hour', '200', '--json']).stdout); assert.ok(st.requests > 0);
  assert.match(run('agentic.mjs', ['stats', f]).stdout, /calls, \d+ sessions/);
  const mc = path.join(d, 'mc.jsonl'); fs.writeFileSync(mc, [0, 1000, 2000].map((ts, i) => JSON.stringify({ timestamp: ts, input_length: 1024 + i * 512, output_length: 20, hash_ids: [0, 1, 2].slice(0, 2 + i) })).join('\n'));
  assert.equal(J(run('agentic.mjs', ['stats', mc, '--json']).stdout).requests, 3);
  const csv = path.join(d, 'pf.json'); assert.equal(run('agentic.mjs', ['fit', f, '-o', csv]).status, 0);
  const syn = path.join(d, 's.jsonl'); assert.equal(run('agentic.mjs', ['synth', csv, '--sessions-per-hour', '60', '-o', syn]).status, 0);
  assert.ok(J(fs.readFileSync(syn, 'utf8').split('\n')[0]).session != null);
  assert.ok(run('agentic.mjs', ['synth', csv, '--sessions-per-hour', '30']).stdout.length > 0, 'to stdout');
  assert.ok(J(run('agentic.mjs', ['fit', f, '--json']).stdout).kind, 'the profile itself without -o');
  const v = run('agentic.mjs', ['validate', f, '--sessions-per-hour', '120', '--seeds', '2', '--model', 'qwen3-32b', '--gpu', 'H100', '--markdown']); assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^# Agentic workload profiles against held-out sessions/m);
  assert.ok(J(run('agentic.mjs', ['validate', f, '--sessions-per-hour', '120', '--seeds', '1', '--json']).stdout).agg);
  const junk = path.join(d, 'junk.jsonl'); fs.writeFileSync(junk, '{"hello":1}\n');
  for (const [a, re] of [[['size', csv], /needs --sessions-per-hour/], [['synth', f], /synth needs a profile/], [['stats'], /give a trace or profile file/], [['size', f, '--model', 'nope'], /unknown model nope/],
    [['size', f, '--gpu', 'nope'], /unknown GPU nope/], [['stats', junk], /not a trace this tool reads/]]) { const x = run('agentic.mjs', a); assert.notEqual(x.status, 0, a.join(' ')); assert.match(x.stderr + x.stdout, re); }
  assert.match(run('agentic.mjs', []).stdout, /Agentic workloads for capacity planning/);
});
