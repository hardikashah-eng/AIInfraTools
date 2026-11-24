#!/usr/bin/env bash
# fleetops on Kubernetes in one command (needs kubectl with access to the cluster; no Node.js on this machine).
#
#   ./fleetops/install/install-k8s.sh --image registry.example.com/fleetops:0.1            # image already pushed
#   ./fleetops/install/install-k8s.sh --image registry.example.com/fleetops:0.1 --build    # build and push it first
#   ./fleetops/install/install-k8s.sh --image … --dry-run > fleetops-rendered.yaml          # render only, apply nothing
#
# Steps: (optional) docker/podman build + push from the repository root; three tokens (admin, ingest, read) made
# here, their SHA-256 in a Secret, the tokens in a 0600 file next to this script's output for you to copy; the
# manifest (deploy/fleetops.yaml) rendered with your image, namespace, storage size and egress allowlist; kubectl
# apply; wait for the rollout; print how to reach it.
#
# Options: --image IMG (required)  --namespace NS (fleetops)  --storage SIZE (500Gi)  --egress HOSTS
#          (in-cluster Prometheus by default)  --build  --dry-run  --tokens-out FILE (./fleetops-tokens.txt)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=""; NS=fleetops; STORAGE=500Gi; EGRESS="prometheus-operated.monitoring.svc,*.svc.cluster.local"; BUILD=0; DRY=0; TOKOUT="./fleetops-tokens.txt"
while [ $# -gt 0 ]; do case "$1" in
  --image) IMAGE="$2"; shift 2;; --namespace) NS="$2"; shift 2;; --storage) STORAGE="$2"; shift 2;; --egress) EGRESS="$2"; shift 2;;
  --build) BUILD=1; shift;; --dry-run) DRY=1; shift;; --tokens-out) TOKOUT="$2"; shift 2;;
  -h|--help) sed -n '2,17p' "$0"; exit 0;; *) echo "unknown option: $1" >&2; exit 2;; esac; done
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { [ "$DRY" = 1 ] && printf '# %s\n' "$*" >&2 || printf '\033[1m==>\033[0m %s\n' "$*"; }
[ -n "$IMAGE" ] || die "--image REGISTRY/fleetops:TAG is required"
[[ "$NS" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "--namespace must be a DNS label"
[[ "$STORAGE" =~ ^[0-9]+(Mi|Gi|Ti)$ ]] || die "--storage like 500Gi"
[[ "$IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "--image has unexpected characters"
[[ "$EGRESS" =~ ^[A-Za-z0-9.,*_-]*$ ]] || die "--egress is a comma-separated host list"

if [ "$BUILD" = 1 ]; then
  B=$(command -v docker || command -v podman || true); [ -n "$B" ] || die "--build needs docker or podman"
  log "building $IMAGE"; "$B" build -f "$ROOT/fleetops/Dockerfile" -t "$IMAGE" "$ROOT"
  [ "$DRY" = 1 ] || { log "pushing $IMAGE"; "$B" push "$IMAGE"; }
fi

# tokens: random, hashed with SHA-256 like `fleetops token create`
. "$HERE/lib.sh"
TOKFILE=$(mktemp); trap 'rm -f "$TOKFILE"' EXIT
write_tokens "$TOKFILE" "$TOKOUT" || die "could not make tokens"

render() {
  sed -e "s#REGISTRY/fleetops:0.1#$IMAGE#g" \
      -e "s#namespace: fleetops#namespace: $NS#g" \
      -e "s#metadata: { name: fleetops }#metadata: { name: $NS }#" \
      -e "s#storage: 500Gi#storage: $STORAGE#" \
      -e "s#value: \"prometheus-operated.monitoring.svc,\*.svc.cluster.local\"#value: \"$EGRESS\"#" \
      "$ROOT/fleetops/deploy/fleetops.yaml"
}
secret() {
  printf 'apiVersion: v1\nkind: Secret\nmetadata: { name: fleetops-tokens, namespace: %s }\ntype: Opaque\ndata:\n  tokens.jsonl: %s\n' "$NS" "$(base64 < "$TOKFILE" | tr -d '\n')"
}

if [ "$DRY" = 1 ]; then render; echo '---'; secret; log "dry run: nothing applied; tokens in $TOKOUT"; exit 0; fi
command -v kubectl >/dev/null || die "kubectl is required (or use --dry-run and apply the output yourself)"
kubectl version --request-timeout=10s >/dev/null 2>&1 || die "kubectl can't reach the cluster"
log "applying to namespace $NS"
render | kubectl apply -f - >/dev/null
secret | kubectl apply -f - >/dev/null
kubectl -n "$NS" rollout restart deployment/fleetops >/dev/null 2>&1 || true
log "waiting for the rollout"; kubectl -n "$NS" rollout status deployment/fleetops --timeout=300s
cat <<EOF

fleetops is running in namespace $NS. Tokens: $TOKOUT (copy them into your collector, Prometheus and Grafana, then delete the file).
  Reach it:     kubectl -n $NS port-forward svc/fleetops 9400:9400      → http://localhost:9400/healthz
  In-cluster:   http://fleetops.$NS.svc:9400  (Prometheus remote_write /api/v1/write, OTLP /v1/…, API /api/…)
  Grafana:      Infinity data source → http://fleetops.$NS.svc:9400 with "Authorization: Bearer <grafana token>";
                import fleetops/deploy/grafana-dashboard.json
  Uninstall:    kubectl delete namespace $NS   (deletes the store's volume too)
EOF
