# Importing real traces

The **Trace replay** node accepts real request logs. Upload a file in the node's details panel or drop it there. FleetScope reads only arrival times, token counts, cache hits and recorded latencies; it never reads prompt or response text. The format is detected from the file's contents, not its name.

| Source | What to export | Arrival | Tokens | Cache hits | Recorded latency |
| --- | --- | --- | --- | --- | --- |
| vLLM tracing | OTLP JSON from an OpenTelemetry Collector `file` exporter, or a Jaeger JSON export | span start | `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens` | – | `gen_ai.latency.time_to_first_token`, `time_in_queue`, `e2e` |
| LiteLLM | Spend logs (JSON array or JSON lines) | `startTime` | `prompt_tokens`, `completion_tokens` | – | TTFT = `completionStartTime − startTime`, e2e = `endTime − startTime` |
| OpenAI-style gateway | JSON lines with an OpenAI `usage` object | `timestamp`, `created`, `startTime`… | `usage.prompt_tokens`, `usage.completion_tokens` | `usage.prompt_tokens_details.cached_tokens` | `ttft`, `ttft_ms`, `latency_ms`… |
| Anthropic-style gateway | JSON lines with an Anthropic `usage` object | `created_at`, `timestamp`… | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `output_tokens` | `cache_read_input_tokens` | `time_to_first_token`… |
| CSV | Azure LLM trace (`TIMESTAMP, ContextTokens, GeneratedTokens`) or `timestamp, input_tokens, output_tokens` | `timestamp` (s, ms, or ISO) | as named | optional `cached_tokens` | optional `ttft_s`, `queue_s`, `e2e_s` |

Sessions are picked up from `session_id`, `conversation_id`, `end_user` or `user` when present; they are counted now and kept for closed-loop session replay later.

## vLLM: capturing spans

Start vLLM with tracing pointed at a collector:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  --otlp-traces-endpoint "$OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
```

Have the collector write spans to a file (the `file` exporter in the contrib distribution writes one OTLP JSON document per line):

```yaml
receivers:
  otlp:
    protocols: { grpc: {}, http: {} }
exporters:
  file:
    path: /var/log/otel/vllm-spans.jsonl
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [file] }
```

If you already send spans to Jaeger, export a trace search as JSON and upload that instead.

**Sampled traces:** if spans are sampled (say 10%), arrivals are thinned by the same factor. Set the Trace replay node's load multiplier to the inverse (10×) to restore the real load.

## Recorded vs simulated

When the log carries TTFT, the run compares it with the simulation on the same requests:

- a **Recorded TTFT p99 (log)** KPI tile with the simulation's error,
- a dotted **recorded p99** line on the TTFT chart,
- recorded p50/p99, queue time and a calibration hint in the Trace replay node's details,
- recorded TTFT, queue and end-to-end time in each request's lifecycle.

To use this as a first calibration check, build a graph that matches the fleet that served the log (instance counts, GPU types, max batch). Then compare the recorded and simulated percentiles. The spec's proposed acceptance bar is within 10% on p50 and 20% on p99.

## Closed-loop replay

By default a trace replays **open loop**: every request is sent at its recorded time. That is right for independent traffic, but wrong for sessions. In an agent loop the next turn is sent only after the previous answer arrives, so on a slower fleet the real users would have sent less traffic, later. Open-loop replay piles up a backlog no user would create; on a faster fleet it hides that users would have sent more.

Set the Trace replay node's **Replay** to **Sessions (closed loop)**:

- Requests are grouped by session. The importer reads `session_id`, `conversation_id`, `end_user` or `user` (top level or under `metadata`), and the `session` column in CSV.
- A session's first turn is sent at its recorded time. Each later turn is sent when the simulated previous turn finishes, plus the recorded **think time**: the gap between the previous turn's recorded end and this turn's start.
- The previous turn's recorded end is its start plus recorded end-to-end latency, or plus TTFT and 30 ms per output token, when only TTFT is logged. With neither, the think time is the arrival gap (assuming the recorded fleet was fast), and the node's details count how many gaps were estimated.
- A turn that starts before the previous one ended (a parallel tool call) is treated as a branch: it is sent at the same offset from the previous turn's simulated start.
- Requests without a session id still replay at their timestamps.
- **When a turn fails** (rejected for KV, cut by an outage): retry it once after 5 s, or give up the rest of the session.
- Surges clone whole sessions rather than single requests.

The run reports how far turns fell behind the log: the **Turns behind the log** KPI (p50 and p90) and a note in the overview. A large drift means the simulated fleet is slower than the one that recorded the log, and the closed-loop numbers are the ones to trust.

The sample **Agent sessions log** trace and the **Replay an agent log** template show this on synthetic data.

## Large logs: the converter

The browser keeps the first 30 minutes or 40,000 requests. For bigger logs, cut a window and sample it first:

```bash
cd fleetscope
node tools/convert-trace.mjs /var/log/otel/vllm-spans.jsonl \
  --start-offset 3600 --minutes 30 --sample 0.25 -o busy-hour.csv
# prints the detected format, request count, how many requests carry TTFT and cache data,
# and the load multiplier to replay with (4x for --sample 0.25)
```

The output is FleetScope's canonical CSV (`timestamp, input_tokens, output_tokens, cached_tokens, ttft_s, queue_s, e2e_s, session`), which uploads back without loss. Sampling is deterministic, so the same command always keeps the same requests.
