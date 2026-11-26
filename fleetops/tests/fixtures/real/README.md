# Real data used by the tests

These files are real measurements or real tool output, kept small so the tests run in CI without downloads. Each test
that uses them says what it checks.

| File | What it is | Source | License |
| --- | --- | --- | --- |
| `philly-job-log-2017-11-07-15.json.gz` | Every Philly job with an attempt between 7 and 16 Nov 2017 (16,062 jobs), as in `cluster_job_log` | [msr-fiddle/philly-traces](https://github.com/msr-fiddle/philly-traces) (Jeon et al., ATC '19) | CC BY 4.0 |
| `philly-machine-list.csv` | Philly `cluster_machine_list` (552 machines) | same | CC BY 4.0 |
| `sysfs-infiniband-counters.txt` | `/sys/class/infiniband/*/ports/*/{counters,hw_counters}/*` from hosts with mlx4, mlx5 and hfi1 adapters, as `grep -H .` prints them | [prometheus/procfs](https://github.com/prometheus/procfs) `testdata/fixtures.ttar` | Apache-2.0 |
| `nfs-mountstats.txt` | `/proc/<pid>/mountstats` with an NFSv4 mount (`statvers=1.1`, 8-field per-op lines, a wrapped 64-bit queue time on ACCESS) | same | Apache-2.0 |
| `lustre/lustrefs-OST0000/job_stats`, `lustre/lustrefs-MDT0000/job_stats` | `/proc/fs/lustre/{obdfilter,mdt}/*/job_stats` from a Lustre 2.10 server (bytes and counts, no latency) | [HewlettPackard/lustre_exporter](https://github.com/HewlettPackard/lustre_exporter) | Apache-2.0 |
| `mlx5-ethtool-counter-names.txt` | The counter names the mlx5 driver documents for `ethtool -S` | Linux `Documentation/networking/device_drivers/ethernet/mellanox/mlx5/counters.rst` | GPL-2.0 (names only) |
| `zeus/summary_power_{a40,v100,p100,rtx6000}.csv` | Epoch time and average power of 6 training workloads at every power limit, on 4 GPU types (1,609 runs) | [ml-energy/zeus](https://github.com/ml-energy/zeus) `examples/research_reproducibility/zeus_nsdi23/trace` (You et al., NSDI '23) | Apache-2.0 |
| `llm-d/pd-disaggregation.disaggregatedset.yaml`, `llm-d/pd-disaggregation.router.values.yaml`, `llm-d/router.base.values.yaml` | llm-d's P/D guide for NVIDIA GPUs and vLLM: the DisaggregatedSet, and the router values it layers on the base | [llm-d/llm-d](https://github.com/llm-d/llm-d) `guides/` at a3ae49a | Apache-2.0 |
| `llm-d/disaggregatedset.crd-v1.schema.json.gz` | The v1 `openAPIV3Schema` of the DisaggregatedSet CRD, as JSON | [kubernetes-sigs/lws](https://github.com/kubernetes-sigs/lws) v1.0.0 `config/crd/bases` | Apache-2.0 |
| `llm-d/inferencepool.crd-v1.schema.json.gz` | The v1 schema of the InferencePool CRD | [kubernetes-sigs/gateway-api-inference-extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) `config/crd/bases` (main, Nov 2026) | Apache-2.0 |
| `rollouts/argo-rollouts-analysistemplate.crd-v1alpha1.schema.json.gz`, `rollouts/argo-rollouts-rollout.crd-v1alpha1.schema.json.gz` | The `openAPIV3Schema` of the AnalysisTemplate and Rollout CRDs, as JSON | [argoproj/argo-rollouts](https://github.com/argoproj/argo-rollouts) v1.9.3 `manifests/crds` | Apache-2.0 |
| `rollouts/flagger-canary.crd-v1beta1.schema.json.gz` | The v1beta1 schema of Flagger's Canary CRD | [fluxcd/flagger](https://github.com/fluxcd/flagger) v1.45.0 `artifacts/flagger/crd.yaml` | Apache-2.0 |
| `rollouts/prometheus-operator-podmonitor.crd-v1.schema.json.gz` | The v1 schema of the PodMonitor CRD | [prometheus-operator/prometheus-operator](https://github.com/prometheus-operator/prometheus-operator) v0.95.2 `example/prometheus-operator-crd` | Apache-2.0 |
| `vllm/metric-names.txt` | vLLM's Prometheus metric names (v1 engine) with the suffixes the client library adds, and the `finished_reason` values | [vllm-project/vllm](https://github.com/vllm-project/vllm) `vllm/v1/metrics/loggers.py` at 43108ff | Apache-2.0 (names only) |

`tools/fetch-public-data.sh` downloads the full Philly traces for larger runs.
