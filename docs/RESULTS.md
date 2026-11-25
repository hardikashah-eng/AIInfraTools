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
| gpu-health fault rules | Fixtures in the documented `nvidia-smi`/DCGM formats | No public dataset has XID, ECC or link-error history to test against |

## Not checked yet

- **Anything on a live cluster:** a model deployed and load-tested, a real admission and rollout, a power cap applied
  and its slowdown measured, fault injection through the real collectors. The cheapest setup that covers most of it is
  a Kubernetes cluster of three 1-GPU NVIDIA L4 nodes (about $1–2 an hour on spot), plus two InfiniBand CPU nodes for
  an hour for the fabric counters.
- **Root-cause accuracy on real incidents:** needs labeled postmortems (`rca bench --from-incidents`).
- **Switch-side fabric counters:** public clouds don't expose their switches.
- **The sizer at low latency:** needs profiles fitted per latency regime.
- **The sizer's defaults point different ways on different data:** pessimistic on MLPerf's Llama 2 70B (twice the
  GPUs needed), optimistic on InferenceX's DeepSeek-R1 (1.44× the throughput). Calibrate to your model, GPU and engine
  before trusting a GPU count; On AMD the calibrated error is still 2–3× NVIDIA's.

If you run any of these, results (even bad ones) are very welcome as an issue or a pull request.
