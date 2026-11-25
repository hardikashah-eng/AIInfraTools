# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may
change the `--json` output, and when it does the change is listed here (see [schemas/](schemas/README.md)).

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
