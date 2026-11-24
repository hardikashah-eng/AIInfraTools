# Measured root-cause accuracy: benchmark, fault injection, detection

Milestone 6 of the [roadmap](../../ROADMAP.md). Without labels, every change to a rule is a guess. This step adds:
- a benchmark that scores root-cause analysis on labeled incidents of three kinds: synthetic, injected, postmortem;
- a fault-injection kit that makes labels on a test cluster;
- detection that adapts to the fleet;
- rule weights fitted on labels.

```
node tools/fleetops.mjs rca bench                                   # synthetic scenarios, accuracy per cause
node tools/fleetops.mjs rca bench --injections --store DIR          # injected faults: detection delay + diagnosis
node tools/fleetops.mjs rca bench --labels postmortems.jsonl --store DIR
node tools/fleetops.mjs rca bench --injections --labels pm.jsonl --fit weights.json   # fit weights, held-out accuracy
node tools/fleetops.mjs rca detect --diagnose --weights weights.json
node tools/fleetops.mjs inject list
node tools/fleetops.mjs inject nfs-block --nodes gpu-t01,gpu-t02 --server nfs-test --allow test-cluster.allow --for 600 --live
```

## Detection (`src/detect.mjs`)

- **Seasonal baseline.** Each bin is compared with the median of the same bin on up to seven previous days. With less
  than two days of history it falls back to the trailing day's median. Observation starts with the first job of any
  outcome, so quiet time before the first failure counts as zero, not unknown.
- **Job failures: Poisson CUSUM.** It accumulates evidence for a rise to max(3× baseline, baseline + 3) per bin and
  alarms past h = 6.
  - The incident starts where the accumulation began (the change point), so its window covers the onset.
  - The evidence is capped at 3h, so one huge bin can't keep an incident open for days.
  - `--min-failures` (default 20) drops small bursts.
- **Latency: CUSUM on robust z-scores** of TTFT and TPOT p99 against the seasonal median and MAD. A window above a
  `--targets` SLO is an incident whatever the baseline says.
- **Grouping.** Incidents with the same symptom and pool that overlap or sit within `--group-gap` (30 min) fold into
  one. Overlapping incidents with different symptoms are linked (`related`), since each may need its own diagnosis.

| Check | Result |
|---|---|
| A busy hour every day (6 failures per 5 minutes), then a real spike | The busy hour is learned and never alarms. The spike alarms within 10 minutes and the incident starts within one bin of the change (`tests/bench.test.mjs`). |
| Philly, 8–14 Nov 2017 (`--where source=philly`) | The same six spikes the hourly threshold found, with alarms 20–70 minutes after onset (the threshold flags the whole hour only after it ends). It splits one into two and adds three smaller multi-owner bursts. |

## The benchmark (`src/bench.mjs`)

Three kinds of label, one format: `{ store, incident, cause (rule id), component? }`.

| Source | Where labels come from | What it shows |
|---|---|---|
| synthetic | `generate()`: randomized fleets of 12–24 nodes (leaves of 4, racks of 6 or 8, 3–6 owners) with one planted cause and 0–2 distractors | Each rule finds its cause through noise. Not accuracy on a real fleet. |
| injected | `injection` records written by `fleetops inject` on a test cluster | Detection delay and diagnosis on real faults through the real collectors |
| postmortem | JSON lines `{ incident, cause, component? }` against a store rebuilt for each window | Accuracy on your fleet's real failures |

**Synthetic scenario kinds:**
- workload: a retry storm, with app errors sometimes;
- hardware: a GPU fault seen in dmesg (exporter fault code sometimes); a GPU quarantined by gpu-health;
- change: a deploy before a latency regression;
- kv-pressure;
- load: a traffic surge;
- infrastructure: a storage outage with NFS or mount logs; many owners failing at once with nothing logged;
- shared-component: a bad leaf switch, with fabric logs sometimes and an outside node sometimes; a rack losing power;
- version-cohort: a bad driver, kernel or VBIOS on scattered nodes, recorded as a rollout half the time;
- monitoring-gap: exporters stop.

**Distractors:** an unrelated change, a harmless soft log line, a hard fault 10–20 hours earlier, another tenant
failing a little on one node, version skew on one node, plus background failures at a random rate.

A scenario depends only on (seed, kind, index), so `--only` reproduces it exactly.

**Scoring:**
- top-1 and top-3 for the expected rule;
- top-1 counting equivalent causes: a version rollout ranked as "change" names the same root cause as
  "version-cohort";
- whether the top hypothesis names the right component (node, switch, rack/PDU).

### What the benchmark found and fixed

The first run scored **73% top-1**. The misses were real weaknesses in the rules, not in the generator:

| Weakness | Fix |
|---|---|
| The monitoring-gap rule counted devices over a window starting 2 h before onset, so devices that went silent still counted as reporting (0/10) | It counts devices reporting during the incident |
| One stray failure made a node count as much as a node with eight | Affected nodes are those with ≥ 2 failures and ≥ 20% of the busiest node's |
| Any change was in scope for a job-failure incident with no named pool or nodes (a change to "gateway" scored 0.62) | In scope = the pool, affected nodes, the failed jobs' namespaces and owners, or fleet-wide; with nothing to scope by, a change counts half |
| NIC link-downs on 2–3 nodes behind one switch ranked as node hardware | Hardware loses 0.25 when its nodes all sit behind one component |
| Infrastructure didn't defer when the failures sat behind one rack | Infrastructure loses 0.25 when ≥ 60% of failing nodes sit behind one component |
| A rack holding 2/3 of a small fleet "explained" any set of nodes | Shared-component scores lift above chance: (cover − size/fleet) / (1 − size/fleet) |
| One owner with half of one node's failures was called a workload problem | Workload loses 0.3 when its failures sit on ≤ 2 nodes where others fail too, or on ≤ 3 nodes that logged a hard hardware fault |
| A stray node hid a cohort below the 80% bar | Version-cohort share is weighted by failures |

The rules were revised against seeds 1–4. Results:

| Seeds | Incidents | Top-1 | Top-3 | Component named |
|---|---|---|---|---|
| 1–4 (tuning) | 960 | 98.8–99.2% | 99.2–100% | 92.5–97.5% |
| 5–10 (not used for tuning) | 1,440 | 98.8–100% | 99.6–100% | 90–97.5% |

**Remaining misses:**
- Most are a version rollout ranked as "change" instead of "version-cohort": the same root cause. Counting
  equivalent causes, top-1 is 99.6–100%.
- The rest are a switch or rack scenario whose few failing nodes also fit a single faulty node.

### Fitted weights

`--fit FILE` fits one multiplier per rule (0.6–1.4) by coordinate ascent on top-1. It reranks from each hypothesis'
raw score without rerunning the rules, and never changes the evidence. It reports held-out accuracy (fit on half,
score the other half) and writes the weights fitted on all labels. `detect`, `diagnose` and `bench` take `--weights`.

**Don't ship weights fitted on synthetic scenarios.** They learn the generator: on seeds 1–2 the fit halves the change
rule, while on a real fleet a recent change is one of the most predictive signals. The file carries a warning when
the labels are synthetic only, or when a cause has fewer than 5 labels. Fit on injected and postmortem labels.

### In CI

`.github/workflows/fleetops.yml` runs `rca bench --per-cause 10 --seed 7 --min-top1 0.95 --min-top3 0.98`. A rule
change that breaks a cause fails the PR (exit code 5).

## Fault injection (`src/inject.mjs`, `fleetops inject`)

| Fault | What happens | Undo | Expected rule |
|---|---|---|---|
| `xid` | `dcgmi test --inject` field 230 (XID) on one GPU; with `--kmsg --pci`, also an NVRM line written to `/dev/kmsg` | none (the value ages out) | hardware |
| `ecc-dbe` | DCGM fields 311 / 313 (double-bit ECC, volatile / aggregate) | none | hardware |
| `nccl-stall` | `kill -STOP` one rank of a running NCCL job, `-CONT` after `--for` | yes | detection only until milestone 8 (straggler, collective hang) |
| `nic-down` | `ip link set dev IFACE down` on one node (RoCE / Ethernet) | yes | hardware |
| `ib-port-down` | `ibportstate LID PORT disable` from a fabric management host | yes | hardware (`--expect shared-component` for a leaf's uplinks) |
| `nfs-block` | iptables drops NFS (TCP 2049) from some nodes to one server | yes | infrastructure |
| `bad-deploy` | `helm upgrade --set KEY=VALUE`, `helm rollback` after `--for` | yes | change |
| `cordon` | `kubectl cordon` (harmless) | yes | detection only (checks the change feed end to end) |

**Safety:**
1. **Dry-run unless `--live`.** A dry run prints the commands and writes nothing.
2. **Every target must be in the `--allow` file** (or `FLEETOPS_INJECT_ALLOW`): one name per line, test-cluster
   hosts, releases and servers only. A target that isn't listed stops the run before any command.
3. **Values must be plain names or numbers**, so a target string can't become a command. `--set` must be `key=value`.
   The `--kmsg` line is built only from a checked XID number and PCI address.
4. **Faults with an undo revert after `--for` seconds,** and also on Ctrl-C. A failed apply is reverted at once.
5. **Every live injection becomes an `injection` record:** the label. `rca bench --injections` scores it.

**After injecting:**
- Let the collectors run, and import what they saw: exporter scrapes, `kernel-log`, `app-log`, `k8s-events`,
  `helm-history`.
- `rca bench --injections` then reports, per injection:
  - whether an incident started in its window, and the alarm delay (p50/p90 over all injections);
  - where the expected cause ranked;
  - whether the right node was named.

## Testing against production traces

1. **Backtest on past incidents.**
   - Rebuild the store for each postmortem's window from retained Prometheus (DCGM, vLLM), Loki or Elastic kernel and
     job logs, Kubernetes events and deploy history.
   - Write `{ incident, cause, component }` per postmortem and run `rca bench --labels`.
   - It needs no cluster changes, and each miss names the missing signal or rule.
2. **Game days on a test partition.** Inject faults with `fleetops inject` on drained nodes or a staging cluster,
   then run `rca bench --injections`. This measures detection delay and accuracy through the real collectors.
3. **Shadow mode next to on-call.** Run collectors read-only and `rca detect --diagnose` on a schedule (optimizer in
   dry-run) for 2–4 weeks. Compare each page with what fleetops detected (and when), its top cause, and the cause
   on-call settled on. That gives recall, false alarms per day, agreement and lead time. Confirmed causes become
   postmortem labels.

Milestone 6's done-when (top-1 ≥ 80% and top-3 ≥ 95% on ≥ 30 labeled incidents, half from injection; detection
within 5 minutes of an injected onset) needs those real labels. The tooling to make and score them is here, but the
labels themselves have to come from a test cluster and from postmortems.
