#!/usr/bin/env bash
# Stop and remove a fleetops install made by install.sh. Data and tokens stay unless --purge.
#   ./fleetops/install/uninstall.sh [--dir ~/.fleetops] [--purge] [--yes]
set -euo pipefail
DIR="${FLEETOPS_DIR:-$HOME/.fleetops}"; PURGE=0; YES=0
while [ $# -gt 0 ]; do case "$1" in --dir) DIR="$2"; shift 2;; --purge) PURGE=1; shift;; --yes|-y) YES=1; shift;; *) echo "unknown option: $1" >&2; exit 2;; esac; done
if command -v systemctl >/dev/null 2>&1 && [ -f "$HOME/.config/systemd/user/fleetops.service" ]; then
  systemctl --user disable --now fleetops.service >/dev/null 2>&1 || true; rm -f "$HOME/.config/systemd/user/fleetops.service"; systemctl --user daemon-reload || true; echo "removed the systemd user service"
fi
PL="$HOME/Library/LaunchAgents/com.aiinfratools.fleetops.plist"
if [ -f "$PL" ]; then launchctl unload "$PL" >/dev/null 2>&1 || true; rm -f "$PL"; echo "removed the launchd agent"; fi
if [ -f "$DIR/fleetops.pid" ]; then kill "$(cat "$DIR/fleetops.pid")" >/dev/null 2>&1 || true; rm -f "$DIR/fleetops.pid"; echo "stopped the background process"; fi
rm -f "$DIR/bin/fleetops"
if [ "$PURGE" = 1 ]; then
  if [ "$YES" != 1 ]; then printf 'Delete %s (store, tokens, logs)? This cannot be undone. [y/N] ' "$DIR"; read -r a; [ "$a" = y ] || [ "$a" = Y ] || { echo "kept $DIR"; exit 0; }; fi
  rm -rf "$DIR"; echo "deleted $DIR"
else echo "kept the store and tokens in $DIR (rerun with --purge to delete them)"; fi
