# Stress tests, breaking points and the model advisor

These tools answer "what happens if…" on the graph you've drawn, without editing it. They run in the browser, against the same engine and the same trace and seed as the normal run, so every comparison is like for like.

## What if… (stress overlays)

Open **What if…** in the toolbar. A stress overlay changes the run, not the graph:

| Overlay | What it does | Knobs |
| --- | --- | --- |
| Traffic surge | Trace replay: duplicates requests inside the window. Sessions: extra users join at the start of the window and stop starting turns when it ends. | Multiplier, applies to (all, sessions, traces), start, duration (0 = whole run) |
| Larger contexts | Multiplies every prompt (traces) or the starting context, system prompt and per-turn additions (sessions); optionally adds a fixed number of tokens | Multiplier, extra tokens |
| Outage | Fails part of a pool, a whole site, or a link for a window | Target, capacity lost (%), start, duration, recovery time |

**How an outage plays out:**

- **Failed instances** disappear from their pool. Requests still prefilling on them are re-queued, because no token has reached the user yet. Requests already streaming are **lost**: the stream is cut mid-answer. They are counted in the *Lost in outage* tile.
- **Fixed pools** get their instances back after the window plus the recovery time. Autoscaled pools have their headroom (max instances) cut during the window and rescale afterwards.
- **A link at 0%** carries nothing. Routers and prefill pools steer around targets behind it while any other target can serve. A partly degraded link keeps working, more slowly.

**Starting scenarios** are built from your graph: peak sessions, peak load, partial outage (half the first on-prem pool), neocloud down, link down, large contexts, and peak load combined with an outage. **Apply to canvas** plays the stressed run. The KPIs and charts then compare it automatically with the same graph unstressed, unless you've pinned your own baseline. The timeline marks surge windows (amber, top) and outage windows (dark, bottom).

**Run scenario suite** runs every applicable scenario and tabulates SLO attainment, TTFT and TPOT p99, lost and rejected requests, peak GPUs, cost and the first bottleneck. Click a row to play it on the canvas.

## Bottleneck attribution

Every run is checked second by second. A second counts as a breach when more than 10% of its first tokens miss the TTFT target, or more than 10% of the requests finishing in it miss TPOT. Each breach second is put down to the most likely cause, in this order of precedence:

1. instances down (outage)
2. link degraded (outage)
3. link saturated (≥ 90% used)
4. KV cache full (≥ 95%) with a queue
5. compute saturated (≥ 90% load) with a queue
6. waiting on cold starts
7. queueing beyond half the TTFT target
8. decode batches too large, for TPOT-only breaches

The *First bottleneck* tile names the first one and jumps to it. The overview panel lists the top three by seconds affected.

## Find the breaking point

Raises one dimension (all traffic, concurrent users, or context size) for the whole run until SLO attainment falls below your target. It searches with bisection between 1× and 8× (6× for context), so it takes about eight runs. The result:

- If the graph holds at today's load, the multiplier where it still meets the target, the one where it fails, and what breaks first.
- If it already misses at today's load, a plain statement saying so, and what breaks first.
- A chart of attainment against the multiplier. Click any run to play it on the canvas.

## Model advisor

Open **Model advisor** in the toolbar and tick candidates: each model × reasoning level (Off, Low 500, Med 2,000, High 8,000 median hidden thinking tokens per request).

For each candidate, the advisor scales every pool in the drawn graph together (fixed sizes, and autoscaling min and max) to the smallest size that meets the target, searching geometrically between 0.125× and 8×. It then ranks the candidates that meet the target by **$ per 1,000 requests**.

**Quality is yours to supply.** FleetScope knows cost and latency, not answer quality. Enter a score per model from your own evals and a minimum; candidates below the floor are kept in the table but not picked. Without scores, the cheapest model that meets latency wins, and that is usually the smallest.

**Apply** switches the Model node to that model and reasoning level and resizes the pools to match.

When a model misses even at 8×, the advisor says why. If the fleet has spare capacity and still misses, the cause is per-request latency: the longest prompts take too long to prefill on one instance. More instances won't fix that; more GPUs per instance, faster GPUs or a looser TTFT target will.

## How reasoning (thinking) models change the picture

Set **Reasoning** on the Model node, or tick reasoning levels in the advisor. Each request then decodes a lognormal number of hidden thinking tokens (the knob sets the median) before its answer.

- **TTFT.** If thinking is hidden, the user waits for all of it: TTFT grows by roughly thinking tokens × time per output token. 2,000 tokens at about 30 ms each is a minute. A 2 s TTFT target is then out of reach on any fleet. If your product streams the reasoning, tick *Streamed thinking counts as the first token* on the SLO node, and TPOT then covers thinking and answer together.
- **Capacity.** Decode work per request multiplies, and thinking tokens hold KV cache while they're generated. Fleets become decode-bound and KV-bound, so batches shrink and queues grow. For closed-loop agents, each turn takes longer, so fewer turns complete.
- **Context.** Thinking usually isn't fed back into the next turn. *Keep thinking in later turns' context* models stacks that do keep it.
- **Cost.** Thinking tokens are generated and billed like output. Compare **$ per 1,000 requests** (cost per answer), not $ per million tokens: a reasoning model can look cheap per token and still cost several times more per answer. The *Thinking share of tokens* tile shows how much of the decode work never reaches the user.

## Using it from code

The same functions are exported by `src/engine.js` for scripts and tests:

```js
const E = require('./src/engine.js');
const { spec } = E.compileGraph(graph, traceLookup);
E.simulate(spec, { surge: { mult: 3, start: 240, dur: 120 }, outages: [{ target: 'on', fraction: 0.5, start: 240, dur: 120, recovery: 60 }] });
E.findHeadroom(spec, { kind: 'load', target: 0.95 });           // { limit, failsAt, breaksOn, runs }
E.sizeFleet(spec, { target: 0.95 });                            // { meets, at: { factor, peakGpus, costPerHr, ... } }
E.adviseModels(spec, { target: 0.95, candidates: [{ key: 'llama-8b' }, { key: 'llama-70b', thinkTokens: 2000 }], quality: { 'llama-8b': 60 }, minQuality: 70 });
```

`headroomIter`, `sizeFleetIter` and `adviseIter` are generator versions that yield after every run, which the UI uses to stay responsive and show progress.
