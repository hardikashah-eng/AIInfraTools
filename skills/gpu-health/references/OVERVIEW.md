# gpu-health

Finds unhealthy and wasted GPUs, suggests what to do about each one, and runs the fix once it's approved.

It reads the accelerator telemetry you already collect (NVIDIA dcgm-exporter, AMD device-metrics-exporter, SambaNova's hardware-monitoring exporter, Cloud TPU metrics from libtpu, or normalized JSON lines) and answers four questions. Fleets can mix vendors: see [VENDORS.md](VENDORS.md).

1. **Is this GPU healthy enough for the next job?** Each GPU has a lifecycle state, and only `serving` GPUs take new work. Missing data counts as unhealthy (fail-closed).
2. **Is the allocation used?** It compares what each job was given with what it used (compute, memory bandwidth, and peak memory) and works out the savings in $/week.
3. **Which GPU fails next?** It ranks GPUs by risk, so the riskiest get a deep diag first and are kept off large synchronous jobs.
4. **Is free capacity usable?** It finds free GPUs that waiting jobs can't use, and the smallest partition layout for small workloads.

Every finding becomes an **action** in a queue. Your policy decides whether an action runs automatically, waits for a person to approve it, or is shown only as a suggestion. Approved actions run as fixed commands (no shell). They are dry-run by default, and every step is written to an audit log.

No dependencies: Node 20+.

## Try it

```bash
cd gpu-health
node tools/gpu-health.mjs demo            # 32-GPU demo fleet with planted problems → gpu-health-demo/report.html
node tools/gpu-health.mjs demo --mixed --out mixed-demo   # AMD + SambaNova + Cloud TPU fleet, one planted fault each
node tools/gpu-health.mjs actions list --state gpu-health-demo/state
node tools/gpu-health.mjs actions approve scale-in:embed-svc --by you --state gpu-health-demo/state
node tools/gpu-health.mjs actions execute --state gpu-health-demo/state     # dry-run: prints the kubectl it would run
```

The demo finds the following problems:

- An XID 79 GPU, which it quarantines, and a GPU behind two silent-data-corruption events in the training job.
- Five suspect GPUs:
  - corrected ECC errors rising;
  - PCIe running at x8 of x16;
  - HBM running 14°C hotter than its node-mates, with power-brake slowdowns;
  - a GPU whose telemetry is thinning while the rest of its node reports normally;
  - a thermally throttled GPU that is also the straggler slowing a 16-GPU training job by 26%.

  For the training job it proposes swapping those nodes at the next checkpoint; for inference, draining the replica.
- An embedding service on 4 GPUs that fits on 1.
- A notebook that has been idle for hours.
- An ETL job starved on CPU/I-O. More GPUs won't help it.
- Two small services that fit together on one partitioned GPU.
- 4 free GPUs that a waiting 4-GPU job can't use because they are spread across two nodes.

It does **not** flag the memory-bound chat decode job: low tensor activity with high HBM bandwidth is normal there.

## How it judges

**Effective utilization = max(tensor-active, HBM-bandwidth-active)**

Every workload is limited by compute or by memory bandwidth, so the larger of the two shows how much of the binding resource is used. A ratio of the two misleads: healthy decode has a low tensor:HBM ratio, and when both are near zero the ratio is noise. The ratio is still useful to explain *why* use is low:

| Pattern | Verdict | Lever |
|---|---|---|
| tensor and HBM < 5–10% for 10+ min | idle | reclaim (never automatic for training) |
| low use, high CPU/I-O wait | starved | fix the input pipeline. Fewer GPUs is the wrong fix |
| tensor ≥ 30% | compute-bound | none |
| HBM bandwidth ≥ 50% | memory-bound | none. Not moved to partitions, because a slice gets a slice of the bandwidth too |
| SM busy, tensor < 10% | busy on non-tensor work | check precision and kernels |
| effective < 20% | underused | right-size: fewer GPUs, a partition, or a larger batch for training |

The **memory delta** uses the framework's own peak when you export it (`torch.cuda.max_memory_allocated`, vLLM KV-cache usage). Otherwise it uses driver-reported memory, which is only an upper bound because frameworks reserve memory up front. The report marks which one it used, and confidence drops when only the driver figure is available.

**Stragglers** are detected from per-rank step timings (`steps.jsonl`) by comparing each rank against its job median using MAD. Without timings, a fallback uses the utilization signature of synchronous jobs: most ranks show low SM while they wait, and one rank shows high SM.

**Health lifecycle:**

```
serving ─soft signal─▶ suspect ─diag fail─▶ quarantined ─▶ remediate (ladder) ─diag pass─▶ burnin ─pass─▶ ready ─release approved─▶ serving
   └────────── hard fault / no data ────────▶ quarantined          second failure within 30 days of a fix ─▶ rma
```

- **Hard faults** quarantine a GPU at once. These are uncorrectable ECC, failed row remap, uncorrectable NVLink/XGMI errors, XID 48/64/74/79/94/95/119/120/145, GPU lost, and repeated or replay-confirmed silent data corruption.
- **Soft signals** make a GPU suspect. See [Early warning](#early-warning) below.
- A suspect GPU finishes its current job, then gets a deep diag before anything else.
- If more than 20% of the fleet goes silent at once, the tool blames monitoring rather than the GPUs: states are held and one exporter check is raised (circuit breaker).

### Early warning

Many GPU failures leave a trend you can catch hours ahead. Others (firmware crashes, a GPU dropping off the bus, silent wrong results) give little or no warning, so they are detected fast instead. Each signal below makes a GPU suspect: it finishes its current job, and its work is moved off before it fails.

| Signal | Usually comes before | Source |
|---|---|---|
| HBM temperature above peers, or rising against its own earlier days at the same power | HBM faults, cooling problems | `memTempC` |
| Power-brake slowdowns, thermal throttling, GPU temperature above peers | power-delivery and cooling faults | `powerBrake`, `throttle`, `tempC` |
| Corrected-ECC rate, pending row remaps (failed remap is a hard fault) | uncorrectable memory errors | ECC and remap counters |
| PCIe below max width/speed under load; NVLink/XGMI correctable-error rate | link failures, fall-off-bus | PCIe and link counters |
| Telemetry thinning on one GPU while its node-mates report normally | detachment (XID 79), which often has no numeric warning | sample gaps, metrics that stop reporting |
| Silent-data-corruption events from the training loop | a GPU that computes wrong results | `results` with `kind: "sdc"` |
| Micro-benchmark below 92% of its cohort | slow silicon, stragglers | probes |

Three rules keep false alarms down:

- **Peers:** a GPU is compared with the other GPUs on the same node running the same job (same load, same cooling). When there are fewer than two of those, it is compared with same-SKU GPUs at similar power.
- **Persistence:** windowed signals must fire in 3 of the last 4 hourly windows.
- **Cooldown:** a signal that cleared stays quiet for 2 hours, so a GPU doesn't flap between serving and suspect.

When a whole node's telemetry thins, the GPUs aren't blamed: one exporter check is raised for the node.

**SDC events:**
- **Reporting:** the training loop reports them, either from a non-finite gradient check, or from a loss or gradient-norm spike that disappears when the step is recomputed. Send `{ t, kind: "sdc", job, rank, type: nan|loss-spike|grad-spike|replay-mismatch }`, or use `node` and `gpu` instead of `job` and `rank`.
- **Thresholds:** one event in 7 days makes the GPU suspect. Two events, or one `replay-mismatch` (the step gave a different result on another GPU), quarantine it.

**Moving work off a GPU:**
- **Training:** `swap-at-checkpoint` labels the node so your launcher or elastic agent checkpoints and restarts without it. The job never crashes on the GPU.
- **Inference:** `drain-inference` flips the replica's `gpu-health.aiinfra/serving` label so the Service stops sending it new requests while in-flight ones finish. Select on that label in your Service, and set it to `"true"` in the pod template. The reason text warns when the replica is the only one.

**Risk** is a rules-first score that combines the signals above with spare rows used and past quarantines. Exact failure times are hard to predict, but a ranking is useful. Once quarantine outcomes accumulate, swap in a learned ranker with the same interface (`src/risk.mjs`). The plan for calibrated failure probabilities, risk tiers that keep critical jobs on low-risk GPUs, and a test suite that finds weak GPUs is in [RISK-PREDICTION.md](RISK-PREDICTION.md).

## Actions and approval

| Mode | Meaning | Defaults |
|---|---|---|
| `auto` | approved by policy at once | quarantine, notify owner, run diag, deep diag at next job boundary, exporter check |
| `approve` | waits for a person | GPU reset, node reboot, RMA, release to service, reclaim idle, scale in, resize, swap at checkpoint, drain inference replica, repartition |
| `never` | suggestion only | reclaim idle *training* jobs |

Overrides are per action and per workload class (`training`, `inference`, `interactive`, `batch`). See [docs/CONFIG.md](CONFIG.md).

Safety rails:

- **Two locks for real execution.** Commands run only with `--live` *and* `policy.dryRun: false` in the config. Otherwise you see the exact commands that would run.
- **No shell.** Executors are argv templates. Every value filled in (node, GPU, job, namespace…) must match a strict pattern, so `n1; rm -rf /` or `--kubeconfig=…` is refused.
- **Blast radius.** At most max(2, 10% of the fleet) quarantines and 1 node reboot per run.
- **Freshness.** Disruptive actions (reset, reboot, scale-in, reclaim…) refuse to run if the analysis behind them is more than 1 hour old. Re-run `analyze`.
- **Idempotent queue.**
  - Re-running the analysis updates actions instead of duplicating them.
  - Fixes already applied for the current fault are not proposed again.
  - Rejected actions stay quiet for 7 days.
  - Proposals that the latest analysis no longer supports become `superseded`.
- **Audit log.** `STATE/audit.jsonl` records who proposed, approved, rejected and ran what, with the commands and their output.

### Approval page

```bash
export GPU_HEALTH_TOKENS="alice:$(openssl rand -hex 16),bob:$(openssl rand -hex 16)"
node tools/gpu-health.mjs serve --state /var/lib/gpu-health          # http://127.0.0.1:8787/
```

The page lists open actions with Approve, Reject and Dry-run/Execute buttons.

- With per-person tokens, the approver recorded is the token's owner, not a name typed into a form.
- `GPU_HEALTH_TOKEN` (one shared token) also works; the approver then types a name.
- The page binds to localhost by default. Put it behind your SSO proxy before exposing it.
- Real execution from the page also needs `--allow-live`.

## Running it on a real fleet

```bash
# one-off, from files
node tools/gpu-health.mjs analyze --samples samples.jsonl --jobs jobs.json --steps steps.jsonl \
     --probes probes.jsonl --results results.jsonl --cluster cluster.json --config my.json --state /var/lib/gpu-health

# continuously, scraping exporters every minute and running auto-approved actions
node tools/gpu-health.mjs watch --scrape http://n1:9400/metrics,http://n2:9400/metrics --jobs jobs.json \
     --config my.json --state /var/lib/gpu-health --execute --live

# weekly report (cron), and receipts for owners
node tools/gpu-health.mjs report --format html --out weekly.html --state /var/lib/gpu-health
node tools/gpu-health.mjs receipt embed-svc --state /var/lib/gpu-health
```

Every command takes `--json` and prints one JSON object, for scripts and LLM agents. The [gpu-health skill](../skills/gpu-health/SKILL.md) packages it for models, including the rule that a model never approves or runs an action live on its own.

### Inputs

| File | Contents | Needed for |
|---|---|---|
| `--samples` JSONL / `--prom` exporter text | per-GPU telemetry, see `src/ingest.mjs` for the fields | everything |
| `--jobs` JSON | `[{ id, class, owner, namespace, start, end?, gpusPerReplica?, gpus: [{node, gpu}] }]`, from your scheduler | efficiency, savings, owner notices |
| `--steps` JSONL | `{ job, rank, step, t, computeMs }`, from a training-loop hook | straggler detection (best) |
| `--probes` JSONL | `{ t, node, gpu, sku, firmware, site, gemmTflops, hbmGBs, linkGBs? }`, from a short benchmark between jobs | speed index |
| `--results` JSONL | `{ t, node, gpu, kind: diag\|burnin\|release, pass, level?, detail? }`, written by your diag jobs; `{ t, kind: sdc, job, rank, type }` from the training loop; `{ t, kind: fault, node, gpu, code }` for faults from logs or a vendor's fault manager | moving GPUs through repair; SDC; faults outside metrics |
| `--cluster` JSON | `{ nodes: [{ node, gpus: [{ gpu, alloc }] }], pending: [{ job, gpus? , fraction? }] }` | fragmentation |

Metric names for each vendor's exporter are in its profile in `src/vendors.mjs`. Check them against the exporter versions you run, and override any of them under `ingest.mappings` (or the whole profile under `vendors`; see [VENDORS.md](VENDORS.md)). AMD's default metrics expose no separate matrix-core counter, so GFX activity stands in for tensor activity. On MI300-series and later, ROCm's XGMI health field isn't evaluated, so link faults are read from the XGMI_WAFL RAS counters instead. On NVIDIA, power brake and throttling are decoded from the clock-event-reason bitmask.

### Commands the executors run

The defaults target Kubernetes (`kubectl label/taint/drain/scale`), `ssh` for device resets (`nvidia-smi -r` on NVIDIA, `amd-smi reset --gpureset` on AMD) and reboots, a diag Job image you supply, and a webhook (Lark/Feishu or Slack) for owner notices, RMA tickets and other steps that need a person. On SambaNova and Cloud TPU, steps that only the vendor's tools or the provider can do are posted as a webhook saying what to do. Replace any of them for Slurm (`scontrol update nodename=… state=drain reason=…`), AGFHC or your own tooling in the config. The process needs RBAC to label, taint and drain nodes and to scale deployments; [deploy/rbac.yaml](deploy/rbac.yaml) is a starting point.

## Files

```
src/vendors.mjs        vendor profiles: metric maps, fault codes, executors, unsupported actions, coverage
src/ingest.mjs         exporter text and JSONL → normalized samples
src/health.mjs         lifecycle state machine, signals, circuit breaker, strike rule
src/efficiency.mjs     effective utilization, verdicts, stragglers, speed index
src/savings.mjs        memory delta, right-sizing, levers, $/week, confidence
src/risk.mjs           failure-risk ranking
src/fragmentation.mjs  stranded capacity, partition packing
src/actions.mjs        suggestions, policy modes, queue, audit, guarded execution
src/executors.mjs      argv templates, validation, dry-run, webhook
src/report.mjs         Markdown / HTML report, job receipts
src/server.mjs         approval page and API
src/synth.mjs          demo fleet
tools/gpu-health.mjs   CLI
tools/tpu-collect.py   Cloud TPU collector: libtpu metrics → JSONL samples
```
