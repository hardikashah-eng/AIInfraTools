# How Inference Sizer estimates a fleet

A first-order model: a roofline per parallel layout, a queueing model for prefill, and a search over layouts and serving architectures. It answers "how many GPUs, laid out how" in milliseconds for the peak load you describe. Use [FleetScope](../../fleetscope/) to replay that answer over time.

All of it lives in `src/model.js` as pure functions over one flat input object. The page, the CLI (`tools/size.mjs`) and the tests all call `plan(s)`.

## Inputs

| Input | Meaning |
| --- | --- |
| Model fields | From the catalog entry (see [SPEC-SHEETS.md](SPEC-SHEETS.md)). |
| GPU fields | From the catalog entry. |
| `wprec`, `kvprec` | Weight precision (`bf16`, `fp8`, `fp4`: 2, 1, 0.5625 bytes/param including FP4 block scales) and KV cache precision (`bf16`, `fp8`). |
| `ctx` | Context window: the most tokens one request may hold. One full-length request must fit in one instance's KV cache. With `kvPolicy: reserve`, every session holds a full window. |
| `conc` | Concurrent sessions at peak: streams that must decode at the TPOT target at once. |
| `dau`, `rpu`, `peakFactor` | Daily active users, requests per user per day, and peak-to-average traffic. |
| `concSource` | `max` sizes for whichever of `conc` and DAU is larger; `conc` or `dau` uses one. |
| `avgIn`, `peakIn`, `avgOut`, `peakOut` | Tokens per request. Averages drive throughput and memory; the peak prompt must still meet TTFT. |
| `prefixHit` | % of prompt tokens served from the prefix cache (cuts prefill compute and KV transfer). |
| `ttft`, `tpot` | Targets in ms. |
| `mode` | `auto`, `disagg` (separate prefill and decode pools), `agg` (both on each GPU, chunked prefill). |
| `kvPolicy` | `paged` (actual tokens, as vLLM, SGLang and TRT-LLM do) or `reserve` (a full window per session). |
| `headroom` | % added to the peak load. |
| `nPlus1` | Keep room for one more instance of the largest layout. |
| `price` | $/GPU-hour. |

Engine assumptions, all editable on the page:

| Setting | Default | Meaning |
| --- | --- | --- |
| `memUtil` | 0.90 | Share of HBM the engine takes (vLLM `gpu_memory_utilization`). |
| `reserveGB` | 8 | Per-GPU memory for activations, CUDA graphs and workspace. |
| `kvMaxUtil` | 0.90 | Largest share of the KV cache that may be filled at peak. |
| `sloMargin` | 10% | Sizes to the targets less this margin. |
| `effPrefill` | 0.40 | Prefill MFU. |
| `effDecodeBW` | 0.65 | Achieved share of HBM bandwidth in decode. |
| `effDecodeComp` | 0.30 | Decode MFU. |
| `stepMs` | 1.5 | Fixed per-step overhead (scheduling, sampling, launch). |
| `maxSeqPerGPU` | 256 | Cap on sequences per GPU in one batch. |

## Steps

1. **Load.** Peak arrivals from DAU are `dau × rpu ÷ 86,400 × peakFactor`. Concurrent sessions convert to a rate with Little's law: `conc ÷ (TTFT + avgOut × TPOT)`. Decode must hold `conc` streams and deliver `rate × avgOut` tokens/s. All of these grow by `headroom`.
2. **Layouts.** Instances of 1, 2, 4, … 64 GPUs.
   - Dense models: TP inside the scale-up domain, pipeline parallel across domains.
   - MoE models: TP attention with EP experts inside a domain, and wide EP with data-parallel attention across domains.
   - MLA models: data-parallel attention, because TP would replicate the latent KV cache.
   - Prefill: TP inside a domain, context parallel across domains.
3. **Memory.** Weights per GPU follow the layout. With DP attention, the dense weights are replicated. KV per token is `2 × layers × kvHeads × headDim × bytes`, or `(latent + rope) × layers × bytes` for MLA; sliding-window layers store only the window. Linear-attention layers (Kimi Delta Attention, Gated DeltaNet) store a fixed state per sequence instead. Compressed attention keeps a share of the tokens (`kvKeep`). Sparse attention attends at most `sparseTopK` tokens per query, which caps attention compute but not KV (see [CATALOG.md](CATALOG.md)). KV is replicated when TP exceeds the KV-head count.
4. **Decode step.** `max(HBM read time, compute time) + collectives + overhead`. The HBM read covers the weights, but only the experts the batch actually routes to, which is `1 − (1 − topk/experts)^B` of them, plus every stream's KV at the average context. Compute covers the linear layers at the weight precision's tensor rate and attention at BF16. Collectives are TP all-reduce or EP all-to-all over NVLink inside a domain, and over the NIC across domains. The largest batch whose step fits the TPOT target, less the margin, sets streams per instance.
5. **Prefill.** `2 × active params × prompt tokens` plus causal attention (sliding-window aware), at the prefill MFU and floored by one read of the weights. Short prompts batch up to 8,192 tokens. Queueing is M/D/1: utilisation is capped so that the average prompt's service time plus its wait meets TTFT. The peak prompt must meet TTFT on an idle instance. In disaggregated mode, the KV transfer to decode (over RDMA) counts against TTFT.
6. **Aggregated mode.** Each step carries the decode batch plus a prefill chunk sized so the step stays within TPOT. Prompts drain at that chunk rate, which sets TTFT.
7. **Pick.** For each pool, the layout with the fewest GPUs. Auto picks disaggregated only when it needs at least 10% fewer nodes than aggregated. Instances pack first-fit into domains, and N+1 adds room for one more instance.

## Known gaps

- No speculative decoding or multi-token prediction, which would lower TPOT and so GPU counts.
- No CUDA-graph batch padding, preemption or swapping, and no length variance beyond the peak-prompt check.
- Efficiency factors are global, not per kernel or per framework. Calibrate them with a benchmark at your own sequence lengths.
- **FleetScope differs.** FleetScope's decode step adds memory and compute time rather than taking the larger of the two. At large batches on single-GPU instances it can show TPOT up to about 1.5× higher than this tool. When the two disagree, trust measured telemetry, and use FleetScope's calibration to bring both in line.
