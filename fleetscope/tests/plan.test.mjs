import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/plan.js');
const dir = new URL('../scenarios/hybrid-chat/', import.meta.url);
const read = f => readFileSync(new URL(f, dir), 'utf8');
const scenario = () => ({ graph: JSON.parse(read('graph.json')), cluster: JSON.parse(read('cluster.json')), kueue: read('kueue.yaml') });

test('reads Kueue ClusterQueue YAML', () => {
  assert.deepEqual(P.kueueQuotas(read('kueue.yaml')), { serving: 160, research: 288, eval: 64 });
  const y = P.parseYaml('a: 1\nb:\n  - name: x\n    v: [1, 2]\n  - name: y\nc: "q"');
  assert.deepEqual(y[0], { a: 1, b: [{ name: 'x', v: [1, 2] }, { name: 'y' }], c: 'q' });
});

test('an unchanged scenario has no changes and passes', () => {
  const r = P.compare(scenario(), scenario());
  assert.equal(r.verdict, 'nochange');
  assert.equal(r.fails.length, 0);
});

test('fewer on-prem instances fail the plan, with the change and its owner named', () => {
  const head = scenario(); head.graph.nodes.find(n => n.id === 'on').cfg.instances = 3;
  const r = P.compare(scenario(), head);
  assert.equal(r.verdict, 'fail');
  assert.ok(r.changes.some(c => c.text === 'On-prem H100: instances 4 → 3'));
  assert.deepEqual(r.owners.map(o => o.team), ['ML Platform']);
  const md = P.markdown(r, { scenario: 'hybrid-chat' });
  assert.match(md, /❌ FleetScope plan/); assert.match(md, /On-prem H100: instances 4 → 3/); assert.match(md, /ML Platform \(@mlplatform-oncall\)/);
});

test('bin-pack placement and a quota change are planned as cluster improvements', () => {
  const head = scenario(); head.cluster.policy.placement = 'binpack'; head.kueue = head.kueue.replace('nominalQuota: 64', 'nominalQuota: 48');
  const r = P.compare(scenario(), head);
  assert.equal(r.verdict, 'pass');
  assert.ok(r.changes.some(c => c.where === 'kueue' && c.text === 'eval: nominal GPU quota 64 → 48'));
  const alloc = r.checks.find(c => c.name === 'GPU allocation');
  assert.ok(alloc.head > alloc.base + 0.1);
});

test('the CLI exits 1 on a failing plan and writes the markdown', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fs-plan-'));
  cpSync(dir, tmp, { recursive: true });
  const g = JSON.parse(read('graph.json')); g.nodes.find(n => n.id === 'on').cfg.instances = 3;
  writeFileSync(join(tmp, 'graph.json'), JSON.stringify(g));
  let code = 0;
  try { execFileSync('node', ['tools/fleetscope-plan.mjs', '--base', 'scenarios/hybrid-chat', '--head', tmp, '--out', join(tmp, 'plan.md')], { cwd: new URL('..', import.meta.url), stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.match(readFileSync(join(tmp, 'plan.md'), 'utf8'), /instances 4 → 3/);
});
