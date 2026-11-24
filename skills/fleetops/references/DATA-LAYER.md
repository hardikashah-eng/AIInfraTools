# Data layer reference

## Store layout

```
<store>/
  device/2017-11-08.jsonl
  device/2017-11-09.jsonl
  job/2017-11-08.jsonl
  change/2026-11-20.jsonl
  …
```

- One JSON object per line.
- Every record has `t` (epoch seconds, UTC) and `source`.
- A record is filed under the UTC day of its `t`.
- `fleetops data query KIND --from T --to T` returns records with `from < t <= to`.

Imports pass `dedupe`: a line identical to one already in that day's file is not written again.

## Record kinds

### `device`

The sample gpu-health reads. See `gpu-health/src/ingest.mjs` for every field.

| Field | Meaning |
|---|---|
| `node`, `gpu` | node name; device index on the node |
| `vendor`, `kind`, `sku` | `nvidia` / `amd` / `sambanova` / `tpu`; `gpu` / `rdu` / `tpu`; model name |
| `tensor`, `sm`, `dram` | tensor-pipe, SM and HBM-bandwidth activity, 0–1 |
| `memUsedGB`, `memTotalGB`, `tempC`, `memTempC`, `powerW`, `throttle`, `powerBrake` | as gpu-health |
| `eccSbeTotal`, `eccDbeTotal`, `remap*`, `pcie*`, `linkErrTotal`, `linkUeTotal`, `faultCountTotal` | counters |
| `faults` | fault codes seen in the interval (`xid79`, …) |
| `utilSource` | `nvidia-smi` when `tensor` is really nvidia-smi utilization (Philly): an upper bound |
| `offlineMinutes` | minutes in the step with no reading (Philly `NA`) |

### `inventory`

`{ node, vendor, kind, sku, devices, deviceMemGB?, site?, state? }`. One record per node per import.

### `placement`

`{ job, class?, owner?, namespace?, start, end?, devices: [{ node, gpu }] }`.
- Kubernetes pods give `node` and `gpuCount` instead of `devices`, because the device index isn't in the pod spec. When dcgm-exporter's pod labels are scraped, the device samples carry the job.
- Philly gives one record per scheduling attempt (`job#2`, …).

### `job`

`{ job, status, cause, start?, end?, devices?, nodes?, gpus?, lostGpuHours? }`.

| Field | Values |
|---|---|
| `status` | `ok`, `failed`, `killed`, `cancelled`, `timeout`, `retried` (an attempt that was rescheduled) |
| `cause` | `device`, `app`, `infra`, `unknown` |

Slurm maps the cause from `State`: `NODE_FAIL` → infra, `OUT_OF_MEMORY` → app, and so on. Philly and AcmeTrace don't record a cause, so it is `unknown`, except AcmeTrace `NODE_FAIL`, which is `infra`.

### `serving`

`{ pool, model?, gpu?, windowS, rate, islMean, oslMean, ttftP50, ttftP99, tpotP50, tpotP99, kvUsage?, running?, queued?, preemptions? }`.

Seconds throughout. There are two ways to get these records:
- From vLLM `/metrics`: two snapshots, or one plus `--window`.
- From Prometheus `query_range`: one field per import, for example:
  - `--field ttftP99` with `histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))`;
  - `--field kvUsage` with `vllm:gpu_cache_usage_perc`.

### `request`

`{ pool?, isl, osl, cached?, ttft?, e2e? }`. The rows FleetScope's Trace replay node reads.

### `change`

`{ kind, target, summary, from?, to?, by?, id?, files? }`.
- `kind` is one of `deploy`, `driver`, `firmware`, `config`, `scale`, `model`, `policy`, `hardware` or `other`.
- `target` is what changed: a pool, a node, a path in a GitOps repo.
- From `git log`, the kind is guessed from the commit subject and file names, and the target is the deepest folder the commit touched. Send JSON lines to set them exactly.

### `health`

gpu-health state changes: `{ key, node, gpu, from, to, why, faultClass }`.

### `benchmark`

A measured run at a known load: `{ system, gpu, gpus, model, scenario, qps, samplesPerS, tokPerS, oslMean, islMean?, ttftP50, ttftP99, tpotP50, tpotP99, ttftLimit?, tpotLimit?, valid }`.

## Exports

| Command | Writes | For |
|---|---|---|
| `data export gpu-health --out DIR` | `samples.jsonl`, `jobs.json`, `results.jsonl` | `gpu-health analyze --samples … --jobs … --results …` |
| `data export fleetscope-trace --out FILE [--pool P]` | CSV `timestamp,input_tokens,output_tokens` | FleetScope's Trace replay node, `fleetscope.mjs` |

Some data is dropped on export:
- **Jobs:** when two placements overlap on one GPU, the later one wins, because gpu-health joins one job per GPU.
- **Retries:** `retried` attempts are not exported as job ends.
