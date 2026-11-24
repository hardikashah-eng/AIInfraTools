#!/usr/bin/env bash
# fleetops + Grafana with Docker Compose in one command (Linux, macOS, or Windows with WSL2).
#   ./fleetops/install/install-docker.sh [--port 9400] [--grafana-port 3000] [--on-prem HOSTS] [--down]
# Makes tokens (hashes in deploy/compose/tokens.jsonl, tokens in deploy/compose/tokens.txt, 0600), a Grafana admin
# password, the provisioned Infinity data source and dashboard, then `docker compose up -d --build` and waits until
# both answer. Rerunning keeps the tokens and data. --down stops the stack (volumes kept; `docker compose down -v`
# in fleetops/deploy deletes them).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; FO="$(cd "$HERE/.." && pwd)"; C="$FO/deploy/compose"
PORT=9400; GPORT=3000; ONPREM=""; DOWN=0
while [ $# -gt 0 ]; do case "$1" in --port) PORT="$2"; shift 2;; --grafana-port) GPORT="$2"; shift 2;; --on-prem) ONPREM="$2"; shift 2;; --down) DOWN=1; shift;;
  -h|--help) sed -n '2,7p' "$0"; exit 0;; *) echo "unknown option: $1" >&2; exit 2;; esac; done
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose …)"
DC=(docker compose -f "$FO/deploy/docker-compose.yml" --env-file "$C/.env" --project-directory "$FO/deploy")
if [ "$DOWN" = 1 ]; then "${DC[@]}" down; exit 0; fi
. "$HERE/lib.sh"
if [ ! -s "$C/tokens.jsonl" ]; then write_tokens "$C/tokens.jsonl" "$C/tokens.txt"; chmod 644 "$C/tokens.jsonl"; say "tokens: $C/tokens.txt (copy them, then delete the file)"; else say "tokens: kept"; fi
READ=$(sed -n 's/^grafana=//p' "$C/tokens.txt" 2>/dev/null || true)
[ -n "$READ" ] || READ=$(sed -n 's/^FLEETOPS_READ_TOKEN=//p' "$C/.env" 2>/dev/null || true)
[ -n "$READ" ] || die "the read token is gone (tokens.txt deleted and no .env): delete $C/tokens.jsonl and rerun to make new tokens"
GPW=$(sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' "$C/.env" 2>/dev/null || true); [ -n "$GPW" ] || GPW=$(openssl rand -base64 18 | tr -d '/+=\n')
( umask 077; printf 'FLEETOPS_PORT=%s\nGRAFANA_PORT=%s\nFLEETOPS_READ_TOKEN=%s\nGRAFANA_ADMIN_PASSWORD=%s\nFLEETOPS_EGRESS_ALLOW=%s\n' "$PORT" "$GPORT" "$READ" "$GPW" "$ONPREM" > "$C/.env" )
mkdir -p "$C/grafana/dashboards" && sed 's/\${DS_FLEETOPS}/fleetops/g' "$FO/deploy/grafana-dashboard.json" > "$C/grafana/dashboards/fleetops.json"
say "building and starting (first run downloads node:22-slim and grafana; a few minutes)"
"${DC[@]}" up -d --build
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$GPORT/api/health" >/dev/null 2>&1 && break; sleep 3; done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || die "fleetops didn't come up: ${DC[*]} logs fleetops"
cat <<EOT

fleetops: http://localhost:$PORT      Grafana: http://localhost:$GPORT  (admin / $GPW; dashboard "fleetops")
  Send data:  Prometheus remote_write → http://<this-host>:$PORT/api/v1/write with the collector token ($C/tokens.txt)
              OpenTelemetry collector otlphttp exporter → http://<this-host>:$PORT (Authorization: Bearer <collector token>)
  CLI:        docker compose -f $FO/deploy/docker-compose.yml exec fleetops node tools/fleetops.mjs incidents list --store /data
  Stop:       $0 --down
EOT
