# Vendors

gpu-health works on NVIDIA and AMD GPUs, SambaNova RDUs and Google Cloud TPUs, and in a mixed fleet of them. Everything after ingest runs on normalized samples and vendor-neutral fault classes. A vendor is a profile in `src/vendors.mjs`, and you can add or change one in the config file without touching the code.

Try it: `node tools/gpu-health.mjs demo --mixed` builds an AMD, SambaNova and Cloud TPU fleet with one planted fault on each.

## What each vendor gives you

| | NVIDIA | AMD | SambaNova | Cloud TPU |
|---|---|---|---|---|
| Device kind | `gpu` | `gpu` | `rdu` | `tpu` |
| Telemetry | dcgm-exporter (`--prom`, `watch`) | device-metrics-exporter (`--prom`, `watch`) | hardware-monitoring exporter (`--prom`, `watch`) | `tools/tpu-collect.py` → JSONL (`--samples`) |
| Fault codes | XIDs, read from the exporter | RAS events, as fault results | Runtime / SNFM fault types, as fault results | Chip and runtime events, as fault results |
| Device reset | `nvidia-smi -r` | `amd-smi reset --gpureset` | a person, with SNFM or SambaNova support | none: the provider owns the hardware |
| Repair ladder | per fault class | per fault class | per fault class, no `config-reset` | restart or recreate the TPU VM, then a support case |

### Blind spots

The health checks that need a field a vendor doesn't report don't run for its devices. The report's **Telemetry coverage** table, and `coverage` in `--json` output, list for each vendor the checks that run and the ones that are blind. With the default metric sets:

- **AMD:** no throttle reasons and no row-remap counters.
- **SambaNova:** per-tile activity and clocks only, plus a node-level fault count. No per-RDU temperature, power, ECC or memory use.
- **Cloud TPU:** libtpu reports TensorCore utilization, duty cycle and HBM use. No temperature, power, ECC or link counters.

Cover the blind spots with what does work everywhere: fault events, silent-data-corruption checks from the training loop, benchmark probes (`--probes`) and regular diags. Missing telemetry is still fail-closed for every vendor: a device that stops reporting is quarantined, and a field that used to report and stops is a `telemetry` signal.

## Setup by vendor

**NVIDIA and AMD.** Point `--prom` or `watch --scrape` at the exporters. The vendor is detected from the metric names; `--vendor` forces it.

**SambaNova.** Scrape the SambaNova exporter from the hardware-monitoring stack. Per-tile activity (`sambanova_tile_aload_percent`, `sambanova_tile_exec_percent`) is averaged per RDU into `tensor` and `sm`. `sambanova_platform_fault_count` is per node. When it rises, every RDU on that node becomes suspect until a deep diag or SNFM shows which one failed. Send the fault types from SNFM or the runtime logs as fault results:

```json
{ "t": 1763550000, "kind": "fault", "node": "sn-01", "gpu": "2", "code": "FTYPE_RDU_REMOVED", "detail": "SNFM: RDU removed" }
```

`FTYPE_RDU_REMOVED` and `FTYPE_RDU_INIT` quarantine the RDU; `FTYPE_RDU_RESET` makes it suspect.

**Cloud TPU.** Run the collector on each TPU VM. It reads libtpu's monitoring API, the same source as `tpu-info`:

```bash
pip install libtpu
python3 tools/tpu-collect.py --sku v5p --out /var/lib/gpu-health/tpu-samples.jsonl     # every 60 s
node tools/gpu-health.mjs analyze --samples /var/lib/gpu-health/tpu-samples.jsonl --jobs jobs.json
```

Send chip and runtime events as fault results with the codes `tpu_chip_unhealthy` (quarantine), `tpu_runtime_error` (suspect) or `tpu_maintenance` (ignored: planned host maintenance is not a device fault).

## Fault events

Any vendor's faults can come in as results, in the `--results` file:

```json
{ "t": EPOCH, "kind": "fault", "node": "n1", "gpu": "3", "code": "xid79" }
{ "t": EPOCH, "kind": "fault", "job": "train-llm", "rank": 13, "code": "ras_uncorrectable" }
```

Use this for faults that live in logs rather than metrics: XIDs from `dmesg`, AMD RAS events, SNFM output, TPU events. A fault code resolves in this order:

1. `faults` in your config, which overrides every vendor;
2. the device's vendor profile;
3. any vendor profile, for JSONL samples without a `vendor`.

An unknown code makes the device suspect.

## Changing or adding a vendor

Everything in a profile can be overridden under `vendors` in the config file, which is deep-merged over the defaults:

```json
{ "vendors": {
    "amd": { "executors": { "gpu-reset": [["ssh", "{node}", "sudo", "/opt/site/amd-reset.sh", "{gpu}"]] } },
    "sambanova": { "faults": { "FTYPE_RDU_RESET": { "class": "firmware", "severity": "hard" } } } } }
```

A new vendor needs a `mapping` from its exporter to the sample fields, or a collector that writes JSONL samples, plus its fault codes and the actions it can't do. Here `acme` and its metric names are placeholders:

```json
{ "vendors": { "acme": {
    "name": "Acme", "kind": "npu", "detect": "^acme_",
    "mapping": { "node": ["instance"], "gpu": ["device"], "sku": ["model"], "defaultSku": "ACME-1",
                 "fields": { "acme_core_busy_percent": ["sm", 0.01], "acme_matrix_busy_percent": ["tensor", 0.01],
                             "acme_hbm_used_bytes": ["memUsedGB", 1e-9], "acme_temp_celsius": ["tempC", 1] } },
    "faults": { "ACME_DEVICE_LOST": { "class": "bus", "severity": "hard" } },
    "executors": { "gpu-reset": { "webhook": "Reset the device with acme-cli on the host." } },
    "unsupported": ["config-reset", "repartition"] } } }
```

Profile fields:

| Field | Meaning |
|---|---|
| `name`, `kind` | Display name; device kind (`gpu`, `tpu`, `rdu`, …) used in messages and the coverage table |
| `detect` | Regex (string) that recognizes the exporter text; `null` when the vendor's samples come as JSONL |
| `mapping` | `node`, `gpu`, `sku`, `job`: label names to try, in order. `defaultSku`: used when no label has one. `fields`: metric → `[sampleField, scale, agg?]`, where `agg` is `"mean"` (several series per device, averaged) or `"node"` (one series per node, copied to every device on it). `fault` / `faultPrefix`: a metric whose value is a fault code. `tensorFrom`: a field that stands in for tensor activity |
| `faults` | Fault code → `{ class, severity }`, with severity `hard`, `soft` or `ignore` |
| `executors` | Action kind → argv templates, `"webhook"`, or `{ "webhook": "what a person should do" }`. Kinds not listed use the global `executors` |
| `unsupported` | Action kinds this platform can't do. They are never proposed and are skipped on the repair ladder |
| `ladder` | Repair steps by fault class, overriding the global `ladder`; `default` applies to every class |

## Not covered yet

- **Failure domains.** A TPU slice, an NVSwitch tray or a SambaNova XRDU can take several devices down together. Health and risk are per device today; rolling them up to the unit that fails or gets scheduled is the next step.
- **Label names.** Kubernetes labels and taints still use the `gpu-health.aiinfra/gpu-{n}` names on every vendor, so existing scheduler rules keep working.
- **Vendor diag suites.** `run-diag` creates one diag Job for every vendor. Point its image at a wrapper that runs DCGM diag, RVS/AGFHC or the vendor's own checks.
