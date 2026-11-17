# Cluster view: Kubernetes scheduling of GPU workloads

The **Cluster** tab at the top of the page switches from the fleet graph to the Kubernetes layer: which pod gets which GPU, who waits, and why. Use it to see what a change to scheduler policy, quotas, node pools or workloads would do before you make it.

## What is simulated

| Part | Model |
| --- | --- |
| Node pools | GPU type, nodes, GPUs per node, nodes per InfiniBand domain, site, fault rate per GPU-day, repair time |
| Queues | Kueue-style ClusterQueues: GPU quota (nominal), priority, owning team |
| Inference | A Deployment whose replica count follows a daily cycle between a minimum and a peak; pods of N GPUs |
| Training | A job of N pods × M GPUs that needs all its pods running to make progress, optionally inside one IB domain; run time, checkpoint interval, restart/load time |
| Batch | A stream of one-pod jobs (Poisson arrivals, log-normal run time), e.g. evaluations or backfills |
| Scheduler | Every 10 s, pending work is taken in priority order, then oldest first |

### Scheduler policy knobs

- **Placement**: *bin-pack* puts pods on the fullest node that fits; *spread* on the emptiest.
- **Gang scheduling**: place all pods of a training job together or none. Off: pods are placed one by one and hold their GPUs idle until the rest arrive.
- **Topology-aware**: training jobs that ask for it are placed inside one IB domain.
- **Preemption**: higher-priority work may evict lower-priority pods. A queue within its quota may also reclaim GPUs another queue borrowed. Over quota, only lower-priority work in the same queue can be evicted. Evicting a training pod stops the whole job, which goes back to its last checkpoint.
- **Quota borrowing**: a queue may use other queues' unused quota.
- **Queue order**: *best-effort FIFO* skips a blocked request and tries later ones; *strict FIFO* stops at the first blocked request in each queue.

### Faults

Each GPU fails at the pool's rate and comes back after the repair time (±50%). A fault kills the pod on it. An inference pod is rescheduled; a batch job restarts from scratch. A training job loses the work since its last checkpoint, and all its pods go back to pending. When it is placed again, it spends its restart time loading before making progress. The run ranks the nodes and GPUs that faulted most.

## What you see

- **Headline**: the job that never started or waited longest, and why; stranded and idle GPU-hours; faults and lost work.
- **KPIs**:
  - GPU allocation (allocated ÷ healthy GPU-hours)
  - stranded GPU-hours (free GPUs on part-used nodes, too few to fit the smallest waiting pod)
  - allocated-but-idle GPU-hours (gangs waiting for pods, restarts)
  - training jobs started and mean wait
  - batch wait
  - share of time every inference replica was placed
  - preemptions, faults and restarts, work lost to faults
- **GPU grid**: one square per GPU, grouped by node, IB domain and pool, coloured by workload. Hatched squares are held but not running; red squares are faulted. Hover for details; click a node for its breakdown.
- **Timeline**: busy, allocated-idle, stranded and faulted GPUs over time, with allocated + pending demand dashed.
- **Workloads over time**: running in the workload colour; pending as a thin bar coloured by the reason it waits (quota, capacity, fragmentation, topology). Ticks mark faults (red) and preemptions (dark).
- **Compare policies**: runs the cluster with each single policy change and tabulates allocation, stranded and idle GPU-hours, training started and wait, batch wait, inference placement, preemptions and lost work. Click a row to apply it; the KPIs then compare against the configured policy.

On the sample cluster (48 on-prem H100 nodes in two IB domains, 16 neocloud H200 nodes, serving, a 160-GPU pre-training gang, two fine-tunes and evaluation jobs):
- Under **spread** placement, inference and evaluation pods land on every node, so the pre-training job never finds 20 empty nodes in one domain. 2,347 GPU-hours sit stranded and allocation is 38%.
- **Bin-pack** starts it at once and lifts allocation to 61%.
- **Strict FIFO** blocks all three training jobs.

## Importing a real cluster

```bash
kubectl get nodes,pods,clusterqueues,localqueues -A -o json > cluster.json
```

Then **Import kubectl JSON** in the Cluster toolbar reads it as follows:

- **Node pools:** GPU nodes are grouped by pool label (Karpenter, GKE, EKS, AKS or a `pool` label) and GPU product. The IB domain is read from `topology.kubernetes.io/zone` or a topology block label.
- **Queues:** taken from Kueue ClusterQueues, using the nominal GPU quota. LocalQueues map pods to their queue.
- **Workloads:** GPU pods are grouped by JobSet, Kubeflow job, Job or app label. Training is recognised from JobSet or PyTorchJob owners, or from names containing "train", "pretrain" or "finetune". Inference is recognised from Deployments, ReplicaSets or StatefulSets, or from names like "serve", "infer", "vllm" or "triton". Everything else is batch.
- **Priority:** comes from `spec.priority` or the priority class name.

Run times are not in the API: training defaults to 6 h and batch to 1 h, so edit them in the left panel. Only resource requests, labels, owners, priorities and phases are read.
