import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DataStore } from '../src/store.mjs';
import * as O from '../src/optimize.mjs';
import { Store } from '../../gpu-health/src/actions.mjs';
import { demoSamples, demoJobs, DEMO_NOW } from '../../gpu-health/src/synth.mjs';

const require = createRequire(import.meta.url);
const TP = require('../../fleetscope/src/templates.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-opt-'));

// gpu-health's demo fleet, loaded through the data layer.
function demoStore() {
  const s = new DataStore(tmp());
  s.append('device', demoSamples({ now: DEMO_NOW }).map(x => Object.assign({ source: 'demo' }, x)));
  s.append('placement', demoJobs(DEMO_NOW).map(j => ({ t: j.start, job: j.id, class: j.class, owner: j.owner, namespace: j.namespace, gpusPerReplica: j.gpusPerReplica, start: j.start, devices: j.gpus })));
  return s;
}

test('optimize: gpu-health candidates from the store, protected classes kept out, goal-driven selection', () => {
  const s = demoStore();
  const c = O.fromGpuHealth(s, {});
  const embed = c.find(x => x.change.job === 'embed-svc');
  assert.ok(embed && embed.savingsWeekly > 0 && embed.risk === 'medium' && embed.slo.impact === 'check');
  const sel = O.select(c, { savePct: 1, baselineWeekly: 1e6 });
  assert.ok(sel.chosen.length >= 1 && sel.chosen.every(x => !x.protected));
  assert.ok(sel.chosen[0].savingsWeekly * (sel.chosen[0].risk === 'low' ? 1 : 0.8) >= Math.max(...sel.chosen.map(x => x.savingsWeekly * (x.risk === 'low' ? 1 : 0.8))) - 1e-9, 'best savings per risk first');
  const prot = O.select(c.map(x => Object.assign({}, x, { protected: true, class: 'training' })), {});
  assert.equal(prot.chosen.length, 0); assert.match(prot.skipped[0].why, /protected class/);
  const low = O.select(c, { maxRisk: 'low' });
  assert.ok(low.chosen.every(x => x.risk === 'low'));
});

test('optimize: retry-storm candidate from a stored incident', () => {
  const s = new DataStore(tmp()), t0 = 1_800_000_000;
  s.append('placement', Array.from({ length: 30 }, (_, i) => ({ t: t0, job: `j${i}`, namespace: 'ns-bad', owner: 'u1', start: t0, devices: [{ node: 'n1', gpu: '0' }, { node: 'n1', gpu: '1' }] })));
  // 10 jobs × 3 attempts, 1 hour on 2 GPUs each, within one day: a cap at 2 attempts avoids the 10 third attempts (20 GPU-hours)
  s.append('job', Array.from({ length: 30 }, (_, i) => ({ t: t0 + 3600 + i, job: `j${i % 10}#${Math.floor(i / 10)}`, status: i >= 20 ? 'failed' : 'retried', cause: 'unknown', start: t0 + i, end: t0 + 3600 + i, gpus: 2 })));
  s.append('incident', [{ t: t0 + 7200, id: 'job-failures@x', hypotheses: [{ rule: 'workload', title: 'One namespace (ns-bad) owns 95% of the failures', score: 0.9 }] }]);
  const c = O.fromRetryStorms(s, { price: 2 });
  assert.equal(c.length, 1); assert.equal(c[0].resource, 'namespace:ns-bad');
  assert.ok(Math.abs(c[0].gpuHoursWeekly - 20 * 7) < 1, `20 avoidable GPU-hours in one day → 140 per week (${c[0].gpuHoursWeekly})`);
  assert.match(c[0].detail, /30 failed or retried attempts \(10 jobs\).*avoids 10 attempts/);
  assert.ok(Math.abs(c[0].savingsWeekly - c[0].gpuHoursWeekly * 2) < 1e-6);
});

test('optimize: FleetScope candidate is the cheapest graph that still meets the target', () => {
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  Object.assign(g.nodes.find(n => n.id === 'on').cfg, { instances: 12 }); // oversized on purpose
  const c = O.fromFleetScope(g, { target: 0.95, maxEvals: 25 });
  assert.equal(c.length, 1);
  assert.ok(c[0].savingsWeekly > 0 && c[0].slo.after >= 0.95, JSON.stringify(c[0].slo));
  assert.ok(c[0].change.pools.length >= 1);
});

function rolloutFixture() {
  const s = new DataStore(tmp()), state = tmp(), t0 = 1_800_000_000;
  const cand = [{ id: 'gpu-health:scale-in:embed', source: 'gpu-health', kind: 'scale-in', resource: 'job:embed', title: 'scale-in embed', savingsWeekly: 900, risk: 'medium', protected: false, slo: { impact: 'check' },
    change: { action: 'scale-in', job: 'embed', namespace: 'serving', replicasNow: 4, replicasTarget: 1 } }];
  const plan = O.planRollout(O.select(cand, {}), { id: 'p1', guards: { 'job:embed': { pool: 'embed', metric: 'ttftP99', maxRegression: 0.2 } }, bakeS: 600 });
  s.append('serving', Array.from({ length: 12 }, (_, i) => ({ t: t0 - 3600 + i * 300, pool: 'embed', ttftP99: 0.5, windowS: 300 })));
  return { s, state, t0, plan };
}

test('optimize: staged rollout needs approval for each stage, applies through the queue, and verifies the guard', async () => {
  const { s, state, t0, plan } = rolloutFixture();
  assert.deepEqual(plan.stages.map(x => x.title), ['embed: 4 → 3 replicas', 'embed: 3 → 1 replicas']);
  assert.deepEqual(plan.stages[0].apply, [['kubectl', '-n', 'serving', 'scale', 'deployment', 'embed', '--replicas=3']]);
  assert.deepEqual(plan.stages[0].rollback, [['kubectl', '-n', 'serving', 'scale', 'deployment', 'embed', '--replicas=4']]);
  const ids = O.enqueue(plan, state, t0);
  let r = await O.advance(plan, { store: s, stateDir: state, now: t0 });
  assert.equal(plan.status, 'waiting-approval'); assert.match(r.log.at(-1), /waits for approval/);
  new Store(state).approve(ids[0], 'alice', t0);
  r = await O.advance(plan, { store: s, stateDir: state, now: t0 + 10 });
  assert.equal(plan.stages[0].status, 'applied'); assert.equal(plan.stages[0].applyResult.dryRun, true, 'dry-run without both locks');
  assert.match((await O.advance(plan, { store: s, stateDir: state, now: t0 + 100 })).log[0], /baking/);
  s.append('serving', [{ t: t0 + 400, pool: 'embed', ttftP99: 0.52, windowS: 300 }]);
  r = await O.advance(plan, { store: s, stateDir: state, now: t0 + 700 });
  assert.equal(plan.stages[0].status, 'verified'); assert.match(r.log.at(-1), /stage 2 waits for approval/, 'the next stage is never applied without its own approval');
  const audit = fs.readFileSync(path.join(state, 'audit.jsonl'), 'utf8');
  assert.match(audit, /"event":"approved"/); assert.match(audit, /"event":"dry-run"/);
});

test('optimize: an SLO regression after a stage rolls back to the last verified state without waiting for approval', async () => {
  const { s, state, t0, plan } = rolloutFixture();
  const ids = O.enqueue(plan, state, t0);
  const st = new Store(state); st.approve(ids[0], 'alice', t0); st.approve(ids[1], 'alice', t0);
  await O.advance(plan, { store: s, stateDir: state, now: t0 + 10 });
  s.append('serving', [{ t: t0 + 400, pool: 'embed', ttftP99: 0.51, windowS: 300 }]);
  await O.advance(plan, { store: s, stateDir: state, now: t0 + 700 });       // stage 1 verified, stage 2 applied
  assert.equal(plan.stages[1].status, 'applied');
  s.append('serving', [{ t: t0 + 900, pool: 'embed', ttftP99: 1.4, windowS: 300 }]);
  const r = await O.advance(plan, { store: s, stateDir: state, now: t0 + 1400 });
  assert.equal(plan.status, 'rolled-back'); assert.match(r.log[0], /guard failed after stage 2/);
  assert.equal(plan.stages[1].status, 'rolled-back'); assert.deepEqual(plan.stages[1].rollbackResult.commands, [['kubectl', '-n', 'serving', 'scale', 'deployment', 'embed', '--replicas=3']], 'back to the last verified state (3 replicas)');
  assert.equal(plan.stages[0].status, 'verified', 'stage 1 had passed its own guard, so only stage 2 is undone');
  assert.match(fs.readFileSync(path.join(state, 'audit.jsonl'), 'utf8'), /"event":"rolled-back"/);
});

test('optimize: shrinking goes in steps, the first one small', () => {
  assert.deepEqual(O.shrinkSteps(4, 1), [3, 1]);
  assert.deepEqual(O.shrinkSteps(16, 6), [15, 10, 6]);
  assert.deepEqual(O.shrinkSteps(2, 1), [1]);
});

test('optimize: unsafe values never reach a stage command', () => {
  const c = [{ id: 'x', resource: 'job:x', title: 'x', savingsWeekly: 1, risk: 'low', protected: false, slo: {}, change: { action: 'scale-in', job: 'x; rm -rf /', namespace: 'serving', replicasNow: 2, replicasTarget: 1 } }];
  assert.throws(() => O.planRollout(O.select(c, {}), {}), /unsafe value for \{job\}/);
});
