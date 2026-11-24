import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import { planDeployment, toYaml, preflight, deploy, smoke, register, workloadFromStore, hfRepo, models } from '../src/serving.mjs';

const require = createRequire(import.meta.url), FIT = require('../../inference-sizer/src/fit.js'), SM = require('../../inference-sizer/src/model.js'), SC = require('../../inference-sizer/src/catalog.js');
const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'serving-'));
let YAML = null; try { YAML = require('yaml'); } catch { /* optional */ }
const WL = { isl: 2000, osl: 400 }, TG = { ttftS: 2, tpotS: 0.05 };
const fitsAt = (model, hw, rate) => { const m = SC.MODELS.find(x => x.id === model), p = SM.plan(FIT.settings(m, hw, Object.assign({ rate }, WL), TG), { noSens: true }); return !!(p.chosen && p.chosen.totalNodes <= hw.nodes); };

test('capacity: the max rate fits on the hardware and 5% more does not; edge carries more than production', () => {
  for (const [model, hw] of [['llama33-70b', { gpu: 'H100', nodes: 2 }], ['qwen3-32b', { gpu: 'H200', nodes: 1 }], ['llama31-8b', { gpu: 'L40S', nodes: 1 }]]) {
    const c = FIT.capacity(model, hw, WL, TG, {});
    assert.ok(c.production.rate > 0, `${model} fits`);
    assert.ok(fitsAt(model, hw, c.production.rate), `${model} at its max rate fits`);
    assert.ok(!fitsAt(model, hw, c.production.rate * 1.05), `${model} at 5% more doesn't`);
    assert.ok(c.edge.rate >= c.production.rate, 'no headroom, spare or margin carries at least as much');
    assert.ok(c.maxPrompt > WL.isl && c.maxPrompt <= c.modelMaxCtx, 'the longest prompt is between the workload and the model limit');
    assert.ok(c.production.layout.instances * c.production.layout.gpusPerInstance <= hw.nodes * SC.GPUS.find(g => g.id === hw.gpu).domain);
  }
});

test('fit: models that need more nodes than there are are listed as not fitting; ranked by size or by rate', () => {
  const big = FIT.fitModels({ gpu: 'H100', nodes: 2 }, WL, TG, { rank: 'largest' }), fast = FIT.fitModels({ gpu: 'H100', nodes: 2 }, WL, TG, { rank: 'throughput' });
  const row = id => big.rows.find(r => r.model === id);
  assert.equal(row('kimi-k2').production.rate, 0); assert.match(row('kimi-k2').production.why, /needs \d+ node/);
  const fitting = big.rows.filter(r => r.production.rate > 0);
  for (let i = 1; i < fitting.length; i++) assert.ok(fitting[i - 1].params >= fitting[i].params, 'largest first');
  const rates = fast.rows.map(r => r.production.rate);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i - 1] >= rates[i], 'fastest first');
  const need = FIT.fitModels({ gpu: 'H100', nodes: 2 }, Object.assign({ rate: 25 }, WL), TG, {});
  assert.ok(need.rows.every(r => r.meetsRate === (r.production.rate >= 25)));
  assert.ok(need.rows.findIndex(r => !r.meetsRate) > need.rows.findIndex(r => r.meetsRate), 'models that carry the load come first');
});

test('deploy plan: single-node → Deployment; the manifests parse and carry the layout, labels and probes', { skip: !YAML && 'yaml not installed' }, () => {
  const d = planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, name: 'chat', hfSecret: 'hf-token', autoscale: true, cachePvc: 'models' });
  const docs = YAML.parseAllDocuments(d.yaml).map(x => x.toJSON());
  assert.deepEqual(docs.map(x => x.kind), ['Deployment', 'Service', 'ScaledObject']);
  const [dep, svc, so] = docs, c = dep.spec.template.spec.containers[0];
  assert.equal(dep.spec.replicas, d.layout.instances);
  assert.equal(c.resources.limits['nvidia.com/gpu'], String(d.layout.tp));
  const arg = k => c.args[c.args.indexOf(k) + 1];
  assert.equal(c.args[0], 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(arg('--tensor-parallel-size'), String(d.layout.tp));
  assert.equal(arg('--served-model-name'), 'llama33-70b');
  assert.ok(+arg('--max-num-seqs') >= d.layout.concurrency / d.layout.instances, 'room for the planned concurrency per instance');
  assert.equal(dep.spec.template.metadata.labels['gpu-health.aiinfra/serving'], 'true', 'gpu-health drains work on it');
  assert.equal(svc.spec.selector['gpu-health.aiinfra/serving'], 'true');
  assert.equal(c.env.find(e => e.name === 'HF_TOKEN').valueFrom.secretKeyRef.name, 'hf-token', 'the token comes from the user\'s Secret');
  assert.ok(c.startupProbe.failureThreshold * c.startupProbe.periodSeconds >= 1800, 'time to load weights before liveness');
  assert.equal(dep.spec.template.spec.volumes.find(v => v.name === 'cache').persistentVolumeClaim.claimName, 'models');
  assert.equal(so.spec.scaleTargetRef.kind, 'Deployment'); assert.ok(so.spec.maxReplicaCount >= so.spec.minReplicaCount);
  assert.deepEqual(d.pool, { chat: { model: 'llama33-70b', gpu: 'H100', gpus: d.layout.gpus, namespace: 'serving' } });
});

test('deploy plan: an instance larger than a node → LeaderWorkerSet in vLLM\'s multi-node shape', { skip: !YAML && 'yaml not installed' }, () => {
  const d = planDeployment({ model: 'kimi-k2', gpu: 'H100', rate: 1, name: 'kimi' });
  assert.equal(d.kind, 'LeaderWorkerSet'); assert.ok(d.nodesPerInstance > 1);
  const [lws, svc] = YAML.parseAllDocuments(d.yaml).map(x => x.toJSON());
  const t = lws.spec.leaderWorkerTemplate, lead = t.leaderTemplate.spec.containers[0], work = t.workerTemplate.spec.containers[0];
  assert.equal(t.size, d.nodesPerInstance); assert.equal(t.restartPolicy, 'RecreateGroupOnPodRestart');
  assert.equal(lead.args[lead.args.indexOf('--tensor-parallel-size') + 1], '8', 'TP inside a node');
  assert.equal(lead.args[lead.args.indexOf('--pipeline-parallel-size') + 1], String(d.nodesPerInstance), 'PP across nodes');
  for (const a of ['--nnodes', '--node-rank', '--master-addr']) { assert.ok(lead.args.includes(a)); assert.ok(work.args.includes(a)); }
  assert.ok(work.args.includes('--headless') && !lead.args.includes('--headless'));
  assert.ok(!work.args.includes('--port') && !work.readinessProbe, 'workers don\'t serve');
  assert.equal(svc.spec.selector.role, 'leader');
});

test('deploy plan refuses what cannot work, and names that are not DNS labels', () => {
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 1, rate: 500 }), /needs \d+ H100 nodes/);
  assert.throws(() => planDeployment({ model: 'kimi-k2', gpu: 'H100', nodes: 2 }), /doesn't fit/);
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, name: 'Bad_Name' }), /DNS label/);
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, namespace: 'a;rm' }), /DNS label/);
  assert.throws(() => planDeployment({ model: 'nope', gpu: 'H100', nodes: 2 }), /unknown model/);
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'H100' }), /--rate|--nodes/);
  assert.ok(models().every(m => m.hf), 'every catalog model has a Hugging Face repo');
  assert.equal(hfRepo({ source: 'https://huggingface.co/Qwen/Qwen3-32B' }), 'Qwen/Qwen3-32B');
});

test('toYaml quotes what YAML would misread', { skip: !YAML && 'yaml not installed' }, () => {
  const o = { a: 'true', b: '8000', c: '--port', d: '$(LWS_GROUP_SIZE)', e: 'x: y', f: [], g: {}, h: 3, i: false, j: ['1e5', 'no', '~'] };
  assert.deepEqual(YAML.parse(toYaml(o)), o);
});

// a pretend cluster: kubectl answers from a table; records what was applied
function stubKube({ gpusPerNode = 8, nodes = 2, lws = true, secret = true, applyFails = false, product = 'NVIDIA-H100-80GB-HBM3' } = {}) {
  const calls = [];
  const runner = (argv, { input } = {}) => {
    calls.push({ argv, input }); const a = argv.join(' ');
    if (a === 'config current-context') return { code: 0, out: 'test-cluster\n', err: '' };
    if (a === 'get nodes -o json') return { code: 0, out: JSON.stringify({ items: Array.from({ length: nodes }, (_, i) => ({ metadata: { name: `gpu-${i}`, labels: { 'nvidia.com/gpu.product': product } }, spec: {}, status: { allocatable: { 'nvidia.com/gpu': String(gpusPerNode) }, conditions: [{ type: 'Ready', status: 'True' }] } })) }), err: '' };
    if (/get crd leaderworkersets/.test(a)) return lws ? { code: 0, out: '', err: '' } : { code: 1, out: '', err: 'NotFound' };
    if (/get crd scaledobjects/.test(a)) return { code: 1, out: '', err: 'NotFound' };
    if (/get secret/.test(a)) return secret ? { code: 0, out: '', err: '' } : { code: 1, out: '', err: 'NotFound' };
    if (/get namespace/.test(a)) return { code: 0, out: '', err: '' };
    if (a === 'apply -f -') return applyFails ? { code: 1, out: '', err: 'forbidden' } : { code: 0, out: 'deployment.apps/chat created\nservice/chat created', err: '' };
    if (/rollout status|wait --for/.test(a)) return { code: 0, out: 'successfully rolled out', err: '' };
    return { code: 1, out: '', err: `unexpected: ${a}` };
  };
  return { runner, calls };
}
function fakeOpenAI(model) {
  const srv = http.createServer((q, s) => {
    if (q.url === '/v1/models') { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ data: [{ id: model }] })); }
    if (q.url === '/v1/completions' && q.method === 'POST') { let b = ''; q.on('data', c => (b += c)); q.on('end', () => { const j = JSON.parse(b); s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ choices: [{ text: j.model === model ? ' Paris.' : '' }], usage: { completion_tokens: 2 } })); }); return; }
    s.statusCode = 404; s.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

test('preflight: counts pods that fit on allocatable GPUs, and names what is missing with the fix', () => {
  const d = planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, name: 'chat', hfSecret: 'hf-token' });
  const ok = preflight(d, { runner: stubKube().runner });
  assert.ok(ok.ready, JSON.stringify(ok.checks));
  const small = preflight(d, { runner: stubKube({ nodes: 1 }).runner });
  assert.ok(!small.ready); assert.match(small.checks.find(c => !c.pass).detail, /fit 4 pod\(s\); this needs 7/);
  const nosecret = preflight(d, { runner: stubKube({ secret: false }).runner });
  assert.match(nosecret.checks.find(c => !c.pass).detail, /create secret generic hf-token/);
  const wrong = preflight(d, { runner: stubKube({ product: 'NVIDIA-A100-SXM4-80GB' }).runner });
  assert.ok(wrong.checks.some(c => !c.pass && /re-plan with --gpu/.test(c.detail)));
  const big = planDeployment({ model: 'kimi-k2', gpu: 'H100', rate: 1, name: 'kimi' });
  const nolws = preflight(big, { runner: stubKube({ nodes: 8, lws: false }).runner });
  assert.match(nolws.checks.find(c => /LeaderWorkerSet/.test(c.name)).detail, /lws/);
  const nokube = preflight(d, { runner: () => ({ code: 127, out: '', err: 'kubectl not found' }) });
  assert.equal(nokube.ready, false); assert.equal(nokube.checks.length, 1);
});

test('deploy: dry run applies nothing; --apply applies, waits, smoke-tests and registers the pool for tune', async () => {
  const d = planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, name: 'chat', hfSecret: 'hf-token' }), dir = tmp();
  const dry = stubKube(), r0 = await deploy(d, { runner: dry.runner, registerDir: dir });
  assert.ok(r0.dryRun); assert.ok(!dry.calls.some(c => c.argv[0] === 'apply'), 'nothing applied');
  assert.ok(!fs.existsSync(path.join(dir, 'pools.json')));
  const api = await fakeOpenAI('llama33-70b');
  try {
    const k = stubKube(), r = await deploy(d, { apply: true, runner: k.runner, endpoint: api.base, registerDir: dir });
    assert.ok(r.ok, r.error); assert.deepEqual(r.steps.map(s => s.step), ['preflight', 'apply', 'wait', 'smoke', 'register']);
    assert.equal(k.calls.find(c => c.argv[0] === 'apply').input, d.yaml, 'what was applied is what was shown');
    assert.ok(k.calls.some(c => c.argv.join(' ').includes('rollout status deployment/chat')));
    assert.equal(r.steps.find(s => s.step === 'smoke').text, 'Paris.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pools.json'), 'utf8')).chat, d.pool.chat);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'targets.json'), 'utf8')).chat, { ttftP99: 2, tpotP99: 0.05 });
    // a failed preflight stops before anything is applied
    const k2 = stubKube({ nodes: 1 }), r2 = await deploy(d, { apply: true, runner: k2.runner, endpoint: api.base });
    assert.match(r2.error, /preflight failed/); assert.ok(!k2.calls.some(c => c.argv[0] === 'apply'));
    const k3 = stubKube({ applyFails: true }), r3 = await deploy(d, { apply: true, runner: k3.runner, endpoint: api.base });
    assert.match(r3.error, /apply failed: forbidden/);
    const wrong = await smoke(api.base, 'other-model');
    assert.ok(!wrong.ok); assert.match(wrong.error, /doesn't list other-model/);
  } finally { api.close(); }
});

test('workload from the store: token sizes and the p99 5-minute rate of a pool', () => {
  const s = new MemStore(), t0 = 1.79e9, rq = [];
  for (let i = 0; i < 3000; i++) rq.push({ t: t0 + i, pool: 'chat', isl: 1000 + (i % 10) * 100, osl: 200 + (i % 5) * 50, ttft: 0.5, tpot: 0.03 });
  s.append('request', rq);
  const w = workloadFromStore(s, 'chat', { from: t0 - 1, to: t0 + 3000 });
  assert.equal(w.requests, 3000); assert.ok(w.isl >= 1000 && w.islP99 >= 1900); assert.ok(Math.abs(w.rate - 1) < 0.01, `one request a second: ${w.rate}`);
  assert.equal(workloadFromStore(s, 'other', { from: t0, to: t0 + 3000 }), null);
});

test('CLI: serving fit / capacity / deploy --out (dry run) and tune reads the registered pools', async () => {
  const dir = tmp(), store = path.join(dir, 'store');
  const fit = JSON.parse((await run('node', [cli, 'serving', 'fit', '--gpu', 'H100', '--nodes', '2', '--rate', '5', '--store', store, '--json'])).stdout);
  assert.ok(fit.fit.rows.length >= 10); assert.ok(fit.fit.rows[0].meetsRate);
  const cap = (await run('node', [cli, 'serving', 'capacity', '--model', 'llama33-70b', '--gpu', 'H100', '--nodes', '2', '--store', store])).stdout;
  assert.match(cap, /max load: +\d+\.\d req\/s/); assert.match(cap, /longest prompt/);
  const out = path.join(dir, 'chat.yaml');
  const dep = (await run(process.execPath, [cli, 'serving', 'deploy', '--model', 'llama33-70b', '--gpu', 'H100', '--nodes', '2', '--name', 'chat', '--out', out, '--store', store], { env: Object.assign({}, process.env, { PATH: '/nonexistent' }) }).catch(e => e)).stdout;
  assert.match(dep, /dry run: nothing applied/); assert.match(fs.readFileSync(out, 'utf8'), /kind: Deployment/);
  register(planDeployment({ model: 'llama33-70b', gpu: 'H100', nodes: 2, name: 'chat' }), path.join(store, 'serving'));
  await run('node', [cli, 'tune', '--store', store, '--json']);
  const del = (await run('node', [cli, 'serving', 'delete', 'chat', '--store', store])).stdout;
  assert.match(del, /would run: kubectl delete -f .*chat\.yaml/); assert.match(del, /--apply to delete/);
});
