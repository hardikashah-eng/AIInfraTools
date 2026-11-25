# Formats

What each importer reads and how it maps to `llm_call`. Files are detected by name and content. `--format
claude-code|codex|otel|openinference|langfuse` forces a format. `.gz` files are read too.

## The record

```json
{ "kind": "llm_call", "t": 1764000000.5, "harness": "claude-code", "session": "…", "agent": "main", "id": "msg_…|req_…",
  "model": "claude-sonnet-4-5-20250929", "provider": "anthropic",
  "input": 41210, "cacheRead": 40100, "cacheWrite": 1106, "output": 212,
  "toolCalls": [{ "name": "Read", "id": "toolu_…", "argHash": "3f1c…", "resultTokens": 2210 }] }
```

`input` includes cached tokens (the OpenTelemetry meaning). `cacheRead`/`cacheWrite` are null when the source
doesn't report cache. Optional: `parent`, `traceId`, `spanId`, `reasoning`, `toolsOffered`, `toolDefTokens`,
`finish`, `error`, `durS`, `costUSD`, `outcome`. A tool call's `error` is true when the tool failed.

## Claude Code

Session transcripts, one JSON object per line, in `~/.claude/projects/<project>/<session>.jsonl` (or under
`$CLAUDE_CONFIG_DIR`).

- `type: "assistant"` lines with `message.usage`: `input_tokens` (excludes cache), `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`. `input` = the sum of the three.
- Claude Code writes a line per content block of a response, each repeating the usage. Lines with the same
  `message.id` and `requestId` are one call.
- `tool_use` blocks are the call's tool calls. `tool_result` blocks in later `type: "user"` lines give each result's
  size and `is_error`.
- `isSidechain: true` lines (subagents) become session `<sessionId>:<agentId>`, with `parent` = the session.
- `costUSD`, when present, is the recorded cost. API error lines (`isApiErrorMessage`) become failed calls.

## Codex

Rollouts in `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (or under `$CODEX_HOME`).

- `session_meta`: the session id, and for subagents and forks the parent (`source.subagent.thread_spawn.parent_thread_id`
  or `forked_from_id`).
- `turn_context.model`: the model for the calls that follow.
- Usage: `token_usage_record` lines (one per response, by `response_id`; lines a fork copied from its parent carry
  the parent's `thread_id` and are skipped), or, in rollouts without them, `event_msg` `token_count` events
  (`info.last_token_usage`). A snapshot that repeats the previous total is the same call. `input_tokens` includes
  `cached_input_tokens`; `reasoning_output_tokens` is part of output.
- `response_item` `function_call` / `custom_tool_call` / `local_shell_call` are tool calls, assigned to the next usage
  event. Their `*_output` items give result size; `metadata.exit_code` ≠ 0 or `success: false` is an error.

## OpenTelemetry GenAI

OTLP/JSON bodies (`{"resourceSpans": …}`), arrays of them, or one span per line (as the OTel JS file exporter and
Copilot write them). Span times may be nanosecond strings, `[seconds, nanos]` or ISO.

| Span | Recognized by | Read |
|---|---|---|
| model call | `gen_ai.operation.name` = `chat`, `text_completion`, `generate_content` | `gen_ai.usage.input_tokens` (includes cache), `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.response.model` / `request.model`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.tool.definitions`, `gen_ai.response.finish_reasons`, `error.type` |
| tool | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments` (hashed), `gen_ai.tool.call.result` (size only), status ERROR |
| agent | `invoke_agent` | `gen_ai.agent.name`, inherited by the calls under it |

A tool span is assigned to the latest model call in its trace that ended before the tool started. The harness name
is `service.name` unless `--harness` is given. Argument and result content is opt-in in OTel instrumentations; when
it's off, repeats and output sizes can't be checked, and the rest still can.

To get these spans: Gemini CLI, Copilot,
the OpenAI Agents SDK and Strands emit GenAI spans. LangChain/LangGraph, LlamaIndex, CrewAI and others do through
OpenLLMetry or OpenInference instrumentations. Point the exporter at a collector with a file exporter, or at
fleetops' OTLP endpoint, and give harness-ledger the file. (Claude Code's own OTel export,
`CLAUDE_CODE_ENABLE_TELEMETRY=1`, sends metrics and events rather than GenAI spans; read its transcripts instead.)

## OpenInference

The same files, with `openinference.span.kind`. LLM spans: `llm.token_count.prompt` (includes
`prompt_details.cache_read` and `cache_write`), `llm.token_count.completion`, `completion_details.reasoning`,
`llm.model_name`, `llm.provider`, `session.id`, `llm.tools.<i>.tool.name` / `tool.json_schema`, `llm.cost.total`.
TOOL spans: `tool.name`, `input.value` (hashed), `output.value` (size only).

## Langfuse

Observation exports: a JSON array, `{"data": […]}` from the public API, JSON lines, or traces with nested
`observations`.

- GENERATION: `usageDetails` (or `usage`). Canonical keys exclude cache: `input` + `input_cached_tokens` (or
  `cache_read_input_tokens`) + `input_cache_creation`. OpenAI-style `prompt_tokens` includes cache. `model`,
  `calculatedTotalCost` / `costDetails.total`, `level: ERROR`, tools from `modelParameters.tools`, tool calls from
  `output.tool_calls` (names and argument hashes only).
- TOOL observations: tool calls, assigned to the latest generation in the trace that ended before them, with output
  size and `level: ERROR`.
- Session: `sessionId` (from the observation or its trace), else the trace.

## Outcomes

`--outcomes` file: `{ "<session>": "success" | "failure" }`, a JSON array of `{ session, outcome }`, or CSV
`session,outcome`. `pass`, `resolved`, `true` and `1` read as success; `fail`, `error`, `abandoned`, `false` and `0`
as failure. A subagent session takes its parent's outcome.

## Engine spans and replicas

`--engine`: OTLP traces from the serving engine. vLLM: start it with `--otlp-traces-endpoint` and
`--collect-detailed-traces model` for prefill and decode times. `--replicas`:

```json
{ "vllm-llama70b-0": { "gpus": 4, "gpuType": "H100", "rate": 2.5 } }
```

or gpu-ledger usage records (`name`, `gpus`, `gpuType`, optional `rate`), with `--gpu-prices` in gpu-ledger's price
format for those without a rate.
