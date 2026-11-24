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

## Order and why

1. **Data first.** Every later step needs the same inputs, and the change feed is the single most predictive signal for incidents.
2. **Calibration next.** Diagnoses and optimizations are only as good as the model they simulate on.
3. **Root-cause analysis third.** It needs the store and calibrated capacity.
4. **Optimization last.** It needs all three, and the safety machinery already exists in gpu-health.

## Public data used for validation

| Data | License | Used for |
|---|---|---|
| [Microsoft Philly traces](https://github.com/msr-fiddle/philly-traces) (2017 GPU training cluster: per-minute per-GPU utilization, job placements and outcomes) | CC BY 4.0 | Data layer at scale; gpu-health efficiency; root-cause analysis on a real failure spike; consolidation candidates |
| [Azure LLM inference traces](https://github.com/Azure/AzurePublicDataset) 2023 and 2024 (arrival times and token counts) | CC BY 4.0 | FleetScope replay and load for calibration runs |
| [MLPerf Inference v5.0 results](https://github.com/mlcommons/inference_results_v5.0) (measured TTFT and TPOT for Llama 2 70B on H100, H200, B200 and MI325X) | Published by MLCommons; downloaded at run time, not stored in this repo | Calibrating FleetScope and the Inference Sizer against measured latency |
| [AcmeTrace](https://github.com/InternLM/AcmeTrace) (LLM-development job outcomes) | CC BY 4.0 | Job failure statistics |

None of these has per-GPU XID, ECC or link-error history. No public dataset with that history was found that could be downloaded and reused here. gpu-health's fault rules are still checked against its own planted demo faults.
