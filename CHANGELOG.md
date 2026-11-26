# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may
change the `--json` output, and when it does the change is listed here (see [schemas/](schemas/README.md)).

## Unreleased

### Shadow upgrades

- **`fleetops shadow`** measures an infra change before it ships, against the baseline at matched load.
  - **`plan`:** predicts the effect with the Inference Sizer and sizes the test.
  - **`replay`:** the same recorded sessions to two OpenAI-compatible endpoints at the same moments, paired per
    request, with session prefixes kept for the prefix cache. Dry run unless `--live`.
  - **`answers`:** greedy tokens and log-probs compared on a prompt set.
  - **`compare`:** stratified by calls in flight, prompt length and cache hit (or paired), with bootstrap intervals,
    verdicts against gates, the naive number beside each, errors, tokens/s per GPU, $ per M tokens, infra signals, and
    prediction vs measurement.
  - **`baseline` / `watch`:** drift of a service against its own saved history.
- Design and architecture: `fleetops/docs/SHADOW.md`. Tested on synthetic arms and mock endpoints; not yet run against
  live engines.

### Agentic workloads from real traces

- **FleetScope agentic profiles** (`fleetscope/tools/agentic.mjs`, `aiinfra agentic`):
  - fit a profile of how agent sessions behave from a real trace: TraceLab, AgentX "weka", Mooncake, harness-ledger
    records or your own CSV/JSONL;
  - generate sessions from a profile at any load;
  - measure what a workload asks of a fleet: prefill after cache reuse, and the KV working set idle sessions hold;
  - size GPUs for both compute and KV.

  On TraceLab, a profile fitted on 70% of sessions matches the held-out 30% within 1–8% on cache hit, call rate, and
  prefill and output rates. The KV working set comes out 28% low. Flat ISL/OSL sizing of the same calls asks for 440
  GPUs where 40 do. Ingest reads AgentX, Mooncake and TraceLab traces, with prefix reuse computed from block hashes.
- **harness-ledger on real data:**
  - TraceLab importer, streamed;
  - `--prices relative`;
  - a report on 8,058 real sessions: 22% of spend avoidable, mostly caches expiring in pauses.
- **harness-ledger outcomes:** cost per successful task, spend on failures, and what call caps would save. On SWE-bench
  Verified across 11 models, 39% of spend goes to unresolved tasks, and caps save about 1% at no more than one point
  of success lost.
- **Sizer against AgentX** (`inference-sizer/tools/validate-agentx.mjs`): scores and calibrates the sizer on AgentX
  agentic results. It needs the results downloaded from InferenceX.
- Fix: price prefixes match only at a version boundary (`gpt-5` no longer prices `gpt-5.5`).

### New tool: harness-ledger

- **Where agent harnesses waste model resources, across harnesses.** Importers for Claude Code transcripts, Codex
  rollouts, OpenTelemetry GenAI and OpenInference spans, and Langfuse exports write one `llm_call` record per model
  call, with token meanings normalized (cached tokens are part of input). Checks: prompt-cache misses and expiries,
  unread cache writes, oversized tool output carried forward, repeated tool calls, retry loops, failed calls, unused
  tool definitions, and routing calls on a large model (as candidates). Costs come from a price file, the harness's
  recorded cost, or, for self-hosted models, GPU time joined from vLLM's request spans through gpu-ledger's rate card.
  Cost per successful task with `--outcomes`. Records keep counts, names and hashes only.
  `harness-ledger scan | report | import | demo`, HTML report, skill. Token accounting matches ccusage on its Codex
  fixtures.

Vendor-neutral: the tools no longer assume NVIDIA.

### New

- **One accelerator registry** (`inference-sizer/src/accelerators.js`), read by the sizer, FleetScope, the power model,
  serving manifests and Kubernetes inventory; vendor adapters replace the NVIDIA-or-AMD branches. MI325X, MI355X and
  GB300 NVL72 added. InferenceX validation covers 198 runs (#66).
- **GCP and Cloud TPU:**
  - TPU v6e, v5p and TPU7x in the sizer.
  - Serving on GKE TPUs: `vllm/vllm-tpu`, `google.com/tpu`, slice selected by accelerator and topology labels.
  - GKE nodes give project, zone and instance, and scheduled host maintenance is a planned event.
  - gpu-health `gke` and `gcp` platforms: GKE's `fault-behavior` label, `report-host-as-faulty` on Compute Engine.
  - Cloud Monitoring accelerator metrics as telemetry.
  - `gpu-ledger import gcp-billing`.
  - `fleetops procure gcp-calendar`.
- **AWS:**
  - EFA `hw_counters` read as fabric counters. Retransmits, timeouts and impaired connections count as congestion; RDMA errors as errors.
  - EKS nodes give their instance, zone and GPU (from the instance type); the node monitoring agent's `AcceleratedHardwareReady` conditions become faults.
  - gpu-health platforms: reboot and replace act on the EC2 instance; reseat is never proposed. `autoRepair` leaves both to EKS.
  - `gpu-ledger import aws-cur`: GPU-hours priced at what the CUR says was billed.
  - Capacity Blocks and spot in FleetScope's buy-vs-rent plan. `fleetops procure aws-blocks` prints the read-only lookup.
- **AMD at parity:**
  - `amd-smi-static` and `amd-smi-topology` importers (inventory, IFWI, PCI → GPU map; XGMI links);
  - `collect.sh` and `admit-node.sh` on AMD nodes (amd-smi, ROCm Validation Suite, rccl-tests);
  - RCCL version and HIP error lines in job logs.

### Changed (`--json`)

- `sizer list`: `nodeKW` is optional; `kind` and `vendorKey` added.
- `admit check`: the diagnostic check is named `diag` (was `dcgm-diag`). Its evidence names the record (`dcgm-diag` or
  `rvs-diag`). A policy that still lists `dcgm-diag` in `require` keeps working.

## 0.2.0 (2026-11)

From four utilities to one loop: Observe → Diagnose → Simulate → Approve → Optimize → Verify. First release as an npm
package and under a license.

### New

- **fleetops**, the shared data layer under the tools (#29–#42):
  - one store for device telemetry, inventory, jobs, serving metrics and changes;
  - adapters for exporters, Kubernetes, Slurm, change feeds and public traces;
  - a Parquet/DuckDB backend measured at 90M samples;
  - remote_write and OTLP ingest.
- **Root-cause analysis:** rules with evidence, CUSUM detection, a benchmark with fault injection, and logs, topology and versions as signals (#31, #34, #35).
- **Incidents as a workflow:** lifecycle, paging (dry run unless `--live`), timelines and drafted postmortems (#39).
- **Run as a service:** read API, scoped tokens and tenants, audit, redaction, on-prem installers (#40, #41).
- **Live agent** that mitigates within approval guardrails, with a dashboard (#42).
- **Training goodput** and silent-data-corruption detection (#44); **workload profiles** for agents, chat, RAG and others (#45).
- **Tuning from real traces:** recommendations with predicted impact, then measured before/after (#46).
- **Serving:** what fits on given GPUs, what a model carries, one-command vLLM deployment (#47), and disaggregated prefill/decode on llm-d (#52).
- **gpu-ledger**, GPU billing and waste for any cluster:
  - GPU-hours and cost by org, team, person and use case, split into useful, idle and lost;
  - ranked savings with owners;
  - FOCUS 1.4 export (#48).
- **Node admission and staged rollouts** with canary-vs-control checks (#49), **power-aware capacity** with per-job GPU power caps (#50), and **fabric and storage stalls** traced to the port and storage target (#51).
- **Inference Sizer:** a "What fits on my GPUs" view (#53).
- **gpu-health:** early-warning signals, risk triage, multi-vendor support (AMD, SambaNova, Cloud TPU), and a flakiness dashboard (#23, #25–#28).
- **Distribution:**
  - the `aiinfra-tools` npm package and `aiinfra` command (#56);
  - an MCP server (`aiinfra mcp`) for any MCP client (#60);
  - JSON Schemas for the `--json` output (#59);
  - a GitHub Pages site with both browser tools (#57);
  - `aiinfra demo`, the whole loop on a real cluster week (#61);
  - a devcontainer.

### Changed

- **Apache-2.0 license**, with NOTICE, SECURITY.md and CONTRIBUTING.md (#55).
- The skills' copies of the tools are regenerated on `main`; pull requests no longer commit them (#56).
- Rollout checks allow for clustered failures: on a real Philly week, false alarms fell from 17 in 100 to 1 (#49 follow-up).
- Power predictions flag caps under 60% of the limit, where measured slowdowns are more than twice the model's (#50 follow-up).

### Fixed

- `fleetops` and `gpu-health` did nothing when run through npm's bin symlinks (#56).
- Fabric: CNP and ECN counters are read from RDMA `hw_counters` (they aren't `ethtool -S` names). Lustre files read from `/proc` get their target from the path. Lustre `punch` and `sync` no longer count as writes (#51 follow-up).
- The collector test no longer depends on the host's network cards (#54).

See [docs/RESULTS.md](docs/RESULTS.md) for what is checked against real data.

## 0.1.0 (2026-11-20)

FleetScope, the Inference Sizer, hybrid-tracing and gpu-health, packaged as Agent Skills and a Claude Code plugin.
