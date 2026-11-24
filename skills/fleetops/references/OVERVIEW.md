# fleetops

The shared layer under the AIInfraTools utilities. It is one store of everything the fleet emits, which the other tools read and later steps build on. See [ROADMAP.md](../ROADMAP.md) for the plan: calibration, root-cause analysis and optimization are built on top of it.

Plain JSON lines, no database, no dependencies beyond Node 20+.

## The data layer

```bash
cd fleetops
node tools/fleetops.mjs data import exporter dcgm-scrape.prom --store /var/lib/fleet-data      # DCGM / AMD / SambaNova exporters
node tools/fleetops.mjs data import vllm metrics.prom --before metrics-1h-ago.prom --pool chat-h200
node tools/fleetops.mjs data import k8s-nodes nodes.json; node tools/fleetops.mjs data import k8s-pods pods.json
node tools/fleetops.mjs data import sacct sacct.txt                                              # Slurm job outcomes
node tools/fleetops.mjs data import git-log infra-git.log --repo infra                          # change feed from a GitOps repo
node tools/fleetops.mjs data summary
node tools/fleetops.mjs data export gpu-health --out gh-input/ --from 2026-11-20                 # then: gpu-health analyze --samples gh-input/samples.jsonl …
```

The store is a directory with one folder per record kind and one file per UTC day (`device/2026-11-23.jsonl`). It can be read by any tool, compressed, shipped between sites, or queried with `jq` or DuckDB. Imports skip records that are already stored, so re-running one is safe.

| Kind | What one record is | From |
|---|---|---|
| `device` | one accelerator at one moment (gpu-health's sample format) | exporters, Philly |
| `inventory` | a node and the accelerators it holds | Kubernetes, Slurm, Philly |
| `placement` | a job on devices | Kubernetes pods, Philly |
| `job` | how a job ended, and why (`device`, `app`, `infra`, `unknown`) | Slurm `sacct`, gpu-health results, Philly, AcmeTrace |
| `serving` | a serving pool over a window: rate, token sizes, TTFT and TPOT quantiles, KV usage | vLLM `/metrics`, Prometheus range queries |
| `request` | one inference request (arrival, input and output tokens) | Azure LLM traces |
| `change` | something that changed: deploy, driver, firmware, config, scale, model, policy | change-feed JSON, `git log` |
| `health` | a device state change | gpu-health's `events.jsonl` |
| `benchmark` | a measured run at a known load | MLPerf Inference summaries |

The full field list is in [docs/DATA-LAYER.md](DATA-LAYER.md).

## Signals for diagnosis

Beyond metrics and job outcomes, the store holds:
- **logs:** XIDs, PCIe AER, NVLink, AMD RAS, IB link state, NFS/Lustre, OOM; NCCL and PyTorch errors;
- **topology:** NVLink, host → leaf → spine, racks and PDUs;
- **versions:** driver, firmware, kernel, image, NCCL; a version change becomes a change record automatically;
- **more change feeds:** Kubernetes events, Helm history.

Root-cause analysis uses them to point at a GPU seen failing only in dmesg, a bad leaf switch, a driver cohort or a storage outage. `fleetops data node NODE` shows one node's versions, what it shares, its log faults and its changes. See [docs/SIGNALS.md](SIGNALS.md).

## Calibration

`fleetops calibrate` fits FleetScope pools and the Inference Sizer to the measurements in the store, keeps each fit as a profile the tools read (`calibrate apply` for FleetScope graphs, `--calibration` for the sizer), checks each fit against held-out measurements, and raises drift records when new data leaves the acceptance bar. See [docs/CALIBRATION.md](CALIBRATION.md), including results on MLPerf Inference v5.0: the sizer's spec-sheet defaults asked for 16 GPUs where the measured H100 and H200 systems used 8, and the calibrated profiles predict 8.

## Root-cause analysis

`fleetops rca` finds incidents (job-failure spikes, serving latency regressions) and ranks their likely causes with rules over the store: workload, hardware, change, infrastructure, KV-cache pressure, load and monitoring gaps. Every hypothesis cites its evidence and says how to confirm it; `rca eval` measures top-1/top-3 accuracy on labeled incidents. On the Philly week it finds six failure spikes and traces each to one tenant's retry storm across 100+ machines, with the GPUs ruled out. See [docs/RCA.md](RCA.md).

## Measured root-cause accuracy

`fleetops rca bench` scores root-cause analysis on labeled incidents: synthetic scenarios with distractors, faults injected on a test cluster (`fleetops inject`, dry-run unless `--live`, targets limited to an allowlist), and postmortems. It reports top-1/top-3 per cause and whether the right component was named, fits rule weights on real labels (`--fit`), and gates CI. Detection now uses seasonal baselines and CUSUM change-point detection, with grouping. The benchmark's first run found and fixed eight weaknesses in the rules (73% → 99% top-1 on scenarios not used for tuning). See [docs/BENCHMARK.md](BENCHMARK.md), including three ways to test against production traces.

## Production volume

A Parquet backend queried with DuckDB (`--backend parquet`; optional dependency) sits behind the same store interface. `fleetops serve` ingests Prometheus remote_write and OTLP/HTTP JSON (metrics, logs, traces), with backpressure, idempotent dedupe and its own metrics. `data rollup` and `data compact` keep minute and hour rollups and incident windows at full resolution while old raw days are dropped. `data migrate` handles schema versions. Measured at 10,000 GPUs every 10 s (90M samples): ingest at 9× the rate needed on one thread, and a 24-hour root-cause query in 1.2 s (0.6 s with the hourly rollup). See [docs/SCALE.md](SCALE.md).

## Request and rank tracing

Spans (OTLP, or forwarded clock-corrected by hybrid-tracing) become per-request records with router/queue/prefill/decode stages, tokens and replica. PyTorch profiler traces and step logs become per-rank steps with NCCL, data and compute time. Detection adds training slowdowns and hangs. Four rules point at the straggler rank and its GPU, the rank that never joined a hung collective, the replica holding the slow requests, and the stage that grew. See [docs/TRACING.md](TRACING.md).

## Incidents as a workflow

`fleetops incidents` opens incidents from detection, moves them through open → acknowledged → mitigated → resolved (with owner, severity, notes and who did what), and pages PagerDuty, Opsgenie or a webhook (dry run unless `--live`). It draws a timeline page per incident and drafts the postmortem from the store. Resolving with `--cause` stores the confirmed cause as a label for `rca bench --from-incidents`. See [docs/INCIDENTS.md](INCIDENTS.md).

## Service and security

`fleetops serve` also answers a read API (`/api/query`, `/api/series` for Grafana, `/api/incidents`, `/api/diagnose`). Tokens have roles (ingest, read, admin) and tenant scopes (namespaces, pools, clusters, infra); only their hashes are stored. Every read is audited. Prompts, completions and secrets are redacted at ingest. `--on-prem` refuses outbound calls to unlisted hosts. Optimizer guards can query Prometheus at check time. Exporter formats are pinned by contract tests. A Dockerfile, a Kubernetes manifest and a Grafana dashboard are in `Dockerfile` and `deploy/`. See [docs/SERVICE.md](SERVICE.md).

## Try it without a fleet

`fleetops demo --store demo [--scenario slow-link]` writes a fleet with one planted cause (any of the 17 benchmark scenarios; `--list` names them) and prints the detect, diagnose and incident commands to run, and the answer to check against.

fleetops is also an [Agent Skill](../skills/fleetops/SKILL.md), so a model can run it for you.

## Install

One command each: `install/install.sh` (one machine, as a user service), `install/install-docker.sh` (Docker Compose with Grafana provisioned) or `install/install-k8s.sh --image …` (Kubernetes). Each makes hashed tokens and prints the Prometheus, OpenTelemetry and Grafana settings to paste. `fleetops backtest` and `fleetops gameday` then turn your postmortems and test-cluster faults into labels. See [docs/INSTALL.md](INSTALL.md).

## Optimization with safe execution

`fleetops optimize` collects candidate changes from gpu-health (right-sizing, scale-in, reclaiming idle GPUs), rca (retry storms) and FleetScope (the cheapest pool sizes that still meet the SLO). It picks a set that meets a savings goal without double-counting or touching protected classes, and stages it in gpu-health's approval queue. Each stage needs its own approval, runs dry unless both locks are open, and is followed by an SLO guard. A regression rolls back to the last verified state automatically. Applying a change never is automatic. See [docs/OPTIMIZE.md](OPTIMIZE.md).

## Public data

`tools/fetch-public-data.sh DATA_DIR STORE_DIR` downloads the public traces used to validate this work and loads them into a store:
- Microsoft Philly: one week of per-minute GPU utilization, plus the job log;
- Azure LLM inference traces 2023 (code and conversation);
- MLPerf Inference v5.0 Llama 2 70B server results on H100, H200, B200 and MI325X;
- AcmeTrace (Kalos).

Licenses and what each is used for are in the roadmap. The data itself is not stored in this repo.

Results on a week of real data from the Philly cluster:
- 60 of its 8-GPU machines (56 of them reported GPU utilization);
- 118,060 ten-minute GPU samples, 29,774 job placements and 23,558 job outcomes, loaded in about 40 seconds;
- exported to gpu-health and analyzed without changes: 122 GPUs, 39% effective utilization (nvidia-smi utilization, an upper bound), 1,495 idle allocated GPU-hours in three days.

## Files

```
src/store.mjs            the store: append by day, dedupe, windowed scans, summary
src/schema.mjs           record kinds and validation
src/adapters/live.mjs    exporters, vLLM, Prometheus, Kubernetes, Slurm, change feeds, gpu-health history
src/adapters/philly.mjs  Microsoft Philly traces
src/adapters/public.mjs  Azure LLM traces, MLPerf summaries, AcmeTrace
src/adapters/logs.mjs    kernel and NCCL/PyTorch logs → log records (XID classes from gpu-health)
src/adapters/topology.mjs nvidia-smi -q / topo -m, ibnetdiscover, racks, shared-component groups, version changes
src/adapters/time.mjs    timestamps with zones and US Pacific daylight saving
src/export.mjs           store → gpu-health inputs, FleetScope trace CSV
src/calibrate.mjs        FleetScope pool and Inference Sizer fits, held-out checks, drift, profiles
src/rca.mjs              incident detection, causal rules, ranked hypotheses with evidence, evaluation
src/detect.mjs           seasonal baselines, Poisson and z-score CUSUM, incident grouping
src/bench.mjs            labeled scenarios, accuracy per cause, injected/postmortem scoring, fitted weights
src/inject.mjs           fault injection for a test cluster: allowlist, dry-run, undo, labels
src/memstore.mjs         the store interface in memory (benchmark, tests)
src/parquet-store.mjs    the store interface on Parquet + DuckDB (worker thread, synchronous facade)
src/ingest.mjs           remote_write and OTLP receivers, bounded dedupe pipeline, fleetops serve
src/proto.mjs            Snappy and the remote_write protobuf, no dependencies
src/retention.mjs        rollups, retention with incident windows kept
src/migrate.mjs          schema versions and migrations
src/pull.mjs             pull windows from Prometheus (query_range) and Loki for backtests and game days
src/api.mjs              read API (query, series, incidents, diagnose), tenant-scoped
src/security.mjs         tokens, roles, tenant scopes, redaction, egress allowlist, audit
src/incidents.mjs        lifecycle, paging, timeline page, postmortem draft, labels from confirmed causes
src/traces.mjs           spans → requests with stages; Kineto traces and step logs → per-rank steps
tools/bench-scale.mjs    ingest and 24 h root-cause benchmark
src/optimize.mjs         candidates, selection, staged rollout through gpu-health's queue, guards, rollback, verify
tools/fleetops.mjs       CLI
tools/fetch-public-data.sh
```
