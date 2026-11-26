# Agentic workloads

Agent traffic doesn't fit the usual sizing input of "N requests per second at ISL×OSL". A session is a loop of model
calls. Each call's context is the previous one plus the reply and tool output, so the context grows turn by turn and
most of it is re-read from the prefix cache. Calls are separated by tool runs (seconds) and by people (minutes). The
context is occasionally compacted, and subagents add bursts.

Sizing from the average prompt gets agent traffic wrong in two opposite ways:
- it counts the whole prompt as prefill on every call, which overstates compute;
- it counts only requests in flight, which understates memory, because idle sessions hold their KV cache between
  turns.

`tools/agentic.mjs` fits a profile of how sessions behave from a real trace, generates synthetic sessions from it at any
load, measures what a workload asks of a fleet, and sizes GPUs for it.

```
node tools/agentic.mjs fit tracelab -o coding.json                      # profile from the public TraceLab trace
node tools/agentic.mjs fit my-agent.jsonl -o mine.json                  # or from your own sessions
node tools/agentic.mjs size coding.json --sessions-per-hour 2000 --model qwen3-coder-480b --gpu B200
node tools/agentic.mjs synth coding.json --sessions-per-hour 2000 --hours 2 -o load.csv   # replay through `fleetscope run --trace`
node tools/agentic.mjs validate tracelab --hours 4 --markdown            # how well a profile stands in for real sessions
```

## Inputs

| Trace | Where from | What it gives |
| --- | --- | --- |
| TraceLab | `tracelab` (fetched at a pinned release, SHA-256 checked) or `syfi_coding_trace.jsonl.gz` | 8,058 real Claude Code and Codex sessions: each provider's cache accounting, timing, tool calls |
| AgentX ("weka" traces) | SemiAnalysis, Hugging Face `semianalysisai/cc-traces-weka-*` | Claude Code sessions with subagents; prompts as 64-token chained block hashes; reuse within a session is computed from the hashes |
| Mooncake | Kimi's released traces | Requests with 512-token block hashes in one hash space (chat and API traffic, not agents) |
| Your own | FleetScope CSV or JSON lines with `session` (and `agent` for subagents), or harness-ledger's `llm_call` records | Whatever your harness logs |

`harness-ledger import` turns Claude Code, Codex, OpenTelemetry and Langfuse logs into `llm_call` records that this tool
reads. That is the way from your own agents to your own profile.

## The profile

A profile is two levels, so each synthetic session behaves like a real one rather than like an average of all of them.

- **Per-stream parameters, sampled whole** (up to 4,000 streams): turns; first prompt; context growth and uncached
  tokens per turn, as 13-point quantiles of that stream's own turns; pace of the tool loop; share and length of long
  pauses; where it compacts and how much it keeps; output length; model time per call. A session that reads big files
  stays a session that reads big files.
- **Pooled per-turn variation**, normalized by each stream's own means: gaps, output, model time; the cache hit of a
  session's first call (system prompts are shared across sessions); the share of context still cached after a pause
  longer than the cache lifetime; how often, and how far, smaller edits cut the context.
- **Long pauses come in runs.** Gaps follow a two-state chain (short: tool loop; long: a person or a slow tool).

Profiles hold numbers only: no prompts, no tool output, no session ids. You can share them.

## What a workload asks of a fleet

`stats` and `validate` report per-minute windows:
- calls per second;
- prefill tokens per second (input not served from cache);
- output tokens per second;
- calls in flight;
- the **KV working set**: the tokens of contexts that must stay resident to be re-read. That is each stream's latest
  context, held from its call until its next call or until the cache lifetime runs out, whichever comes first.

## Sizing

`size` hands the Inference Sizer the workload's peak-minute call rate, mean and p99 prompt, output and cache hit (the
sizer's request-rate path, so prefill and decode come from the measured rate). It also checks the KV working set
against the HBM left after weights on the chosen layout. The answer is the larger of the two GPU counts, and it says
which one binds. A flat sizing of the same calls is shown beside it: the same rate and mean ISL/OSL, no reuse, no idle
sessions.

## How well it works

On TraceLab, a profile fitted on 70% of the sessions was checked against replaying the other 30% on the same arrivals
([VALIDATION-AGENTIC.md](VALIDATION-AGENTIC.md)):
- **Within 1–8%:** cache hit, calls per second, prefill and output tokens per second (mean and p95 minute).
- **Mean prompt:** 15% low.
- **KV working set:** 28% low.
- **GPUs:** 48 from the synthetic sessions against 40 from the held-out ones.
- **Flat ISL/OSL sizing:** no layout meets a 2 s TTFT at all; relaxed to 10 s, it asks for 440 GPUs.

Pooling all turns into one distribution per quantity, which is the obvious design, put prefill 2.5× too high: heavy
per-stream tails got multiplied across streams. That is why the profile keeps per-stream quantiles.

Limits:
- Timing comes from the providers that served the trace, not from your GPUs. The profile carries the shape of the work
  (growth, reuse, gaps, tool time), not latency.
- The KV working set assumes contexts stay in GPU memory for the cache lifetime. Offloading to CPU memory or storage
  needs fewer GPUs and adds reload time.
- TraceLab is mostly coding agents. Fit your own profile for other kinds of agent.
