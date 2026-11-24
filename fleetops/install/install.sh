#!/usr/bin/env bash
# fleetops: one-command install on one machine (Linux or macOS).
#
#   ./fleetops/install/install.sh                      # from a checkout of AIInfraTools
#   curl -fsSL https://raw.githubusercontent.com/hardikashah-eng/AIInfraTools/main/fleetops/install/install.sh | bash
#
# What it does (nothing outside --dir except an optional user service):
#   1. checks Node.js ≥ 20 (tells you how to get it if missing; installs nothing system-wide)
#   2. uses this checkout, or clones AIInfraTools into <dir>/src
#   3. installs DuckDB for the Parquet backend (npm, into the checkout only; falls back to JSON lines without it)
#   4. creates the store, three tokens (admin, ingest, read; only their hashes go in tokens.jsonl, the tokens
#      themselves in a 0600 file for you to copy and then delete) and a `fleetops` command in <dir>/bin
#   5. starts `fleetops serve` as a user service (systemd --user, or launchd on macOS; else in the background)
#   6. waits for /healthz and prints the Prometheus, OpenTelemetry and Grafana settings to paste
#
# Options: --dir DIR (~/.fleetops)  --port N (9400)  --host H (127.0.0.1)  --backend parquet|jsonl  --no-service
#          --no-start  --on-prem HOSTS  --repo URL  --ref REF  --yes   (rerunning keeps existing data and tokens)
set -euo pipefail

DIR="${FLEETOPS_DIR:-$HOME/.fleetops}"; PORT=9400; HOST=127.0.0.1; BACKEND=""; SERVICE=1; START=1; ONPREM=""
REPO="https://github.com/hardikashah-eng/AIInfraTools.git"; REF="main"; YES=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --port) PORT="$2"; shift 2;; --host) HOST="$2"; shift 2;; --backend) BACKEND="$2"; shift 2;;
  --no-service) SERVICE=0; shift;; --no-start) START=0; shift;; --on-prem) ONPREM="$2"; shift 2;;
  --repo) REPO="$2"; shift 2;; --ref) REF="$2"; shift 2;; --yes|-y) YES=1; shift;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;; *) echo "unknown option: $1" >&2; exit 2;; esac; done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# 1. Node.js
command -v node >/dev/null 2>&1 || die "Node.js 20 or newer is required. Install it (https://nodejs.org, 'brew install node', or nvm: https://github.com/nvm-sh/nvm) and rerun."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $NODE_MAJOR found; 20 or newer is required."
say "Node.js $(node -v)"

# 2. code: this checkout if the script lives in one, else a clone
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/../tools/fleetops.mjs" ] && [ -d "$HERE/../../gpu-health" ]; then
  ROOT="$(cd "$HERE/../.." && pwd)"; say "using this checkout: $ROOT"
else
  command -v git >/dev/null 2>&1 || die "git is required to fetch AIInfraTools"
  ROOT="$DIR/src"
  if [ -d "$ROOT/.git" ]; then say "updating $ROOT"; git -C "$ROOT" fetch -q --depth 1 origin "$REF" && git -C "$ROOT" checkout -q FETCH_HEAD
  else say "cloning $REPO ($REF) into $ROOT"; mkdir -p "$DIR"; git clone -q --depth 1 --branch "$REF" "$REPO" "$ROOT"; fi
fi
FO="$ROOT/fleetops"

# 3. backend
mkdir -p "$DIR/data" "$DIR/etc" "$DIR/bin" "$DIR/log"
if [ -f "$DIR/data/fleetops-store.json" ]; then BACKEND=$(node -p "require('$DIR/data/fleetops-store.json').backend || 'jsonl'"); say "existing store ($BACKEND backend): kept"; fi
if [ -z "$BACKEND" ] || [ "$BACKEND" = parquet ]; then
  if [ -d "$FO/node_modules/@duckdb/node-api" ] || (cd "$FO" && npm install --no-save --no-package-lock --no-audit --no-fund @duckdb/node-api@2.0.1-r.1 >/dev/null 2>&1); then BACKEND=parquet; say "Parquet backend (DuckDB) ready"
  elif [ "$BACKEND" = parquet ]; then die "could not install DuckDB (npm); rerun with --backend jsonl or check npm's network access"
  else BACKEND=jsonl; say "DuckDB not installable here: using the JSON-lines backend (fine for small fleets)"; fi
fi

# 4. tokens, config, command
TOK="$DIR/etc/tokens.jsonl"; SECRET="$DIR/etc/initial-tokens.txt"
if [ ! -s "$TOK" ]; then
  umask 077
  for spec in "admin:admin" "collector:ingest" "grafana:read"; do
    name=${spec%%:*}; role=${spec#*:}
    out=$(node "$FO/tools/fleetops.mjs" token create --tokens "$TOK" --name "$name" --roles "$role" $([ "$role" = read ] && echo --infra))
    printf '%s=%s\n' "$name" "$(printf '%s\n' "$out" | sed -n 2p)" >> "$SECRET"
  done
  umask 022; say "tokens created: $SECRET (copy them, then delete the file; only hashes are kept)"
else say "tokens: kept ($TOK)"; fi
tok() { sed -n "s/^$1=//p" "$SECRET" 2>/dev/null; }
cat > "$DIR/etc/fleetops.env" <<EOF
FLEETOPS_STORE=$DIR/data
FLEETOPS_PORT=$PORT
FLEETOPS_HOST=$HOST
$( [ -n "$ONPREM" ] && echo "FLEETOPS_EGRESS_ALLOW=$ONPREM" )
EOF
cat > "$DIR/bin/fleetops" <<EOF
#!/usr/bin/env bash
# fleetops with this install's store; any --store on the command line wins.
case " \$* " in *" --store "*) exec node "$FO/tools/fleetops.mjs" "\$@";; esac
exec node "$FO/tools/fleetops.mjs" "\$@" --store "$DIR/data"
EOF
chmod +x "$DIR/bin/fleetops"
SERVE=(node "$FO/tools/fleetops.mjs" serve --store "$DIR/data" --backend "$BACKEND" --host "$HOST" --port "$PORT" --tokens "$TOK")
[ -n "$ONPREM" ] && SERVE+=(--on-prem "$ONPREM")

# 5. service
started=""
if [ "$START" = 1 ]; then
  if [ "$SERVICE" = 1 ] && [ "$(uname)" = Linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/fleetops.service" <<EOF
[Unit]
Description=fleetops (ingest + API)
After=network-online.target
[Service]
ExecStart=$(printf '%q ' "${SERVE[@]}")
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload && systemctl --user enable --now fleetops.service >/dev/null && started="systemd --user (systemctl --user status fleetops)"
  elif [ "$SERVICE" = 1 ] && [ "$(uname)" = Darwin ]; then
    PL="$HOME/Library/LaunchAgents/com.aiinfratools.fleetops.plist"; mkdir -p "$(dirname "$PL")"
    { echo '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
      echo '<key>Label</key><string>com.aiinfratools.fleetops</string><key>ProgramArguments</key><array>'
      for a in "$(command -v node)" "${SERVE[@]:1}"; do printf '<string>%s</string>' "$a"; done
      echo "</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$DIR/log/fleetops.log</string><key>StandardErrorPath</key><string>$DIR/log/fleetops.log</string></dict></plist>"; } > "$PL"
    launchctl unload "$PL" >/dev/null 2>&1 || true; launchctl load "$PL" && started="launchd (launchctl list | grep fleetops)"
  else
    [ -f "$DIR/fleetops.pid" ] && kill "$(cat "$DIR/fleetops.pid")" >/dev/null 2>&1 || true
    nohup "${SERVE[@]}" >> "$DIR/log/fleetops.log" 2>&1 &
    echo $! > "$DIR/fleetops.pid"; started="in the background (pid $(cat "$DIR/fleetops.pid"); log $DIR/log/fleetops.log)"
  fi
  # 6. wait for it
  for i in $(seq 1 30); do node -e "fetch('http://127.0.0.1:$PORT/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break; sleep 1; done
  node -e "fetch('http://127.0.0.1:$PORT/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || die "fleetops did not come up; see $DIR/log/fleetops.log"
  say "fleetops is running: http://$HOST:$PORT  ($started)"
fi

ING=$(tok collector); RD=$(tok grafana)
cat <<EOF

Next steps
  CLI:          export PATH="$DIR/bin:\$PATH";  fleetops rca bench;  fleetops incidents list
  Prometheus:   remote_write:
                  - url: http://<this-host>:$PORT/api/v1/write
                    authorization: { credentials: ${ING:-<collector token>} }
                    write_relabel_configs: [{ source_labels: [__name__], regex: 'DCGM_FI_.*|gpu_.*|sambanova_.*|nccl_.*', action: keep }]
  OTel collector: exporters: { otlphttp/fleetops: { endpoint: http://<this-host>:$PORT, headers: { Authorization: "Bearer ${ING:-<collector token>}" } } }
  Grafana:      Infinity data source → URL http://<this-host>:$PORT, header Authorization: Bearer ${RD:-<grafana token>};
                import $FO/deploy/grafana-dashboard.json
  Backtest:     fleetops backtest --labels postmortems.jsonl --prom http://prometheus:9090 --loki http://loki:3100
  Uninstall:    $FO/install/uninstall.sh --dir $DIR   (keeps data unless --purge)
$( [ "$HOST" != 127.0.0.1 ] || echo "  (listening on localhost only; rerun with --host 0.0.0.0 to accept other machines: tokens are required either way)" )
EOF
