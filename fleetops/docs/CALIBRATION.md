# Continuous calibration

The models in FleetScope and the Inference Sizer start from spec sheets. Calibration fits them to measurements held in the store, keeps each fit as a profile, and raises a drift record when new measurements fall outside the profile.

```bash
# Inference Sizer (and FleetScope) from benchmark records: MLPerf summaries, benchmark_serving results
node tools/fleetops.mjs calibrate benchmarks --store fleet-data --profile profile.json [--isl 300]
node ../inference-sizer/tools/size.mjs --model llama33-70b --gpu H200 --set conc=800 --calibration profile.json

# FleetScope pools from serving records (vLLM /metrics, Prometheus), re-fitted every hour, last 25% held out
node tools/fleetops.mjs calibrate serving --graph fleet.json --holdout 0.25 --profile pools.json --graph-out fleet-calibrated.json --every 3600

# Drift: the latest window simulated with the stored multipliers (cron-friendly: exit 3 on drift)
node tools/fleetops.mjs calibrate drift --graph fleet.json --profile pools.json --from 2026-11-23 --fail-on-drift
```

## What gets fitted

| Model | Parameters | Fitted to | Accepted when |
|---|---|---|---|
| FleetScope pool | `prefill` and `decode` multipliers (FleetScope's own fitter) | serving records for the pool, or a benchmark run on a one-pool graph | TTFT and TPOT within 10% at p50 and 20% at p99 |
| Inference Sizer | one multiplier on `effPrefill`, `effDecodeBW` and `effDecodeComp`, each capped at a physical ceiling (0.9, 0.95, 0.9) | a benchmark run: the sizer's GPU count for the measured request rate, token sizes and latency limits must equal the GPUs the system used | the GPU counts match; a fit that hits the ceilings says so |

Each fit is stored as a `calibration` record with what it was fitted on (`fitOn`) and its before/after errors. The profile file is plain JSON, so the tools read it without this package:
- FleetScope pools: the multipliers go into a graph with `calibrate apply`;
- the sizer: `--calibration`.

**Held-out checks.**
- With `--holdout`, the latest share of each pool's serving records stays out of the fit, and the fit is then checked against them.
- For benchmarks, runs whose model name says `interactive` (low-latency runs) are checked against the profile fitted on the same system's regular run.

**Drift.** A drift record names the worst metric and by how much it missed the bar. Re-fit when one appears. `calibrate serving --every` does that on a schedule, and so does a cron job.

## Results on MLPerf Inference v5.0 (Llama 2 70B, 8 GPUs, Server scenario)

Derived from published MLPerf Inference v5.0 results; not verified by MLCommons. The mean input length isn't in the summaries, so it is an assumption: 300 tokens by default. The sensitivity to it is below.

**Inference Sizer.** These are the GPUs predicted for each run's measured request rate within its TTFT ≤ 2 s and TPOT ≤ 200 ms limits. The measured systems used 8.

| System | Spec-sheet efficiencies | Calibrated | Fitted efficiencies (prefill / decode BW / decode compute) |
|---|---|---|---|
| 8× H100 (NVIDIA) | 16 (+100%) | 8 (0%) | 0.778 / 0.95 (ceiling) / 0.584 |
| 8× H200 (NVIDIA) | 16 (+100%) | 8 (0%) | 0.765 / 0.95 (ceiling) / 0.573 |
| 8× B200 (NVIDIA) | 21 (+163%) | 9 (+13%) | 0.90 (ceiling) / 0.95 (ceiling) / 0.90 |
| 8× MI325X (AMD) | not in the sizer's catalog | – | – |

**Held out: the low-latency runs.** TTFT ≤ 450 ms, TPOT ≤ 40 ms, on the same systems:

| System | Spec-sheet | Calibrated | Used |
|---|---|---|---|
| 8× H200 | 10 (+25%) | 5 (−37%) | 8 |
| 8× B200 | 13 (+63%) | 5 (−37%) | 8 |

**What this shows.**
- The spec-sheet defaults are conservative by about 2× against a tuned MLPerf system.
- A single multiplier fitted at the 200 ms TPOT operating point doesn't carry over to the 40 ms one: it overshoots, and the calibrated sizer under-provisions there.
- So efficiency depends on the latency regime, and profiles need to be fitted per regime (TPOT band) before the roadmap's held-out bar (10% p50, 20% p99) is met for the sizer.
- Decode bandwidth hits its 0.95 ceiling in every fit. The sizer's decode path is the conservative part.

**FleetScope.** One pool, as many instances as the 8 GPUs allow, at each run's measured request rate:

| System | Before calibration: TTFT p50 / TPOT p50 / TPOT p99 | After the fit |
|---|---|---|
| 8× H100 | +15,048% / −12% / +2% | not within the bar: "capacity" |
| 8× H200 | +18,152% / +4% / +25% | not within the bar: "limit" |
| 8× B200 | +33,006% / −11% / +13% | not within the bar: "capacity" |

- **Decode:** without any calibration, FleetScope's decode model lands within 4–12% of measured TPOT at p50.
- **TTFT:** the simulated pool can't absorb MLPerf's request rate. Its KV-cache admission and aggregated prefill model are more conservative than TensorRT-LLM's, so requests queue. The fitter reports this ("capacity", "limit") instead of forcing a fit that doesn't hold.
- **Held out anyway:** the low-latency H200 run predicted with the fitted multipliers lands at TPOT +14% (p50) and +15% (p99), against +210% and +258% with spec-sheet values. TTFT stays outside the bar (−31% p50, −65% p99).

**Sensitivity to the assumed mean input length** (sizer, calibrated GPUs for the regular runs):

| Mean input | H100 | H200 | B200 |
|---|---|---|---|
| 200 | 8 | 8 | 8 |
| 300 | 8 | 8 | 9 |
| 500 | 8 | 8 | 11 |
| 800 | 12 | 11 | 15 |

Above about 500 tokens even the ceilings can't reach 8 GPUs. That fits a short mean prompt, and it is consistent with the KV-cache arithmetic. A measured mean input length would remove the main uncertainty.
