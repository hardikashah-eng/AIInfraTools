import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js');
const fixture = f => readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const near = (a, b, tol) => Math.abs(a - b) / b <= tol;

test('every built-in GPU and model passes its own validation', () => {
  for (const g of C.GPUS) assert.ok(C.validateGPU(g).ok, g.id + ': ' + C.validateGPU(g).errors.join('; '));
  for (const m of C.MODELS) assert.ok(C.validateModel(m).ok, m.id + ': ' + C.validateModel(m).errors.join('; '));
  assert.equal(new Set(C.GPUS.map(g => g.id)).size, C.GPUS.length, 'GPU ids are unique');
  assert.equal(new Set(C.MODELS.map(m => m.id)).size, C.MODELS.length, 'model ids are unique');
});

test('the shipped spec sheet and the exported template import cleanly', () => {
  const sheet = C.parseSheet(readFileSync(new URL('../specs/example.json', import.meta.url), 'utf8'));
  assert.ok(sheet.ok, sheet.errors.join('; '));
  assert.ok(sheet.gpus.length >= 1 && sheet.models.length >= 1);
  const tpl = C.parseSheet(JSON.stringify(C.makeSheet([C.GPUS[0]], [C.MODELS[0]])));
  assert.ok(tpl.ok, tpl.errors.join('; '));
  assert.equal(tpl.gpus[0].id, C.GPUS[0].id);
});

test('a sheet entry with a built-in id replaces it; a new id is added', () => {
  const r = C.parseSheet({ gpus: [Object.assign({}, C.GPUS.find(g => g.id === 'B200'), { hbmTBs: 7.7, price: 3.1 }), { id: 'x1', label: 'Lab GPU', hbmGB: 96, hbmTBs: 4, tfBf16: 800, scaleUpGBs: 400, domain: 4, nicGbps: 400 }] });
  assert.ok(r.ok, r.errors.join('; '));
  const merged = C.merge(C.GPUS, r.gpus);
  const b200 = merged.find(g => g.id === 'B200');
  assert.equal(b200.hbmTBs, 7.7);
  assert.ok(b200.overrides);
  assert.equal(merged.length, C.GPUS.length + 1);
  assert.equal(merged.find(g => g.id === 'x1').tfFp8, 0, 'missing optional precisions default to 0 (not supported)');
});

test('bad entries are rejected with a message that names the field', () => {
  const r = C.parseSheet({ gpus: [{ label: 'Broken', hbmGB: -1, hbmTBs: 4, tfBf16: 800, scaleUpGBs: 400, domain: 8, nicGbps: 400 }], models: [{ name: 'MoE', total: 10, active: 20, layers: 10, hidden: 1024, qHeads: 8, kvHeads: 8, headDim: 128, attn: 'gqa', maxCtx: 4096 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /hbmGB/.test(e)));
  assert.ok(r.errors.some(e => /active params/.test(e)));
  assert.equal(C.parseSheet('{not json').ok, false);
  assert.equal(C.parseSheet({ hello: 1 }).ok, false);
});

test('Hugging Face config.json: architecture and parameter estimates match the model cards', () => {
  const cases = [
    ['llama-3.1-8b.config.json', { total: 8.03, active: 8.03, attn: 'gqa', kvHeads: 8, maxCtx: 131072 }],
    ['deepseek-v3.config.json', { total: 671, active: 37, attn: 'mla', experts: 256, topk: 8, mlaLatent: 512 }],
    ['qwen3-235b-a22b.config.json', { total: 235, active: 22, attn: 'gqa', kvHeads: 4, experts: 128 }],
    ['gpt-oss-120b.config.json', { total: 116.8, active: 5.1, swaFrac: 0.5, swaWindow: 128, wprec: 'fp4' }],
  ];
  for (const [f, want] of cases) {
    const r = C.parseSheet(fixture(f));
    assert.ok(r.ok, f + ': ' + r.errors.join('; '));
    const m = r.models[0];
    for (const [k, v] of Object.entries(want)) {
      if (k === 'total') assert.ok(near(m.total, v, 0.03), `${f} total ${m.total}B vs ${v}B`);
      else if (k === 'active') assert.ok(near(m.active, v, 0.15), `${f} active ${m.active}B vs ${v}B`);
      else assert.equal(m[k], v, `${f} ${k}`);
    }
  }
});
