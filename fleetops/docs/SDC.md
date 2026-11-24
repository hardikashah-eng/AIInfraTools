# Silent data corruption

Some GPUs compute wrong answers without raising an error: no XID, no ECC count, nothing in the logs. In training, a
corrupted gradient or weight spreads through every replica at the next all-reduce. Every checkpoint saved after that
carries the damage. `fleetops sdc` finds the GPU from the evidence training already produces, and names the checkpoint
to resume from.

```bash
fleetops data import sdc-checks checks.jsonl           # your trainer's checks, and canary results
fleetops data import app-log train.log --node n3 --job llm   # non-finite loss lines become evidence too
fleetops sdc --days 2                                  # suspect GPUs, and per job the checkpoint to resume from
python3 tools/sdc-canary.py > canary.jsonl             # on a node: the same deterministic work on every GPU, compared
```

## Evidence

| Check | Record | Strength |
|---|---|---|
| **Canary** | `{ check: "canary", node, gpu, test, value, expected, ok }` from `tools/sdc-canary.py`: deterministic matmul chains in FP32 and BF16, compared across GPUs of the same model (majority of three or more) or against `--golden` values | confirms |
| **Replay** | `{ check: "replay", job, step, node, gpu, replayNode, replayGpu, ok }`: a step recomputed on another GPU did not match | confirms |
| **Parameter checksums** | `{ check: "param-checksum", job, step, rank, node, gpu, group, value }` from each data-parallel replica. Replicas of the same shard (`group`) must hold identical parameters after a step. | Strong when 3+ replicas give a majority; twice on the same GPU confirms. With two replicas a disagreement shows that something is wrong but not which side. |
| **First non-finite rank** | `{ check: "nan", … }`, or a `non_finite` app-log line with a rank | Suggestive. Loss-scaler overflows ("skipping step") are recognized and ignored. |
| **Gradient-norm outlier** | step records' `gradNorm` (the rank's local norm before all-reduce) | Weak: a rank far from its peers on 3+ steps |

**How the score works:**
- a GPU's score combines its evidence: 1 − Π(1 − strength);
- it rises when the same GPU shows up in more than one job, or is named by more than one kind of check;
- **confirmed** means a failed canary or replay, or a checksum minority twice;
- **suspect** means a score of 0.5 or more;
- **watch** is anything below that.

Parameter checksums are the cheapest strong signal. Hash each replica's parameter shard every N steps and log it:
- in PyTorch FSDP or DDP, hash the local shard;
- in Megatron, the replicas of a shard are the data-parallel group of each tensor- and pipeline-parallel rank.

## Where to resume

For each affected job, the report gives:
- **the first sign:** the earliest step with evidence from a confirmed or suspect GPU;
- **the last clean checkpoint:** the last checkpoint before it (step records with `ckptS`, or `checkpoint_saved` log
  records).

Checkpoints saved after the first sign may hold corrupted weights. Resume from the one named, without that node.

## What happens next

- **Detection:** a job with confirmed or suspect corruption becomes a `training-divergence` incident.
- **Diagnosis:** root-cause analysis ranks the `silent-corruption` rule first when the evidence points at one GPU. If
  two or more GPUs show evidence at once, it scores lower: a software or numerics bug is more likely.
- **gpu-health:** the evidence becomes `sdc` results through `data export gpu-health` and the live agent. gpu-health
  quarantines the GPU with fault class `sdc` (repair ladder: GPU reset, then RMA). A failed canary or replay confirms
  it.
- **The live agent:**
  - quarantines the GPU and runs a level-4 diag (the canary) on its own;
  - tells the job's owner which checkpoint to resume from;
  - proposes restarting the job from there without the node, which waits for a person.
- **Benchmark:** the scenario "one GPU corrupts its replica" (3–5 data-parallel replicas, one rank drifting from a
  random step, sometimes a NaN log) is diagnosed correctly 10/10 on each seed tried.

## Running the canary

`tools/sdc-canary.py` needs PyTorch with CUDA or ROCm and keeps every GPU on the node busy for a minute or two.
- **When to run it:** in a diag job, at burn-in, or before a node joins the training pool.
- **Comparing GPUs:** GPUs of the same model, driver and library versions should give bit-identical results with
  deterministic algorithms. With one or two GPUs of a model on a node, use `--golden` values recorded on known-good
  hardware (`--write-golden`). Keep one golden file per model and software stack.

The canary hasn't been run on GPUs here: no GPU was available. Its logic is simple, but check its first results on
your fleet against a known-good node.
