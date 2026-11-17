# Inference view: serving on the cluster

The **Inference** tab looks at the serving deployments in the Cluster tab's cluster as Kubernetes pods. It answers three questions:

- Is every deployment at full strength?
- How long does a new replica take to serve?
- Who takes the GPUs when serving needs them?

## What it shows

- **Headline**: the deployment that ran shortest and why (preempted by which job, when, how far short), and what a new replica's start-up time is mostly spent on, with the saving from caching weights on local NVMe.
- **KPIs**: replica-hours short of target, share of time at full strength (worst deployment), deepest shortfall, start-up time, scheduling wait p90, serving pods preempted, peak GPUs for serving and for training.
- **GPUs by workload kind** over time: inference, training, batch, faulted, free.
- **Per deployment**: the replica target (daily cycle) against replicas ready to serve, replicas scheduled but still starting, and the shortfall. Below it, a new replica's time to serve: scheduling wait (p50, from the cluster simulation), image pull, weight load and warm-up.
- **Side panel at the playhead**: target, running and ready replicas per deployment, why any are short, and nearby preemptions.

## Start-up model

Time to serve = scheduling wait + image size ÷ registry bandwidth + weights ÷ weight-source bandwidth + warm-up.
- **Weights:** FP8, one byte per parameter, for the model each deployment serves.
- **Weight sources:** local NVMe cache (5 GB/s), parallel file system (2 GB/s), object store (0.5 GB/s), model hub over the internet (0.15 GB/s).
- **Warm-up:** CUDA graph capture, compilation and health checks.
- **Warm at start:** replicas already running when the simulation starts count as warm.

## Scenarios

- **Cluster as in the Cluster tab**: whatever is configured there (the sample cluster until you change it).
- **Pre-training outranks serving**: serving queues are set just below the training queues' priority.
  - On the sample cluster under spread placement, the 160-GPU pre-training gang preempts 49 chat replicas at 0:30. Chat serving runs 64% short until replacements have loaded weights.
  - With weights in the object store, each replacement takes 4 minutes to serve; on local NVMe, 1.8 minutes.
- **Cluster tab, with bin-pack placement**: the same cluster with bin-pack placement.
