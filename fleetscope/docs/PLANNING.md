# Plan and optimise

**Plan** in the fleet toolbar has three tools.

## Optimise

It searches for the cheapest graph (serving $/hour) that:
- meets an SLO attainment target,
- keeps restricted data in its allowed zones (the residency rule), and
- if set, holds an **N-1 floor**: SLO attainment with the largest pool down.

The search, within a simulation budget:
1. **Feasibility:** grows the pool that breaks first (by 25%, and gives a cold autoscaled pool one warm instance) until the targets are met.
2. **Trim:** shrinks each pool by about 15% at a time while the targets still hold.
3. **GPU types:** optionally tries H100, H200 and B200 for each pool, re-trimming after each swap.
4. **Router policies:** tries primary-first and least-wait.

The result lists today vs the proposed setup and the changes. **Apply to the canvas** applies them.

On the Hybrid chat burst graph (57% SLO met today), a 95% target is met by moving on-prem to 6 B200 instances: $19/h and 6 GPUs, instead of 8 H100 instances ($22/h).

## Buy vs rent

This costs five ways to supply growing peak GPU demand over a horizon (24 months by default):
- **Rent on demand:** pay for average use at on-demand prices.
- **Reserve the base:** reserved prices for the base load, on demand for the peaks.
- **Reserve the base, capacity blocks for the peaks:** short-term blocks for the peaks, such as AWS EC2 Capacity Blocks for ML or GCP calendar-mode reservations. They are bought in whole days, so the peak hours are assumed to come as one run of days (a training run or a launch); `blockPerGpuH` sets the price. To see what is actually on offer, `fleetops procure aws-blocks --gpu H100 --gpus 64 --days 7` prints the read-only AWS command; `fleetops procure gcp-calendar --gpu H200 --gpus 64 --days 7 --region us-central1` (or `--gpu TPU-v6e --chips 64`) prints GCP's calendar-mode advice command.
- **Reserve the base, spot for the peaks:** the peak hours on spot (`spotPerGpuH`), plus the share redone after interruptions (`spotRework`, 10% by default).
- **Buy the base, rent the peaks:** order on-prem GPUs so that, after the lead time, owned capacity covers the base load. Pay capex on delivery, plus power (kW per GPU × PUE × $/kWh) and operations, and rent the rest on demand. Hardware keeps its undepreciated value at the end.

The result gives cumulative cost curves, the cheapest strategy, the month buying pays back against renting, and the order schedule. At the defaults (16 GPUs today, +4% a month): buying the base costs $751k net of residual value, against $826k reserved and $1.18M rented, and pays back by month 21. The block and spot prices are placeholders; set your own. This is a rough model, not financial advice.

## MIG

This packs small models onto MIG slices (H100, H200, A100 profiles). Each replica takes the smallest profile whose memory holds its weights with 30% headroom, packed first-fit-decreasing. The example (6 embedding, 4 reranker and 3 small guard-model replicas) fits on 4 H100s instead of 13 whole GPUs. Models too large for a slice are flagged and take whole GPUs.
