---
name: gpu-health
description: Checks GPU and accelerator fleet health and efficiency from NVIDIA DCGM, AMD, SambaNova or Google Cloud TPU telemetry, including mixed fleets. It finds failing and soon-to-fail devices from XID and vendor fault codes, ECC and row-remap trends, HBM temperature, throttling, power brake, PCIe/NVLink/XGMI errors, telemetry gaps and silent data corruption. It also finds flaky GPUs that keep failing after repair, repairs that don't hold and groups of GPUs that fail together. It finds stragglers slowing training, idle or oversized GPU allocations with $/week savings, ranks failure risk and measures fragmentation. It proposes fixes (quarantine, diagnostics, reset, drain, swap at checkpoint, scale in, reclaim) in an approval queue, and runs approved fixes as a dry run unless explicitly made live. Use for GPU health checks, deciding which GPUs to quarantine or repair, GPU utilization, waste and savings reports, finding stragglers, or acting on GPU alerts in NVIDIA or AMD clusters.
license: Apache-2.0 (see LICENSE.txt)
---

# GPU health

Analyzes GPU telemetry, explains what is wrong or wasted, and manages an approval queue of fixes.

Requires Node.js 20+. Paths below are relative to this skill's folder. The CLI is `scripts/gpu-health/tools/gpu-health.mjs`; every command takes `--json`. State (the action queue, audit log and last analysis) is kept in `--state DIR`, default `./gpu-health-state`. Use the same `--state` for every command in a session.

## Rules for acting on a cluster (always)

- **Never approve an action on the user's behalf.** Approve only the action ids the user names, and only after they say to. Record their name with `--by` (ask for it if unknown). Never pass your own name.
- **Never run anything for real unless the user explicitly asks.** Execution is a dry run unless both locks are open: `--live` on the command line, and `"policy": {"dryRun": false}` in the config. Do not set either one unless the user explicitly asks for live execution and confirms the specific actions. Show the dry-run commands first.
- **Don't edit the policy to get around approval.** Don't change `policy.actions` modes, limits or executors to get past an approval or a limit. If a limit refuses an action, report it.
- **Don't work around a refusal.** If the queue refuses an action (it's stale, or over a blast-radius limit), say why and suggest re-running `analyze`. Don't run the kubectl or ssh commands yourself instead.

## Workflow

1. **Get telemetry.**
   - Normalized JSON lines: `--samples FILE`.
   - Saved exporter scrapes (dcgm-exporter, AMD device-metrics-exporter or SambaNova's exporter, as Prometheus text): `--prom FILE[,FILE]`. The vendor is detected from the metric names; `--vendor` forces it.
   - Cloud TPU: JSONL samples from `scripts/gpu-health/tools/tpu-collect.py`, run on each TPU VM.
   - A jobs file (`--jobs`, from the scheduler) is needed for efficiency, savings and owner notices.
   - Optional:
     - `--steps`: per-rank step timings, for stragglers;
     - `--probes`: benchmark results;
     - `--results`: diag results, SDC events from the training loop, and fault events from logs or a vendor's fault manager (`{ t, kind: "fault", node, gpu, code }`);
     - `--cluster`: allocation snapshot, for fragmentation;
     - `--config`: prices, thresholds and policy.

   Formats are in [references/OVERVIEW.md](references/OVERVIEW.md#inputs). With no data, `demo --json` builds a 32-GPU demo fleet with planted problems, and `demo --mixed --json` an AMD, SambaNova and Cloud TPU fleet.

2. **Analyze.**
   ```bash
   node scripts/gpu-health/tools/gpu-health.mjs analyze --samples samples.jsonl --jobs jobs.json --state ./gh --json
   ```
   The JSON has these fields:
   - `summary`: fleet size, effective utilization, idle GPU-hours, savings $/week, states.
   - `gpusNotServing`: each GPU with its state, why, and the signal keys behind it.
   - `recommendations`: per job, with lever, action, $/week, confidence and an explanation.
   - `risk`, `fragmentation`, `partitionPlan` and `jobUsage`.
   - `coverage`: per vendor, the health checks its telemetry supports and the ones it is blind to.
   - `openActions`: the queue.

3. **Explain.** Start with what needs attention now: quarantined GPUs and what they affect. Then:
   - suspect GPUs and why (each signal has a reason string);
   - the biggest savings.

   Explain the verdicts in plain terms:
   - Effective utilization is max(tensor-active, HBM-bandwidth-active).
   - A memory-bound decode job with low tensor use is healthy, not waste.
   - "Starved" means more GPUs won't help: fix the input pipeline.
   - Savings computed from driver-reported memory are an upper bound.

4. **Propose.** List the open actions the user might approve, with id, mode, what it does and why.
   - Actions in `auto` mode were approved by policy and are dry-run only.
   - Actions in `never` mode are suggestions only and cannot be approved.
   - To see the exact commands, approve nothing and run `actions execute --json`. It shows dry runs of the actions that are already approved.

5. **Approve and run, only when told.**
   ```bash
   node scripts/gpu-health/tools/gpu-health.mjs actions approve swap-at-checkpoint:train-llm@n1/3 --by "Their Name" --state ./gh --json
   node scripts/gpu-health/tools/gpu-health.mjs actions execute swap-at-checkpoint:train-llm@n1/3 --state ./gh --json
   ```
   Each result has an `outcome` of `dry-run`, `done`, `failed` or `skipped`, with the commands and output. Rejections are `actions reject ID --by NAME --reason TEXT`.

6. **Report.** For a shareable weekly report:
   - `report --format html --out report.html` (or `--format md`) writes it.
   - `receipt JOB --json` shows what one job was given vs what it used.
   - `serve` starts an approval page for people, with per-person tokens.

## Mixed and non-NVIDIA fleets

- **Say what can't be seen.** When `coverage` lists blind checks for a vendor (Cloud TPU and SambaNova report no temperature, power or ECC), say so when you report that vendor's devices as healthy, and suggest diags, probes or fault events to cover the gap.
- **Repairs differ by vendor.** The queue only proposes what the platform can do: `amd-smi` resets on AMD, a person with SNFM on SambaNova, and on Cloud TPU no device reset at all (restart or recreate the TPU VM, then a support case). Steps a person must do are webhook messages that say what to do. Don't suggest commands outside the queue to make up for it.
- Vendor profiles, fault codes and how to add a vendor are in [references/VENDORS.md](references/VENDORS.md).

## Flakiness

Use this when asked which GPUs keep failing, whether repairs are working, or whether failures share a cause.

```bash
node scripts/gpu-health/tools/gpu-health.mjs flakiness --state ./gh --json
node scripts/gpu-health/tools/gpu-health.mjs flakiness --state ./gh --format html --out flakiness.html
```

The JSON has `totals`, `devices` (the top 20 by score, each with a `verdict`), `repairs`, `hotCohorts` and `badput`.

1. **Lead with the verdicts.** Report RMA candidates first, then flaky GPUs, each with its counts: exits, bounces (failed again within a week of coming back), diag passes followed by a failure, and device-caused job failures.
2. **Repairs.** Point out repair kinds marked "rarely holds". For that fault class the next ladder step is the better first step. Say when there are too few repairs to judge.
3. **Cohorts.** A flagged node, site, SKU or firmware means look for a shared cause before replacing parts one by one.
4. **Limits.** History only covers the time gpu-health has been running. Job-failure cost is estimated unless the job-end results carry `lostGpuHours`. Say so when it matters.
5. **Propose, don't act.** RMA and other changes still go through the action queue and its rules. Thresholds are in [references/FLAKINESS.md](references/FLAKINESS.md).

## Risk triage

Use this when asked which GPUs are likely to fail, whether a GPU is safe for a critical job, or where to place one.

1. **Rank.** Run `analyze` as above. The `risk` list in the JSON holds up to 10 GPUs scoring 0.05 or more, highest first. Each has `score`, `tier` (low below 0.2, medium below 0.5, high from 0.5) and `why`. GPUs already quarantined, in repair or in RMA are left out.
2. **Explain.** Give the top GPUs' `why` strings in plain terms, strongest first. The score is a rules-based ranking, not a calibrated failure probability: use it to compare GPUs, and never present it as "an X% chance of failing".
3. **Keep critical work on low-risk GPUs.**
   - Critical or large synchronous jobs: only `serving` GPUs that are tier `low` or not in the list.
   - Tier `medium`: preemptible or checkpointed work.
   - Tier `high`: the queue already proposes `avoid-large-jobs` and `deep-diag-next-boundary`, plus `swap-at-checkpoint` or `drain-inference` for jobs on it.
   - A job's exposure: estimate it as 1 − ∏(1 − score) over its GPUs, counting GPUs missing from the list as 0. Present it as a rough comparison between placements, not a probability.
4. **Propose, don't act.** List the relevant open action ids with what each does. The rules for acting on a cluster above apply.
5. **Finding weak GPUs.** If asked for a burn-in or a test that finds GPUs likely to fail, use the test suite in [references/RISK-PREDICTION.md](references/RISK-PREDICTION.md#test-workloads-that-find-weak-gpus). Its results go back in through `--probes` and `--results`. Calibrated tiers, job risk budgets and the learned model in that file are planned, not built: say so if asked for them.

## What the GPU states mean

- `serving`: the GPU takes new jobs.
- `suspect`: soft signal. The GPU finishes its current job, gets a deep diag, and takes no new jobs.
- `quarantined`: hard fault or no data. No new jobs, diag, and repair through the ladder:
  1. reset;
  2. reboot;
  3. RMA.
- `remediate`: the GPU is on a repair step.
- `burnin`: being tested after repair.
- `ready`: burn-in passed; waiting for a person to approve `release`.
- `rma`: second failure within 30 days of a fix.

**Circuit breaker:** if more than 20% of the fleet stops reporting at once, states are held and monitoring is blamed. Report this prominently.

Signals, thresholds, persistence (3 of 4 hourly windows), peer comparison and policy are covered in [references/OVERVIEW.md](references/OVERVIEW.md) and [references/CONFIG.md](references/CONFIG.md). Example config: `scripts/gpu-health/examples/config.example.json`. Kubernetes RBAC for the default executors: `scripts/gpu-health/deploy/rbac.yaml`.
