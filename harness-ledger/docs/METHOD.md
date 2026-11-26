# Method

How harness-ledger decides what was avoidable and what it cost. The code is `src/waste.mjs`, `src/prices.mjs` and
`src/gpu.mjs`; the defaults below are `DEFAULTS` in `waste.mjs` and can be changed with the CLI flags shown.

## Sessions and chains

A session is one harness conversation: a Claude Code session file (each subagent is its own session, with the main
session as `parent`), a Codex rollout, an OTel `gen_ai.conversation.id` (or OpenInference `session.id`, or the trace
when neither is set), a Langfuse session. Within a session, calls on one model form a **chain**. Side calls on other
models, such as a small model writing a title, run their own chain, because a prompt cache belongs to one model.

A **compaction** is a call whose input is less than half the previous call's in its chain. The context was rewritten
on purpose, so it isn't a cache miss, and nothing before it is carried past it.

## The checks

**Cache misses and expiries.** In an agent loop each call's context is the previous call's context plus the reply
and tool results, so the previous call's input is a prefix that a prompt cache should serve. For each call after the
first in a chain:

```
prefix = min(previous input, this input)
missed = prefix − this call's cache reads
```

It is a finding when `missed` is at least 1,024 tokens and 2% of the prefix (below that, cache block rounding and
small edits explain it). It's `cache-expired` when the gap since the previous call is longer than the cache lifetime
(`--cache-ttl`, 300 s: Anthropic's default cache and OpenAI's in-memory retention are minutes), else `cache-miss`.
Cost: missed tokens at what they were billed (cache-write price for the part re-written, input price for the rest),
minus what they'd have cost as cache reads. Calls without cache reporting (`cacheRead` null: some OTel
instrumentations) are skipped, and the report says how many calls reported cache.

What it can't see: a harness that never enabled caching looks like a miss on every call (which it is, from the
bill's point of view); a provider whose cache is shared across sessions can serve a first call from cache, which is
not counted as a saving.

**Unread cache writes.** A call that wrote to cache at a premium (cache-write price above input price) where no
later call in the chain read from cache within the lifetime. Cost: the premium. The last call of every session does
this; on one-shot subagents it adds up.

**Oversized tool output.** A tool result above `--big-result` (8,000 tokens). The part above 1,500 tokens (what a
summary or a capped output would take) is avoidable in the call that received it and in each later call that carried
it (until a compaction). Tokens: excess × (1 + calls carried). Cost: the excess at input price once, then at
cache-read price for each carry when the harness reports cache (input price when it doesn't). Tool output sizes are
estimated at 4 characters per token; transcripts don't hold the tokenizer's count for them.

**Repeated tool calls.** The same tool with the same arguments (compared by hash) within the last 25 tool calls of
the session, when the earlier one didn't fail. Tokens: the repeat's result, carried as above, plus the call's output
share. Tools that are meant to repeat (to-do lists, plans, questions to the user) are ignored. A repeat can be
deliberate (re-running tests after an edit), so the report names the tools: read it as "look here".

**Error loops.** A run of three or more consecutive calls in a session whose tool calls all failed, with the same
tool. The first two are a try and a retry; every call after them is avoidable in full.

**Failed calls.** A model call that returned an error but still reported tokens.

**Unused tool definitions.** When the request's tool definitions are logged (OTel `gen_ai.tool.definitions`,
OpenInference `llm.tools`, Langfuse tools), the share of their tokens belonging to tools the session never called, on
every call. Mostly cache reads, so cheap per call, but they fill context on every turn. Claude Code and Codex don't
log the definitions they send, so this check needs OTel or Langfuse input.

**Model tier (candidate).** A call with at most 300 output tokens, one tool call and no reasoning, on a model whose
price entry names a `downshift` model. It is counted only when the cheaper model would cost less even after
prefilling the whole context uncached, since the cache doesn't move with the model. These are reported apart and not
added to the avoidable total: a cheaper model needs a check that tasks still succeed.

## Overlap

A call can have several findings: a bloated tool result can be re-sent without a cache hit. For each call, the
findings' cost is scaled down so their sum never exceeds the call's cost. The token counts of findings about the
call's own input (cache, failures, loops, tool definitions) are capped the same way. Carried tool output is counted
across later calls by design.

## Prices

Per call, the first that applies:

1. **GPU time** for a call matched to an engine request with a priced replica (below).
2. **Recorded cost**: the harness logged a cost. When the model is also in the price table, the table's per-token
   prices are scaled so the call's cost matches the recorded one. Otherwise the recorded cost is spread with typical
   ratios (cache read 0.1×, cache write 1.25×, output 5× input).
3. **Price table**: `--prices`, matched on the model id or a prefix of it (`claude-sonnet-4-5` matches
   `claude-sonnet-4-5-20250929`; provider prefixes like `anthropic/` are dropped).

Otherwise the call is unpriced. Its tokens still count, and the report lists the models to add.

## GPU time for self-hosted models

1. **Engine requests.** Spans carrying `gen_ai.latency.e2e` or named `llm_request` (vLLM's request span), with
   queue, prefill and decode times and the replica from `k8s.pod.name` (or host, server address, service).
2. **Matching.** The engine span whose parent is the harness's chat span, when trace context was propagated. Else
   the first unmatched engine request in the same trace that started no earlier than a second before the call.
3. **Busy cost.** Per replica, busy time is the union of its requests' intervals. Batched requests overlap, so they
   share it. Busy cost = GPUs × $/GPU-h × busy time, split over the replica's requests by time in the model (prefill +
   decode, or end-to-end when the split is missing). The time between the replica's first and last request that isn't
   busy is **idle cost**, reported per replica and left out of the harness's cost (gpu-ledger counts it as idle).
4. **Per-token prices.** A call's prefill cost spread over its prefilled tokens (input not served from the prefix
   cache), and its decode cost over its output tokens. Cache reads cost 0. A cache miss then costs the prefill the
   prefix cache would have skipped.

## Outcomes

`harness-ledger outcomes` reads runs whose tasks have a cost, a call count and an outcome: SWE-bench per-instance
results, or tasks as JSON/CSV. Per run it reports:
- cost per task and per successful task;
- the share of spend on failed tasks;
- calls per successful and per failed task;
- a curve of call caps: for each cap N, every task is stopped at N calls. Each call is charged the task's average
  cost, and a success that needed more than N calls counts as lost. That is a conservative estimate, because later
  calls carry more context and cost more.

The cap reported is the one that saves the most while losing at most one point of success rate.

## Validation

- Token accounting matches ccusage on ccusage's own Codex fixtures: a subagent rollout (1,010 tokens) and a fork
  that copies its parent's history (16,000 non-cached input, 4,000 cached, 200 output). The fixtures are in
  `tests/fixtures` with ccusage's MIT license.
- Field names follow the OpenTelemetry GenAI registry (`gen_ai.usage.cache_read.input_tokens` and
  `cache_write.input_tokens` are included in `gen_ai.usage.input_tokens`) and the OpenInference spec
  (`llm.token_count.prompt_details.cache_read`/`cache_write`, `llm.tools.<i>.tool.*`).
- The checks are tested on constructed sessions with known answers (`tests/harness.test.mjs`). The demo plants one
  example of each cause in three harnesses' native formats and checks they're all found, the GPU cost adds up, and no
  text from the inputs reaches the output.

- On real use: TraceLab's 8,058 Claude Code and Codex sessions ([VALIDATION-TRACELAB.md](VALIDATION-TRACELAB.md)).
  The cache-expired check rests on the measured hit rate by pause length. Changing the cache lifetime from 5 to 60
  minutes and the oversized-output threshold from 8k to 20k tokens moves the avoidable total by one point; it changes
  which cause the waste is labelled with, not how much there is.
- Outcomes: SWE-bench Verified runs of mini-SWE-agent 2.x across 11 models ([VALIDATION-SWEBENCH.md](VALIDATION-SWEBENCH.md)).

No real trace yet combines per-call usage with task outcomes, so the waste checks haven't been scored against success.
