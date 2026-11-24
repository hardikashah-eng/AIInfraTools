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

The full field list is in [docs/DATA-LAYER.md](docs/DATA-LAYER.md).

## Signals for diagnosis

Beyond metrics and job outcomes, the store holds:
- **logs:** XIDs, PCIe AER, NVLink, AMD RAS, IB link state, NFS/Lustre, OOM; NCCL and PyTorch errors;
- **topology:** NVLink, host → leaf → spine, racks and PDUs;
- **versions:** driver, firmware, kernel, image, NCCL; a version change becomes a change record automatically;
- **more change feeds:** Kubernetes events, Helm history.

Root-cause analysis uses them to point at a GPU seen failing only in dmesg, a bad leaf switch, a driver cohort or a storage outage. `fleetops data node NODE` shows one node's versions, what it shares, its log faults and its changes. See [docs/SIGNALS.md](docs/SIGNALS.md).

## Calibration

`fleetops calibrate` fits FleetScope pools and the Inference Sizer to the measurements in the store, keeps each fit as a profile the tools read (`calibrate apply` for FleetScope graphs, `--calibration` for the sizer), checks each fit against held-out measurements, and raises drift records when new data leaves the acceptance bar. See [docs/CALIBRATION.md](docs/CALIBRATION.md), including results on MLPerf Inference v5.0: the sizer's spec-sheet defaults asked for 16 GPUs where the measured H100 and H200 systems used 8, and the calibrated profiles predict 8.

## Root-cause analysis

`fleetops rca` finds incidents (job-failure spikes, serving latency regressions) and ranks their likely causes with rules over the store: workload, hardware, change, infrastructure, KV-cache pressure, load and monitoring gaps. Every hypothesis cites its evidence and says how to confirm it; `rca eval` measures top-1/top-3 accuracy on labeled incidents. On the Philly week it finds six failure spikes and traces each to one tenant's retry storm across 100+ machines, with the GPUs ruled out. See [docs/RCA.md](docs/RCA.md).

## Measured root-cause accuracy

`fleetops rca bench` scores root-cause analysis on labeled incidents: synthetic scenarios with distractors, faults injected on a test cluster (`fleetops inject`, dry-run unless `--live`, targets limited to an allowlist), and postmortems. It reports top-1/top-3 per cause and whether the right component was named, fits rule weights on real labels (`--fit`), and gates CI. Detection now uses seasonal baselines and CUSUM change-point detection, with grouping. The benchmark's first run found and fixed eight weaknesses in the rules (73% → 99% top-1 on scenarios not used for tuning). See [docs/BENCHMARK.md](docs/BENCHMARK.md), including three ways to test against production traces.

## Production volume

A Parquet backend queried with DuckDB (`--backend parquet`; optional dependency) sits behind the same store interface. `fleetops serve` ingests Prometheus remote_write and OTLP/HTTP JSON (metrics, logs, traces), with backpressure, idempotent dedupe and its own metrics. `data rollup` and `data compact` keep minute and hour rollups and incident windows at full resolution while old raw days are dropped. `data migrate` handles schema versions. Measured at 10,000 GPUs every 10 s (90M samples): ingest at 9× the rate needed on one thread, and a 24-hour root-cause query in 1.2 s (0.6 s with the hourly rollup). See [docs/SCALE.md](docs/SCALE.md).

## Request and rank tracing

Spans (OTLP, or forwarded clock-corrected by hybrid-tracing) become per-request records with router/queue/prefill/decode stages, tokens and replica. PyTorch profiler traces and step logs become per-rank steps with NCCL, data and compute time. Detection adds training slowdowns and hangs. Four rules point at the straggler rank and its GPU, the rank that never joined a hung collective, the replica holding the slow requests, and the stage that grew. See [docs/TRACING.md](docs/TRACING.md).

## Incidents as a workflow

`fleetops incidents` opens incidents from detection, moves them through open → acknowledged → mitigated → resolved (with owner, severity, notes and who did what), and pages PagerDuty, Opsgenie or a webhook (dry run unless `--live`). It draws a timeline page per incident and drafts the postmortem from the store. Resolving with `--cause` stores the confirmed cause as a label for `rca bench --from-incidents`. See [docs/INCIDENTS.md](docs/INCIDENTS.md).

## Service and security

`fleetops serve` also answers a read API (`/api/query`, `/api/series` for Grafana, `/api/incidents`, `/api/diagnose`). Tokens have roles (ingest, read, admin) and tenant scopes (namespaces, pools, clusters, infra); only their hashes are stored. Every read is audited. Prompts, completions and secrets are redacted at ingest. `--on-prem` refuses outbound calls to unlisted hosts. Optimizer guards can query Prometheus at check time. Exporter formats are pinned by contract tests. A Dockerfile, a Kubernetes manifest and a Grafana dashboard are in `Dockerfile` and `deploy/`. See [docs/SERVICE.md](docs/SERVICE.md).

## Send your traces, get tuning advice, check it worked

- **Collect:** `tools/collect.sh` gathers what a node or cluster has into one bundle: nvidia-smi, the kernel log, DCGM, vLLM metrics, kubectl or Slurm, Helm history, and the step and request logs you name.
- **Send:** `fleetops data import bundle FILE` imports it, `fleetops send FILE --to URL` uploads it to a running fleetops, and `data import auto` recognizes loose files by their content.
- **Tune:** `fleetops tune` ranks what to change, with evidence, knobs and the expected effect, and says whether that effect is measured, modelled or an upper bound:
  - training: checkpoint interval, input pipeline, slow nodes, restarts, communication;
  - inference: KV cache, pool size and autoscaling through the Inference Sizer;
  - fleet: flaky nodes, idle GPUs.
- **Check it worked:**
  - `fleetops tune apply ID --by NAME` records a change, and `fleetops tune verify` measures it before and after, with a 95% interval;
  - `tune holdout` checks a recommendation's premise out of sample before anything changes.

On Philly's real job traces, the 10 flaky nodes found in the first half of a week kept failing at 3.5× their expected rate in the second half. See [docs/TUNE.md](docs/TUNE.md).

## Power-aware capacity

`fleetops power report` gives IT kW per rack, PDU, row and site against budgets, and how many more nodes fit. `power predict --cap 70%` gives which jobs a cap slows and by how much: memory-bound serving barely notices, compute-bound training does. `power fit` measures that response on your GPUs. `power plan` picks the caps that bring each group under budget at the least slowdown and queues them for approval. NVIDIA and AMD are both handled, and the live agent proposes caps when a group goes over budget. FleetScope models caps per pool and site budgets too (`fleetscope power`). See [docs/POWER.md](docs/POWER.md).

## Serving: what fits, what it carries, deploy it

- **What fits:** `fleetops serving fit --gpu H100 --nodes 2 [--rate 5]` lists every catalog model with the load it carries on that hardware within the TTFT and TPOT targets (production and flat out), output tokens/s, $ per million tokens and the layout. With `--rate`, the models that carry it come first, largest first.
- **What one model carries:** `fleetops serving capacity --model llama33-70b --gpu H100 --nodes 2` gives the max request rate, concurrency, the longest prompt that still meets TTFT, and the layout.
- **Deploy:** `install/install-serving.sh --model … --gpu … --nodes 2 --hf-secret hf-token` (or `fleetops serving deploy … --apply`) renders vLLM as a Deployment, or a LeaderWorkerSet when an instance spans nodes, plus a Service and optional KEDA autoscaling; checks the cluster; applies; waits; sends a test completion; and registers the pool so `fleetops tune` and the agent know it. A dry run unless told to apply.

The numbers are the Inference Sizer's, from spec sheets unless `fleetops calibrate` has fitted them to your benchmarks. See [docs/SERVING.md](docs/SERVING.md).

## Training goodput

`fleetops goodput` splits every training allocation, per job, team and day:
- **productive:** kept steps at the job's own best pace;
- **badput:** slow steps, waiting on data, checkpoint saves, lost work (steps after the last checkpoint of an attempt that failed, and the hang before it), restarts, startup and idle.

It measures the fleet's interruption rate and gives each job its best checkpoint interval (Young/Daly), with the GPU-hours a week the change would save. Serving pools get the share of requests that met their latency targets. On Philly's week of job traces, 21% of 318K training GPU-hours were in attempts that failed. That figure is an upper bound: the traces have no checkpoint data. See [docs/GOODPUT.md](docs/GOODPUT.md).

## Silent data corruption

`fleetops sdc` finds GPUs that compute wrong answers without an error. Its evidence:
- data-parallel replicas whose parameter checksums disagree with their peers;
- failed canaries (`tools/sdc-canary.py`: the same deterministic work on every GPU, compared) and replays;
- the first rank to go non-finite;
- gradient-norm outliers.

For each affected job it names the last checkpoint saved before the first sign, which is where to resume. A `silent-corruption` rule, a benchmark scenario, gpu-health quarantine (fault class `sdc`) and a live-agent playbook come with it. See [docs/SDC.md](docs/SDC.md).

## Live agent and dashboard

`fleetops serve --agent` checks the fleet every 30 seconds as data streams in. It finds job failures, latency regressions, slow training steps and hangs, diagnoses each one, and mitigates it within the gpu-health policy:
- **training:** cordon a slow-link or hung node, reset a straggler's clocks, swap a node out at the next checkpoint;
- **inference:** drain a slow replica, scale a pool out;
- **changes:** roll back a bad Helm revision.

Ten minutes later it checks whether the symptom cleared and pages a person when it didn't.

Guardrails:
- confidence decides how far it goes (medium only contains, low only pages);
- a monitoring gap freezes it;
- cordons and autonomous changes are capped, and a Pause button stops it;
- nothing runs unless both locks are open.

The same process serves `/live`: GPU states and flakiness, incidents and what the agent did, training step times, serving latency, and approve and reject buttons for what it proposed. Without `--live` it is a shadow: it decides and logs everything, runs nothing, and reports whether each incident cleared on its own. See [docs/AGENT.md](docs/AGENT.md).

## Try it without a fleet

`fleetops demo --store demo [--scenario slow-link]` writes a fleet with one planted cause (any of the 18 benchmark scenarios; `--list` names them) and prints the detect, diagnose and incident commands to run, and the answer to check against. Add `--now` to move it so the incident is happening now, then `fleetops serve --agent --store demo` and open http://127.0.0.1:9400/live.

fleetops is also an [Agent Skill](../skills/fleetops/SKILL.md), so a model can run it for you.

## Install

One command each: `install/install.sh` (one machine, as a user service), `install/install-docker.sh` (Docker Compose with Grafana provisioned) or `install/install-k8s.sh --image …` (Kubernetes). `install/install-serving.sh` deploys a model for inference (above). Each makes hashed tokens and prints the Prometheus, OpenTelemetry and Grafana settings to paste. `fleetops backtest` and `fleetops gameday` then turn your postmortems and test-cluster faults into labels. See [docs/INSTALL.md](docs/INSTALL.md).

## Optimization with safe execution

`fleetops optimize` collects candidate changes from gpu-health (right-sizing, scale-in, reclaiming idle GPUs), rca (retry storms) and FleetScope (the cheapest pool sizes that still meet the SLO). It picks a set that meets a savings goal without double-counting or touching protected classes, and stages it in gpu-health's approval queue. Each stage needs its own approval, runs dry unless both locks are open, and is followed by an SLO guard. A regression rolls back to the last verified state automatically. Applying a change never is automatic. See [docs/OPTIMIZE.md](docs/OPTIMIZE.md).

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
src/bundle.mjs           trace bundles: tar reading, content sniffing, import plans (tools/collect.sh makes them)
src/tune.mjs             tuning recommendations, apply / verify (before-after with a bootstrap interval), holdout
tools/collect.sh         one-command, read-only collection of a node's or cluster's traces into a bundle
src/goodput.mjs          training goodput: allocations split into goodput and badput, interruption rate, checkpoint advice
src/goodput-report.mjs   the goodput report (Markdown, HTML)
src/sdc.mjs              silent-data-corruption evidence → suspect GPUs, first sign and checkpoint to resume from per job
tools/sdc-canary.py      deterministic work on every GPU of a node, compared (PyTorch)
src/agent.mjs            the live agent: detect → diagnose → playbook → guardrails → act → verify → page
src/live.mjs             the /live dashboard and its API (state, approvals, pause)
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
