#!/usr/bin/env bash
# Shadow upgrades on real engines, end to end, on three 1-GPU NVIDIA L4 nodes (see README.md).
#   deploy/shadow-live/run.sh            deploy, then show what would be sent (dry runs) and stop
#   deploy/shadow-live/run.sh --yes      also send the traffic: paired replay, the answers check, in-cluster canary load
#   add --keep to leave the namespace up afterwards (it is deleted otherwise)
# Needs kubectl pointed at the cluster, node 22 and this repository. Results land in deploy/shadow-live/out/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../../.." && pwd)"; out="$here/out"; store="$out/store"
F=(node "$repo/fleetops/tools/fleetops.mjs"); A=(node "$repo/fleetscope/tools/agentic.mjs")
live=""; keep=""; for a in "$@"; do case "$a" in --yes) live="--live";; --keep) keep=1;; *) echo "unknown argument $a" >&2; exit 2;; esac; done
mkdir -p "$out"; NS=(-n shadow-live); PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; if [ -z "$keep" ] && [ -n "$live" ]; then kubectl delete -f "$here/kit.yaml" --ignore-not-found --wait=false; fi; }
trap cleanup EXIT

n=$(kubectl get nodes -l nvidia.com/gpu.product=NVIDIA-L4 -o name | wc -l)
[ "$n" -ge 3 ] || echo "warning: $n nodes labelled nvidia.com/gpu.product=NVIDIA-L4 (three are needed: two baseline replicas and the candidate)" >&2

echo "== deploy"; kubectl apply -f "$here/kit.yaml"
kubectl "${NS[@]}" rollout status deploy/prometheus --timeout=10m
kubectl "${NS[@]}" rollout status deploy/chat-v1 --timeout=40m; kubectl "${NS[@]}" rollout status deploy/chat-v2 --timeout=40m
pf() { kubectl "${NS[@]}" port-forward "svc/$1" "$2:$3" >/dev/null 2>&1 & PIDS+=($!); }
pf chat-v1 18001 8000; pf chat-v2 18002 8000; pf prometheus 19090 9090; sleep 5

echo "== workload: agent sessions fitted on TraceLab (CC BY 4.0, fetched at a pinned release)"
[ -f "$out/profile.json" ] || "${A[@]}" fit tracelab -o "$out/profile.json"

echo "== A. paired replay: the same requests to one replica of each version"
kubectl "${NS[@]}" scale deploy/chat-v1 --replicas=1; kubectl "${NS[@]}" rollout status deploy/chat-v1 --timeout=10m; sleep 5
"${F[@]}" shadow answers --baseline http://127.0.0.1:18001 --candidate http://127.0.0.1:18002 --model chat $live --out "$out/answers.json" --store "$store"
"${F[@]}" shadow replay --trace "$out/profile.json" --sessions-per-hour 120 --duration 900 --max-isl 12000 --max-osl 1024 --max-requests 4000 \
  --baseline http://127.0.0.1:18001 --candidate http://127.0.0.1:18002 --model chat $live --out "$out/paired.jsonl" --store "$store"
if [ -z "$live" ]; then echo "dry run: add --yes to send the traffic. The namespace stays up: kubectl delete -f $here/kit.yaml"; exit 0; fi
"${F[@]}" shadow compare --results "$out/paired.jsonl" --answers "$out/answers.json" --store "$store" | tee "$out/paired-verdict.txt"

echo "== B. canary at a third of the traffic, judged from Prometheus"
kubectl "${NS[@]}" scale deploy/chat-v1 --replicas=2; kubectl "${NS[@]}" rollout status deploy/chat-v1 --timeout=20m
t0=$(date +%s)
kubectl "${NS[@]}" delete job load-canary --ignore-not-found; kubectl apply -f "$here/load-canary.yaml"
kubectl "${NS[@]}" wait --for=condition=complete job/load-canary --timeout=60m
t1=$(date +%s)
"${F[@]}" shadow prom --prom http://127.0.0.1:19090 --select 'namespace="shadow-live"' --baseline 'llm_isvc_name="chat-v1"' --candidate 'llm_isvc_name="chat-v2"' \
  --from "$t0" --to "$t1" --step 30 --save "$out/canary-series.json" --store "$store" | tee "$out/canary-verdict.txt"

echo "== the judge, called the way Argo Rollouts calls it"
"${F[@]}" shadow serve --prom http://127.0.0.1:19090 --port 19410 --step 30 --store "$store" & PIDS+=($!); sleep 3
curl -sS -X POST http://127.0.0.1:19410/verdict -H 'content-type: application/json' \
  -d "{\"select\":\"namespace=\\\"shadow-live\\\"\",\"baseline\":\"llm_isvc_name=\\\"chat-v1\\\"\",\"candidate\":\"llm_isvc_name=\\\"chat-v2\\\"\",\"lookback\":$(( $(date +%s) - t0 ))}" | tee "$out/judge.json"; echo
echo "results in $out (paired-verdict.txt, canary-verdict.txt, judge.json, canary-series.json)"
