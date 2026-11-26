// Disaggregated serving on llm-d, checked against the real thing instead of our own expectations:
//  - the DisaggregatedSet CRD's v1 schema from LeaderWorkerSet v1.0.0 (what the API server validates against): our
//    manifest must pass it with no unknown fields, as llm-d's own guide manifest does;
//  - llm-d's P/D guide (commit a3ae49a): the KV connector, routing sidecar, ports, probes and labels it depends on;
//  - the router values and the EPP plugins the guide uses;
//  - the CRD names preflight looks for, from the CRDs themselves.
// The manifests also go through the YAML we emit and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planDeployment } from '../src/serving.mjs';
import { LLMD } from '../src/llmd.mjs';
import { validate } from './crd-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), REAL = path.join(here, 'fixtures', 'real', 'llm-d'), require = createRequire(import.meta.url);
let YAML = null; try { YAML = require('yaml'); } catch { /* optional */ }
const crd = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, f))).toString());

const plan = () => planDeployment({ model: 'llama33-70b', gpu: 'H100', rate: 20, isl: 8000, osl: 300, mode: 'disagg', name: 'chat-pd', hfSecret: 'hf-token', cachePvc: 'models' });
// from the YAML we emit, parsed back: the check covers the emitter too
const ours = () => { const d = plan(); return { d, ds: YAML.parseAllDocuments(d.yaml).map(x => x.toJSON()).find(x => x.kind === 'DisaggregatedSet') }; };
const guide = () => YAML.parse(fs.readFileSync(path.join(REAL, 'pd-disaggregation.disaggregatedset.yaml'), 'utf8'));

test('the real DisaggregatedSet CRD schema (LWS v1.0.0) accepts our manifest and llm-d\'s, and catches a typo', { skip: !YAML && 'yaml not installed' }, () => {
  const c = crd('disaggregatedset.crd-v1.schema.json.gz'), s = c.openAPIV3Schema;
  const { ds } = ours();
  assert.equal(ds.apiVersion, `${c.group}/${c.version}`); assert.equal(ds.kind, c.kind);
  assert.deepEqual(validate(s, guide()), [], 'the validator accepts llm-d\'s own guide manifest');
  assert.deepEqual(validate(s, ds), []);
  const bad = JSON.parse(JSON.stringify(ds)); bad.spec.roles[0].spec.replica = 2; bad.spec.roles[1].spec.leaderWorkerTemplate.workerTemplate.spec.containers[0].resources.limit = {};
  bad.spec.slices = 'one';
  const e = validate(s, bad);
  assert.ok(e.some(x => /unknown field replica$/.test(x)) && e.some(x => /unknown field limit$/.test(x)) && e.some(x => /slices: integer expected/.test(x)), e.join('\n'));
});

test('llm-d\'s P/D guide: same KV connector per role, routing sidecar, ports, probes and the labels the router selects on', { skip: !YAML && 'yaml not installed' }, () => {
  const g = guide(), { ds } = ours(), role = (x, n) => x.spec.roles.find(r => r.name === n).spec.leaderWorkerTemplate.workerTemplate;
  for (const n of ['prefill', 'decode']) {
    const G = role(g, n), O = role(ds, n), gc = G.spec.containers[0], oc = O.spec.containers[0];
    const kv = a => JSON.parse(a[a.indexOf('--kv-transfer-config') + 1]);
    assert.deepEqual(kv(oc.args), kv(gc.args), `${n}: kv-transfer-config`);
    assert.deepEqual(oc.command, gc.command);
    assert.deepEqual(oc.ports.map(p => [p.name, p.containerPort]), gc.ports.map(p => [p.name, p.containerPort]), `${n}: ports`);
    for (const f of ['--block-size=128', '--shutdown-timeout=45', ...(n === 'decode' ? ['--port=8200'] : [])]) assert.ok(oc.args.includes(f) && gc.args.includes(f), `${n}: ${f}`);
    for (const e of ['VLLM_NIXL_SIDE_CHANNEL_HOST', 'VLLM_HTTP_TIMEOUT_KEEP_ALIVE']) assert.ok(oc.env.some(x => x.name === e), `${n}: env ${e}`);
    assert.equal(oc.env.find(x => x.name === 'VLLM_HTTP_TIMEOUT_KEEP_ALIVE').value, '120', 'keep-alive ≥ the sidecar\'s idle timeout');
    for (const p of ['startupProbe', 'livenessProbe', 'readinessProbe']) assert.deepEqual(oc[p], gc[p], `${n}: ${p}`);
    for (const l of ['llm-d.ai/inference-serving', 'llm-d.ai/guide', 'llm-d.ai/role', 'llm-d.ai/engine-type', 'llm-d.ai/model']) assert.ok(l in O.metadata.labels, `${n}: label ${l}`);
    assert.equal(O.metadata.labels['llm-d.ai/role'], G.metadata.labels['llm-d.ai/role']);
    assert.deepEqual(O.spec.volumes.find(v => v.name === 'shm'), G.spec.volumes.find(v => v.name === 'shm'));
  }
  const gs = role(g, 'decode').spec.initContainers[0], os_ = role(ds, 'decode').spec.initContainers[0];
  assert.deepEqual([os_.name, os_.args, os_.restartPolicy, os_.securityContext, os_.ports], [gs.name, gs.args, gs.restartPolicy, gs.securityContext, gs.ports]);
  assert.ok(!role(ds, 'prefill').spec.initContainers && !role(g, 'prefill').spec.initContainers, 'no sidecar on prefill');
  // llm-d's guide surges a role during rollouts; we keep maxSurge 0 so a rollout needs no spare GPUs (the guide's own
  // comment gives this setting for capacity-constrained clusters)
  assert.deepEqual(ds.spec.roles[0].spec.rolloutStrategy.rollingUpdateConfiguration, { maxSurge: 0, maxUnavailable: 1 });
});

test('router values: the guide\'s ports, pool selection and EPP plugins; the chart layering base → guide', { skip: !YAML && 'yaml not installed' }, () => {
  const { d } = ours(), rv = YAML.parse(d.router.yaml).router;
  const base = YAML.parse(fs.readFileSync(path.join(REAL, 'router.base.values.yaml'), 'utf8')).router, gv = YAML.parse(fs.readFileSync(path.join(REAL, 'pd-disaggregation.router.values.yaml'), 'utf8')).router;
  assert.deepEqual(rv.extraServicePorts, gv.extraServicePorts);
  assert.equal(rv.epp.pluginsConfigFile, gv.epp.pluginsConfigFile); assert.equal(rv.epp.replicas, 1);
  assert.deepEqual(rv.inferencePool, base.inferencePool); assert.equal(rv.modelServers.protocol, base.modelServers.protocol); assert.deepEqual(rv.proxy.args, base.proxy.args);
  assert.deepEqual(Object.keys(rv.modelServers.matchLabels), Object.keys(gv.modelServers.matchLabels));
  const ep = YAML.parse(rv.epp.pluginsCustomConfig['pd-config.yaml']), gp = YAML.parse(gv.epp.pluginsCustomConfig['pd-config.yaml']);
  const types = c => new Set(c.plugins.map(p => p.type)), gt = types(gp);
  for (const t of types(ep)) assert.ok(gt.has(t), `plugin ${t} is one the guide uses`);
  for (const pr of ep.schedulingProfiles) for (const r of pr.plugins) assert.ok(types(ep).has(r.pluginRef), `${pr.name} refers to a declared plugin ${r.pluginRef}`);
  assert.deepEqual(ep.schedulingProfiles.map(p => p.name), gp.schedulingProfiles.map(p => p.name));
  // the one plugin left out needs a throughput measured on your fleet (the guide's is for gpt-oss-120b on H200)
  assert.deepEqual([...gt].filter(t => !types(ep).has(t)), ['prefix-cache-affinity-filter']);
});

test('preflight looks for the CRDs by the names the real CRDs carry', () => {
  assert.equal(LLMD.crds.ds, crd('disaggregatedset.crd-v1.schema.json.gz').name);
  assert.equal(LLMD.crds.pool, crd('inferencepool.crd-v1.schema.json.gz').name);
});

test('no mocks: the CLI\'s disaggregated dry run writes manifests the real CRD schema accepts, and applies nothing', { skip: !YAML && 'yaml not installed' }, async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-cli-')), out = path.join(dir, 'pd.yaml');
  const r = await promisify(execFile)(process.execPath, [path.join(here, '..', 'tools', 'fleetops.mjs'), 'serving', 'deploy', '--model', 'llama33-70b', '--gpu', 'H100', '--rate', '20', '--isl', '8000', '--osl', '300', '--mode', 'disagg', '--name', 'chat-pd', '--out', out, '--store', path.join(dir, 's')]);
  assert.match(r.stdout, /wrote/); assert.match(r.stdout, /dry run: nothing applied/); assert.doesNotMatch(r.stdout, /^\s+applied/m);
  const docs = YAML.parseAllDocuments(fs.readFileSync(out, 'utf8')).map(x => x.toJSON()), ds = docs.find(x => x.kind === 'DisaggregatedSet');
  assert.ok(ds); assert.deepEqual(validate(crd('disaggregatedset.crd-v1.schema.json.gz').openAPIV3Schema, ds), []);
  assert.ok(!fs.existsSync(path.join(dir, 's', 'serving', 'pools.json')), 'a dry run registers nothing');
});
