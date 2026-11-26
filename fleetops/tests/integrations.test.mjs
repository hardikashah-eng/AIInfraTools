// Integrations with what clusters already run, and the loop between the tools:
//  - NVSentinel health events (every shape it emits: event-exporter CloudEvents, datastore documents, HealthEventResource
//    objects, bare events) → log records; the nodes it is remediating; gpu-health defers to it instead of queueing a
//    second repair ladder for the same node;
//  - an llm-d canary (two LLMInferenceServices, KServe v1alpha2 route group/weight) stepped by the judge: rollback is
//    written at once with --live, a step up is only ever queued for a person, and nothing is written without --live.
//    These tests never approve a step: approval is a person's;
//  - a shadow verdict whose prediction was off refits the sizer's efficiencies into the calibration profile that plan,
//    the Inference Sizer and harness-ledger economics read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nvsentinelEvents, remediating } from '../src/adapters/nvsentinel.mjs';
import * as Canary from '../src/shadow-canary.mjs';
import * as S from '../src/shadow.mjs';
import * as P from '../src/shadow-prom.mjs';
import { validate } from './crd-schema.mjs';
import { analyze } from '../../gpu-health/src/analyze.mjs';
import { loadConfig } from '../../gpu-health/src/config.mjs';
import { demoSamples, demoJobs, demoSteps, demoProbes, demoCluster, demoResults, DEMO_NOW } from '../../gpu-health/src/synth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), FX = path.join(here, 'fixtures'), CLI = path.join(here, '..', 'tools', 'fleetops.mjs');
const HL = path.join(here, '..', '..', 'harness-ledger', 'tools', 'harness-ledger.mjs'), require = createRequire(import.meta.url);
let YAML = null; try { YAML = require('yaml'); } catch { /* optional */ }
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (args, opt = {}) => execFileSync(process.execPath, [CLI, ...args], Object.assign({ encoding: 'utf8' }, opt));
// for calls that reach a mock server in this process: a synchronous child would block the server's event loop
const acli = args => new Promise((res, rej) => { const ch = spawn(process.execPath, [CLI, ...args]); let o = '', e = ''; ch.stdout.on('data', x => { o += x; }); ch.stderr.on('data', x => { e += x; }); ch.on('close', c => (c ? rej(new Error(e || o)) : res(o))); });

test('NVSentinel: every event shape becomes a log record, XIDs through gpu-health\'s table', () => {
  const r = nvsentinelEvents(fs.readFileSync(path.join(FX, 'nvsentinel-events.jsonl'), 'utf8'));
  assert.equal(r.unmatched, 1, 'a Pod is not a health event');
  const by = n => r.logs.filter(l => l.node === n);
  const xid = by('gpu-07')[0];
  assert.deepEqual([xid.code, xid.class, xid.severity, xid.gpu, xid.pci, xid.cluster, xid.recommendedAction, xid.remediating], ['xid79', 'bus', 'hard', '3', '0000:3b:00.0', 'prod-a', 'RESTART_BM', true]);
  const x48 = by('gpu-02')[0]; assert.equal(x48.code, 'xid48'); assert.equal(x48.recommendedAction, 'COMPONENT_RESET', 'numeric enum'); assert.equal(x48.remediating, false, 'STORE_ONLY: NVSentinel only records it');
  const mem = by('gpu-11')[0]; assert.deepEqual([mem.class, mem.quarantine, mem.remediated, mem.remediationAction, mem.t], ['ecc', 'Quarantined', false, 'COMPONENT_RESET', 1795172400]);
  assert.equal(by('gpu-04')[0].remediating, false, 'nothing recommended: nothing to defer to');
  const nv = by('gpu-09'); assert.equal(nv[0].class, 'link'); assert.equal(nv[1].severity, 'info'); assert.equal(nv[1].healthy, true);
  const crs = nvsentinelEvents(fs.readFileSync(path.join(FX, 'nvsentinel-healtheventresources.json'), 'utf8')).logs;
  assert.deepEqual([crs[0].class, crs[0].quarantine, crs[0].remediating], ['network', 'AlreadyQuarantined', false]);
  // remediating now: the XID 79 and the ECC fault; the NVLink fault was cleared by a healthy event
  const rem = remediating(r.logs, { now: 1795172400 + 4 * 3600 });
  assert.deepEqual([...rem.keys()].sort(), ['gpu-07/3', 'gpu-11/5']);
  assert.equal(remediating(r.logs, { now: 1795172400 + 3 * 86400 }).size, 0, 'old events expire');
});

test('NVSentinel through fleetops into gpu-health: faults arrive, and the remediating nodes are deferred', () => {
  const store = tmp('nvs-'), out = tmp('nvs-gh-');
  cli(['data', 'import', 'nvsentinel', path.join(FX, 'nvsentinel-events.jsonl'), '--store', store], { stdio: ['ignore', 'pipe', 'pipe'] });
  cli(['data', 'export', 'gpu-health', '--out', out, '--from', '2026-11-20T00:00:00Z', '--to', '2026-11-20T15:00:00Z', '--store', store]);
  const res = fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(res.some(x => x.kind === 'fault' && x.source === 'nvsentinel' && x.code === 'xid79' && x.gpu === '3'));
  const ext = res.filter(x => x.kind === 'external-remediation');
  assert.deepEqual(ext.map(x => `${x.node}/${x.gpu}:${x.action}`).sort(), ['gpu-07/3:RESTART_BM', 'gpu-11/5:COMPONENT_RESET']);
});

test('gpu-health defers to an external remediator: no second repair ladder for a node NVSentinel is handling', () => {
  const cfg = loadConfig({ pricePerGpuHour: { B200: 6, H200: 4.5 } }), base = { samples: demoSamples(), jobs: demoJobs(), steps: demoSteps(), probes: demoProbes(), cluster: demoCluster(), now: DEMO_NOW };
  const a0 = analyze(Object.assign({}, base, { results: demoResults(), cfg }));
  const repair = a0.suggestions.find(s => s.node && ['quarantine', 'run-diag', 'gpu-reset', 'node-reboot', 'deep-diag-next-boundary'].includes(s.kind));
  assert.ok(repair, 'the demo has a repair to defer');
  const ext = { t: DEMO_NOW - 600, kind: 'external-remediation', node: repair.node, by: 'nvsentinel', action: 'COMPONENT_RESET', check: 'GpuMemWatch' };
  const a1 = analyze(Object.assign({}, base, { results: [...demoResults(), ext], cfg }));
  const onNode = a1.suggestions.filter(s => s.node === repair.node);
  assert.ok(!onNode.some(s => ['quarantine', 'run-diag', 'gpu-reset', 'node-reboot', 'deep-diag-next-boundary', 'drain-inference', 'swap-at-checkpoint'].includes(s.kind)), onNode.map(s => s.kind).join(','));
  const info = onNode.find(s => s.kind === 'external-remediation');
  assert.ok(info && info.mode === 'never' && /nvsentinel is remediating/.test(info.reason), 'shown, never run');
  assert.ok(a1.suggestions.filter(s => s.node !== repair.node).length === a0.suggestions.filter(s => s.node !== repair.node).length, 'other nodes untouched');
  const a2 = analyze(Object.assign({}, base, { results: [...demoResults(), ext], cfg: loadConfig({ pricePerGpuHour: { B200: 6, H200: 4.5 }, deferToExternal: false }) }));
  assert.ok(a2.suggestions.some(s => s.node === repair.node && s.kind === repair.kind), 'deferToExternal: false keeps gpu-health\'s own');
  const stale = analyze(Object.assign({}, base, { results: [...demoResults(), Object.assign({}, ext, { t: DEMO_NOW - 3 * 86400 })], cfg }));
  assert.ok(stale.suggestions.some(s => s.node === repair.node && s.kind === repair.kind), 'a remediation older than a day is not deferred to');
});

// a stand-in kubectl that records its arguments
function stubKubectl() {
  const dir = tmp('kubectl-'), log = path.join(dir, 'calls.jsonl'), bin = path.join(dir, 'kubectl');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('patched');\n`); fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) };
}
function mockProm(arms) {
  const answers = new Map();
  for (const [sel, ws] of Object.entries(arms)) { const s = P.seriesOf(ws); for (const [k, q] of Object.entries(P.queries(sel, 60))) answers.set(q, s[k] || []); }
  const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://p'), q = u.searchParams.get('query'), a = +u.searchParams.get('start'), b = +u.searchParams.get('end'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: answers.has(q) ? [{ metric: {}, values: answers.get(q).filter(([t]) => t >= a && t <= b) }] : [] } })); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}
const armsFor = (st, w) => { const sel = Canary.selectors(st); return { [P.join(sel.select, sel.baseline)]: w.baseline, [P.join(sel.select, sel.candidate)]: w.candidate }; };
const recent = o => P.synthWindows(Object.assign({ t0: Math.floor(Date.now() / 1000) - 240 * 60 }, o));

test('llm-d canary: start writes both weights only with --live; a slower candidate is rolled back to 0 at once', async () => {
  const store = tmp('canary-'), k = stubKubectl(), base = ['--name', 'chat', '--store', store, '--kubectl', k.bin];
  const dry = cli(['shadow', 'canary', 'start', ...base, '--namespace', 'llm', '--group', 'chat', '--baseline', 'chat-v1', '--candidate', 'chat-v2']);
  assert.match(dry, /dry run/); assert.equal(k.calls().length, 0, 'nothing written without --live');
  assert.ok(!fs.existsSync(path.join(store, 'shadow', 'canaries', 'chat.json')), 'a dry run starts nothing');
  cli(['shadow', 'canary', 'start', ...base, '--namespace', 'llm', '--group', 'chat', '--baseline', 'chat-v1', '--candidate', 'chat-v2', '--bake', '0', '--live']);
  const c0 = k.calls(); assert.equal(c0.length, 2);
  assert.deepEqual(c0.map(a => [a[0], a[1], a[2], a[4], JSON.parse(a[8]).spec.router.route]), [['patch', 'llminferenceservice', 'chat-v1', 'llm', { group: 'chat', weight: 990000 }], ['patch', 'llminferenceservice', 'chat-v2', 'llm', { group: 'chat', weight: 10000 }]]);
  // the canary has been at its step for an hour (the mock Prometheus holds that hour of traffic)
  const sf = path.join(store, 'shadow', 'canaries', 'chat.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8')); st.since -= 3600; fs.writeFileSync(sf, JSON.stringify(st));
  const prom = await mockProm(armsFor(st, recent({ slower: 0.12, loadShare: 0.5 })));
  try {
    const dryRb = JSON.parse(await acli(['shadow', 'canary', 'advance', ...base, '--prom', prom.url, '--json'])).canary;
    assert.equal(dryRb.action.type, 'rollback'); assert.equal(dryRb.apply.dryRun, true); assert.equal(k.calls().length, 2, 'a rollback without --live writes nothing');
    assert.equal(JSON.parse(cli(['shadow', 'canary', 'status', ...base, '--json'])).canary.status, 'running', 'and changes nothing');
    const rb = JSON.parse(await acli(['shadow', 'canary', 'advance', ...base, '--prom', prom.url, '--live', '--json'])).canary;
    assert.equal(rb.verdict, 'rollback'); assert.match(rb.why, /tpot/);
    const c1 = k.calls().slice(2); assert.deepEqual(c1.map(a => [a[2], JSON.parse(a[8]).spec.router.route.weight]), [['chat-v1', 1000000], ['chat-v2', 0]]);
    assert.equal(rb.state.status, 'rolled back');
    const after = JSON.parse(await acli(['shadow', 'canary', 'advance', ...base, '--prom', prom.url, '--live', '--json'])).canary;
    assert.equal(after.action.type, 'stopped'); assert.equal(k.calls().length, 4, 'a rolled-back canary stays rolled back');
  } finally { prom.close(); }
});

test('llm-d canary: a good candidate is never stepped up without a person: the step is queued, and stays queued', async () => {
  const store = tmp('canary-ok-'), k = stubKubectl(), base = ['--name', 'chat', '--store', store, '--kubectl', k.bin];
  cli(['shadow', 'canary', 'start', ...base, '--namespace', 'llm', '--group', 'chat', '--baseline', 'chat-v1', '--candidate', 'chat-v2', '--bake', '0', '--live']);
  // the canary has been at its step for an hour (the mock Prometheus holds that hour of traffic)
  const sf = path.join(store, 'shadow', 'canaries', 'chat.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8')); st.since -= 3600; fs.writeFileSync(sf, JSON.stringify(st));
  const prom = await mockProm(armsFor(st, recent({ slower: 0 })));
  try {
    const q = JSON.parse(await acli(['shadow', 'canary', 'advance', ...base, '--prom', prom.url, '--live', '--json'])).canary;
    assert.equal(q.verdict, 'promote'); assert.equal(q.action.type, 'queued'); assert.equal(q.apply, null); assert.equal(k.calls().length, 2, 'promote writes nothing');
    assert.match(q.action.note, /approve --name chat --by NAME/);
    const again = JSON.parse(await acli(['shadow', 'canary', 'advance', ...base, '--prom', prom.url, '--live', '--json'])).canary;
    assert.equal(again.action.type, 'awaiting-approval'); assert.equal(k.calls().length, 2);
    const status = JSON.parse(cli(['shadow', 'canary', 'status', ...base, '--json'])).canary;
    assert.equal(Canary.share(status), 1); assert.equal(status.pending.toStep, 1); assert.equal(status.pending.approvedBy, undefined);
    const noBy = spawnSync(process.execPath, [CLI, 'shadow', 'canary', 'approve', ...base], { encoding: 'utf8' });
    assert.notEqual(noBy.status, 0); assert.match(noBy.stderr, /approver name required/);
  } finally { prom.close(); }
});

test('llm-d canary pieces: weights, selectors, bake time, and the manifests pass KServe\'s CRD schema', { skip: !YAML && 'yaml not installed' }, () => {
  assert.deepEqual(Canary.weightsFor(25), { baseline: 750000, candidate: 250000 }); assert.deepEqual(Canary.weightsFor(100), { baseline: 0, candidate: 1000000 });
  const st = Canary.start({ name: 'c', namespace: 'llm', group: 'chat', baseline: 'v1', candidate: 'v2', now: 1000 });
  assert.deepEqual(Canary.selectors(st), { select: 'namespace="llm"', baseline: 'llm_isvc_name="v1"', candidate: 'llm_isvc_name="v2"' });
  assert.equal(Canary.decide(st, 'promote', { now: 1100 }).action.type, 'bake', 'ten minutes at a step before a step up');
  assert.equal(Canary.decide(st, 'wait', { now: 5000 }).action.type, 'wait');
  assert.throws(() => Canary.start({ name: 'c', group: 'Chat_1', baseline: 'a', candidate: 'b' }), /group/);
  assert.throws(() => Canary.start({ name: 'c', group: 'chat', baseline: 'a', candidate: 'b', steps: [5, 1] }), /increasing/);
  const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'real', 'llm-d', 'llminferenceservice.crd-v1alpha2.schema.json.gz'))));
  const docs = YAML.parseAllDocuments(fs.readFileSync(path.join(here, '..', 'deploy', 'shadow-gate', 'llmd-canary-example.yaml'), 'utf8')).map(d => d.toJSON());
  for (const d of docs) { assert.equal(d.apiVersion, `${c.group}/${c.version}`); assert.deepEqual(validate(c.openAPIV3Schema, d), [], d.metadata.name); }
  // what start/advance patch in is valid on the real schema, at every step
  for (const pct of [...st.steps, 0]) for (const [, , , name, , , , , , body] of Canary.patches(Object.assign({}, st, { baseline: docs[0].metadata.name, candidate: docs[1].metadata.name }), pct)) {
    const d = JSON.parse(JSON.stringify(docs.find(x => x.metadata.name === name))); Object.assign(d.spec.router.route, JSON.parse(body).spec.router.route);
    assert.deepEqual(validate(c.openAPIV3Schema, d), [], `${name} at ${pct}%`);
  }
  assert.ok(validate(c.openAPIV3Schema, { apiVersion: 'serving.kserve.io/v1alpha2', kind: 'LLMInferenceService', metadata: { name: 'x' }, spec: { router: { route: { group: 'chat', weight: 2000000 } } } }).some(e => /weight/.test(e)), 'the validator catches a weight past 1,000,000');
});

test('a prediction that was off refits the candidate\'s efficiencies; plan then predicts what was measured', () => {
  const w = { isl: 2000, osl: 300, prefixHit: 50, inflight: 16 }, cfg = { baseline: { model: 'llama33-70b', gpu: 'H100', tp: 4 }, candidate: { model: 'llama33-70b', gpu: 'H200', tp: 4 } };
  const p = S.plan(Object.assign({ workload: w }, cfg));
  assert.ok(p.predicted.tpot < -0.2, `the sizer expects H200 decode to be much faster (${p.predicted.tpot})`);
  const measured = { tpot: { verdict: 'better', effect: -0.10 }, ttft: { verdict: 'same', effect: -0.02 }, e2e: { verdict: 'inconclusive', effect: 0.5 } };
  const rc = S.recalibrate(p, measured);
  assert.equal(rc.key, 'H200|llama33-70b'); assert.ok(rc.changed); assert.ok(rc.eff.effDecodeBW < rc.before.effDecodeBW);
  assert.ok(!rc.rows.some(r => r.metric === 'e2e'), 'an unsettled metric teaches nothing');
  const prof = S.mergeProfile(null, rc, { fitOn: 'test' }), p2 = S.plan(Object.assign({ workload: w }, cfg, { candidate: S.applyCalibration(cfg.candidate, prof) }));
  assert.ok(Math.abs(p2.predicted.tpot - -0.10) < 0.005, `${p2.predicted.tpot}`);
  assert.ok(Math.abs(S.plan(Object.assign({ workload: w }, cfg, { baseline: S.applyCalibration(cfg.baseline, prof) })).predicted.tpot - p.predicted.tpot) < 1e-9, 'other GPUs untouched');
  const gap = S.recalibrate(p, { tpot: { verdict: 'better', effect: -0.95 } });
  assert.ok(!gap.changed && /model gap/.test(gap.rows[0].note), 'what efficiencies can\'t explain is reported, not fitted');
  assert.equal(S.recalibrate(p, { tpot: { verdict: 'better', effect: p.predicted.tpot * 0.95 } }).changed, false, 'within 15%: nothing to learn');
});

test('the loop through the CLI: compare --plan writes the calibration; plan, the sizer and economics read it', () => {
  const store = tmp('loop-'), dir = tmp('loop-f-'), f = n => path.join(dir, n);
  fs.writeFileSync(f('b.json'), JSON.stringify({ model: 'llama33-70b', gpu: 'H100', tp: 4 })); fs.writeFileSync(f('c.json'), JSON.stringify({ model: 'llama33-70b', gpu: 'H200', tp: 4 }));
  cli(['shadow', 'demo', '--store', store]);
  cli(['shadow', 'plan', '--baseline-config', f('b.json'), '--candidate-config', f('c.json'), '--baseline', 'variant=baseline', '--out', f('plan.json'), '--store', store, '--json']);
  const out = cli(['shadow', 'compare', '--baseline', 'variant=baseline', '--candidate', 'variant=candidate', '--plan', f('plan.json'), '--store', store]);
  assert.match(out, /prediction was off/); assert.match(out, /recalibrated H200\|llama33-70b/);
  const prof = JSON.parse(fs.readFileSync(path.join(store, 'calibration', 'sizer.json'), 'utf8')).sizer['H200|llama33-70b'];
  assert.equal(prof.source, 'fleetops-shadow'); assert.ok(prof.effDecodeBW > 0 && prof.effPrefill > 0);
  const recs = JSON.parse(cli(['data', 'query', 'calibration', '--store', store, '--json']));
  assert.ok(JSON.stringify(recs).includes('sizer:H200|llama33-70b'));
  const again = cli(['shadow', 'plan', '--baseline-config', f('b.json'), '--candidate-config', f('c.json'), '--baseline', 'variant=baseline', '--store', store]);
  assert.match(again, /calibrated from .*sizer\.json: H200\|llama33-70b/);
  // the Inference Sizer reads the same profile
  const sz = JSON.parse(execFileSync(process.execPath, [path.join(here, '..', '..', 'inference-sizer', 'tools', 'size.mjs'), '--model', 'llama33-70b', '--gpu', 'H200', '--calibration', path.join(store, 'calibration', 'sizer.json'), '--json'], { encoding: 'utf8' }));
  assert.ok(JSON.stringify(sz).includes('fleetops') || JSON.stringify(sz).includes('shadow'), 'the sizer says it used the calibration');
  // and harness-ledger economics sizes self-hosting with it
  const e = JSON.parse(execFileSync(process.execPath, [HL, 'economics', '--demo', '--days', '30', '--self-host-model', 'llama33-70b', '--gpu', 'H200', '--calibration', path.join(store, 'calibration', 'sizer.json'), '--json'], { encoding: 'utf8' }));
  assert.match(String(e.selfHost.calibrated), /shadow/);
});
