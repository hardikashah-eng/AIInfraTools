---
name: gpu-ledger
description: GPU billing and waste for any cluster. Imports Kubernetes pods with DCGM and vLLM metrics, Slurm sacct, OpenCost allocations, CSV or a fleetops store, then reports GPU-hours and cost by org, team, person, project, use case, GPU type and model, split into useful, idle and lost-to-failure hours, with unallocated capacity, budgets and coverage. Ranks savings per month with evidence and owner (idle notebooks, jobs holding idle GPUs, repeated failures, a cheaper GPU type, GPU sharing, serving cost per token, over-provisioned replicas, model and hardware matching, unused commitments) and exports FOCUS 1.4 and showback CSV. Use for GPU chargeback or showback, who is wasting GPUs, cost per team or person, cost per million tokens, which GPU a model or job should run on, or GPU budgets.
---

# gpu-ledger

Requires Node.js 20+. Paths are relative to this skill's folder. The CLI is `scripts/gpu-ledger/tools/ledger.mjs`
(written `gpu-ledger` below: run it as `node scripts/gpu-ledger/tools/ledger.mjs`). Every reading command takes
`--usage FILE[,FILE]` and `--config ledger.json` (prices, attribution, capacity, budgets, policy, thresholds, models),
`--from`/`--to` (ISO or epoch seconds) and `--json`.

## Rules

- **Prices are the user's.** Never invent a price and present it as theirs. Without one, report GPU-hours and say
  cost needs a price book. The demo and example prices are illustrations: say so if you use them.
- **Say the coverage.** Every report states the share of GPU-hours with an org, a person, utilization and a price.
  Lead with it when it is low. Without utilization, idle time is invisible and "useful" is an upper bound.
- **Lost work is an estimate** unless the records have checkpoint times. Give the basis the report gives.
- **Insights are options, not orders, and they overlap.** Give the saving, the basis (measured, estimate, modelled,
  upper bound, investigate) and the confidence. A cheaper GPU type needs a trial run. A smaller model needs a quality
  evaluation. Don't add the savings up as one total.
- **People are named in the data.** When reporting waste by person, keep to the facts in the evidence, not judgments.

## Workflow

1. **Get usage.** Ask what the cluster has, then import (appends to `--out`):
   - Kubernetes: `gpu-ledger import k8s --pods pods.json --nodes nodes.json --prom sm.json,fb_used.json,fb_free.json,vllm_tokens.json --cluster C --out usage.jsonl`.
     The `--prom` files are Prometheus `query_range` results.
   - Slurm: `gpu-ledger import slurm sacct.txt --cluster C --out usage.jsonl`, from
     `sacct -a -P -X --format=JobID,JobName,User,Account,Partition,State,Start,End,NodeList,AllocTRES`.
   - OpenCost: `import opencost allocation.json`.
   - Anything else: `import csv FILE --map start=…,end=…,gpus=…,user=…`.
   - fleetops (with the fleetops skill): `fleetops data export gpu-ledger --out usage.jsonl --capacity cap.json`.
   - No data: `gpu-ledger demo --out ledger-demo` writes a demo org with planted waste.
2. **Configure.** Copy `assets/ledger.example.json`:
   - prices: on-prem as capex, years, watts, PUE, $/kWh and opex; cloud as $/GPU-h; commitments;
   - attribution: label fields, a `people.csv` directory, team → org, rules, shared namespaces;
   - capacity per cluster and GPU type, and budgets.

   `gpu-ledger rates --config …` shows each rate's parts for the user to check.
3. **Report:** `gpu-ledger report --by org,team --json`.
   - `totals`: allocated, useful, idle, lost, cost, wasted, SM activity.
   - `coverage`, `unallocated`, `lostBases`, `groups` (with `loadedCost`), `budgets` and `insights`.
   - Other groupings: `--by user`, `useCase`, `gpuType`, `model`, `project`, `status`.
   - `--format html --out ledger.html` gives a page for sharing; `md` gives markdown.
4. **Where to save:** `gpu-ledger insights --json`. Each insight has `kind`, `owner`, `evidence`, `action`,
   `savings.usdMonth` (or `gpuHMonth` without prices), `basis`, `confidence` and sometimes `caveat`. Methods are in
   [references/METHOD.md](references/METHOD.md).
5. **Bill it:**
   - `gpu-ledger showback --period month --out showback.csv` for finance;
   - `gpu-ledger focus --out focus.csv` gives FOCUS 1.4 rows, which load next to cloud bills in FinOps tools.
