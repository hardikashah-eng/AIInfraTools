# Node admission and safe rollouts

Two gates that stop a bad node or a bad version before it reaches a production job:
- **Admission:** a node joins the training pool, or comes back from repair, only after it passes a set of checks.
- **Rollouts:** a new driver, firmware, CUDA, NCCL or kernel version goes to a canary cohort first. It is compared
  automatically with the nodes still on the old version, and a regression rolls it back before the next wave.

The root-cause analysis rules `hardware` and `version-cohort` find these problems after jobs have failed. The gates
find them before.

## Admission

```bash
# on the node (it refuses while compute processes run on the GPUs)
tools/admit-node.sh --burn-in 6h --out admit-$(hostname).jsonl
# anywhere with the store
fleetops data import admission admit-gpu-a17.jsonl
fleetops admit check gpu-a17
fleetops admit apply gpu-a17            # admit-node waits for approval; reject-node runs on its own (dry run unless --live)
```

`admit-node.sh` changes nothing on the node. It runs on NVIDIA nodes (`nvidia-smi`) and on AMD nodes (`amd-smi`). Each part is skipped with a note when its tool is missing:

| Part | Runs | Record |
|---|---|---|
| versions | NVIDIA: `nvidia-smi` (driver, VBIOS, CUDA, GPU model and count). AMD: `amd-smi static` (driver, IFWI, model and count) and `/opt/rocm/.info/version`. Both: `uname -r`, NCCL or RCCL through PyTorch | inventory |
| topology | PCIe generation (maximum) and width (current) per GPU; active NVLink links (`nvidia-smi nvlink -s`) or XGMI links (`amd-smi topology`) | check, topology |
| diag | NVIDIA: `dcgmi diag -r 3` (`--diag-level`), recorded as `dcgm-diag`. AMD: the ROCm Validation Suite, `rvs -c CONF` (`--rvs-conf`; default `gst_single.conf`), recorded as `rvs-diag` | check |
| nccl | `all_reduce_perf` from nccl-tests (NVIDIA) or rccl-tests (AMD) on every GPU of the node, 1–4 GB messages | check (bus bandwidth) |
| burn-in | with `--burn-in`, NVIDIA only: `dcgmproftester` tensor load, the hottest GPU sampled every 30 s, new XIDs counted. On AMD, run your own load: the check counts hours under load from the exporter's samples | check |
| sdc-canary | `tools/sdc-canary.py` | sdc_check |

`fleetops admit check NODE` judges six checks:

| Check | Passes when | Compared with |
|---|---|---|
| burn-in | `burnInS` (6 h) at ≥ 50% load with no hard fault, no new uncorrectable ECC error, no pending row remap, GPU ≤ 87 °C, HBM ≤ 95 °C | DCGM samples from the store (preferred), or the script's burn-in record |
| diag | the vendor's diagnostic passed (`dcgm-diag` or `rvs-diag`; a policy that lists `dcgm-diag` means this check) | — |
| sdc-canary | every GPU ran the canary and agreed with its peers or the golden values | — |
| nccl | all-reduce bus bandwidth ≥ 90% of the reference | the median of the same SKU's admitted nodes (at least 3), or `ncclRef` in the policy |
| topology | as many GPUs and scale-up links (NVLink or XGMI), and the same PCIe link, as the same SKU's other nodes | peers |
| versions | driver, CUDA or ROCm, firmware, VBIOS or IFWI, NCCL or RCCL, and kernel equal to the baseline | `golden` in the policy, or what most admitted nodes of the SKU run |

The verdict:
- **reject** if any required check fails, with the evidence;
- **incomplete** if any is missing, with the command that would supply it;
- **admit** otherwise.

`--record` stores the verdict. Admitted nodes become the reference for the next ones.

**The gate in Kubernetes.** New nodes register with the taint `aiinfra.dev/admission=pending:NoSchedule` (kubelet
`--register-with-taints`), and nodes going to repair get it too. Nothing schedules on them except the admission job,
which tolerates it.

`admit apply` turns the verdict into an action in gpu-health's queue:
- `admit-node` removes the taint and labels the node `aiinfra.dev/admission=admitted`. It needs a person's approval.
- `reject-node` labels the node `aiinfra.dev/admission=rejected` and leaves the taint. It runs on its own: keeping a
  node out is safe.

Both are dry runs unless `--live` and `policy.dryRun: false` in the gpu-health config. On Slurm, replace the executors
with `scontrol update NodeName={node} State=RESUME` and `State=DRAIN Reason=admission`.

**Which nodes.** `fleetops admit pending` lists:
- nodes new to the inventory in the last 30 days that were never admitted;
- nodes with a quarantine, repair or RMA health event since their last admission;
- nodes with a hardware, firmware or driver change since then.

**The policy** (`--policy p.json`, all optional): `lookbackS`, `burnInS`, `burnInLoad`, `maxTempC`, `maxMemTempC`,
`require` (which checks gate), `ncclFrac`, `ncclRef` `{ sku: GB/s }`, `versionFields`, and `golden`
`{ sku: { driver: … } }`.

## Rollouts

```bash
fleetops rollout plan --field driver --version 560.35.03 --canary 2 --waves 25%,100% --bake 6h \
  --apply "ansible-playbook driver.yml -l {node} -e version={version}" \
  --rollback "ansible-playbook driver.yml -l {node} -e version=550.54.15" --out rollout.json
gpu-health actions approve rollout-stage:rollout-driver-560.35.03#1 --by alice --state fleet-data/rollouts/state
fleetops rollout advance --plan rollout.json          # run it on a schedule: applies approved waves, judges baked ones
```

**The plan:**
- **Who moves:** every node not yet on the version, filtered by `--nodes REGEX` and `--sku`.
- **The canary:** spread round-robin over racks and SKUs, with nodes that had hard faults in the last week last.
- **The waves:** fixed sizes or percentages of the nodes to move.
- **Each wave** is an action in gpu-health's approval queue.
- **Commands:** `--apply` and `--rollback` are argv templates (no shell). `{node}`, `{version}` and `{field}` are
  filled in and checked. Without them, each wave posts what to do to the webhook, and a person does it.

**After each wave's bake time** (6 h by default), `rollout advance` checks that the wave's nodes report the new
version in the inventory. It then compares every node moved so far with the same SKUs' nodes still on another
version, over the time since the canary:

| Signal | Regression when |
|---|---|
| job failures per GPU-hour on the nodes | at least 2, ≥ 1.5× the old version's rate, p < 0.01 (Poisson, widened by the between-node dispersion) |
| hard faults (XID, AER, …) per GPU-hour | the same |
| NCCL bus bandwidth (NCCL Inspector collectives) | the median ≥ 10% lower, Mann-Whitney p < 0.01, ≥ 20 samples each |
| compute time per training step, within the same job | ≥ 5% slower in at least 3 of 4 jobs that ran on both versions |
| TTFT of requests served from the nodes | the median ≥ 10% higher, p < 0.01 |

Step compute is compared within jobs that span both versions. Those ranks run the same model, batch and code, so
their difference is the version's. A job's synchronized step time would hide it, so per-rank compute time
(`computeS`) is used when the step logs carry it.

**After the comparison:**
- **A regression** rolls the wave back without waiting for approval, halts the rollout, and stores a `rollout`
  record. Later waves never run.
- **No regression with enough exposure** (100 GPU-hours on the new version, or the bandwidth and step comparisons)
  marks the wave verified. The next wave waits for its approval.
- **Too little data:** it waits.

Applied waves are stored as `change` records, so root-cause analysis sees them like any other change.

`fleetops rollout check --field driver --version V --from T --to T` runs the same comparison on any version already
in the fleet, without a plan. `fleetops rollout demo [--good]` writes 24 nodes where two moved to a new driver, bad
or harmless, to try it on.

## Validation on real data

`tests/admission-real.test.mjs` runs the comparison on a real week of the Philly cluster (8–15 Nov 2017, 29,230
placements on 238 machines of one SKU), with a random 10% of the machines labelled as the new version:

| Case | Result |
| --- | --- |
| Random labels, nothing changed (A/A, 100 splits) | 1 false alarm with the dispersion, 17 with a plain Poisson test |
| Failure rate tripled on the "new" machines (30 splits) | caught in most splits (the test needs 60%) |
| Failure rate doubled (40 splits, not in the test) | caught in about half |

Failures on real clusters cluster on a few flaky machines and on multi-node jobs, so per-node counts vary several
times more than Poisson allows (the dispersion was above 2 in every split). The comparison estimates that from the
control nodes and widens the test by it. A one-week canary on 10% of a SKU catches a doubling about half the time; to
catch smaller regressions, bake longer or canary more nodes.

No-mock and mocked tests in the same file: `admit-node.sh` run on the test host as it is, and a live admit and
reject through a stand-in `kubectl`, which runs only with approval, `--live` and `policy.dryRun: false`.

## Limits

- **Exposure decides power.** Two canary nodes for six hours see few failures, so the failure and fault rates only
  catch big regressions early. Bandwidth and step compute need far less exposure and catch more. For firmware that
  fails rarely, bake longer or use a bigger canary.
- **A version is only one of the things that differ.** The canary's racks and jobs are not the control's. Racks are
  spread on purpose, and the step comparison is within the same jobs, but a canary that landed on unlucky racks can
  still look worse.
- **Burn-in from the store needs DCGM samples during the burn-in.** Otherwise the script's own record stands in, and
  it sees only temperature and XIDs.
