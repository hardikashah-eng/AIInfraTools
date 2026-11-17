import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/cluster.js');

const pack = () => { const s = C.sampleCluster(); s.policy.placement = 'binpack'; return s; };

test('ready replicas lag running ones by the start-up time; slower start-up means more shortfall', () => {
  const r = C.simulateCluster(pack());
  const fast = C.inferenceReadiness(r, 0, 30), slow = C.inferenceReadiness(r, 0, 900);
  for (let k = 0; k < r.T; k++) { assert.ok(slow.ready[k] <= slow.running[k]); assert.ok(slow.ready[k] <= fast.ready[k]); }
  assert.ok(slow.deficitReplicaH > fast.deficitReplicaH);
  assert.equal(slow.ready[0], slow.running[0], 'replicas running at the start are already warm');
  assert.ok(Math.max(...r.wlTarget[0]) > Math.min(...r.wlTarget[0].filter(Boolean)), 'the replica target follows a daily cycle');
});

test('when pre-training outranks serving, the gang evicts serving replicas', () => {
  const s = C.sampleCluster();
  s.queues.find(q => q.id === 'serving').priority = 5;
  const r = C.simulateCluster(s), base = C.simulateCluster(C.sampleCluster());
  assert.ok(r.workloads[0].preempts > 10);
  assert.equal(base.workloads[0].preempts, 0);
  assert.ok(C.inferenceReadiness(r, 0, 240).worstShare > C.inferenceReadiness(base, 0, 240).worstShare + 0.3);
});

test('GPUs by workload kind add up to allocated GPUs', () => {
  const r = C.simulateCluster(C.sampleCluster());
  for (let k = 0; k < r.T; k += 97) assert.equal(r.gpusByKind.inference[k] + r.gpusByKind.training[k] + r.gpusByKind.batch[k], r.series.alloc[k]);
});
