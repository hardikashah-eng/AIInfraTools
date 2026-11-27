# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may
change the `--json` output, and when it does the change is listed here (see [schemas/](schemas/README.md)).

## Unreleased

### Plan → verify → account, and what agents can call

- **`aiinfra report`:** one page from what the tools already keep in a fleetops store: the Inference Sizer's GPU count
  before and after the store's calibration, the last shadow verdict with prediction against measurement, the last
  promotion, each canary's share and any step waiting for a person's approval, and agent economics (cost per resolved
  task, self-hosting sized with the calibration, tokens per MW). Text, Markdown or `--json`; `--demo` runs it on demo data.
  It only reads. Shadow verdict records now keep the prediction rows so the report can show them.
- **KV offload in the sizing:** FleetScope's agentic sizing reports what LMCache-style offload to host memory would do:
  the GPU count with the cold part of the KV working set in host memory (375 GB per GPU by default, AgentX's 3 TB per
  8-GPU server), the PCIe reload time for a returning session, and PCIe load at the peak minute. `--kv-offload` (on
  `harness-ledger economics` and `agentic.mjs size`) uses it when a reload fits the TTFT target and PCIe stays under 80%.
- **Tokens per megawatt** next to every agentic GPU count: peak output tokens/s over provisioned power, from published
  node power, or the GPU's board power when none is published.
- **New `--json` contracts:** `fleetops.shadow.compare`, `fleetops.shadow.prom`, `fleetops.shadow.canary`,
  `harness-ledger.economics` and `aiinfra.report`. `harness-ledger.economics` gains `offload`, `kvOffloadUsed` and
  `power` under `selfHost`; `sizer.list` GPUs gain `tdpW`. Both changes add fields only.
- **MCP tools:** `shadow_verdict`, `canary_status`, `agent_economics` and `infra_report` (20 tools). None of them can
  advance or approve a canary.

### Code quality

- **fleetops CLI split:** `tools/fleetops.mjs` now only parses and dispatches. Each area's commands live in
  `tools/cmd/<area>.mjs`, unchanged.
- **Branch coverage floors** go from 70% to 80% in every package except fleetops, which goes to 77%. New tests cover
  the least-covered branches, mostly the command lines and their errors.
- **Fixed:** gpu-ledger read a time it couldn't parse as NaN instead of no time, so a CSV row with an unreadable start
  was kept. Such a row is now dropped.

- **Lint gate:** ESLint recommended rules on every pull request (`eslint.config.mjs`, `.github/workflows/lint.yml`),
  starting from zero findings.
- **Removed:**
  - four exports nothing used (`STATES`, `slowRequests`, `NUM_FIELDS`, `knownPlatforms`, and the helper behind the last);
  - 20 unused locals and imports;
  - a no-op self-assignment in the sizer UI;
  - nine needless regex escapes;
  - a literal byte-order mark in a regex.
- **One copy of fleetops' statistics:** `fleetops/src/stats.mjs` replaces 11 copies of median, percentile and the seeded
  generator. Each copy's exact behaviour is kept, so no result moved.
- **Weekly format check:** `scripts/check-formats.mjs` and `.github/workflows/formats.yml`.
  - Its first run found that the Argo Rollouts schemas had been vendored from v1.9.3 while v1.10.2 is current. They are
    refreshed; the manifests pass both.

### Integrations, and the loop between the tools

- **OpenCost:** `harness-ledger economics --opencost FILE|URL` (its `/inferenceCost/total`) or `--opencost-prom URL` (its
  `llm_cost_per_million_tokens` and `llm_cache_savings_fraction` gauges) uses OpenCost's measured self-host cost per token.
  - The price per delivered input token is turned into a price per prefilled token.
  - A deployment whose label join failed (zero cost) is explained, not used.
- **NVSentinel:** `fleetops data import nvsentinel` reads its health events: event-exporter CloudEvents, datastore
  documents, HealthEventResource objects and bare events, with XIDs classified through gpu-health's table.
  - Root-cause analysis uses them as evidence.
  - gpu-health defers to NVSentinel on nodes it is remediating: one informational `external-remediation` action instead
    of a second repair ladder (`deferToExternal: false` to turn this off).
- **llm-d canaries:** `fleetops shadow canary start|advance|approve|status` steps two LLMInferenceServices' route weights
  by the judge's verdict.
  - A rollback is written at once with `--live`.
  - A step up is queued for a person and written only after `approve --by NAME`.
  - Manifests and patches are checked against KServe's CRD schema (v1alpha2, vendored).
- **The loop:**
  - `shadow plan` records its configs.
  - `compare` and `prom` with `--plan` refit the candidate's sizer efficiencies when the prediction was off by more than
    15%, into `<store>/calibration/sizer.json`. `shadow plan`, `inference-sizer --calibration` and
    `harness-ledger economics --calibration` read it.
  - Promoted changes are recorded in `<store>/shadow/promoted.jsonl`.
- `shadow prom` takes `--plan` (prediction vs measurement, as `compare` does).
- **Recovered:** the agent unit economics work (`harness-ledger economics`, `validate-economics`) had been merged into a
  feature branch instead of `main`; it is included here.

### Shadow upgrades inside the rollout tools

- **`fleetops shadow prom`** judges a canary from its own per-version vLLM metrics in Prometheus (llm-d controlled
  deployments' `llm_isvc_name`, Argo Rollouts' pod-template hash, Flagger's `app` label, or any label matchers).
  - Each canary window is compared with what the baseline shows at the same load per engine, prompt length and cache
    hit (a local fit on the baseline's own history), with an interval and a verdict. Per-version means are shown beside it.
  - On synthetic canaries at half or a quarter of the baseline's load, the effect lands within 1 point of the truth
    where per-version means say 20–33% faster.
  - `--save` keeps the series; `--file` reruns them; `--demo` shows the trap.
- **`fleetops shadow serve`** runs the judge as a service for Argo Rollouts (an AnalysisTemplate web metric) and
  Flagger (`rollout` and `confirm-promotion` webhooks): promote, rollback or wait.
  - Manifests in `fleetops/deploy/shadow-gate/`, checked against the real CRD schemas (Argo Rollouts v1.10.2, Flagger
    v1.45.0, Prometheus Operator v0.95.2).
  - Selectors are checked as label matchers before any query is built.
- **`fleetops/deploy/shadow-live/`**: a kit that runs everything on three 1-GPU L4 nodes against real vLLM engines
  (paired replay, an in-cluster canary, the judge). Not run yet.
- `shadow replay` takes `--max-isl` / `--max-osl` to fit long agent sessions to a small model's context.
- `compare`'s decision logic is shared (`decide`); with no latency data at all the decision is now *extend the test*,
  not *promote*.

### Agent unit economics

- **`harness-ledger economics`** reports what a successful agent task costs and what changing it is worth.
  - **Cost per resolved task** and the share of spend on failed tasks.
  - **Fixes ranked by what they save per resolved task:** each waste cause, plus a step cap computed exactly from each
    session's calls.
  - **Self-hosting vs the API:** the same workload sized with the Inference Sizer for an open model (FleetScope's agentic
    path: real arrivals, cache reuse, the KV working set; busiest day's peak).
    - The result is a break-even GPU-hour price per resolved task, and with `--gpu-rate` the volume from which
      self-hosting wins.
    - `--self-host-price` uses measured prices (OpenCost) instead.
    - `--self-host-success-rate` and `--token-scale` (calls per task) carry the open model's quality and verbosity.
- **`validate-economics`** on TraceLab's workload with SWE-bench success rates (`docs/VALIDATION-ECONOMICS.md`; a CI job
  in `validate.yml`).
  - One team's volume (about $5,600 a month of API spend at Sonnet-class prices) favours the API: self-hosting pays only
    below about $0.25–0.50 a GPU-hour.
  - At $3 a GPU-hour on B200, self-hosting wins from about 8–16× that volume.
  - Half the calls exceed the open models' 128k context.

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
