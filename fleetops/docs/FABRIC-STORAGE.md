# Fabric and storage stalls

Before this, root-cause analysis named the **node** when NCCL was slow and said "storage" when jobs failed together.
Now a slow-link diagnosis names the **switch port**, and it says whether that port's cable is bad or the port is
congested. A data or checkpoint stall names the **storage target**: a Lustre OST, an NFS export, an object-store
bucket.

## Data

| Source | Import | Records |
|---|---|---|
| `perfquery [-x] LID PORT` (InfiniBand) | `data import perfquery FILE --switch leaf-03` | `port`: symbol errors, link recovery, link downs, receive errors, xmit discards, xmit wait, data |
| `ibqueryerrors` | `data import ibqueryerrors FILE` | `port`: every switch port with errors, fabric-wide |
| `ethtool -S IFACE` (RoCE NIC) | `data import ethtool FILE --node N --iface I` | `port` on the node's side: PFC pause frames, discards, CNPs sent, link downs |
| UFM telemetry, SONiC, SNMP through Prometheus | `data import fabric-prom range.json [--map metric=field]` | `port`, metric names mapped by pattern (`PortXmitWait*`, `ifInErrors`, `*pfc*`, `*ecn*`, `ifHCInOctets`, …), switch and port from common labels |
| anything else | `data import ports FILE` (JSON lines) | `port` |
| Lustre `lctl get_param obdfilter.*.job_stats` on the OSS | `data import lustre-jobstats now.txt --before then.txt` | `storage`: reads, writes and metadata per OST per job, with latency |
| NFS `/proc/self/mountstats` on a client | `data import mountstats now.txt --node N --before then.txt --window 60` | `storage`: per export, round-trip and execution time per op |
| anything else (an S3 client, the data loader's own timing) | `data import storage FILE` (JSON lines `{ t, target, op, job?, node?, ops?, latMs? }`) | `storage` |

`ibnetdiscover` now keeps the switch port each host lands on, so a node maps to `leaf-03/17`.

`tools/collect.sh` adds two things:
- NFS mountstats and the RDMA NICs' `ethtool -S`, taken at the start and at the end, so the bundle holds what
  happened in between;
- with `--fabric`, `ibnetdiscover` and `ibqueryerrors`.

Counters are stored as totals. Analysis takes how much each one grew in a window, and handles resets.

## Diagnosis

**`slow-link`** (one node's NCCL bandwidth well below the others', compute normal) looks up the node's switch port
and compares its counters in the incident with the 6 hours before:
- **Bad link:** symbol errors, link recoveries, link downs, receive errors, discards or uncorrectable FEC grew more
  than 3× their earlier rate. The title names `leaf-03/17, bad link`. The steps: reseat or replace the cable and
  transceiver, clear the counters, run nccl-tests again.
- **Congestion:** xmit wait, pause frames, ECN marks, CNPs or out-of-buffer grew, on the switch port or the node's
  NIC. The steps: find the other traffic on that switch, and check adaptive routing and QoS.
- **No counters in the store:** it names the port from the topology and asks for them.

**`fabric-congestion`** (new) is for when communication time per step rose on most of a job's nodes at once, so no
single node stands out. It looks at the uplinks of the leaf switches the job sits behind. When an uplink's xmit wait
or pause frames rose more than 3×, it names that leaf and those uplink ports. The fix is elsewhere: other traffic on
those uplinks, routing, or a placement that spans fewer leaves.

**`storage-stall`** (new) is for when steps wait longer on data (`dataS`) or on checkpoint writes (`ckptS`):
1. Of the storage targets the job uses (by job id, or by its nodes), it takes the one whose read or write latency
   rose most against the 6 hours before, at least 1.5×.
2. It names that target, with other jobs on the same target as supporting evidence. Storage log lines (NFS
   timeouts, Lustre errors) add weight.
3. When the job waits but none of its targets slowed, it says so: the loader itself (workers, CPU, decode) is more
   likely. With no storage data, it asks for it.

## Benchmark

Four planted-cause scenarios, 10 incidents each:

| Scenario | Top-1 | Component named |
|---|---|---|
| a bad cable on a leaf port | 10/10 | the port |
| a leaf's uplinks saturated | 10/10 | the leaf |
| a slow Lustre OST | 10/10 | the OST |
| checkpoint writes to a slow NFS export | 10/10 | the export |

The whole benchmark (22 scenario kinds, 220 incidents) stays at 99.5% top-1. The one miss is a version-cohort case
that misses on main too.

## Limits

- **Switch counters must be collected:** UFM, SONiC, SNMP or perfquery from a host with fabric access. Nodes
  alone show only their NIC side.
- **Uplink congestion is judged per uplink port.** It does not yet trace which flows share it. Adaptive routing
  spreads traffic, so one hot uplink can mean several.
- **Storage targets are only as fine as the source.** Lustre job_stats name the OST and the job; NFS mountstats name
  the export, per client. Object stores need the client's own timing.
