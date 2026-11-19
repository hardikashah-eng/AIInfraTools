import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), TP = require('../src/templates.js');
const m70 = Object.assign({ wPrec: 'fp8', kvPrec: 'fp8' }, E.MODELS['llama-70b']);

test('pool tp: 0 keeps the automatic choice, a set value overrides it', () => {
  assert.equal(E.profile('B200', m70).tp, 1);
  assert.equal(E.profile('B200', m70, 0).tp, 1);
  const p4 = E.profile('B200', m70, 4);
  assert.equal(p4.tp, 4);
  assert.ok(p4.kvCap > E.profile('B200', m70).kvCap * 4, 'four GPUs hold more than four times the KV of one (weights are shared)');
  assert.ok(p4.prefill > E.profile('B200', m70).prefill * 3.9);
});

test('pool tp flows through compile and simulate', () => {
  const g = TP.TEMPLATES[0].build();
  const pool = g.nodes.find(n => n.type === 'pool');
  Object.assign(pool.cfg, { gpu: 'B200', tp: 4, instances: 2, autoscale: false });
  const c = E.compileGraph(g, (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7));
  assert.equal(c.errors.length, 0);
  assert.equal(c.spec.pools.find(p => p.id === pool.id).tp, 4);
  const R = E.simulate(c.spec);
  assert.ok(R.summary.requests > 0);
});

test('B300 and GB200 are in the GPU table', () => {
  for (const k of ['B300', 'GB200']) {
    assert.ok(E.GPUS[k], k);
    assert.ok(E.profile(k, m70).kvCap > 0);
  }
});
