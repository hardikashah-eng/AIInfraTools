# What the tools get right, and how we know

Every model in this repository makes a claim: a sizer says how many GPUs, a power model says how much slower, a
rollout check says whether a version is worse. This page lists each claim that has been checked against **real data**
(public traces, published measurements, real tool output), what the check found, and what it changed. It also says
what is still checked only on synthetic data, and what nothing here has checked yet.

The tests named below run in CI on every pull request. Sources and licenses for the data are in
[fleetops/tests/fixtures/real/README.md](../fleetops/tests/fixtures/real/README.md) and
[ROADMAP.md](../ROADMAP.md#public-data-used-for-validation).

## Checked on real data

| Claim | Data | Result | Changed because of it | Where |
| --- | --- | --- | --- | --- |
| A staged rollout halts only when the new version really fails more | One week of the Philly cluster (29,230 placements, 238 machines), 100 random splits with nothing changed, and splits with failures added | **17 false alarms in 100** with a plain Poisson test; **1 in 100** after the fix. A tripled failure rate on a 10% canary is caught in most splits, a doubled one in about half | Failures cluster on flaky machines and multi-node jobs (dispersion above 2 in every split): the test is now widened by the between-node dispersion | [ADMISSION.md](../fleetops/docs/ADMISSION.md#validation-on-real-data), `admission-real.test.mjs` |
| Capping GPU power slows work by about (draw / cap)^α | Zeus power-limit sweeps: 1,609 training runs, 6 workloads, A40, V100, P100 and RTX 6000 | From 60% to 100% of the limit: median error −0.4 to −1.7 points per GPU type, p10–p90 within about −6 to +4 points (857 capped runs). **Below 60% the model is more than 2× too low** (clocks reach their floor) | `predict` flags caps under 60%; the planner never goes below it | [POWER.md](../fleetops/docs/POWER.md#validation-on-real-data), `power-real.test.mjs` |
| The sizer predicts the speed and throughput of a given layout | InferenceX: 198 measured runs of DeepSeek-R1 on B200, B300, H200, MI300X, MI325X and MI355X (TRT-LLM, SGLang, ATOM; 1k/1k, 8k/1k, 1k/8k; concurrency 4–256) | Datasheet roofline: off by **2.4×** (median). Sizer defaults: off by **46%** for TPOT and **47%** for output tokens/s per GPU, **optimistic** (about 1.4× the measured throughput on NVIDIA and MI355X, 2× on MI300X and MI325X), worst at low concurrency. Calibrated per GPU on the 1k/1k runs and scored on the other shapes: **17% / 18%** overall; 6–16% on NVIDIA, 11–38% on AMD | Added `operatingPoint` to the sizer model. AMD fits need implausible compute efficiency (2% of peak), and MI355X stays at 35–38% after calibration, so the AMD error is the model's shape, not its settings | [VALIDATION-INFERENCEX.md](../inference-sizer/docs/VALIDATION-INFERENCEX.md), `inferencex.test.mjs` |
| The sizer's GPU count matches what a real system needed | MLPerf Inference v5.0, Llama 2 70B Server on 8× H100, H200, B200 | Spec-sheet defaults ask for **2× the GPUs** (16 for 8). Calibrated: 8 for 8 on H100 and H200, 9 on B200. Held-out low-latency runs: calibrated **under**-provisions by 37% | Calibration profiles per latency regime; defaults kept conservative on purpose | [CALIBRATION.md](../fleetops/docs/CALIBRATION.md#results-on-mlperf-inference-v50-llama-2-70b-8-gpus-server-scenario) |
| Flaky nodes found in one half-week stay flaky | Philly, 8–14 Nov 2017, 14,281 failed attempts | **Held out of sample:** the 10 nodes flagged on the first half had 231 failures in the second against 66 expected (3.5×) | The saving estimate is reported as an upper bound (selection on a noisy week) | [TUNE.md](../fleetops/docs/TUNE.md) |
| Idle allocations found once can be acted on per job | Same week | **Faded:** 10 of 29 flagged jobs were still idle in the second half | Recommends an idle-timeout policy, not per-job notices | [TUNE.md](../fleetops/docs/TUNE.md) |
| Failure spikes are detected early and pinned on an owner | Same week | Six spikes, 15–75× the hourly median; CUSUM alarms **20–70 minutes after onset**; one namespace owns 92–98% of each | — | [RCA.md](../fleetops/docs/RCA.md), [BENCHMARK.md](../fleetops/docs/BENCHMARK.md) |
| Where the GPU-hours went | Philly week, real utilization | Of 314,261 allocated GPU-hours: **70% useful, 25% idle, 4% lost** to failures. In the goodput view of the same week, one team lost 48% of its training GPU-hours to failed attempts | — | [gpu-ledger](../gpu-ledger/README.md), [GOODPUT.md](../fleetops/docs/GOODPUT.md) |
| An agentic workload profile stands in for real agent sessions when sizing a fleet | TraceLab: 8,058 Claude Code and Codex sessions, 665k calls. Profile fitted on 70% of sessions, checked on the other 30% on the same arrivals (600 sessions/h, 4 h, 5 seeds) | Cache hit, calls/s, prefill and output tokens/s (mean and p95 minute) within **1–8%** of replaying the held-out sessions; mean prompt **15% low**; KV working set **28% low**. GPUs (Qwen3-Coder-480B on B200): held-out 40, synthetic 48. **Sizing from mean ISL/OSL without cache reuse can't meet a 2 s TTFT at all, and with 10 s asks for 440 GPUs** | Per-stream parameters (turns, growth and prefill per turn as quantiles, pace, compaction point) instead of pooled distributions: pooled heavy tails had put prefill 2.5× too high | [VALIDATION-AGENTIC.md](../fleetscope/docs/VALIDATION-AGENTIC.md), `agentic.test.mjs` |
| Where coding agents waste model work | TraceLab (same data) | **22% of spend avoidable** (relative prices): 76% of it prompt caches expiring during pauses, 18% misses within the cache lifetime, 5% oversized tool output (which is a third of all context re-read). Claude Code's hit rate falls from 98% to 48% once a pause passes 5 minutes | The cache-expired check is backed by the measured hit rate by pause; totals move 1 point between 5-minute and 1-hour cache assumptions | [VALIDATION-TRACELAB.md](../harness-ledger/docs/VALIDATION-TRACELAB.md) |
| Cost per successful task, and whether step caps save money | SWE-bench Verified, mini-SWE-agent 2.x, 11 models × 500 tasks (cost, calls, resolved) | The median run spends **39%** of its budget on tasks it doesn't resolve; a call cap that loses ≤1 point of resolution saves a median **1%**; cost per resolved task differs **10×** among models within 5 points of the best rate | Outcomes report leads with cost per success and spend on failures, and says caps don't help without a better stop signal | [VALIDATION-SWEBENCH.md](../harness-ledger/docs/VALIDATION-SWEBENCH.md) |
| Where self-hosting an open model beats the API for an agent workload | TraceLab's workload (8,058 Claude Code and Codex sessions over 303 days, real arrivals and cache accounting) sized for DeepSeek V3 and Kimi K2 on H200 and B200; task success and calls per task from SWE-bench Verified (DeepSeek V3.2, Kimi K2.5 vs Claude 4.5 Sonnet) | **One team's volume favours the API:** about $5,600 a month at Sonnet-class prices against a two-node floor, so self-hosting pays only below **$0.24–0.48 a GPU-hour**. At $3 a GPU-hour on B200 it wins from **8–16× the volume**. **51% of calls exceed the open models' 128k context** | Busiest-day and typical-day sizing reported side by side (the busiest day had 46× the median day's calls); calls per task scale arrivals, not prompt length | [VALIDATION-ECONOMICS.md](../harness-ledger/docs/VALIDATION-ECONOMICS.md) |
| The store holds production volume | 90M samples at full size, 2 vCPUs | Ingest at 9× the needed rate; root-cause query in 1.22 s (0.62 s with the hourly rollup) | Parquet backend | [ROADMAP.md](../ROADMAP.md) milestone 7 |
| Host port counters are read correctly | Real sysfs InfiniBand counters from mlx4, mlx5 and hfi1 hosts (prometheus/procfs) | Bytes per port equal procfs's own expected values | **Bug:** CNP and ECN counters are RDMA `hw_counters`, not `ethtool -S` names; added the `ib-sysfs` source | [FABRIC-STORAGE.md](../fleetops/docs/FABRIC-STORAGE.md#validation-on-real-data), `fabric-storage-real.test.mjs` |
| NIC counters are named as the driver names them | The mlx5 driver's documented `ethtool -S` counters (Linux docs) | Every counter read exists | Three CNP/ECN names expected from ethtool don't exist there (above) | same |
| NFS latency per export | Real NFSv4 mountstats with a wrapped 64-bit counter | RTT per op from the right field; the wrapped one ignored | — | same |
| Lustre I/O per job | Real Lustre 2.10 OST and MDT `job_stats` | Write ops and bytes per job match the file | **Bugs:** files read from `/proc` had no target (now from the path); `punch` and `sync` were counted as writes. 2.10 keeps no latency | same |
| Disaggregated serving manifests deploy on llm-d | The DisaggregatedSet CRD schema from LWS v1.0.0; llm-d's P/D guide | **No unknown fields** under strict validation (as for llm-d's own manifest); same KV connector, sidecar, ports, probes and labels | — | [SERVING.md](../fleetops/docs/SERVING.md), `llmd-real.test.mjs` |
| The npm package works when installed | The packed tarball installed into an empty project | Every command runs through npm's symlinks | **Bug:** `fleetops` and `gpu-health` did nothing when installed (main-module check compared the symlink); fixed | `tests/package.test.mjs` |

## Checked on synthetic data only

| Claim | How | Result |
| --- | --- | --- |
| Root-cause rules find the planted cause through noise | 220 generated incidents, 22 scenario kinds, 17 rules, 0–2 distractors each | First run **73% top-1**; the misses were real weaknesses in the rules, fixed; now **99.5% top-1**. This measures the rules against our own generator, not accuracy on real incidents |
| Training goodput and checkpoint advice | Demo week with planted badput | Each planted loss found; checkpoint interval from the measured interruption rate |
| Silent data corruption detection | Simulated canary results | Detection logic tested; the canary hasn't run on a GPU |
| Shadow upgrades judge an infra change at matched load | A candidate 8% slower at every load that got less than half the traffic; paired replays against two mock streaming endpoints; a numerics change that is faster but changes greedy outputs | Naive TPOT says **7.5% faster**; matched load finds **+7.8% (+6.5% to +9.3%)** and rolls back. Paired replay measures a 10% regression within 2 points. The numerics change is rolled back on answers |
| A canary judged from its own Prometheus metrics, at matched load | Synthetic per-version windows: canaries identical, 3%, 8% and 12% slower, at half and a quarter of the baseline's load per engine, with a smooth latency curve and one with a knee near saturation; a mock Prometheus answering the exact queries | Per-version means say the canary is **20–33% faster**; matched load lands **within 1 point** of the true effect (identical: within ±0.6%) and rolls back the 8% and 12% canaries. A global latency curve was **4.6% off** at the knee: replaced by local fits |
| gpu-health fault rules | Fixtures in the documented `nvidia-smi`/DCGM formats | No public dataset has XID, ECC or link-error history to test against |

## Not checked yet

- **Anything on a live cluster:** a model deployed and load-tested, a real admission and rollout, a power cap applied
  and its slowdown measured, fault injection through the real collectors. The cheapest setup that covers most of it is
  a Kubernetes cluster of three 1-GPU NVIDIA L4 nodes (about $1–2 an hour on spot), plus two InfiniBand CPU nodes for
  an hour for the fabric counters.
- **Shadow upgrades on live engines:** `fleetops/deploy/shadow-live/run.sh --yes` on three 1-GPU L4 nodes runs paired
  replay, an in-cluster canary judged from Prometheus, and the judge, against two vLLM deployments that differ by one
  known change. The statistics are tested; the end-to-end run isn't.
- **Root-cause accuracy on real incidents:** needs labeled postmortems (`rca bench --from-incidents`).
- **Switch-side fabric counters:** public clouds don't expose their switches.
- **The sizer at low latency:** needs profiles fitted per latency regime.
- **The sizer on agentic traffic (AgentX):** `inference-sizer/tools/validate-agentx.mjs` scores and calibrates the sizer
  on AgentX results (long contexts, ~95% cache hits, measured on GB300, B200, MI355X…). The results and the AgentX
  traces are published on Hugging Face and the InferenceX dashboard, which this project's CI can't reach yet; run it
  on downloaded results. Most AgentX models (DeepSeek V4, GLM 5.x, Kimi K3, MiniMax M3) also need a catalog entry,
  which `--hf-config` adds from the model's config.json.
- **The sizer's defaults point different ways on different data:** pessimistic on MLPerf's Llama 2 70B (twice the
  GPUs needed), optimistic on InferenceX's DeepSeek-R1 (1.44× the throughput). Calibrate to your model, GPU and engine
  before trusting a GPU count; On AMD the calibrated error is still 2–3× NVIDIA's.

If you run any of these, results (even bad ones) are very welcome as an issue or a pull request.
