# Flakiness

A dead GPU is quarantined once and replaced. A flaky one passes its diag, goes back to work and fails again days later, often in the middle of a long job. The analysis judges each GPU as it stands now. The flakiness view looks back over its history (60 days by default) to find the GPUs that keep coming back, the repairs that don't hold, and the groups of GPUs that fail together.

```bash
node tools/gpu-health.mjs flakiness --state /var/lib/gpu-health --format html --out flakiness.html
node tools/gpu-health.mjs flakiness --state /var/lib/gpu-health --json        # totals, top GPUs, repairs, hot cohorts, cost
node tools/gpu-health.mjs demo                                               # also writes gpu-health-demo/flakiness.html from 60 days of demo history
```

The approval page (`serve`) has a **Flakiness** button. It opens the same page, behind the same token; the API is `GET /api/flakiness[?days=N][&format=html]`.

## Where the history comes from

Every `analyze` and `watch` run adds to three files in the state directory:

| File | What | Written by |
|---|---|---|
| `events.jsonl` | every state change: `{ t, key, node, gpu, sku, site, vendor, from, to, why, faultClass }` | each analysis |
| `audit.jsonl` | executed repairs (`gpu-reset`, `node-reboot`, `reseat`, …) | the action queue |
| `results.jsonl` | diag results, job ends, faults and SDC events from `--results`, without duplicates | each analysis |

History starts when you start running gpu-health. To get the cost of failures right, report how jobs end in `--results`:

```json
{ "t": 1763550000, "kind": "job-end", "job": "train-llm", "rank": 13, "status": "failed", "cause": "device", "lostGpuHours": 96 }
```

`cause` is `device`, `app` or `infra`, and only `device` counts against a GPU. The GPU comes from `node` and `gpu`, or from `job` and `rank` through the jobs file. Without `lostGpuHours`, the loss is estimated as the job's GPU count × `flakiness.lostHoursPerFailure` (1 hour: work since the last checkpoint plus the restart).

## What it measures

Per GPU:

| Measure | Meaning |
|---|---|
| Exits | Times it went from serving to suspect, quarantined or RMA |
| Bounces | Exits within `bounceDays` (7) of coming back to service |
| Diag passed, then failed | Diag passes followed by an exit within `bounceDays` |
| Job failures | Jobs that failed with `cause: "device"` on it |
| Verdict | **RMA candidate**: 2+ bounces, or `rmaHardFailures` (3) hard failures in the window. **Flaky**: 2+ exits with a bounce or a device-caused job failure. **Watch**: 2+ exits |

Fleet-wide:

- **Do repairs hold?** For each repair kind and fault class, the share of repairs after which the GPU stayed in service for 7 and 30 days (`holdDays`). Repairs too recent to judge are left out of the rate. With at least `minRepairs` (3) to judge from, a repair that holds less than half the time is marked "rarely holds": for that fault class, go straight to the next step on the ladder.
- **Where failures cluster.** The exit rate of each SKU, site, node, slot, vendor and firmware, against the fleet's. A group is flagged at `cohortRatio` (2) × the fleet rate when at least `cohortMinDevices` (3) of its GPUs failed. One bad GPU is not a cohort. A flagged node or rack usually means cooling or power; a flagged firmware or SKU batch, a shared defect.
- **Early warning.** The share of hard failures that were suspect within `warnHours` (72) before failing. This shows how often the early-warning signals caught a failure in time.
- **Cost.** GPU-hours and dollars lost to device-caused job failures, by job.

All thresholds are under `flakiness` in the config; see [CONFIG.md](CONFIG.md).

## Reading the page

- **Tiles:** exits, flaky GPUs and RMA candidates, the bounce rate, how often repairs hold, how often failures were caught early, and the GPU-hours lost.
- **Day chart:** GPUs leaving service each day, quarantined or RMA on the baseline and suspect stacked on top. Hover a bar for its numbers. *Table view* lists them.
- **Flakiest GPUs:** a strip per GPU showing its state across the window, colored suspect, out of service, burn-in / ready, or serving. Hover a segment for its dates. GPUs that left service only once are folded away.
- **Repairs:** held rates as bars, with the counts beside them.
- **Cohorts:** a table per dimension, tinted by how much worse than the fleet each group fails. Flagged groups also get a callout at the top of the page.

Colors were checked for color-vision deficiency in light and dark mode, and every state also has a text label.
