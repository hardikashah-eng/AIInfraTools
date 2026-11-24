// Serving: what fits, how much it carries, and a one-command deployment of vLLM on Kubernetes.
//
//   fit       hardware (+ workload) → catalog models that fit, ranked          (Inference Sizer, the other way round)
//   capacity  a model on hardware → max request rate, concurrency, prompt length
//   deploy    model + hardware (+ rate) → layout → manifests → apply → wait → smoke test → registered with fleetops
//
// Deployments are vLLM's OpenAI server: a Deployment when an instance fits on one node, a LeaderWorkerSet when it
// spans nodes (vLLM's own multi-node recipe: tensor parallel inside a node, pipeline parallel across nodes). The
// Service selects gpu-health.aiinfra/serving=true, so gpu-health's and the live agent's drain actions work on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as LLMD from './llmd.mjs';

const require = createRequire(import.meta.url);
const SC = require('../../inference-sizer/src/catalog.js'), SM = require('../../inference-sizer/src/model.js'), FIT = require('../../inference-sizer/src/fit.js');

// Models whose published weights are already quantized (no --quantization flag needed for the sizer's precision).
const NATIVE_LOWP = new Set(['deepseek-v3', 'kimi-k2', 'gpt-oss-120b']);
const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;
export const hfRepo = m => { const x = String(m.source || '').match(/huggingface\.co\/([^/?#]+\/[^/?#]+)/); return x ? x[1] : null; };
export const models = () => SC.MODELS.map(m => ({ id: m.id, name: m.name, params: m.total, active: m.active, maxCtx: m.maxCtx, hf: hfRepo(m), wprec: m.wprec }));
export const gpus = () => SC.GPUS.map(g => ({ id: g.id, label: g.label, vendor: g.vendor, hbmGB: g.hbmGB, perNode: g.domain, price: g.price }));

// A workload measured from the store: token sizes and the p99 request rate over 5-minute windows of a pool.
export function workloadFromStore(store, pool, { from, to }) {
  const rq = store.query('request', { from, to, where: r => r.pool === pool && r.isl > 0 && r.osl > 0 });
  if (rq.length < 50) return null;
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
  const bins = new Map();
  for (const r of rq) { const k = Math.floor(r.t / 300); bins.set(k, (bins.get(k) || 0) + 1); }
  return { isl: q(rq.map(r => r.isl), 0.5), islP99: q(rq.map(r => r.isl), 0.99), osl: q(rq.map(r => r.osl), 0.5), oslP99: q(rq.map(r => r.osl), 0.99), rate: q([...bins.values()], 0.99) / 300, requests: rq.length, source: `measured: ${rq.length} requests of ${pool}` };
}

// ---------- the deployment ----------
// opts: { model, gpu, nodes?|gpus?, rate?, isl, osl, islP99?, oslP99?, ttftS, tpotS, name, namespace, image, hfSecret,
//         cachePvc, maxModelLen, autoscale, prometheus, gpusPerNode, weights: 'fp8'|'bf16', createNamespace }
export function planDeployment(opts) {
  const m = SC.MODELS.find(x => x.id === opts.model), g = SC.GPUS.find(x => x.id === opts.gpu);
  if (!m) throw new Error(`unknown model ${opts.model} (fleetops serving models)`);
  if (!g) throw new Error(`unknown GPU ${opts.gpu}; known: ${SC.GPUS.map(x => x.id).join(', ')}`);
  const name = opts.name || m.id.replace(/[^a-z0-9-]/g, '-');
  if (!NAME_RE.test(name)) throw new Error(`name must be a DNS label (lowercase letters, digits, -): ${name}`);
  const ns = opts.namespace || 'serving';
  if (!NAME_RE.test(ns)) throw new Error(`namespace must be a DNS label: ${ns}`);
  const per = opts.gpusPerNode || g.domain, hw = opts.nodes != null ? { gpu: g.id, nodes: +opts.nodes, gpusPerNode: per } : opts.gpus != null ? { gpu: g.id, gpus: +opts.gpus, gpusPerNode: per, nodes: Math.floor(+opts.gpus / per) || undefined } : null;
  const wl = { isl: opts.isl || 2000, osl: opts.osl || 400, islP99: opts.islP99, oslP99: opts.oslP99, rate: opts.rate };
  const tg = { ttftS: opts.ttftS || 2, tpotS: opts.tpotS || 0.05 };
  const wprec = opts.weights || m.wprec || 'fp8';
  // mode: agg (one vLLM per instance), disagg (prefill and decode pools on llm-d), auto (whichever the sizer finds smaller)
  const mode = opts.mode || 'agg';
  if (!['agg', 'disagg', 'auto'].includes(mode)) throw new Error('--mode agg | disagg | auto');
  let autoNote = null;
  if (mode !== 'agg') {
    const sizeAs = md => {
      if (wl.rate) { const s = FIT.settings(m, hw || { gpu: g.id, gpusPerNode: per }, wl, tg, { wprec, mode: md }), p = SM.plan(s, { noSens: true }); return p.chosen ? { lay: FIT.layout(p), nodes: p.chosen.totalNodes, gpus: p.chosen.gpus, rate: wl.rate, fits: !(hw && hw.nodes && p.chosen.totalNodes > hw.nodes) } : null; }
      if (!hw) throw new Error('give --rate (req/s to serve) or the hardware to fill (--nodes N or --gpus N)');
      const c = FIT.maxRate(m, hw, wl, tg, { profile: 'production', extra: { wprec, mode: md } }); return c.rate ? { lay: c.layout, nodes: c.nodes, gpus: c.gpus, rate: c.rate, fits: true } : null;
    };
    const dis = sizeAs('disagg'), agg = mode === 'auto' ? sizeAs('agg') : null;
    const better = !agg || !agg.fits ? !!(dis && dis.fits) : dis && dis.fits && (wl.rate ? dis.nodes < agg.nodes : dis.rate > agg.rate * 1.05);
    if (mode === 'disagg' && !(dis && dis.fits)) throw new Error(`no disaggregated layout of ${m.id} on ${g.id} meets the targets${wl.rate ? ` at ${wl.rate} req/s${hw && hw.nodes ? ` on ${hw.nodes} node(s)` : ''}` : ` on that hardware`}`);
    // auto falls back to aggregated when a P/D role would span nodes (not rendered yet); disagg says so
    const fitsNode = dis && dis.lay && dis.lay.prefill && dis.lay.prefill.gpusPerInstance <= per && dis.lay.decode.gpusPerInstance <= per;
    if (better && (fitsNode || mode === 'disagg')) return planDisagg({ m, g, per, wl, tg, wprec, dis, agg, opts, name, ns });
    if (better && !fitsNode) autoNote = 'auto: disaggregated would be smaller, but a role spans nodes (not rendered yet), so this deploys aggregated serving.';
  }
  // deployments are aggregated (one vLLM per instance); the sizer still says when disaggregation would be smaller
  const extra = { wprec, mode: 'agg' };
  let lay, sized, notes = [];
  if (mode === 'auto') notes.push(autoNote || 'auto: the sizer found aggregated serving as small as disaggregated, so this deploys aggregated serving.');
  if (wl.rate) {
    const s = FIT.settings(m, hw || { gpu: g.id, gpusPerNode: per }, wl, tg, extra), p = SM.plan(s, { noSens: true });
    if (!p.chosen) throw new Error(`no layout of ${m.id} on ${g.id} meets TTFT ${tg.ttftS}s / TPOT ${tg.tpotS}s at ${wl.rate} req/s (${((p.agg.rows || []).find(r => r.why) || {}).why || 'see the Inference Sizer'})`);
    if (hw && hw.nodes && p.chosen.totalNodes > hw.nodes) throw new Error(`${wl.rate} req/s needs ${p.chosen.totalNodes} ${g.id} nodes (with the N+1 spare); you have ${hw.nodes}. Lower the rate, or see what fits: fleetops serving capacity --model ${m.id} --gpu ${g.id} --nodes ${hw.nodes}`);
    lay = FIT.layout(p); sized = { basis: `sized for ${wl.rate} req/s`, nodes: p.chosen.totalNodes, gpus: p.chosen.gpus, rate: wl.rate };
    const auto = SM.plan(Object.assign({}, s, { mode: 'auto' }), { noSens: true });
    if (mode === 'agg' && auto.chosen && auto.chosen.mode === 'disagg') notes.push(`The sizer would use disaggregated prefill/decode (${auto.chosen.totalNodes} nodes against ${p.chosen.totalNodes}): --mode disagg deploys it on llm-d.`);
  } else {
    if (!hw) throw new Error('give --rate (req/s to serve) or the hardware to fill (--nodes N or --gpus N)');
    const c = FIT.maxRate(m, hw, wl, tg, { profile: 'production', extra });
    if (!c.rate) throw new Error(`${m.id} doesn't fit on ${hw.nodes || hw.gpus} ${g.id} ${hw.nodes ? 'node(s)' : 'GPU(s)'} within the targets: ${c.why}`);
    lay = c.layout; sized = { basis: `all of ${hw.nodes ? `${hw.nodes} node(s)` : `${hw.gpus} GPUs`}: up to ${c.rate.toFixed(1)} req/s within the targets`, nodes: c.nodes, gpus: c.gpus, rate: c.rate };
  }
  const tpp = lay.tp * lay.pp, multiNode = tpp > per, nodesPer = multiNode ? Math.ceil(tpp / per) : 1;
  if (multiNode && !(lay.tp === per && lay.pp === nodesPer)) notes.push(`Rendered as TP${per} × PP${nodesPer} across ${nodesPer} nodes (vLLM's multi-node recipe); the sizer modelled ${lay.label || `TP${lay.tp} × PP${lay.pp}`}, so measured throughput can differ.`);
  const repo = opts.hf || hfRepo(m);
  if (!repo) throw new Error(`no Hugging Face repo for ${m.id}; pass --hf ORG/NAME`);
  // the context the sizer planned memory for (its default 32K, or the workload's p99 prompt + output if longer)
  const maxLen = opts.maxModelLen || Math.min(m.maxCtx || 131072, Math.max(SM.SETTINGS.ctx, (wl.islP99 || wl.isl * 4) + (wl.oslP99 || wl.osl * 4)));
  const seqs = Math.max(8, Math.ceil(lay.concurrency / lay.instances * 1.25 / 8) * 8);
  const vendor = (g.vendor || '').toUpperCase() === 'AMD' ? 'amd' : 'nvidia';
  const image = opts.image || (vendor === 'amd' ? 'rocm/vllm:latest' : 'vllm/vllm-openai:latest');
  if (!opts.image) notes.push(`Image ${image} is a moving tag: pin a version (--image ${vendor === 'amd' ? 'rocm/vllm' : 'vllm/vllm-openai'}:vX.Y.Z) for production.`);
  const args = [repo, '--served-model-name', m.id, '--port', '8000', '--tensor-parallel-size', String(multiNode ? per : lay.tp), '--max-model-len', String(maxLen),
    '--gpu-memory-utilization', String(opts.gpuMemoryUtilization || 0.9), '--max-num-seqs', String(seqs), '--kv-cache-dtype', opts.kvDtype || 'fp8', '--enable-prefix-caching'];
  if (multiNode || lay.pp > 1) args.push('--pipeline-parallel-size', String(multiNode ? nodesPer : lay.pp));
  // fp8: vLLM quantizes bf16 weights at load time. fp4 only comes from a checkpoint published in fp4 (--hf).
  if (wprec === 'fp8' && !NATIVE_LOWP.has(m.id) && !/fp8/i.test(repo)) args.push('--quantization', 'fp8');
  if (wprec === 'fp4' && !NATIVE_LOWP.has(m.id) && !opts.hf) notes.push(`The plan assumes fp4 weights: pass --hf with an fp4 checkpoint of ${m.id}, or --weights fp8 to re-plan.`);
  if (m.experts > 0 && multiNode) args.push('--enable-expert-parallel');
  const gpuRes = vendor === 'amd' ? 'amd.com/gpu' : 'nvidia.com/gpu', perPod = multiNode ? per : tpp;
  const labels = { app: name, 'fleetops.aiinfra/pool': name, 'gpu-health.aiinfra/serving': 'true' };
  const env = [{ name: 'HF_HOME', value: '/cache/huggingface' }, { name: 'VLLM_NO_USAGE_STATS', value: '1' }];
  if (opts.hfSecret) env.push({ name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name: opts.hfSecret, key: opts.hfSecretKey || 'token' } } });
  const volumes = [{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '16Gi' } }, opts.cachePvc ? { name: 'cache', persistentVolumeClaim: { claimName: opts.cachePvc } } : { name: 'cache', emptyDir: {} }];
  const mounts = [{ name: 'dshm', mountPath: '/dev/shm' }, { name: 'cache', mountPath: '/cache' }];
  const probe = (p, extra) => Object.assign({ httpGet: { path: '/health', port: 8000 } }, extra);
  const container = (role, cmdArgs, withPort) => ({
    name: role, image, imagePullPolicy: 'IfNotPresent', command: ['vllm', 'serve'], args: cmdArgs, env, volumeMounts: mounts,
    resources: { limits: { [gpuRes]: String(perPod) }, requests: { [gpuRes]: String(perPod) } },
    securityContext: { allowPrivilegeEscalation: false },
    ...(withPort ? { ports: [{ name: 'http', containerPort: 8000 }],
      // loading weights can take many minutes: startup gets up to 40 minutes before liveness starts
      startupProbe: probe(8000, { periodSeconds: 10, failureThreshold: 240 }), readinessProbe: probe(8000, { periodSeconds: 10 }), livenessProbe: probe(8000, { periodSeconds: 20, failureThreshold: 6 }) } : {}),
  });
  const annotations = { 'prometheus.io/scrape': 'true', 'prometheus.io/port': '8000', 'prometheus.io/path': '/metrics' };
  const spec = Object.assign({ volumes, terminationGracePeriodSeconds: 60 }, opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {});
  const docs = [];
  if (opts.createNamespace) docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  let workload;
  if (!multiNode) {
    workload = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels },
      spec: { replicas: lay.instances, selector: { matchLabels: { app: name } }, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
        template: { metadata: { labels, annotations }, spec: Object.assign({ containers: [container('vllm', args, true)] }, spec) } } };
  } else {
    // vLLM's multi-node recipe on LeaderWorkerSet: the leader serves, workers run headless
    const mn = ['--nnodes', '$(LWS_GROUP_SIZE)', '--node-rank', '$(LWS_WORKER_INDEX)', '--master-addr', '$(LWS_LEADER_ADDRESS)'];
    workload = { apiVersion: 'leaderworkerset.x-k8s.io/v1', kind: 'LeaderWorkerSet', metadata: { name, namespace: ns, labels },
      spec: { replicas: lay.instances, leaderWorkerTemplate: { size: nodesPer, restartPolicy: 'RecreateGroupOnPodRestart',
        leaderTemplate: { metadata: { labels: Object.assign({ role: 'leader' }, labels), annotations }, spec: Object.assign({ containers: [container('vllm-leader', args.concat(mn), true)] }, spec) },
        workerTemplate: { metadata: { labels: { app: name, role: 'worker' } }, spec: Object.assign({ containers: [container('vllm-worker', args.filter((a, i, all) => !(a === '--port' || all[i - 1] === '--port')).concat(mn, ['--headless']), false)] }, spec) } } } };
  }
  docs.push(workload);
  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels: { app: name } },
    spec: { selector: Object.assign({ app: name, 'gpu-health.aiinfra/serving': 'true' }, multiNode ? { role: 'leader' } : {}), ports: [{ name: 'http', port: 8000, targetPort: 8000 }], type: 'ClusterIP' } });
  if (opts.autoscale) {
    const min = Math.max(1, opts.minReplicas || Math.ceil(lay.instances / 4)), max = Math.max(min, opts.maxReplicas || lay.instances);
    docs.push({ apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: { name, namespace: ns },
      spec: { scaleTargetRef: { apiVersion: workload.apiVersion, kind: workload.kind, name }, minReplicaCount: min, maxReplicaCount: max, cooldownPeriod: 600, pollingInterval: 30,
        // requests waiting per replica: scale before TTFT grows, not on CPU
        triggers: [{ type: 'prometheus', metadata: { serverAddress: opts.prometheus || 'http://prometheus.monitoring:9090', query: `sum(vllm:num_requests_waiting{model_name="${m.id}"})`, threshold: String(opts.waitingPerReplica || 4) } }] } });
    notes.push(`Autoscaling between ${min} and ${max} instance(s) on requests waiting (KEDA; Prometheus at ${opts.prometheus || 'http://prometheus.monitoring:9090'}).`);
  }
  if (!opts.cachePvc) notes.push('Weights download into an emptyDir on every start: give --cache-pvc NAME (ReadWriteMany) to keep them.');
  if (!opts.hfSecret) notes.push(`No --hf-secret: gated models (${repo}) need a Hugging Face token in a Secret (kubectl -n ${ns} create secret generic hf-token --from-literal=token=…).`);
  const totalGpus = lay.instances * tpp;
  return {
    name, namespace: ns, model: m.id, hf: repo, hfSecretName: opts.hfSecret || null, gpu: g.id, vendor, image, kind: workload.kind, multiNode, nodesPerInstance: nodesPer,
    layout: { tp: lay.tp, pp: lay.pp, instances: lay.instances, gpusPerInstance: tpp, gpus: totalGpus, concurrency: lay.concurrency, maxNumSeqs: seqs, maxModelLen: maxLen },
    sized, targets: tg, workload: wl, notes, docs, yaml: docs.map(x => toYaml(x)).join('---\n'),
    pool: { [name]: { model: m.id, gpu: g.id, gpus: totalGpus, namespace: ns } }, poolTargets: { [name]: { ttftP99: tg.ttftS, tpotP99: tg.tpotS } },
    needs: { gpus: totalGpus, perPod, lws: multiNode, keda: !!opts.autoscale, gpuResource: gpuRes },
  };
}

// Disaggregated: prefill and decode pools from the sizer's P/D plan, rendered for llm-d (src/llmd.mjs).
function planDisagg({ m, g, per, wl, tg, wprec, dis, agg, opts, name, ns }) {
  const L = dis.lay, P = L.prefill, D = L.decode, notes = [];
  for (const [k, r] of [['prefill', P], ['decode', D]]) if (r.gpusPerInstance > per) throw new Error(`the ${k} instances need ${r.gpusPerInstance} GPUs, more than a node's ${per}: multi-node P/D roles are not rendered yet; use --mode agg`);
  if (P.pp > 1 || D.pp > 1) notes.push('The sizer used pipeline parallelism in a role; rendered as tensor parallelism over the same GPUs.');
  const repo = opts.hf || hfRepo(m); if (!repo) throw new Error(`no Hugging Face repo for ${m.id}; pass --hf ORG/NAME`);
  const vendor = (g.vendor || '').toUpperCase() === 'AMD' ? 'amd' : 'nvidia', gpuRes = vendor === 'amd' ? 'amd.com/gpu' : 'nvidia.com/gpu';
  const maxLen = opts.maxModelLen || Math.min(m.maxCtx || 131072, Math.max(SM.SETTINGS.ctx, (wl.islP99 || wl.isl * 4) + (wl.oslP99 || wl.osl * 4)));
  const seqs = Math.max(8, Math.ceil(L.concurrency / D.instances * 1.25 / 8) * 8);
  const quantization = wprec === 'fp8' && !NATIVE_LOWP.has(m.id) && !/fp8/i.test(repo) ? 'fp8' : null;
  const r = LLMD.render({ name, namespace: ns, model: m.id, repo, vendor, gpuResource: gpuRes, image: opts.image || LLMD.LLMD.vllm[vendor], hfSecret: opts.hfSecret, hfSecretKey: opts.hfSecretKey,
    maxLen, gpuMemoryUtilization: opts.gpuMemoryUtilization, kvDtype: opts.kvDtype || 'fp8', quantization, cachePvc: opts.cachePvc, sidecar: opts.sidecarImage,
    prefill: { tp: P.gpusPerInstance, replicas: P.instances }, decode: { tp: D.gpusPerInstance, replicas: D.instances, maxNumSeqs: seqs } });
  if (!opts.image) notes.push(`Image ${LLMD.LLMD.vllm[vendor]} is the vLLM release llm-d's P/D guide validates (${LLMD.LLMD.ref}).`);
  notes.push('NIXL moves the KV cache over UCX: RDMA (InfiniBand, RoCE, EFA) between the prefill and decode nodes is strongly recommended; over TCP it works but slowly.');
  notes.push('The router\'s prefix-cache affinity gate is left out: calibrate peakPrefillThroughput for this model and GPU (llm-d guides/recipes/router/calibration) and add it.');
  if (agg) notes.push(`auto: disaggregated ${wl.rate ? `needs ${dis.nodes} node(s) against ${agg.nodes} aggregated` : `carries ${dis.rate.toFixed(1)} req/s against ${agg.rate.toFixed(1)} aggregated`}.`);
  if (!opts.cachePvc) notes.push('Weights download into an emptyDir on every start: give --cache-pvc NAME (ReadWriteMany) to keep them.');
  if (!opts.hfSecret) notes.push(`No --hf-secret: gated models (${repo}) need a Hugging Face token in a Secret.`);
  const gpus = P.instances * P.gpusPerInstance + D.instances * D.gpusPerInstance, routerYaml = toYaml(r.routerValues);
  return {
    name, namespace: ns, model: m.id, hf: repo, hfSecretName: opts.hfSecret || null, gpu: g.id, vendor, image: opts.image || LLMD.LLMD.vllm[vendor], kind: 'DisaggregatedSet', mode: 'disagg', multiNode: false, nodesPerInstance: 1,
    layout: { mode: 'disagg', prefill: { tp: P.gpusPerInstance, instances: P.instances }, decode: { tp: D.gpusPerInstance, instances: D.instances, maxNumSeqs: seqs }, gpus, concurrency: L.concurrency, maxModelLen: maxLen, instances: P.instances + D.instances },
    sized: { basis: dis.rate && !wl.rate ? `all of the hardware: up to ${dis.rate.toFixed(1)} req/s within the targets` : `sized for ${wl.rate} req/s`, nodes: dis.nodes, gpus: dis.gpus, rate: dis.rate }, targets: tg, workload: wl, notes,
    docs: r.docs, yaml: r.docs.map(x => toYaml(x)).join('---\n'), router: { chart: LLMD.LLMD.routerChart, version: opts.routerVersion || LLMD.LLMD.routerVersion, release: name, values: r.routerValues, yaml: routerYaml }, service: r.service, servicePort: r.servicePort,
    pool: { [name]: { model: m.id, gpu: g.id, gpus, namespace: ns, mode: 'disagg' } }, poolTargets: { [name]: { ttftP99: tg.ttftS, tpotP99: tg.tpotS } },
    needs: { gpus, gpuResource: gpuRes, pods: [...Array(P.instances).fill(P.gpusPerInstance), ...Array(D.instances).fill(D.gpusPerInstance)], disagg: true, perPod: Math.max(P.gpusPerInstance, D.gpusPerInstance) },
    prereqs: LLMD.prereqs({ gaieVersion: opts.gaieVersion }),
  };
}

// Minimal YAML for the manifests above (maps, lists, strings, numbers, booleans; strings quoted when they need it).
export function toYaml(o, ind = 0) {
  const pad = ' '.repeat(ind), q = s => (/^[\w./:@-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(s) && !/^[-:?@]/.test(s) ? s : JSON.stringify(s));
  const scalar = v => (typeof v === 'string' ? q(v) : v === null ? 'null' : String(v));
  if (Array.isArray(o)) return o.map(v => (v !== null && typeof v === 'object' ? `${pad}-${toYaml(v, ind + 2).replace(/^\s+/, ' ')}` : `${pad}- ${scalar(v)}\n`)).join('');
  return Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => {
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v) && !v.length) return `${pad}${q(k)}: []\n`;
      if (!Array.isArray(v) && !Object.keys(v).length) return `${pad}${q(k)}: {}\n`;
      return `${pad}${q(k)}:\n${toYaml(v, ind + 2)}`;
    }
    if (typeof v === 'string' && v.includes('\n')) return `${pad}${q(k)}: |\n${v.replace(/\n$/, '').split('\n').map(l => (l ? `${pad}  ${l}` : '')).join('\n')}\n`;
    return `${pad}${q(k)}: ${scalar(v)}\n`;
  }).join('');
}

// ---------- applying it ----------
// runner(argv, { input }) → { code, out, err }: kubectl, real or not (tests)
export const kubectl = (argv, { input } = {}) => { const r = spawnSync('kubectl', argv, { input, encoding: 'utf8', maxBuffer: 64 << 20 }); return { code: r.error ? 127 : r.status, out: r.stdout || '', err: r.stderr || (r.error ? r.error.message : '') }; };

// What the cluster has: GPUs per node of the resource, CRDs, the secret.
export function preflight(d, { runner = kubectl, helm = helmRun } = {}) {
  const checks = [], ok = (name, pass, detail) => checks.push({ name, pass, detail });
  const ctx = runner(['config', 'current-context']);
  ok('kubectl context', ctx.code === 0, ctx.code === 0 ? ctx.out.trim() : (ctx.err || 'kubectl not found').trim());
  if (ctx.code !== 0) return { ready: false, checks };
  const nodes = runner(['get', 'nodes', '-o', 'json']);
  if (nodes.code === 0) {
    const items = JSON.parse(nodes.out).items || [];
    const per = items.map(n => ({ name: n.metadata.name, gpus: +((n.status.allocatable || {})[d.needs.gpuResource] || 0), product: (n.metadata.labels || {})['nvidia.com/gpu.product'] || (n.metadata.labels || {})['amd.com/gpu.product-name'] || '', ready: (n.status.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'), cordoned: !!(n.spec || {}).unschedulable }));
    const usable = per.filter(n => n.ready && !n.cordoned && n.gpus >= (d.needs.pods ? Math.min(...d.needs.pods) : d.needs.perPod));
    let fitPods, podsNeeded;
    if (d.needs.pods) {
      // prefill and decode pods of different sizes: first fit, largest first, on allocatable GPUs
      const free = usable.map(n => n.gpus).sort((a, b) => b - a), pods = d.needs.pods.slice().sort((a, b) => b - a); fitPods = 0; podsNeeded = pods.length;
      for (const g of pods) { const i = free.findIndex(f => f >= g); if (i >= 0) { free[i] -= g; fitPods++; } }
    } else { fitPods = usable.reduce((t, n) => t + Math.floor(n.gpus / d.needs.perPod), 0); podsNeeded = d.layout.instances * d.nodesPerInstance; }
    ok(`GPU nodes (${d.needs.gpuResource}${d.needs.pods ? `: ${podsNeeded} pods of ${[...new Set(d.needs.pods)].join(' and ')} GPUs` : ` ≥ ${d.needs.perPod} per pod`})`, fitPods >= podsNeeded, `${usable.length} usable node(s) fit ${fitPods} pod(s); this needs ${podsNeeded}${usable.length ? `; GPUs: ${[...new Set(usable.map(n => n.product).filter(Boolean))].join(', ') || 'unlabelled'}` : ''} (allocatable, not counting what is already running)`);
    const wrongGpu = usable.length && usable.every(n => n.product) && !usable.some(n => n.product.toUpperCase().includes(d.gpu.split('-')[0].toUpperCase()));
    if (wrongGpu) ok(`GPU type ${d.gpu}`, false, `the GPU nodes report ${[...new Set(usable.map(n => n.product))].join(', ')}; the plan assumed ${d.gpu}: re-plan with --gpu`);
  } else ok('list nodes', false, nodes.err.trim());
  if (d.needs.lws) { const r = runner(['get', 'crd', 'leaderworkersets.leaderworkerset.x-k8s.io']); ok('LeaderWorkerSet installed', r.code === 0, r.code === 0 ? 'yes' : 'kubectl apply --server-side -f https://github.com/kubernetes-sigs/lws/releases/latest/download/manifests.yaml'); }
  if (d.needs.disagg) {
    const ds = runner(['get', 'crd', LLMD.LLMD.crds.ds]); ok('DisaggregatedSet (LeaderWorkerSet ≥ 0.11.1)', ds.code === 0, ds.code === 0 ? 'yes' : `helm upgrade --install lws oci://registry.k8s.io/lws/charts/lws --version=${LLMD.LLMD.lwsVersion} -n lws-system --create-namespace --set enableDisaggregatedSet=true (or install-serving.sh --install-prereqs)`);
    const ip = runner(['get', 'crd', LLMD.LLMD.crds.pool]); ok('InferencePool (Gateway API Inference Extension)', ip.code === 0, ip.code === 0 ? 'yes' : 'kubectl apply -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/latest/download/v1-manifests.yaml');
    const h = helm(['version', '--short']); ok('helm', h.code === 0, h.code === 0 ? h.out.trim() : 'install helm 3.8+ (the llm-d router is a Helm chart)');
  }
  if (d.needs.keda) { const r = runner(['get', 'crd', 'scaledobjects.keda.sh']); ok('KEDA installed', r.code === 0, r.code === 0 ? 'yes' : 'install KEDA, or deploy without --autoscale'); }
  if (d.hfSecretName) { const r = runner(['-n', d.namespace, 'get', 'secret', d.hfSecretName]); ok(`secret ${d.hfSecretName}`, r.code === 0, r.code === 0 ? 'present' : `kubectl -n ${d.namespace} create secret generic ${d.hfSecretName} --from-literal=token=…`); }
  if (!d.docs.some(x => x.kind === 'Namespace')) { const r = runner(['get', 'namespace', d.namespace]); ok(`namespace ${d.namespace}`, r.code === 0, r.code === 0 ? 'present' : 'add --create-namespace'); }
  return { ready: checks.every(c => c.pass), checks };
}

// One OpenAI request against the endpoint: models listed, a short completion, time to the first byte and in all.
export async function smoke(base, model, { fetcher = fetch, timeoutMs = 120000 } = {}) {
  const t0 = Date.now(), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const ms = await fetcher(`${base}/v1/models`, { signal: ctl.signal });
    const list = ms.ok ? ((await ms.json()).data || []).map(x => x.id) : [];
    if (!list.includes(model)) return { ok: false, error: `/v1/models doesn't list ${model} (${list.join(', ') || ms.status})` };
    const t1 = Date.now();
    const r = await fetcher(`${base}/v1/completions`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: 'The capital of France is', max_tokens: 16, temperature: 0 }) });
    const tFirst = Date.now(), j = r.ok ? await r.json() : null;
    if (!r.ok || !j || !j.choices) return { ok: false, error: `completion failed: ${r.status}` };
    return { ok: true, models: list, text: String(j.choices[0].text || '').trim().slice(0, 80), firstByteMs: tFirst - t1, totalMs: Date.now() - t0, usage: j.usage || null };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message }; } finally { clearTimeout(to); }
}

// Apply, wait, smoke test, register. Without apply it only plans and checks (dry run).
export async function deploy(d, { apply = false, runner = kubectl, helm = helmRun, waitS = 2400, endpoint, fetcher = fetch, registerDir, portForward = defaultPortForward, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const res = { name: d.name, namespace: d.namespace, steps: [] }, step = (s, x) => { res.steps.push(Object.assign({ step: s }, x)); log(s, x); };
  const pf = preflight(d, { runner, helm });
  step('preflight', pf);
  if (!apply) { res.dryRun = true; return res; }
  if (!pf.ready) { res.error = 'preflight failed: ' + pf.checks.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`).join('; '); return res; }
  if (d.mode === 'disagg') return deployDisagg(d, { res, step, runner, helm, waitS, endpoint, fetcher, registerDir, portForward, sleep });
  const a = runner(['apply', '-f', '-'], { input: d.yaml });
  step('apply', { code: a.code, out: a.out.trim(), err: a.err.trim() });
  if (a.code !== 0) { res.error = `kubectl apply failed: ${a.err.trim()}`; return res; }
  const w = d.kind === 'Deployment' ? runner(['-n', d.namespace, 'rollout', 'status', `deployment/${d.name}`, `--timeout=${waitS}s`])
    : runner(['-n', d.namespace, 'wait', '--for=condition=Available', `leaderworkerset/${d.name}`, `--timeout=${waitS}s`]);
  step('wait', { code: w.code, out: w.out.trim(), err: w.err.trim() });
  if (w.code !== 0) { res.error = `not ready after ${waitS}s: ${w.err.trim() || w.out.trim()} (kubectl -n ${d.namespace} logs -l app=${d.name} --tail 50)`; return res; }
  let base = endpoint, stop = () => {};
  if (!base) { const p = await portForward(d); base = p.base; stop = p.stop; }
  try { const s = await smoke(base, d.model, { fetcher }); step('smoke', s); if (!s.ok) { res.error = `smoke test: ${s.error}`; return res; } } finally { stop(); }
  if (registerDir) res.registered = register(d, registerDir);
  step('register', res.registered || {});
  res.ok = true;
  return res;
}

export const helmRun = (argv, { input } = {}) => { const r = spawnSync('helm', argv, { input, encoding: 'utf8', maxBuffer: 64 << 20 }); return { code: r.error ? 127 : r.status, out: r.stdout || '', err: r.stderr || (r.error ? r.error.message : '') }; };

// llm-d: the router (Helm), then the DisaggregatedSet, then every prefill and decode pod ready, then a request through
// the router's Service, which sends it to a prefill pod and then a decode pod.
async function deployDisagg(d, { res, step, runner, helm, waitS, endpoint, fetcher, registerDir, portForward, sleep }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-')), vf = path.join(tmp, 'router.values.yaml'); fs.writeFileSync(vf, d.router.yaml);
  const h = helm(['upgrade', '--install', d.router.release, d.router.chart, '--version', d.router.version, '-n', d.namespace, '-f', vf]);
  step('router', { code: h.code, out: h.out.trim(), err: h.err.trim() });
  if (h.code !== 0) { res.error = `helm install of the llm-d router failed: ${h.err.trim()}`; return res; }
  const a = runner(['apply', '-f', '-'], { input: d.yaml });
  step('apply', { code: a.code, out: a.out.trim(), err: a.err.trim() });
  if (a.code !== 0) { res.error = `kubectl apply failed: ${a.err.trim()}`; return res; }
  const want = d.layout.prefill.instances + d.layout.decode.instances, until = Date.now() + waitS * 1000;
  let ready = 0;
  while (true) {
    const g = runner(['-n', d.namespace, 'get', 'pods', '-l', `llm-d.ai/guide=${d.name}`, '-o', 'json']);
    if (g.code === 0) ready = (JSON.parse(g.out).items || []).filter(p => (p.status.conditions || []).some(c => c.type === 'Ready' && c.status === 'True')).length;
    if (ready >= want || Date.now() > until) break;
    await sleep(15000);
  }
  step('wait', { code: ready >= want ? 0 : 1, out: `${ready} of ${want} prefill and decode pods ready` });
  if (ready < want) { res.error = `${ready} of ${want} pods ready after ${waitS}s (kubectl -n ${d.namespace} get pods -l llm-d.ai/guide=${d.name}; logs of the decode pods' routing-proxy and modelserver)`; return res; }
  let base = endpoint, stop = () => {};
  if (!base) { const p = await portForward(d); base = p.base; stop = p.stop; }
  try { const s = await smoke(base, d.model, { fetcher }); step('smoke', s); if (!s.ok) { res.error = `smoke test through the llm-d router: ${s.error}`; return res; } } finally { stop(); }
  if (registerDir) { res.registered = register(d, registerDir); fs.writeFileSync(path.join(registerDir, `${d.name}.router.values.yaml`), d.router.yaml); }
  step('register', res.registered || {});
  res.ok = true;
  return res;
}

async function defaultPortForward(d) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const p = spawn('kubectl', ['-n', d.namespace, 'port-forward', `svc/${d.service || d.name}`, `${port}:${d.servicePort || 8000}`], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 3000));
  return { base: `http://127.0.0.1:${port}`, stop: () => p.kill() };
}

// The pool joins fleetops: pools.json and targets.json that `tune` and the agent read by default, and the manifest.
export function register(d, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const merge = (f, add) => { const p = path.join(dir, f), cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; fs.writeFileSync(p, JSON.stringify(Object.assign(cur, add), null, 1)); return p; };
  fs.writeFileSync(path.join(dir, `${d.name}.yaml`), d.yaml);
  return { pools: merge('pools.json', d.pool), targets: merge('targets.json', d.poolTargets), manifest: path.join(dir, `${d.name}.yaml`) };
}
