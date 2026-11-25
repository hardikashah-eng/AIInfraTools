# gpu-ledger

GPU billing and waste for any cluster: who used which GPUs, what it cost, how much of it was useful work, and where
to save. It runs on its own (Node.js 22+, no dependencies, no other tool from this repo needed) against what a cluster
already has: Kubernetes, DCGM and vLLM metrics in Prometheus, Slurm accounting, OpenCost, or a CSV.

```
$ gpu-ledger report --usage usage.jsonl --config ledger.json --by org,team
GPU ledger 2026-11-09 00:00 → 2026-11-16 00:00 UTC (7.0 days)

  allocated 18,781 GPU-h, $25,462
  useful 84% · idle 15% · lost to failures 1% → $4,391 not buying work
  unallocated onprem-a H100: 44% of capacity (11,747 GPU-h, $13,748)
  coverage: org known for 99%, person for 99%, utilization measured for 100%, priced 100% of GPU-hours

org        team      GPU-h   cost     useful  idle  lost  wasted  SM
research   pretrain  10,741  $12,572     96%    4%    0%    $482  61%
product    serving    6,048  $10,749     77%   23%    0%  $2,606  39%
research   speech       768     $899     12%   88%    0%    $791  50%
…
Where to save (per month):
  $6,126/mo llama33-70b: $0.63/1M tokens on H200, $1.16 on H100 [serving-gpu; measured; medium]
  $4,863/mo llama33-70b: more replicas than the traffic needs [serving-scale; measured; medium]
  $3,390/mo asr-train held GPUs it barely used [held-idle; measured; medium]
  $1,234/mo sft-1b fits on A100 instead of H100 [gpu-type; estimate; medium]
  $813/mo   sweep-lr failed 9 times and never succeeded [repeated-failure; estimate; high]
  $667/mo   alice: interactive sessions idle in long stretches [idle-timeout; measured; high]
  …
```


## What it answers

- **Who spent what.** GPU-hours and cost by org, team, person, project, use case (training, fine-tuning,
  inference, evaluation, interactive, data), GPU type, cluster, model, by day, week or month. Shared services and
  unallocated capacity can be spread over everyone in proportion (`loadedCost`).
- **How much was useful.** Every allocated GPU-hour is one of:
  - **useful**;
  - **idle**: allocated, GPU not working (needs utilization from DCGM or similar);
  - **lost**: work a failure or preemption threw away. That is the time since the last checkpoint when known, half
    the checkpoint interval if that is known, otherwise an estimate; and all of it when every attempt of a job failed.

  The three add up. Capacity nobody allocated is counted separately per cluster and GPU type.
- **Where to save, per month.** Each insight names an owner, the evidence, the change, the saving and how it was
  worked out (measured, estimate, modelled, upper bound):
  - idle notebooks (idle timeout);
  - jobs holding GPUs they barely use;
  - jobs that fail again and again, or never succeed;
  - work that fits on a cheaper GPU type (peak memory and SM activity against spec sheets);
  - single-GPU work light enough to share a GPU (MIG, time-slicing);
  - training that is busy but slow.
- **Model and hardware matching for serving.** Allocation-based cost per million output tokens, per model and GPU
  type, measured on your fleet. It finds:
  - the same model cheaper on another GPU type you already run;
  - more replicas than the busiest hour needs at the throughput the deployment has shown it reaches;
  - with the Inference Sizer next to it, the GPUs each type would need for the observed traffic;
  - big models that mostly write short answers: a candidate for a smaller model, which only an evaluation can
    confirm.
- **Commitments and capacity.** Reserved GPUs used less than paid for. Capacity nobody allocated: on-prem, only the
  power is avoidable, because the hardware is paid for.
- **Budgets.** Run rate per month against a budget per org or team.

## Fits any infrastructure

| Source | Command | Gives |
|---|---|---|
| Kubernetes | `import k8s --pods pods.json [--nodes nodes.json] [--prom …]` | pods with GPU requests (NVIDIA, AMD, Gaudi, Intel), labels, owners, status, GPU type from node labels |
| DCGM in Prometheus | `--prom` with `query_range` results for `DCGM_FI_PROF_SM_ACTIVE` (or `DCGM_FI_DEV_GPU_UTIL`), `DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_FB_FREE` | busy share, SM activity, idle stretches, peak memory, joined per pod |
| vLLM in Prometheus | `--prom` with `vllm:generation_tokens_total`, `vllm:prompt_tokens_total`, `vllm:request_success_total` | tokens and requests per serving pod and hour |
| Slurm | `import slurm sacct.txt` | jobs with `gres/gpu`, user, account, partition, state |
| OpenCost / Kubecost | `import opencost allocation.json` | per-pod GPU-hours from `/allocation` |
| AWS Cost and Usage Report | `import aws-cur cur.csv[.gz]` (CUR 2.0 data export or legacy CUR, with resource IDs) | GPU instance-hours priced at what was billed: Savings Plan and Reserved effective cost, Spot, on demand. The GPU type and count come from the instance type; tags (`user:team`) attribute |
| Google Cloud Billing export | `import gcp-billing export.jsonl` (the BigQuery standard or detailed usage cost export, as JSON lines or an array) | GPU and TPU hours from their own SKUs (`Nvidia H100 80GB GPU …`, `TpuV6e …`), net of credits: committed use, spot, calendar mode, on demand. The VM's vCPU and memory are separate lines and not included. GKE cost-allocation labels give the cluster and namespace |
| Anything else | `import csv FILE --map start=…,end=…,gpus=…,user=…` | your own columns |
| fleetops | `fleetops data export gpu-ledger --out usage.jsonl --capacity cap.json` | placements, status, utilization and inventory from a fleetops store |

Out: a text or markdown report, JSON, a single-file HTML page, a showback CSV, and **FOCUS 1.4** cost-and-usage
rows (`gpu-ledger focus`). FOCUS is the FinOps Foundation's open billing format, so the rows load into tools that read
FOCUS cloud bills, next to them. The useful, idle and lost GPU-hours ride in `x_` columns.

## Prices

On-prem GPUs are priced as amortized cost: capex over its life, plus power × PUE × $/kWh, plus opex per year, per
GPU-hour. Cloud and neocloud GPUs take a list price. Commitments (reserved GPUs at a rate) are checked against use.
`gpu-ledger rates` prints each rate with its parts. The example prices in `examples/ledger.example.json` and the demo
are illustrations, not quotes: put in your own.

## Try it

```bash
node tools/ledger.mjs demo --out ledger-demo
node tools/ledger.mjs report --usage ledger-demo/usage.jsonl --config ledger-demo/ledger.json --by org,team
node tools/ledger.mjs insights --usage ledger-demo/usage.jsonl --config ledger-demo/ledger.json
node tools/ledger.mjs report --usage ledger-demo/usage.jsonl --config ledger-demo/ledger.json --format html --out ledger.html
```

## On real traces

**Microsoft Philly, 8–14 November 2017.** Job attempts, users, virtual clusters (teams) and per-GPU utilization
every minute; 2,308 GPUs report utilization. Prices are assumed (the trace has none).
- Of 314,261 allocated GPU-hours, 70% were useful, 25% idle (GPU utilization at or under 5%) and 4% lost to
  failures; 94% of the lost hours came from jobs whose every attempt failed.
- 16% of the 12 GB GPUs' capacity and 32% of the 24 GB GPUs' was allocated to nobody.
- Teams ranged from 47% to 80% useful.
- 221 allocations held GPUs while busy under 20% of the time, and 98 jobs failed three or more times.
- The utilization is nvidia-smi's, not SM activity, so "busy" is generous.

**AcmeTrace (Shanghai AI Lab, Kalos, May–August 2023).** LLM development jobs with users, workload type and state,
no utilization:
- 1.47 M GPU-hours, 96% of it pretraining;
- 61% of the pretraining GPU-hours ended cancelled, which the ledger counts as useful by default, because stopping a
  long run after a checkpoint is how pretraining usually ends.

Without utilization the report says idle time can't be seen and "useful" is an upper bound. Method, policies and
limits: [docs/METHOD.md](METHOD.md).
