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

**Status:** the tooling is built: the benchmark, fault injection, CUSUM detection with grouping, weight fitting and the CI gate ([fleetops/docs/BENCHMARK.md](fleetops/docs/BENCHMARK.md)). On synthetic scenarios not used for tuning: top-1 98.8–100%, top-3 99.6–100%. The done-when still needs real labels from a test cluster and from postmortems.

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

**Status:** built ([fleetops/docs/TRACING.md](fleetops/docs/TRACING.md)): OTLP and hybrid-tracing spans → per-request stages; Kineto traces and step logs → per-rank steps; training-slow and training-hang detection; straggler, collective-hang, replica-tail and slow-stage rules; `inject gpu-slow`. Checked on injected and synthetic cases. The NCCL profiler-plugin input and real-cluster labels are still to come.

### 9. Incidents as a workflow

- **Lifecycle:** open, acknowledged, mitigated, resolved, with owner and severity. Links to the pager (PagerDuty or Opsgenie) and the ticket system.
- **A timeline view:** symptoms, changes, log faults, health events and hypotheses on one time axis, in the flakiness dashboard's style.
- **A postmortem draft** generated from the diagnosis.
- **The confirmed cause is fed back** as a label for milestone 6.

**Done when:** an injected incident goes from detection to a resolved postmortem with its label stored, without leaving the tools.

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

## Order and why

1. **Data first.** Every later step needs the same inputs, and the change feed is the single most predictive signal for incidents.
2. **Calibration next.** Diagnoses and optimizations are only as good as the model they simulate on.
3. **Root-cause analysis third.** It needs the store and calibrated capacity.
4. **Optimization last.** It needs all three, and the safety machinery already exists in gpu-health.
5. **Signals before scale (5 before 7).** A diagnosis can't name what the store never collected. Logs, topology and versions change what root-cause analysis can say; a bigger store doesn't.
6. **Measure before tuning (6).** Without a labeled benchmark, every rule change is a guess. Fault injection makes labels cheap.
7. **Scale before connecting a real fleet (7).**
8. **Then depth and workflow (8–10):** per-request and per-rank detail, incident handling, and running as a service.

## Public data used for validation

| Data | License | Used for |
|---|---|---|
| [Microsoft Philly traces](https://github.com/msr-fiddle/philly-traces) (2017 GPU training cluster: per-minute per-GPU utilization, job placements and outcomes) | CC BY 4.0 | Data layer at scale; gpu-health efficiency; root-cause analysis on a real failure spike; consolidation candidates |
| [Azure LLM inference traces](https://github.com/Azure/AzurePublicDataset) 2023 and 2024 (arrival times and token counts) | CC BY 4.0 | FleetScope replay and load for calibration runs |
| [MLPerf Inference v5.0 results](https://github.com/mlcommons/inference_results_v5.0) (measured TTFT and TPOT for Llama 2 70B on H100, H200, B200 and MI325X) | Published by MLCommons; downloaded at run time, not stored in this repo | Calibrating FleetScope and the Inference Sizer against measured latency |
| [AcmeTrace](https://github.com/InternLM/AcmeTrace) (LLM-development job outcomes) | CC BY 4.0 | Job failure statistics |

None of these has per-GPU XID, ECC or link-error history, kernel logs, or network topology. No public dataset with that history was found that could be downloaded and reused here. gpu-health's fault rules and the milestone-5 log and topology adapters are checked against fixtures written in the documented output formats, until milestone 6's fault injection produces real ones.
