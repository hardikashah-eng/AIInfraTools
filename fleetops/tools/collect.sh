#!/usr/bin/env bash
# Collect what this node or cluster can tell fleetops into one bundle, to import (fleetops data import bundle) or send
# (fleetops send … --to URL). Read-only: it runs only listing and log commands, and skips anything not installed.
#
#   tools/collect.sh [--since 24h] [--out DIR] [--node NAME]
#                    [--dcgm URL] [--vllm URL]... [--amd URL]
#                    [--k8s] [--slurm] [--helm RELEASE:NAMESPACE]...
#                    [--step-log FILE]... [--requests FILE]... [--app-log FILE]... [--kineto FILE]...
#                    [--nccl-inspector DIR] [--sdc-checks FILE]... [--fabric] [--no-kernel] [--no-gpu]
#
# Per node (by default): nvidia-smi -q and topo -m (or rocm-smi), the kernel log since --since, and the DCGM exporter
# at http://localhost:9400/metrics if it answers. --k8s adds nodes, pods and events cluster-wide; --slurm adds sacct
# and scontrol show node. vLLM /metrics are scraped twice, a minute apart, so rates can be computed. NFS mountstats
# (per-export latency), ethtool -S of the RDMA NICs (pause frames, discards, link errors) and the InfiniBand/RoCE port
# counters in sysfs (errors, xmit wait, CNPs and ECN marks) are taken at the start and the end. --fabric adds ibnetdiscover and ibqueryerrors (switch ports with error counters), from a host that sees the fabric.
#
# What it does not collect: prompts, completions, environment variables, credentials. Request logs you pass with
# --requests are reduced to token counts and latencies when imported. Kernel and application logs are copied as they
# are: read them before sending a bundle outside your organization.
set -euo pipefail

SINCE=24h OUT="" NODE="$(hostname -s 2>/dev/null || hostname)" DCGM="http://localhost:9400/metrics" AMD=""
K8S=0 SLURM=0 KERNEL=1 GPU=1 FABRIC=0
VLLM=() HELM=() STEPS=() REQS=() APPS=() KINETO=() SDC=() NCCLI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --dcgm) DCGM="$2"; shift 2 ;;
    --amd) AMD="$2"; shift 2 ;;
    --vllm) VLLM+=("$2"); shift 2 ;;
    --k8s) K8S=1; shift ;;
    --slurm) SLURM=1; shift ;;
    --helm) HELM+=("$2"); shift 2 ;;
    --step-log) STEPS+=("$2"); shift 2 ;;
    --requests) REQS+=("$2"); shift 2 ;;
    --app-log) APPS+=("$2"); shift 2 ;;
    --kineto) KINETO+=("$2"); shift 2 ;;
    --sdc-checks) SDC+=("$2"); shift 2 ;;
    --nccl-inspector) NCCLI="$2"; shift 2 ;;
    --fabric) FABRIC=1; shift ;;
    --no-kernel) KERNEL=0; shift ;;
    --no-gpu) GPU=0; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$NODE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "node name must be letters, digits, . _ -" >&2; exit 2; }
[[ "$SINCE" =~ ^[0-9]+[smhd]$ ]] || { echo "--since takes a duration such as 24h or 7d" >&2; exit 2; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-fleetops-bundle-$NODE-$STAMP}"
mkdir -p "$OUT"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ENTRIES=()
have() { command -v "$1" >/dev/null 2>&1; }
# add PATH SOURCE [JSON-OPTS]: record a collected file in the manifest (empty files are dropped)
add() { if [ -s "$OUT/$1" ]; then ENTRIES+=("{\"path\":\"$1\",\"source\":\"$2\",\"opts\":${3:-{\}}}"); echo "  $1 ($2)"; else rm -f "$OUT/$1"; fi; }
# copy FILE DIR SOURCE: a file given on the command line
copy() { local f="$1" d="$2" s="$3" b; b="$(basename "$f")"; [ -f "$f" ] || { echo "  skipped $f: not a file" >&2; return; }; mkdir -p "$OUT/$d"; cp "$f" "$OUT/$d/$b"; add "$d/$b" "$s" "${4:-}"; }
secs() { local n="${1%?}" u="${1: -1}"; case "$u" in s) echo "$n";; m) echo $((n*60));; h) echo $((n*3600));; d) echo $((n*86400));; esac; }
SINCE_ISO="$(date -u -d "@$(( $(date +%s) - $(secs "$SINCE") ))" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -r "$(( $(date +%s) - $(secs "$SINCE") ))" +%Y-%m-%dT%H:%M:%S)"

echo "collecting into $OUT (node $NODE, since $SINCE)"
mkdir -p "$OUT/node"
# counters taken now and again at the end, so the bundle holds what happened in between
# (FLEETOPS_SYSFS and FLEETOPS_MOUNTSTATS point elsewhere, for tests)
SYS="${FLEETOPS_SYSFS:-/sys}" MSTATS="${FLEETOPS_MOUNTSTATS:-/proc/self/mountstats}"
T0S=$(date +%s)
if grep -q 'fstype nfs' "$MSTATS" 2>/dev/null; then cp "$MSTATS" "$OUT/node/mountstats-before.txt"; fi
NICS=(); for d in "$SYS"/class/infiniband/*/device/net/*; do [ -e "$d" ] && NICS+=("$(basename "$d")"); done
IBDEVS=(); for d in "$SYS"/class/infiniband/*/ports/*; do [ -d "$d/counters" ] || [ -d "$d/hw_counters" ] && IBDEVS+=("$d"); done
# counters NAME WHEN T: ethtool -S of every RDMA NIC and every IB port's sysfs counters, stamped with T
counters() {
  local w="$1" t="$2" n p f
  for n in "${NICS[@]+"${NICS[@]}"}"; do
    [[ "$n" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    have ethtool && ethtool -S "$n" > "$OUT/node/ethtool-$n-$w.txt" 2>/dev/null && add "node/ethtool-$n-$w.txt" ethtool "{\"node\":\"$NODE\",\"iface\":\"$n\",\"t\":\"$t\"}"
  done
  for p in "${IBDEVS[@]+"${IBDEVS[@]}"}"; do
    f="node/ib-$(basename "$(dirname "$(dirname "$p")")")-$(basename "$p")-$w.txt"
    grep -H . "$p"/counters/* "$p"/hw_counters/* > "$OUT/$f" 2>/dev/null || true
    add "$f" ib-sysfs "{\"node\":\"$NODE\",\"t\":\"$t\"}"
  done
}
counters start "$NOW"
if [ "$GPU" = 1 ]; then
  if have nvidia-smi; then
    nvidia-smi -q > "$OUT/node/nvidia-smi-q.txt" 2>/dev/null || true; add node/nvidia-smi-q.txt nvidia-smi-q "{\"node\":\"$NODE\",\"t\":\"$NOW\"}"
    nvidia-smi topo -m > "$OUT/node/nvidia-topo.txt" 2>/dev/null || true; add node/nvidia-topo.txt nvidia-topo "{\"node\":\"$NODE\",\"t\":\"$NOW\"}"
  fi
  if curl -fsS -m 5 "$DCGM" -o "$OUT/node/dcgm.prom" 2>/dev/null; then add node/dcgm.prom exporter "{\"t\":\"$NOW\"}"; fi
  if [ -n "$AMD" ] && curl -fsS -m 5 "$AMD" -o "$OUT/node/amd.prom" 2>/dev/null; then add node/amd.prom exporter "{\"vendor\":\"amd\",\"t\":\"$NOW\"}"; fi
fi
if [ "$KERNEL" = 1 ]; then
  if have journalctl; then journalctl -k -o short-iso --since "$SINCE_ISO" --no-pager > "$OUT/node/kernel.log" 2>/dev/null || true
  elif have dmesg; then dmesg --time-format iso > "$OUT/node/kernel.log" 2>/dev/null || true; fi
  [ -f "$OUT/node/kernel.log" ] && add node/kernel.log kernel-log "{\"node\":\"$NODE\"}"
fi
i=0
for u in "${VLLM[@]+"${VLLM[@]}"}"; do
  i=$((i+1)); mkdir -p "$OUT/serving"
  if curl -fsS -m 10 "$u" -o "$OUT/serving/vllm-$i-before.prom" 2>/dev/null; then
    sleep 60; T="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    curl -fsS -m 10 "$u" -o "$OUT/serving/vllm-$i.prom" 2>/dev/null && add "serving/vllm-$i.prom" vllm "{\"before\":\"serving/vllm-$i-before.prom\",\"window\":60,\"t\":\"$T\"}"
  else echo "  skipped $u: no answer" >&2; fi
done
if [ "$K8S" = 1 ] && have kubectl; then
  mkdir -p "$OUT/k8s"
  kubectl get nodes -o json > "$OUT/k8s/nodes.json" 2>/dev/null && add k8s/nodes.json k8s-nodes "{\"t\":\"$NOW\"}"
  kubectl get pods -A -o json > "$OUT/k8s/pods.json" 2>/dev/null && add k8s/pods.json k8s-pods "{\"t\":\"$NOW\"}"
  kubectl get events -A -o json > "$OUT/k8s/events.json" 2>/dev/null && add k8s/events.json k8s-events
fi
if [ "$FABRIC" = 1 ]; then
  mkdir -p "$OUT/fabric"
  have ibnetdiscover && ibnetdiscover > "$OUT/fabric/ibnetdiscover.txt" 2>/dev/null && add fabric/ibnetdiscover.txt ibnetdiscover "{\"t\":\"$NOW\"}"
  have ibqueryerrors && ibqueryerrors > "$OUT/fabric/ibqueryerrors.txt" 2>/dev/null; add fabric/ibqueryerrors.txt ibqueryerrors "{\"t\":\"$NOW\"}"
fi
for h in "${HELM[@]+"${HELM[@]}"}"; do
  rel="${h%%:*}" ns="${h#*:}"; [ "$ns" = "$h" ] && ns=default
  [[ "$rel$ns" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "  skipped helm $h: bad name" >&2; continue; }
  mkdir -p "$OUT/helm"; have helm && helm history "$rel" -n "$ns" -o json > "$OUT/helm/$rel.json" 2>/dev/null && add "helm/$rel.json" helm-history "{\"release\":\"$rel\",\"namespace\":\"$ns\"}"
done
if [ "$SLURM" = 1 ]; then
  mkdir -p "$OUT/slurm"
  have sacct && sacct -a -X -P -S "$SINCE_ISO" --format=JobID,JobName,User,State,Start,End,NodeList,AllocTRES,ExitCode > "$OUT/slurm/sacct.txt" 2>/dev/null && add slurm/sacct.txt sacct
  have scontrol && scontrol show node -o > "$OUT/slurm/nodes.txt" 2>/dev/null && add slurm/nodes.txt slurm-nodes "{\"t\":\"$NOW\"}"
fi
for f in "${STEPS[@]+"${STEPS[@]}"}"; do copy "$f" training step-log; done
for f in "${KINETO[@]+"${KINETO[@]}"}"; do copy "$f" training kineto "{\"node\":\"$NODE\"}"; done
for f in "${APPS[@]+"${APPS[@]}"}"; do copy "$f" logs app-log "{\"node\":\"$NODE\"}"; done
for f in "${SDC[@]+"${SDC[@]}"}"; do copy "$f" training sdc-checks; done
for f in "${REQS[@]+"${REQS[@]}"}"; do copy "$f" serving requests; done
if [ -n "$NCCLI" ] && [ -d "$NCCLI" ]; then
  mkdir -p "$OUT/nccl"; n=0
  for f in "$NCCLI"/*.log "$NCCLI"/*.json "$NCCLI"/*.jsonl; do [ -f "$f" ] || continue; n=$((n+1)); cp "$f" "$OUT/nccl/$(basename "$f")"; add "nccl/$(basename "$f")" nccl-inspector "{\"job\":\"$(basename "$NCCLI" | sed 's/^nccl-inspector-//')\"}"; done
fi

# the end of the counter window (at least 30 s after the start)
W=$(( $(date +%s) - T0S )); [ "$W" -lt 30 ] && { sleep $((30 - W)); W=30; }
TE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$OUT/node/mountstats-before.txt" ]; then cp "$MSTATS" "$OUT/node/mountstats.txt"; add node/mountstats.txt mountstats "{\"node\":\"$NODE\",\"before\":\"node/mountstats-before.txt\",\"window\":$W,\"t\":\"$TE\"}"; fi
counters end "$TE"

{ printf '{"version":1,"collectedAt":"%s","host":"%s","since":"%s","files":[' "$NOW" "$NODE" "$SINCE"
  sep=""; for e in "${ENTRIES[@]+"${ENTRIES[@]}"}"; do printf '%s%s' "$sep" "$e"; sep=","; done
  printf ']}\n'; } > "$OUT/manifest.json"
tar -czf "$OUT.tar.gz" -C "$OUT" .
echo "wrote $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1), ${#ENTRIES[@]} files)"
echo "next: fleetops data import bundle $OUT.tar.gz   or   fleetops send $OUT.tar.gz --to http://fleetops:9400 --token …"
