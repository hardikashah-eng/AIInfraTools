# Scenario library

Each folder is one scenario that CI plans on every pull request that touches it (see `.github/workflows/fleetscope-plan.yml`):

| File | What it is | Where it comes from |
| --- | --- | --- |
| `graph.json` | The fleet graph | **Copy graph JSON** in the fleet view |
| `cluster.json` | The cluster: node pools, queues, workloads, scheduler policy | The Cluster tab (or `fromKube` on `kubectl ... -o json`) |
| `kueue.yaml` | Kueue ClusterQueues; their nominal GPU quotas override the cluster's queue quotas | Your cluster's manifests |
| `training.json` | A training job (optional) | The Training tab |
| `thresholds.json` | When the plan fails: SLO drop (pt), serving cost rise (%), allocation drop (pt), training goodput drop (pt) | Edit by hand |

Run a plan locally:

```bash
node tools/fleetscope-plan.mjs --git origin/main --scenarios scenarios          # every scenario changed against main
node tools/fleetscope-plan.mjs --base old/hybrid-chat --head scenarios/hybrid-chat   # two folders
```
