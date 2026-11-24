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
  const fz = json(d, [cli, 'flakiness', ...st, '--json']);
  assert.equal(fz.devices[0].key, 'n1/2'); assert.ok(fz.devices.some(r => r.verdict === 'rma-candidate'));
  assert.deepEqual(fz.hotCohorts.map(c => c.value), ['n2']);
  const mixed = json(d, [cli, 'demo', '--mixed', '--out', 'mixed', '--json']);
  assert.deepEqual(mixed.gpusNotServing.map(g => g.gpu).sort(), ['a1/1', 's1/2', 't1/3']);
  assert.ok(mixed.coverage.find(c => c.vendor === 'tpu').blind.includes('ecc'));
  assert.ok(!mixed.openActions.some(a => a.id.startsWith('gpu-reset:t1/')));
});

test('gpu-ledger: demo → report finds the planted waste, FOCUS export, slurm import, serving sizing through the vendored sizer', () => {
  const d = isolate('gpu-ledger'), cli = 'scripts/gpu-ledger/tools/ledger.mjs';
  run(d, 'node', [cli, 'demo', '--out', 'ld']);
  const r = json(d, [cli, 'report', '--usage', 'ld/usage.jsonl', '--config', 'ld/ledger.json', '--json']);
  const kinds = new Set(r.insights.map(i => i.kind));
  for (const k of ['idle-timeout', 'repeated-failure', 'gpu-type', 'serving-scale', 'commitment']) assert.ok(kinds.has(k), k);
  run(d, 'node', [cli, 'focus', '--usage', 'ld/usage.jsonl', '--config', 'ld/ledger.json', '--out', 'f.csv']);
  assert.match(fs.readFileSync(path.join(d, 'f.csv'), 'utf8'), /^BilledCost,/);
  assert.match(run(d, 'node', [cli, 'rates', '--config', 'assets/ledger.example.json']), /H100 +onprem/);
  assert.ok(fs.existsSync(path.join(d, 'scripts/inference-sizer/src/fit.js')), 'the sizer is vendored for serving sizing');
});

test('fleetops: demo → diagnose names the planted cause, game day is a dry run and checks the allowlist, k8s dry run', () => {
  const d = isolate('fleetops'), cli = 'scripts/fleetops/tools/fleetops.mjs', ex = 'scripts/fleetops/examples';
  assert.equal(json(d, [cli, 'demo', '--list', '--json']).scenarios.length, 18);
  for (const sc of ['hardware: GPU fault seen in dmesg', 'slow-link', 'kv-pressure']) {
    const demo = json(d, [cli, 'demo', '--scenario', sc, '--store', `s-${sc.split(':')[0]}`, '--json']).demo;
    const diag = json(d, [...demo.next[1].replace(/^fleetops /, `${cli} `).split(' '), '--json']);
    assert.equal(diag.incidents[0].hypotheses[0].rule, demo.planted.cause, sc);
  }
  const s = json(d, [cli, 'incidents', 'open', '--from', '2026-01-15T06:00:00Z', '--to', '2026-01-15T14:00:00Z', '--min-failures', '5', '--store', 's-hardware', '--json']);
  assert.equal(s.opened.length, 1);
  assert.match(run(d, 'node', [cli, 'incidents', 'page', s.opened[0].id, '--to', 'webhook', '--url', 'https://hooks.example/x', '--action', 'trigger', '--store', 's-hardware']), /dry run/i);
  const imp = json(d, [cli, 'data', 'import', 'exporter', `${ex}/dcgm.example.prom`, '--store', 'imp', '--json']);
  assert.ok(imp.imported.device.written >= 1);
  assert.deepEqual(json(d, [cli, 'gameday', `${ex}/gameday-plan.example.json`, '--allow', `${ex}/test-cluster.allow`, '--store', 'g', '--json']).gameday, { dryRun: true, steps: 3 });
  fs.writeFileSync(path.join(d, 'narrow.allow'), 'gpu-t01\n');
  run(d, 'node', [cli, 'gameday', `${ex}/gameday-plan.example.json`, '--allow', 'narrow.allow', '--store', 'g'], { code: 1 });
  const k8s = run(d, 'bash', ['scripts/fleetops/install/install-k8s.sh', '--image', 'registry.example/fleetops:1', '--dry-run']);
  assert.match(k8s, /kind: Deployment/); assert.match(k8s, /image: registry\.example\/fleetops:1/);
  for (const f of ['install/install.sh', 'install/install-docker.sh', 'install/uninstall.sh']) run(d, 'bash', ['-n', `scripts/fleetops/${f}`]);
  // the live agent: one check on a demo happening now; a dry run that proposes and waits for a person
  json(d, [cli, 'demo', '--scenario', 'slow-link', '--now', '--store', 'live', '--json']);
  const t = json(d, [cli, 'agent', '--once', '--store', 'live', '--json']).tick;
  assert.equal(t.live, false); assert.equal(t.incidents[0].rule, 'slow-link');
  assert.ok(t.executed.every(e => e.outcome === 'dry-run'));
  const st = json(d, [cli, 'agent', 'status', '--store', 'live', '--json']).status;
  // goodput on the training demo; silent corruption on its benchmark scenario
  json(d, [cli, 'demo', '--training', '--store', 'train', '--json']);
  const gp = json(d, [cli, 'goodput', '--days', '7', '--store', 'train', '--json']).goodput;
  assert.equal(gp.jobs.find(j => j.job === 'sft-8b').top, 'data-stall');
  json(d, [cli, 'demo', '--scenario', 'silent-corruption', '--store', 'sdc', '--json']);
  const sd = json(d, [cli, 'sdc', '--from', '2026-01-15T00:00:00Z', '--to', '2026-01-16T00:00:00Z', '--store', 'sdc', '--json']).sdc;
  assert.equal(sd.devices[0].verdict, 'confirmed'); assert.ok(sd.jobs[0].lastCleanCheckpoint);
  // tune: two changes applied mid-way, measured
  json(d, [cli, 'demo', '--training', '--days', '14', '--tuned-at', '7', '--store', 'tuned', '--json']);
  const v = json(d, [cli, 'tune', 'verify', '--store', 'tuned', '--json']).verified;
  assert.deepEqual(v.map(x => x.verdict), ['improved', 'improved']);
  run(d, 'bash', ['-n', 'scripts/fleetops/tools/collect.sh']);
  // admission and rollouts: the bad-driver demo halts on the comparison; the node script parses
  run(d, 'node', [cli, 'rollout', 'demo', '--store', 'ro']);
  const cmp = json(d, [cli, 'rollout', 'check', '--field', 'driver', '--version', '560.35.03', '--from', '1794700800', '--to', '1794787200', '--store', 'ro', '--json'], { code: 4 }).comparison;
  assert.equal(cmp.ok, false);
  run(d, 'bash', ['-n', 'scripts/fleetops/tools/admit-node.sh']);
  // serving: fit, capacity, a deploy dry run, and the installer's dry run renders manifests
  const fit = json(d, [cli, 'serving', 'fit', '--gpu', 'H100', '--nodes', '2', '--rate', '5', '--store', 'sv', '--json']).fit;
  assert.ok(fit.rows[0].meetsRate);
  assert.ok(json(d, [cli, 'serving', 'capacity', '--model', 'llama33-70b', '--gpu', 'H100', '--nodes', '2', '--store', 'sv', '--json']).capacity.production.rate > 10);
  assert.match(run(d, 'bash', ['scripts/fleetops/install/install-serving.sh', '--model', 'qwen3-32b', '--gpu', 'H200', '--rate', '20', '--store', 'sv', '--dry-run']), /kind: Deployment/);
  assert.ok(st.waiting.some(a => a.kind === 'swap-at-checkpoint'));
});
