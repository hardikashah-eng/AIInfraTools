import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/cluster.js');

const small = extra => Object.assign({
  seed: 3, horizonH: 2, policy: { placement: 'binpack' },
  pools: [{ id: 'a', name: 'a', gpu: 'H100', gpusPerNode: 8, nodes: 4, domainNodes: 4, faultPerGpuDay: 0 }],
  queues: [{ id: 'q', name: 'q', quota: 32, priority: 0 }],
  workloads: []
}, extra);

test('GPUs are conserved: allocated + free + faulted = total, every tick', () => {
  const r = C.simulateCluster(C.sampleCluster());
  for (let k = 0; k < r.T; k++) assert.equal(r.series.alloc[k] + r.series.free[k] + r.series.faulted[k], r.G);
  const r2 = C.simulateCluster(C.sampleCluster());
  assert.deepEqual(r2.summary, r.summary, 'deterministic');
});

test('spread placement strands GPUs and blocks the pre-training gang; bin-pack admits it', () => {
  const spread = C.simulateCluster(C.sampleCluster(), { policy: { placement: 'spread' } });
  const pack = C.simulateCluster(C.sampleCluster(), { policy: { placement: 'binpack' } });
  const ps = spread.workloads.find(w => w.id === 'pretrain'), pp = pack.workloads.find(w => w.id === 'pretrain');
  assert.ok(!ps.admittedOk);
  assert.equal(ps.topReason, 'fragmentation');
  assert.ok(pp.admittedOk && pp.waitMin < 5);
  assert.ok(spread.summary.strandedGpuH > 10 * pack.summary.strandedGpuH);
});

test('a queue over quota waits unless it may borrow', () => {
  const spec = small({ queues: [{ id: 'q', name: 'q', quota: 8 }, { id: 'idle', name: 'idle', quota: 24 }],
    workloads: [{ id: 'j', name: 'j', kind: 'training', queue: 'q', gpusPerPod: 8, pods: 2, durationH: 1 }] });
  const no = C.simulateCluster(spec, { policy: { borrowing: false } });
  assert.equal(no.workloads[0].topReason, 'quota');
  assert.ok(!no.workloads[0].admittedOk);
  const yes = C.simulateCluster(spec, { policy: { borrowing: true } });
  assert.ok(yes.workloads[0].admittedOk);
});

test('a high-priority gang preempts low-priority batch pods', () => {
  const spec = small({ workloads: [
    { id: 'b', name: 'batch', kind: 'batch', queue: 'q', gpusPerPod: 1, ratePerH: 400, durationH: 2, priority: -10 },
    { id: 't', name: 'train', kind: 'training', queue: 'q', gpusPerPod: 8, pods: 4, startH: 0.5, durationH: 1, priority: 100 }] });
  const on = C.simulateCluster(spec, { policy: { preemption: true } });
  assert.ok(on.workloads[1].admittedOk);
  assert.ok(on.workloads[0].preempts > 0);
  const off = C.simulateCluster(spec, { policy: { preemption: false } });
  assert.ok(off.workloads[1].waitMin > on.workloads[1].waitMin);
});

test('without gang scheduling, partially placed jobs hold idle GPUs', () => {
  const spec = small({ workloads: [
    { id: 't1', name: 't1', kind: 'training', queue: 'q', gpusPerPod: 8, pods: 3, durationH: 1 },
    { id: 't2', name: 't2', kind: 'training', queue: 'q', gpusPerPod: 8, pods: 3, durationH: 1 }] });
  const gang = C.simulateCluster(spec, { policy: { gang: true } }), loose = C.simulateCluster(spec, { policy: { gang: false } });
  assert.ok(loose.summary.idleAllocGpuH > gang.summary.idleAllocGpuH + 1);
});

test('GPU faults restart training from the last checkpoint', () => {
  const mk = ck => small({ horizonH: 6, pools: [{ id: 'a', name: 'a', gpu: 'H100', gpusPerNode: 8, nodes: 6, domainNodes: 6, faultPerGpuDay: 0.5, repairH: 1 }],
    queues: [{ id: 'q', name: 'q', quota: 48 }],
    workloads: [{ id: 't', name: 't', kind: 'training', queue: 'q', gpusPerPod: 8, pods: 4, durationH: 20, ckptMin: ck, restartMin: 5 }] });
  const rare = C.simulateCluster(mk(120)), often = C.simulateCluster(mk(10));
  assert.ok(rare.summary.faults > 0 && rare.workloads[0].restarts > 0);
  assert.ok(rare.workloads[0].lostGpuH > often.workloads[0].lostGpuH, 'frequent checkpoints lose less work');
  assert.ok(rare.nodeFaults.length > 0 && rare.gpuFaults[0].faults >= 1);
});

test('policy comparison runs every variant', () => {
  const rows = C.comparePolicies(C.sampleCluster());
  assert.equal(rows.length, C.POLICY_VARIANTS.length);
  const pack = rows.find(r => r.name === 'Bin-pack'), spread = rows.find(r => r.name === 'Spread');
  assert.ok(pack.summary.allocation > spread.summary.allocation);
});

test('imports a kubectl List with nodes, GPU pods and Kueue queues', () => {
  const { spec, notes } = C.fromKube(readFileSync(new URL('./fixtures/kube-list.json', import.meta.url), 'utf8'));
  assert.equal(spec.pools.length, 2);
  const h100 = spec.pools.find(p => p.gpu === 'H100');
  assert.equal(h100.nodes, 4); assert.equal(h100.gpusPerNode, 8); assert.equal(h100.domainNodes, 2);
  assert.deepEqual(spec.queues.map(q => [q.id, q.quota]), [['serving', 16], ['research', 32], ['eval', 8]]);
  const chat = spec.workloads.find(w => w.name === 'vllm-chat');
  assert.equal(chat.kind, 'inference'); assert.equal(chat.pods, 3); assert.equal(chat.gpusPerPod, 2); assert.equal(chat.queue, 'serving'); assert.equal(chat.priority, 100);
  const pre = spec.workloads.find(w => w.name === 'pretrain-8b');
  assert.equal(pre.kind, 'training'); assert.equal(pre.pods, 2); assert.equal(pre.topology, 'domain'); assert.equal(pre.queue, 'research');
  assert.equal(spec.workloads.filter(w => w.kind === 'batch').length, 5);
  assert.ok(notes.length >= 3);
  const r = C.simulateCluster(spec);
  assert.ok(r.summary.allocation > 0);
});
