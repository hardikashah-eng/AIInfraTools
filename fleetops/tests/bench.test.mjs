import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../src/store.mjs';
import { MemStore } from '../src/memstore.mjs';
import * as D from '../src/detect.mjs';
import * as B from '../src/bench.mjs';
import * as I from '../src/inject.mjs';
import { diagnose, RULE_IDS } from '../src/rca.mjs';

const T0 = Date.UTC(2026, 0, 15, 0, 0, 0) / 1000, H = 3600;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-bench-'));

// ---------- detection ----------

// a week of failures with a busy hour every day (09:00–10:00, 6/bin) and a quiet rest (0–1/bin); then a real spike
function weekWithSpike(s, { spikeAt = T0 + 7 * 86400 + 15 * H, perBin = 8 } = {}) {
  const jobs = [];
  let k = 0;
  for (let t = T0; t < T0 + 8 * 86400; t += 300) {
    const h = new Date(t * 1000).getUTCHours(), busy = h === 9;
    const n = busy ? 6 : (Math.floor(t / 300) % 7 === 0 ? 1 : 0);
    const spike = t >= spikeAt && t < spikeAt + 30 * 60 ? perBin : 0;
    for (let i = 0; i < n + spike; i++) jobs.push({ t: t + i, job: `j${k++}`, status: 'failed', cause: 'unknown' });
  }
  s.append('job', jobs);
  return spikeAt;
}

test('detect: the daily busy hour is learned as normal, a real spike alarms within two bins and starts at the change', () => {
  const s = new MemStore(), at = weekWithSpike(s);
  const incs = D.detectJobFailures(s, { from: T0 + 6 * 86400, binS: 300 });
  const spikes = incs.filter(i => i.from >= at - 600 && i.from <= at + 600);
  assert.equal(spikes.length, 1, JSON.stringify(incs.map(i => new Date(i.from * 1000).toISOString())));
  assert.ok(spikes[0].alarmAt - at <= 600, `alarm ${spikes[0].alarmAt - at} s after onset`);
  assert.ok(Math.abs(spikes[0].from - at) <= 300, 'the incident starts at the change, not at the alarm');
  assert.ok(!incs.some(i => new Date(i.from * 1000).getUTCHours() === 9), 'no alarm on the busy hour once a few days are known');
  assert.ok(spikes[0].to - spikes[0].from < 3 * H, 'the incident ends soon after the rate is back (capped evidence)');
});

test('detect: latency CUSUM, SLO targets, and grouping', () => {
  const s = new MemStore(), rec = [];
  for (let t = T0; t <= T0 + 2 * 86400; t += 300) rec.push({ t, pool: 'chat', windowS: 300, ttftP99: t > T0 + 2 * 86400 - 1800 ? 1.4 : 0.6 + 0.02 * Math.sin(t / 900), tpotP99: 0.04 });
  s.append('serving', rec);
  const incs = D.detectServing(s, { from: T0 + 86400, targets: { chat: { ttftP99: 1.0 } } });
  assert.ok(incs.some(i => i.method === 'cusum' && i.metric === 'ttftP99'));
  assert.ok(incs.some(i => i.method === 'target' && i.limit === 1.0));
  const g = D.groupIncidents(incs);
  assert.equal(g.filter(i => i.pool === 'chat').length, 1, 'one event, not one per detector');
  assert.ok(g[0].merged.length >= 1);
  const linked = D.groupIncidents([{ id: 'a', symptom: 'job-failures', from: 0, to: 100 }, { id: 'b', symptom: 'latency', pool: 'p', from: 50, to: 150 }]);
  assert.deepEqual(linked.map(i => i.related), [['b'], ['a']], 'different symptoms that overlap are linked, not merged');
});

test('detect: the CUSUM finds the six Philly spikes the hourly threshold found (fixture-sized replay)', () => {
  // the Philly spikes, as hourly failure counts around a quiet baseline (the real store isn't in the repo)
  const s = new MemStore(), spikes = [T0 + 26 * H, T0 + 48 * H, T0 + 61 * H, T0 + 77 * H, T0 + 133 * H, T0 + 153 * H], jobs = [];
  let k = 0;
  for (let t = T0; t < T0 + 7 * 86400; t += 600) {
    const n = (Math.floor(t / 600) % 3 === 0 ? 1 : 0) + (spikes.some(x => t >= x && t < x + 2 * H) ? 20 : 0);
    for (let i = 0; i < n; i++) jobs.push({ t: t + i, job: `j${k++}`, status: 'failed', cause: 'unknown' });
  }
  s.append('job', jobs);
  const g = D.groupIncidents(D.detectJobFailures(s, { binS: 600, minFailures: 20 }));
  for (const x of spikes) assert.ok(g.some(i => i.from <= x + 600 && i.to >= x + H), `spike at +${(x - T0) / H} h`);
  assert.equal(g.length, spikes.length);
});

// ---------- benchmark ----------

test('bench: every scenario kind ranks its cause first through the distractors (seed held out from tuning)', () => {
  const r = B.run(B.generate({ perCause: 6, seed: 11 }));
  assert.equal(r.incidents, 6 * B.SCENARIO_NAMES.length);
  assert.ok(r.top1 >= 0.9, `top-1 ${r.top1}`); assert.ok(r.top3 >= 0.97, `top-3 ${r.top3}`);
  for (const [k, b] of Object.entries(r.byScenario)) assert.ok(b.top1 >= b.n - 1, `${k}: ${b.top1}/${b.n} ${JSON.stringify(b.tops)}`);
  assert.ok(r.componentTop1 >= 0.85, `component ${r.componentTop1}`);
});

test('bench: scenarios are reproducible and independent of filtering', () => {
  const a = B.generate({ perCause: 3, seed: 5 }).filter(x => x.scenario.startsWith('version')), b = B.generate({ perCause: 3, seed: 5, only: ['version'] });
  assert.deepEqual(a.map(x => x.store.query('job').length), b.map(x => x.store.query('job').length));
  assert.deepEqual(B.run(a).rows.map(x => x.top), B.run(b).rows.map(x => x.top));
});

test('bench: fitted weights rerank from raw scores and never change the evidence', () => {
  const rows = B.run(B.generate({ perCause: 3, seed: 2 })).rows;
  const w = B.fitWeights(rows);
  assert.deepEqual(Object.keys(w).sort(), RULE_IDS.slice().sort());
  assert.ok(B.applyWeights(rows, w).top1 >= B.summarize(rows).top1, 'never worse on what it was fitted on');
  // a weight that buries a rule changes the ranking, not the hypothesis
  const l = B.generate({ perCause: 1, seed: 2, only: ['kv-pressure'] })[0];
  const d0 = diagnose(l.store, l.incident), d1 = diagnose(l.store, l.incident, { weights: { 'kv-pressure': 0.1 } });
  const h0 = d0.hypotheses.find(h => h.rule === 'kv-pressure'), h1 = d1.hypotheses.find(h => h.rule === 'kv-pressure');
  assert.equal(h1.rawScore, h0.score); assert.ok(h1.score < h0.score); assert.deepEqual(h1.evidence, h0.evidence);
});

test('bench: the in-memory store answers like the file store', () => {
  const m = new MemStore(), f = new DataStore(tmp()), recs = [{ t: 5, job: 'a', status: 'ok' }, { t: 1, job: 'b', status: 'failed' }, { t: 86400 * 3, job: 'c', status: 'failed' }, { t: 1, job: 'b', status: 'failed' }];
  for (const s of [m, f]) s.append('job', recs, { dedupe: true });
  for (const q of [{}, { from: 1 }, { to: 5 }, { where: r => r.status === 'failed' }]) assert.deepEqual(m.query('job', q), f.query('job', q));
  assert.equal(m.append('job', [{ t: 1 }]).invalid, 1);
});

// ---------- fault injection ----------

test('inject: dry-run by default, allowlist enforced, values checked, nothing written', async () => {
  const lines = [];
  const prep = I.prepare('nfs-block', { nodes: 'gpu-t01,gpu-t02', server: 'nfs-test' }, { allow: ['gpu-t01', 'gpu-t02', 'nfs-test'] });
  assert.equal(prep.apply.length, 2); assert.equal(prep.revert.length, 2); assert.equal(prep.expect, 'infrastructure');
  const s = new MemStore();
  const r = await I.run(prep, { store: s, log: l => lines.push(l), runner: () => { throw new Error('must not run'); } });
  assert.equal(r.dryRun, true); assert.equal(s.query('injection').length, 0);
  assert.match(lines.join('\n'), /apply\s+ssh gpu-t01 sudo iptables -I OUTPUT -d nfs-test -p tcp --dport 2049 -j DROP/);
  assert.throws(() => I.prepare('nfs-block', { nodes: 'gpu-t01,prod-db', server: 'nfs-test' }, { allow: ['gpu-t01', 'nfs-test'] }), /not in the allowlist: prod-db/);
  assert.throws(() => I.prepare('xid', { node: 'gpu-t01;reboot', gpu: '0' }, { allow: ['gpu-t01;reboot'] }), /not a plain name/);
  assert.throws(() => I.prepare('xid', { node: 'gpu-t01', gpu: '0', kmsg: true }, { allow: ['gpu-t01'] }), /--kmsg needs --pci/);
  assert.throws(() => I.prepare('bad-deploy', { release: 'r', chart: 'c', namespace: 'n', set: 'image.tag=$(id)', pool: 'p' }, { allow: ['r', 'n'] }), /not a plain name/);
});

test('inject: a live run applies, waits, reverts, and writes the label; a failed apply is reverted at once', async () => {
  const s = new MemStore(), ran = [];
  let clock = T0;
  const prep = I.prepare('nccl-stall', { node: 'gpu-t01', pid: '4242' }, { allow: ['gpu-t01'] });
  const rec = await I.run(prep, { live: true, forS: 600, store: s, log: () => {}, now: () => clock, runner: a => { ran.push(a.join(' ')); return { status: 0 }; }, sleep: async x => { clock += x; } });
  assert.deepEqual(ran, ['ssh gpu-t01 sudo kill -STOP 4242', 'ssh gpu-t01 sudo kill -CONT 4242']);
  assert.equal(rec.applied, true); assert.equal(rec.reverted, true); assert.equal(rec.to - rec.from, 600); assert.equal(rec.expect, 'collective-hang');
  assert.equal(s.query('injection').length, 1);
  const bad = await I.run(I.prepare('cordon', { node: 'gpu-t02' }, { allow: ['gpu-t02'] }), { live: true, store: s, log: () => {}, now: () => clock, runner: a => ({ status: a[1] === 'cordon' ? 1 : 0, stderr: 'forbidden' }), sleep: async () => { throw new Error('must not wait'); } });
  assert.equal(bad.applied, false); assert.equal(bad.reverted, true);
});

test('inject → collectors → score: detection delay and diagnosis of injected faults', async () => {
  // A 12-node test cluster from the benchmark generator, with two live injections whose effects the collectors saw:
  // an XID on one GPU (jobs on that node fail) and an NFS block on five nodes (jobs there fail, NFS timeouts logged).
  const base = B.generate({ perCause: 1, seed: 3, only: ['workload'] })[0].store;
  const s = new MemStore();
  for (const k of Object.keys(base.data)) s.append(k, base.query(k).filter(r => k !== 'job' || r.status === 'ok'));
  const t1 = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  // telemetry keeps flowing through the whole test (the generator's covers only its own incident)
  const nodes = [...new Set(base.query('inventory').map(r => r.node))], dev = [];
  for (let t = t1 + H + 600; t <= t1 + 7 * H; t += 600) for (const n of nodes) for (const g of ['0', '1']) dev.push({ t, node: n, gpu: g, vendor: 'nvidia', kind: 'gpu', faults: [] });
  s.append('device', dev);
  let clock = t1;
  const run = (fault, params, allow) => I.run(I.prepare(fault, params, { allow }), { live: true, forS: 1200, store: s, log: () => {}, now: () => clock, runner: () => ({ status: 0 }), sleep: async x => { clock += x; } });
  await run('xid', { node: 'node-03', gpu: '1', xid: '79' }, ['node-03']);
  let k = 0;
  const fail = (node, t) => { const id = `inj${k++}`, o = `team-${'abc'[k % 3]}`; s.append('placement', [{ t: t - 600, job: id, owner: o, namespace: `ns-${o}`, start: t - 600, devices: [{ node, gpu: '1' }] }]); s.append('job', [{ t, job: id, status: 'failed', cause: 'unknown', start: t - 600, end: t, devices: [{ node, gpu: '1' }] }]); };
  for (let i = 0; i < 12; i++) fail('node-03', t1 + 60 + i * 90);
  s.append('log', [{ t: t1 + 5, node: 'node-03', gpu: '1', code: 'xid79', class: 'bus', severity: 'hard', msg: 'NVRM: Xid (PCI:0000:3b:00): 79, injected by fleetops', source: 'kernel' }]);
  clock = t1 + 4 * H;
  const t2 = clock, nfsNodes = ['node-01', 'node-04', 'node-06', 'node-09', 'node-11'];
  await run('nfs-block', { nodes: nfsNodes.join(','), server: 'nfs-test' }, [...nfsNodes, 'nfs-test']);
  for (const n of nfsNodes) { for (let i = 0; i < 4; i++) fail(n, t2 + 120 + i * 200); s.append('log', [{ t: t2 + 30, node: n, code: 'nfs_timeout', class: 'storage', severity: 'hard', msg: 'nfs: server nfs-test not responding', server: 'nfs-test', source: 'kernel' }]); }

  const r = B.evalInjections(s);
  assert.equal(r.injections, 2); assert.equal(r.detected, 1, JSON.stringify(r.rows.map(({ hyps, ...x }) => x)));
  assert.ok(r.delayP90 <= 600, `alarm within 10 minutes (p90 ${r.delayP90} s)`);
  const [xid, nfs] = r.rows;
  assert.equal(xid.rank, 1, `xid: ${JSON.stringify(xid.hyps)}`); assert.equal(xid.componentOk, true);
  assert.equal(nfs.rank, 1, `nfs: ${JSON.stringify(nfs.hyps)}`);
  assert.equal(r.diagnosis.top1, 1);
});
