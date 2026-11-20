---
name: fleetscope
description: Simulates LLM inference traffic and training on a modelled hybrid GPU fleet (on-prem plus neocloud). It replays synthetic traffic or real request logs through routers, GPU pools and cross-site links, and reports SLO attainment, TTFT and TPOT p99, cost per hour, peak GPUs and the first bottleneck under stress (traffic surges, longer contexts, half a pool down). It answers plain-English what-ifs, such as the cloud link dropping to 25 Gbps, moving a pool to H200 or doubling traffic, and compares two versions of a scenario the way terraform plan does. Use for GPU capacity planning, burst, cold-start and outage what-ifs, cross-site prefill/decode and KV-transfer questions, Kubernetes GPU scheduling and fragmentation, and reviewing changes to fleet scenarios.
---

# FleetScope

A discrete-event simulator for hybrid GPU fleets. Results are **uncalibrated spec-sheet estimates**. Say so when presenting them, and treat them as directional until calibrated against telemetry (see [references/CALIBRATION.md](references/CALIBRATION.md)).

Requires Node.js 20+. Paths below are relative to this skill's folder. The CLI is `scripts/fleetscope/tools/fleetscope.mjs`; every command takes `--json`.

## Pick a starting fleet

A run needs a *source*, which is one of:

- `--template ID`: a built-in fleet. Run `node scripts/fleetscope/tools/fleetscope.mjs templates --json` to list them:
  - `burst`: a hybrid chat burst against a 90 s cold start
  - `agent`: a coding-agent fleet
  - `xpd`: prefill on-prem, decode in the neocloud
  - `train`: training sharing the cross-site link
  - `disagg`, `multi` and `replay` are also available.
- `--graph FILE`: a fleet graph. It can be a template written out with `template ID -o FILE` and then edited, or an export from the `inference-sizer` skill (`--fleetscope FILE`).
- `--scenario DIR`: a folder with `graph.json` and optionally `cluster.json` (Kubernetes), `training.json` and `kueue.yaml`. `assets/scenarios/hybrid-chat` is an example.

When the user describes their own fleet, start from the closest template. Write it out, edit the node `cfg` fields to match, and run from the file. The node types and their fields are in [references/NODE-TYPES.md](references/NODE-TYPES.md). Keep node `id`s and `edges` unchanged unless you are adding nodes.

## Run the stress suite

```bash
node scripts/fleetscope/tools/fleetscope.mjs run --template burst --json
```

`fleet` holds one row per stress test: as drawn, traffic ×1.5, the largest pool half down, and contexts ×2. Each row has these fields:

- `slo` is the share of requests meeting both targets.
- `ttftP99` and `tpotP99` are in seconds.
- `costPerHr`, `peakGpus`, `rejected` (the context didn't fit) and `lost`.
- `bottleneck` says what broke first.

`lint` lists design warnings, such as a pool that starts cold behind a burst. A scenario that includes Kubernetes or training also returns `cluster` (allocation, stranded and idle GPU-hours, training admitted, preemptions) and `training` (goodput, MFU, tokens).

To replay the user's own traffic, add `--trace FILE`. FILE can be vLLM OTLP or Jaeger spans, OpenAI, Anthropic or LiteLLM gateway logs, or CSV. Every trace-replay node then uses that file instead of synthetic traffic. Formats are in [references/TRACES.md](references/TRACES.md).

## Ask a what-if

```bash
node scripts/fleetscope/tools/fleetscope.mjs ask "What if the cloud link drops to 25 Gbps and traffic doubles?" --template xpd --json -o /tmp/edited.json
```

The JSON has these fields:

- `readAs` lists the edits and stress test the question was understood as.
- `notUsed` lists the words that weren't matched.
- `before` and `after` are summaries, and `answer` explains the change in one paragraph.

**Always check `readAs` and `notUsed` before reporting.** If the question was misread or partly ignored, rephrase it using `examples` (`node scripts/fleetscope/tools/fleetscope.mjs examples`), or edit the graph yourself and use `run`. When a question isn't understood the exit code is 1. Ask understands:

- GPU moves and instance counts;
- autoscale limits and cold starts;
- link bandwidth;
- traffic and context multipliers;
- outages;
- model, reasoning and SLO targets;
- routing policy, speculative decoding, CPU offload and residency.

Its full phrase list is in [references/ASK.md](references/ASK.md). `-o` saves the edited graph so you can chain further questions on it.

## Compare two versions

```bash
node scripts/fleetscope/tools/fleetscope.mjs compare --base scenarios/prod --head scenarios/proposed --json
```

This returns `verdict` (`pass`, `fail` or `nochange`), `checks` (SLO, cost, allocation and goodput, each base vs head with its threshold), `changes` and `owners`. It exits 1 when a check fails. Thresholds come from the head's `thresholds.json`. For using this as a CI gate, see [references/CI.md](references/CI.md).

## Presenting results

- Lead with the answer to the user's question: whether it holds up, what breaks first and when, and what it costs.
- Give a compact before/after or per-stress-test table: SLO, TTFT p99, TPOT p99, $/hour and peak GPUs.
- Name the first bottleneck and one concrete change that would move it, such as more instances, autoscaling earlier, a faster link, KV-aware routing or a different GPU. Offer to test that change with `ask` or an edited graph.
- People can open the same graph in the visual editor (`dist/index.html` in the FleetScope repo) to watch the replay.

## Exit codes

- 0: ok.
- 1: a compare check failed, or a question was not understood.
- 2: bad input. With `--json`, stdout holds `{"error": ...}`.
