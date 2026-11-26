// Shadow upgrades from a canary's own metrics, and the judge inside Argo Rollouts and Flagger:
//  - windows from Prometheus (a mock that answers exactly the queries we send) judged at matched load: a canary 8%
//    slower that runs at half the load per engine looks 20% faster per version and is rolled back; the same canary
//    without the regression is promoted; a latency knee near saturation doesn't fool it;
//  - every vLLM metric the queries use exists in vLLM's own metric list (fixtures/real/vllm);
//  - selectors are label matchers or nothing: PromQL can't be smuggled in;
//  - the judge's HTTP answers for Argo (web metric) and Flagger (rollout / confirm-promotion webhooks), auth, errors;
//  - the shipped manifests pass the real CRD schemas (Argo Rollouts v1.9.3, Flagger v1.45.0, Prometheus Operator
//    v0.95.2) with no unknown fields, the bodies they send after templating are accepted, and the judge starts from the
//    Deployment's own arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as P from '../src/shadow-prom.mjs';
import { gateServer, params } from '../src/shadow-gate.mjs';
import { validate } from './crd-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), REAL = path.join(here, 'fixtures', 'real'), DEPLOY = path.join(here, '..', 'deploy', 'shadow-gate');
const CLI = path.join(here, '..', 'tools', 'fleetops.mjs'), require = createRequire(import.meta.url);
let YAML = null; try { YAML = require('yaml'); } catch { /* optional */ }
const crd = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, 'rollouts', f))).toString());
const docs = f => YAML.parseAllDocuments(fs.readFileSync(path.join(DEPLOY, f), 'utf8')).map(d => d.toJSON()).filter(Boolean);

// A Prometheus that knows two versions' windows and answers the exact queries shadow-prom builds for each selector.
function mockProm(arms) {
  const answers = new Map(), seen = [];
  for (const [sel, ws] of Object.entries(arms)) { const s = P.seriesOf(ws), q = P.queries(sel, 60); for (const [k, query] of Object.entries(q)) answers.set(query, s[k] || []); }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://p'); if (u.pathname !== '/api/v1/query_range') { res.writeHead(404); return res.end(); }
    const q = u.searchParams.get('query'), from = +u.searchParams.get('start'), to = +u.searchParams.get('end'); seen.push(q);
    const vals = (answers.get(q) || []).filter(([t]) => t >= from && t <= to);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: answers.has(q) ? [{ metric: {}, values: vals }] : [] } }));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), seen })));
}
const B = 'llm_isvc_name="chat-v1"', C = 'llm_isvc_name="chat-v2"', SEL = 'namespace="llm"';
const span = ws => ({ from: ws[0].t, to: ws[ws.length - 1].t });

test('a canary at half the load per engine, 8% slower: dashboards say 20% faster, matched load says roll back', async () => {
  const d = P.synthWindows();
  const prom = await mockProm({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate });
  try {
    const got = await P.fetchArms(prom.url, { select: SEL, baseline: B, candidate: C, ...span(d.baseline), step: 60 });
    assert.equal(got.baseline.length, 240); assert.equal(got.candidate.length, 240);
    assert.ok(prom.seen.every(q => q.includes('llm_isvc_name=') && q.includes('namespace="llm"')), 'every query carries both matchers');
    const r = P.compareWindows(got.baseline, got.candidate, { step: 60 });
    assert.equal(r.decision, 'roll back'); assert.equal(r.verdict, 'rollback');
    assert.ok(r.metrics.tpot.naive < -0.15, `naive ${r.metrics.tpot.naive}`);
    assert.ok(r.metrics.tpot.lo > 0.05 && Math.abs(r.metrics.tpot.effect - 0.08) < 0.015, JSON.stringify(r.metrics.tpot));
    assert.equal(r.metrics.ttft.verdict, 'same');
    assert.ok(r.load.candidate.concPerEngine < 0.6 * r.load.baseline.concPerEngine);
    // saved series replay to the same verdict
    const saved = JSON.parse(JSON.stringify((({ baseline, candidate, ...k }) => k)(got)));
    const again = P.fromSaved(saved), r2 = P.compareWindows(again.baseline, again.candidate, { step: 60 });
    assert.equal(r2.decision, r.decision); assert.equal(r2.metrics.tpot.effect, r.metrics.tpot.effect);
  } finally { prom.close(); }
});

test('the same canary without the regression is promoted; a 12% regression at a quarter of the load is caught', () => {
  for (const seed of [5, 9, 21]) {
    const d = P.synthWindows({ seed, slower: 0 }), r = P.compareWindows(d.baseline, d.candidate);
    assert.equal(r.decision, 'promote', `seed ${seed}: ${r.why}`);
    for (const m of ['ttft', 'tpot', 'e2e']) assert.ok(Math.abs(r.metrics[m].effect) < 0.012, `${m} ${r.metrics[m].effect}`);
  }
  const q = P.synthWindows({ slower: 0.12, loadShare: 0.25 }), r = P.compareWindows(q.baseline, q.candidate);
  assert.equal(r.decision, 'roll back'); assert.ok(Math.abs(r.metrics.tpot.effect - 0.12) < 0.02);
  assert.ok(r.metrics.tpot.coverage < 0.9, 'a canary far below the baseline\'s load range is partly left out, not extrapolated');
});

test('a latency knee near saturation: local fits follow it (a global curve was off by 4.6%)', () => {
  const d = P.synthWindows({ slower: 0 }); let s = 7; const u = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const knee = (ws, k) => ws.map(w => { const tp = 0.015 * (1 + 0.4 * w.conc / Math.max(1, 32 - w.conc)) * k * (1 + 0.02 * (u() - 0.5)); return Object.assign({}, w, { tpot: tp, e2e: w.ttft + tp * w.osl }); });
  const same = P.compareWindows(knee(d.baseline, 1), knee(d.candidate, 1)), worse = P.compareWindows(knee(d.baseline, 1), knee(d.candidate, 1.08));
  assert.ok(Math.abs(same.metrics.tpot.effect) < 0.01, `${same.metrics.tpot.effect}`); assert.equal(same.decision, 'promote');
  assert.ok(Math.abs(worse.metrics.tpot.effect - 0.08) < 0.01, `${worse.metrics.tpot.effect}`); assert.equal(worse.decision, 'roll back');
});

test('too little canary traffic waits; errors are judged as a rate', () => {
  const d = P.synthWindows(), few = P.compareWindows(d.baseline, d.candidate.slice(0, 2));
  assert.equal(few.verdict, 'wait');
  const bad = d.candidate.map(w => Object.assign({}, w, { errors: Math.round(w.finished * 0.03) })), r = P.compareWindows(d.baseline, bad);
  assert.equal(r.metrics.errorRate.verdict, 'worse'); assert.equal(r.verdict, 'rollback');
});

test('every vLLM metric the queries use is one vLLM exports (vllm/v1/metrics/loggers.py)', () => {
  const names = new Set(fs.readFileSync(path.join(REAL, 'vllm', 'metric-names.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')));
  const used = new Set(Object.values(P.queries('a="b"')).join(' ').match(/vllm:[a-z0-9_]+/g));
  assert.ok(used.size >= 14);
  for (const m of used) assert.ok(names.has(m), `${m} is not a vLLM metric`);
  assert.match(fs.readFileSync(path.join(REAL, 'vllm', 'metric-names.txt'), 'utf8'), /finished_reason values: .*abort error/);
});

test('selectors are label matchers only', () => {
  assert.equal(P.checkSelector('{llm_isvc_name="a", namespace=~"llm|prod"}'), 'llm_isvc_name="a",namespace=~"llm|prod"');
  assert.equal(P.checkSelector('app="x,y"'), 'app="x,y"', 'a comma inside quotes is part of the value');
  for (const bad of ['a="x"} or vector(1) #', 'up', 'a=x', 'a="x", sum(rate(b[5m]))', 'a="x"}[5m]) + on() group_left vector(1', '']) assert.throws(() => P.checkSelector(bad), undefined, bad);
  assert.throws(() => params({ baseline: 'a="x"', candidate: 'b' }), /not a label matcher/);
  assert.throws(() => params({ baseline: 'a="x"', candidate: 'a="y"', lookback: '5' }), /seconds between/);
});

async function withGate(arms, fn, opt = {}) {
  const prom = await mockProm(arms), log = [];
  const all = Object.values(arms)[0], { to } = span(all);
  const evaluate = async p => { const d = await P.fetchArms(opt.promUrl || prom.url, { select: p.select, baseline: p.baseline, candidate: p.candidate, from: to - p.lookback, to, baselineFrom: to - Math.max(p.lookback, p.baselineLookback), step: 60 }); return P.compareWindows(d.baseline, d.candidate, { step: 60 }); };
  const srv = gateServer(evaluate, { defaults: { lookback: 7200, baselineLookback: 14400, select: SEL }, log: e => log.push(e), tokens: opt.tokens || null });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body, headers = {}) => { const r = await fetch(base + p, body === undefined ? { headers } : { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ } return { status: r.status, j, t }; };
  try { await fn(call, log); } finally { srv.close(); prom.close(); }
}

test('the judge for Argo Rollouts and Flagger: rollback on a slower canary', async () => {
  const d = P.synthWindows();
  await withGate({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate }, async (call, log) => {
    assert.equal((await call('/healthz')).status, 200);
    const v = await call('/verdict', { baseline: B, candidate: C });
    assert.equal(v.status, 200); assert.equal(v.j.verdict, 'rollback'); assert.match(v.j.why, /tpot/);
    const g = await call(`/verdict?baseline=${encodeURIComponent(B)}&candidate=${encodeURIComponent(C)}`);
    assert.equal(g.j.verdict, 'rollback', 'GET with query parameters too');
    const meta = { name: 'chat', namespace: 'llm', phase: 'Progressing', metadata: { baseline: B, candidate: C } };
    assert.equal((await call('/flagger/rollout', meta)).status, 412, 'a failed check');
    assert.equal((await call('/flagger/confirm-promotion', meta)).status, 412, 'promotion held');
    assert.equal(log.length, 4); assert.ok(log.every(e => e.verdict === 'rollback' && e.baseline === B));
    assert.equal((await call('/verdict', { baseline: B, candidate: 'up' })).status, 400);
    assert.equal((await call('/nothing', {})).status, 404);
  });
});

test('the judge promotes a canary that is the same at matched load, and says wait while it is short of traffic', async () => {
  const d = P.synthWindows({ slower: 0 });
  await withGate({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate }, async call => {
    const meta = { metadata: { baseline: B, candidate: C } };
    const v = await call('/verdict', { baseline: B, candidate: C }); assert.equal(v.j.verdict, 'promote', v.j.why);
    assert.equal((await call('/flagger/rollout', meta)).status, 200);
    assert.equal((await call('/flagger/confirm-promotion', meta)).status, 200);
    const short = await call('/verdict', { baseline: B, candidate: C, lookback: 120 });
    assert.equal(short.j.verdict, 'wait');
    assert.equal((await call('/flagger/rollout', { metadata: { baseline: B, candidate: C, lookback: '120' } })).status, 200, 'waiting is not a failed check');
    assert.equal((await call('/flagger/confirm-promotion', { metadata: { baseline: B, candidate: C, lookback: '120' } })).status, 412, 'but it holds the promotion');
  });
});

test('the judge: Prometheus down is a 502 (Argo counts it as an error, not a verdict); tokens when given', async () => {
  const d = P.synthWindows({ slower: 0 }), tok = 'judge-test-token-1234567890';
  const tokens = [{ name: 'argo', roles: ['read'], sha256: require('node:crypto').createHash('sha256').update(tok).digest('hex') }];
  await withGate({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate }, async call => {
    assert.equal((await call('/verdict', { baseline: B, candidate: C })).status, 401);
    assert.equal((await call('/healthz')).status, 200, 'probes need no token');
    assert.equal((await call('/verdict', { baseline: B, candidate: C }, { authorization: `Bearer ${tok}` })).j.verdict, 'promote');
  }, { tokens });
  await withGate({ [P.join(SEL, B)]: d.baseline }, async call => { assert.equal((await call('/verdict', { baseline: B, candidate: C })).status, 502); }, { promUrl: 'http://127.0.0.1:1' });
});

test('the manifests pass the real CRD schemas, and what they send is what the judge accepts', { skip: !YAML && 'yaml not installed' }, () => {
  const checks = [['argo-analysistemplate.yaml', 'AnalysisTemplate', 'argo-rollouts-analysistemplate.crd-v1alpha1.schema.json.gz'], ['argo-rollout-example.yaml', 'Rollout', 'argo-rollouts-rollout.crd-v1alpha1.schema.json.gz'],
    ['flagger-canary.yaml', 'Canary', 'flagger-canary.crd-v1beta1.schema.json.gz'], ['podmonitor-vllm.yaml', 'PodMonitor', 'prometheus-operator-podmonitor.crd-v1.schema.json.gz']];
  for (const [f, kind, schema] of checks) {
    const c = crd(schema), m = docs(f).find(x => x.kind === kind);
    assert.equal(m.apiVersion, `${c.group}/${c.version}`, f);
    assert.deepEqual(validate(c.openAPIV3Schema, m), [], f);
  }
  // the validator does catch mistakes in these schemas
  const at = docs('argo-analysistemplate.yaml')[0], bad = JSON.parse(JSON.stringify(at)); bad.spec.metrics[0].provider.web.jsonpath = '{$.verdict}'; bad.spec.metrics[0].count = 'ten';
  const e = validate(crd('argo-rollouts-analysistemplate.crd-v1alpha1.schema.json.gz').openAPIV3Schema, bad);
  assert.ok(e.some(x => /unknown field jsonpath$/.test(x)), e.join('\n'));

  // Argo: the args it fills in (podTemplateHashValue), templated into jsonBody, make a request the judge accepts
  const m = at.spec.metrics[0], vals = Object.fromEntries(at.spec.args.map(a => [a.name, a.value])); Object.assign(vals, { 'stable-hash': '6b9f7c', 'canary-hash': '84d2aa' });
  const body = JSON.parse(JSON.stringify(m.provider.web.jsonBody).replace(/\{\{args\.([\w-]+)\}\}/g, (_, k) => String(vals[k]).replace(/"/g, '\\"')));
  const p = params(body);
  assert.equal(p.baseline, 'rollouts_pod_template_hash="6b9f7c"'); assert.equal(p.candidate, 'rollouts_pod_template_hash="84d2aa"'); assert.equal(p.select, 'namespace="llm",app="chat"'); assert.equal(p.lookback, 900);
  assert.equal(m.provider.web.jsonPath, '{$.verdict}'); assert.match(m.successCondition, /"promote"/); assert.match(m.failureCondition, /"rollback"/);
  // the Rollout passes both hashes to the template it names
  const ro = docs('argo-rollout-example.yaml')[0], steps = ro.spec.strategy.canary.steps.filter(s => s.analysis);
  assert.ok(steps.length >= 1 && steps.every(s => s.analysis.templates[0].templateName === at.metadata.name && s.analysis.args.map(a => a.valueFrom.podTemplateHashValue).join() === 'Stable,Latest'));
  // Flagger: webhook metadata is the judge's request; types are the ones Flagger runs during analysis and before promotion
  const cn = docs('flagger-canary.yaml')[0];
  assert.deepEqual(cn.spec.analysis.webhooks.map(w => w.type), ['rollout', 'confirm-promotion']);
  for (const w of cn.spec.analysis.webhooks) { const q = params(w.metadata); assert.equal(q.candidate, `app="${cn.spec.targetRef.name}"`); assert.equal(q.baseline, `app="${cn.spec.targetRef.name}-primary"`); assert.match(w.url, /\/flagger\/(rollout|confirm-promotion)$/); }
  // the PodMonitor makes the labels the selectors use
  const targets = docs('podmonitor-vllm.yaml')[0].spec.podMetricsEndpoints[0].relabelings.map(r => r.targetLabel);
  for (const l of ['llm_isvc_name', 'rollouts_pod_template_hash', 'app', 'namespace']) assert.ok(targets.includes(l), l);
});

test('the judge starts from the Deployment\'s own arguments and answers', { skip: !YAML && 'yaml not installed' }, async () => {
  const d = P.synthWindows({ slower: 0, t0: Math.floor(Date.now() / 1000) - 240 * 60 });
  const prom = await mockProm({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate });
  const dep = docs('judge.yaml').find(x => x.kind === 'Deployment'), c = dep.spec.template.spec.containers[0], args = [...c.args];
  const set = (k, v) => { args[args.indexOf(k) + 1] = v; };
  set('--prom', prom.url); set('--host', '127.0.0.1'); set('--port', '0'); set('--store', fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')));
  const port = 20000 + Math.floor(Math.random() * 20000); set('--port', String(port));
  const env = Object.assign({}, process.env, Object.fromEntries(c.env.map(e => [e.name, e.value])));
  env.FLEETOPS_EGRESS_ALLOW = ''; // localhost is always allowed; nothing else may be called
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = ''; child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { out += x; });
    for (let i = 0; i < 50 && !/shadow judge on/.test(out); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(out, /shadow judge on http:\/\/127\.0\.0\.1/);
    const r = await fetch(`http://127.0.0.1:${port}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ select: SEL, baseline: B, candidate: C, lookback: 3600 }) });
    const j = await r.json(); assert.equal(r.status, 200); assert.ok(['promote', 'wait'].includes(j.verdict), j.why);
    assert.ok(j.requests.candidate > 0);
  } finally { child.kill(); prom.close(); }
});

test('CLI: shadow prom --demo, --save and --file give the same verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprom-'));
  const run = a => JSON.parse(execFileSync(process.execPath, [CLI, 'shadow', 'prom', ...a, '--store', dir, '--json'], { encoding: 'utf8' }));
  const demo = run(['--demo']).shadow; assert.equal(demo.decision, 'roll back');
  const text = execFileSync(process.execPath, [CLI, 'shadow', 'prom', '--demo', '--store', dir], { encoding: 'utf8' });
  assert.match(text, /ROLL BACK: worse on tpot/); assert.match(text, /in flight per engine/);
  const d = P.synthWindows();
  const prom = await mockProm({ [P.join(SEL, B)]: d.baseline, [P.join(SEL, C)]: d.candidate });
  try {
    const f = path.join(dir, 'saved.json'), { from, to } = span(d.baseline);
    const live = JSON.parse(await new Promise((res, rej) => { const ch = spawn(process.execPath, [CLI, 'shadow', 'prom', '--prom', prom.url, '--select', SEL, '--baseline', B, '--candidate', C, '--from', String(from), '--to', String(to), '--save', f, '--store', dir, '--json']); let o = ''; ch.stdout.on('data', x => { o += x; }); ch.on('close', c => (c ? rej(new Error(o)) : res(o))); })).shadow;
    assert.equal(live.decision, 'roll back');
    const again = run(['--file', f]).shadow; assert.equal(again.metrics.tpot.effect, live.metrics.tpot.effect);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).kind, 'fleetops.shadow-prom');
  } finally { prom.close(); }
  assert.ok(fs.readFileSync(path.join(dir, 'shadow', 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).length >= 3);
});

test('the L4 live-run kit: versions, labels, GPUs, load and script are consistent', { skip: !YAML && 'yaml not installed' }, () => {
  const LIVE = path.join(here, '..', 'deploy', 'shadow-live'), all = f => YAML.parseAllDocuments(fs.readFileSync(path.join(LIVE, f), 'utf8')).map(d => d.toJSON()).filter(Boolean);
  const kit = all('kit.yaml'), dep = n => kit.find(x => x.kind === 'Deployment' && x.metadata.name === n), svc = n => kit.find(x => x.kind === 'Service' && x.metadata.name === n);
  for (const n of ['chat-v1', 'chat-v2']) {
    const d = dep(n), t = d.spec.template, c = t.spec.containers[0];
    assert.equal(t.metadata.labels['app.kubernetes.io/name'], n, 'the label Prometheus turns into llm_isvc_name'); assert.equal(t.metadata.labels.app, 'chat');
    assert.deepEqual(d.spec.selector.matchLabels, { 'app.kubernetes.io/name': n });
    assert.equal(c.resources.limits['nvidia.com/gpu'], 1); assert.equal(t.spec.nodeSelector['nvidia.com/gpu.product'], 'NVIDIA-L4');
    assert.equal(c.ports[0].name, 'http'); assert.equal(c.args[c.args.indexOf('--served-model-name') + 1], 'chat');
  }
  assert.equal(dep('chat-v1').spec.replicas + dep('chat-v2').spec.replicas, 3, 'three L4 GPUs');
  const diff = dep('chat-v2').spec.template.spec.containers[0].args.filter(a => !dep('chat-v1').spec.template.spec.containers[0].args.includes(a));
  assert.deepEqual(diff, ['--no-enable-prefix-caching'], 'the candidate differs by exactly the change under test');
  assert.deepEqual(svc('chat').spec.selector, { app: 'chat' }); assert.deepEqual(svc('chat-v2').spec.selector, { 'app.kubernetes.io/name': 'chat-v2' });
  const cfg = YAML.parse(kit.find(x => x.kind === 'ConfigMap').data['prometheus.yml']), rl = cfg.scrape_configs[0].relabel_configs;
  assert.ok(rl.some(r => r.source_labels[0] === '__meta_kubernetes_pod_label_app_kubernetes_io_name' && r.target_label === 'llm_isvc_name'));
  assert.ok(rl.some(r => r.target_label === 'namespace'));
  const job = all('load-canary.yaml')[0], script = job.spec.template.spec.containers[0].args[0];
  assert.match(script, /--base-url http:\/\/chat\.shadow-live\.svc:8000/); assert.match(script, /--random-prefix-len 1500/);
  assert.equal(job.spec.template.spec.containers[0].image, dep('chat-v1').spec.template.spec.containers[0].image, 'the image the nodes already pulled');
  // the script: valid bash, sends nothing unless --yes, and only uses fleetops flags that exist
  const sh = fs.readFileSync(path.join(LIVE, 'run.sh'), 'utf8'); execFileSync('bash', ['-n', path.join(LIVE, 'run.sh')]);
  assert.match(sh, /--yes\) live="--live"/); assert.ok(!/ --live\b/.test(sh.replace(/live="--live"/, '')), 'no hard-coded --live');
  const help = execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' });
  for (const flag of new Set(sh.match(/(?<=\s)--[a-z][a-z-]+(?=[\s"])/g))) {
    if (['--yes', '--keep', '--timeout', '--replicas', '--ignore-not-found', '--wait', '--for', '-o'].includes(flag)) continue;
    assert.ok(help.includes(flag) || ['--sessions-per-hour', '--model', '--results', '--answers', '--out'].includes(flag), `${flag} is not a fleetops flag`);
  }
});
