---
name: inference-sizer
description: Sizes a GPU fleet for serving an LLM. It works out how many GPUs, which tensor-parallel layout, aggregated or disaggregated prefill/decode, how many nodes, and the cost per hour and per million output tokens needed to meet TTFT and TPOT targets at a given concurrency, user count, context window and token mix. It compares GPUs (NVIDIA B200, B300, GB200 NVL72, H200, H100, A100, L40S, AMD MI300X) and takes new models or GPUs from a spec sheet or a Hugging Face config.json. Use when asked how many GPUs a model needs, which GPU to buy or rent for inference, how to meet a latency SLO, how inference cost compares across GPUs, or for a starting fleet to stress-test in FleetScope.
license: Apache-2.0 (see LICENSE.txt)
---

# Inference Sizer

Estimates the GPUs, layout and cost needed to serve one LLM at the user's latency targets. It is a first-order roofline model built from spec-sheet figures. Present results as **estimates to validate with a benchmark**, not measurements.

Requires Node.js 20+. Paths below are relative to this skill's folder. The CLI is `scripts/inference-sizer/tools/size.mjs`.

## Workflow

1. **Collect the inputs.** Ask only for what the user hasn't given and you can't reasonably assume. Defaults exist for everything else; say which ones you relied on.
   - **Model.** Run `node scripts/inference-sizer/tools/size.mjs --list --json` to see the model and GPU ids. For a model that isn't listed, see *New models and GPUs* below.
   - **Targets:** `ttft` and `tpot` in milliseconds.
   - **Load:**
     - peak concurrent sessions `conc`, or daily users `dau` with requests per user per day `rpu` and a peak-to-average `peakFactor`;
     - tokens per request: `avgIn`, `peakIn`, `avgOut`, `peakOut`;
     - context window `ctx`.
   - **Optional:**
     - `prefixHit` (% of prompt tokens served from the prefix cache);
     - `wprec` and `kvprec` (`bf16`, `fp8`, `fp4`);
     - `mode` (`auto`, `agg` or `disagg`);
     - `price` ($/GPU-hour);
     - `headroom` (%);
     - `nPlus1` (keep room for one more instance).

2. **Compare GPUs unless the user fixed one.** Write the inputs as JSON and compare:
   ```bash
   cat > /tmp/sizing.json <<'EOF'
   { "model": "llama33-70b", "conc": 800, "ttft": 1000, "tpot": 25, "avgIn": 2000, "avgOut": 400, "ctx": 32768 }
   EOF
   node scripts/inference-sizer/tools/size.mjs --input /tmp/sizing.json --compare B200,H200,H100,MI300X --json
   ```
   The results come back cheapest first. For a single GPU, use `--gpu B200` instead of `--compare`. `--set key=value` overrides any input.

3. **Read the result.** Each result has these fields:
   - `found` is false when no layout meets the targets. `floors` then gives the fastest TPOT and TTFT that GPU can reach.
   - `pools` lists each role (`aggregated`, or `prefill` + `decode`) with its instance count, layout (e.g. `TP4`) and GPUs per instance.
   - `gpus` is the number serving. `provisionedGpus` is that number rounded up to whole nodes or racks, and `costPerHour` uses `provisionedGpus`.
   - `estimates` gives the expected TTFT (average and peak prompt) and TPOT, in seconds.
   - `costPerMOutputTokens` and `tpotSensitivity` show how GPU count moves as the TPOT target changes.
   - `reason` says why aggregated or disaggregated serving was chosen.

4. **Present it.** Use a short table per GPU: GPUs provisioned, layout, $/hour, $/1M output tokens, and estimated TTFT/TPOT against the targets. Then say in one or two sentences what drives the answer, such as memory capacity, decode bandwidth or prefill compute (`tpotSensitivity` helps here). Give the caveats:
   - prices are placeholders unless the user gave `price`;
   - efficiency factors are typical, not measured;
   - benchmark before buying.

5. **Offer a stress test.** To see how the fleet behaves under bursts, cold starts and failures, export it:
   ```bash
   node scripts/inference-sizer/tools/size.mjs --input /tmp/sizing.json --gpu B200 --fleetscope /tmp/fleet.json
   ```
   Then run it with the `fleetscope` skill: `run --graph /tmp/fleet.json`.

## New models and GPUs

Pass `--catalog FILE`, where FILE is a Hugging Face `config.json` or a spec sheet (JSON or CSV), to add or override models and GPUs. The format and an example are in [references/SPEC-SHEETS.md](references/SPEC-SHEETS.md) and `assets/example.json`. Check the result with `--list --json`.

If the user has a calibration profile (from `fleetops calibrate benchmarks`), pass `--calibration FILE`: it replaces the default engine efficiencies with measured ones for that GPU and model. The JSON's `calibration` field shows which profile entry was used. Say so when you report the plan, since the defaults are conservative and calibrated plans can need far fewer GPUs.

## Exit codes

- 0: a plan was found (for `--compare`, on at least one GPU).
- 1: no layout meets the targets.
- 2: bad input. With `--json`, stdout holds `{"error": ...}`.

## More detail

- [references/METHOD.md](references/METHOD.md): every input, the calculation steps and known gaps. Read it when the user asks how a number was derived.
- [references/OVERVIEW.md](references/OVERVIEW.md): the tool's README, including the web page for people who prefer a UI.
