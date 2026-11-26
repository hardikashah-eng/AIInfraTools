# Shadow upgrades on real engines

The statistics behind `fleetops shadow` are tested on synthetic data and mock endpoints. This kit runs the whole thing
on real vLLM engines, so the judge's verdicts can be checked against a change whose effect is known. **It has not been
run yet**; the first run's results belong in [docs/RESULTS.md](../../../docs/RESULTS.md).

## What you need

- A Kubernetes cluster with **three 1-GPU NVIDIA L4 nodes** labelled `nvidia.com/gpu.product=NVIDIA-L4` (GPU Feature
  Discovery sets this; the NVIDIA GPU Operator installs it). On a public cloud that is about $1–2 an hour on spot.
- `kubectl` pointed at it, Node 22, and this repository.
- Nothing secret: the model (Qwen2.5-1.5B-Instruct, Apache-2.0) is not gated, and the workload comes from TraceLab
  (CC BY 4.0), fetched at a pinned release.

## What it does

| Step | What runs | What the judge should say |
| --- | --- | --- |
| Deploy | `kit.yaml`: `chat-v1` (vLLM v0.32.0, prefix caching on, 2 replicas), `chat-v2` (the same with `--no-enable-prefix-caching`, 1 replica), Prometheus labelling each version `llm_isvc_name` | — |
| A. Paired replay | One replica of each. `shadow answers`, then `shadow replay` of agent sessions (prompts up to 12k tokens, sessions sharing growing prefixes) to both at the same moments, then `shadow compare` | TTFT clearly **worse** (no prefix reuse); answers the same or nearly (prefix caching shouldn't change greedy tokens) → **roll back** |
| B. Canary from Prometheus | Two baseline replicas and the candidate behind one Service (a canary at a third of the traffic). `vllm bench serve` in the cluster at 2 and 6 req/s, every prompt sharing a 1,500-token prefix. Then `shadow prom` on the per-version metrics | TTFT **worse** at matched load → **roll back** |
| The judge | `shadow serve` against the same Prometheus, called the way an Argo Rollouts AnalysisTemplate calls it | `{"verdict":"rollback",…}` |

```bash
deploy/shadow-live/run.sh          # deploy and print the dry runs: nothing is sent
deploy/shadow-live/run.sh --yes    # send the traffic; the namespace is deleted at the end (--keep to leave it)
```

Results land in `deploy/shadow-live/out/`: `paired-verdict.txt`, `canary-verdict.txt`, `judge.json`, and
`canary-series.json` (the Prometheus series, to rerun with `fleetops shadow prom --file`).

For an engine upgrade instead of a known change, set `chat-v2`'s image to the new vLLM version and drop
`--no-enable-prefix-caching`; there the verdict is what you want to learn.
