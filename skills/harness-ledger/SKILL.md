---
name: harness-ledger
description: Finds where agent harnesses waste model resources, across harnesses. Reads Claude Code transcripts, Codex CLI rollouts, OpenTelemetry GenAI or OpenInference spans (Copilot, Gemini CLI, LangGraph, OpenAI Agents SDK, CrewAI, LlamaIndex…) and Langfuse exports into one record per model call, then reports avoidable tokens and cost by cause (prompt-cache misses and expiries, unread cache writes, oversized tool output carried forward, repeated tool calls, retry loops, failed calls, unused tool definitions, routing calls on a large model), by harness, session, tool and model, with the fix for each. With vLLM traces it charges self-hosted calls their GPU time. Gives cost per successful task when outcomes are known. Use for why an agent costs so much, token or cache efficiency of Claude Code, Codex or a custom agent, comparing harnesses or configurations, or agent cost per task.
license: Apache-2.0 (see LICENSE.txt)
---

# harness-ledger

Requires Node.js 22+. Paths are relative to this skill's folder. The CLI is
`scripts/harness-ledger/tools/harness-ledger.mjs` (written `harness-ledger` below: run it as
`node scripts/harness-ledger/tools/harness-ledger.mjs`). Every reading command takes `--json`.

## Rules

- **Prices are examples unless the user gives theirs.** The built-in table is labelled as examples. Say so when you
  quote dollars from it, and ask for a price file (or the provider's invoice rates) before anyone budgets on them.
  Calls on unpriced models are listed; never guess their price.
- **Don't read the transcripts into the conversation.** The tool reads them and keeps counts only. Don't open
  transcript files yourself to "check" a finding: they can hold secrets and code. Quote the report.
- **Findings are evidence, not verdicts.** A repeated tool call can be deliberate (tests re-run after an edit). A
  model-tier finding is a candidate that needs a check that tasks still succeed. Give the note the finding carries.
- **Say what the input can't show.** Claude Code and Codex logs don't include tool definitions, so unused tools needs
  OTel or Langfuse input. OTel without content capture has no tool output sizes. Calls with no cache reporting skip
  the cache checks. The report's `totals.cacheReported` says how many calls reported cache.

## Workflow

1. **Find the logs.** Ask which harnesses the user runs and where their traces go.
   - Claude Code or Codex on this machine: `harness-ledger scan --since 7d --json` reads `~/.claude/projects` and
     `~/.codex/sessions` (or `--claude DIR`, `--codex DIR`).
   - Anything else: `harness-ledger report PATH… --json` on files or folders: OTLP JSON or span-per-line files, a
     Langfuse export, transcripts copied from another machine. `--format` forces a format.
   - To move data off a machine safely: `harness-ledger import PATH… --out calls.jsonl` writes counts and hashes only.
   - No data: `harness-ledger demo --json`, three harnesses and a vLLM fleet, synthetic. Say it's synthetic.
   Formats and how to get OTel spans from each harness: [references/FORMATS.md](references/FORMATS.md).
2. **Price it.**
   - `--prices prices.json`: `{ "models": { "<model or prefix>": { "input", "cacheRead", "cacheWrite", "output"
     ($/M tokens), "tier", "downshift" } } }`.
   - Self-hosted: `--engine vllm-traces.json --replicas replicas.json`. Replicas are `{ "<pod>": { "gpus", "gpuType",
     "rate" } }`, or gpu-ledger usage records with `--gpu-prices`.
   - `--outcomes outcomes.json` (session → success/failure) for cost per successful task.
3. **Read the report** (`--json`):
   - `totals`: calls, sessions, tokens, cacheRead, cost, `avoidableCost`, `avoidableShare`, `avoidableFullPrice` (work
     at full price), `unpricedModels`.
   - `funnel`: tokens processed → from cache → full price → output → avoidable.
   - `byCause` with `fix`; `byHarness` (cache hit, cost per success); `byTool`; `sessions`; `byModel`; `top`
     findings with `note`; `gpu.replicas` with busy and idle cost; `outcomes`.
   - `--findings` adds every finding; `--html report.html` writes a page to share.
4. **Answer.** Lead with avoidable cost and its share, then the top two or three causes with their fixes and the tools
   or sessions behind them. When comparing harnesses, compare cost per successful task if outcomes are known, else
   cost and cache hit rate per session, and say which.

## Unit economics

- `harness-ledger economics PATH… [--outcomes FILE] --json`: cost per resolved task, the share of spend on failed
  tasks, fixes ranked by what they save per resolved task (with an exact step cap from per-call records), and an upper
  bound for all fixes together (they overlap).
- Self-hosting vs the API: add `--self-host-model ID --gpu ID` (Inference Sizer catalog ids, e.g. `deepseek-v3` on
  `H200`).
  - Lead with the break-even GPU-hour price, and give the volume from which self-hosting wins only with `--gpu-rate`.
  - Say which success rate is assumed (`--self-host-success-rate`, e.g. from SWE-bench) and how many calls exceed the
    open model's context.
  - With `--prices relative`, give `--unit-price` and say it's an assumption.
- Don't present the self-hosting side as a recommendation to buy hardware. It is a model: GPUs only, sized for the
  busiest day, kept on all month.

## Outcomes and real data

- `harness-ledger outcomes PATH… --json` reads outcome-labelled runs: SWE-bench `per_instance_details.json` (with its
  `metadata.yaml`), or tasks as JSON/CSV `{ task, cost, calls, outcome }`. It reports cost per successful task, the
  share of spend on failed tasks, and the call cap that saves the most while losing at most one point of success.
- `--prices relative` prices every model in the same units (cache read 0.1, write 1.25, output 5 per fresh input
  token), for comparing harnesses when real prices don't matter. Say the numbers are relative.
- Real-data results: [references/VALIDATION-TRACELAB.md](references/VALIDATION-TRACELAB.md) (8,058 Claude Code and
  Codex sessions: 22% of spend avoidable, mostly caches expiring in pauses) and
  [references/VALIDATION-SWEBENCH.md](references/VALIDATION-SWEBENCH.md) (39% of spend goes to unresolved tasks; step
  caps barely help), and [references/VALIDATION-ECONOMICS.md](references/VALIDATION-ECONOMICS.md) (self-hosting vs the API on
  TraceLab's workload: one team's volume favours the API; pooled volume can flip it).

## Methods

How each cause is decided, its thresholds (`--cache-ttl`, `--big-result`), overlap handling and the GPU-time join:
[references/METHOD.md](references/METHOD.md).
