import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Cross-tool check: graphs exported by Inference Sizer must compile and run in FleetScope (../fleetscope).
const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js'), X = require('../src/fleetscope.js');
const E = require('../../fleetscope/src/engine.js');
const input = (model, gpu, over) => {
  const m = C.MODELS.find(x => x.id === model), g = C.GPUS.find(x => x.id === gpu);
  return Object.assign({}, M.SETTINGS, m, g, { model, gpu, modelLabel: m.name, gpuLabel: g.label }, over || {});
};
const exportRun = (model, gpu, over) => {
  const r = M.plan(input(model, gpu, over), { noSens: true });
  const x = X.toGraph(r);
  assert.ok(x.ok, (x.errors || []).join('; '));
  const c = E.compileGraph(x.graph, () => []);
  assert.deepEqual(c.errors, []);
  return { r, x, c, R: E.simulate(c.spec) };
};

test('every GPU the sizer maps to FleetScope exists in FleetScope', () => {
  for (const [id, key] of Object.entries(X.FS_GPUS)) {
    assert.ok(C.GPUS.find(g => g.id === id), id);
    assert.ok(E.GPUS[key], key);
  }
  for (const key of Object.values(X.FS_MODELS)) assert.ok(E.MODELS[key], key);
});

test('the example plan exports with GPUs per instance set, and FleetScope meets the SLO when replaying it', () => {
  const { r, c, R } = exportRun('llama33-70b', 'B200');
  const pool = c.spec.pools[0];
  assert.equal(pool.tp, r.agg.best.c.g);
  assert.equal(pool.max, r.agg.best.N);
  assert.ok(R.summary.slo >= 0.95, 'SLO met in FleetScope: ' + R.summary.slo);
});

test('disaggregated plans export as a prefill pool wired to a decode pool', () => {
  const { c } = exportRun('llama33-70b', 'B200', { mode: 'disagg' });
  const roles = c.spec.pools.map(p => p.role).sort();
  assert.deepEqual(roles, ['decode', 'prefill']);
  assert.equal(c.spec.pools.find(p => p.role === 'prefill').decode.length, 1);
});

test('MLA and MoE models export with their architecture', () => {
  const { x, R } = exportRun('deepseek-v3', 'B200', { ctx: 65536 });
  const m = x.graph.nodes.find(n => n.type === 'model').cfg;
  assert.equal(m.key, 'moe-671b');
  assert.equal(m.mla, 576);
  assert.ok(R.summary.requests > 0);
});

test('a custom GPU FleetScope does not know is refused with a clear message', () => {
  const s = Object.assign(input('llama33-70b', 'B200'), { gpu: 'my-gpu', gpuLabel: 'My GPU' });
  const x = X.toGraph(M.plan(s, { noSens: true }));
  assert.equal(x.ok, false);
  assert.match(x.errors[0], /FleetScope has no profile for "My GPU"/);
});
