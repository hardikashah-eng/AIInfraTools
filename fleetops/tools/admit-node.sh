#!/usr/bin/env bash
# Admission checks for one GPU node (NVIDIA or AMD), run on the node before it joins the training pool or returns from repair.
# Writes JSON lines ({"record": kind, …}) for `fleetops data import admission FILE`, then `fleetops admit check NODE` gives the verdict.
#
#   tools/admit-node.sh > admit-$(hostname).jsonl                 # versions, topology, DCGM diag, NCCL, SDC canary
#   tools/admit-node.sh --burn-in 6h --out admit.jsonl            # plus a burn-in under load (dcgmproftester)
#
# What it runs (each skipped with a note when its tool is missing):
#   versions     driver, VBIOS/IFWI, CUDA or ROCm, kernel, NCCL or RCCL (via PyTorch), GPU model and count → inventory
#   topology     PCIe generation and width, active NVLink (nvidia-smi) or XGMI (amd-smi topology) links → check + topology
#   diag         NVIDIA: dcgmi diag -r 3 (10–20 minutes) → dcgm-diag;  AMD: ROCm Validation Suite (rvs -c CONF) → rvs-diag
#   nccl         all_reduce_perf from nccl-tests (NVIDIA) or rccl-tests (AMD) on every GPU of the node → check record
#   sdc-canary   tools/sdc-canary.py (needs PyTorch, CUDA or ROCm)                          → sdc_check records
#   burn-in      with --burn-in, NVIDIA: dcgmproftester on every GPU, max temperature and new XIDs → check record
#                (AMD: run your own load; admission counts hours under load from the exporter's samples)
#
# It loads every GPU, so it refuses to run while compute processes are on them (--force to override). It changes
# nothing on the node.
#
# Options: --out FILE  --burn-in DURATION (e.g. 6h, 90m)  --diag-level 1|2|3|4 (3)  --skip dcgm,nccl,sdc,burn-in
#          --nccl-bin PATH (all_reduce_perf)  --rvs-conf FILE (AMD)  --node NAME (hostname)  --force
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=/dev/stdout; BURN=""; LEVEL=3; SKIP=""; RVS_CONF=""; NCCL_BIN="${ALL_REDUCE_PERF:-all_reduce_perf}"; NODE="$(hostname)"; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --out) OUT="$2"; shift 2;; --burn-in) BURN="$2"; shift 2;; --diag-level) LEVEL="$2"; shift 2;; --skip) SKIP="$2"; shift 2;;
  --nccl-bin) NCCL_BIN="$2"; shift 2;; --rvs-conf) RVS_CONF="$2"; shift 2;; --node) NODE="$2"; shift 2;; --force) FORCE=1; shift;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;; *) echo "unknown option: $1" >&2; exit 2;; esac; done
die() { printf 'admit-node: %s\n' "$*" >&2; exit 1; }
note() { printf 'admit-node: %s\n' "$*" >&2; }
skip() { [[ ",$SKIP," == *",$1,"* ]]; }
[[ "$NODE" =~ ^[A-Za-z0-9._-]+$ ]] || die "--node must be a plain host name"
[[ "$LEVEL" =~ ^[1-4]$ ]] || die "--diag-level 1-4"
if command -v nvidia-smi >/dev/null; then VENDOR=nvidia; elif command -v amd-smi >/dev/null; then VENDOR=amd
else die "neither nvidia-smi nor amd-smi found"; fi
command -v python3 >/dev/null || die "python3 is needed to write the results"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ "$FORCE" != 1 ]; then
  if [ "$VENDOR" = nvidia ] && [ -n "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr -d '[:space:]')" ]; then
    die "compute processes are running on the GPUs; drain the node first (or --force)"
  fi
  if [ "$VENDOR" = amd ]; then
    amd-smi process --json > "$TMP/procs.json" 2>/dev/null || echo '[]' > "$TMP/procs.json"
    python3 "$HERE/amd-admit.py" --node "$NODE" --processes "$TMP/procs.json" --busy-only || die "compute processes are running on the GPUs; drain the node first (or --force)"
  fi
fi
secs() { local v="$1"; case "$v" in *h) echo $(( ${v%h} * 3600 ));; *m) echo $(( ${v%m} * 60 ));; *s) echo "${v%s}";; *) echo "$v";; esac; }
emit() { python3 -c 'import json,sys,time; r=json.loads(sys.argv[1]); r.setdefault("t", int(time.time())); r.setdefault("source","admit-node"); print(json.dumps(r))' "$1" >> "$TMP/out.jsonl"; }
J() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

if [ "$VENDOR" = amd ]; then
  # versions, inventory, PCIe and XGMI from amd-smi
  amd-smi static --json > "$TMP/static.json" 2>/dev/null || die "amd-smi static --json failed"
  amd-smi metric --pcie --json > "$TMP/metric.json" 2>/dev/null || true
  amd-smi topology --json > "$TMP/topo.json" 2>/dev/null || true
  ROCM=$(cat /opt/rocm/.info/version 2>/dev/null | sed -n 1p || true)
  RCCLV=$(python3 -c 'import torch; print(".".join(map(str, torch.cuda.nccl.version())))' 2>/dev/null || true)
  python3 "$HERE/amd-admit.py" --node "$NODE" --static "$TMP/static.json" $([ -s "$TMP/metric.json" ] && echo --metric "$TMP/metric.json") \
    $([ -s "$TMP/topo.json" ] && echo --topology "$TMP/topo.json") ${ROCM:+--rocm "$ROCM"} ${RCCLV:+--rccl "$RCCLV"} --kernel "$(uname -r)" >> "$TMP/out.jsonl"
  COUNT=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); print(len(o if isinstance(o,list) else o.get("gpu_data",[])))' "$TMP/static.json")
  # ROCm Validation Suite: GPU stress and health checks from a config file
  if ! skip dcgm && ! skip diag; then
    RVS=$(command -v rvs || ls /opt/rocm/bin/rvs 2>/dev/null || true)
    CONF="${RVS_CONF:-$(ls /opt/rocm/share/rocm-validation-suite/conf/gst_single.conf 2>/dev/null || true)}"
    if [ -n "$RVS" ] && [ -n "$CONF" ]; then
      note "rvs -c $CONF (this takes a while)"
      set +e; "$RVS" -c "$CONF" > "$TMP/rvs.txt" 2>&1; RC=$?; set -e
      BAD=$(grep -ciE '(pass|met)[[:space:]]*:[[:space:]]*FALSE|\bFAIL' "$TMP/rvs.txt" || true)
      emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"rvs-diag\",\"ok\":$([ "$RC" -eq 0 ] && [ "${BAD:-0}" -eq 0 ] && echo true || echo false),\"detail\":$(J "$(basename "$CONF"): exit $RC, $BAD failing line(s)")}"
    else note "rvs (ROCm Validation Suite) or its config not found: no GPU diagnostic (--rvs-conf FILE)"; fi
  fi
  [ -n "$BURN" ] && note "burn-in on AMD: run your own load; admission counts hours under load from the exporter's samples"
  BURN=""
fi

if [ "$VENDOR" = nvidia ]; then
# versions and inventory
NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | sed -n 1p | sed 's/ *$//')
COUNT=$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l | tr -d ' ')
DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | sed -n 1p | tr -d ' ')
VBIOS=$(nvidia-smi --query-gpu=vbios_version --format=csv,noheader | sort -u | paste -sd'|' -)
CUDA=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\([0-9.]*\).*/\1/p' | sed -n 1p)
NCCLV=$(python3 -c 'import torch; print(".".join(map(str, torch.cuda.nccl.version())))' 2>/dev/null || true)
emit "{\"record\":\"inventory\",\"node\":$(J "$NODE"),\"vendor\":\"nvidia\",\"sku\":$(J "$NAME"),\"devices\":$COUNT,\"versions\":{\"driver\":$(J "$DRIVER"),\"vbios\":$(J "$VBIOS"),\"cuda\":$(J "$CUDA"),\"kernel\":$(J "$(uname -r)")$([ -n "$NCCLV" ] && echo ",\"nccl\":$(J "$NCCLV")")}}"
emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"gpu-count\",\"value\":$COUNT}"

# PCIe: the slowest GPU's maximum generation and current width (generation drops at idle; width doesn't)
PCIE=$(nvidia-smi --query-gpu=pcie.link.gen.max,pcie.link.width.current --format=csv,noheader 2>/dev/null | tr -d ' ' | sort -t, -k1,1n -k2,2n | sed -n 1p | awk -F, '{print "gen" $1 "x" $2}')
[ -n "$PCIE" ] && emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"pcie\",\"value\":$(J "$PCIE")}"
# NVLink: one topology edge per active link
nvidia-smi nvlink -s 2>/dev/null | python3 -c '
import json, re, sys, time
node, gpu = sys.argv[1], None
for line in sys.stdin:
    m = re.match(r"GPU (\d+):", line)
    if m: gpu = m.group(1); continue
    m = re.search(r"Link (\d+): *([\d.]+) GB/s", line)
    if m and gpu is not None:
        print(json.dumps({"record": "topology", "kind": "nvlink", "t": int(time.time()), "source": "admit-node", "from": f"{node}/gpu{gpu}", "to": f"nvlink:{node}/gpu{gpu}/link{m.group(1)}", "gbps": float(m.group(2))}))
' "$NODE" >> "$TMP/out.jsonl" || true

# DCGM diagnostic
if ! skip dcgm; then
  if command -v dcgmi >/dev/null; then
    note "dcgmi diag -r $LEVEL (this takes a while)"
    dcgmi diag -r "$LEVEL" -j > "$TMP/diag.json" 2>"$TMP/diag.err" || true
    python3 - "$NODE" "$TMP/diag.json" "$LEVEL" >> "$TMP/out.jsonl" <<'PY'
import json, sys, time
node, f, level = sys.argv[1], sys.argv[2], sys.argv[3]
try: d = json.load(open(f))
except Exception as e: d = None
fails, tests = [], 0
def walk(o, name=None):
    global tests
    if isinstance(o, dict):
        n = o.get("name") or o.get("test_name") or name
        st = o.get("status")
        if isinstance(st, str):
            tests += 1
            if st.lower().startswith("fail"): fails.append(f'{n} gpu {o.get("gpu_id", o.get("entity_id", "?"))}')
        for v in o.values(): walk(v, n)
    elif isinstance(o, list):
        for v in o: walk(v, name)
walk(d)
ok = d is not None and tests > 0 and not fails
print(json.dumps({"record": "check", "t": int(time.time()), "source": "admit-node", "node": node, "check": "dcgm-diag", "ok": ok,
  "detail": (f"level {level}: " + ("; ".join(sorted(set(fails))[:10]) if fails else f"{tests} results passed")) if d is not None else "dcgmi diag gave no JSON"}))
PY
  else note "dcgmi not found: no DCGM diagnostic"; fi
fi
fi

# NCCL all-reduce across the node's GPUs
if ! skip nccl; then
  if command -v "$NCCL_BIN" >/dev/null; then
    note "all_reduce_perf on $COUNT GPUs"
    "$NCCL_BIN" -b 1G -e 4G -f 2 -g "$COUNT" > "$TMP/nccl.txt" 2>&1 || true
    BW=$(sed -n 's/.*Avg bus bandwidth *: *\([0-9.]*\).*/\1/p' "$TMP/nccl.txt" | tail -1)
    if [ -n "$BW" ]; then emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"nccl-allreduce\",\"value\":$BW,\"unit\":\"GB/s\",\"detail\":\"all_reduce_perf -b 1G -e 4G -g $COUNT\"}"
    else emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"nccl-allreduce\",\"ok\":false,\"detail\":$(J "$(tail -3 "$TMP/nccl.txt")")}"; fi
  else note "all_reduce_perf not found (nccl-tests): no NCCL check (--nccl-bin PATH)"; fi
fi

# burn-in under load: dcgmproftester (tensor-core load) on every GPU, temperatures sampled, XIDs counted before/after
if [ -n "$BURN" ] && ! skip burn-in; then
  S=$(secs "$BURN"); [[ "$S" =~ ^[0-9]+$ ]] || die "--burn-in like 6h or 90m"
  PT=$(command -v dcgmproftester12 || command -v dcgmproftester11 || true)
  if [ -n "$PT" ]; then
    X0=$( (dmesg 2>/dev/null || journalctl -k --no-pager 2>/dev/null || true) | grep -c 'NVRM: Xid' || true)
    note "burn-in for $BURN with $(basename "$PT")"
    "$PT" --no-dcgm-validation -t 1004 -d "$S" > "$TMP/burn.txt" 2>&1 &
    P=$!; MAXT=0; END=$(( $(date +%s) + S ))
    while kill -0 "$P" 2>/dev/null && [ "$(date +%s)" -lt "$END" ]; do
      T=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits | sort -n | tail -1); [ "${T:-0}" -gt "$MAXT" ] && MAXT=$T; sleep 30
    done
    wait "$P" || true
    X1=$( (dmesg 2>/dev/null || journalctl -k --no-pager 2>/dev/null || true) | grep -c 'NVRM: Xid' || true)
    NEW=$(( X1 - X0 ))
    emit "{\"record\":\"check\",\"node\":$(J "$NODE"),\"check\":\"burn-in\",\"ok\":$([ "$NEW" -eq 0 ] && echo true || echo false),\"value\":$S,\"maxTempC\":$MAXT,\"detail\":$(J "$S s of tensor load, max ${MAXT}°C, $NEW new XID(s)")}"
  else note "dcgmproftester not found: no burn-in"; fi
fi

# silent data corruption canary
if ! skip sdc; then
  if python3 -c 'import torch; assert torch.cuda.is_available()' 2>/dev/null; then
    note "SDC canary on every GPU"
    python3 "$HERE/sdc-canary.py" --node "$NODE" | python3 -c 'import json,sys
for l in sys.stdin:
    if l.strip(): r = json.loads(l); r["record"] = "sdc_check"; print(json.dumps(r))' >> "$TMP/out.jsonl" || note "the canary failed to run"
  else note "PyTorch with CUDA or ROCm not found: no SDC canary"; fi
fi

cat "$TMP/out.jsonl" > "$OUT"
note "wrote $(wc -l < "$TMP/out.jsonl" | tr -d ' ') record(s); next: fleetops data import admission FILE && fleetops admit check $NODE"
