# Running fleetops as a service, securely

Milestone 10 of the [roadmap](../../ROADMAP.md). `fleetops serve` is now one service: it ingests the fleet's
telemetry, answers reads for people, Grafana and other tools, and is safe to run on a shared network.

```
fleetops token create --tokens tokens.jsonl --name collector --roles ingest
fleetops token create --tokens tokens.jsonl --name grafana   --roles read --infra
fleetops token create --tokens tokens.jsonl --name team-chat --roles read --pools chat-70b --namespaces ns-chat
fleetops serve --host 0.0.0.0 --store /data --backend parquet --tokens tokens.jsonl --on-prem prometheus.monitoring.svc
```

## Read API

| Endpoint | Returns |
|---|---|
| `GET /api/summary` | records per kind (unscoped or infra tokens) |
| `GET /api/query?kind=K&from=T&to=T&limit=N&where=k=v` | records, scoped to the token's tenant |
| `GET /api/series?kind=K&field=F&agg=avg\|max\|min\|sum\|count\|p50\|p99&step=S&node=&gpu=&pool=&job=&where=` | `[{ t, time, value }]`, a time series for Grafana |
| `GET /api/incidents[?status=S]`, `/api/incidents/ID`, `…/timeline` (HTML), `…/postmortem` (Markdown) | the incident workflow |
| `GET /api/diagnose?symptom=S&from=T&to=T&pool=P&job=J&nodes=a,b` | a diagnosis on demand |

**Grafana:** `deploy/grafana-dashboard.json` uses the Infinity data source. Point it at `http://fleetops:9400` with
an `Authorization: Bearer <read token>` header. The dashboard has five panels:
- TTFT p99 per pool;
- failed jobs per 10 minutes;
- the hottest GPU;
- mean SM activity;
- open incidents.

fleetops' own `/metrics` (ingest, drops by reason, redactions, queue depth) can be scraped with a read token.

## Access

| | |
|---|---|
| **Tokens** | `Authorization: Bearer fo_…`. Only the SHA-256 is stored (`token create` prints the token once), and comparisons are constant-time. |
| **Roles** | `ingest` (the write endpoints), `read` (the API and `/metrics`), `admin` (both). |
| **Tenant scope** | `*`, or any of `namespaces`, `owners`, `pools`, `clusters`, plus `infra: true` for the shared hardware records (device, log, topology, inventory, health). A team token sees its own pools, jobs (through their placement's namespace), changes in its namespaces and incidents on its pools. It can diagnose only its own pools. |
| **Open mode** | Without `--tokens` there is no auth, and `serve` refuses to listen on anything but localhost unless `--no-auth` is given. |
| **Audit** | Every API call goes to `<store>/audit/api.jsonl`: who, tenant, path, status, records returned. Refusals are logged too. |

## Data protection

- **Redaction at ingest, before the queue.**
  - Span attributes that carry request content are dropped: `gen_ai.prompt*`, `gen_ai.completion*`, `*.messages`,
    `input.value` / `output.value`, `llm.input_messages`, HTTP bodies.
  - Bearer tokens, API keys (`sk-…`, `AKIA…`, `ghp_…`), `password=`/`token=` values and email addresses are masked in
    log lines and string attributes.
  - Counted in `fleetops_ingest_redacted_total`.
  - The test sends a prompt, a completion, a token and an email, and checks that none of them is in any stored file.
- **On-prem mode.** With `--on-prem [HOST,…]` or `FLEETOPS_EGRESS_ALLOW`, every outbound HTTP call fleetops makes
  (paging, optimizer webhooks, Prometheus guards) is refused unless its host is listed. Localhost is always allowed.
  `--on-prem` with no hosts means no external calls at all.

## Operations

- **Optimizer guards can read Prometheus at check time:**
  `{ "prometheus": "http://prometheus:9090", "query": "<PromQL>", "limit": 1.0 }`. A value above the limit after a
  stage rolls it back, as with store-based guards.
- **Exporter contract tests** (`tests/fixtures/contracts/`) cover pinned formats:
  - DCGM exporter 3.3.x (old throttle-reasons name) and 4.x (clock-event reasons, pod labels, XID);
  - AMD device metrics exporter 1.x;
  - vLLM with `gpu_cache_usage_perc` (0.6) and `kv_cache_usage_perc` (0.11).

  Every field the tools need must map. When an exporter changes its output, add a fixture for the new version.
- **Deploying:**
  - `Dockerfile`: build from the repository root (`docker build -f fleetops/Dockerfile .`).
  - `deploy/fleetops.yaml`:
    - one writer Deployment on a persistent volume (Parquet), non-root, read-only root filesystem;
    - tokens from a Secret;
    - egress limited to in-cluster Prometheus;
    - readiness and liveness on `/healthz`;
    - a nightly CronJob for rollups and retention.

## Done-when, checked

`tests/service.test.mjs` covers:
- tokens: 401 without one, 403 for the wrong role, team tokens see only their pools and jobs, and every read is
  audited;
- redaction: no request content or secrets are stored;
- on-prem: a refused PagerDuty call, an allowed in-cluster Prometheus guard, and a refused external one;
- a Prometheus-guard rollback;
- the exporter contracts.
