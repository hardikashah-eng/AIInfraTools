# Method

## The usage record

Every adapter produces the same record: one allocation of GPUs for a span of time.

```
{ id, start, end (epoch seconds; null while running), gpus, gpuType?, cluster?, provider?, region?, node?,
  kind? (job | pod | deployment | notebook), name?, namespace?, labels?, group? (a job and its retries),
  user?, team?, org?, project?, useCase?,
  status? (succeeded | failed | cancelled | preempted | running),
  util? { busy, sm, memPeak, idleLong, samples, smSource? },
  checkpoint? { intervalS?, lastAt? },
  serving? { model, tokensIn, tokensOut, requests } }
```

- `util.busy`: share of GPU-time above the idle threshold (5% SM activity or GPU utilization).
- `util.sm`: mean SM activity while busy.
- `util.memPeak`: peak HBM used, 0–1.
- `util.idleLong`: GPU-seconds idle in stretches of 30 minutes or more.
- `util.smSource: gpu_util`: busy and SM came from nvidia-smi utilization, which counts a GPU as busy when any kernel
  runs, not how much of the GPU it uses. It overstates.

Records can be written by hand or by any script (JSON lines). Serving pods with vLLM counters become one record per
pod and hour, so traffic can be compared hour by hour.

## Attribution

Each of `org`, `team`, `user`, `project` takes the first value found among its fields (record fields or `label:…`).
The defaults:
- `user`: `user`, `label:user`, `label:owner`, `label:created-by`;
- `team`: `team`, `label:team`, `label:group`, `namespace`.

Then, in order:
1. A directory (`people.csv`: `user,team,org`) fills team and org from the person.
2. Rules (`{ match: { field: regex }, set: { … } }`) override.
3. `teams` maps a team to its org.
4. `shared` marks platform services: they appear as their own rows and can be spread over everyone else
   (`loadedCost`), but no insight blames them on anyone.
5. The use case comes from rules, or else from the workload's name and kind:
   - serving names or a Deployment → inference;
   - jupyter, notebook or debug → interactive;
   - eval or bench → evaluation;
   - sft, lora, dpo or rlhf → fine-tuning;
   - train, pretrain or sweep → training;
   - prep, etl or tokenize → data.

Every report says what share of GPU-hours had an org, a person, utilization and a price. A low share is the first
thing to fix: the rest is only as good as it.

## Classes

For one allocation in a window:
- `allocated = gpus × time`
- `idle = allocated × (1 − busy)`, or 0 when utilization isn't known
- `lost = gpus × (the part of the lost span inside the window) × busy`
- `useful = allocated − idle − lost`

The lost span (policy, all configurable):

| Evidence | Lost |
|---|---|
| last checkpoint time known | from it to the end |
| checkpoint interval known | half the interval (the expected loss) |
| run shorter than `wholeIfShorterS` (1 h) | all of it: a short run that failed produced nothing to keep |
| otherwise | `assumedTailS` (30 min) |
| every attempt of the job failed, at least `neverSucceeded` (3) times | all of it |

Failed and preempted runs lose work. Cancelled runs count as useful unless `cancelled: lost-tail`: pretraining is
usually stopped on purpose after a checkpoint, and a job cancelled by mistake can't be told apart from the record. The
lost span sits at the end of the run, so in a report by day it lands on the day the run ended.

**Unallocated** capacity = capacity × window − allocated, per cluster and GPU type, when `capacity` is given.
Allocations above capacity are flagged: they usually mean the capacity file is wrong.

## Prices

The on-prem rate per GPU-hour:

```
capex / (years × 8760) + watts / 1000 × PUE × $/kWh + opexYear / 8760
```

`watts` should include the GPU's share of the server, network and storage power. Cloud and neocloud take a list
price per GPU-hour. Commitments `{ provider, gpuType, gpus, rate, from, to }` are compared with use on that provider
and GPU type.

For unallocated on-prem capacity, the insight counts only power as avoidable: the hardware is paid for, and the
alternatives are powering nodes down, lending them out, or moving cloud work onto them.

## Insights

Savings are per month: the window's figure × 30 days / window length. They overlap: moving a model to another GPU
and right-sizing its replicas both count the same GPU-hours. Treat each as its own option.

| Kind | Finds | Saving | Basis |
|---|---|---|---|
| `idle-timeout` | interactive sessions with idle stretches ≥ 30 min | the idle stretches | measured |
| `held-idle` | batch allocations busy < 20% for ≥ 2 h | the idle GPU-hours | measured |
| `repeated-failure` | ≥ 3 failed attempts of the same job; "never succeeded" when none passed | the lost GPU-hours | estimate |
| `gpu-type` | work whose peak memory (+15%) and SM demand (+25%) fit a GPU ≥ 15% cheaper in the price book; multi-GPU work never moves to PCIe parts | the rate difference | estimate |
| `share-gpu` | single-GPU work under 40% memory and 30% SM, ≥ 3 allocations | (1 − 1/k) of its GPU-hours, k = how many fit on one GPU (2–7) | estimate |
| `serving-gpu` | the same model ≥ 15% cheaper per token on another GPU type the fleet runs (≥ 10% of its tokens there) | tokens × the difference | measured |
| `serving-scale` | GPU-hours above what every hour needed at the deployment's own p95 hourly throughput plus 25% headroom, in whole replicas | the excess | measured |
| `serving-sizing` | the Inference Sizer's layout per GPU type for the busiest hour (when inference-sizer is beside it, or `--sizer DIR`) | spend − cheapest layout | modelled |
| `serving-model-size` | a model ≥ 60B whose answers average < 32 tokens | none given | investigate |
| `commitment` | reserved GPUs used < 90% | the unused part | measured |
| `unallocated` | > 20% of a cluster's GPU type allocated to nobody | power (on-prem) or the rate (cloud) | measured |
| `training-efficiency` | training on ≥ 8 GPUs busy but < 35% SM active | up to 50% SM active | upper bound |

Thresholds are in `thresholds` in the config. Anything under 20 GPU-hours a month is left out.

## FOCUS

`gpu-ledger focus` writes FOCUS 1.4 Cost and Usage rows. There is one row per day, cluster, GPU type, provider,
owner (org/team/user/project) and use case, plus one row per unallocated capacity. The column mapping:

| Column | Value |
|---|---|
| `BilledCost`, `EffectiveCost`, `ListCost`, `ContractedCost` | the same internal cost |
| `ChargeCategory` | `Usage` |
| `ChargeFrequency` | `Usage-Based` |
| `ConsumedQuantity`, `PricingQuantity` | GPU-hours |
| `ConsumedUnit`, `PricingUnit` | `GPU-Hours` |
| `ServiceCategory` | `Compute` |
| `ServiceName` | `GPU Compute` |
| `HostProviderName`, `ServiceProviderName`, `InvoiceIssuerName` | the provider, or `On-premises` (`--provider-name`) |
| `SubAccountId` | the org |
| `AllocatedMethodId` | `gpu-ledger/gpu-seconds` |
| `AllocatedResourceId` | org/team/user/project |
| `Tags`, `AllocatedTags` | the attribution |
| `x_UseCase`, `x_UsefulGpuHours`, `x_IdleGpuHours`, `x_LostGpuHours`, `x_WastedCost`, `x_SmActive`, `x_OutputTokens`, `x_RateBasis` | extension columns (FOCUS prefixes non-standard columns with `x_`) |

The rows have not been run through the FOCUS validator. Columns that don't apply, such as commitment discounts on
amortized on-prem cost, are left out.

## Limits

- **Idle needs utilization.** Without it, idle time can't be seen and "useful" is an upper bound. The report says so.
- **Busy is not productive.** A GPU spinning on a hung collective is busy. fleetops' goodput and root-cause analysis
  see inside a busy GPU; the ledger does not.
- **Lost work is estimated** unless checkpoint times are in the records.
- **GPU-type suggestions** use peak memory and mean SM activity against spec sheets. Memory bandwidth, interconnect
  and kernels tuned for one architecture can make the cheaper GPU slower. Each suggestion asks for a trial run.
- **Cost per token at low utilization** is the real cost of self-hosting, not a property of the model. The serving
  insights compare allocation-based cost, so a lightly loaded deployment looks expensive, because it is.
