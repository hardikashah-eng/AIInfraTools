#!/usr/bin/env node
// Smoke-tests each skill the way an agent uses it: copies the skill folder somewhere outside the repo (so nothing
// can reach back into the tool directories), runs the commands its SKILL.md documents, and checks the JSON.
//
//   node scripts/test-skills.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-smoke-'));
const isolate = name => { const dst = path.join(WORK, name); fs.cpSync(path.join(ROOT, 'skills', name), dst, { recursive: true }); return dst; };
function run(dir, cmd, args, { input, code = 0 } = {}) {
  const r = spawnSync(cmd, args, { cwd: dir, input, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, code, `${cmd} ${args.join(' ')} exited ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`);
  return r.stdout;
}
const json = (dir, args, opt) => JSON.parse(run(dir, 'node', args, opt));

test('inference-sizer: list, compare, single GPU from stdin, export to FleetScope', () => {
  const d = isolate('inference-sizer'), cli = 'scripts/inference-sizer/tools/size.mjs';
  const list = json(d, [cli, '--list', '--json']);
  assert.ok(list.gpus.some(g => g.id === 'B200') && list.models.some(m => m.id === 'llama33-70b') && list.inputs.includes('tpot'));
  fs.writeFileSync(path.join(d, 'in.json'), JSON.stringify({ model: 'llama33-70b', conc: 800, ttft: 1000, tpot: 25 }));
  const cmp = json(d, [cli, '--input', 'in.json', '--compare', 'B200,H200,MI300X', '--json']);
  assert.equal(cmp.results.length, 3);
  const found = cmp.results.filter(r => r.found);
  assert.ok(found.length >= 1);
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].costPerHour <= found[i].costPerHour, 'cheapest first');
  const one = json(d, [cli, '--input', '-', '--json'], { input: JSON.stringify({ model: 'llama33-70b', gpu: 'H200', conc: 200 }) });
  assert.equal(one.gpuId, 'H200'); assert.ok(one.pools.length >= 1);
  assert.deepEqual(json(d, [cli, '--model', 'nope', '--json'], { code: 2 }), { error: 'Unknown model "nope". Use --list.' });
  run(d, 'node', [cli, '--input', 'in.json', '--gpu', 'B200', '--fleetscope', path.join(WORK, 'sized-graph.json')]);
  assert.ok(fs.existsSync(path.join(WORK, 'sized-graph.json')));
});

test('fleetscope: templates, run, ask, compare, and a graph from inference-sizer', () => {
  const d = isolate('fleetscope'), cli = 'scripts/fleetscope/tools/fleetscope.mjs';
  const t = json(d, [cli, 'templates', '--json']);
  assert.ok(t.some(x => x.id === 'burst'));
  const r = json(d, [cli, 'run', '--template', 'burst', '--json']);
  assert.equal(r.fleet.length, 4); assert.ok(r.fleet[0].slo >= 0 && r.fleet[0].slo <= 1);
  const a = json(d, [cli, 'ask', 'What if the cloud link drops to 25 Gbps?', '--template', 'xpd', '--json', '-o', 'edited.json']);
  assert.equal(a.understood, true); assert.deepEqual(a.readAs, ['Cloud link at 25 Gbps']); assert.ok(a.after.slo <= a.before.slo);
  assert.ok(fs.existsSync(path.join(d, 'edited.json')));
  json(d, [cli, 'ask', 'make it purple', '--template', 'burst', '--json'], { code: 1 });
  const c = json(d, [cli, 'compare', '--base', 'assets/scenarios/hybrid-chat', '--head', 'assets/scenarios/hybrid-chat', '--json']);
  assert.equal(c.verdict, 'nochange');
  const sc = json(d, [cli, 'run', '--scenario', 'assets/scenarios/hybrid-chat', '--json']);
  assert.ok(sc.fleet && sc.cluster);
  const g = path.join(WORK, 'sized-graph.json');
  if (fs.existsSync(g)) assert.ok(json(d, [cli, 'run', '--graph', g, '--json']).fleet.length >= 1);
});

test('hybrid-tracing: demo skew fix and clock check help', () => {
  const d = isolate('hybrid-tracing');
  const rep = json(d, ['scripts/hybrid-tracing/tools/fix-skew.mjs', '--demo', '--json']);
  assert.ok(rep.rows.some(r => r.method === 'two-way')); assert.ok(rep.after.startBeforeParent < rep.before.startBeforeParent);
  run(d, 'bash', ['scripts/hybrid-tracing/clock/check-clock.sh', '--help']);
  for (const f of ['clock/ptp4l.conf', 'collector/tailsampler.yaml', 'deploy/skew-corrector.yaml']) assert.ok(fs.existsSync(path.join(d, 'scripts/hybrid-tracing', f)), f);
});

test('gpu-health: demo, analyze digest, approval needs a name, execute is a dry run', () => {
  const d = isolate('gpu-health'), cli = 'scripts/gpu-health/tools/gpu-health.mjs';
  const demo = json(d, [cli, 'demo', '--out', 'demo', '--json']);
  assert.ok(demo.summary.gpus === 32 && demo.gpusNotServing.length > 0 && demo.openActions.length > 0);
  const st = ['--state', 'demo/state'];
  const id = demo.openActions.find(a => a.status === 'proposed' && a.kind === 'scale-in').id;
  json(d, [cli, 'actions', 'approve', id, ...st, '--json'], { code: 1 });
  const ap = json(d, [cli, 'actions', 'approve', id, '--by', 'tester', ...st, '--json']);
  assert.equal(ap.approved[0].approvedBy, 'tester');
  const ex = json(d, [cli, 'actions', 'execute', id, ...st, '--json']);
  assert.equal(ex.executed[0].outcome, 'dry-run'); assert.equal(ex.executed[0].commands[0][0], 'kubectl');
  const live = json(d, [cli, 'actions', 'execute', id, '--live', ...st, '--json']);
  assert.match(live.note, /still a dry-run/); assert.equal(live.executed[0].outcome, 'dry-run');
  const mixed = json(d, [cli, 'demo', '--mixed', '--out', 'mixed', '--json']);
  assert.deepEqual(mixed.gpusNotServing.map(g => g.gpu).sort(), ['a1/1', 's1/2', 't1/3']);
  assert.ok(mixed.coverage.find(c => c.vendor === 'tpu').blind.includes('ecc'));
  assert.ok(!mixed.openActions.some(a => a.id.startsWith('gpu-reset:t1/')));
});
