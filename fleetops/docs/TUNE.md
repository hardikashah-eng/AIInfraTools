# Sending real traces, and tuning from them

fleetops takes your cluster's traces, says what to change and how much each change should give back, and afterwards
measures whether it did.

```bash
tools/collect.sh --k8s --vllm http://chat:8000/metrics --step-log /logs/train/steps.jsonl   # on a node: one bundle
fleetops data import bundle fleetops-bundle-gpu-a17-….tar.gz        # or: fleetops send BUNDLE --to http://fleetops:9400
fleetops tune --days 7 --pools pools.json --targets targets.json    # ranked recommendations
fleetops tune apply checkpoint:pretrain-70b --by ana                # when you make the change
fleetops tune verify                                                # a week later: did it work?
```

## 1. Getting traces in

| Way | When | How |
|---|---|---|
| **Bundle** | a first look, a one-off, a cluster fleetops can't reach | `tools/collect.sh` on a node (or a jump host), then `fleetops data import bundle` or `fleetops send … --to URL` (`POST /v1/bundle`, ingest token) |
| **Files** | traces you already have | `fleetops data import auto FILE…` recognizes each file by its content; `data import SOURCE FILE` names it |
| **Pull** | Prometheus and Loki already hold it | `fleetops pull --from … --to … --prom URL --loki URL` |
| **Stream** | continuous | Prometheus `remote_write` and OpenTelemetry `otlphttp` into `fleetops serve` ([SERVICE.md](SERVICE.md)) |

**`tools/collect.sh`** is read-only and skips what isn't installed. It collects:
- **per node:** `nvidia-smi -q` and `topo -m`, the kernel log since `--since`, and the DCGM exporter scrape;
- **with `--k8s`:** nodes, pods and events;
- **with `--slurm`:** `sacct` and `scontrol show node`;
- **with `--helm REL:NS`:** Helm history;
- **with `--vllm URL`:** two scrapes a minute apart, so rates can be computed;
- **files you name:** `--step-log`, `--kineto`, `--app-log`, `--requests`, `--sdc-checks`, `--nccl-inspector DIR`.

It writes `manifest.json` (each file's source and options) and a `.tar.gz`.

**Privacy:**
- request logs are reduced to token counts and latencies on import, never prompts;
- kernel and application logs go in as they are, so read them before a bundle leaves your organization.

**Bundle import:**
- each file is imported by its manifest entry, or recognized by content;
- one bad file doesn't stop the rest, and each file's result is reported;
- paths can't leave the bundle, there is a per-file size limit, and nested archives aren't opened.

What each data source unlocks:

| Data | Recommendations |
|---|---|
| step logs (`step-log`, Kineto) with placements and job outcomes | checkpoint interval, input pipeline, slow node or period, restarts, exposed communication |
| vLLM metrics or request logs, with `--pools` | KV cache, pool size, autoscaling |
| job outcomes with placements (sacct, Kubernetes, Philly) | flaky nodes |
| device telemetry (DCGM, AMD) | GPUs held idle, oversized jobs |

`fleetops tune` lists what's missing at the end of its report.

## 2. Recommendations

Each recommendation names:
- **evidence:** the numbers from your traces;
- **the change:** knobs, from → to;
- **the expected effect:** GPU-hours a week, or a latency;
- **the basis for that number,** one of:
  - **measured:** a contrast in your data, such as TTFT when the KV cache was full against when it wasn't, or every
    restart as fast as your fastest;
  - **model:** a model fed with your measurements: Young/Daly for checkpoint intervals, the Inference Sizer for pools
    (calibrated if `fleetops calibrate` has run, otherwise spec-sheet numbers, and it says which);
  - **upper bound:** all the time lost to the cause, such as every second spent waiting on data.

| Area | Recommendation | From |
|---|---|---|
| Training | checkpoint more or less often | save cost, measured interruption rate × the job's GPUs ([GOODPUT.md](GOODPUT.md)) |
| | feed the job faster (loader workers, prefetch, data placement) | the waiting-on-data share |
| | take a node out, or find what slowed a period | per-node step times when ranks log, or days slower than the job's best |
| | restart faster (warm spares, local or peer checkpoint load, pre-pulled images) | each restart against the fastest |
| | hide communication (bucket sizes, prefetch, NCCL settings) | step `commS`; NCCL bus bandwidth spread |
| Inference | more KV cache (FP8 KV, memory utilization, max sequences, or a replica) | TTFT p99 in full-cache windows against the rest |
| | shrink or grow a pool | measured load (p99 of 5-minute windows) and token sizes → Inference Sizer |
| | autoscale between a floor and a ceiling | GPUs the load needs window by window, against a pool sized for p99 |
| Fleet | drain and test flaky nodes | failed attempts per node against its share of GPU-hours |
| | release GPUs held idle; right-size | gpu-health utilization |

`pools.json` gives each serving pool's model, GPU and current size:
`{ "chat": { "model": "llama33-70b", "gpu": "H100", "gpus": 32 } }`. `fleetops tune models` lists the ids.

## 3. Did it work?

- **Record the change:** `fleetops tune apply ID --by NAME [--at T]` records the change as a change record, which
  root-cause analysis also sees.
- **Measure it:** `fleetops tune verify` compares the recommendation's own metric:
  - **windows:** the same length before the change and after it settles (7 days each, `--before`, `--after`);
  - **samples:** per day for training shares and the interruption rate, per hour for latency;
  - **output:** the difference, a bootstrap 95% interval, the measured change next to the predicted one, and a
    verdict: improved, worse, no clear effect, held (for a smaller pool whose latency must not get worse), or not
    enough data.
- **Before changing anything:** `fleetops tune holdout --from … --split … --to …` makes the recommendations on the
  first part of a window and checks on the rest that each problem is still there. A recommendation whose evidence
  disappears in the next days was chasing noise.

## Results

**Microsoft Philly, 8–14 November 2017** (real job traces; attempts, nodes and GPU utilization, no step logs):

| | Found | Out of sample (recommend on 8–11.5 Nov, check 11.5–15 Nov) |
|---|---|---|
| Flaky nodes | 10 nodes share in 10% of the week's 14,281 failed attempts with 1.4% of the GPU-hours. One node fails 33× its expected rate. | **Held.** The 10 nodes flagged on the first half had 231 failed attempts in the second against 66 expected (3.5×). Their share of failures fell from 13% to 3.9%, so the first-half estimate overstated the saving (selection on a noisy week). |
| Idle allocations | 17 jobs held GPUs with no kernels: about 1,950 GPU-hours a week | **Faded.** 10 of the 29 jobs flagged on the first half were still idle in the second. Idle allocations come and go, so an idle-timeout policy fits better than notices per job. |

The flaky-node saving is an upper bound: Philly's outcomes don't say whether the node or the job's code failed, and a
failed attempt counts whole.

**Azure LLM inference traces, 16 November 2023** (one hour of real conversation and code requests: arrivals and
token counts, no latencies). With `--pools` set to Llama 3.3 70B on H100 and targets of TTFT 2 s and TPOT 50 ms:
- **conversation** (7.3 req/s at p99, 1,020 input / 129 output tokens) needs one 8-GPU node;
- **code** (3.4 req/s at p99, 1,469 / 13 tokens) also needs one node.

This is the Inference Sizer on spec-sheet numbers, so it says so and rates its confidence low. An hour has no daily
cycle, so there's no autoscaling recommendation; a day of the same trace would show one.

**Synthetic, with a known answer** (`fleetops demo --training --days 14 --tuned-at 7`): three jobs with planted
problems. On day 7 the two top recommendations are applied, a faster input pipeline and checkpoints every 40 minutes
instead of every 3 hours. `tune verify` a week later:

| Recommendation | Before → after | 95% interval of the difference | Predicted |
|---|---|---|---|
| data pipeline (sft-8b) | 32% → 9% of GPU-hours waiting on data | −24 to −22 points | −100% (upper bound); measured −73% |
| checkpoint interval (pretrain-70b) | 31% → 16% lost to failures, saves and restarts | −22 to −6 points | −51% (Young/Daly); measured −48% |

The Young/Daly prediction matched the measured change within 3 points, in a world built to follow its assumptions. On
a real fleet, `tune verify` is what tells you.

## Limits

- **Recommendations are only as complete as the data sent.** The report lists what's missing.
- **Sizing without calibration uses spec-sheet efficiencies.** Run `fleetops calibrate` on benchmarks or serving
  records first. Before shrinking a production pool, replay a window in FleetScope.
- **Before/after is not an experiment.** A change made the same week as a traffic shift or a driver rollout is
  confounded. The verdict gives the interval, and `fleetops tune list` and the change records show what else
  happened. Change one thing at a time where you can.
- **The collector covers one node, or the cluster through kubectl and Slurm.** For many nodes, run it per node and
  send each bundle, or stream instead.
