import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../src/training.js');

test('wall time is fully accounted for by phases', () => {
  for (const o of [{}, { spares: 0 }, { seed: 8 }, { queueWaitS: 3600 }]) {
    const r = T.simulateTraining(o);
    const sum = Object.values(r.shares).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.03, JSON.stringify(o) + ' sums to ' + sum);
  }
});

test('step model: compute shrinks with more GPUs; memory sets a minimum', () => {
  const a = T.stepModel({ gpus: 160 }), b = T.stepModel({ gpus: 320 });
  assert.ok(Math.abs(a.compute / b.compute - 2) < 0.01);
  assert.equal(a.minGpus, Math.ceil(16 * 70.6e9 / (0.75 * 80e9)));
  assert.ok(T.stepModel({ model: 'llama-405b' }).minGpus > 100);
});

test('switching to a heavy data mix exposes data loading; more workers hide it', () => {
  const r = T.simulateTraining({ stragglerShare: 0, faultPerGpuDay: 0 });
  assert.equal(r.byMix[0].dataS, 0);
  assert.ok(r.byMix[1].dataS > 2 && r.byMix[1].stepS > r.byMix[0].stepS);
  assert.equal(r.models[1].dataBound, 'cpu');
  const more = T.simulateTraining({ stragglerShare: 0, faultPerGpuDay: 0, workersPerGpu: 16 });
  assert.ok(more.byMix[1].dataS < 0.01);
  assert.equal(r.summary.bottleneck.phase, 'data');
});

test('one slow GPU holds every step', () => {
  const none = T.simulateTraining({ stragglerShare: 0, faultPerGpuDay: 0 }), some = T.simulateTraining({ stragglerShare: 0.02, stragglerSlow: 0.2, faultPerGpuDay: 0 });
  assert.ok(some.summary.stragglers >= 1);
  assert.ok(some.shares.straggler > 5 * none.shares.straggler);
  assert.equal(some.summary.bottleneck.phase, 'straggler');
  assert.ok(some.slowRank[0].slow > 1.1);
});

test('faults: no hot spare means waiting for repair; frequent checkpoints lose less', () => {
  const base = { stragglerShare: 0, faultPerGpuDay: 0.2, seed: 2 };
  const spare = T.simulateTraining(Object.assign({ spares: 4 }, base)), none = T.simulateTraining(Object.assign({ spares: 0 }, base));
  assert.ok(none.summary.faults > 0);
  assert.ok(none.shares.restart > spare.shares.restart);
  assert.ok(none.segs.some(s => s.waitedRepair));
  const rare = T.simulateTraining(Object.assign({ spares: 4, ckptMin: 120 }, base)), often = T.simulateTraining(Object.assign({ spares: 4, ckptMin: 10, asyncCkpt: true }, base));
  assert.ok(rare.shares.lost > often.shares.lost);
});

test('state at a moment: slow GPUs compute while the rest wait', () => {
  const r = T.simulateTraining({ stragglerShare: 0.02, stragglerSlow: 0.2, faultPerGpuDay: 0 });
  const st = r.steps[10], t = st.t + st.data + st.compute * 1.05, S = T.stateAt(r, t);
  assert.equal(S.phase, 'compute');
  const computing = [...S.st].filter(x => x === 0).length, waiting = [...S.st].filter(x => x === 1).length;
  assert.ok(computing >= 1 && computing < 10 && waiting > 100);
  assert.equal(T.stateAt(r, r.segs.find(x => x.kind === 'checkpoint').t0 + 0.1).phase, 'checkpoint');
});

test('parses GPU fault logs: CSV, JSON lines and syslog Xid lines', () => {
  const csv = T.parseFaultLog('timestamp,hostname,gpu,xid\n2026-11-01T00:00:00Z,n1,3,79\n2026-11-02T00:00:00Z,n1,3,79\n2026-11-03T00:00:00Z,n2,0,48');
  assert.equal(csv.events.length, 3);
  assert.deepEqual(csv.byGpu[0], { key: 'n1/3', n: 2 });
  assert.equal(csv.xids[79], 2);
  const jl = T.parseFaultLog('{"node":"a","gpu_index":1,"xid":94}\n{"host":"b","gpu":2}');
  assert.equal(jl.events.length, 2);
  const sys = T.parseFaultLog('Nov 17 02:11:05 gpu-node-07 kernel: NVRM: Xid (PCI:0000:3b:00): 79, pid=1234, GPU has fallen off the bus.');
  assert.equal(sys.events.length, 1); assert.equal(sys.events[0].node, 'gpu-node-07'); assert.equal(sys.events[0].xid, 79);
});
