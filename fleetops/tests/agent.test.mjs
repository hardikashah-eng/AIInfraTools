import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DataStore } from '../src/store.mjs';
import * as Bench from '../src/bench.mjs';
import * as Agent from '../src/agent.mjs';
import * as Inc from '../src/incidents.mjs';
import { liveView, liveRoutes, LIVE_HTML } from '../src/live.mjs';
import * as Ingest from '../src/ingest.mjs';
import * as Sec from '../src/security.mjs';
import { Store as Queue } from '../../gpu-health/src/actions.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-agent-'));
// a scenario from the benchmark written to a store on disk; returns the store, its agent state dir and the label
function scenario(name, { seed = 1 } = {}) {
  const dir = tmp(), [lab] = Bench.generate({ perCause: 1, seed, only: [name] }), store = new DataStore(path.join(dir, 's'));
  for (const [k, r] of Object.entries(lab.store.data)) if (r.length) store.append(k, r);
  return { store, stateDir: path.join(dir, 'agent'), lab, now: lab.incident.to + 120 };
}
const kinds = inc => inc.actions.map(a => `${a.kind}:${a.mode}`).sort();
const live = { policy: { dryRun: false } };

test('training: straggler, slow link and collective hang each get their playbook, as a dry run', async () => {
  const st = scenario('straggler'), r1 = await Agent.tick(st.store, { stateDir: st.stateDir, now: st.now });
  const i1 = r1.incidents.find(i => i.symptom === 'training-slow');
  assert.equal(i1.rule, 'straggler'); assert.equal(i1.decision, 'mitigate');
  assert.deepEqual(kinds(i1), ['config-reset:auto', 'deep-diag-next-boundary:auto', 'swap-at-checkpoint:approve']);
  assert.ok(r1.executed.every(e => e.outcome === 'dry-run'), 'nothing runs without --live and policy.dryRun false');

  const sl = scenario('slow-link'), r2 = await Agent.tick(sl.store, { stateDir: sl.stateDir, now: sl.now });
  const i2 = r2.incidents.find(i => i.rule === 'slow-link');
  assert.deepEqual(kinds(i2), ['cordon-node:auto', 'link-check:auto', 'swap-at-checkpoint:approve']);
  assert.ok(i2.actions.some(a => a.id === `cordon-node:node:${sl.lab.component}`), 'cordons the slow node, not another');

  const ch = scenario('collective-hang'), r3 = await Agent.tick(ch.store, { stateDir: ch.stateDir, now: ch.now });
  const i3 = r3.incidents.find(i => i.symptom === 'training-hang');
  assert.equal(i3.rule, 'collective-hang');
  assert.ok(kinds(i3).includes('restart-without-node:approve') && kinds(i3).includes('cordon-node:auto'));
  // the incident is open, with the agent's decision as a note
  const s = Inc.state(ch.store, i3.id);
  assert.equal(s.status, 'open');
  assert.ok(s.events.some(e => e.event === 'note' && e.by === 'fleetops-agent' && /mitigate/.test(e.note)));
});

test('inference: KV pressure scales out (approval by default), a slow replica is drained, a bad helm deploy is rolled back', async () => {
  const kv = scenario('kv-pressure');
  const r = await Agent.tick(kv.store, { stateDir: kv.stateDir, now: kv.now, agent: { pools: { 'chat-70b': { namespace: 'serving', replicas: 8 } } } });
  const i = r.incidents.find(x => x.rule === 'kv-pressure');
  assert.deepEqual(kinds(i), ['scale-out:approve']);
  const a = new Queue(kv.stateDir).get('scale-out:pool:chat-70b');
  assert.equal(a.status, 'proposed'); assert.equal(a.params.replicas, '10'); assert.equal(a.params.namespace, 'serving');
  // without a replica count it asks a person instead of guessing
  const kv2 = scenario('kv-pressure'), r2 = await Agent.tick(kv2.store, { stateDir: kv2.stateDir, now: kv2.now });
  assert.deepEqual(kinds(r2.incidents.find(x => x.rule === 'kv-pressure')), ['notify-owner:auto']);

  const rt = scenario('replica-tail'), r3 = await Agent.tick(rt.store, { stateDir: rt.stateDir, now: rt.now });
  const i3 = r3.incidents.find(x => x.rule === 'replica-tail');
  assert.ok(i3.actions.some(x => x.kind === 'drain-replica' && x.mode === 'approve' && x.id === `drain-replica:replica:${rt.lab.component}`));

  const h = { title: 'deploy change', evidence: [] };
  assert.deepEqual(Agent.PLAYBOOK.change({ change: { id: 'serving/chat#7' } }, { h }).map(x => [x.kind, x.params.release, x.params.revision, x.params.namespace]), [['rollback-change', 'chat', '6', 'serving']]);
  assert.equal(Agent.PLAYBOOK.change({ change: { id: 'c9', target: 'fleet' } }, { h })[0].kind, 'hold-rollout');
});

test('guardrails: medium confidence only contains; low confidence escalates; a monitoring gap freezes; cordons are capped', async () => {
  const cfg = (await import('../../gpu-health/src/config.mjs')).loadConfig();
  const acfg = Agent.AGENT_DEFAULTS, ctx = { jobsOn: () => [{ job: 't', class: 'training', namespace: 'ml' }], ns: () => 'ml', pool: () => ({}) };
  const d = conf => ({ id: 'x', confidence: conf, incident: { symptom: 'training-slow' }, hypotheses: [{ rule: 'slow-link', title: 'slow', evidence: [], targets: { node: 'n1', job: 't' } }] });
  const auto = list => list.filter(a => a.mode === 'auto').map(a => a.kind).sort();
  assert.deepEqual(auto(Agent.plan(d('high'), 'mitigate', { cfg, acfg, ctx })), ['cordon-node', 'link-check']);
  // medium: containing kinds stay automatic; with a policy that makes swap-at-checkpoint auto, it is lowered to approve
  const cfg2 = (await import('../../gpu-health/src/config.mjs')).loadConfig({ policy: { actions: { 'swap-at-checkpoint': 'auto' }, classes: { training: { 'swap-at-checkpoint': 'auto' } } } });
  const med = Agent.plan(d('medium'), 'contain', { cfg: cfg2, acfg, ctx });
  assert.equal(med.find(a => a.kind === 'swap-at-checkpoint').mode, 'approve');
  assert.match(med.find(a => a.kind === 'swap-at-checkpoint').lowered, /medium confidence/);
  assert.equal(Agent.plan(d('high'), 'mitigate', { cfg: cfg2, acfg, ctx }).find(a => a.kind === 'swap-at-checkpoint').mode, 'auto', 'high confidence keeps the policy mode');
  assert.deepEqual(Agent.plan(d('low'), 'escalate', { cfg, acfg, ctx }), []);
  const gap = { id: 'g', confidence: 'high', incident: {}, hypotheses: [{ rule: 'monitoring-gap', title: 'gap', evidence: [], targets: {} }] };
  assert.deepEqual(Agent.plan(gap, 'frozen', { cfg, acfg, ctx }).map(a => a.kind), ['exporter-check']);
  assert.deepEqual(Agent.plan(d('high'), 'frozen', { cfg, acfg, ctx }), [], 'frozen: no device actions whatever the cause');

  // a bad leaf switch: the agent cordons at most 10% of the nodes (at least one) on its own; the rest wait
  const sc = scenario('shared-component: bad leaf switch', { seed: 2 }), r = await Agent.tick(sc.store, { stateDir: sc.stateDir, now: sc.now });
  const i = r.incidents.find(x => x.rule === 'shared-component');
  const cordons = i.actions.filter(a => a.kind === 'cordon-node');
  assert.ok(cordons.length >= 3);
  assert.ok(cordons.filter(a => a.mode === 'auto').length <= 2);
  assert.ok(cordons.some(a => a.mode === 'approve' && /cordon limit/.test(a.lowered)));
});

test('live: autonomous actions run through the runner within the hourly limit; pause stops them; approvals run next tick', async () => {
  const sl = scenario('slow-link'), calls = [];
  const runner = argv => { calls.push(argv.join(' ')); return { code: 0, out: 'ok' }; };
  const opts = { stateDir: sl.stateDir, ghConfig: live, live: true, runner, agent: { maxAutoActionsPerHour: 1 } };
  const r = await Agent.tick(sl.store, Object.assign({ now: sl.now }, opts));
  assert.equal(r.live, true);
  const done = r.executed.filter(e => e.outcome === 'done');
  assert.equal(done.filter(e => e.by === 'policy' && !['link-check', 'notify-owner'].includes(e.kind)).length, 1, 'one autonomous change: the hourly limit');
  assert.ok(calls.length >= 1 && calls.every(c => !/swap-at-checkpoint/.test(c)), 'actions that need approval do not run');
  assert.ok(Agent.decisions(sl.stateDir).some(e => e.decision === 'budget'));
  // a person approves the swap; it runs on the next tick
  const q = new Queue(sl.stateDir);
  q.approve('swap-at-checkpoint:train-llm', 'ana');
  const r2 = await Agent.tick(sl.store, Object.assign({ now: sl.now + 30 }, opts));
  assert.ok(r2.executed.some(e => e.kind === 'swap-at-checkpoint' && e.outcome === 'done' && e.by === 'ana'));
  assert.ok(calls.some(c => /gpu-health.aiinfra\/swap-at-checkpoint=train-llm/.test(c)));
  // paused: nothing runs, even approved actions
  Agent.setPaused(sl.stateDir, true, 'ana');
  new Queue(sl.stateDir).list('proposed').forEach(a => new Queue(sl.stateDir).approve(a.id, 'ana'));
  const n = calls.length, r3 = await Agent.tick(sl.store, Object.assign({ now: sl.now + 7200 }, opts));
  assert.equal(r3.paused, true); assert.equal(calls.length, n); assert.equal(r3.executed.length, 0);
  Agent.setPaused(sl.stateDir, false, 'ana');
});

test('verify: cleared after a live mitigation → incident mitigated; still failing → a person is paged', async () => {
  const hw = scenario('hardware: GPU fault seen in dmesg'), runner = () => ({ code: 0, out: 'ok' }), pages = [];
  const opts = { stateDir: hw.stateDir, ghConfig: live, live: true, runner, agent: { page: { to: 'webhook', url: 'https://hooks.example/x' } }, pagePoster: async (u, o) => { pages.push(JSON.parse(o.body)); return { status: 200, text: '' }; } };
  const r = await Agent.tick(hw.store, Object.assign({ now: hw.now }, opts));
  const id = r.incidents.find(i => i.rule === 'hardware').id;
  assert.ok(r.executed.some(e => e.kind === 'quarantine' && e.outcome === 'done'));
  // jobs keep finishing after the GPU is out
  hw.store.append('job', Array.from({ length: 12 }, (_, i) => ({ t: hw.now + 120 + i * 40, job: `ok-${i}`, status: 'ok', devices: [{ node: 'node-01', gpu: '0' }] })));
  const v = await Agent.tick(hw.store, Object.assign({ now: hw.now + 700 }, opts));
  assert.deepEqual(v.verified.map(x => [x.id, x.outcome, x.live]), [[id, 'cleared', true]]);
  assert.equal(Inc.state(hw.store, id).status, 'mitigated');

  // the same, but failures keep coming after the action
  const hw2 = scenario('hardware: GPU fault seen in dmesg'), o2 = Object.assign({}, opts, { stateDir: hw2.stateDir });
  await Agent.tick(hw2.store, Object.assign({ now: hw2.now }, o2));
  const node = hw2.lab.component;
  hw2.store.append('job', Array.from({ length: 30 }, (_, i) => ({ t: hw2.now + 120 + i * 20, job: `again-${i}`, status: 'failed', devices: [{ node, gpu: '0' }], node })));
  const v2 = await Agent.tick(hw2.store, Object.assign({ now: hw2.now + 1300 }, o2));
  assert.equal(v2.verified[0].outcome, 'persisting');
  assert.equal(Inc.state(hw2.store, v2.verified[0].id).status, 'open');
  assert.ok(pages.length >= 1, 'paged');
  assert.ok(Agent.decisions(hw2.stateDir).some(e => e.decision === 'verified' && /a person is needed/.test(e.note)));
});

test('dashboard: page without data, API by role, approvals named by the token, pause', async () => {
  const sl = scenario('slow-link'), dir = tmp(), tf = path.join(dir, 'tokens.jsonl');
  await Agent.tick(sl.store, { stateDir: sl.stateDir, now: sl.now });
  const v = liveView(sl.store, sl.stateDir, { now: sl.now });
  assert.ok(v.fleet.gpus.length > 0 && v.incidents.length === 1 && v.training[0].job === 'train-llm' && v.training[0].series.length > 0);
  assert.ok(v.actions.open.some(a => a.status === 'proposed' && a.kind === 'swap-at-checkpoint'));
  const read = Sec.addToken(tf, { name: 'grafana', roles: ['read'] }).token, ana = Sec.addToken(tf, { name: 'ana', roles: ['read', 'approve'] }).token;
  const pipe = new Ingest.Pipeline(sl.store).start();
  const srv = Ingest.server(pipe, { tokens: Sec.loadTokens(tf), extra: liveRoutes({ store: sl.store, stateDir: sl.stateDir }), page: LIVE_HTML });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (p, { method = 'GET', token, body } = {}) => new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}) }, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => res({ status: r.statusCode, body: d })); });
    req.on('error', rej); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const page = await call('/live');
    assert.equal(page.status, 200); assert.match(page.body, /fleetops live/); assert.doesNotMatch(page.body, /train-llm/);
    assert.equal((await call('/api/live')).status, 401);
    const lv = await call('/api/live', { token: read });
    assert.equal(lv.status, 200); assert.equal(JSON.parse(lv.body).incidents.length, 1);
    const id = encodeURIComponent('swap-at-checkpoint:train-llm@node-03/0');
    assert.equal((await call(`/api/agent/actions/${id}/approve`, { method: 'POST', token: read, body: {} })).status, 403);
    const ok = await call(`/api/agent/actions/${id}/approve`, { method: 'POST', token: ana, body: { by: 'someone-else' } });
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).by, 'ana', 'the approver is the token\'s owner, not a name in the body');
    assert.equal(new Queue(sl.stateDir).get('swap-at-checkpoint:train-llm@node-03/0').approvedBy, 'ana');
    assert.equal((await call(`/api/agent/actions/${id}/approve`, { method: 'POST', token: ana, body: {} })).status, 409, 'only proposed actions can be approved');
    assert.equal((await call('/api/agent/pause', { method: 'POST', token: ana, body: {} })).status, 200);
    assert.equal(Agent.paused(sl.stateDir), true);
    assert.equal(JSON.parse((await call('/api/live', { token: read })).body).agent.paused, true);
    const fz = await call('/api/flakiness?format=html', { token: read });
    assert.equal(fz.status, 200); assert.match(fz.body, /GPU flakiness/);
  } finally { srv.close(); pipe.stop(); }
});

test('verify in a dry run (shadow mode): latency and training slowdowns that recover are reported as clearing on their own', async () => {
  const kv = scenario('kv-pressure'), r = await Agent.tick(kv.store, { stateDir: kv.stateDir, now: kv.now });
  const id = r.incidents.find(i => i.rule === 'kv-pressure').id;
  const before = kv.store.query('serving', { to: kv.lab.incident.from - 3600, where: x => x.pool === 'chat-70b' }).slice(-1)[0];
  kv.store.append('serving', Array.from({ length: 10 }, (_, i) => Object.assign({}, before, { t: kv.now + 120 + i * 60 })));
  const v = await Agent.tick(kv.store, { stateDir: kv.stateDir, now: kv.now + 800 });
  assert.deepEqual(v.verified.map(x => [x.id, x.outcome, x.live]), [[id, 'cleared', false]]);
  assert.equal(Inc.state(kv.store, id).status, 'open', 'a dry run never marks an incident mitigated');
  assert.ok(Inc.state(kv.store, id).events.some(e => /cleared on its own/.test(e.note || '')));

  const sl = scenario('slow-link'), r2 = await Agent.tick(sl.store, { stateDir: sl.stateDir, now: sl.now });
  const id2 = r2.incidents.find(i => i.rule === 'slow-link').id;
  // no new steps since acting: it can't tell, so it waits, then says so instead of claiming success
  assert.equal((await Agent.tick(sl.store, { stateDir: sl.stateDir, now: sl.now + 800 })).verified.length, 0);
  const v2 = await Agent.tick(sl.store, { stateDir: sl.stateDir, now: sl.now + 1900 });
  assert.equal(v2.verified.find(x => x.id === id2).outcome, 'no-data');
  const fast = sl.store.query('step', { to: sl.lab.incident.from - 3600 }).slice(-48);
  const sl3 = scenario('slow-link'); await Agent.tick(sl3.store, { stateDir: sl3.stateDir, now: sl3.now });
  sl3.store.append('step', fast.map(x => Object.assign({}, x, { t: sl3.now + 200, step: x.step + 200000 })));
  assert.equal((await Agent.tick(sl3.store, { stateDir: sl3.stateDir, now: sl3.now + 800 })).verified[0].outcome, 'cleared');
  const sl2 = scenario('slow-link'); await Agent.tick(sl2.store, { stateDir: sl2.stateDir, now: sl2.now });
  const slow = sl2.store.query('step', { from: sl2.lab.incident.to - 300, to: sl2.lab.incident.to });
  sl2.store.append('step', slow.map(x => Object.assign({}, x, { t: x.t + 600, step: x.step + 100000 })));
  const v3 = await Agent.tick(sl2.store, { stateDir: sl2.stateDir, now: sl2.now + 800 });
  assert.equal(v3.verified[0].outcome, 'persisting');
});

test('the realtime policy example drains a slow replica on its own at high confidence, and still never moves training work', async () => {
  const cfgFile = JSON.parse(fs.readFileSync(new URL('../examples/agent-policy.realtime.json', import.meta.url)));
  const cfg = (await import('../../gpu-health/src/config.mjs')).loadConfig(cfgFile), acfg = Agent.AGENT_DEFAULTS;
  const ctx = { jobsOn: () => [], ns: () => 'ml', pool: () => ({ namespace: 'serving', replicas: 6 }) };
  const d = (rule, targets) => ({ id: 'x', confidence: 'high', incident: {}, hypotheses: [{ rule, title: rule, evidence: [], targets }] });
  const mode = (p, k) => p.find(a => a.kind === k).mode;
  assert.equal(mode(Agent.plan(d('replica-tail', { pool: 'chat', replica: 'chat-3', node: 'n4' }), 'mitigate', { cfg, acfg, ctx }), 'drain-replica'), 'auto');
  const so = Agent.plan(d('kv-pressure', { pool: 'chat' }), 'mitigate', { cfg, acfg, ctx });
  assert.equal(mode(so, 'scale-out'), 'auto');
  assert.equal(so[0].params.replicas, '8', '6 replicas + min(maxScaleOutStep 2, 25%)');
  assert.equal(mode(Agent.plan(d('slow-link', { node: 'n1', job: 't' }), 'mitigate', { cfg, acfg, ctx }), 'swap-at-checkpoint'), 'approve');
  assert.equal(cfg.policy.dryRun, true, 'the example never turns execution on by itself');
});
