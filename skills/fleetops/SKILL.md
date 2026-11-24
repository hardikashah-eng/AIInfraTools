---
name: fleetops
description: Finds the root cause of GPU fleet incidents, runs them as incidents, mitigates live, measures training goodput, turns the user's traces into tuning changes, and sizes and deploys vLLM serving. It ingests DCGM, AMD and SambaNova exporters, vLLM metrics, Prometheus, Loki, OTLP, kernel and NCCL logs, NCCL Inspector, PyTorch profiler traces, Slurm and Kubernetes, or a one-command trace bundle. It detects job failures, latency regressions and training slowdowns, hangs and divergence, and ranks causes across 15 rules (hardware, bad change, shared switch or rack, version cohort, straggler, slow link, collective hang, silent data corruption, KV pressure, load, slow replica, storage, workload, monitoring gaps). A live agent mitigates within approval guardrails. It advises checkpoint intervals, pool sizes and more, then measures whether each change worked. Use for why jobs fail, latency regressed, training broke, wasted GPU-hours, NaNs, tuning, live auto-mitigation, what models fit on GPUs, or deploying one.
---

# fleetops

A shared store for GPU fleet data, and the root-cause analysis, incident workflow, calibration and optimization built on
it.

Requires Node.js 20+. Paths are relative to this skill's folder. The CLI is `scripts/fleetops/tools/fleetops.mjs`
(written `fleetops` below: run it as `node scripts/fleetops/tools/fleetops.mjs`). Every command takes `--json` and
`--store DIR` (default `./fleet-data`); use the same `--store` for the whole session. Times are ISO dates or epoch
seconds.

## Rules (always)

- **Fault injection and game days only on a test cluster, and dry run by default.** `inject` and `gameday` print what
  they would run unless `--live` is given. Every target must be in the `--allow` file. Never add `--live`, and never
  write or widen an allowlist, unless the user explicitly asks for a live run on a named test cluster. Show the dry run
  first.
- **Never page without being told.** `incidents page` prints the request unless `--live` is given. Add `--live` only
  when the user asks to send that page.
- **Never approve an optimization stage.** Stages go into gpu-health's approval queue; only the user approves them,
  with their own name in `--by`. `optimize advance` is a dry run unless `--live`. Rollback after a guard breach needs no
  approval; applying a stage always does.
- **`--by` is a person.** Incident transitions record who did them: use the user's name (ask if unknown), never yours.
- **Don't invent causes.** Report the ranked hypotheses, their evidence and what they rule out. Scores rank causes;
  they are not probabilities. When confidence is low or the top two are close, say so and give the confirm steps.
- **Benchmark scores are synthetic.** `rca bench` and `demo` use generated fleets with a planted cause. They show the
  rules work, not accuracy on the user's fleet; that needs `backtest` (postmortems) or `gameday` results.
- **Keep egress closed when asked.** With `--on-prem HOSTS` (or `FLEETOPS_EGRESS_ALLOW`), fleetops refuses outbound
  calls to unlisted hosts. Don't remove it to make a pull work; ask the user to add the host.
- **The live agent stays as it is unless the user says otherwise.** Never add `--live` to the agent, set
  `policy.dryRun` to false, switch an action kind to `auto`, resume a paused agent, or approve its proposals on the
  user's behalf. Report what it proposes and let the user decide.
- **Deploy only when asked, dry run first.** `serving deploy` without `--apply` changes nothing; show that output
  (plan, notes, failed checks) before anyone applies. Add `--apply`, or run `install-serving.sh` without `--dry-run`,
  only when the user asks to deploy to a cluster they name. Never create the Hugging Face Secret or handle the token:
  the user does.
- **Tokens are secrets.** Show a token only once, to the user, and never put one in a file you share or a command you
  echo back.

## Workflow

1. **Get data.**
   - **No fleet at hand:** `fleetops demo --store demo [--scenario NAME]` writes a fleet with one planted cause and
     prints the commands to try and the answer to check against. `demo --list` names the 18 scenarios.
   - **Files:** `fleetops data import SOURCE FILE… --store S`. Sources include `exporter` (DCGM, AMD, SambaNova text),
     `vllm`, `prom-range`, `kernel-log` (journalctl, dmesg, syslog), `app-log` (NCCL, PyTorch), `nccl-inspector`,
     `kineto`, `step-log`, `sacct`, `k8s-nodes`, `k8s-pods`, `k8s-events`, `helm-history`, `slurm-nodes`,
     `nvidia-smi-q`, `nvidia-topo`, `ibnetdiscover`, `racks`, `otlp-traces`, `changes`, `git-log` and `gpu-health`.
     `fleetops --help` lists each one's options.
   - **The fleet's own monitoring:** `fleetops pull --from T --to T --prom URL [--loki URL] [--header 'Authorization:
     Bearer …']` fetches DCGM, AMD, vLLM and NCCL Inspector series and kernel and NCCL logs for a window.
   - **Streaming:** `fleetops serve` takes Prometheus remote_write and OTLP over HTTP (protobuf or JSON) and answers a
     read API for Grafana. See [references/SERVICE.md](references/SERVICE.md).

   Check what arrived with `fleetops data summary --json`. Record kinds are in
   [references/DATA-LAYER.md](references/DATA-LAYER.md).

2. **Find and diagnose.**
   ```bash
   node scripts/fleetops/tools/fleetops.mjs rca detect --from T --to T --diagnose --store S --json
   node scripts/fleetops/tools/fleetops.mjs rca diagnose --symptom job-failures --from T --to T [--nodes n1,n2] --store S --json
   ```
   - Symptoms: `job-failures`, `latency` (`--pool P`), `training-slow` and `training-hang` (`--job J`), `device`.
   - `detect` uses seasonal baselines and CUSUM. On a small fleet, lower `--min-failures` (default 20). Latency
     targets go in `--targets targets.json` (`{ "chat": { "ttftP99": 1.0 } }`).
   - The JSON has `incidents[]`, each with `confidence`, ranked `hypotheses` (`rule`, `score`, `title`, `evidence`,
     `against`, `confirm`), the rules that were ruled out, and a `narrative` written only from the top hypothesis'
     evidence.
   - `fleetops data node NODE --from T --to T` shows one node's versions, shared switch, rack and PDU, log faults and
     changes, for a follow-up question.

3. **Explain.** Lead with the top cause, its confidence and the evidence behind it (records with times). Then what
   argues against it, the runner-up if close, what was ruled out, and the `confirm` steps. Rules and thresholds are in
   [references/RCA.md](references/RCA.md); training and serving traces in [references/TRACING.md](references/TRACING.md).

4. **Run it as an incident** (when asked to track, page or write up).
   - `incidents open --from T --to T` detects, diagnoses and opens the new incidents, with severity from their size.
   - `incidents ack|mitigate|resolve|reopen|assign|severity|note ID --by NAME`. `resolve --cause RULE --component X`
     stores the confirmed cause as a label for later scoring.
   - `incidents page ID --to pagerduty|opsgenie|webhook --action trigger|ack|resolve`: a dry run unless `--live`.
   - `incidents postmortem ID --out pm.md` drafts the postmortem; `incidents timeline ID --out t.html` writes a page
     with one time axis. Details in [references/INCIDENTS.md](references/INCIDENTS.md).

5. **Measure accuracy** (when asked whether to trust it).
   - **Postmortems:** one JSON line per confirmed incident,
     `{ "incident": { "id", "symptom", "from", "to", "pool"?, "nodes"? }, "cause": "<rule>", "component"? }`. Run
     `fleetops backtest --labels pm.jsonl --prom URL [--loki URL]`. Each miss names the incident. Example:
     `scripts/fleetops/examples/postmortems.example.jsonl`.
   - **Game days:** a plan (example `scripts/fleetops/examples/gameday-plan.example.json`) and an allowlist (example
     `scripts/fleetops/examples/test-cluster.allow`). `fleetops gameday plan.json --allow FILE` checks every step against
     the allowlist before any runs, prints the commands, and scores detection and diagnosis after a live run.
     `fleetops inject list` shows the faults.
   - **Confirmed incidents:** `rca bench --from-incidents`. Fit rule weights on labels with
     `rca bench --labels pm.jsonl --fit weights.json`; it reports held-out accuracy. Pass `--weights` afterwards.
   - **Synthetic:** `rca bench --per-cause 10 --json` gives top-1 and top-3 per scenario. Methods and results are in
     [references/BENCHMARK.md](references/BENCHMARK.md).

6. **Calibrate capacity models** (FleetScope and the Inference Sizer, vendored here).
   `calibrate benchmarks` fits to MLPerf or benchmark_serving records; `calibrate serving --graph G` fits each FleetScope
   pool to serving records with a held-out check; `calibrate drift` flags when new data leaves the fit. See
   [references/CALIBRATION.md](references/CALIBRATION.md).

7. **Optimize safely** (when asked to cut cost).
   - `optimize candidates`: right-size, scale-in and reclaim from gpu-health, retry storms from RCA, pool sizes from
     FleetScope.
   - `optimize plan --candidates c.json --out plan.json --save-pct 20 --max-risk medium` stages a set that meets the goal
     and queues each stage for approval.
   - The user approves each stage: `node scripts/gpu-health/tools/gpu-health.mjs actions approve ID --by NAME --state DIR`
     (DIR defaults to `<store>/rollouts/state`). Then `optimize advance --plan
     plan.json` checks the last stage's SLO guard (rolls back on breach) and runs the next approved stage, dry run
     unless `--live`. `optimize verify` compares before and after. See [references/OPTIMIZE.md](references/OPTIMIZE.md).

## Tuning from the user's traces

Use this when asked whether the infrastructure could be tuned, what to change, or whether a change worked.
1. **Get the traces in:**
   - a bundle: `scripts/fleetops/tools/collect.sh` run by the user on a node, then
     `fleetops data import bundle FILE`;
   - loose files: `fleetops data import auto FILE…`;
   - or pull or stream.

   The collector is read-only, but the user runs it on their machines. Remind them that kernel and application logs go
   in as they are.
2. **Recommend:** `fleetops tune --days 7 [--pools pools.json] [--targets t.json] --json`.
   - Give the top recommendations with their evidence, the change, the expected effect and its basis. Say "upper
     bound" and "uncalibrated" when the report does.
   - Pass on the report's list of missing data: it says what would unlock more.
   - Pool sizing needs `--pools` (model, GPU and current GPUs per pool; `fleetops tune models` lists ids). Ask for it
     rather than guessing.
3. **Check before changing:** `fleetops tune holdout --from … --split … --to …` reports which premises held out of
   sample.
4. **After a change:** the user records it with `fleetops tune apply ID --by THEIR_NAME`. A week later,
   `fleetops tune verify --json` gives the verdict, the interval, and measured against predicted. Before/after is not
   an experiment: mention anything else that changed in the window.

Without data, `fleetops demo --training --days 14 --tuned-at 7` gives a store where two changes were applied
mid-way. Method and results: [references/TUNE.md](references/TUNE.md).

## Serving: what fits, capacity, deploy

Use this when asked which models fit on some GPUs, how much a model can serve, or to deploy one.
- **Which models:** `fleetops serving fit --gpu G --nodes N [--rate R] [--isl --osl] [--ttft --tpot] --json`. Ids:
  `serving gpus`. With `--rate`, rows with `meetsRate` carry it, largest first. Size is a capability proxy, not a
  quality score: say so, and suggest evaluating the top two or three.
- **How much:** `fleetops serving capacity --model M --gpu G --nodes N --json` gives `production.rate` (with headroom,
  an N+1 spare and a margin), `edge.rate` (none), the layout, concurrency and `maxPrompt`.
- **The workload:** ask for prompt and output lengths and the latency targets, or measure them from request records
  with `--from-pool P`. The defaults (2000/400 tokens, 2 s / 50 ms) are placeholders: say when you used them.
- **Deploy:** `fleetops serving deploy --model M --gpu G --nodes N [--hf-secret S] [--cache-pvc P] [--autoscale]` is a
  dry run that prints the plan, the manifests and the cluster checks. The user (or you, when asked) runs it with
  `--apply`, or `scripts/fleetops/install/install-serving.sh`. Relay its notes: image tag, weights cache, gated models,
  disaggregation. `--mode disagg` (or `auto`) renders prefill and decode pools on llm-d (DisaggregatedSet, NIXL, the
  llm-d router chart); it needs LeaderWorkerSet ≥ 0.11.1 and the InferencePool CRDs (`--install-prereqs` in the script),
  and works best with RDMA between the nodes: say so.
- **Say:** the numbers are spec-sheet estimates unless calibrated (`fleetops calibrate`); a load test against the
  endpoint confirms them. Details: [references/SERVING.md](references/SERVING.md).

## Goodput and silent data corruption

- **Goodput** (where training GPU-hours went; asked as "are we wasting GPUs", "how often should we checkpoint"):
  `fleetops goodput --days 7 [--job J] [--format html --out goodput.html] --json`. Lead with the fleet's goodput and
  its biggest loss, then the jobs with the most badput and what to do. The categories:
  - slow steps: look at stragglers and slow links;
  - waiting on data: the input pipeline;
  - lost work: checkpoint more often;
  - restarts: faster load or warm spares.

  Give the checkpoint advice with its numbers: save cost, interruption interval, now vs best, GPU-hours a week. When
  the report says jobs have no step records, say the goodput is an upper bound. Without data, use
  `fleetops demo --training` first. Method: [references/GOODPUT.md](references/GOODPUT.md).
- **Silent data corruption** (asked as "loss spiked / NaN", "is a GPU corrupting training"): `fleetops sdc --json`.
  Report each GPU's verdict and evidence. Confirmed means a failed canary or replay, or a checksum minority twice.
  Report the checkpoint to resume from for each job, and that later checkpoints may be corrupted. Suggest
  `scripts/fleetops/tools/sdc-canary.py` on the node to confirm; it needs GPUs and PyTorch. Inputs and limits:
  [references/SDC.md](references/SDC.md).

## Live agent and dashboard

Use this when asked to watch the fleet continuously, mitigate in real time, or show a live dashboard.

- **Start it:** `fleetops serve --agent [--targets t.json] [--agent-config a.json]` runs the agent every 30 s and serves
  the dashboard at `/live`. `fleetops agent --once` runs one check. Without a fleet, use
  `fleetops demo --scenario slow-link --now --store demo` first.
- **It is a dry run by default (shadow mode).** It opens incidents, decides, logs "would run", and checks whether each
  incident cleared on its own. Commands run only with `--live` and `policy.dryRun: false`, and only for action kinds
  the policy makes `auto`.
- **What it does per cause, and its guardrails,** are in [references/AGENT.md](references/AGENT.md):
  - confidence decides how far it goes;
  - a monitoring gap freezes it;
  - cordons and autonomous changes per hour are capped;
  - pause stops it.
- **Report:**
  - `fleetops agent status --json` gives incidents with the agent's decision, actions waiting for approval, and
    autonomous actions this hour;
  - `fleetops agent log --json` gives its decisions.
  - Explain each decision with its confidence. For waiting actions, say what each would run and why. A person
    approves with `fleetops agent approve ID --by THEIR_NAME` or the dashboard's button.
- **Real-time inference mitigation:** `scripts/fleetops/examples/agent-policy.realtime.json` lets it drain slow replicas
  and scale pools out on its own. Suggest it only when the user asks for more autonomy, and point out what it changes.

## The rules (causes)

| Rule | Points at |
|---|---|
| `hardware` | failures piled on a few nodes with fault codes, health events or offline time |
| `change` | a driver, firmware, config or deploy change shortly before onset |
| `shared-component` | the failing nodes share a leaf switch, rack or PDU |
| `version-cohort` | the failing nodes share a driver, firmware or kernel version the healthy ones don't |
| `infrastructure` | many owners and nodes failing at once on healthy devices: storage, network, scheduler |
| `workload` | one owner or namespace holds most of the failures |
| `straggler` | one rank's compute is slow and the job waits for it |
| `slow-link` | one node's NCCL bus bandwidth is well below the others' while its compute is normal |
| `collective-hang` | a rank never joins a collective; the watchdog fires |
| `kv-pressure` | KV cache full during a latency regression, with preemptions |
| `load` | request rate or prompt length above baseline |
| `replica-tail` | one serving replica is slow |
| `slow-stage` | one stage (such as prefill) slowed on every replica |
| `silent-corruption` | one GPU computing wrong answers: replicas that disagree, failed canary or replay, first NaN |
| `monitoring-gap` | far fewer devices reporting than before: blame the monitoring first |

## Installing

One command each; all make hashed tokens and print the Prometheus, OpenTelemetry and Grafana settings to paste:
- one machine as a user service: `scripts/fleetops/install/install.sh` (`uninstall.sh` keeps data unless `--purge`);
- Docker Compose with Grafana provisioned: `scripts/fleetops/install/install-docker.sh`;
- Kubernetes: `scripts/fleetops/install/install-k8s.sh --image REGISTRY/fleetops:TAG [--build] [--dry-run]`.

Run an installer only when the user asks to install, and show `--dry-run` output first for Kubernetes. Options and
what has been tested are in [references/INSTALL.md](references/INSTALL.md); capacity and the Parquet backend in
[references/SCALE.md](references/SCALE.md).
