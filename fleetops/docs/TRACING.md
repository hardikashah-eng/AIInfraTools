# Request and rank tracing

Milestone 8 of the [roadmap](../../ROADMAP.md). Pool-level metrics say *that* TTFT rose or a training job slowed.
Per-request spans and per-rank steps say *which* replica, stage, rank or GPU did it.

## Serving: requests from spans

**Getting spans in:**
- Stream them to `fleetops serve` (`POST /v1/traces`, OTLP over HTTP, protobuf or JSON).
- Or import a file: `data import otlp-traces FILE [--derive]`.
- **hybrid-tracing's skew corrector** forwards clock-corrected spans: set its downstream to
  `http://fleetops:9400/v1/traces`. A full queue in fleetops (429) becomes 503 at the corrector, so the collector
  retries. `tests/tracing.test.mjs` runs this end to end.

**From spans to requests.** `data requests` turns the spans of each trace into one `request` record:

| Field | From |
|---|---|
| `stages.router / queue / prefill / decode` | child spans named like the stage (`route`/`gateway`, `queue`/`scheduler`, `prefill`, `decode`/`generate`), or vLLM's OpenTelemetry attributes `gen_ai.latency.time_in_queue`, `time_in_model_prefill`, `time_in_model_decode` |
| `ttft`, `e2e` | `gen_ai.latency.time_to_first_token` / `.e2e`, or router + queue + prefill, and the root span's duration |
| `isl`, `osl` | `gen_ai.usage.input_tokens` / `output_tokens` (or `prompt_tokens` / `completion_tokens`) |
| `pool` | `gen_ai.request.model`, else the root span's service |
| `replica`, `node` | the engine span's `k8s.pod.name`, `replica` or `server.address`, and its host |

The same records feed FleetScope's trace replay (`data export fleetscope-trace`) as before.

## Training: per-rank steps

| Source | Gives |
|---|---|
| `data import kineto TRACE.json` (PyTorch profiler / Kineto Chrome trace, one rank per file) | step time from `ProfilerStep#N`; NCCL time from NCCL kernels inside the step; data-loading and checkpoint time from their annotations; compute = step − NCCL − data. Rank from `distributedInfo`. |
| `data import step-log FILE` | JSON lines a training loop writes: `{ t, rank, node, step, durS, commS?, dataS?, ckptS?, mfu? }` |

## Detection

`rca detect` adds:
- **training-slow:** a job's median step time across ranks, against its own last 100 steps (z-score CUSUM);
- **training-hang:** NCCL / PyTorch watchdog timeouts, grouped by job.

## Rules

| Rule | Finds | Evidence |
|---|---|---|
| straggler | the rank whose compute time is ≥ 1.2× the median and ≥ 3 MADs above it | the others' NCCL time (they wait for it); that GPU's SM clock against its maximum or its peers, and its temperature; hardware log lines on its node |
| collective-hang | the rank that never joined: the only rank without a timeout, else the one behind on the collective sequence number, else the one whose steps stopped first | the timeouts (op, duration); hardware log lines on that rank's node |
| replica-tail | the replica holding far more of the slowest 10% of requests than its traffic share: binomial tail < 1%, ≥ 2× its share, and slower as a whole | its median against the other replicas'; the slowest traces as references (exemplars) |
| slow-stage | the request stage that grew (router, queue, prefill, or decode for TPOT and end-to-end incidents; TTFT incidents only look at the stages before the first token) | each stage's median before and during; whether prompts got longer |

## Done-when, checked

| Check | Result (`tests/tracing.test.mjs`, `rca bench`) |
|---|---|
| A slow GPU injected with `fleetops inject gpu-slow` (clocks locked with `nvidia-smi -lgc`) | straggler ranks first and names the node |
| One serving replica slow | replica-tail ranks first and names the replica |
| Prefill slows on every replica | slow-stage ranks first and names prefill |
| A rank that never joins a collective | collective-hang names the rank's node |
| hybrid-tracing → fleetops | corrected spans land in the store and become requests |

**Benchmark** (16 scenario kinds, 320 incidents per seed): top-1 99.1–100% and top-3 99.7–100% on seeds 1, 2, 3, 5, 7
and 9. The four new kinds score 20/20 on each seed.

## Limits

- **OTLP/gRPC isn't served:** OTLP over HTTP, protobuf or JSON, is.
- **NCCL Inspector** (NCCL's profiler plugin) is read in both its JSON form (`data import nccl-inspector`) and its
  Prometheus form (remote_write or `fleetops pull`). It feeds the **slow-link** rule: one node's NCCL bus bandwidth
  well below the other nodes' for the same operations, while its compute is normal.
- **The straggler rule needs several ranks' steps:** one rank's trace can't show which rank is slow.
- **The training scenarios are synthetic.** `inject gpu-slow` and `inject nccl-stall` on a test cluster make real
  labels for them.
