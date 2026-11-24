// Encode OTLP requests with protobufjs from the official opentelemetry-proto files (fixtures for the decoder tests).
const protobuf = require('protobufjs'), fs = require('fs'), path = require('path');
const root = new protobuf.Root(); root.resolvePath = (o, t) => path.join(__dirname, 'opentelemetry-proto', t);
root.loadSync(['opentelemetry/proto/collector/trace/v1/trace_service.proto', 'opentelemetry/proto/collector/logs/v1/logs_service.proto', 'opentelemetry/proto/collector/metrics/v1/metrics_service.proto']);
const out = process.argv[2], t0 = 1768478400n * 1000000000n, kv = (k, v) => ({ key: k, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : { stringValue: v } });
const hex = h => Buffer.from(h, 'hex');
const reqs = {
  traces: ['opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest', { resourceSpans: [{ resource: { attributes: [kv('service.name', 'vllm-router'), kv('host.name', 'gpu-a01')] }, scopeSpans: [{ scope: { name: 'vllm' }, spans: [
    { traceId: hex('0af7651916cd43dd8448eb211c80319c'), spanId: hex('b7ad6b7169203331'), name: 'llm_request', kind: 2, startTimeUnixNano: (t0).toString(), endTimeUnixNano: (t0 + 1500000000n).toString(), status: { code: 1 },
      attributes: [kv('gen_ai.request.model', 'llama-70b'), kv('gen_ai.usage.prompt_tokens', 900), kv('gen_ai.usage.completion_tokens', 200), kv('gen_ai.latency.time_to_first_token', 0.25), kv('gen_ai.latency.time_in_queue', 0.05), kv('gen_ai.latency.e2e', 1.5), kv('k8s.pod.name', 'vllm-0')] },
    { traceId: hex('0af7651916cd43dd8448eb211c80319c'), spanId: hex('00f067aa0ba902b7'), parentSpanId: hex('b7ad6b7169203331'), name: 'prefill', kind: 1, startTimeUnixNano: (t0 + 50000000n).toString(), endTimeUnixNano: (t0 + 250000000n).toString() }] }] }] }],
  logs: ['opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest', { resourceLogs: [{ resource: { attributes: [kv('k8s.node.name', 'gpu-a02')] }, scopeLogs: [{ logRecords: [
    { timeUnixNano: (t0).toString(), severityNumber: 17, severityText: 'ERROR', body: { stringValue: 'NVRM: Xid (PCI:0000:3b:00): 79, pid=1234, name=python3, GPU has fallen off the bus.' } },
    { timeUnixNano: (t0 + 1000000000n).toString(), body: { stringValue: '[Rank 5] Watchdog caught collective operation timeout: WorkNCCL(SeqNum=77, OpType=ALLREDUCE, NumelIn=1) ran for 600000 milliseconds before timing out.' }, attributes: [kv('k8s.pod.name', 'train-7b-0')] }] }] }] }],
  metrics: ['opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest', { resourceMetrics: [{ resource: { attributes: [kv('host.name', 'gpu-a03')] }, scopeMetrics: [{ metrics: [
    { name: 'DCGM_FI_DEV_GPU_TEMP', gauge: { dataPoints: [{ timeUnixNano: t0.toString(), asDouble: 64, attributes: [kv('gpu', '2'), kv('modelName', 'NVIDIA H100 80GB HBM3')] }] } },
    { name: 'DCGM_FI_DEV_XID_ERRORS', gauge: { dataPoints: [{ timeUnixNano: t0.toString(), asInt: 48, attributes: [kv('gpu', '2'), kv('modelName', 'NVIDIA H100 80GB HBM3')] }] } },
    { name: 'DCGM_FI_DEV_POWER_USAGE', sum: { aggregationTemporality: 2, dataPoints: [{ timeUnixNano: t0.toString(), asDouble: 401.5, attributes: [kv('gpu', '2'), kv('modelName', 'NVIDIA H100 80GB HBM3')] }] } }] }] }] }],
};
for (const [k, [type, obj]] of Object.entries(reqs)) {
  const T = root.lookupType(type);
  fs.writeFileSync(path.join(out, `${k}.pb`), T.encode(T.fromObject(obj)).finish());
}
console.log('encoded', Object.keys(reqs).join(', '));
