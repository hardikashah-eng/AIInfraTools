# Training view: one job, four ways

The **Training** tab simulates one training job step by step and shows it four ways. Each answers one question.

| Sub-view | Question | What it shows |
| --- | --- | --- |
| **Full view** | Where is the bottleneck? | One headline naming the biggest loss of wall time and why. Where wall time went (computing, slow GPUs, data, sync, checkpoints, restarts, redone work, queueing), the GPU grid, idle GPU-hours by cause, and step time by phase. |
| **GPUs** | What is each GPU doing, and which ones hurt? | Every GPU at the playhead: computing, waiting on slow GPUs, waiting on data, sync, checkpointing, restarting, faulted, queued. Also idle GPU-hours by cause, the slowest GPUs, and the most-faulting nodes (from the run, and from an imported fault log). |
| **Phases** | Which part of a step grows? | Each step as a column split into data, compute, waiting on slow GPUs, sync and optimizer; checkpoints, restarts and queueing in between; steps later lost to a fault faded; the data-mix switch marked. A table per data mix: step time, exposed and raw data time, whether loading is limited by storage or by decode/tokenize. |
| **Scheduling** | Can it start, and what does the scheduler do to it? | Constraint checks: GPUs needed for model states, tensor parallel inside a node, TP × PP × DP, gang fits one IB domain, queue quota, cluster capacity. Admission on the Cluster tab's cluster (wait and why, next to the other workloads), and each fault: moved to a spare, or waited for repair. |

## Model

For a model (from the fleet presets), GPU type and GPU count:

- **Compute** = 6 × active parameters × tokens per step ÷ (GPUs × peak BF16 × kernel efficiency), plus tensor-parallel overhead and the pipeline bubble ((PP − 1) ÷ (microbatches + PP − 1)).
- **Gradient sync**: ring all-reduce of 2-byte gradients across data-parallel ranks, over InfiniBand when the job spans nodes. Only the part not overlapped with compute counts.
- **Data loading** per step = the slower of storage reads (parallel file system and cloud bucket shares, after cache hits) and decode/tokenize on the dataloader workers. With prefetch, only the part longer than compute is exposed.
- **Two data mixes** with a switch time: see what a new dataset does to step time before switching. The default switches from pre-tokenized text to video and images, 70% in a cloud bucket. Decoding becomes the bottleneck: step time goes from 26 s to 29 s, and doubling dataloader workers hides it.
- **Slow GPUs**: a share of GPUs runs slower (thermal throttling, ECC retries, a weak link). Every step waits for the slowest, so one slow GPU idles the others.
- **Checkpoints**: 14 bytes per parameter written at a set bandwidth every N minutes, blocking or asynchronous.
- **Faults**: Poisson per GPU. A fault loses the work since the last checkpoint, then the job restarts and reloads. With a hot spare node it resumes on the spare; without one it waits for repair. Spares return after repair.
- **Memory floor**: about 16 bytes per parameter (weights, gradients, Adam states), sharded, at 75% of HBM, gives the minimum GPU count.
- **Admission**: with "Start when the Cluster view's scheduler admits it", the job replaces the pre-training workload in the Cluster tab's cluster. Its admission wait becomes queueing time here. Before the Cluster tab is opened, the sample cluster with bin-pack placement is used.

**Goodput** is the share of wall time spent computing steps that were kept; **effective MFU** is useful FLOPs ÷ (wall time × GPUs × peak).

## Fault logs

**Import fault log** reads:
- CSV with node/hostname, GPU and optional time and Xid columns
- JSON lines with the same fields
- syslog lines with `NVRM: Xid (PCI:…): <code>`, as `dmesg` or DCGM write them

Faults are then weighted toward the GPUs that fail most in the log, and the log's top GPUs and Xid codes are listed.

## Default job

Llama 3.3 70B on 160 H100s (20 nodes, TP 8, DP 20), 4M tokens per step, 12 hours:
- **Bottleneck:** one GPU 12% slow holds every step (9% of wall time). Data loading after the mix switch is next (7%).
- **Fault:** one GPU fault moved the job to the hot spare and cost 43 minutes of restart and redone work.
- **Goodput:** 76%; effective MFU 35%.
