# Installing fleetops

Three ways, one command each. All of them make three tokens (admin, ingest for collectors, read for Grafana),
store only their SHA-256, and give you the tokens once in a 0600 file to copy and then delete.

| Where | Command | Needs |
|---|---|---|
| **One machine** (Linux, macOS) | `./fleetops/install/install.sh` | Node.js ≥ 20 (git, if run through curl) |
| **Docker Compose**, with Grafana provisioned | `./fleetops/install/install-docker.sh` | Docker with Compose v2 (Windows: WSL2) |
| **Kubernetes** | `./fleetops/install/install-k8s.sh --image REGISTRY/fleetops:TAG [--build]` | kubectl, openssl (docker or podman for `--build`) |

Without a checkout:
`curl -fsSL https://raw.githubusercontent.com/hardikashah-eng/AIInfraTools/main/fleetops/install/install.sh | bash`.
It clones the repository into `~/.fleetops/src`.

## install.sh: one machine

1. Checks Node.js. It never installs anything system-wide; if Node is missing it says how to get it.
2. Installs DuckDB into the checkout for the Parquet backend. If npm can't, it falls back to JSON lines.
3. Creates `~/.fleetops/{data,etc,bin,log}`, the tokens, and a `fleetops` command bound to that store.
4. Starts `fleetops serve` as a **systemd user service** on Linux or a **launchd agent** on macOS, else in the
   background with a pidfile.
5. Waits for `/healthz` and prints the Prometheus `remote_write`, OpenTelemetry collector and Grafana settings with
   your tokens filled in.

**Options:** `--dir`, `--port` (9400), `--host` (127.0.0.1; use 0.0.0.0 for other machines, tokens are always
required), `--backend parquet|jsonl`, `--on-prem HOSTS`, `--no-service`, `--no-start`.

**Rerun safely:** rerunning keeps the store and tokens. `install/uninstall.sh` stops the service and keeps the data;
`--purge` deletes it after asking.

## install-docker.sh: Docker Compose

- `deploy/docker-compose.yml` runs two services:
  - **fleetops:** non-root, read-only root filesystem, a named Parquet volume, a health check;
  - **Grafana:** the Infinity plugin, a provisioned fleetops data source with the read token, and the dashboard.
- The installer writes the tokens, a Grafana admin password (`deploy/compose/.env`, 0600) and the dashboard, then
  runs `docker compose up -d --build` and waits for both.
- `--down` stops the stack and keeps the volumes.

## install-k8s.sh: Kubernetes

1. `--build` builds and pushes the image from the repository root.
2. Makes the tokens with openssl. Their hashes go into a Secret.
3. Renders `deploy/fleetops.yaml` with your `--image`, `--namespace`, `--storage` and `--egress` hosts, and applies
   it: one writer Deployment on a PVC, a Service, and the nightly retention CronJob.
4. Waits for the rollout and prints the port-forward and in-cluster URLs.

`--dry-run` renders everything to stdout and applies nothing, so you can review it or commit it to GitOps.

## Then: send data

| Source | Point it at | Token |
|---|---|---|
| Prometheus | `remote_write` → `http://fleetops:9400/api/v1/write` (keep `DCGM_FI_.*`, `gpu_.*`, `sambanova_.*`, `nccl_.*`) | collector |
| OpenTelemetry collector | `otlphttp` exporter → `http://fleetops:9400` (protobuf or JSON, gzip fine) | collector |
| hybrid-tracing corrector | downstream `http://fleetops:9400/v1/traces` | collector |
| Grafana | Infinity data source → `http://fleetops:9400`, `Authorization: Bearer …`; dashboard `deploy/grafana-dashboard.json` | grafana (read) |

## Then: get real labels

1. **Backtest your postmortems.** Write one JSON line per confirmed incident:
   `{ "incident": { "id", "symptom", "from", "to", "pool"?, "nodes"? }, "cause": "<rule>", "component"? }`. Then run
   `fleetops backtest --labels pm.jsonl --prom http://prometheus:9090 --loki http://loki:3100`. It pulls each window
   (DCGM, AMD, vLLM and NCCL Inspector series; kernel and NCCL logs) from your monitoring and scores root-cause
   analysis. Each miss names the incident.
2. **Game days on a test partition.** Write a plan, e.g.
   `[{ "fault": "gpu-slow", "node": "gpu-t01", "gpu": "0", "forS": 900 }, { "fault": "nfs-block", "nodes": "gpu-t01,gpu-t02", "server": "nfs-test" }]`.
   Then run `fleetops gameday plan.json --allow test-cluster.allow` (dry run) and add `--live`. Every step is checked
   against the allowlist before any runs.
3. **Shadow mode:** schedule `fleetops incidents open` and compare with on-call. Resolving with `--cause` turns each
   confirmed incident into a label.

Then fit rule weights on those labels: `fleetops rca bench --from-incidents --labels pm.jsonl --fit weights.json`.

## What was checked, and what wasn't

| Checked here | Not checkable here |
|---|---|
| `install.sh`: install, rerun, uninstall (also in CI) | systemd and launchd paths (no init system in the test environment; the background path ran) |
| The image built from the Dockerfile's COPY set and run non-root with a read-only root filesystem, Parquet, tokens, ingest and the API | `node:22-slim` as the base (Docker Hub is blocked here; a base from the same Node binary was used). CI builds the real one. |
| The compose fleetops service healthy, with an authenticated API | Grafana in compose (its image couldn't be pulled here) |
| The Kubernetes manifest rendered by `install-k8s.sh --dry-run` and checked structurally; tokens round-trip | Applying it to a cluster (no cluster here; schema validation with kubeconform was not run) |
