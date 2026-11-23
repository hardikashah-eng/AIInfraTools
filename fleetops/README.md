# fleetops

The shared layer under the AIInfraTools utilities. It is one store of everything the fleet emits, which the other tools read and later steps build on. See [ROADMAP.md](../ROADMAP.md) for the plan: calibration, root-cause analysis and optimization each arrive in their own step.

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
src/adapters/time.mjs    timestamps with zones and US Pacific daylight saving
src/export.mjs           store → gpu-health inputs, FleetScope trace CSV
tools/fleetops.mjs       CLI
tools/fetch-public-data.sh
```
