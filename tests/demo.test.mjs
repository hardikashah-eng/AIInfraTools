// `aiinfra demo` on the real Philly week it ships with: no mocks, real data, the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aiinfra.mjs'), 'demo', ...a], { encoding: 'utf8', timeout: 300000 });

test('steps 1–4 on the real week: incidents pinned on one namespace, flaky nodes, a plan that waits for a person', { timeout: 300000 }, () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), 'd');
  const r = demo('--out', dir, '--json'); assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.observe.gpuHours > 300000 && o.observe.gpuHours < 330000, `${o.observe.gpuHours} GPU-hours`);
  assert.ok(o.diagnose.length >= 6, `${o.diagnose.length} incidents`);
  assert.ok(o.diagnose.filter(i => /namespace \(6214e9\)/.test(i.cause)).length >= 5, 'most spikes are one namespace');
  assert.ok(o.simulate.some(s => s.id === 'flaky-nodes' && s.gpuHoursPerWeek > 1000));
  assert.ok(o.plan.weekly > 0 && o.plan.stages.length >= 1);
  assert.match(o.approve.command, /^aiinfra gpu-health actions approve 'rollout-stage:opt-[\w-]+#1' --by "Your Name" --state /);
  assert.ok(o.commands.length >= 5 && o.commands.every(c => c.command.startsWith('fleetops ')), 'every step shows its command');
  // the human-readable run says the same and stops at approval
  const t = demo('--out', dir + '2'); assert.equal(t.status, 0);
  assert.match(t.stdout, /1\. Observe[\s\S]*2\. Diagnose[\s\S]*3\. Simulate[\s\S]*4\. Approve[\s\S]*approve it yourself/);
  assert.doesNotMatch(t.stdout, /5\. Optimize/);
});

test('continuing without approval changes nothing and says who has to act', { timeout: 300000 }, () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), 'd');
  assert.equal(demo('--out', dir).status, 0);
  const plan = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  const c = demo('--continue', dir); assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /still waiting for approval[\s\S]*only a person can/);
  assert.ok(!fs.existsSync(path.join(dir, 'report.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')).stages[0].status, JSON.parse(plan).stages[0].status);
});
