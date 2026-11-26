# Shadow upgrades

Measure an infra change before it ships, and keep measuring the baseline so drift is caught. The change can be new
GPUs, an engine version or its configuration, networking, topology, or the serving layout.

```
fleetops shadow plan    --baseline-config h100.json --candidate-config b200.json --trace sessions.jsonl --rps 4 --out plan.json
fleetops shadow replay  --trace sessions.jsonl --baseline http://vllm-old:8000 --candidate http://vllm-new:8000 --model M --live
fleetops shadow answers --baseline http://vllm-old:8000 --candidate http://vllm-new:8000 --model M --live --out answers.json
fleetops shadow compare --baseline variant=baseline,source=shadow-replay --candidate variant=candidate,source=shadow-replay \
                        --plan plan.json --answers answers.json --baseline-gpus 8 --baseline-rate 2.5 --candidate-gpus 8 --candidate-rate 5
fleetops shadow baseline save --name chat --select pool=chat --from 2026-11-01 --to 2026-11-08
fleetops shadow watch --name chat --select pool=chat --from 2026-11-24
fleetops shadow demo                                     # a candidate that looks faster and isn't
```

## Architecture

```mermaid
flowchart LR
  change["Infra change<br/>GPUs · config · network · topology · serving"] --> plan
  plan["plan<br/>predict the effect (Inference Sizer)<br/>size the test"] --> arms
  subgraph arms["Compare three ways"]
    live["Live<br/>engine traces of a canary or a mirrored pool"]
    replay["Replay<br/>the same sessions sent to both endpoints"]
    history["History<br/>this window against a saved baseline"]
  end
  arms --> match["Match the load<br/>calls in flight · prompt length · cache hit"]
  match --> checks
  subgraph checks["Check four things"]
    speed["Speed: TTFT, TPOT, end-to-end"]
    answers["Same answers: greedy tokens, log-probs"]
    infra["Infra signals: NCCL, power, faults"]
    cost["Cost: tokens/s per GPU, $ per M tokens"]
  end
  checks --> verdict["Verdict<br/>promote · roll back · extend · recalibrate"]
  verdict --> store[("Baseline store<br/>verdicts, baselines, calibration")]
  store --> history
  store -. calibrates .-> plan
```

The same design is on the team whiteboard: *Shadow upgrades for AI infra*.

### Components

| Piece | Code | Reads | Writes |
| --- | --- | --- | --- |
| Plan | `shadow.mjs` `plan`, `predict`, `testSize` | two Inference Sizer configs `{ model, gpu, tp, gpus?, rate? }`; a workload (trace, profile, or request records) | `plan.json`: predicted effects, requests per arm |
| Replay | `shadow-replay.mjs` `requestsFrom`, `run` | a trace or an agentic profile (FleetScope); two OpenAI-compatible endpoints | `request` records with `variant` and `pair`, in the store |
| Same answers | `shadow-replay.mjs` `answers` | a prompt set (built-in or a file); the two endpoints | `answers.json` |
| Compare | `shadow.mjs` `compare`, `effect`, `judge` | request records for each arm (store selectors or a results file); plan, answers, infra | a verdict; one line in `<store>/shadow/verdicts.jsonl` |
| Infra signals | `shadow.mjs` `infraSignals` | the store's `collective`, `device` and `log` records for each arm's nodes | part of the verdict |
| Baselines and watch | `shadow.mjs` `makeBaseline`, `drift` | request records of a service | `<store>/shadow/baselines/NAME.jsonl` (each save a version), `watch-NAME.jsonl` |

It is built on what fleetops already has:
- the data store and its `request` kind, filled from engine traces with `fleetops data import otlp-traces FILE --derive`;
- the collectors, for infra signals;
- FleetScope's trace readers and agentic profiles, for replay workloads;
- the Inference Sizer, for the prediction;
- `rollout`, which judges node-level versions (drivers, firmware) on failure rates. Shadow judges serving performance.

### Where the arms come from

- **Replay** is the cleanest comparison. Each recorded request goes to both endpoints at the same moment with one
  `pair` id, so the comparison uses per-request ratios. Those cancel request-to-request spread and need several times
  fewer requests.
  - Prompts are synthetic text of the recorded length.
  - Requests of one session repeat the previous prompt and append, so the engine's prefix cache sees the session's real
    reuse.
  - Output length is held to the recorded one (`max_tokens`, plus vLLM's `ignore_eos` unless `--no-exact-output`).
- **Live** compares engine traces of two pools serving production traffic: a canary split, or a mirrored shadow pool.
  The traffic differs between the arms, so the comparison matches load.
- **History** compares a window of a service with a saved baseline sample of the same service, at matched load.

## The statistics

- **Matched load.**
  - Every request is put in a stratum by the load it met:
    - calls in flight in its own arm when it started, in half-powers of two: 1, 2, 3, 4, 6, 8, 11, 16…;
    - prompt length, in powers of two;
    - cache hit: under 50%, 50–90%, over 90%;
    - for end-to-end time only, output length too.
  - In each stratum both arms reach with at least 5 requests, the effect is log(median candidate) − log(median baseline).
  - The strata are weighted by their traffic in both arms.
  - The report gives the share of baseline requests that found a matching stratum. When the arms ran at very different
    loads it is low, and the report says so.
- **Paired.** When at least half the requests carry a pair id on both arms, the effect is the median per-request log
  ratio.
- **Confidence intervals.** By bootstrap: 400 resamples, of requests within strata or of pairs.
- **Verdict per metric, against a gate** (default ±5% for TTFT, TPOT, end-to-end):
  - *worse*: the interval lies wholly above +gate;
  - *better*: wholly below −gate;
  - *same*: wholly inside ±gate;
  - *inconclusive* otherwise, with an estimate of how many more requests per arm would settle it.
- **Errors.** A two-proportion test; worse when the rate rises by more than half a point and p < 0.05.
- **Decision.**
  - *roll back*: answers differ, or anything is worse;
  - *extend the test*: anything is inconclusive;
  - *promote*: otherwise.
  - The prediction is checked separately. When it's off by more than 15% on any metric, the verdict says to recalibrate
    the sizer for this change, because then the model of the change is what's wrong, whichever way the change went.
- **Test size.** Requests per arm for a relative effect δ (two-sided α = 0.05, power 0.8):
  - unpaired: n = 2(1.96 + 0.84)²σ²/ln(1+δ)², with σ the spread of log TTFT;
  - paired: the same with σ shrunk to about 35%, the usual spread of a per-request ratio.

The comparison most dashboards make, all requests and no load matching, is shown beside every effect as *naive*. In the
demo, a candidate 8% slower at any load got less than half the traffic. Naively it looks 7.5% faster on TPOT; matched
on load it is 7.8% slower (+6.5% to +9.3%), and the decision is to roll back.

## Same answers

Speed gates miss numerics changes. A new kernel, FP8, a different tensor-parallel layout or an engine upgrade can
change outputs. `shadow answers` runs greedy decoding with log-probabilities on a fixed prompt set against both arms.
It reports:
- the share of prompts with identical tokens;
- where the first divergence falls;
- how far the log-probabilities of the shared tokens moved.

Fewer than 98% identical, or a mean log-prob drift over 0.05, is "different", and the decision is roll back however fast
the candidate is. Some changes are expected to alter outputs, such as a new quantization. For those, set
`--gates gates.json` with `{ "answers": { "match": 0.9 } }` and check quality separately.

## Safety

- `replay` and `answers` send nothing without `--live`. Without it they print what they would send: requests, sessions,
  tokens and duration.
- Only model calls are sent. Nothing else a recorded agent did (tool calls, writes) is repeated.
- API keys come from an environment variable named with `--api-key-env`, never from the command line.
- `--max-inflight` (64) bounds the load on each endpoint, and `--max-requests` (1,000) the length of a run.

## Limits

- Mirrored live traffic doesn't share the baseline's KV cache, so cache-hit effects need replay.
- New hardware needs a candidate pool to replay against or to mirror to.
- Small effects (2–3%) need thousands of requests even paired. `plan` says how many before you start.
- The demo and the tests use synthetic arms and mock endpoints. Nothing here has been run against two live engines yet.
