#!/usr/bin/env python3
"""Collect Cloud TPU runtime metrics and write gpu-health samples as JSON lines.

Cloud TPU has no Prometheus exporter by default. This reads libtpu's monitoring API (the same source as the
`tpu-info` CLI) on a TPU VM and writes one normalized sample per chip, which `gpu-health analyze --samples` reads.

    pip install libtpu
    python3 tools/tpu-collect.py --sku v5p --out tpu-samples.jsonl            # every 60 s, forever
    python3 tools/tpu-collect.py --count 1                                    # one snapshot to stdout

Fields written (when libtpu reports them):
    tensor      tensorcore_util / 100       TensorCore utilization
    sm          duty_cycle_pct / 100        share of the sample period the chip was busy
    memUsedGB   hbm_capacity_usage          HBM in use, GB
    memTotalGB  hbm_capacity_total          HBM capacity, GB
libtpu reports no temperature, power, ECC or link counters, so those checks don't run for TPUs (the report's
coverage table says so). Feed fault events (chip unhealthy, runtime errors) in as results instead:
    { "t": ..., "kind": "fault", "node": "<host>", "gpu": "<chip>", "code": "tpu_chip_unhealthy" }
Runtime metrics read as zeros until libtpu is initialized by a workload.
"""
import argparse
import json
import socket
import sys
import time

GB = 1e9


def read(tm, name):
    """A metric as a list of floats, one per chip, or None if libtpu doesn't offer it."""
    try:
        data = tm.get_metric(name).data()
    except Exception:
        return None
    if not isinstance(data, (list, tuple)):
        return None
    out = []
    for v in data:
        try:
            out.append(float(str(v).strip().strip("'\"")))
        except ValueError:
            return None  # not a per-chip list of numbers (format changed): skip the metric
    return out


def snapshot(tm, node, sku, site, now=None):
    t = int(now if now is not None else time.time())
    duty, tc = read(tm, 'duty_cycle_pct'), read(tm, 'tensorcore_util')
    used, total = read(tm, 'hbm_capacity_usage'), read(tm, 'hbm_capacity_total')
    chips = max([len(x) for x in (duty, tc, used, total) if x] or [0])
    rows = []
    for i in range(chips):
        s = {'t': t, 'site': site, 'node': node, 'gpu': str(i), 'vendor': 'tpu', 'kind': 'tpu', 'sku': sku, 'faults': []}
        if tc and i < len(tc):
            s['tensor'] = round(tc[i] / 100, 4)
        if duty and i < len(duty):
            s['sm'] = round(duty[i] / 100, 4)
        if used and i < len(used):
            s['memUsedGB'] = round(used[i] / GB, 2)
        if total and i < len(total):
            s['memTotalGB'] = round(total[i] / GB, 2)
        rows.append(s)
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--node', default=socket.gethostname(), help='node name to record (default: hostname)')
    p.add_argument('--sku', default='TPU', help='TPU generation, e.g. v5p or v6e (used for prices and peer groups)')
    p.add_argument('--site', default='', help='site label')
    p.add_argument('--interval', type=float, default=60, help='seconds between samples')
    p.add_argument('--count', type=int, default=0, help='samples to take (0 = forever)')
    p.add_argument('--out', default='-', help='JSONL file to append to (default: stdout)')
    a = p.parse_args(argv)
    try:
        from libtpu.sdk import tpumonitoring
    except ImportError:
        sys.exit('libtpu not found: run this on a TPU VM after `pip install libtpu`')
    out = sys.stdout if a.out == '-' else open(a.out, 'a')
    n = 0
    while True:
        for row in snapshot(tpumonitoring, a.node, a.sku, a.site):
            out.write(json.dumps(row) + '\n')
        out.flush()
        n += 1
        if a.count and n >= a.count:
            break
        time.sleep(a.interval)


if __name__ == '__main__':
    main()
