# CI gate, scenario library and reports

Infrastructure changes (a router setting, an instance count, a scheduler policy, a Kueue quota) get a **plan** before they merge. Like `terraform plan`, the plan runs the change against the current state and lists what would happen.

## Scenario library

`scenarios/<name>/` holds one scenario: `graph.json` (fleet graph), `cluster.json`, `kueue.yaml`, optional `training.json`, and `thresholds.json`. See [scenarios/README.md](../scenarios/README.md). The sample `hybrid-chat` scenario holds the Hybrid chat burst graph, the sample cluster and its Kueue quotas.

## The plan

`tools/fleetscope-plan.mjs` runs the base and head versions of each scenario:
- **Fleet:** SLO met as drawn, at traffic ×1.5, with the largest pool half down, and with contexts ×2. Also serving cost, TTFT p99, peak GPUs, the first bottleneck, and new potential issues.
- **Cluster** (with the Kueue quotas applied): GPU allocation, training jobs started, inference fully placed, stranded GPU-hours, preemptions.
- **Training:** goodput.

The output lists what changed in every file and the owner teams and on-call of the changed nodes. The verdict uses `thresholds.json`: SLO drop (default 1 pt), serving cost rise (10%), allocation drop (5 pt), training goodput drop (3 pt).

```bash
node tools/fleetscope-plan.mjs --git origin/main --scenarios scenarios --out plan.md   # scenarios changed since main
node tools/fleetscope-plan.mjs --base old/hybrid-chat --head scenarios/hybrid-chat      # two folders
```

Exit code: 0 pass, 1 a check failed, 2 a usage or read error. `--json` prints machine-readable results; `--comment N` posts to PR N with `gh`.

Example: cutting the on-prem pool from 4 to 3 instances fails the plan. SLO met as drawn goes from 56.9% to 28.0%, and the plan asks ML Platform (@mlplatform-oncall) to review.

## In CI

`.github/workflows/fleetscope-plan.yml` runs on pull requests that touch `fleetscope/scenarios/**`. It plans each changed scenario against the base branch, comments the plan on the PR (editing its last comment on new pushes), and fails the job when a check fails.

## Report in the browser

**Report** in the fleet toolbar plans the current setup against the baseline pinned with **Pin all as baseline**: fleet graph, Cluster tab and Training tab. It shows the same plan as CI, and can copy it as Markdown or download it as a `.md` file for a capacity review.
