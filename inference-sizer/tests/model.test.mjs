import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js');
const input = (model, gpu, over) => {
  const m = C.MODELS.find(x => x.id === model), g = C.GPUS.find(x => x.id === gpu);
  return Object.assign({}, M.SETTINGS, m, g, { model, gpu, modelLabel: m.name, gpuLabel: g.label }, over || {});
};
const plan = (model, gpu, over, opts) => M.plan(input(model, gpu, over), opts || { noSens: true });
const gpusOf = r => r.chosen ? r.chosen.provGPUs : Infinity;

test('example: Llama 3.3 70B FP8 on B200 at 500 sessions / 50K DAU is 4 × TP4 aggregated in 3 nodes', () => {
  const r = plan('llama33-70b', 'B200');
  assert.equal(r.chosen.mode, 'agg');
  assert.equal(r.agg.best.label, 'TP4');
  assert.equal(r.agg.best.N, 4);
  assert.equal(r.chosen.gpus, 16);
  assert.equal(r.chosen.totalNodes, 3);
  assert.ok(r.agg.best.ttftAvg <= 1 && r.agg.best.tpotOp <= 0.03);
});

test('GPU count never rises as the TPOT target is relaxed', () => {
  for (const [m, g, o] of [['llama33-70b', 'B200'], ['deepseek-v3', 'B200', { ctx: 65536 }], ['qwen3-235b', 'H200'], ['llama31-405b', 'B300'], ['llama33-70b', 'B200', { kvPolicy: 'reserve', ctx: 131072 }]]) {
    const sens = plan(m, g, o, {}).sens.map(x => x.gpus == null ? Infinity : x.gpus);
    for (let i = 1; i < sens.length; i++) assert.ok(sens[i] <= sens[i - 1], `${m} on ${g}: ${sens.join(',')}`);
  }
});

test('more traffic, tighter targets or bigger reservations never need fewer GPUs', () => {
  const base = gpusOf(plan('llama33-70b', 'B200'));
  assert.ok(gpusOf(plan('llama33-70b', 'B200', { dau: 500000, conc: 5000 })) > base);
  assert.ok(gpusOf(plan('llama33-70b', 'B200', { ttft: 400 })) >= base);
  assert.ok(gpusOf(plan('llama33-70b', 'B200', { kvPolicy: 'reserve', ctx: 131072 })) > base);
  assert.ok(gpusOf(plan('llama33-70b', 'B200', { ctx: 131072, kvPolicy: 'reserve' })) >= gpusOf(plan('llama33-70b', 'B200', { ctx: 32768, kvPolicy: 'reserve' })));
});

test('the context window is enforced: one full-length request must fit an instance', () => {
  // Llama 3.1 8B BF16 on one L40S leaves ~19 GB for KV: a 128K request (16.8 GB of BF16 KV) fits, 256K (33.6 GB) does not.
  const at = ctx => plan('llama31-8b', 'L40S', { wprec: 'bf16', kvprec: 'bf16', ctx }).dis.dec.find(x => x.c.g === 1);
  assert.notEqual(at(131072).why, 'one full-context sequence does not fit');
  assert.equal(at(262144).feasible, false);
  assert.equal(at(262144).why, 'one full-context sequence does not fit');
});

test('a GPU without FP4 tensor cores keeps the memory saving but computes at FP8', () => {
  const h = plan('llama33-70b', 'H100', { wprec: 'fp4' });
  assert.equal(h.md.computeFallback, 'fp8');
  assert.equal(h.md.Fw, 1979e12);
  assert.ok(h.md.Wd < plan('llama33-70b', 'H100', { wprec: 'fp8' }).md.Wd);
  assert.equal(plan('llama33-70b', 'B200', { wprec: 'fp4' }).md.computeFallback, null);
});

test('scale-up domain: NVL72 keeps wide EP inside one rack, HGX goes across nodes', () => {
  const nvl = plan('deepseek-v3', 'GB200-NVL72', { ctx: 65536 });
  assert.ok(nvl.cfgs.every(c => c.g <= 72));
  assert.ok(nvl.chosen.nodeGPUs === 72);
  const dp16 = M.decodeStep(nvl.s, nvl.md, nvl.cfgs.find(c => c.g === 16), 512);
  const hgx = plan('deepseek-v3', 'B200', { ctx: 65536 });
  const dp16h = M.decodeStep(hgx.s, hgx.md, hgx.cfgs.find(c => c.g === 16), 512);
  assert.ok(dp16.comm < dp16h.comm, 'NVLink all-to-all is cheaper than InfiniBand');
});

test('node packing fills nodes before opening new ones; N+1 uses free slots first', () => {
  assert.equal(M.packNodes([{ N: 3, g: 2 }, { N: 1, g: 2 }], 8), 1);
  assert.equal(M.packNodes([{ N: 3, g: 4 }], 8), 2);
  assert.equal(M.packNodes([{ N: 2, g: 16 }], 8), 4);
  assert.equal(M.packNodes([{ N: 3, g: 16 }], 72), 1);
  const r = plan('deepseek-v3', 'GB200-NVL72', { ctx: 65536 });
  assert.equal(r.chosen.spareNodes, 0, 'the spare instance fits in the same rack');
});

test('impossible targets return no plan and the floors explain why', () => {
  const r = plan('llama31-405b', 'B200', { tpot: 5 });
  assert.equal(r.chosen, null);
  assert.ok(r.tpotFloor > 0.005 * 0.9);
});

test('every built-in model on B200 and H200 either finds a plan or explains why not', () => {
  for (const m of C.MODELS) for (const g of ['B200', 'H200']) {
    const r = plan(m.id, g, { ctx: Math.min(32768, m.maxCtx) });
    if (r.chosen) { assert.ok(r.chosen.gpus > 0 && r.chosen.provGPUs >= r.chosen.gpus); continue; }
    assert.ok(r.dis.dec.every(x => x.why) && r.agg.rows.every(x => x.why), m.id + ' on ' + g);
  }
});
