/* Inference Sizer catalog: GPUs and models, spec-sheet import/export, and Hugging Face config.json parsing.
   Plain data plus validation, so the browser page, the CLI and FleetScope can share it. */
(function (root) {
  'use strict';

  // ---------- schemas ----------
  // Every field a GPU or model entry may carry, with its unit, range and a one-line meaning.
  // The UI builds its edit forms from these, and imports are checked against them.
  const GPU_FIELDS = [
    { k: 'label', type: 'text', label: 'Name', required: true },
    { k: 'vendor', type: 'text', label: 'Vendor' },
    { k: 'hbmGB', label: 'HBM per GPU', unit: 'GB', min: 1, max: 4096, required: true, hint: 'Memory the GPU exposes (e.g. 180 for HGX B200).' },
    { k: 'hbmTBs', label: 'HBM bandwidth', unit: 'TB/s', min: 0.1, max: 100, required: true },
    { k: 'tfBf16', label: 'BF16 dense', unit: 'TFLOPS', min: 1, max: 1e6, required: true, hint: 'Dense, not the "with sparsity" figure.' },
    { k: 'tfFp8', label: 'FP8 dense', unit: 'TFLOPS', min: 0, max: 1e6, hint: '0 if the GPU has no FP8 tensor cores.' },
    { k: 'tfFp4', label: 'FP4 dense', unit: 'TFLOPS', min: 0, max: 1e6, hint: '0 if the GPU has no FP4 tensor cores.' },
    { k: 'scaleUpGBs', label: 'GPU-to-GPU link, per direction', unit: 'GB/s', min: 1, max: 1e5, required: true, hint: 'NVLink / Infinity Fabric. Half the bidirectional figure.' },
    { k: 'domain', label: 'GPUs per scale-up domain', unit: 'GPUs', min: 1, max: 576, required: true, hint: '8 for an HGX server, 72 for an NVL72 rack.' },
    { k: 'nicGbps', label: 'Scale-out NIC per GPU', unit: 'Gb/s', min: 1, max: 1e4, required: true },
    { k: 'nodeKW', label: 'Power per domain (max)', unit: 'kW', min: 0, max: 2000 },
    { k: 'price', label: 'Price', unit: '$/GPU-hr', min: 0, max: 1000, hint: 'Placeholder unless you set your own.' },
    { k: 'source', type: 'text', label: 'Spec sheet URL' },
  ];
  const MODEL_FIELDS = [
    { k: 'name', type: 'text', label: 'Name', required: true },
    { k: 'total', label: 'Total params', unit: 'B', min: 0.01, max: 1e5, required: true },
    { k: 'active', label: 'Active params per token', unit: 'B', min: 0.01, max: 1e5, required: true },
    { k: 'layers', label: 'Layers', min: 1, max: 1000, int: true, required: true },
    { k: 'hidden', label: 'Hidden size', min: 64, max: 1e6, int: true, required: true },
    { k: 'qHeads', label: 'Query heads', min: 1, max: 4096, int: true, required: true },
    { k: 'kvHeads', label: 'KV heads', min: 1, max: 4096, int: true, required: true },
    { k: 'headDim', label: 'Head dim', min: 8, max: 4096, int: true, required: true },
    { k: 'attn', type: 'enum', opts: ['gqa', 'mla'], label: 'Attention', required: true },
    { k: 'mlaLatent', label: 'MLA KV latent (kv_lora_rank)', min: 1, max: 1e5, int: true },
    { k: 'mlaRope', label: 'MLA RoPE dim', min: 0, max: 1e4, int: true },
    { k: 'mlaNope', label: 'MLA QK no-PE dim', min: 0, max: 1e4, int: true },
    { k: 'mlaV', label: 'MLA V head dim', min: 1, max: 1e4, int: true },
    { k: 'experts', label: 'Routed experts (0 = dense)', min: 0, max: 1e5, int: true },
    { k: 'topk', label: 'Experts per token', min: 0, max: 1e4, int: true },
    { k: 'swaFrac', label: 'Share of sliding-window layers', min: 0, max: 1 },
    { k: 'swaWindow', label: 'Sliding window', unit: 'tokens', min: 0, max: 1e8, int: true },
    { k: 'maxCtx', label: 'Max context', unit: 'tokens', min: 256, max: 1e8, int: true, required: true },
    { k: 'wprec', type: 'enum', opts: ['bf16', 'fp8', 'fp4'], label: 'Default weight precision' },
    { k: 'source', type: 'text', label: 'Model card URL' },
  ];

  // ---------- built-in GPUs ----------
  // From the shared accelerator registry (accelerators.js): per-GPU dense figures, HGX/DGX system totals divided by 8
  // (or 72 for NVL72), "with sparsity" figures halved. Prices are placeholder on-demand rents, not quotes.
  const REG = (typeof module !== 'undefined' && module.exports) ? require('./accelerators.js') : root.AIInfraAccelerators;
  const ORDER = ['B200', 'B300', 'GB200-NVL72', 'GB300-NVL72', 'H200', 'H100', 'A100', 'L40S', 'MI300X', 'MI325X', 'MI355X', 'TPU7x', 'TPU-v6e', 'TPU-v5p'];
  const KEEP = ['id', 'kind', 'vendorKey', 'gkeAccelerator', 'tdpW'].concat(GPU_FIELDS.map(f => f.k)); // tdpW: board power, for tokens per MW
  const GPUS = REG.ACCELERATORS.slice().sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99))
    .map(g => Object.fromEntries(KEEP.filter(k => g[k] !== undefined).map(k => [k, g[k]])));

  // ---------- built-in models ----------
  const MLA = { attn: 'mla', kvHeads: 1, headDim: 128, mlaLatent: 512, mlaRope: 64, mlaNope: 128, mlaV: 128 };
  const G = { attn: 'gqa', experts: 0, topk: 0, swaFrac: 0, swaWindow: 0 };
  const MODELS = [
    Object.assign({ id: 'llama31-8b', name: 'Llama 3.1 8B', total: 8.03, active: 8.03, layers: 32, hidden: 4096, qHeads: 32, kvHeads: 8, headDim: 128, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct' }, G),
    Object.assign({ id: 'qwen3-32b', name: 'Qwen3 32B', total: 32.8, active: 32.8, layers: 64, hidden: 5120, qHeads: 64, kvHeads: 8, headDim: 128, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/Qwen/Qwen3-32B' }, G),
    Object.assign({ id: 'llama33-70b', name: 'Llama 3.3 70B', total: 70.6, active: 70.6, layers: 80, hidden: 8192, qHeads: 64, kvHeads: 8, headDim: 128, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct' }, G),
    Object.assign({ id: 'qwen25-72b', name: 'Qwen2.5 72B', total: 72.7, active: 72.7, layers: 80, hidden: 8192, qHeads: 64, kvHeads: 8, headDim: 128, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct' }, G),
    Object.assign({ id: 'llama31-405b', name: 'Llama 3.1 405B', total: 405.9, active: 405.9, layers: 126, hidden: 16384, qHeads: 128, kvHeads: 8, headDim: 128, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/meta-llama/Llama-3.1-405B-Instruct' }, G),
    Object.assign({}, G, { id: 'gpt-oss-120b', name: 'gpt-oss-120b (MoE)', total: 116.8, active: 5.1, layers: 36, hidden: 2880, qHeads: 64, kvHeads: 8, headDim: 64, experts: 128, topk: 4, swaFrac: 0.5, swaWindow: 128, maxCtx: 131072, wprec: 'fp4', source: 'https://huggingface.co/openai/gpt-oss-120b' }),
    Object.assign({}, G, { id: 'mixtral-8x22b', name: 'Mixtral 8x22B (MoE)', total: 141, active: 39, layers: 56, hidden: 6144, qHeads: 48, kvHeads: 8, headDim: 128, experts: 8, topk: 2, maxCtx: 65536, wprec: 'fp8', source: 'https://huggingface.co/mistralai/Mixtral-8x22B-Instruct-v0.1' }),
    Object.assign({}, G, { id: 'qwen3-235b', name: 'Qwen3 235B-A22B (MoE)', total: 235, active: 22, layers: 94, hidden: 4096, qHeads: 64, kvHeads: 4, headDim: 128, experts: 128, topk: 8, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/Qwen/Qwen3-235B-A22B' }),
    Object.assign({}, G, { id: 'llama4-maverick', name: 'Llama 4 Maverick 400B (MoE)', total: 400, active: 17, layers: 48, hidden: 5120, qHeads: 40, kvHeads: 8, headDim: 128, experts: 128, topk: 1, swaFrac: 0.75, swaWindow: 8192, maxCtx: 1048576, wprec: 'fp8', source: 'https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct' }),
    Object.assign({}, G, { id: 'qwen3-coder-480b', name: 'Qwen3-Coder 480B-A35B (MoE)', total: 480, active: 35, layers: 62, hidden: 6144, qHeads: 96, kvHeads: 8, headDim: 128, experts: 160, topk: 8, maxCtx: 262144, wprec: 'fp8', source: 'https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct' }),
    Object.assign({}, G, MLA, { id: 'deepseek-v3', name: 'DeepSeek-V3 / R1 671B (MoE, MLA)', total: 671, active: 37, layers: 61, hidden: 7168, qHeads: 128, experts: 256, topk: 8, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/deepseek-ai/DeepSeek-V3' }),
    Object.assign({}, G, MLA, { id: 'kimi-k2', name: 'Kimi K2 1T (MoE, MLA)', total: 1040, active: 32, layers: 61, hidden: 7168, qHeads: 64, experts: 384, topk: 8, maxCtx: 131072, wprec: 'fp8', source: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct' }),
  ];
  const MODEL_DEFAULTS = { attn: 'gqa', experts: 0, topk: 0, swaFrac: 0, swaWindow: 0, mlaLatent: 512, mlaRope: 64, mlaNope: 128, mlaV: 128, wprec: 'fp8' };
  const GPU_DEFAULTS = { tfFp8: 0, tfFp4: 0, nodeKW: 0, price: 0, vendor: '' };

  // ---------- validation ----------
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
  function check(entry, fields, defaults, kind) {
    const errors = [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, errors: [kind + ' entry must be an object.'] };
    const out = Object.assign({}, defaults);
    const nameKey = kind === 'GPU' ? 'label' : 'name';
    out.id = entry.id ? String(entry.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) : slug(entry[nameKey]);
    for (const f of fields) {
      let v = entry[f.k];
      if (v === undefined || v === null || v === '') {
        if (f.required) errors.push(`${kind} "${entry[nameKey] || entry.id || '?'}": missing ${f.label} (${f.k}).`);
        continue;
      }
      if (f.type === 'text') { out[f.k] = String(v).slice(0, 300); continue; }
      if (f.type === 'enum') {
        v = String(v).toLowerCase();
        if (!f.opts.includes(v)) { errors.push(`${kind} "${entry[nameKey] || out.id}": ${f.k} must be one of ${f.opts.join(', ')}.`); continue; }
        out[f.k] = v; continue;
      }
      v = Number(v);
      if (!isFinite(v)) { errors.push(`${kind} "${entry[nameKey] || out.id}": ${f.k} must be a number.`); continue; }
      if (f.int) v = Math.round(v);
      if (v < f.min || v > f.max) { errors.push(`${kind} "${entry[nameKey] || out.id}": ${f.k} = ${v} is outside ${f.min}–${f.max}${f.unit ? ' ' + f.unit : ''}.`); continue; }
      out[f.k] = v;
    }
    if (kind === 'Model' && out.active > out.total) errors.push(`Model "${out.name}": active params (${out.active}B) exceed total (${out.total}B).`);
    if (kind === 'Model' && out.experts > 0 && !(out.topk > 0 && out.topk < out.experts)) errors.push(`Model "${out.name}": experts per token must be between 1 and ${out.experts - 1}.`);
    if (kind === 'Model' && out.experts > 0 && out.active >= out.total) errors.push(`Model "${out.name}": an MoE model needs active params below total params.`);
    return { ok: errors.length === 0, errors, value: out };
  }
  const validateGPU = g => check(g, GPU_FIELDS, GPU_DEFAULTS, 'GPU');
  const validateModel = m => check(m, MODEL_FIELDS, MODEL_DEFAULTS, 'Model');

  // ---------- spec sheets ----------
  // A spec sheet is JSON: { "kind": "inference-sizer/catalog", "version": 1, "gpus": [...], "models": [...] }.
  // An entry whose id matches a built-in one replaces it ("update via spec sheet"); new ids are added.
  // A single GPU or model object, or a Hugging Face config.json, is also accepted.
  const SHEET_KIND = 'inference-sizer/catalog';
  function parseSheet(text) {
    let j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, errors: ['Not valid JSON: ' + e.message], gpus: [], models: [] }; }
    const res = { ok: true, errors: [], gpus: [], models: [], notes: [] };
    if (!j || typeof j !== 'object') return { ok: false, errors: ['Expected a JSON object.'], gpus: [], models: [] };
    let gpus = [], models = [];
    if (Array.isArray(j.gpus) || Array.isArray(j.models)) { gpus = j.gpus || []; models = j.models || []; }
    else if (isHFConfig(j)) { const m = fromHFConfig(j); models = [m.model]; res.notes.push(...m.notes); }
    else if ('hbmGB' in j || 'tfBf16' in j) gpus = [j];
    else if ('layers' in j || 'qHeads' in j) models = [j];
    else return { ok: false, errors: ['Could not recognise this file. Use a spec sheet with "gpus" and/or "models" arrays, a single GPU or model entry, or a Hugging Face config.json.'], gpus: [], models: [] };
    for (const g of gpus) { const r = validateGPU(g); if (r.ok) res.gpus.push(r.value); else res.errors.push(...r.errors); }
    for (const m of models) { const r = validateModel(m); if (r.ok) res.models.push(r.value); else res.errors.push(...r.errors); }
    res.ok = res.errors.length === 0 && (res.gpus.length + res.models.length) > 0;
    if (!res.gpus.length && !res.models.length && !res.errors.length) { res.ok = false; res.errors.push('The file holds no GPUs or models.'); }
    return res;
  }
  function makeSheet(gpus, models) {
    const strip = o => { const c = Object.assign({}, o); delete c.builtin; delete c.custom; return c; };
    return { kind: SHEET_KIND, version: 1, gpus: (gpus || []).map(strip), models: (models || []).map(strip) };
  }
  // Built-ins overlaid with user entries (same id replaces).
  function merge(builtin, custom) {
    const out = builtin.map(x => Object.assign({ builtin: true }, x));
    for (const c of custom || []) {
      const i = out.findIndex(x => x.id === c.id);
      const e = Object.assign({ custom: true }, c);
      if (i >= 0) out[i] = Object.assign(e, { overrides: true }); else out.push(e);
    }
    return out;
  }

  // ---------- Hugging Face config.json ----------
  function isHFConfig(j) {
    const c = j.text_config || j;
    return ('num_hidden_layers' in c || 'n_layer' in c) && ('hidden_size' in c || 'n_embd' in c || 'd_model' in c);
  }
  const first = (o, keys, d) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return d; };
  // Reads architecture fields and estimates parameter counts from the layer shapes (embeddings, attention, MLP/experts).
  function fromHFConfig(j) {
    const notes = [];
    const c = j.text_config ? Object.assign({}, j.text_config) : j;
    if (j.text_config) notes.push('Read the text model from text_config.');
    const layers = +first(c, ['num_hidden_layers', 'n_layer', 'num_layers']);
    const hidden = +first(c, ['hidden_size', 'n_embd', 'd_model']);
    const qHeads = +first(c, ['num_attention_heads', 'n_head', 'num_heads']);
    let kvHeads = +first(c, ['num_key_value_heads', 'num_kv_heads', 'n_head_kv'], c.multi_query ? 1 : qHeads);
    const headDim = +first(c, ['head_dim'], Math.round(hidden / qHeads));
    const V = +first(c, ['vocab_size', 'padded_vocab_size'], 32000);
    const inter = +first(c, ['intermediate_size', 'ffn_hidden_size', 'n_inner'], 4 * hidden);
    const experts = +first(c, ['num_local_experts', 'n_routed_experts', 'num_experts', 'moe_num_experts'], 0) || 0;
    const topk = experts ? +first(c, ['num_experts_per_tok', 'experts_per_token', 'moe_top_k', 'num_experts_per_token', 'top_k'], 2) : 0;
    const moeInter = +first(c, ['moe_intermediate_size', 'expert_intermediate_size'], inter);
    const denseInter = +first(c, ['intermediate_size_mlp'], inter);
    const mla = c.kv_lora_rank != null;
    const mlaLatent = mla ? +c.kv_lora_rank : 512, mlaRope = mla ? +first(c, ['qk_rope_head_dim'], 64) : 64;
    const mlaNope = mla ? +first(c, ['qk_nope_head_dim'], 128) : 128, mlaV = mla ? +first(c, ['v_head_dim'], 128) : 128;
    if (mla) kvHeads = 1;
    // sliding window
    let swaFrac = 0, swaWindow = 0;
    if (Array.isArray(c.layer_types) && c.sliding_window) {
      const n = c.layer_types.filter(t => /slid/i.test(String(t))).length;
      swaFrac = +(n / c.layer_types.length).toFixed(3); swaWindow = +c.sliding_window;
    } else if (c.sliding_window && c.use_sliding_window === true) { swaFrac = 1; swaWindow = +c.sliding_window; }
    else if (c.attention_chunk_size && c.no_rope_layers) {
      const n = c.no_rope_layers.filter(x => x).length;
      swaFrac = +(n / c.no_rope_layers.length).toFixed(3); swaWindow = +c.attention_chunk_size;
      notes.push('Chunked-attention layers modelled as sliding-window layers.');
    }
    if (c.sliding_window && !swaFrac) notes.push('sliding_window is set but not enabled for these layers; KV is sized for full attention.');
    // context
    let maxCtx = +first(c, ['max_position_embeddings', 'n_positions', 'seq_length', 'max_sequence_length'], 4096);
    const rs = c.rope_scaling;
    if (rs && rs.factor && rs.original_max_position_embeddings) maxCtx = Math.max(maxCtx, Math.round(rs.factor * rs.original_max_position_embeddings));
    // which layers are MoE
    let moeLayers = experts ? layers : 0;
    if (experts && c.first_k_dense_replace != null) moeLayers = layers - c.first_k_dense_replace;
    if (experts && c.interleave_moe_layer_step > 1) moeLayers = Math.floor(layers / c.interleave_moe_layer_step);
    if (experts && c.decoder_sparse_step > 1) moeLayers = Math.floor(layers / c.decoder_sparse_step);
    if (experts && Array.isArray(c.mlp_only_layers)) moeLayers -= c.mlp_only_layers.length;
    if (experts && Array.isArray(c.moe_layers)) moeLayers = c.moe_layers.length;
    const denseLayers = layers - moeLayers;
    // attention params per layer
    let attnP;
    if (mla) {
      const qk = mlaNope + mlaRope;
      const qP = c.q_lora_rank ? hidden * c.q_lora_rank + c.q_lora_rank * qHeads * qk : hidden * qHeads * qk;
      attnP = qP + hidden * (mlaLatent + mlaRope) + mlaLatent * qHeads * (mlaNope + mlaV) + qHeads * mlaV * hidden;
    } else attnP = hidden * qHeads * headDim * 2 + hidden * kvHeads * headDim * 2;
    const gated = !(c.hidden_act === 'gelu' && /gpt2|bloom|opt/.test(c.model_type || ''));
    const mlp = n => (gated ? 3 : 2) * hidden * n;
    const sharedN = +first(c, ['n_shared_experts', 'num_shared_experts'], 0) || 0;
    const sharedInter = c.shared_expert_intermediate_size ? +c.shared_expert_intermediate_size : sharedN * moeInter;
    const llama4Shared = /llama4/.test(c.model_type || '') && experts ? mlp(moeInter) : 0;
    const expertP = mlp(moeInter);
    const tied = j.tie_word_embeddings === true || c.tie_word_embeddings === true;
    const emb = V * hidden * (tied ? 1 : 2);
    const perMoE = experts * expertP + (sharedInter ? mlp(sharedInter) : 0) + llama4Shared + hidden * experts;
    const total = emb + layers * attnP + denseLayers * mlp(denseInter) + moeLayers * perMoE;
    const active = total - moeLayers * (experts - topk) * expertP;
    notes.push('Parameter counts are estimated from layer shapes; check them against the model card.');
    const name = String(first(j, ['_name_or_path', 'name_or_path'], '') || '').split('/').pop() || (c.model_type ? c.model_type + ' ' + (total / 1e9).toFixed(0) + 'B' : 'Imported model');
    const model = {
      name, total: +(total / 1e9).toFixed(2), active: +(active / 1e9).toFixed(2), layers, hidden, qHeads, kvHeads, headDim,
      attn: mla ? 'mla' : 'gqa', mlaLatent, mlaRope, mlaNope, mlaV, experts, topk, swaFrac, swaWindow, maxCtx,
      wprec: /fp8|float8/i.test(JSON.stringify(j.quantization_config || '')) ? 'fp8' : /mxfp4|nvfp4|fp4/i.test(JSON.stringify(j.quantization_config || '')) ? 'fp4' : 'fp8',
    };
    return { model, notes };
  }

  const api = { GPU_FIELDS, MODEL_FIELDS, GPUS, MODELS, MODEL_DEFAULTS, GPU_DEFAULTS, SHEET_KIND, validateGPU, validateModel, parseSheet, makeSheet, merge, fromHFConfig, isHFConfig, slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SizerCatalog = api;
})(this);
