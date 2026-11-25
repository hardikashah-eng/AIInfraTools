#!/usr/bin/env python3
"""AMD side of admit-node.sh: amd-smi JSON → admission records (JSON lines), the same shapes the NVIDIA path writes.

  amd-admit.py --node N --static static.json [--metric metric.json] [--topology topo.json] [--processes procs.json]
               [--rocm VERSION] [--rccl VERSION] [--busy-only]

  static     `amd-smi static --json`         → inventory record (market name, driver, IFWI, ROCm, RCCL) + gpu-count check
  metric     `amd-smi metric --pcie --json`  → pcie check: the slowest GPU's max generation × current width
  topology   `amd-smi topology --json`       → topology records, one per XGMI link (kind xgmi)
  processes  `amd-smi process --json`        → with --busy-only: exit 3 when compute processes are running, else 0

amd-smi prints a list of per-GPU objects, or {"gpu_data": [...]} in newer releases, and values as plain numbers or
{"value": …, "unit": …}; both are read.
"""
import argparse, json, sys, time

GEN = {2.5: 1, 5: 2, 8: 3, 16: 4, 32: 5, 64: 6, 128: 7}


def gpus(path):
    with open(path) as f:
        o = json.load(f)
    a = o if isinstance(o, list) else (o.get("gpu_data") or o.get("gpus") or [])
    return [g for g in a if isinstance(g, dict) and "gpu" in g]


def val(v):
    if isinstance(v, dict) and "value" in v:
        v = v["value"]
    return None if v in (None, "N/A", "") else v


def num(v):
    v = val(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        try:
            return float(str(v).split()[0])
        except (TypeError, ValueError, IndexError):
            return None


def busy(path):
    """True when any GPU lists a process with a pid."""
    def walk(o):
        if isinstance(o, dict):
            if num(o.get("pid")):
                return True
            return any(walk(v) for v in o.values())
        if isinstance(o, list):
            return any(walk(v) for v in o)
        return False
    with open(path) as f:
        return walk(json.load(f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", required=True)
    ap.add_argument("--static"); ap.add_argument("--metric"); ap.add_argument("--topology"); ap.add_argument("--processes")
    ap.add_argument("--rocm"); ap.add_argument("--rccl"); ap.add_argument("--kernel")
    ap.add_argument("--busy-only", action="store_true")
    ap.add_argument("--t", type=int, default=int(time.time()))
    a = ap.parse_args()
    if a.busy_only:
        sys.exit(3 if a.processes and busy(a.processes) else 0)
    out = []
    rec = lambda **r: out.append(dict(r, t=a.t, source="admit-node", node=a.node))
    if a.static:
        gs = gpus(a.static)
        names = [val((g.get("asic") or {}).get("market_name")) or val((g.get("board") or {}).get("product_name")) for g in gs]
        fw = sorted({val((g.get("ifwi") if isinstance(g.get("ifwi"), dict) else g.get("vbios") or {}).get("version")) or "" for g in gs} - {""})
        drv = [val((g.get("driver") or {}).get("version")) for g in gs]
        versions = {k: v for k, v in {"driver": next((d for d in drv if d), None), "vbios": "|".join(fw) or None, "rocm": a.rocm, "rccl": a.rccl, "kernel": a.kernel}.items() if v}
        sku = max(set(n for n in names if n), key=names.count) if any(names) else ""
        rec(record="inventory", vendor="amd", kind="gpu", sku=sku, devices=len(gs), versions=versions)
        rec(record="check", check="gpu-count", value=len(gs))
        if a.metric:
            width = {str(g["gpu"]): num((g.get("pcie") or {}).get("width")) for g in gpus(a.metric)}
            pairs = []
            for g in gs:
                sp, w = num((g.get("bus") or {}).get("max_pcie_speed")), width.get(str(g["gpu"]))
                if sp in GEN and w:
                    pairs.append((GEN[sp], int(w)))
            if pairs:
                gen, w = sorted(pairs)[0]
                rec(record="check", check="pcie", value=f"gen{gen}x{w}")
    if a.topology:
        seen = set()
        for g in gpus(a.topology):
            links = g.get("links")
            if isinstance(links, list):
                items = [(l.get("gpu"), l.get("link_type"), l.get("link_status"), l.get("num_hops")) for l in links]
            else:
                lt = g.get("link_type") or {}
                items = [(k.replace("gpu_", ""), v, (g.get("link_accessibility") or {}).get(k), (g.get("hops") or {}).get(k)) for k, v in lt.items()]
            for peer, typ, status, hops in items:
                if str(typ).upper() != "XGMI" or str(peer) == str(g["gpu"]) or (status and str(status).upper() != "ENABLED"):
                    continue
                key = tuple(sorted((str(g["gpu"]), str(peer))))
                if key in seen:
                    continue
                seen.add(key)
                rec(record="topology", kind="xgmi", **{"from": f"{a.node}/gpu{key[0]}", "to": f"{a.node}/gpu{key[1]}"}, hops=num(hops))
    for r in out:
        print(json.dumps({k: v for k, v in r.items() if v is not None}))


if __name__ == "__main__":
    main()
