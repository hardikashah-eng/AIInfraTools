# Serving: what fits, what it carries, and one-command deployment

Three questions, one sizing model (the Inference Sizer's):

| Question | Command |
|---|---|
| I have this hardware. Which models can I serve, and how much load does each carry? | `fleetops serving fit` |
| I have this model and this hardware. What is the most it carries? | `fleetops serving capacity` |
| Deploy it. | `fleetops serving deploy`, or `install/install-serving.sh` |

All three take the same workload and targets:

- `--isl` / `--osl`: median prompt and output tokens (2000 / 400 by default); `--isl-p99` / `--osl-p99` for the tails;
- `--ttft` / `--tpot`: the latency targets in seconds (2 / 0.05);
- or `--from-pool P`: the token sizes and the p99 5-minute request rate measured from a pool's request records in the
  store (at least 50 requests).

## Which models fit

```
$ fleetops serving fit --gpu H100 --nodes 2 --rate 5
2 node(s) of H100; ISL 2000 / OSL 400 tokens; TTFT ≤ 2s, TPOT ≤ 50ms; needs 5 req/s
ranked by size among the models that carry the load (size is a proxy for capability, not a quality score)

model                params     req/s      edge   out tok/s  $/1M out  layout
✓ qwen3-coder-480b     480B      5.27      19.4       2,109     $5.06  1 × TP8 · EP8
✓ llama4-maverick      400B      24.6      57.7       9,835     $1.08  1 × TP8 · EP8
✓ qwen3-235b           235B      19.3      45.2       7,701     $1.39  1 × TP8 · EP8
✓ mixtral-8x22b        141B      28.2      44.0      11,274     $0.95  3 × TP4 · EP4
✓ gpt-oss-120b       116.8B       227       303      90,830     $0.12  7 × TP2 · EP2
✓ qwen25-72b          72.7B      19.6      26.3       7,855     $1.36  7 × TP2
✓ llama33-70b         70.6B      20.2      27.0       8,097     $1.32  7 × TP2
✓ qwen3-32b           32.8B      48.8      60.7      19,526     $0.55  15 × 1 GPU
✓ llama31-8b          8.03B       209       258      83,540     $0.13  15 × 1 GPU
  kimi-k2             1040B      0.00      0.00           –         –  needs 8 node(s) even at the lowest load
  deepseek-v3          671B      0.00      16.3           –         –  needs 4 node(s) even at the lowest load
  llama31-405b       405.9B      1.75      4.11         700    $15.23  1 × TP8
```

- **req/s (production)** keeps the Inference Sizer's defaults: 15% headroom, an N+1 spare node, and 10% inside the
  latency targets. **edge** drops all three: what the hardware does flat out, with nothing in reserve.
- With `--rate`, the models that carry it come first (✓), largest first. Without it they are ranked by throughput;
  `--rank largest|throughput` chooses. Size is a stand-in for capability, not a quality score: pick between the ✓
  rows on your own evals.
- Each row is a bisection over the request rate (the largest rate whose plan still fits on the hardware), so the
  whole catalog takes well under a second.

## What one model carries

```
$ fleetops serving capacity --model llama33-70b --gpu H100 --nodes 2
Llama 3.3 70B on 16 H100; ISL 2000 / OSL 400; TTFT ≤ 2s, TPOT ≤ 50ms
  max load:        20.2 req/s in production (27.0 at the edge), 8,097 output tokens/s
  users:           ~87,450 daily active users at 20 requests each, if the load were flat (peaks need more)
  concurrency:     224 sequences in flight (7 instance(s) × 32)
  layout:          7 × TP2 (2 GPU(s) each), 2 node(s) with the spare
  longest prompt:  39,513 tokens at light load (model maximum 131,072)
  cost:            $1.32 per million output tokens at that load (catalog price)
```

The longest prompt is the largest input whose prefill still meets the TTFT target and whose KV cache still fits, at
light load. `--gpus N` instead of `--nodes N` sizes part of a node.

## Deploy

```bash
kubectl -n serving create secret generic hf-token --from-literal=token=hf_…    # once; fleetops never reads it
fleetops/install/install-serving.sh --model llama33-70b --gpu H100 --nodes 2 --hf-secret hf-token --cache-pvc models
```

or `fleetops serving deploy … --apply`. Without `--apply` (or with the script's `--dry-run`) nothing is applied: it
prints the plan, the manifests and the cluster checks.

What happens:

1. **Plan.** `--nodes N` / `--gpus N` fills that hardware (the max rate above); `--rate R` sizes for R req/s and
   refuses if the hardware you named can't carry it. The layout becomes vLLM arguments: tensor and pipeline parallel
   size, `--max-num-seqs` (the planned concurrency per instance plus 25%), `--max-model-len` (the context the sizer
   planned memory for), fp8 KV cache, prefix caching, fp8 weights when the plan assumed them.
2. **Render.**
   - An instance that fits on one node is a **Deployment** with one replica per instance.
   - An instance larger than a node is a **LeaderWorkerSet** in vLLM's multi-node recipe: tensor parallel inside a
     node, pipeline parallel across nodes, the leader serving and the workers `--headless`, the group recreated when
     any pod restarts. It needs the LeaderWorkerSet controller (`--install-lws vX.Y.Z` in the script).
   - A **Service** selecting `gpu-health.aiinfra/serving=true`, so gpu-health's and the live agent's drain actions take
     a replica out of rotation by flipping that label.
   - `/dev/shm` in memory, a startup probe that allows 40 minutes for weights to load before liveness starts, Prometheus
     scrape annotations for vLLM's `/metrics`.
   - With `--autoscale`, a **KEDA ScaledObject** on `vllm:num_requests_waiting` (queue depth per replica, not CPU).
3. **Check the cluster:** kubectl context, ready uncordoned nodes with enough allocatable GPUs for every pod (and that
   their GPU product matches the plan), the LeaderWorkerSet and KEDA CRDs when needed, the token Secret, the
   namespace. A failed check stops before anything is applied.
4. **Apply, wait** for the rollout (or the LeaderWorkerSet to be Available), up to `--wait` seconds (2400).
5. **Smoke test** through a port-forward (or `--endpoint URL`): `/v1/models` lists the model and one completion
   returns.
6. **Register** the pool in `<store>/serving/pools.json` and `targets.json`, which `fleetops tune` reads by default:
   its pool-sizing and latency recommendations cover the new pool without `--pools` or `--targets`. The manifest is
   kept beside them; `fleetops serving delete NAME --apply` removes both.

### What it does not do

- **Disaggregated prefill/decode.** When the sizer would choose it, the plan says so and deploys aggregated serving;
  disaggregation needs llm-d or NVIDIA Dynamo.
- **Pick an image version.** The default `vllm/vllm-openai:latest` (`rocm/vllm` on AMD) is a moving tag; pin one with
  `--image` for production.
- **Fetch secrets.** The Hugging Face token comes from a Secret you create.
- **Know your GPUs' real speed until calibrated.** The sizer uses spec-sheet efficiencies; after
  `fleetops calibrate benchmarks` against your own benchmark runs, the numbers are fitted. Treat uncalibrated req/s
  as within ±30%, and confirm with a load test (`vllm bench serve`) against the deployed endpoint before sending
  production traffic.
- **fp4 weights.** A plan assuming fp4 needs a checkpoint published in fp4 (`--hf ORG/NAME`).

## Options

`deploy` takes `--name` (default: the model id), `--namespace` (serving), `--hf ORG/NAME` (another checkpoint),
`--hf-secret`, `--cache-pvc` (a ReadWriteMany claim for the weights), `--image`, `--max-model-len`, `--weights
fp8|bf16`, `--kv-dtype`, `--autoscale` with `--prometheus URL`, `--min-replicas`, `--max-replicas`,
`--create-namespace`, `--out FILE`, `--endpoint URL`, `--wait S`. `fleetops serving models` and `serving gpus` list the
catalog.
