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
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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
  // deployments are aggregated (one vLLM per instance); the sizer still says when disaggregation would be smaller
  const extra = { wprec, mode: 'agg' };
  let lay, sized, notes = [];
  if (wl.rate) {
    const s = FIT.settings(m, hw || { gpu: g.id, gpusPerNode: per }, wl, tg, extra), p = SM.plan(s, { noSens: true });
    if (!p.chosen) throw new Error(`no layout of ${m.id} on ${g.id} meets TTFT ${tg.ttftS}s / TPOT ${tg.tpotS}s at ${wl.rate} req/s (${((p.agg.rows || []).find(r => r.why) || {}).why || 'see the Inference Sizer'})`);
    if (hw && hw.nodes && p.chosen.totalNodes > hw.nodes) throw new Error(`${wl.rate} req/s needs ${p.chosen.totalNodes} ${g.id} nodes (with the N+1 spare); you have ${hw.nodes}. Lower the rate, or see what fits: fleetops serving capacity --model ${m.id} --gpu ${g.id} --nodes ${hw.nodes}`);
    lay = FIT.layout(p); sized = { basis: `sized for ${wl.rate} req/s`, nodes: p.chosen.totalNodes, gpus: p.chosen.gpus, rate: wl.rate };
    const auto = SM.plan(Object.assign({}, s, { mode: 'auto' }), { noSens: true });
    if (auto.chosen && auto.chosen.mode === 'disagg') notes.push(`The sizer would use disaggregated prefill/decode (${auto.chosen.totalNodes} nodes against ${p.chosen.totalNodes}); this deploys aggregated serving. Disaggregation needs llm-d or Dynamo.`);
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
    sized, targets: tg, workload: wl, notes, docs, yaml: docs.map(toYaml).join('---\n'),
    pool: { [name]: { model: m.id, gpu: g.id, gpus: totalGpus, namespace: ns } }, poolTargets: { [name]: { ttftP99: tg.ttftS, tpotP99: tg.tpotS } },
    needs: { gpus: totalGpus, perPod, lws: multiNode, keda: !!opts.autoscale, gpuResource: gpuRes },
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
    return `${pad}${q(k)}: ${scalar(v)}\n`;
  }).join('');
}

// ---------- applying it ----------
// runner(argv, { input }) → { code, out, err }: kubectl, real or not (tests)
export const kubectl = (argv, { input } = {}) => { const r = spawnSync('kubectl', argv, { input, encoding: 'utf8', maxBuffer: 64 << 20 }); return { code: r.error ? 127 : r.status, out: r.stdout || '', err: r.stderr || (r.error ? r.error.message : '') }; };

// What the cluster has: GPUs per node of the resource, CRDs, the secret.
export function preflight(d, { runner = kubectl } = {}) {
  const checks = [], ok = (name, pass, detail) => checks.push({ name, pass, detail });
  const ctx = runner(['config', 'current-context']);
  ok('kubectl context', ctx.code === 0, ctx.code === 0 ? ctx.out.trim() : (ctx.err || 'kubectl not found').trim());
  if (ctx.code !== 0) return { ready: false, checks };
  const nodes = runner(['get', 'nodes', '-o', 'json']);
  if (nodes.code === 0) {
    const items = JSON.parse(nodes.out).items || [];
    const per = items.map(n => ({ name: n.metadata.name, gpus: +((n.status.allocatable || {})[d.needs.gpuResource] || 0), product: (n.metadata.labels || {})['nvidia.com/gpu.product'] || (n.metadata.labels || {})['amd.com/gpu.product-name'] || '', ready: (n.status.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'), cordoned: !!(n.spec || {}).unschedulable }));
    const usable = per.filter(n => n.ready && !n.cordoned && n.gpus >= d.needs.perPod);
    const fitPods = usable.reduce((t, n) => t + Math.floor(n.gpus / d.needs.perPod), 0), podsNeeded = d.layout.instances * d.nodesPerInstance;
    ok(`GPU nodes (${d.needs.gpuResource} ≥ ${d.needs.perPod} per pod)`, fitPods >= podsNeeded, `${usable.length} usable node(s) fit ${fitPods} pod(s); this needs ${podsNeeded}${usable.length ? `; GPUs: ${[...new Set(usable.map(n => n.product).filter(Boolean))].join(', ') || 'unlabelled'}` : ''} (allocatable, not counting what is already running)`);
    const wrongGpu = usable.length && usable.every(n => n.product) && !usable.some(n => n.product.toUpperCase().includes(d.gpu.split('-')[0].toUpperCase()));
    if (wrongGpu) ok(`GPU type ${d.gpu}`, false, `the GPU nodes report ${[...new Set(usable.map(n => n.product))].join(', ')}; the plan assumed ${d.gpu}: re-plan with --gpu`);
  } else ok('list nodes', false, nodes.err.trim());
  if (d.needs.lws) { const r = runner(['get', 'crd', 'leaderworkersets.leaderworkerset.x-k8s.io']); ok('LeaderWorkerSet installed', r.code === 0, r.code === 0 ? 'yes' : 'kubectl apply --server-side -f https://github.com/kubernetes-sigs/lws/releases/latest/download/manifests.yaml'); }
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
export async function deploy(d, { apply = false, runner = kubectl, waitS = 2400, endpoint, fetcher = fetch, registerDir, portForward = defaultPortForward, log = () => {} } = {}) {
  const res = { name: d.name, namespace: d.namespace, steps: [] }, step = (s, x) => { res.steps.push(Object.assign({ step: s }, x)); log(s, x); };
  const pf = preflight(d, { runner });
  step('preflight', pf);
  if (!apply) { res.dryRun = true; return res; }
  if (!pf.ready) { res.error = 'preflight failed: ' + pf.checks.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`).join('; '); return res; }
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

async function defaultPortForward(d) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const p = spawn('kubectl', ['-n', d.namespace, 'port-forward', `svc/${d.name}`, `${port}:8000`], { stdio: 'ignore' });
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
