---
name: hybrid-tracing
description: Unifies distributed traces across on-prem and neocloud (or any multi-site) clusters and fixes clock skew between machines. It estimates each machine's clock offset from OpenTelemetry spans with the NTP four-timestamp method, rewrites exported OTLP/JSON traces so child spans no longer start before their parents, checks a node's clock sync (chrony, PTP), and supplies OpenTelemetry Collector (agent, gateway, tail sampler), chrony and ptp4l configs for a hybrid pipeline. Use when traces across sites look out of order or show negative gaps or causality violations, when setting up one tracing view across on-prem and cloud, or when checking NTP or PTP clock sync on GPU nodes.
---

# Hybrid tracing and clock sync

Two jobs: **fix skew in traces you already have**, and **set up a pipeline and clocks** so new traces line up.

Requires Node.js 20+. Paths below are relative to this skill's folder. The tool is in `scripts/hybrid-tracing/`.

## Fix skew in exported traces

The input is OTLP/JSON: one request, an array, or JSON lines as the collector's file exporter writes them. Start with a dry run:

```bash
node scripts/hybrid-tracing/tools/fix-skew.mjs traces.jsonl --dry-run --json
```

- **Defaults:** one site, `onprem`, is the reference clock (`--ref-site`). The site of each span comes from the resource attribute `site` (`--site-key`).
- **Known offsets:** if chrony already reports offsets, pass them with `--known offsets.json`.
- **Writing:** to write corrected traces, drop `--dry-run` and add `-o fixed.jsonl`. Corrected spans carry `clock.skew_corrected_ns`.

The report has these fields:

- `rows`: one per machine (`domain`) with its `site`, `offsetNs`, uncertainty `errNs`, `method` and `samples`. `method` is one of:
  - `reference`: the reference clock;
  - `two-way`: estimated from round-trip pairs;
  - `bound`: one-way traffic only, so the estimate is looser;
  - `measured`: taken from `--known`;
  - `unanchored`: estimated, but not linked to the reference site;
  - `none`: no cross-machine traffic, so no estimate.
- `before` and `after`: violation counts (`startBeforeParent`, `endAfterParent`). `spans` and `corrected` are counts.

Exit code 1 means violations remain. The usual causes are:

- the machine has only one-way traffic (`bound`), so the estimate is loose;
- clock jumps during the window: split the file by time;
- spans genuinely out of order, such as async work started after the parent ended.

Try `--demo` first if the user wants to see how it works: synthetic traces with known offsets, and the estimate compared with the truth.

When presenting:
- Give the machines with the largest offsets and their uncertainty.
- Give how many violations were fixed.
- Say whether residual skew is small enough for the latencies they care about. A 2 ms residual matters for a 5 ms hop, not for a 2 s request.

## Check a node's clock

`scripts/hybrid-tracing/clock/check-clock.sh` must run **on the node being checked**. It reads `chronyc -c tracking` and computes chrony's own bound on the clock error: |offset| + root dispersion + root delay / 2.

- **Options:** `--max-error-ms 1` sets the allowed error, `--site NAME` labels the node, and `--textfile FILE` writes Prometheus metrics for node_exporter.
- **Exit codes:**
  - 0: synced and within the bound;
  - 1: synced but outside it;
  - 2: not synced, or chrony is unreachable.
- **Uses:** it also works as a Kubernetes readiness probe or a cron check.
- **Remote nodes:** if the user can run commands there, give them the command (or run it over SSH if they ask).
- **Don't change clocks yourself.** Never step a clock or restart chrony/ptp4l on a production machine unless the user explicitly asks.

## Set up the pipeline and clocks

Ready configs are in `scripts/hybrid-tracing/`. Adapt hostnames, endpoints and site names, and keep the structure.

| File | Purpose |
|---|---|
| `clock/onprem-timeserver.chrony.conf` | On-prem time servers: PTP hardware clock as refclock, NTS, orphan mode if upstream is lost |
| `clock/onprem-node.chrony.conf`, `clock/neocloud-node.chrony.conf` | Nodes. Neocloud nodes follow the on-prem time servers, so both sites share one timescale |
| `clock/ptp4l.conf` | PTP client (`clientOnly`) for nodes with PTP-capable NICs |
| `collector/agent.yaml` | Per-node collector: receives OTLP, stamps `site`/host, measures the node's clock against the on-prem time servers, scrapes the serving engine and GPU exporters |
| `collector/gateway-onprem.yaml`, `collector/gateway-neocloud.yaml` | Site gateways. They redact prompt and response content; the neocloud one buffers to disk (`file_storage`) across WAN outages |
| `collector/tailsampler.yaml` | Tail sampling with load-balancing by trace ID, so whole traces are sampled together |
| `deploy/chrony-daemonset.yaml`, `deploy/skew-corrector.yaml` | Kubernetes manifests: chrony on every node, and the streaming skew corrector |

`tools/skew-corrector.mjs` runs the correction as a service: it takes OTLP in, sends corrected OTLP out, and exposes `/offsets` and `/metrics`. Use it when traces can't be fixed after the fact.

Explain the design when asked:
- trace context propagates through W3C `traceparent`;
- each node runs a collector agent, which feeds a gateway per site, which feeds a tail sampler routing by trace ID;
- one timescale comes from on-prem PTP/chrony that the neocloud follows;
- the corrector catches what clock sync misses.

Details are in [references/CLOCKS.md](references/CLOCKS.md) and [references/OVERVIEW.md](references/OVERVIEW.md).
