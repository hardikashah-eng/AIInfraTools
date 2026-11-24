# A store that holds production volume

Milestone 7 of the [roadmap](../../ROADMAP.md). A 10,000-GPU fleet scraped every 10 seconds produces about 86M device
samples a day. This step adds:
- a columnar backend;
- streaming ingestion;
- rollups and retention;
- schema versions with migrations;
- a benchmark that measures ingest and the 24-hour root-cause query.

## Backends

| | `jsonl` (default) | `parquet` |
|---|---|---|
| Files | `<kind>/<day>.jsonl` | `<kind>/day=<day>/cluster=<name>/part-<uuid>.parquet` (zstd) |
| Dependencies | none | `@duckdb/node-api` (`npm install --no-save @duckdb/node-api@2.0.1-r.1` in `fleetops/`) |
| Queries | streams the day files in the window | DuckDB with partition pruning, the time window and a SQL predicate pushed down |
| Good for | tests, small fleets, shipping files around | production volume |

- **Choosing a backend:** `--backend parquet` on a new store. The choice is recorded in `fleetops-store.json`, and every
  later command uses it.
- **One interface:** all the tools use the same calls on both backends (`append`, `scan`, `query`, `distinct`,
  `summary`, `days`, `dropDay`). There's also an in-memory store for tests and the benchmark.
- **Synchronous calls:** DuckDB runs in a worker thread, and each call waits for it with `Atomics.wait`, so the store
  stays synchronous like the others.
- **Batched appends:** appends are buffered and written in batches; any read flushes first.

**Narrow reads for root-cause analysis.** The rules need three things from device telemetry:
- faulty or offline samples near the incident;
- which devices reported during it;
- which reported the day before.

Those are now three narrow queries: a pushed-down `bad` filter and two `distinct` queries. The day before comes from
the hourly rollup when the store has one. Root-cause analysis no longer loads every sample of the past day.

## Streaming ingestion (`fleetops serve`)

| Endpoint | Accepts | Becomes |
|---|---|---|
| `POST /api/v1/write` | Prometheus remote_write (Snappy + protobuf, decoded without dependencies) | `device`, through gpu-health's exporter mapping: identical to scraping `/metrics` |
| `POST /v1/metrics` | OTLP metrics, JSON (the same exporters through an OpenTelemetry collector) | `device` |
| `POST /v1/logs` | OTLP logs, JSON | `log`, classified by the same patterns as `kernel-log` and `app-log` |
| `POST /v1/traces` | OTLP traces, JSON | `span` (for milestone 8) |
| `GET /metrics`, `/healthz` | | fleetops' own counters: received, written, dropped by reason, late, queue depth, flush time |

- **Backpressure:** the queue is bounded (`--max-queue`). When it's full, a request gets 429 with `Retry-After: 1`, and
  remote_write and OTLP senders retry.
- **Idempotent:** records are deduplicated by content within a 15-minute window, so a retried delivery isn't written
  twice. Deduplication happens before the capacity check, so a retry of an accepted batch is never refused. A refused
  batch is not marked as seen, so its retry gets in.
- **Late and out-of-order data** are accepted and counted (`fleetops_ingest_late_total`).
- **OTLP protobuf isn't decoded:** configure the collector's `otlphttp` exporter with `encoding: json`; protobuf
  requests get 415. Metrics that no vendor profile maps, and log lines no pattern matches, are counted as unmapped.

**Prometheus:**
```yaml
remote_write:
  - url: http://fleetops:9400/api/v1/write
    queue_config: { max_samples_per_send: 20000 }
    write_relabel_configs:
      - source_labels: [__name__]
        regex: 'DCGM_FI_.*|gpu_.*|sambanova_.*'
        action: keep
```

## Rollups and retention

- **`fleetops data rollup`** writes one record per device per minute (`rollup-60/`) and per hour (`rollup-3600/`):
  - means of the utilization, clock, memory, temperature and power fields;
  - maxima of temperature, power and the error counters;
  - faults unioned, and the number of samples;
  - t is the start of the bin.

  On Parquet it runs in DuckDB and writes the rollup files directly. On JSON lines it streams the day.
- **`fleetops data compact --raw-days 7`** prints what it would do; `--apply` does it:
  1. rolls up the old device days;
  2. copies every raw record inside an incident window (incident records, ±2 h) into `keep/`;
  3. drops raw device, request and span days older than the cutoff.

  Logs, changes, jobs, inventory, topology and everything else stay.

## Schema versions

- `fleetops-store.json` records the layout version. A store from before versioning is version 1; a new store starts
  at the current version (2).
- A store at an older version gets a note on every command. `fleetops data migrate` shows what would change and
  `--apply` rewrites day by day, so an interrupted run can be repeated.
- A store written by a newer fleetops is refused.
- Migration 1 → 2 makes GPU indexes strings everywhere: some adapters wrote numbers, so "0" and 0 were two GPUs.

## Measured (`tools/bench-scale.mjs`)

Measured on one node: 2 vCPUs, 7 GB of memory, Node 22, single-threaded ingest.

| Scale | Backend | Ingest (remote_write → store) | Store | 24 h root-cause query | With hourly rollup |
|---|---|---|---|---|---|
| **10,000 GPUs every 10 s, 25 h (90M samples)** | parquet | **8,981 samples/s: 9× the 1,000/s needed** | 1.1 GB (bulk-loaded in 682 s, about 132,000 samples/s) | **1.22 s** | **0.62 s** |
| 1,000 GPUs every 60 s, 26 h (1.56M) | parquet | 7,759/s | 18 MB | 0.07 s | 0.17 s |
| 1,000 GPUs every 60 s, 26 h (1.56M) | jsonl | 8,311/s | 195 MB | 4.98 s | 3.13 s |

- The hourly rollup of one full day at 10,000 GPUs every 10 s (86.4M samples → 240,000 records) takes 1 min 51 s in
  DuckDB, using 231 MB of memory.
- Milestone 7's done-when was sustained ingest of 10,000 GPUs at 10 s on one node, and a 24 h root-cause query under
  10 s. Both are met on the Parquet backend. JSON lines don't scale to it: the query time grows with the samples in
  the window.
- **In CI**, `fleetops.yml` runs the 1,000-GPU size on both backends with `--min-ingest 3000 --max-rca 10`.

## Limits

- **Ingest is one process.** About 9,000 samples/s covers about 90,000 GPUs at a 10 s interval; past that, shard by
  cluster (one `serve` per cluster, same store root).
- **Rollup records from DuckDB carry `null`** for fields the raw samples never had; the JavaScript rollup omits them.
- **The Parquet backend dedupes appends against a day's hashes,** loaded once per day per process. The ingest
  pipeline's own deduplication window is what protects streaming ingest.
