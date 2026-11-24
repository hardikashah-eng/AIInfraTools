# Training goodput

`fleetops goodput` answers "how much of the GPU time we paid for turned into training progress we kept?" It splits
every training allocation into goodput and the badput categories below, per job, per team and per day. It then works
out each job's best checkpoint interval from the interruption rate measured on your own fleet.

```bash
fleetops goodput --days 7                                # Markdown: fleet, jobs, teams, checkpoint advice
fleetops goodput --days 7 --format html --out goodput.html
fleetops goodput --job pretrain-70b --json
fleetops demo --training --store demo && fleetops goodput --days 7 --store demo     # a week with planted badput
```

The same report is served at `GET /api/goodput?format=html` (unscoped or infra tokens). It also feeds a "training
goodput, last 24 h" tile on the live dashboard.


## Where each GPU-second goes

Each attempt of a job is a placement: GPUs held from start to end. Its wall time × GPUs is split eight ways, and the
eight add up to the allocation:

| Category | What it is | From |
|---|---|---|
| **Productive** | steps at the job's own ideal pace that were kept | step records; the ideal pace is the job's 10th-percentile step time without data and checkpoint waits |
| Slow steps | step time above that pace: stragglers, slow links, contention, jitter | step `durS` |
| Waiting on data | the input pipeline | step `dataS` |
| Checkpoint saves | training blocked while saving | step `ckptS`, or `checkpoint_saved` log records with `saveS` |
| Lost work | steps after the last checkpoint of an attempt that failed, plus the time from its last step to the failure (often a hang before the watchdog) | steps, job outcomes |
| Restarts | from the start of a restarted attempt to its first step: scheduling, init, checkpoint load | placements, steps |
| Startup | the same for a job's first attempt | |
| Idle | the rest of the allocation: gaps between steps (eval, logging) and after the last step | |

Notes on the inputs:

- **Attempts:**
  - a job's attempts are its placements named `job#1`, `job#2`, and so on;
  - an attempt followed by another ended abnormally, whatever its record says;
  - `killed` and `cancelled` are someone's choice, so they are not counted as interruptions.
- **Step records may cover several steps** (`n` steps at an average `durS`), as frameworks log every N steps. With
  many ranks, the slowest rank sets each step's wall time.
- **Without step records** (job traces only), an attempt counts whole: productive if it finished or is running, lost
  if it failed. The report flags this and calls the result an upper bound.
- **Allocations with no end and no steps** say nothing about what they did, so they are left out and their GPU-hours
  are reported separately.

## Checkpoint interval

For each job with checkpoint times:
- **save cost δ:** its median blocking save time;
- **current interval:** the median gap between its checkpoints;
- **restart cost R:** the median time from a restarted attempt's start to its first step.

The mean time between interruptions **M** is the fleet's measured interruptions per GPU-hour, over the window and the
week before, scaled by the job's GPUs. A job on more GPUs is interrupted more often.

The expected badput of checkpointing every τ seconds is δ/τ + (τ/2 + R)/M. It is smallest at τ* = √(2δM)
(Young/Daly). The report gives:
- τ*;
- the verdict: checkpoint more often, less often, or about right (within 25%);
- the GPU-hours a week the change would save.

Async checkpointing makes δ small and pushes τ* down. Measure δ as the time training is actually blocked.

## Serving

For pools with latency targets (`--targets`), the report adds the share of requests that met them: TTFT, and TPOT
from `(e2e − ttft) / (osl − 1)`. Pools with only windowed metrics use the share of p99 windows that met them.

## Results

**Demo week** (`fleetops demo --training`): three jobs, each with one planted problem. Goodput finds each one as its
job's biggest loss.

| Job | Planted | Found |
|---|---|---|
| pretrain-70b, 256 GPUs | checkpoints every 3 h; interrupted every ~6 h | 66.7% goodput; lost work 28%; interruptions every 6.0 h (measured); checkpoint every 38 min instead, saving ~6,900 GPU-hours a week |
| sft-8b, 64 GPUs | slow input pipeline | 64.5% goodput; waiting on data 32% |
| rl-policy, 32 GPUs | one slow node for two days | 87.6% goodput; slow steps 11%; checkpoint interval about right |

**Microsoft Philly, 8–14 November 2017** (job traces, no step records):
- **Accounted:** 318K GPU-hours of training attempts across 13,204 jobs. 21% of it was in attempts that failed and
  were retried or ended failed.
- **Upper bound:** without checkpoint data, every failed attempt counts as lost, so the real lost work was likely
  lower.
- **Spread:** losses vary widely by team. One team lost 48% of its 32K GPU-hours this way.
- **Left out:** 626K GPU-hours of attempts with no recorded end. That is more than the cluster's capacity for the
  week, so those records can't be trusted.

## Limits

- **Productive means "at the job's own best pace", not "at the hardware's peak".** A job that is slow everywhere has
  high goodput here and low MFU. Use the step records' `mfu` for that.
- **Lost work needs checkpoint marks.** Without them, a failed attempt's steps count as lost only when the job records
  failure.
- **The interruption rate is fleet-wide.** A job on a flakier subset of nodes is interrupted more often than M says.
  The flakiness view shows where.
