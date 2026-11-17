import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const O = require('../src/optimize.js'), TP = require('../src/templates.js');
const burst = () => TP.TEMPLATES.find(t => t.id === 'burst').build();

test('the optimiser grows the pool that breaks until the target is met', () => {
  const r = O.optimize(burst(), { target: 0.95, maxEvals: 40 });
  assert.equal(r.status, 'ok');
  assert.ok(!r.before.ok && r.after.ok && r.after.slo >= 0.95);
  assert.ok(r.changes.some(c => c.startsWith('On-prem H100: instances 4 →')));
});

test('allowing GPU swaps finds a cheaper setup than adding H100s', () => {
  const plain = O.optimize(burst(), { target: 0.95, maxEvals: 40 });
  const swap = O.optimize(burst(), { target: 0.95, maxEvals: 70, gpuChoices: ['H100', 'H200', 'B200'] });
  assert.ok(swap.after.ok && swap.after.cost < plain.after.cost);
});

test('an over-provisioned graph is trimmed and gets cheaper', () => {
  const g = burst(); g.nodes.find(n => n.id === 'on').cfg.instances = 16;
  const r = O.optimize(g, { target: 0.95, maxEvals: 40 });
  assert.ok(r.before.ok && r.after.ok && r.after.cost < r.before.cost);
});

test('buy vs rent: fast growth favours buying the base; no growth and pricey hardware favour renting', () => {
  const grow = O.capacityPlan({ gpusNow: 64, growthPct: 5 });
  assert.equal(grow.best, 'hybrid'); assert.ok(grow.ownedEnd > 0);
  assert.ok(O.capacityPlan({ gpusNow: 16, growthPct: 4 }).breakEven != null, 'cash pays back within two years at the defaults');
  assert.ok(grow.months.every(m => m.owned <= m.base * 1.5 + 1));
  const flat = O.capacityPlan({ gpusNow: 8, growthPct: 0, gpuCapex: 90000, months: 12, reservedPerGpuH: 1.2 });
  assert.notEqual(flat.best, 'hybrid');
});

test('MIG packs small models onto fewer GPUs and flags what does not fit', () => {
  const r = O.migPlan([{ name: 'embed', memoryGB: 4, replicas: 6 }, { name: 'rerank', memoryGB: 9, replicas: 4 }, { name: 'big', memoryGB: 70, replicas: 1 }], 'H100');
  assert.ok(r.used < r.whole);
  for (const g of r.gpus) { assert.ok(g.slices <= 7); assert.ok(g.mem <= 80); }
  assert.deepEqual(r.unfit, ['big']);
});
