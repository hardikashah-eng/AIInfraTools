# Signals for diagnosis: logs, topology, versions, change feeds

Milestone 5 of the [roadmap](../../ROADMAP.md). Root-cause analysis can only name what the store holds. Before this
step it saw exporter counters, job outcomes and serving metrics. It now also sees:
- what the kernel and the job said: `log` records;
- how the hardware is wired: `topology` records;
- what each node runs: versions on `inventory` records;
- what changed: more `change` sources, including version changes found automatically.

## Sources

| Source | Command it reads | Records |
|---|---|---|
| `auto` | any of the files below | recognized by content (`fleetops data import auto FILE…`); a bundle from `tools/collect.sh` is imported with `data import bundle` ([TUNE.md](TUNE.md)) |
| `requests` | gateway or proxy request logs: LiteLLM, OpenAI-style usage, OTLP gen_ai spans, CSV of t, isl, osl, ttft, e2e | `request` (token counts and latencies only) |
| `kernel-log` | `journalctl -k -o short-iso`, `dmesg -T` (`--utc-offset`), `dmesg` (`--boot`), syslog (`--year`) | `log` |
| `app-log` | NCCL, RCCL or PyTorch job output (CUDA or HIP errors), optionally `kubectl logs --timestamps` | `log` |
| `nvidia-smi-q` | `nvidia-smi -q` | `inventory` with versions, GPU serials, UUIDs and the PCI → GPU map |
| `nvidia-topo` | `nvidia-smi topo -m` | `topology`: NVLink pairs, GPU ↔ NIC PCIe path |
| `amd-smi-static` | `amd-smi static --json` (`--rocm V`) | `inventory` with driver, IFWI (VBIOS) per GPU, ROCm, power limit and the PCI → GPU map |
| `amd-smi-topology` | `amd-smi topology --json` (both layouts amd-smi has shipped) | `topology`: XGMI links and PCIe peer links with hops |
| `ibnetdiscover` | `ibnetdiscover` | `topology`: host → leaf → spine |
| `racks` | CSV `node,rack,row,pdu,site` | `topology` |
| `k8s-nodes` | `kubectl get nodes -o json` | `inventory` with versions (GPU feature discovery labels, node info); rack/zone edges |
| `slurm-nodes` | `scontrol show node -o` | `inventory` with the kernel version |
| `k8s-events` | `kubectl get events -A -o json` | `change` (cordon, reboot, scaling) and `log` (NotReady, OOM, mount failures, evictions) |
| `helm-history` | `helm history REL -n NS -o json` | `change` (one per revision) |

### What the log adapter recognizes

| Class | Codes | From |
|---|---|---|
| ecc | `xid48`, `xid63`, `xid64`, `xid92`, `xid94`, `xid95`, `ras_uncorrectable`, `ras_correctable`, `cuda_ecc_uncorrectable` | NVRM XIDs, amdgpu RAS, CUDA errors |
| bus | `xid79` | GPU fell off the bus |
| link | `xid74`, `xid145`, `nvlink_error` | NVLink |
| pcie | `pcie_aer_uncorrected`, `pcie_aer_corrected` | AER lines naming the device, or the port with "received: …" |
| firmware | `xid119`, `xid120`, other XIDs, `amd_gpu_reset` | GSP / driver |
| network | `ib_link_down`, `nccl_timeout`, `nccl_ib_error`, `nccl_peer_lost`, `nccl_system_error` | mlx5 / hfi1, NCCL, the PyTorch watchdog |
| storage | `nfs_timeout`, `lustre_error`, `mount_failed` | kernel, Kubernetes events |
| host-memory, cpu | `host_oom`, `dimm_ue`, `dimm_ce`, `mce` | kernel |
| node | `node_not_ready`, `evicted` | Kubernetes events |
| app | `cuda_oom`, `cuda_illegal_access`, `amd_page_fault`, `xid13`, `xid31`, `xid43` | job output, kernel |
| info | `nccl_version`, `nfs_ok`, `ib_link_up` | kept only where useful (NCCL version) |

- **XID classes and severities come from gpu-health's table** (`gpu-health/src/vendors.mjs`), so the two tools never
  disagree on what an XID means.
- **GPU indexes:** a kernel line names a PCI address. The import maps it to a GPU index with the latest `nvidia-smi -q`
  in the store for that node. Only device classes are mapped; a NIC's address never becomes a GPU.

### Versions and derived changes

- **Version fields** on inventory records: driver, cuda, vbios, inforom, firmware, kernel, os, runtime, kubelet,
  image. NCCL comes from job logs.
- **Version changes:** when a node's snapshot shows a different version from its previous snapshot, the import writes
  a `change` record (driver, firmware, config or deploy) with `since`: the change happened somewhere between the two
  snapshots. The change rule counts it if the onset falls in that interval, so an hourly snapshot taken after the
  onset still explains it.
- **Mixed versions:** a node whose GPUs report different VBIOS or InfoROM versions gets `mixedVersions` on its
  inventory record.

## How root-cause analysis uses them

| Rule | New evidence |
|---|---|
| hardware | Device faults found in logs: XIDs, AER, AMD RAS, NVLink, MCE, a node's own NIC link. Spread over more than three nodes, only device classes count, because the rest points at something shared. Failures landing on the node that logged the fault add weight. |
| **shared-component** (new) | The leaf or spine switch, rack, PDU or row that holds most of the affected nodes, when most of that group is affected. It cites fabric errors behind a switch, and nodes dropping out behind a rack or PDU. |
| **version-cohort** (new) | A driver, firmware, kernel, image or NCCL version that ≥ 80% of the affected nodes run and few of the rest do. It cites the rollout when one is recorded. |
| infrastructure | Names storage or the network fabric when their errors are on enough of the failing nodes, and the storage server from the NFS lines. It defers to shared-component when those errors all sit behind one switch, rack or PDU. |
| workload | Application errors in the tenant's own job logs (CUDA OOM, illegal access) count for it; log faults on its nodes count against it. |
| change | Version changes from snapshots, with their `since` interval. A change to one node counts only if that node is affected. |

gpu-health reads the log-sourced device faults as results. Its global fault table now has the vendor-neutral codes:
- `pcie_aer_uncorrected`: pcie, hard;
- `pcie_aer_corrected`: ignored (a degraded link shows in the width/gen signals);
- `nvlink_error`: link, hard;
- `cuda_ecc_uncorrectable`: ecc, hard;
- `amd_gpu_reset`: firmware, soft.

## Scenarios (`tests/signals.test.mjs`)

Each runs on a 12-node fleet with 3 leaf switches, 2 racks and four owners.

| Scenario | Ranked first | Score (next) |
|---|---|---|
| A GPU falls off the bus, seen only in dmesg (`xid79` on n03/2); failures on n03 | hardware, citing the XID line | 0.77 |
| NCCL IB errors and failures on all four nodes behind leaf-2, across owners | shared-component: leaf switch leaf-2 | 0.90 (infrastructure 0.62) |
| Four nodes on different leaves and racks get driver 560 (seen in the next snapshot, after onset); failures on them | version-cohort: driver 560.35.03 on 4 of 4, 0 of 8 others | 0.90 (change 0.85) |
| NFS timeouts on 5 of 6 failing nodes, across owners | infrastructure: shared storage, naming storage01 | 0.88 |

The six Philly incidents are unchanged: each is still diagnosed as one namespace's workload, with high confidence.

## Limits

- **Fixtures, not production logs.** The fixtures follow each tool's documented output. No public dataset with real
  kernel logs, XIDs or fabric topology was found. Milestone 6's fault injection on a test cluster is where real ones
  come from.
- **Log lines vary.** Driver versions and distributions word lines differently. Unmatched lines are skipped, never
  guessed. Add a pattern to `KERNEL` or `APP` in `src/adapters/logs.mjs` with a fixture line.
- **NCCL lines carry no time.** Pass `--t`, or collect with `kubectl logs --timestamps`.
- **Counted, not deduplicated.** One event can produce several lines, e.g. an XID 79 and the AER line after it, so the
  counts in evidence are lines, not events.
