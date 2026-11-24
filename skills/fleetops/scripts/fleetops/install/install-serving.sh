#!/usr/bin/env bash
# Inference serving on Kubernetes in one command: a model, sized by the Inference Sizer, served by vLLM.
#
#   ./fleetops/install/install-serving.sh --model llama33-70b --gpu H100 --nodes 2 --hf-secret hf-token
#   ./fleetops/install/install-serving.sh --model qwen3-32b --gpu H200 --rate 20 --autoscale
#   ./fleetops/install/install-serving.sh --model kimi-k2 --gpu H100 --rate 1 --install-lws v0.7.0   # multi-node
#   ./fleetops/install/install-serving.sh --model llama33-70b --gpu H200 --rate 20 --isl 8000 --mode disagg --install-prereqs
#        # disaggregated prefill/decode on llm-d (DisaggregatedSet + the llm-d router chart)
#   ./fleetops/install/install-serving.sh … --dry-run > serving.yaml                               # render only
#
# Not sure which model? See what fits first:
#   node fleetops/tools/fleetops.mjs serving fit --gpu H100 --nodes 2 [--rate 10]
#   node fleetops/tools/fleetops.mjs serving capacity --model llama33-70b --gpu H100 --nodes 2
#
# Steps: plan the layout (TP/PP, instances, max-num-seqs) for the hardware or the rate within the latency targets;
# render a Deployment (an instance on one node) or a LeaderWorkerSet (an instance across nodes), a Service and,
# with --autoscale, a KEDA ScaledObject; check the cluster (context, GPU nodes, CRDs, the token Secret); apply;
# wait until ready; send one completion through a port-forward; register the pool with fleetops (pools.json and
# targets.json in the store) so `fleetops tune` and the agent know it.
#
# The Hugging Face token stays in a Secret you create; this script never reads it:
#   kubectl -n serving create secret generic hf-token --from-literal=token=hf_…
#
# Options (all of `fleetops serving deploy`): --model M (required)  --gpu G (required)  --nodes N | --gpus N | --rate R
#   --name N  --namespace NS (serving)  --hf-secret SECRET  --cache-pvc PVC  --image IMG  --autoscale  --prometheus URL
#   --isl/--osl TOKENS  --ttft S  --tpot S  --from-pool P  --create-namespace  --endpoint URL  --wait S  --store DIR
#   --mode agg|disagg|auto  --router-version V  --gaie-version vX.Y.Z
#   Script only: --dry-run (print the manifests, apply nothing)  --install-lws VERSION (install LeaderWorkerSet first)
#                --install-prereqs (for --mode disagg: LeaderWorkerSet 1.0.0 with DisaggregatedSet, and the InferencePool CRDs)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
DRY=0; LWS=""; PREREQS=0; GAIE=latest; PASS=()
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1; shift;;
  --install-lws) LWS="${2:-}"; shift 2;;
  --install-prereqs) PREREQS=1; shift;;
  --gaie-version) GAIE="${2:-}"; PASS+=("$1" "$2"); shift 2;;
  --apply) shift;;                                   # this script applies unless --dry-run
  -h|--help) sed -n '2,28p' "$0"; exit 0;;
  *) PASS+=("$1"); shift;; esac; done
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { [ "$DRY" = 1 ] && printf '# %s\n' "$*" >&2 || printf '\033[1m==>\033[0m %s\n' "$*"; }
command -v node >/dev/null || die "Node.js 18+ is required (it runs the sizer)"
[ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ] || die "Node.js 18+ is required"
CLI="$ROOT/tools/fleetops.mjs"

if [ "$DRY" = 1 ]; then
  T=$(mktemp); trap 'rm -f "$T"' EXIT
  node "$CLI" serving deploy "${PASS[@]}" --out "$T" >&2 || exit $?
  cat "$T"; if [ -f "$T.router.values.yaml" ]; then log "llm-d router values (helm upgrade --install NAME oci://ghcr.io/llm-d/charts/llm-d-router-standalone --version v0 -f FILE):"; sed 's/^/# /' "$T.router.values.yaml"; rm -f "$T.router.values.yaml"; fi
  log "dry run: nothing applied"; exit 0
fi

command -v kubectl >/dev/null || die "kubectl is required (or use --dry-run and apply the output yourself)"
kubectl version --request-timeout=10s >/dev/null 2>&1 || die "kubectl can't reach the cluster"
if [ -n "$LWS" ]; then
  [[ "$LWS" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--install-lws takes a release like v0.7.0 (https://github.com/kubernetes-sigs/lws/releases)"
  if kubectl get crd leaderworkersets.leaderworkerset.x-k8s.io >/dev/null 2>&1; then log "LeaderWorkerSet already installed"
  else
    log "installing LeaderWorkerSet $LWS"
    kubectl apply --server-side -f "https://github.com/kubernetes-sigs/lws/releases/download/$LWS/manifests.yaml" >/dev/null
    kubectl -n lws-system rollout status deployment/lws-controller-manager --timeout=300s
  fi
fi
if [ "$PREREQS" = 1 ]; then
  [[ "$GAIE" == latest || "$GAIE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--gaie-version like v1.0.1"
  command -v helm >/dev/null || die "helm is required for --install-prereqs"
  log "installing LeaderWorkerSet 1.0.0 with the DisaggregatedSet API"
  helm upgrade --install lws oci://registry.k8s.io/lws/charts/lws --version=1.0.0 --namespace lws-system --create-namespace --set enableDisaggregatedSet=true --wait --timeout 300s
  log "installing the Gateway API Inference Extension CRDs ($GAIE)"
  if [ "$GAIE" = latest ]; then U=releases/latest/download; else U="releases/download/$GAIE"; fi
  kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api-inference-extension/$U/v1-manifests.yaml"
fi
log "planning, checking the cluster, applying"
exec node "$CLI" serving deploy "${PASS[@]}" --apply
