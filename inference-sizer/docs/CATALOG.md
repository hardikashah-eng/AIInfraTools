# Keeping the model and hardware lists current

The Inference Sizer's catalog (`src/catalog.js`, `MODELS`) and the accelerator registry (`src/accelerators.js`) are
the lists behind every model and GPU menu in the repo:
- the Inference Sizer page and CLI;
- FleetScope's model menus, which take every catalog model FleetScope doesn't already have;
- harness-ledger's self-hosting economics;
- fleetops' power model and serving manifests.

They are refreshed weekly: a scheduled task looks for new open-weight models and inference chips and opens a pull
request against `main`. Anyone can do the same by hand with this checklist.

## Where figures come from

Use these sources, most trusted first:

1. The model's Hugging Face `config.json` and model card, or the vendor's spec page or datasheet.
2. The model's technical report.
3. Pages that reproduce the config with a link to it, such as SemiAnalysis InferenceX's model pages
   (`inferencex.semianalysis.com/model/...`), Sebastian Raschka's LLM Architecture Gallery, or cloud model libraries.

Rules:

- **Name the source.** Put it in `source`, and say in the comment above the entry where any figure that isn't in the
  config comes from.
- **Don't guess a missing figure.** Either leave the model out, or use the closest published figure and say so in the
  comment. For example, GLM-5.3's active parameters aren't published, so the GLM-5 lineage's 40B is used, and the
  comment says that.
- **Use dense chip figures.** Halve "with sparsity" numbers, and divide rack totals by the chip count. When a vendor
  publishes no board power, give the reported figure and say it is reported, not a spec-sheet value.
- **Prices are placeholders,** not quotes.

## Model fields beyond plain attention

| Field | Use it for | How to fill it |
| --- | --- | --- |
| `swaFrac`, `swaWindow` | Sliding-window layers (gpt-oss, Gemma, Muse Spark) | Share of layers that use a window, and the window in tokens |
| `linFrac`, `linStateMB` | Linear-attention layers (Kimi Delta Attention, Gated DeltaNet) | Share of such layers; state per layer per sequence = value heads × key dim × value dim × 4 bytes |
| `kvKeep` | Compressed attention (DeepSeek V4's CSA/HCA) | Average share of tokens whose KV is kept (V4: 1/4 and 1/128 on alternating layers ≈ 0.129) |
| `sparseTopK` | Sparse attention (DSA, GLM's IndexShare, MiniMax MSA, Mistral Large 4) | Tokens each query attends (the index top-k) |

A linear-attention layer holds a fixed state per sequence rather than KV per token. Its compute per token doesn't grow
with context. When a model mixes kinds that one entry can't hold exactly, size it on the kind that dominates at long
context and say what was approximated. For example, Gemma 4's sliding-window layers have more KV heads than its global
layers, but their KV is capped at the window, so the entry uses the global layers' heads.

`fromHFConfig` reads these from a config: `layer_types` with sliding or linear layers, `full_attention_interval`,
`linear_num_value_heads` and the linear head dims, and `index_topk`.

## Checklist for an update

1. **Models:** find open-weight releases since the last update (Hugging Face trending, the labs' release notes,
   open-weight leaderboards) and their config values. Add each to `MODELS` with a stable `id`, and never rename an
   existing id: saved inputs and FleetScope graphs refer to them.
2. **Chips:** find announced or shipping accelerators with published memory, bandwidth and dense FLOPS. Add each to
   `ACCELERATORS` (see [ACCELERATORS.md](ACCELERATORS.md)), with a `match` that doesn't catch other SKUs.
3. **Tests:** add the new SKU names to `tests/accelerators.test.mjs`. Check any published KV-per-token figure in
   `inference-sizer/tests/attention.test.mjs`.
4. **Build and check:** run `npm run build` in `inference-sizer/` and `fleetscope/`. Then run `npm test` at the root,
   in `inference-sizer/` and in `fleetscope/`. Run `node scripts/schemas.mjs --update` if `sizer list` output changed.
5. **Changelog:** add a line under "Unreleased".

## Not in the lists yet, and why

| Item | Why it isn't in yet |
| --- | --- |
| AWS Trainium3 | Needs a Neuron vendor adapter: Kubernetes resource, exporter, vLLM image and a gpu-health profile |
| Google TPU 8i / 8t | FP8, BF16 and ICI figures are unpublished, as is the GKE accelerator name |
| DeepSeek V4.1 Flash | Encoder-decoder with a separate Engram memory: not a shape the sizer models |
| Qwen3.8 2.4T-A95B, LongCat-2.5, Hunyuan Hy3, Inkling | Config values not found in a citable source yet |
| NVIDIA Rubin CPX | A prefill-only part: the sizer sizes one GPU type per deployment |
