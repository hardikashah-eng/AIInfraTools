# harness-ledger

Where agent harnesses waste model resources, across harnesses. It reads what Claude Code, Codex, and any harness
instrumented with OpenTelemetry or Langfuse already write. It turns each model call into one shared record. Then it
reports, per harness, session, tool and model, which tokens, dollars and GPU-seconds needn't have been spent, why,
and what to change.

```
node tools/harness-ledger.mjs demo                      # three harnesses and a vLLM fleet, synthetic
node tools/harness-ledger.mjs scan --since 7d           # your own Claude Code and Codex logs on this machine
node tools/harness-ledger.mjs report traces/ --engine vllm-traces.json --replicas replicas.json --html report.html
```

```
harness-ledger: 77 model calls in 6 sessions from claude-code, codex, langgraph-support
  tokens 3.46M (input 3.44M, of which from cache 2.95M = 86%; output 19.6k)
  cost $2.32 (77/77 calls priced; example prices (pass --prices); 21 by GPU time)
  avoidable $0.7623 (33% of cost): 401.8k tokens of work at full price, 2.15M of context re-read from cache
  outcomes: 5 succeeded, 1 failed ($0.0763 spent on failed tasks); cost per successful task $0.4648

Where it goes, by cause:
       cost  full-price   re-read  count
    $0.3465      170.5k         0      3  Context re-sent without a cache hit
    $0.2640       76.5k         0      1  Cache expired during a pause
    $0.0781        1790    169.0k      3  Retrying a failing tool
    $0.0493      117.5k     1.74M      5  Oversized tool output carried forward
    …
```

## Why across harnesses works

Every harness differs in its logs, but they all make the same thing: model calls, each with tokens in (some from
cache), tokens out, the tools it asked for, and what those tools returned. One importer per harness converts its
format into that `llm_call` record. The waste checks and the cost join only read `llm_call`, so a new harness is one
importer. Token meanings are normalized on the way in: Anthropic's `input_tokens` excludes cache reads, while
OpenAI's and OpenTelemetry's include them. See [FORMATS.md](docs/FORMATS.md).

| Reads | From | What it gets |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` | every request's usage with cache reads and writes, tool calls, tool result sizes and errors, subagents |
| Codex CLI / IDE | `~/.codex/sessions/**/rollout-*.jsonl` | per-response usage with cached input and reasoning, shell and tool calls, outputs, exit codes, subagents and forks |
| OpenTelemetry GenAI | OTLP JSON, or one span per line | `chat` spans' usage, `gen_ai.tool.definitions` (tools offered), `execute_tool` spans, `invoke_agent` names: Copilot, Gemini CLI, OpenAI Agents SDK, LangGraph and others through OpenLLMetry or OpenInference |
| OpenInference | same | `llm.token_count.*`, `llm.tools.N`, TOOL spans (Arize Phoenix, LlamaIndex, CrewAI, DSPy) |
| Langfuse | observation export | GENERATION usage and cost, TOOL observations, sessions |
| TraceLab | `syfi_coding_trace.jsonl.gz` (streamed) | the public trace of 8,058 Claude Code and Codex sessions: cache accounting, timing, tool names, result sizes, errors |
| vLLM (`--engine`) | OTLP `llm_request` spans | per-request prefill and decode time per replica, to charge self-hosted calls GPU time |

## What counts as waste

| Cause | What happened | Fix it with |
|---|---|---|
| Context re-sent without a cache hit | the next call's prefix wasn't read from the prompt cache: the system prompt changed (timestamps, per-call IDs, reordered tools), history was edited, or nothing marked it cacheable | a byte-stable prefix, append-only history, cache breakpoints |
| Cache expired during a pause | the same, after a pause longer than the cache lifetime | 1-hour cache writes for slow tools and human pauses |
| Cache writes nobody read | write premium paid for a prefix no later call used | don't cache the last turn of one-shot subagents |
| Oversized tool output carried forward | a tool returned far more than a summary would, and every later call re-sent it | cap, paginate or summarize tool output; delegate reading to a subagent |
| Same tool call repeated | identical tool and arguments again in a session | memoize read-only tools; tell the agent nothing changed |
| Retrying a failing tool | three or more calls in a row with the same tool failing | stop after two, surface the error, make error messages actionable |
| Failed model calls | errored calls that used tokens | fix oversize requests, rate limits, timeouts |
| Tool definitions never used | tools sent with every call that the session never called | load tools on demand, tool search |
| Routing calls on a large model (candidate) | short single-tool steps on a model whose price file names a cheaper one; counted only if it saves after the cheaper model re-reads the context uncached | route them, after checking task success |

Each finding carries its tokens (split into work at full price and context re-read from cache), its cost at that
call's own prices, and the evidence. Causes can overlap on one call. Their cost is capped at what the call cost, so
the total avoidable never exceeds the bill. The method, the thresholds and what each check can't see are in
[METHOD.md](docs/METHOD.md).

## Cost: list prices, recorded cost, or GPU time

- **Hosted APIs.** `--prices` gives $ per million tokens per model, with cache read and write prices. The built-in
  table holds a few example models so the report reads out of the box. It's labelled as examples: pass yours. Calls
  on models not in the table are counted and listed as unpriced.
- **Recorded cost.** When a harness logged its own cost (Claude Code `costUSD`, OpenInference `llm.cost.total`,
  Langfuse cost), that cost is used.
- **Self-hosted models.** `--engine` takes the serving engine's OTLP traces. vLLM writes them with
  `--otlp-traces-endpoint`. `--replicas` gives each pod's GPUs and $/GPU-hour, or takes gpu-ledger usage records and
  its price file. A call is matched to its engine request through W3C trace context (the engine span's parent is the
  harness's chat span), or by trace and time. A replica's busy GPU time is split across its requests by time in the
  model. Idle time between requests is reported per replica and not charged to any harness. The waste checks then
  price prefill and decode in GPU dollars, so a cache miss costs what its prefill cost on the GPUs.

`--outcomes` (session → success/failure, JSON or CSV) adds cost on failed tasks and **cost per successful task**,
the number to compare harnesses and configurations by.

## Unit economics: cost per resolved task, and self-hosting vs the API

```
harness-ledger economics ~/.claude/projects --outcomes outcomes.csv
harness-ledger economics traces/ --outcomes outcomes.csv --self-host-model deepseek-v3 --gpu H200 \
    --self-host-success-rate 0.70 --gpu-rate 3
```

`economics` turns the waste report into numbers a budget owner can use:
- **Cost per resolved task:** the spend over the sessions that succeeded (`--outcomes`), and the share of spend that
  went to tasks that failed.
- **Fixes, ranked:** each waste cause's avoidable spend, per resolved task, and the cost per resolved task after it.
  Also a step cap on sessions, computed exactly from each session's own calls, and the successes it would cost.
- **Self-hosting vs the API:** the same workload sized with the Inference Sizer for an open model on a GPU, through
  FleetScope's agentic path (real arrivals, prompt growth, cache reuse, the KV working set). It is sized for the busiest
  day's peak and kept on all month.
  - The result is a break-even: the GPU-hour price under which self-hosting is cheaper per resolved task (scaled by the
    two models' success rates). With `--gpu-rate`, it also gives the volume from which self-hosting wins.
  - `--opencost FILE|URL` (OpenCost's `/inferenceCost/total`) or `--opencost-prom URL` (its `llm_cost_per_million_tokens`
    gauges) uses OpenCost's measured self-host cost per token instead. Its price per delivered input token is turned into
    a price per prefilled token, so a workload with a different cache hit rate is priced right. `--self-host-price` takes
    prices by hand.
  - `--calibration FILE` sizes with measured engine efficiencies, from `fleetops calibrate` or from a promoted shadow
    upgrade's `<store>/calibration/sizer.json`.
  - `--kv-offload` holds the part of the KV working set that doesn't fit in HBM in host memory (LMCache-style; 375 GB per
    GPU by default, the 3 TB per 8-GPU server InferenceX AgentX allows; `--cpu-kv-gb` changes it). A returning session's
    cached prefix is reloaded over PCIe (`--pcie-gbs`, 64 by default, at 70% of it). Offload is only used when that
    reload fits the TTFT target and the peak minute's reloads leave PCIe under 80% busy. The what-if is reported either
    way, so you can see what offload would save before turning it on.
  - Tokens per megawatt (AgentX's headline metric) is reported next to the GPU count: the peak minute's output tokens/s
    over the provisioned power, from the published per-node power, or the GPU's board power when none is published.
  - Calls longer than the open model's context are counted and flagged.

On TraceLab's workload, with SWE-bench success rates ([VALIDATION-ECONOMICS.md](docs/VALIDATION-ECONOMICS.md)):
- **One team:** at about $5,600 a month of API spend at Sonnet-class prices, self-hosting DeepSeek V3 or Kimi K2 pays
  only below about $0.25–0.50 a GPU-hour. Two whole nodes (one serving, one spare) are the floor at any load.
- **Pooled teams:** at $3 a GPU-hour on B200 it wins from about 8–16× that volume.
- **Context:** half the calls exceed those models' 128k context.

## On real data

- **Real coding-agent use** ([VALIDATION-TRACELAB.md](docs/VALIDATION-TRACELAB.md)). On TraceLab (8,058 Claude Code
  and Codex sessions, 665k calls, in relative prices):
  - 22% of spend was avoidable.
  - 76% of that was prompt caches expiring during pauses, 18% was misses inside the cache lifetime, and 5% was
    oversized tool output.
  - Oversized tool output is a third of all the context re-read from cache.
  - Claude Code's cache hit rate falls from 98% to 48% once a pause passes five minutes.
- **Cost per successful task** ([VALIDATION-SWEBENCH.md](docs/VALIDATION-SWEBENCH.md)). On SWE-bench Verified runs of
  one scaffold across 11 models:
  - the median run spends 39% of its budget on tasks it doesn't resolve;
  - a call cap that loses at most a point of resolution rate saves about 1%;
  - among models within 5 points of the best rate, cost per resolved task differs 10×.

  `harness-ledger outcomes` runs this on any outcome-labelled runs.

## Privacy

Transcripts can hold anything: code, secrets, customer data. The `llm_call` record keeps only counts, model and
tool names, and SHA-256 hashes of tool arguments (for spotting repeats). It never keeps prompt, completion, argument
or tool-output text. A tool output's size is measured and then dropped. `harness-ledger import --out calls.jsonl`
gives you a file that is safe to share or to send to a central place, and `report` reads it like the raw logs.

## Where it fits

[gpu-ledger](../gpu-ledger/) says which teams' GPUs were useful, idle or lost. harness-ledger goes one level up, to
which agent steps used the model work those GPUs did. With `--engine`, the two meet: harness call → engine request →
replica → GPUs → $. [fleetops](../fleetops/) stores the engine spans (`fleetops data import otlp-traces`), and
[hybrid-tracing](../hybrid-tracing/) fixes clock skew between harness and engine hosts when their traces disagree.
