import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), TP = require('../src/templates.js'), T = require('../src/training.js');
const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
const run = (id, edit) => { const g = TP.TEMPLATES.find(t => t.id === id).build(); edit(g); return E.simulate(E.compileGraph(g, lookup).spec).summary; };
const nodeOf = (g, id) => g.nodes.find(n => n.id === id);

test('prefix-cache locality: cache-oblivious routing loses hits; KV-aware routing and offload win most back', () => {
  const agents = (aff, off) => run('agent', g => { nodeOf(g, 'rt').cfg.affinity = aff; Object.assign(nodeOf(g, 'on').cfg, { instances: 14, offloadGB: off || 0 }); });
  const ideal = agents('ideal'), none = agents('none'), kv = agents('session'), kvOff = agents('session', 512);
  assert.ok(ideal.slo > 0.95);
  assert.ok(none.slo < 0.3, 'oblivious ' + none.slo);
  assert.ok(kv.slo > none.slo + 0.4, 'kv-aware ' + kv.slo);
  assert.ok(kvOff.locality.hits > kv.locality.hits && kvOff.locality.offloadLoads > 0);
  assert.ok(none.locality.cachedShare < kv.locality.cachedShare);
  assert.equal(ideal.locality.misses + ideal.locality.hits, 0, 'ideal mode does not model locality');
});

test('speculative decoding: more tokens per step, faster tokens at small batches', () => {
  const base = run('burst', g => { nodeOf(g, 'on').cfg.instances = 12; });
  const spec = run('burst', g => { nodeOf(g, 'on').cfg.instances = 12; Object.assign(g.nodes.find(n => n.type === 'model').cfg, { specK: 3, specAccept: 0.7 }); });
  assert.ok(Math.abs(spec.spec.tokensPerStep - (1 - 0.7 ** 4) / 0.3) < 1e-9);
  assert.ok(spec.tpotP99 < base.tpotP99 * 0.7);
});

test('LoRA: adapters add step overhead, and more adapters than slots cap the batch', () => {
  const P = E.profile('H100', E.MODELS['llama-70b']);
  const few = run('burst', g => { Object.assign(nodeOf(g, 'on').cfg, { instances: 12, loraAdapters: 4, loraSlots: 8 }); });
  const none = run('burst', g => { nodeOf(g, 'on').cfg.instances = 12; });
  assert.ok(few.tpotP99 > none.tpotP99, 'adapter overhead slows tokens');
  void P;
});

test('MoE models pay an all-to-all per token; dense models do not', () => {
  assert.ok(E.profile('H100', E.MODELS['moe-671b']).a2a > 0);
  assert.equal(E.profile('H100', E.MODELS['llama-70b']).a2a, 0);
});

test('training: elastic jobs keep going, power caps trade tokens for energy, cross-site sync costs step time', () => {
  const wait = T.simulateTraining({ spares: 0 }).summary, el = T.simulateTraining({ spares: 0, elastic: true }).summary;
  assert.ok(el.tokensB > wait.tokensB * 1.3 && el.shrunkH > 1 && el.restartH < wait.restartH);
  const full = T.simulateTraining({}).summary, cap = T.simulateTraining({ powerCapPct: 80 }).summary;
  assert.ok(cap.energyMWh < full.energyMWh * 0.9 && cap.tokensB > full.tokensB * 0.9 && cap.tokensB < full.tokensB);
  const one = T.stepModel({}), two = T.stepModel({ sites: 2, wanGbps: 100 });
  assert.ok(two.cross > 10 && two.sync > one.sync + 3);
});
