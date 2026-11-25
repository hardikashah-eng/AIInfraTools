# AWS fixtures

These fixtures are **not captured from an account**. Each one is built from AWS's documented formats:

- `efa-hw-counters-*.txt`: the EFA `hw_counters` names, in the sysfs layout shown in
  [Monitor an Elastic Fabric Adapter](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/efa-working-monitor.html).
  Two devices are included; one of them shows SRD retransmits, retransmit timeouts, impaired connections and RDMA
  errors.
- `eks-nodes.json`: three nodes as `kubectl get nodes -o json` prints them, with `spec.providerID`, the instance-type
  label, and three conditions:
  - the EKS node monitoring agent's `AcceleratedHardwareReady=False`, with reason `NvidiaXID79Error`;
  - a node-problem-detector condition (`KernelDeadlock=True`);
  - a healthy node.
  See [EKS node health](https://docs.aws.amazon.com/eks/latest/userguide/node-health.html).
- `cur2.csv`: a CUR 2.0 data export (hourly, with resource IDs). Column names come from the
  [CUR 2.0 data dictionary](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html). It holds:
  - a Savings Plan hour;
  - a Spot hour;
  - half an hour of g6e;
  - a Trainium hour (not a GPU in the registry);
  - lines that should be skipped: CPU, S3 and tax.
- `cur-legacy.csv`: the legacy CUR layout (`lineItem/…`, `resourceTags/user:team`) with one Reserved Instance day.

Prices are illustrative, not quotes.
