# Roadmap: from four utilities to one loop

AIInfraTools has four utilities that each answer one question well:
- **FleetScope**: what happens to this fleet if…
- **Inference Sizer**: how many GPUs for these targets.
- **gpu-health**: which GPUs are failing or wasted.
- **Hybrid tracing**: what happened to this request across sites.

The next step is to connect them into one loop:

**Observe → Diagnose → Simulate → Approve → Optimize → Verify**

The loop is built on real measurements, every step can be explained, and nothing changes in production without a person approving it.

The work builds on what already exists. FleetScope already has calibration against vLLM metrics, benchmark results and recorded traces (10% at p50, 20% at p99). It also has a cheapest-graph optimizer, a live twin fed by Prometheus and a CI plan gate. gpu-health already has an approval queue with two locks on real execution, blast-radius limits, freshness checks and an audit log. This roadmap fills the gaps between them.

## Gaps today

| Area | Exists | Missing |
|---|---|---|
| Data | Each tool reads its own inputs: exporter scrapes, traces, `cluster.json`, jobs files | One store every tool reads; inventory discovered from Kubernetes and Slurm; a **change feed** (deploys, driver and firmware upgrades, config); job outcomes with a cause |
| Calibration | One-off fits in FleetScope | Re-fits on a schedule, drift alerts, saved per-workload profiles, Inference Sizer using measured efficiencies |
| Diagnosis | Evidence inside each tool (health signals, risk, flakiness, bottlenecks, clock skew) | Correlating it across tools, and with changes, into ranked and checkable explanations |
| Optimization | Cheapest graph for one fleet graph; one-at-a-time actions in the queue | Comparing many candidate changes, staged rollout, automatic rollback |

## Milestones

### 1. Shared data layer (`fleetops/`)

One directory of JSON-lines files, one folder per record kind, one file per day. The kinds are: device samples, inventory, placements, job outcomes, serving metrics, requests, changes, health events and benchmarks.

Adapters read what systems already emit:
- DCGM, AMD and SambaNova exporters, vLLM `/metrics` and Prometheus range queries;
- `kubectl` and Slurm (`scontrol`, `sacct`);
- a JSON or `git log` change feed;
- gpu-health's own history;
- public traces: Microsoft Philly, Azure LLM inference, MLPerf Inference results and AcmeTrace.

Exporters project the store into each tool's existing inputs, so the tools run unchanged.

**Done when:** gpu-health and FleetScope run on data that came only through the store, including a real public trace.

### 2. Continuous calibration

- A scheduled job re-fits FleetScope pool multipliers from the serving metrics in the store.
- Calibration profiles are kept per pool and workload, with their history.
- A drift record is raised when the latest measurements fall outside the acceptance bar.
- Benchmark records (MLPerf, `benchmark_serving`) fit the Inference Sizer's efficiency factors per GPU and model, and the sizer reads them with `--calibration`.

**Done when:** prediction error is within 10% at p50 and 20% at p99 on held-out measurements, and every profile shows what it was fit on.

### 3. Root-cause analysis, version 1

- **Hypotheses come from rules over the store.** Each one is scored on how strong its evidence is and how close in time. Version 1 rules:
  - KV-cache pressure;
  - hardware degradation on the devices serving the symptom;
  - a regression that follows a change;
  - load above calibrated capacity;
  - a monitoring gap;
  - one device lagging its peers.
- **Every hypothesis cites the records it rests on** and lists the steps to check it.
- **Explanations sit on top of the evidence.** They are written from it and never add evidence of their own.
- **Labeled incidents** measure top-1 and top-3 accuracy.

**Done when:** every diagnosis cites its evidence, and top-3 accuracy is reported on a labeled set.

### 4. Optimization with safe execution

- **Candidates** come from three places: gpu-health's right-sizing and idle-allocation reclaim, FleetScope's optimizer, and retry storms diagnosed by root-cause analysis.
- **Each candidate is scored on the calibrated model** for cost, SLO, risk and constraints. Combinations are re-simulated, because savings don't simply add up.
- **The winner goes to the approval queue** as a staged rollout, with an SLO check after each stage and automatic rollback.
- **Rollback is automatic; applying a change never is.**

**Done when:** a verified reduction in GPU-hours with no increase in SLO violations, measured after the rollout from the store.

## Part 2: production-grade traces and incident analysis

Milestones 1–4 work end to end on public data. A real fleet adds three things they don't handle yet:
- **Volume:** a 10,000-GPU fleet sampled every 10 seconds produces about 86M device samples a day.
- **Signals the store doesn't collect:** logs, topology and versions.
- **Incidents as a workflow:** people need to own them, follow them and close them, not only read a record.

Milestones 5–10 close those gaps, in the order they should be built.

### 5. Signals for diagnosis: logs, topology, versions, change feeds

- **Logs:**
  - kernel and driver logs: NVIDIA XIDs, NVLink, PCIe AER, AMD RAS, machine checks, InfiniBand link state, NFS and Lustre timeouts, host out-of-memory kills;
  - NCCL and PyTorch logs: collective timeouts, NCCL network errors, CUDA out-of-memory and illegal-access errors.

  Each log line becomes a `log` record with a code, a class (ecc, bus, link, pcie, network, storage, app…) and a severity. XIDs reuse gpu-health's fault table.
- **Topology:**
  - `nvidia-smi topo -m`: NVLink and NIC affinity within a node;
  - `ibnetdiscover`: host to leaf to spine;
  - a racks file: rack, row, PDU, site.

  These become `topology` edges.
- **Versions:** driver, CUDA, VBIOS, kernel, OS image, container runtime and NCCL, read from `nvidia-smi -q`, Kubernetes node info, GPU feature discovery labels and NCCL logs. A version that changes between two inventory snapshots becomes a `change` record automatically.
- **Change feeds:** Kubernetes events (cordon, reboot, scaling; mount failures and evictions as logs) and Helm release history.
- **Root-cause analysis uses all of it:**
  - log faults count as hardware evidence;
  - a **shared-component** rule finds the leaf switch, rack or PDU the affected nodes have in common;
  - a **version-cohort** rule finds the driver, firmware or image the affected nodes share and the rest of the fleet doesn't;
  - the infrastructure rule names storage or network when their logs dominate.
- **gpu-health** reads device faults from logs as results.

**Done when:** each of these scenarios ranks first with evidence that cites the log, topology or version records: a faulty GPU seen only in dmesg, a bad leaf switch, a bad driver cohort, a storage outage.

### 6. Measured root-cause accuracy: benchmark, fault injection, detection

- **A labeled benchmark** built from two sources:
  - past incidents and postmortems, each a store snapshot plus its confirmed cause;
  - fault injection on a test cluster, with a script per fault: ECC errors injected with `dcgmi`, a throttled NVLink, a killed NCCL rank, a downed IB port, a bad config push, a stalled NFS mount.
- **Top-1 and top-3 accuracy and time to diagnosis on every PR**, the way the skills have smoke tests.
- **Detection:**
  - change-point detection (CUSUM or Bayesian online change-point) and seasonal baselines replace the fixed ratio thresholds;
  - alerts that share a cause are folded into one incident.
- **Rule weights fitted to the labeled set** instead of set by hand, with the evidence still cited.

**Done when:** top-1 ≥ 80% and top-3 ≥ 95% on at least 30 labeled incidents, half of them from fault injection; detection fires within 5 minutes of the injected onset.

**Status:** the tooling is built: the benchmark, fault injection, CUSUM detection with grouping, weight fitting and the CI gate ([fleetops/docs/BENCHMARK.md](fleetops/docs/BENCHMARK.md)). On synthetic scenarios not used for tuning: top-1 98.8–100%, top-3 99.6–100%. The done-when still needs real labels: `fleetops backtest` (postmortem windows pulled from Prometheus and Loki) and `fleetops gameday` (a plan of injections on a test cluster) produce them in one command each.

### 7. A store that holds production volume

- **Storage:** Parquet partitioned by kind, day and cluster, queried with DuckDB, behind the same `DataStore` interface. ClickHouse is an option where a server is wanted.
- **Streaming ingestion:**
  - a Prometheus remote_write receiver and an OTLP receiver (metrics, logs, traces);
  - out-of-order and late data handled;
  - idempotent dedupe keys;
  - backpressure.
- **Retention:** raw data for days, 1-minute and 1-hour rollups for months, and every incident window kept at full resolution for good.
- **Schema versions** with migrations.

**Done when:** sustained ingest of 10,000 GPUs at a 10-second interval on one node, and a 24-hour root-cause query in under 10 seconds. Both are measured by a benchmark in CI that replays Philly at 100× speed.

**Status:** done on the Parquet backend, measured at full size (90M samples) on 2 vCPUs: ingest at 9× the rate needed, root-cause query 1.22 s (0.62 s with the hourly rollup). CI runs the benchmark at 1,000 GPUs on generated DCGM series, not a Philly replay, because the Philly data is downloaded at run time and too large for CI ([fleetops/docs/SCALE.md](fleetops/docs/SCALE.md)).

### 8. Request and rank tracing

- **Serving:** per-request spans (router queue, prefill, decode, KV eviction, retry) with one correlation ID from router to engine.
  - The spans follow the OpenTelemetry GenAI semantic conventions.
  - Exemplars link metrics to traces, so a p99 spike opens the slow requests.
  - hybrid-tracing writes its clock-corrected spans into the store.
- **Training:**
  - per-rank step time and NCCL collective timing, from the NCCL profiler plugin or PyTorch Kineto traces;
  - checkpoint stall time and MFU.
- **New root-cause rules:**
  - straggler rank;
  - collective hang;
  - tail latency from one replica.

**Done when:** a slow-rank injection is pinned to the right rank and node, and a TTFT regression is traced to the replica or stage that caused it.

**Status:** built ([fleetops/docs/TRACING.md](fleetops/docs/TRACING.md)): OTLP and hybrid-tracing spans → per-request stages; Kineto traces and step logs → per-rank steps; training-slow and training-hang detection; straggler, collective-hang, replica-tail and slow-stage rules; `inject gpu-slow`. Checked on injected and synthetic cases. NCCL Inspector (the profiler plugin) is read in JSON and Prometheus form and feeds a slow-link rule. Real-cluster labels are still to come.

### 9. Incidents as a workflow

- **Lifecycle:** open, acknowledged, mitigated, resolved, with owner and severity. Links to the pager (PagerDuty or Opsgenie) and the ticket system.
- **A timeline view:** symptoms, changes, log faults, health events and hypotheses on one time axis, in the flakiness dashboard's style.
- **A postmortem draft** generated from the diagnosis.
- **The confirmed cause is fed back** as a label for milestone 6.

**Done when:** an injected incident goes from detection to a resolved postmortem with its label stored, without leaving the tools.

**Status:** done ([fleetops/docs/INCIDENTS.md](fleetops/docs/INCIDENTS.md)), checked end to end through the CLI in `tests/incidents.test.mjs`. Paging is a dry run unless `--live`.

### 10. Run as a service, securely

- **A service, not only cron:**
  - a daemon with an HTTP API;
  - a Grafana data source and dashboards;
  - fleetops' own health metrics.
- **The optimizer's guard queries Prometheus at advance time,** not only the store.
- **Access and data protection:**
  - tenant-scoped access;
  - prompts and outputs redacted at ingest;
  - an on-prem-only mode with no external calls;
  - an audit trail of reads of sensitive data.
- **Contract tests against pinned exporter versions:** DCGM exporter, AMD device metrics exporter, vLLM.

**Done when:** fleetops runs as a deployment with tenant-scoped access, and the redaction tests show no request content in the store.

**Status:** built ([fleetops/docs/SERVICE.md](fleetops/docs/SERVICE.md)): read API and Grafana dashboard, tokens with roles and tenant scopes, audit, redaction at ingest, on-prem egress allowlist, Prometheus guards, exporter contract tests, a Dockerfile and a Kubernetes manifest. Checked in tests; not yet run on a real cluster.

### 11. Live agent and dashboard

- **An agent in the service:**
  - watches training and inference as data streams in;
  - diagnoses each incident and mitigates it from a playbook per cause, within the gpu-health policy;
  - verifies the mitigation, and pages a person when it can't act or the mitigation didn't work.
- **Guardrails:**
  - confidence decides how far it goes;
  - a monitoring gap freezes it;
  - blast-radius caps and an hourly limit on autonomous changes;
  - pause;
  - approvals by named people;
  - nothing runs unless both locks are open.
- **A live dashboard:** GPU states and flakiness, incidents and the agent's decisions, training step times and serving
  latency, approvals.

**Done when:** in shadow mode the agent's decisions can be compared with on-call's for a week, and each action kind can
be made live on its own.

**Status:** built ([fleetops/docs/AGENT.md](fleetops/docs/AGENT.md)). Tested on the benchmark scenarios with a fake
runner. It has not yet run against a real cluster.

## Part 3: where the GPU time goes, and whether the answers are right

The first two parts find and fix incidents. This part measures what the fleet delivers: how much of the GPU spend
turns into training that is kept, whether that training is correct, and how to keep it that way through changes,
power limits and cost reviews.

### 12. Training goodput

- **A ledger of every allocated GPU-second:**
  - per job, team and day;
  - split into productive steps and seven kinds of badput: slow steps, waiting on data, checkpoint saves, lost work,
    restarts, startup, idle.
- **Interruptions:** the fleet's interruption rate, measured.
- **Checkpoint intervals:** each job's best interval (Young/Daly), with the GPU-hours it would save.
- **Serving:** the share of requests that met their latency targets.

**Done when:** a week of the fleet's step logs gives each job's goodput and biggest loss, and the checkpoint advice
names its savings.

**Status:** built ([fleetops/docs/GOODPUT.md](fleetops/docs/GOODPUT.md)). Tested on a demo week with planted badput,
where each job's biggest loss is the one planted, and on Philly's job traces (attempt-level, an upper bound). It
needs a real fleet's step logs.

### 13. Silent data corruption

- **Evidence that names a GPU:**
  - data-parallel replicas whose parameter checksums disagree;
  - failed canaries and replays;
  - the first rank to go non-finite;
  - gradient-norm outliers.
- **Per job:** the first sign, and the last clean checkpoint to resume from.
- **Wiring:**
  - a `silent-corruption` root-cause rule and a benchmark scenario;
  - gpu-health quarantine with fault class `sdc`;
  - a live-agent playbook;
  - a canary script for nodes.

**Done when:** a GPU flagged on the fleet is confirmed by the canary or a replay, and the job resumes from the
checkpoint named.

**Status:** built ([fleetops/docs/SDC.md](fleetops/docs/SDC.md)). The detection logic is tested; the canary hasn't
run on GPUs yet.

### 14. Node admission and safe rollouts

- **Admission:** a node must pass a gate before it joins the training pool or returns from repair:
  - burn-in;
  - the SDC canary;
  - an NCCL bandwidth test against its neighbours;
  - topology and version checks.
- **Rollouts:** driver, firmware, CUDA and NCCL changes go to a canary cohort first, compared automatically with the
  rest. A regression stops the rollout. This turns the version-cohort rule from after the fact into before it.

**Done when:** a bad node or version is stopped before it reaches a production job.

**Status:** built ([fleetops/docs/ADMISSION.md](fleetops/docs/ADMISSION.md)).
- **Admission:** six checks, against the same SKU's admitted peers. The node-side script is tested against
  stand-in tools.
- **Rollouts:** canary across racks, approved waves, and an automatic comparison with automatic rollback.
- **On a synthetic fleet with a known answer:** a bad driver on two canary nodes was caught on hard faults (×7),
  NCCL bandwidth (−22%) and per-rank compute (+12% in 43 of 44 shared jobs), rolled back and halted. A harmless one
  was verified.
- **Still needed:** a real rollout, and admission on real nodes.

### 15. Power-aware capacity

- **FleetScope:** power budgets per rack and site, power caps per pool, and throughput per megawatt; which jobs slow
  down under a cap.
- **Live agent:** applies power caps within the same approval guardrails.
- **Vendor-neutral:** works on NVIDIA and AMD alike.

**Done when:** a capacity plan is limited by power as well as GPUs, and a cap's effect on goodput is predicted before
it is applied.

**Status:** built ([fleetops/docs/POWER.md](fleetops/docs/POWER.md)).
- **Measured:** power against budgets per rack, PDU and site, with headroom in nodes.
- **Predicted per job:** the slowdown under a cap, from its measured draw and how compute-bound it is.
- **Planned:** caps at the least slowdown, approved and guarded. The live agent proposes caps.
- **FleetScope:** caps per pool, site budgets and tokens per MWh.
- **Synthetic, with a known answer:** the fitted cap response came out at 0.41 against a planted 0.40. The plan
  capped memory-bound serving to 60% (2.5% slower) before training (80%, 4.7%).
- **Still needed:** caps applied on a real fleet and measured with `power verify`, and node-level power meters.

### 16. Cost per useful work

- **Joined data:**
  - GPU-hour cost (from OpenCost where it runs, or prices in the config);
  - goodput, failures and latency targets.
- **Measures:**
  - cost per kept training step and per in-target token;
  - the cost of each incident;
  - on-prem against neocloud for the same work.

**Done when:** each team's bill shows what was useful and what was lost, and why.

**Status:** built as a standalone tool, [gpu-ledger](gpu-ledger/), so it runs on any cluster, not only on fleetops
data (`fleetops data export gpu-ledger` connects the two):
- useful, idle and lost GPU-hours and cost per org, team, person, project, use case, GPU type and model;
- ranked savings with owners, including serving cost per token and model/GPU matching;
- FOCUS 1.4 export next to cloud bills.

On Philly's week (real utilization), 70% of 314,261 allocated GPU-hours were useful, 25% idle and 4% lost.
**Still needed:**
- a bill reconciled against a real invoice or cloud FOCUS export;
- on-prem vs neocloud for the same work;
- the cost of each incident, joining fleetops incidents to the ledger.

### 18. Tuning from real traces

- **Getting traces in:**
  - a read-only collector makes one bundle per node or cluster;
  - bundles are imported or uploaded (`POST /v1/bundle`);
  - loose files are recognized by content.
- **Tuning:** recommendations across training, inference and the fleet, each with evidence, knobs, the expected
  effect and its basis (measured, model, upper bound).
- **Checking:**
  - `tune apply` records a change, and `tune verify` measures it before and after with a 95% interval;
  - `tune holdout` checks each premise out of sample.

**Done when:** a change made on a recommendation is measured on the fleet, and the measurement is near the
prediction.

**Status:** built ([fleetops/docs/TUNE.md](fleetops/docs/TUNE.md)).
- **Philly:** the flaky-node finding held out of sample (3.5× expected), at a smaller share than in sample.
- **Synthetic, with a known answer:** two applied changes were measured as improved; the checkpoint model's
  prediction was within 3 points.
- **Still needed:** a change applied on a real fleet.

### 19. Serving: fit, capacity and one-command deployment

- **Fit:** given GPUs, which catalog models fit and how much load each carries within the latency targets.
- **Capacity:** given a model and GPUs, the max request rate, concurrency and longest prompt.
- **Deploy:** the plan becomes vLLM on Kubernetes (a Deployment, or a LeaderWorkerSet across nodes), checked against
  the cluster, applied, smoke-tested and registered with fleetops for tuning.

**Done when:** a model deployed this way meets its targets at the planned rate under a load test on a real cluster.

**Status:** built ([fleetops/docs/SERVING.md](fleetops/docs/SERVING.md)), tested against a stub cluster and a fake
OpenAI server. **Still needed:** a deployment on a real cluster, a load test against the plan, and disaggregated
serving (llm-d or Dynamo) when the sizer chooses it.

### 17. Fabric and storage stalls

- **Fabric:** slow NCCL links traced to switch ports and congestion counters (UFM, SONiC, switch telemetry), not
  only to the node.
- **Storage:** data-loader and checkpoint-storage stalls traced to the filesystem or object store behind them.

**Done when:** a slow-link or data-stall diagnosis names the switch port or storage target.

## Order and why

1. **Data first.** Every later step needs the same inputs, and the change feed is the single most predictive signal for incidents.
2. **Calibration next.** Diagnoses and optimizations are only as good as the model they simulate on.
3. **Root-cause analysis third.** It needs the store and calibrated capacity.
4. **Optimization last.** It needs all three, and the safety machinery already exists in gpu-health.
5. **Signals before scale (5 before 7).** A diagnosis can't name what the store never collected. Logs, topology and versions change what root-cause analysis can say; a bigger store doesn't.
6. **Measure before tuning (6).** Without a labeled benchmark, every rule change is a guess. Fault injection makes labels cheap.
7. **Scale before connecting a real fleet (7).**
8. **Then depth and workflow (8–10):** per-request and per-rank detail, incident handling, and running as a service.
9. **Acting last (11).** The agent reuses every piece before it: the store, detection, diagnosis, incidents, gpu-health's queue and locks. It starts as a shadow so its decisions are measured before any of them run.
10. **Then what the fleet delivers (12–17).** Goodput and silent corruption first: both reuse data already collected, and neither has a strong open-source answer. Admission and rollouts next, since they prevent what 6–13 detect. Power and cost last: they need goodput to say what a watt or a dollar bought.

## Public data used for validation

| Data | License | Used for |
|---|---|---|
| [Microsoft Philly traces](https://github.com/msr-fiddle/philly-traces) (2017 GPU training cluster: per-minute per-GPU utilization, job placements and outcomes) | CC BY 4.0 | Data layer at scale; gpu-health efficiency; root-cause analysis on a real failure spike; consolidation candidates |
| [Azure LLM inference traces](https://github.com/Azure/AzurePublicDataset) 2023 and 2024 (arrival times and token counts) | CC BY 4.0 | FleetScope replay and load for calibration runs |
| [MLPerf Inference v5.0 results](https://github.com/mlcommons/inference_results_v5.0) (measured TTFT and TPOT for Llama 2 70B on H100, H200, B200 and MI325X) | Published by MLCommons; downloaded at run time, not stored in this repo | Calibrating FleetScope and the Inference Sizer against measured latency |
| [AcmeTrace](https://github.com/InternLM/AcmeTrace) (LLM-development job outcomes) | CC BY 4.0 | Job failure statistics |

None of these has per-GPU XID, ECC or link-error history, kernel logs, or network topology. No public dataset with that history was found that could be downloaded and reused here. gpu-health's fault rules and the milestone-5 log and topology adapters are checked against fixtures written in the documented output formats, until milestone 6's fault injection produces real ones.
