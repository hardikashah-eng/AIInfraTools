// Disaggregated prefill/decode serving on llm-d: the sizer's P/D plan as a DisaggregatedSet (prefill and decode roles,
// vLLM with NixlConnector moving the KV cache, the llm-d routing sidecar in front of decode) plus values for the llm-d
// router's standalone chart, which schedules each request onto a prefill pod and then a decode pod.
//
// The shape follows llm-d's P/D guide (github.com/llm-d/llm-d, guides/pd-disaggregation, Apache-2.0) at commit
// a3ae49a (November 2026): DisaggregatedSet from LeaderWorkerSet ≥ 0.11.1 with enableDisaggregatedSet, the router
// chart oci://ghcr.io/llm-d/charts/llm-d-router-standalone, InferencePool CRDs from the Gateway API Inference
// Extension, pods selected by the label llm-d.ai/guide = the router's release name.
import { createRequire } from 'node:module';
const REG = createRequire(import.meta.url)('../../inference-sizer/src/accelerators.js');

export const LLMD = {
  ref: 'llm-d/llm-d guides/pd-disaggregation @ a3ae49a',
  lwsVersion: '1.0.0', routerChart: 'oci://ghcr.io/llm-d/charts/llm-d-router-standalone', routerVersion: 'v0',
  sidecar: 'ghcr.io/llm-d/llm-d-router-disagg-sidecar:v1.0.0',
  // the vLLM image the guide validates, per vendor (from the accelerator registry)
  vllm: Object.fromEntries(Object.entries(REG.VENDORS).filter(([, v]) => v.images.llmdVllm).map(([k, v]) => [k, v.images.llmdVllm])),
  crds: { ds: 'disaggregatedsets.disaggregatedset.x-k8s.io', pool: 'inferencepools.inference.networking.k8s.io' },
};

const EPP_CONFIG = `apiVersion: llm-d.ai/v1
kind: EndpointPickerConfig
plugins:
- type: always-disagg-pd-decider
- type: disagg-profile-handler
  parameters:
    deciders:
      prefill: always-disagg-pd-decider
- type: prefill-filter
- type: decode-filter
- type: approx-prefix-cache-producer
- type: inflight-load-producer
- type: token-load-scorer
- type: active-request-scorer
- type: max-score-picker
schedulingProfiles:
- name: prefill
  plugins:
  - pluginRef: prefill-filter
  - pluginRef: token-load-scorer
  - pluginRef: max-score-picker
- name: decode
  plugins:
  - pluginRef: decode-filter
  - pluginRef: active-request-scorer
  - pluginRef: max-score-picker
`;

// p: { name, namespace, model (served id), repo, vendor, gpuResource, image, hfSecret, hfSecretKey, maxLen, gpuMemoryUtilization,
//      kvBufferDevice, kvDtype, prefill: { tp, replicas }, decode: { tp, replicas, maxNumSeqs }, cachePvc }
export function render(p) {
  const kv = role => JSON.stringify({ kv_connector: 'NixlConnector', kv_role: role, kv_buffer_device: p.kvBufferDevice || (REG.VENDORS[p.vendor] || {}).kvBufferDevice || 'cuda', kv_connector_extra_config: { backends: ['UCX'] } });
  const labels = role => ({ 'llm-d.ai/inference-serving': 'true', 'llm-d.ai/guide': p.name, 'llm-d.ai/model': p.model, 'llm-d.ai/role': role, 'llm-d.ai/engine-type': 'vllm',
    app: p.name, 'fleetops.aiinfra/pool': p.name, 'gpu-health.aiinfra/serving': 'true' });
  const env = [{ name: 'VLLM_NIXL_SIDE_CHANNEL_HOST', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }, { name: 'VLLM_HTTP_TIMEOUT_KEEP_ALIVE', value: '120' }, { name: 'HF_HOME', value: '/cache/huggingface' }, { name: 'VLLM_NO_USAGE_STATS', value: '1' }];
  if (p.hfSecret) env.unshift({ name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name: p.hfSecret, key: p.hfSecretKey || 'token' } } });
  const probes = port => ({ startupProbe: { httpGet: { path: '/v1/models', port }, initialDelaySeconds: 15, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 120 },
    livenessProbe: { httpGet: { path: '/health', port }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 }, readinessProbe: { httpGet: { path: '/v1/models', port }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 3 } });
  const gpu = n => ({ [p.gpuResource]: String(n) });
  const vols = [{ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '20Gi' } }, p.cachePvc ? { name: 'cache', persistentVolumeClaim: { claimName: p.cachePvc } } : { name: 'cache', emptyDir: {} }];
  const mounts = [{ name: 'shm', mountPath: '/dev/shm' }, { name: 'cache', mountPath: '/cache' }];
  const args = (role, r) => [p.repo, '--served-model-name', p.model, `--tensor-parallel-size=${r.tp}`, `--max-model-len=${p.maxLen}`, `--gpu-memory-utilization=${p.gpuMemoryUtilization || 0.9}`,
    `--kv-cache-dtype=${p.kvDtype || 'auto'}`, '--block-size=128', '--kv-transfer-config', kv(role === 'prefill' ? 'kv_producer' : 'kv_consumer'), '--shutdown-timeout=45',
    ...(role === 'prefill' ? ['--enable-prefix-caching'] : [`--max-num-seqs=${r.maxNumSeqs}`, '--port=8200']), ...(p.quantization ? ['--quantization', p.quantization] : [])];
  const container = (role, r) => Object.assign({ name: 'modelserver', image: p.image, command: ['vllm', 'serve'], args: args(role, r), env,
    ports: [{ name: 'modelserver', containerPort: role === 'prefill' ? 8000 : 8200, protocol: 'TCP' }, { name: 'nixl', containerPort: 5600, protocol: 'TCP' }],
    resources: { limits: gpu(r.tp), requests: gpu(r.tp) }, volumeMounts: mounts, lifecycle: { preStop: { sleep: { seconds: 15 } } } }, probes('modelserver'));
  const sidecar = { name: 'routing-proxy', image: p.sidecar || LLMD.sidecar, imagePullPolicy: 'IfNotPresent', args: ['--port=8000', '--kv-connector=nixlv2', '--zap-log-level=1', '--secure-serving=false'],
    ports: [{ name: 'sidecar', containerPort: 8000, protocol: 'TCP' }], restartPolicy: 'Always', securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true } };
  const role = (name, r) => ({ name, spec: { replicas: r.replicas, groupIdentity: 'Hash',
    rolloutStrategy: { rollingUpdateConfiguration: { maxSurge: 0, maxUnavailable: 1 } },
    leaderWorkerTemplate: { size: 1, workerTemplate: { metadata: { labels: labels(name), annotations: { 'prometheus.io/scrape': 'true', 'prometheus.io/port': name === 'prefill' ? '8000' : '8200', 'prometheus.io/path': '/metrics' } },
      spec: Object.assign({ serviceAccountName: p.name, terminationGracePeriodSeconds: 75, containers: [container(name, r)], volumes: vols }, name === 'decode' ? { initContainers: [sidecar] } : {}) } } } });
  const docs = [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: p.name, namespace: p.namespace }, automountServiceAccountToken: false },
    { apiVersion: 'disaggregatedset.x-k8s.io/v1', kind: 'DisaggregatedSet', metadata: { name: p.name, namespace: p.namespace, labels: { 'llm-d.ai/guide': p.name, app: p.name, 'fleetops.aiinfra/pool': p.name } },
      spec: { slices: 1, roles: [role('prefill', p.prefill), role('decode', p.decode)] } },
  ];
  // router values: the llm-d base values and the P/D guide's, merged, with the guide label pointing at this deployment
  const routerValues = { router: {
    extraServicePorts: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 8081 }],
    epp: { replicas: 1, flags: { v: 2 }, pluginsConfigFile: 'pd-config.yaml', pluginsCustomConfig: { 'pd-config.yaml': EPP_CONFIG }, resources: { requests: { cpu: '4', memory: '8Gi' }, limits: { memory: '16Gi' } } },
    inferencePool: { failureMode: 'FailOpen' },
    modelServers: { protocol: 'http', matchLabels: { 'llm-d.ai/guide': p.name } },
    proxy: { proxyType: 'envoy', args: ['--service-node', 'envoy-sidecar', '--log-level', 'warn', '--concurrency', '8', '--drain-strategy', 'immediate', '--drain-time-s', '60', '-c', '/etc/envoy/envoy.yaml'], resources: { requests: { cpu: '4', memory: '8Gi' }, limits: { memory: '16Gi' } } },
  } };
  return { docs, routerValues, service: `${p.name}-epp`, servicePort: 80 };
}

// What has to be on the cluster first, as commands (run by install-serving.sh --install-prereqs, or by hand).
export function prereqs({ gaieVersion = 'latest', lwsVersion = LLMD.lwsVersion } = {}) {
  const gaie = gaieVersion === 'latest' ? 'releases/latest/download' : `releases/download/${gaieVersion}`;
  return [
    ['helm', 'upgrade', '--install', 'lws', 'oci://registry.k8s.io/lws/charts/lws', `--version=${lwsVersion}`, '--namespace', 'lws-system', '--create-namespace', '--set', 'enableDisaggregatedSet=true', '--wait', '--timeout', '300s'],
    ['kubectl', 'apply', '-f', `https://github.com/kubernetes-sigs/gateway-api-inference-extension/${gaie}/v1-manifests.yaml`],
  ];
}
