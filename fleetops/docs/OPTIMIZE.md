# Optimization with safe execution

`fleetops optimize` turns what the other tools already know into changes, and rolls them out without ever applying one
that a person has not approved.

```
candidates ──► select (goal, risk, protection, one change per resource) ──► plan (stages + guards + undo)
                                                                              │
          gpu-health approval queue ◄── every stage proposed, mode approve ◄──┘
                 │ approve (a person)
                 ▼
          advance: guard of the last stage ok? ── no ──► roll back to the last verified state (no approval needed)
                 │ yes
                 ▼
          run the next approved stage (dry-run unless --live and policy.dryRun:false) ──► verify after the rollout
```

## Candidates

| Source | What it proposes | Savings counted as |
|---|---|---|
| gpu-health | right-size, scale-in, reclaim idle allocations, notify owners | gpu-health's own estimate. Owner notifications are reported separately ("if the owner acts") and never count toward the goal |
| rca | cap retries for a tenant whose retry storm was diagnosed (stored `incident` records whose top cause is `workload`) | GPU-hours of the failing attempts beyond `--max-attempts` (default 2) per job; the first attempts still run |
| FleetScope | the cheapest version of a graph that still meets the SLO target, using FleetScope's optimizer on the (calibrated) graph, optionally replaying the store's own requests (`--trace-pool`) | FleetScope's simulated cost per hour × 168 |

## Selection

- Candidates are ranked by savings weighted by risk (low ×1, medium ×0.8, high ×0.5).
- Each resource (a job, a tenant, a graph) gets at most one change. This is what keeps savings from double-counting: two
  proposals for the same job can't both be counted, and FleetScope's pool changes come from one joint simulation.
- Excluded, with the reason kept in the plan:
  - protected classes (training by default; a notification is never blocked, because it changes nothing);
  - risk above `--max-risk` (default medium);
  - a FleetScope result that misses the SLO target.
- `--save-pct N` stops once firm savings reach N% of the fleet's weekly cost and reports whether the goal was met. The
  weekly cost is GPUs in the inventory × 168 h × price.

## Stages and guards

- **Scale-in and pool shrinks go in steps.** The first step removes one replica as a canary; each later step removes
  at most half the gap. Example: 16 → 15 → 10 → 6.
- **A GPU-type change is one stage** (new hardware).
- **Retry caps and owner notifications** are webhook messages. All notifications share one digest stage.
- **Commands come from gpu-health's executor templates**, filled with its value checks. A value that isn't a plain name
  (`embed; rm -rf /`) stops the plan before anything is queued. `--deployments` maps FleetScope pool ids to Kubernetes
  deployments; without a mapping a stage becomes a webhook message to whoever runs that pool.
- **A guard** is `{ pool, metric, limit }` or `{ pool, metric, maxRegression }`, read from `serving` records after the
  stage's bake time. `--guards` keys guards by resource (`job:NAME`, `pool:ID`) with `default` as a fallback.

## Rollout

- `plan` writes every stage to gpu-health's queue (default `<store>/rollouts/state`) as `proposed`, mode `approve`.
- People approve stages with gpu-health's CLI or approval page:
  `gpu-health actions approve rollout-stage:PLAN#N --by NAME --state DIR`. Every approval is its own: approving stage 1
  never lets stage 2 run.
- `advance` does one step:
  1. **While the last applied stage is baking**, it waits.
  2. **After the bake time**, it checks the stage's guard against the serving records.
     - **The guard fails:** every stage applied since the last verified one is undone, newest first, without waiting
       for approval. The rollback is recorded in the audit log.
     - **No data:** it waits. It never goes on blind.
     - **The guard passes:** the stage is marked verified.
  3. **The next stage** runs only if it is approved; otherwise `advance` says which command approves it.
- Commands run through gpu-health's executors: argv only, never a shell. They are dry-run unless both `--live` is
  given and gpu-health's `policy.dryRun` is `false`.
- Run `advance` from cron or a CI schedule. Exit code 4 means the plan was rolled back.

## Verify

`verify` compares the window before the first stage with the same length after it:
- allocated GPU-hours, from placements;
- guard breaches, from serving records.

It writes an `optimization` record. "Verified" means fewer GPU-hours and no more breaches.

## Results on public data

These runs mix two public datasets in one store, so the dollar figures show the mechanics rather than one real
fleet. Prices are a flat $4 per GPU-hour.

- **Philly (rca).** Six diagnosed failure spikes point to one namespace, 6214e9.
  - Its 2,737 jobs ran 11,817 failing attempts, using 28,686 GPU-hours in 6.9 days.
  - Capping at two attempts per job avoids 6,688 attempts but only 1,736 GPU-hours, about $7,000 a week. Most late
    retries fail within minutes, so the waste is in the count of attempts more than in GPU time.
- **Philly (gpu-health).** 21 idle allocations, all training jobs. They are not changed, only notified: up to $7,800 a
  week if the owners act.
- **Azure conversation trace (FleetScope).**
  - The graph replays the busiest 10 minutes of the trace: 4,419 requests, 18:40–18:50 UTC.
  - It uses one H200 pool for Llama 70B, with the MLPerf-fitted H200 decode multiplier (×0.967). The prefill fit
    didn't converge (see [CALIBRATION.md](CALIBRATION.md)), so prefill stays at the spec-sheet value.
  - FleetScope's optimizer shrinks the pool from 16 instances to 6: SLO attainment 99.9% → 99.5% against a 99% target,
    $3,360 a week.
- **Plan.** $10,400 a week firm, up to $18,200 if the notified owners act. That is 0.6% of the Philly cluster's $1.67M
  weekly cost, so a 20% goal is reported as not met. The plan has five stages: the notification digest, the retry cap,
  and 16 → 15 → 10 → 6.
- **Rollout, dry-run.** Stages 1–3 were approved through gpu-health's CLI and advanced. The rollout then held at stage 3
  because the store has no serving latency for that pool. The regression and rollback path is covered by
  `tests/optimize.test.mjs`.
