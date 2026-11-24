# Power-aware capacity

Power, not GPUs, is often what limits a fleet: a rack's PDU, a row's circuit, a site's contract. This adds four things:
- power against budgets per rack, PDU, row and site;
- which jobs a power cap would slow, and by how much, before the cap is applied;
- the caps that bring a group under budget at the least slowdown, applied through the usual approvals;
- how many more nodes fit under a budget.

It works the same on NVIDIA and AMD.

## Measured: what is drawn

```bash
fleetops power report --budgets budgets.json [--from T --to T]
```

`budgets.json` gives IT kW per group: `{ "rack:r1": 40, "pdu:p3": 17, "site:sjc": 2000 }` or
`{ "rack": { "r1": 40 } }`. Groups come from the store's topology (`racks` CSV, Kubernetes rack labels) and inventory
(site).

| Column | How |
|---|---|
| IT kW | sum over nodes of GPU power (`DCGM_FI_DEV_POWER_USAGE`, AMD `gpu_power_usage`), per 5-minute bin, ÷ `gpuShare` (0.7: CPUs, NICs and fans are the rest) |
| p99, peak | over the bins in the window; budgets are judged on p99 |
| headroom | budget − p99 |
| more nodes | headroom ÷ the p95 IT kW of one node of the group's GPU model |
| facility kW | IT × PUE (1.3) |

Set `--options '{"gpuShare":0.65,"pue":1.2}'` from your own metering. A node-level meter (BMC, PDU outlet) is
better than the ratio when you have one.

## Modelled: what a cap does

```bash
fleetops power jobs                      # each job's draw (p50/p95), limit, how compute-bound, time at the limit
fleetops power predict --cap 70%         # or --cap 500W: predicted slowdown and kW saved per job
fleetops power fit                       # α from your fleet
```

A cap C on a GPU drawing D > C stretches its work by (D/C)^α. Samples drawing less than the cap are untouched, so a
job that rarely reaches the cap loses nothing to it. α depends on what limits the job:
- **Compute-bound** work (prefill, dense training steps) follows the core clock. The clock drops with power:
  α ≈ 0.35 by default.
- **Memory-bound** work (decode, reading weights and the KV cache) is limited by HBM bandwidth, which barely
  depends on the core clock: α ≈ 0.08.

Each job's α is a mix of the two, weighted by its tensor activity against its DRAM activity.

`fleetops power fit` measures the compute exponent on your GPUs. It takes GPUs that ran busy under different power
limits (`DCGM_FI_DEV_POWER_MGMT_LIMIT`, now in the default pull and mapping) and regresses log clock on log limit.
Pass the result as `--fit-alpha`. Without it, the report says the defaults are uncalibrated.

## Planned and applied: caps under budget

```bash
fleetops power plan --budgets budgets.json [--max-slowdown 0.05] [--protect training] [--guards g.json] --out plan.json
fleetops optimize advance --plan plan.json      # after approval: applies, bakes, checks the guard, rolls back on a breach
fleetops power verify --plan plan.json          # measured kW saved and step slowdown against the prediction
```

**How it chooses caps.** For each group whose p99 is over its budget:
1. It considers caps at 90%, 80%, 70% and 60% of each job's limit, and drops any predicted to slow the job more
   than `maxSlowdown` (5%).
2. It takes the cap with the least slowdown per kW saved first, until the shortfall is covered.
3. It then backs each job off to the shallowest cap that still covers it.

Memory-bound serving is usually capped first, and deeply, because it costs it almost nothing. A plan that can't
reach the budget within the limits says STILL OVER, and by how much. `--protect training` leaves training jobs alone.

**How the caps are applied.**
- Each group's caps are one stage in gpu-health's approval queue, the same machinery as `fleetops optimize`.
  Applying needs a person; undoing restores the default limit.
- The commands come from the gpu-health executors:
  - `power-cap-node` when a job holds every GPU of a node: `nvidia-smi -pl W`, or
    `amd-smi set --gpu all --power-cap W`;
  - `power-cap` per GPU otherwise: `nvidia-smi -i N -pl W`, or `amd-smi set --gpu N --power-cap W`.
- Override them for your site, for example a Redfish call or the GPU operator.
- `--guards` adds a serving guard per stage (`{ "power:rack:r1": { "pool": "chat", "metric": "ttftP99", "limit": 1.0 } }`).

**The live agent.** With `power: { budgets, windowS: 900, maxSlowdown, protect }` in the agent config, a group over
budget gets `power-cap-node` actions proposed for approval each tick, never applied on its own.

## FleetScope

```bash
node fleetscope/tools/fleetscope.mjs power --template disagg --cap "Decode H100=60" --budget "On-prem DC=6"
```

What it models:
- **Pools:** each pool can take a power cap (`powerCapPct`, also a field in the editor). It slows prefill and decode
  with the same exponents as above.
- **Power:** IT kW per pool and site is computed from busy and idle GPUs, then compared with site budgets.
- **Comparison:** the command shows tokens per MWh, and SLO, TTFT and TPOT with and without the caps.

On the disaggregated template, capping decode to 60% leaves the SLO unchanged and raises tokens per MWh. Capping
prefill to 60% pushes TTFT p99 from 20 s to 35 s.

## Limits

- **IT power is estimated** from GPU power and a fixed share unless you set the share from metering. Node meters
  would be better and are not read yet.
- **The cap response is a model.** It is fitted from clocks under different limits when the fleet has them, and
  otherwise uses defaults. A job's own sensitivity (communication-bound steps, for one) can differ. `power verify`
  measures it after the fact.
- **Budgets are judged on the p99** of 5-minute bins. Breaker trips happen on shorter peaks, so keep a margin.
