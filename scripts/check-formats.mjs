#!/usr/bin/env node
// Are the formats these tools read and write still current? Each check fetches upstream's latest and compares it with
// what the tools use (and with the copy vendored under tests, where there is one):
//   breaking  a field, metric or enum value the tools read is gone, or a manifest we ship fails upstream's latest schema
//   newer     upstream has moved on (a new release, added fields) but nothing we use changed: refresh when convenient
//   ok        nothing changed
// Runs weekly in CI (.github/workflows/formats.yml), which opens an issue when anything is breaking or newer.
//   node scripts/check-formats.mjs [--json] [--only name,name]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(path.join(root, 'fleetops', 'package.json'));
const YAML = require('yaml');
const { validate } = await import(path.join(root, 'fleetops', 'tests', 'crd-schema.mjs'));
const rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const gz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, f))).toString());
const H = {}; // raw.githubusercontent.com needs no token
async function get(url) {
  const r = await fetch(url, { headers: Object.assign({ 'user-agent': 'aiinfra-format-check' }, H) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}
// the highest release tag (vX.Y.Z, no pre-releases), from git itself: no API token, no rate limit
const latestTag = async repo => {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}`], { encoding: 'utf8', timeout: 60000 });
  const tags = out.split('\n').map(l => l.split('refs/tags/')[1]).filter(t => t && /^v?\d+\.\d+\.\d+$/.test(t));
  const key = t => t.replace(/^v/, '').split('.').map(Number);
  return tags.sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }).at(-1);
};
const raw = (repo, ref, file) => get(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`);
const crdSchema = (text, kind) => { const c = YAML.parseAllDocuments(text).map(d => d.toJSON()).find(d => d && d.kind === 'CustomResourceDefinition' && d.spec.names.kind === kind); const v = c.spec.versions.find(x => x.storage) || c.spec.versions[0]; return { group: c.spec.group, version: v.name, schema: v.schema.openAPIV3Schema }; };
const docs = f => YAML.parseAllDocuments(rd(f)).map(d => d.toJSON()).filter(Boolean);
// shipped manifests of `kind` against the latest schema: errors are breaking
function manifests(files, kind, latest) {
  const out = [];
  for (const f of files) for (const d of docs(f).filter(x => x.kind === kind)) {
    if (d.apiVersion !== `${latest.group}/${latest.version}`) out.push(`${f}: ${kind} is ${d.apiVersion}, upstream stores ${latest.group}/${latest.version}`);
    for (const e of validate(latest.schema, d)) out.push(`${f} (${d.metadata.name}): ${e}`);
  }
  return out;
}
const vendored = f => fs.existsSync(path.join(root, f)) ? gz(f) : null;
const sameSchema = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CHECKS = {
  async 'vllm-metrics'() {
    const P = await import(path.join(root, 'fleetops', 'src', 'shadow-prom.mjs'));
    const src = await raw('vllm-project/vllm', 'main', 'vllm/v1/metrics/loggers.py'), names = new Set();
    for (const m of src.matchAll(/(_counter_cls|_gauge_cls|_histogram_cls|Counter|Gauge|Histogram)\(\s*name="(vllm:[a-z0-9_]+)"/g)) {
      const k = m[1], n = m[2]; if (/ounter/.test(k)) names.add(n + '_total'); else if (/istogram/.test(k)) for (const s of ['_bucket', '_sum', '_count']) names.add(n + s); else names.add(n);
    }
    const used = new Set(Object.values(P.queries('a="b"')).join(' ').match(/vllm:[a-z0-9_]+/g));
    for (const q of Object.values((await import(path.join(root, 'fleetops', 'src', 'pull.mjs'))).SERVING_QUERIES)) for (const m of q.match(/vllm:[a-z0-9_]+/g) || []) used.add(m);
    const pinned = new Set(rd('fleetops/tests/fixtures/real/vllm/metric-names.txt').split('\n').filter(l => l && !l.startsWith('#')));
    // a metric may be read through an `or` with its replacement: only one of each such pair needs to exist
    const gone = [...used].filter(m => !names.has(m) && !(/time_per_output_token|inter_token|gpu_cache_usage_perc/.test(m) && [...used].some(o => o !== m && names.has(o) && /time_per_output_token|inter_token|kv_cache_usage_perc/.test(o))));
    const added = [...names].filter(n => !pinned.has(n)), removed = [...pinned].filter(n => !names.has(n));
    return gone.length ? { status: 'breaking', detail: `metrics the queries read are gone from vLLM main: ${gone.join(', ')}` }
      : added.length || removed.length ? { status: 'newer', detail: `vLLM main vs the pinned list: ${added.length} added${added.length ? ` (${added.slice(0, 6).join(', ')}${added.length > 6 ? '…' : ''})` : ''}, ${removed.length} removed${removed.length ? ` (${removed.join(', ')})` : ''}; nothing the queries read changed` }
      : { status: 'ok', detail: `${used.size} metrics read, all present` };
  },
  async 'argo-rollouts'() {
    const tag = await latestTag('argoproj/argo-rollouts');
    const at = crdSchema(await raw('argoproj/argo-rollouts', tag, 'manifests/crds/analysis-template-crd.yaml'), 'AnalysisTemplate'), ro = crdSchema(await raw('argoproj/argo-rollouts', tag, 'manifests/crds/rollout-crd.yaml'), 'Rollout');
    const errs = [...manifests(['fleetops/deploy/shadow-gate/argo-analysistemplate.yaml'], 'AnalysisTemplate', at), ...manifests(['fleetops/deploy/shadow-gate/argo-rollout-example.yaml'], 'Rollout', ro)];
    const moved = !sameSchema(at.schema, vendored('fleetops/tests/fixtures/real/rollouts/argo-rollouts-analysistemplate.crd-v1alpha1.schema.json.gz').openAPIV3Schema) || !sameSchema(ro.schema, vendored('fleetops/tests/fixtures/real/rollouts/argo-rollouts-rollout.crd-v1alpha1.schema.json.gz').openAPIV3Schema);
    return errs.length ? { status: 'breaking', detail: `${tag}: ${errs.join('; ')}` } : moved ? { status: 'newer', detail: `${tag}: schemas changed since v1.10.2 (vendored); the manifests still pass` } : { status: 'ok', detail: `${tag}: same schemas as vendored` };
  },
  async flagger() {
    const tag = await latestTag('fluxcd/flagger'), c = crdSchema(await raw('fluxcd/flagger', tag, 'artifacts/flagger/crd.yaml'), 'Canary');
    const errs = manifests(['fleetops/deploy/shadow-gate/flagger-canary.yaml'], 'Canary', c), moved = !sameSchema(c.schema, vendored('fleetops/tests/fixtures/real/rollouts/flagger-canary.crd-v1beta1.schema.json.gz').openAPIV3Schema);
    return errs.length ? { status: 'breaking', detail: `${tag}: ${errs.join('; ')}` } : moved ? { status: 'newer', detail: `${tag}: Canary schema changed since v1.45.0 (vendored); the manifest still passes` } : { status: 'ok', detail: `${tag}: same schema as vendored` };
  },
  async 'prometheus-operator'() {
    const tag = await latestTag('prometheus-operator/prometheus-operator'), c = crdSchema(await raw('prometheus-operator/prometheus-operator', tag, 'example/prometheus-operator-crd/monitoring.coreos.com_podmonitors.yaml'), 'PodMonitor');
    const errs = manifests(['fleetops/deploy/shadow-gate/podmonitor-vllm.yaml'], 'PodMonitor', c), moved = !sameSchema(c.schema, vendored('fleetops/tests/fixtures/real/rollouts/prometheus-operator-podmonitor.crd-v1.schema.json.gz').openAPIV3Schema);
    return errs.length ? { status: 'breaking', detail: `${tag}: ${errs.join('; ')}` } : moved ? { status: 'newer', detail: `${tag}: PodMonitor schema changed since v0.95.2 (vendored); the manifest still passes` } : { status: 'ok', detail: `${tag}: same schema as vendored` };
  },
  async 'kserve-llminferenceservice'() {
    const c = crdSchema(await raw('kserve/kserve', 'master', 'config/crd/full/llmisvc/serving.kserve.io_llminferenceservices.yaml'), 'LLMInferenceService');
    const errs = manifests(['fleetops/deploy/shadow-gate/llmd-canary-example.yaml'], 'LLMInferenceService', c);
    const route = c.schema.properties.spec.properties.router.properties.route.properties;
    if (!route.weight || !route.group) errs.push('spec.router.route.group/weight (the canary weights) are gone');
    else if (route.weight.maximum !== 1000000) errs.push(`route.weight maximum is now ${route.weight.maximum} (shadow-canary writes parts per million)`);
    const moved = !sameSchema(c.schema, vendored('fleetops/tests/fixtures/real/llm-d/llminferenceservice.crd-v1alpha2.schema.json.gz').openAPIV3Schema);
    return errs.length ? { status: 'breaking', detail: errs.join('; ') } : moved ? { status: 'newer', detail: `master (${c.version}): schema changed since the vendored copy; the manifests and weights still fit` } : { status: 'ok', detail: `master (${c.version}): same schema as vendored` };
  },
  async 'lws-disaggregatedset'() {
    const tag = await latestTag('kubernetes-sigs/lws');
    const text = await raw('kubernetes-sigs/lws', tag, 'config/crd/bases/disaggregatedset.x-k8s.io_disaggregatedsets.yaml').catch(() => null);
    if (!text) return { status: 'newer', detail: `${tag}: the DisaggregatedSet CRD isn't at the path it was (config/crd/bases): look for it and update the fixture` };
    const c = crdSchema(text, 'DisaggregatedSet'), { planDeployment } = await import(path.join(root, 'fleetops', 'src', 'serving.mjs'));
    const d = YAML.parseAllDocuments(planDeployment({ model: 'llama33-70b', gpu: 'H100', rate: 20, isl: 8000, osl: 300, mode: 'disagg', name: 'chat-pd' }).yaml).map(x => x.toJSON()).find(x => x && x.kind === 'DisaggregatedSet');
    const errs = [...(d.apiVersion !== `${c.group}/${c.version}` ? [`we emit ${d.apiVersion}, upstream stores ${c.group}/${c.version}`] : []), ...validate(c.schema, d)];
    const moved = !sameSchema(c.schema, vendored('fleetops/tests/fixtures/real/llm-d/disaggregatedset.crd-v1.schema.json.gz').openAPIV3Schema);
    return errs.length ? { status: 'breaking', detail: `${tag}: the DisaggregatedSet fleetops emits: ${errs.slice(0, 5).join('; ')}` } : moved ? { status: 'newer', detail: `${tag}: schema changed since v1.0.0 (vendored); what fleetops emits still passes` } : { status: 'ok', detail: `${tag}: same schema as vendored` };
  },
  async nvsentinel() {
    const tag = await latestTag('NVIDIA/NVSentinel'), proto = await raw('NVIDIA/NVSentinel', tag, 'data-models/protobufs/health_event.proto');
    const ce = await raw('NVIDIA/NVSentinel', tag, 'event-exporter/pkg/transformer/cloudevents.go');
    const block = name => (proto.match(new RegExp(`(?:message|enum) ${name} \\{([\\s\\S]*?)\\n\\}`)) || [])[1] || '';
    const has = (b, f) => new RegExp(`\\b${f}\\b`).test(b);
    const need = { HealthEvent: ['agent', 'componentClass', 'checkName', 'isFatal', 'isHealthy', 'message', 'recommendedAction', 'errorCode', 'entitiesImpacted', 'metadata', 'generatedTimestamp', 'nodeName', 'processingStrategy'],
      HealthEventStatus: ['nodeQuarantined', 'faultRemediated', 'remediationDecision'], Entity: ['entityType', 'entityValue'], HealthEventWithStatus: ['createdAt', 'healthEvent', 'healthEventStatus'],
      RecommendedAction: ['NONE', 'COMPONENT_RESET', 'CONTACT_SUPPORT', 'RESTART_BM', 'UNKNOWN'], ProcessingStrategy: ['EXECUTE_REMEDIATION', 'STORE_ONLY', 'STORE_AND_ANALYSE'] };
    const gone = Object.entries(need).flatMap(([m, fs]) => fs.filter(f => !has(block(m), f)).map(f => `${m}.${f}`));
    if (!ce.includes('com.nvidia.nvsentinel.health.v1')) gone.push('CloudEvent type com.nvidia.nvsentinel.health.v1');
    if (!/"healthEvent":/.test(ce)) gone.push('CloudEvent data.healthEvent');
    const fields = (block('HealthEvent').match(/^\s+\S+\s+(\w+)\s*=\s*\d+;/gm) || []).length;
    return gone.length ? { status: 'breaking', detail: `${tag}: no longer has ${gone.join(', ')}` } : tag !== 'v1.33.0' ? { status: 'newer', detail: `${tag} (adapter written against v1.33.0): every field the adapter reads is still there; HealthEvent has ${fields} fields` } : { status: 'ok', detail: `${tag}: every field the adapter reads is there` };
  },
  async opencost() {
    const exp = await raw('opencost/opencost', 'develop', 'pkg/inferencecost/exporter.go').catch(() => raw('opencost/opencost', 'main', 'pkg/inferencecost/exporter.go'));
    const api = await raw('opencost/opencost', 'develop', 'pkg/inferencecost/apitypes.go').catch(() => raw('opencost/opencost', 'main', 'pkg/inferencecost/apitypes.go'));
    const gone = ['llm_cost_per_million_tokens', 'llm_cache_savings_fraction', '"phase"', '"cost_basis"', '"model_name"', '"namespace"'].filter(s => !exp.includes(s));
    gone.push(...['inputCostPerMillionTokens', 'outputCostPerMillionTokens', 'cacheSavingsFraction', 'promptTokens', 'generationTokens', 'allocationMethod', 'costBasis'].filter(s => !api.includes(`"${s}`)));
    return gone.length ? { status: 'breaking', detail: `OpenCost no longer has ${gone.join(', ')}` } : { status: 'ok', detail: 'the metrics, labels and REST fields harness-ledger reads are all there' };
  },
  async 'otel-genai'() {
    const reg = await raw('open-telemetry/semantic-conventions-genai', 'main', 'model/gen-ai/registry.yaml');
    const keys = new Set([...reg.matchAll(/^\s*- key: (gen_ai\.[a-z_.]+)/gm)].map(m => m[1]));
    // the standard names harness-ledger relies on; the others it reads are older or vendor spellings, kept for compatibility
    const need = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.provider.name', 'gen_ai.operation.name', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.conversation.id', 'gen_ai.agent.name'];
    const read = new Set(['harness-ledger/src/importers.mjs', 'harness-ledger/src/gpu.mjs'].flatMap(f => rd(f).match(/'gen_ai\.[a-z_.]+'/g) || []).map(s => s.slice(1, -1)));
    // per-modality breakdowns (text/image/audio) are parts of input_tokens / output_tokens, which are read: not needed for cost
    const gone = need.filter(k => !keys.has(k)), unread = [...keys].filter(k => /^gen_ai\.usage\./.test(k) && !/\.(text|image|audio)\./.test(k) && !read.has(k));
    return gone.length ? { status: 'breaking', detail: `no longer in the GenAI registry: ${gone.join(', ')}` } : unread.length ? { status: 'newer', detail: `usage attributes in the registry that harness-ledger doesn't read yet: ${unread.join(', ')}` } : { status: 'ok', detail: `${need.length} standard attributes present` };
  },
  async openinference() {
    const py = await raw('Arize-ai/openinference', 'main', 'python/openinference-semantic-conventions/src/openinference/semconv/trace/__init__.py');
    const read = [...new Set(rd('harness-ledger/src/importers.mjs').match(/'(llm|openinference)\.[a-z_.]+'/g) || [])].map(s => s.slice(1, -1));
    const gone = read.filter(k => !py.includes(`"${k}"`));
    return gone.length ? { status: 'breaking', detail: `OpenInference no longer defines ${gone.join(', ')}` } : { status: 'ok', detail: `${read.length} attributes present` };
  },
  async 'datasets'() {
    const out = [];
    const tl = await latestTag('uw-syfi/TraceLab'); if (tl !== 'v0.0.2') out.push(`TraceLab ${tl} is out (pinned v0.0.2 in fleetscope/tools/tracelab-data.mjs)`);
    return out.length ? { status: 'newer', detail: out.join('; ') } : { status: 'ok', detail: 'TraceLab v0.0.2 is still the latest release' };
  },
};

const a = process.argv.slice(2), only = a.includes('--only') ? a[a.indexOf('--only') + 1].split(',') : null;
const results = [];
for (const [name, fn] of Object.entries(CHECKS)) {
  if (only && !only.includes(name)) continue;
  try { results.push(Object.assign({ name }, await fn())); } catch (e) { results.push({ name, status: 'error', detail: e.message }); }
}
if (a.includes('--json')) console.log(JSON.stringify(results, null, 1));
else {
  console.log('| Format | Status | Detail |\n| --- | --- | --- |');
  for (const r of results) console.log(`| ${r.name} | ${r.status === 'ok' ? 'ok' : r.status === 'newer' ? 'newer upstream' : `**${r.status}**`} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
}
// breaking fails the run; an upstream that couldn't be reached is reported, not failed on
process.exitCode = results.some(r => r.status === 'breaking') ? 1 : 0;
