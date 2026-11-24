# Configuration

Pass `--config my.json`. The file is deep-merged over the defaults in `src/config.mjs`, so list only what you change. [examples/config.example.json](../examples/config.example.json) is a starting point.

## Prices and partitions

```json
{ "pricePerGpuHour": { "B200": 6.0, "H200": 4.5, "default": 4.0 },
  "partitions": [0.125, 0.25, 0.5, 1] }
```

- **Prices** are keyed by the `sku` in your samples and drive every $/week figure. Use your blended cost: amortized capex plus power for on-prem, the contract rate for neocloud.
- **Partitions** are the GPU fractions a small workload can be given. Use the shapes your partitioning actually offers. MIG profiles are not exact powers of two, so map each to the nearest fraction of memory.

## Thresholds

| Key | Default | Meaning |
|---|---|---|
| `efficiency.warmupMin` | 15 | Ignore a job's first minutes (loading, compiling) |
| `efficiency.idleTensor` / `idleDram` / `idleAlertMin` | 0.05 / 0.10 / 10 | Idle: both below these for this long |
| `efficiency.underused` | 0.20 | Effective utilization p50 below this is underused |
| `efficiency.computeBound` / `memoryBound` | 0.30 / 0.50 | Tensor or HBM-bandwidth share that counts as bound |
| `efficiency.starvedCpuWait` | 0.30 | CPU/I-O wait share that makes low use "starved" |
| `efficiency.headroom` | 1.2 | Margin over the observed peak when right-sizing |
| `savings.minObservedHours` / `highConfidenceHours` | 24 / 72 | Data needed for medium / high confidence |
| `savings.minWeeklySavings` | 50 | Don't propose right-sizing worth less than this |
| `health.staleSec` | 300 | No sample for this long: not schedulable |
| `health.staleCircuitBreaker` | 0.2 | Above this share stale at once: suspect monitoring, hold states |
| `health.sbeRatePerHour` | 10 | Corrected ECC errors per hour that make a GPU suspect |
| `health.throttleBusy` | 0.2 | Share of busy time clock-limited |
| `health.tempOverPeersC` | 10 | Hotter than same-SKU peers at similar power |
| `health.speedIndexMin` | 0.92 | Micro-benchmark vs cohort median |
| `health.strikeWindowDays` | 30 | A second failure within this window after a fix sends the GPU to RMA |
| `health.memTempOverPeersC` / `memTempRiseC` | 8 / 6 | HBM hotter than peers / than its own earlier days at the same power |
| `health.powerBrakeBusy` | 0.05 | Share of busy time in power-brake slowdown |
| `health.telemetryGapFrac` | 0.3 | Share of expected samples missing in the last hour (one GPU; node-mates fine) |
| `health.persistN` / `persistK` / `persistWindowMin` | 3 / 4 / 60 | Windowed signals must fire in N of the last K windows |
| `health.signalCooldownMin` | 120 | A soft signal that cleared stays quiet this long |
| `health.sdcSoft` / `sdcHard` / `sdcWindowDays` | 1 / 2 / 7 | SDC events per GPU that make it suspect / quarantine it |

## Faults and the repair ladder

`faults` maps a fault code to `{ class, severity }`. Severity is `hard` (quarantine now), `soft` (suspect), or `ignore` (application errors such as XID 13/31/43). Vendor-specific codes (XIDs, AMD RAS events, SambaNova and TPU fault types) are in the vendor profiles; a code listed under `faults` overrides every vendor. See [VENDORS.md](VENDORS.md).

`ladder` lists the repair steps for each class, cheapest first. A failed diag moves the GPU one step up its ladder. A vendor profile can replace the ladder, and steps its platform can't do (a device reset on Cloud TPU, say) are skipped.

```json
{ "faults": { "xid63": { "class": "ecc", "severity": "hard" } },
  "ladder": { "ecc": ["gpu-reset", "node-reboot", "rma"] } }
```

## Policy

```json
{ "policy": {
    "dryRun": true,
    "actions": { "gpu-reset": "auto" },
    "classes": { "training": { "reclaim-idle": "never" }, "interactive": { "reclaim-idle": "auto" } },
    "limits": { "maxQuarantineShare": 0.1, "minQuarantinePerRun": 2, "maxNodeRebootsPerRun": 1, "maxActionAgeSec": 3600 },
    "cooldownSec": { "rejected": 604800, "executed": 86400 } } }
```

- **`actions`** sets the mode per action kind: `auto`, `approve` or `never`. Kinds that aren't listed need approval.
- **`classes`** overrides the mode per workload class. The class comes from `class` in your jobs file.
- **`dryRun: false`** is the second lock for real execution. Commands also need `--live` on the CLI, or `--allow-live` on the approval server.
- **`limits`** caps the blast radius of one run and refuses disruptive actions whose analysis is older than `maxActionAgeSec`.

Action kinds:

| Kind | From | Default command |
|---|---|---|
| `quarantine` / `release` | health | label + taint the node for that GPU / remove the taint |
| `run-diag` | quarantine, burn-in | create a diag Job (`{level}` = 1–4) |
| `deep-diag-next-boundary` | suspect, high risk, straggler | label the node so the scheduler runs a diag before the next job |
| `gpu-reset` / `config-reset` | ladder, pending remap | `ssh node nvidia-smi -r -i N` / `-rgc`; on AMD `amd-smi reset --gpureset --gpu N`; on SambaNova a webhook asking for an SNFM reset; not offered on Cloud TPU |
| `node-reboot` | ladder | `kubectl drain`, then reboot |
| `avoid-large-jobs` | high risk | label so large synchronous jobs avoid the GPU |
| `scale-in` | oversized inference | `kubectl scale deployment --replicas={replicas}` |
| `reclaim-idle` | idle allocation | delete the pod |
| `swap-at-checkpoint` | training job on a suspect, quarantined or high-risk GPU; stragglers | label the node so the launcher checkpoints and restarts without it |
| `drain-inference` | inference replica on a suspect, quarantined or high-risk GPU | flip the replica pods' `gpu-health.aiinfra/serving` label so the Service stops routing to them (`app={job}` label assumed) |
| `cordon-node`, `uncordon-node`, `drain-replica`, `scale-out`, `rollback-change`, `restart-without-node`, `link-check`, `hold-rollout` | proposed by the fleetops live agent from its diagnoses | see [fleetops/docs/AGENT.md](../../fleetops/docs/AGENT.md#the-playbook) |
| `resize`, `repartition`, `rma`, `reseat`, `firmware-align`, `fabric-restart`, `facilities-check`, `exporter-check`, `notify-owner` | various | webhook message to the owner or ops channel |

## Executors

Each action kind maps to a list of argv arrays, run in order without a shell, or to `"webhook"`, or to `{ "webhook": "what a person should do" }`. A vendor profile's `executors` win over these for its devices (`vendors.<v>.executors`). Placeholders: `{node} {gpu} {job} {namespace} {replicas} {level} {fraction} {reason} {vendor}`. Each value filled in must match `^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,252}$`. Anything else, including values starting with `-`, stops the action.

Slurm example. Draining in Slurm is per node, so quarantining one GPU drains the whole node:

```json
{ "executors": {
    "quarantine": [["scontrol", "update", "nodename={node}", "state=drain", "reason=gpu-health-gpu{gpu}"]],
    "release":    [["scontrol", "update", "nodename={node}", "state=resume"]] } }
```

`notify.webhook` takes a Lark/Feishu or Slack incoming-webhook URL; the message format is picked from the host. When it is empty, messages are printed only.

## Flakiness

```json
{ "flakiness": { "windowDays": 60, "bounceDays": 7, "holdDays": [7, 30], "rmaHardFailures": 3, "warnHours": 72,
                 "cohortRatio": 2, "cohortMinDevices": 3, "minRepairs": 3, "lostHoursPerFailure": 1 } }
```

What each one means is in [FLAKINESS.md](FLAKINESS.md#what-it-measures).

## Metric names

`ingest.mappings.<vendor>` overrides the exporter names in the vendor profiles (`src/vendors.mjs`). `fields` entries merge with the defaults; each value is `[sampleField, scale, agg?]`. Pass `--vendor` to force the vendor when detection from metric names isn't enough. To change a whole profile, or add a vendor, see [VENDORS.md](VENDORS.md).

```json
{ "ingest": { "mappings": { "amd": { "fields": { "gpu_mma_activity": ["tensor", 0.01] } } } } }
```
