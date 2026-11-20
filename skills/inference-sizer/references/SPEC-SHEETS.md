# Adding and updating GPUs and models

Inference Sizer ships with a catalog of GPUs and models (`src/catalog.js`). You can extend or correct it in three ways, and none of them needs a code change:

| You have | Do this | Where it lands |
| --- | --- | --- |
| A model on Hugging Face | **Import file…** or **Paste JSON…** with its `config.json` | Your models, in this browser |
| A new GPU, or better numbers for one | Pick the closest GPU, open **Spec sheet: edit, or save as a new GPU**, change the fields, **Save GPU** | Your GPUs, in this browser |
| Many entries to share with a team | Write a spec sheet (below) and import it, or commit it under `specs/` | Anyone who imports the file |

Saved entries live in the browser's local storage. **Export my catalog** writes them out as one spec sheet, so you can move them to another machine or commit them.

To change the built-in catalog for everyone, edit `src/catalog.js`, run `npm test`, then `npm run build`.

## Spec sheet format

```json
{
  "kind": "inference-sizer/catalog",
  "version": 1,
  "gpus": [ { "id": "H200-NVL", "label": "NVIDIA H200 NVL", "hbmGB": 141, "hbmTBs": 4.8, "tfBf16": 835, "tfFp8": 1670, "tfFp4": 0, "scaleUpGBs": 450, "domain": 4, "nicGbps": 400, "nodeKW": 3.2, "price": 3.0 } ],
  "models": [ { "id": "qwen3-30b-a3b", "name": "Qwen3 30B-A3B", "total": 30.5, "active": 3.3, "layers": 48, "hidden": 2048, "qHeads": 32, "kvHeads": 4, "headDim": 128, "attn": "gqa", "experts": 128, "topk": 8, "maxCtx": 131072 } ]
}
```

`specs/example.json` is a complete example, and **Spec-sheet template** in the page gives you a fresh one.

- **Replacing a built-in entry:** give an entry the same `id` as a built-in one (`B200`, `llama33-70b`, …) and it replaces it. The model picker marks it "(your values)". **Remove** brings the built-in figures back.
- **New entries:** a new `id`, or no `id` at all, adds an entry. Without an `id`, one is made from the name.
- **Other files the import accepts:** a single GPU or model object without the wrapper, or a Hugging Face `config.json`.
- **Errors:** every field is range-checked. A bad entry is skipped with a message naming the field, and the rest of the sheet still imports.

### GPU fields

| Field | Unit | Meaning |
| --- | --- | --- |
| `id` | | Stable key. Use the built-in id to replace that GPU. |
| `label` | | Name shown in the picker (required). |
| `hbmGB` | GB | Memory per GPU as the system exposes it. HGX B200 is 180, not the 192 GB die figure. |
| `hbmTBs` | TB/s | HBM bandwidth per GPU. |
| `tfBf16`, `tfFp8`, `tfFp4` | TFLOPS | **Dense** tensor throughput per GPU. Halve any "with sparsity" figure, and divide system totals by the GPU count. Use 0 when the GPU lacks that precision: the model then keeps the weight-memory saving but computes at the next precision up. |
| `scaleUpGBs` | GB/s | GPU-to-GPU link (NVLink, Infinity Fabric) **per direction**: half the bidirectional figure. 900 for NVLink 5. |
| `domain` | GPUs | GPUs in one scale-up domain: 8 for HGX/DGX, 72 for NVL72. Instances up to this size use `scaleUpGBs`; larger ones cross the scale-out network. It is also the packing unit (node or rack). |
| `nicGbps` | Gb/s | Scale-out NIC per GPU (400 for ConnectX-7, 800 for ConnectX-8). |
| `nodeKW` | kW | Max power of one domain (node or rack), for the power estimate. Optional. |
| `price` | $/GPU-hr | For the cost tiles. The built-in prices are placeholders. Optional. |
| `vendor`, `source` | | Optional; `source` shows as a "Spec sheet" link. |

### Model fields

| Field | Unit | Meaning |
| --- | --- | --- |
| `id`, `name` | | As for GPUs (`name` is required). |
| `total`, `active` | B params | Total parameters and parameters used per token (equal for dense models). |
| `layers`, `hidden`, `qHeads`, `kvHeads`, `headDim` | | Transformer shape. `kvHeads` < `qHeads` is GQA. |
| `attn` | `gqa` or `mla` | MLA (DeepSeek-style) caches one latent per token per layer instead of K and V heads. |
| `mlaLatent`, `mlaRope`, `mlaNope`, `mlaV` | | MLA dims (`kv_lora_rank`, `qk_rope_head_dim`, `qk_nope_head_dim`, `v_head_dim`). Defaults are DeepSeek-V3's 512 / 64 / 128 / 128. |
| `experts`, `topk` | | Routed experts and experts per token. 0 for dense models. |
| `swaFrac`, `swaWindow` | 0–1, tokens | Share of layers with sliding-window (or chunked) attention, and the window. Those layers cache only the window. |
| `maxCtx` | tokens | The model's maximum context. The page warns when the context window is set above it. |
| `wprec` | `bf16`, `fp8`, `fp4` | Precision picked when the model is selected. Optional. |

## Importing a Hugging Face config.json

The importer reads `num_hidden_layers`, `hidden_size`, `num_attention_heads`, `num_key_value_heads`, `head_dim`, the expert counts (`num_local_experts`, `n_routed_experts`, `num_experts`, `num_experts_per_tok`, `experts_per_token`), MLA ranks (`kv_lora_rank`, …), sliding-window settings (`sliding_window` with `layer_types`, or `use_sliding_window`) and the context length (`max_position_embeddings`, extended by `rope_scaling`). Multimodal configs are read from `text_config`.

`config.json` does not state parameter counts, so the importer estimates them from the layer shapes: embeddings, attention, dense MLP, routed and shared experts, and router. On the test fixtures the estimates land within 3% of the published totals:

| Config | Estimated total / active | Published |
| --- | --- | --- |
| Llama 3.1 8B | 8.03B | 8.03B |
| DeepSeek-V3 | 671B / 37.6B | 671B / 37B |
| Qwen3-235B-A22B | 235B / 22.2B | 235B / 22B |
| gpt-oss-120b | 116.8B / 5.7B | 116.8B / 5.1B (excludes embeddings) |

Check the numbers against the model card, correct them in the Architecture panel if needed, and **Save model**.
