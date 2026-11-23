import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../src/store.mjs';
import * as R from '../src/rca.mjs';

const H = 3600, T0 = 1_800_000_000, ON = T0 + 30 * H; // incidents start 30 h after T0, with a day of normal history before
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-rca-'));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'fleetops.mjs');

// A normal day: 10 owners × 4 nodes each, a few failures per hour, devices reporting.
function baseline(s) {
  const placements = [], jobs = [], devices = [];
  for (let h = 0; h < 32; h++) for (let i = 0; i < 20; i++) {
    const owner = 'u' + (i % 10), node = 'n' + (i % 40), job = `j${h}-${i}`, t = T0 + h * H + i * 60;
    placements.push({ t, job, owner, namespace: 'ns-' + owner, class: 'training', start: t, end: t + 1800, devices: [{ node, gpu: '0' }] });
    jobs.push({ t: t + 1800, job, status: i === 0 ? 'failed' : 'ok', cause: 'unknown', start: t, end: t + 1800, devices: [{ node, gpu: '0' }] });
  }
  for (let t = T0; t <= ON + 2 * H; t += 600) for (let n = 0; n < 20; n++) devices.push({ t, node: 'n' + n, gpu: '0', sm: 0.6, tensor: 0.5, faults: [] });
  s.append('placement', placements); s.append('job', jobs); s.append('device', devices);
}
const failJobs = (s, specs) => {
  const p = [], j = [];
  specs.forEach((x, i) => { const t = ON + 60 + i * 10, job = `f${x.owner}-${i}`; p.push({ t: t - 600, job, owner: x.owner, namespace: 'ns-' + x.owner, class: 'training', start: t - 600, end: t, devices: [{ node: x.node, gpu: '0' }] }); j.push({ t, job, status: 'failed', cause: 'unknown', start: t - 600, end: t, devices: [{ node: x.node, gpu: '0' }] }); });
  s.append('placement', p); s.append('job', j);
};
const serving = (s, pool, f) => { const r = []; for (let t = T0; t <= ON + 2 * H; t += 300) r.push(Object.assign({ t, pool, windowS: 300, rate: 5, islMean: 1000, oslMean: 200, ttftP50: 0.3, ttftP99: 0.8, tpotP50: 0.03, tpotP99: 0.04, kvUsage: 0.6 }, t > ON ? f(t) : {})); s.append('serving', r); };
const jobInc = { symptom: 'job-failures', from: ON, to: ON + H };
const latInc = pool => ({ symptom: 'latency', pool, metric: 'ttftP99', from: ON, to: ON + 2 * H });

const SCENARIOS = {
  workload: s => failJobs(s, Array.from({ length: 60 }, (_, i) => ({ owner: 'u3', node: 'n' + (i % 25) }))),
  hardware: s => {
    failJobs(s, Array.from({ length: 20 }, (_, i) => ({ owner: 'u' + (i % 6), node: 'n7' })));
    s.append('health', [{ t: ON + 120, key: 'n7/0', node: 'n7', gpu: '0', from: 'serving', to: 'quarantined', why: 'fault xid79', faultClass: 'bus' }]);
    s.append('device', [{ t: ON + 100, node: 'n7', gpu: '0', sm: 0, faults: ['xid79'] }]);
  },
  change: s => { s.append('change', [{ t: ON - 20 * 60, kind: 'deploy', target: 'serving/chat', summary: 'vLLM 0.11.2', by: 'alice', id: 'c1' }]); serving(s, 'chat', () => ({ ttftP99: 2.5 })); },
  infrastructure: s => failJobs(s, Array.from({ length: 50 }, (_, i) => ({ owner: 'u' + (i % 10), node: 'n' + (i % 30) }))),
  'kv-pressure': s => serving(s, 'chat', () => ({ ttftP99: 3, kvUsage: 0.97, preemptions: 40 })),
  load: s => serving(s, 'chat', () => ({ ttftP99: 2.2, rate: 11 })),
  'monitoring-gap': () => {}, // built in build(): the baseline devices go quiet before the incident
};

function build(name) {
  const s = new DataStore(tmp());
  baseline(s);
  if (name === 'monitoring-gap') { // the 20 baseline devices stop reporting 2 h before the incident; 3 others report
    const s2 = new DataStore(tmp());
    for (const k of ['placement', 'job']) s2.append(k, s.query(k));
    s2.append('device', s.query('device', { to: ON - 2 * H - 1 }));
    s2.append('device', Array.from({ length: 18 }, (_, i) => ({ t: ON - 2 * H + i * 600, node: 'm' + (i % 3), gpu: '0', sm: 0.5 })));
    return s2;
  }
  SCENARIOS[name](s);
  return s;
}
const incFor = name => (['change', 'kv-pressure', 'load'].includes(name) ? latInc('chat') : name === 'monitoring-gap' ? { symptom: 'device', from: ON, to: ON + H } : jobInc);

test('rca: each rule ranks first on its own scenario, with evidence and verification steps', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const d = R.diagnose(build(name), Object.assign({ id: name }, incFor(name)));
    assert.ok(d.hypotheses.length, `${name}: some hypothesis`);
    assert.equal(d.hypotheses[0].rule, name, `${name}: got ${d.hypotheses.map(h => `${h.rule}:${h.score.toFixed(2)}`).join(' ')}`);
    assert.ok(d.hypotheses[0].evidence.length && d.hypotheses[0].verify.length);
    assert.ok(d.narrative.startsWith('Most likely:'));
    assert.ok(!d.ruledOut.includes(name));
  }
});

test('rca: hardware evidence cites the health event and the fault; a change cites the commit', () => {
  const h = R.diagnose(build('hardware'), jobInc).hypotheses[0];
  assert.ok(h.evidence.some(e => /n7\/0 went serving → quarantined/.test(e.what)) && h.evidence.some(e => /xid79/.test(e.what)));
  assert.ok(h.evidence.some(e => (e.refs || []).some(r => r.kind === 'health')));
  const c = R.diagnose(build('change'), latInc('chat')).hypotheses[0];
  assert.match(c.title, /deploy change "vLLM 0.11.2" on serving\/chat, 20 min before onset/);
  assert.equal(c.evidence[0].refs[0].id, 'c1');
});

test('rca: labeled incidents give top-1 and top-3 accuracy', () => {
  const labeled = Object.keys(SCENARIOS).map(name => ({ name, store: build(name), incident: incFor(name), cause: name }));
  const rows = labeled.map(l => R.evaluate(l.store, [{ incident: l.incident, cause: l.cause }]));
  const top1 = rows.filter(r => r.top1 === 1).length / rows.length, top3 = rows.filter(r => r.top3 === 1).length / rows.length;
  assert.equal(top1, 1); assert.equal(top3, 1);
});

test('rca: detection finds a failure spike and a latency regression', () => {
  const s = build('workload');
  const spikes = R.detectJobFailureSpikes(s, { from: T0 + 25 * H, minFailures: 20 });
  assert.equal(spikes.length, 1); assert.equal(spikes[0].from, ON); assert.ok(spikes[0].failures >= 60);
  const s2 = build('kv-pressure');
  const reg = R.detectServingRegressions(s2, { from: T0 + 25 * H, targets: { chat: { ttftP99: 1 } } });
  assert.equal(reg.length, 1); assert.equal(reg[0].pool, 'chat'); assert.equal(reg[0].metric, 'ttftP99');
});

test('rca: CLI detects, diagnoses and stores incidents', () => {
  const s = build('workload');
  const r = spawnSync('node', [CLI, 'rca', 'detect', '--store', s.dir, '--from', String(T0 + 25 * H), '--min-failures', '20', '--diagnose', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.incidents.length, 1); assert.equal(j.incidents[0].hypotheses[0].rule, 'workload');
  assert.equal(s.query('incident').length, 1);
  const md = spawnSync('node', [CLI, 'rca', 'diagnose', '--store', s.dir, '--symptom', 'job-failures', '--from', String(ON), '--to', String(ON + H)], { encoding: 'utf8' });
  assert.match(md.stdout, /One (owner|namespace) \((u3|ns-u3)\) owns/);
});
