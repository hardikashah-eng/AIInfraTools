# GCP fixtures

These fixtures are **not captured from a project**. Each one follows Google's documented formats:

- `gke-nodes.json`: two GKE nodes as `kubectl get nodes -o json` prints them, each with its `gce://` provider ID:
  - an A3 Ultra GPU node with the `cloud.google.com/scheduled-maintenance-time` label
    ([GKE host maintenance](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/handle-disruption-gpu-tpu));
  - a TPU v6e node with `cloud.google.com/gke-tpu-accelerator` and `cloud.google.com/gke-tpu-topology`
    ([Plan TPUs in GKE](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-tpus)).
- `cloud-monitoring.json`: a `timeSeries.list` response, with `int64Value` as a string as the API writes it. It holds
  `kubernetes.io/node/accelerator/*` metrics for two TPU chips and one GPU, plus a CPU metric that the parser ignores
  ([GKE system metrics](https://docs.cloud.google.com/monitoring/api/metrics_kubernetes)).
- `billing-export.jsonl`: Cloud Billing standard usage cost rows. The field names come from the
  [export schema](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage). The
  SKU descriptions follow Google's SKU listings:
  - "Nvidia H100 80GB GPU running in Americas";
  - "TpuV6e running in Americas";
  - "Reserved TpuV5p in Belgium in Calendar Mode";
  - a commitment fee line.

Prices are illustrative, not quotes.
