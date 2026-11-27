// Attention beyond full and sliding-window layers: linear-attention layers (a fixed state per sequence), compressed KV
// (a share of the tokens kept) and sparse attention (a fixed number of tokens attended), and the 2026 models that use them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js');
const S = (id, gpu = 'B300', extra = {}) => Object.assign({}, M.SETTINGS, C.MODEL_DEFAULTS, C.MODELS.find(m => m.id === id), C.GPUS.find(g => g.id === gpu), extra);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${msg}: ${a} vs ${b}`);

test('no new fields: KV and attention exactly as before', () => {
  const base = Object.assign({}, M.SETTINGS, { attn: 'gqa', layers: 80, qHeads: 64, kvHeads: 8, headDim: 128, swaFrac: 0.5, swaWindow: 4096, total: 70, active: 70, tfBf16: 989, hbmTBs: 3.35, scaleUpGBs: 450, nicGbps: 400, hbmGB: 80 });
  const md = M.derive(base), L = 100000;
  assert.equal(M.kvBytes(md, L), 2 * 8 * 128 * (40 * L + 40 * 4096));
  assert.deepEqual([md.keep, md.topK, md.linLayers, md.linState], [1, 0, 0, 0]);
  assert.equal(M.kvBytes(M.derive(Object.assign({}, base, C.MODEL_DEFAULTS, { swaFrac: 0.5, swaWindow: 4096 })), L), M.kvBytes(md, L), 'catalog defaults change nothing');
});

test('linear-attention layers hold a fixed state; compressed layers a share of the tokens; sparse layers attend top-k', () => {
  const q = M.derive(S('qwen35-397b')), L = 200000;
  assert.equal(q.linLayers, 45); assert.equal(q.fullLayers, 15);
  assert.equal(M.kvBytes(q, L), 2 * 2 * 256 * 15 * L + 45 * 4.19e6, 'KV for 15 gated-attention layers plus 45 fixed states');
  assert.equal(M.kvBytes(q, 2 * L) - M.kvBytes(q, L), 2 * 2 * 256 * 15 * L, 'the states do not grow with context');
  const d = M.derive(S('deepseek-v4-pro'));
  near(M.kvBytes(d, 1048576) / M.kvBytes(M.derive(S('deepseek-v3')), 1048576), 0.129 * (512 / 576), 1e-9, 'V4 keeps ~13% of the tokens of a 512-wide latent');
  // attention: a sparse layer stops growing once its kept tokens pass top-k; prefill is the integral over query positions
  const g = M.derive(S('glm-5.1'));
  for (const L0 of [1000, 2048, 50000, 1e6]) assert.equal(M.attnDec(g, L0), g.Adec * g.fullLayers * Math.min(L0, 2048), `GLM attends min(L, 2048) at ${L0}`);
  const f = M.derive(Object.assign({}, S('deepseek-v4-flash'), { kvKeep: 0.25, sparseTopK: 1000 })), n = 20000;
  let sum = 0; for (let x = 0; x < n; x++) sum += Math.min(0.25 * (x + 0.5), 1000);
  near(M.attnPre(f, 0, n), f.Apre * f.fullLayers * sum, 1e-6, 'prefill attention: closed form against a Riemann sum');
  assert.equal(M.attnDec(q, 10) - M.attnDec(q, 0), q.Adec * 15 * 10, 'linear layers cost the same at any context');
});

test('every catalog model is valid and has a plan on a current GPU; published KV per token matches', () => {
  for (const m of C.MODELS) { const v = C.validateModel(m); assert.ok(v.ok, `${m.id}: ${v.errors.join('; ')}`); }
  for (const id of ['kimi-k3', 'kimi-k26', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.1', 'glm-5.3', 'mistral-large-4', 'qwen35-397b', 'qwen38-27b', 'minimax-m3', 'minimax-m27', 'muse-spark-open', 'gemma4-31b']) {
    for (const gpu of ['B300', 'VR200-NVL72', 'MI455X-Helios']) { const r = M.plan(S(id, gpu, { ctx: 131072 })); assert.ok(r.chosen && r.chosen.provGPUs > 0, `${id} on ${gpu}`); }
  }
  // the KV a token holds (bf16) against the figures published for the architecture
  const perTok = (id, L = 131072) => M.kvBytes(M.derive(S(id, 'B300', { kvprec: 'bf16' })), L) / L / 1024;
  near(perTok('mistral-large-4'), 80.75, 0.02, 'Mistral Large 4: 80.75 KiB'); // MLA 576 × 72 layers, plus the indexer's keys
  near(perTok('deepseek-v4-flash'), 6.72, 0.25, 'DeepSeek-V4-Flash: 6.72 KiB of growing cache'); // without the indexer's keys
  assert.match(C.validateModel(Object.assign({}, C.MODELS.find(m => m.id === 'gemma4-31b'), { linFrac: 0.5 })).errors.join(), /add up to more than all layers/);
});

test('a Hugging Face config with Gated DeltaNet layers and an index top-k imports with them', () => {
  const r = C.fromHFConfig({ model_type: 'qwen3_5_moe', num_hidden_layers: 60, hidden_size: 4096, num_attention_heads: 32, num_key_value_heads: 2, head_dim: 256, full_attention_interval: 4,
    linear_num_value_heads: 64, linear_key_head_dim: 128, linear_value_head_dim: 128, num_experts: 512, num_experts_per_tok: 10, moe_intermediate_size: 1024, vocab_size: 248320, max_position_embeddings: 262144, index_topk: 2048 });
  assert.deepEqual([r.model.linFrac, r.model.linStateMB, r.model.sparseTopK], [0.75, 4.194, 2048]);
  assert.ok(r.notes.some(n => /45 linear-attention layers/.test(n)) && r.notes.some(n => /2048 selected tokens/.test(n)));
  const lt = C.fromHFConfig({ model_type: 'x', num_hidden_layers: 4, hidden_size: 1024, num_attention_heads: 8, num_key_value_heads: 2, layer_types: ['linear_attention', 'linear_attention', 'linear_attention', 'full_attention'], vocab_size: 1000 });
  assert.equal(lt.model.linFrac, 0.75);
});
