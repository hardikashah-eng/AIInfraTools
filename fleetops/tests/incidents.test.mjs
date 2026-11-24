import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../src/store.mjs';
import { MemStore } from '../src/memstore.mjs';
import * as Inc from '../src/incidents.mjs';
import * as B from '../src/bench.mjs';
import * as I from '../src/inject.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-inc-'));
const diag = (id, extra = {}) => Object.assign({ t: 4600, id, incident: { symptom: 'job-failures', from: 1000, to: 4600, failures: 150 }, confidence: 'high', hypotheses: [{ rule: 'hardware', title: 'GPU fault on n3', score: 0.8, evidence: [{ what: 'n3/2 logged xid79' }], against: [], verify: ['Run a level-3 diag on n3.'] }] }, extra);

test('lifecycle: open once, legal transitions only, who did what, reopen clears the cause', () => {
  const s = new MemStore();
  s.append('incident', [diag('inc-1')]);
  assert.equal(Inc.open(s, diag('inc-1'), { now: 5000 }).severity, 'sev2');
  assert.equal(Inc.open(s, diag('inc-1'), { now: 5001 }), null, 'opened once');
  assert.throws(() => Inc.transition(s, 'inc-1', 'acknowledge', {}), /--by NAME/);
  Inc.transition(s, 'inc-1', 'acknowledge', { by: 'ana', now: 5100 });
  Inc.transition(s, 'inc-1', 'assign', { by: 'ana', owner: 'gpu-oncall', now: 5150 });
  Inc.transition(s, 'inc-1', 'mitigate', { by: 'ana', note: 'drained n3', now: 5200 });
  assert.throws(() => Inc.transition(s, 'inc-1', 'reopen', { by: 'ana', now: 5250 }), /mitigated: can't go to open/);
  Inc.transition(s, 'inc-1', 'resolve', { by: 'ana', cause: 'hardware', component: 'n3', now: 5300 });
  let st = Inc.state(s, 'inc-1');
  assert.deepEqual([st.status, st.owner, st.cause, st.component, st.severity], ['resolved', 'gpu-oncall', 'hardware', 'n3', 'sev2']);
  assert.equal(st.diagnosis.hypotheses[0].rule, 'hardware');
  assert.deepEqual(Inc.labelsFromIncidents(s).map(l => [l.incident.id, l.cause, l.component]), [['inc-1', 'hardware', 'n3']]);
  Inc.transition(s, 'inc-1', 'reopen', { by: 'bo', note: 'came back', now: 6000 });
  st = Inc.state(s, 'inc-1');
  assert.equal(st.status, 'open'); assert.equal(st.cause, undefined); assert.equal(Inc.labelsFromIncidents(s).length, 0);
});

test('paging: PagerDuty and Opsgenie payloads; nothing is sent without --live; a live page is recorded', async () => {
  const s = new MemStore();
  s.append('incident', [diag('inc-2')]); Inc.open(s, diag('inc-2'), { now: 5000 });
  const pd = await Inc.page(s, 'inc-2', 'pagerduty', 'trigger', { poster: () => { throw new Error('must not send'); } });
  assert.equal(pd.dryRun, true); assert.equal(pd.request.url, 'https://events.pagerduty.com/v2/enqueue');
  assert.deepEqual([pd.request.body.event_action, pd.request.body.dedup_key, pd.request.body.payload.severity], ['trigger', 'inc-2', 'error']);
  const og = Inc.pagePayload('opsgenie', 'resolve', Inc.state(s, 'inc-2'), { key: 'k' });
  assert.equal(og.url, 'https://api.opsgenie.com/v2/alerts/inc-2/close?identifierType=alias'); assert.equal(og.headers.authorization, 'GenieKey k');
  await assert.rejects(Inc.page(s, 'inc-2', 'pagerduty', 'trigger', { live: true }), /needs a key/);
  const sent = [];
  const r = await Inc.page(s, 'inc-2', 'webhook', 'ack', { live: true, url: 'https://hooks.example.test/x', poster: (u, o) => { sent.push([u, JSON.parse(o.body)]); return { status: 202 }; }, now: 5050 });
  assert.equal(r.ok, true); assert.equal(sent[0][1].incident.id, 'inc-2');
  assert.ok(Inc.state(s, 'inc-2').events.some(e => e.event === 'paged' && e.provider === 'webhook' && e.status === 202));
});

test('timeline and postmortem: facts from the store, the parts a person writes are marked', () => {
  const s = new MemStore();
  s.append('job', [0, 1, 2].map(i => ({ t: 1200 + i * 300, job: `j${i}`, status: 'failed', start: 1000, end: 1200 + i * 300, gpus: 2 })));
  s.append('log', [{ t: 1100, node: 'n3', gpu: '2', code: 'xid79', class: 'bus', severity: 'hard', msg: 'GPU has fallen off the bus' }]);
  s.append('change', [{ t: 900, kind: 'config', target: 'n3', summary: 'kernel param' }]);
  s.append('incident', [diag('inc-3')]); Inc.open(s, diag('inc-3'), { now: 1500 });
  Inc.transition(s, 'inc-3', 'resolve', { by: 'ana', cause: 'hardware', component: 'n3', now: 3000 });
  const html = Inc.timelineHtml(s, 'inc-3');
  assert.match(html, /^<!DOCTYPE html>/); assert.match(html, /failed jobs \/ 5 min/); assert.match(html, /▲ hard {2}n3\/2 xid79/); assert.match(html, /config on n3/);
  assert.match(html, /prefers-color-scheme:dark/); assert.match(html, /confirmed cause: hardware \(n3\)/);
  const md = Inc.postmortem(s, 'inc-3');
  assert.match(md, /\| Impact \| 3 failed jobs, /); assert.match(md, /\*\*Confirmed:\*\* hardware \(n3\)\. Root-cause analysis ranked it first/);
  assert.match(md, /- \[ \] Run a level-3 diag on n3\./); assert.match(md, /## What went well\n\n_To write\._/);
  assert.match(md, /n3\/2 logged xid79/);
});

test('done-when: an injected fault goes from detection to a resolved postmortem with its label stored, in the tools', async () => {
  // a test cluster where an XID was injected on node-03 (fake runner) and the collectors saw its effect
  const dir = tmp(), st = new DataStore(dir), base = B.generate({ perCause: 1, seed: 3, only: ['workload'] })[0].store;
  for (const k of Object.keys(base.data)) st.append(k, base.query(k).filter(r => k !== 'job' || r.status === 'ok'));
  const t1 = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  let clock = t1;
  await I.run(I.prepare('xid', { node: 'node-03', gpu: '1', xid: '79' }, { allow: ['node-03'] }), { live: true, forS: 1800, store: st, log: () => {}, now: () => clock, runner: () => ({ status: 0 }), sleep: async x => { clock += x; } });
  for (let i = 0; i < 14; i++) { const t = t1 + 60 + i * 100, o = `team-${'abc'[i % 3]}`; st.append('placement', [{ t: t - 600, job: `x${i}`, owner: o, namespace: `ns-${o}`, start: t - 600, devices: [{ node: 'node-03', gpu: '1' }] }]); st.append('job', [{ t, job: `x${i}`, status: 'failed', cause: 'unknown', start: t - 600, end: t, devices: [{ node: 'node-03', gpu: '1' }] }]); }
  st.append('log', [{ t: t1 + 5, node: 'node-03', gpu: '1', code: 'xid79', class: 'bus', severity: 'hard', msg: 'NVRM: Xid 79, injected by fleetops', source: 'kernel' }]);
  const run = (...a) => execFileSync(process.execPath, [cli, ...a, '--store', dir], { encoding: 'utf8' });
  const opened = JSON.parse(run('incidents', 'open', '--from', String(t1 - 3600), '--to', String(t1 + 7200), '--min-failures', '5', '--json')).opened;
  assert.equal(opened.length, 1); const id = opened[0].id;
  assert.match(opened[0].summary, /node-03/);
  run('incidents', 'ack', id, '--by', 'ana');
  const page = JSON.parse(run('incidents', 'page', id, '--to', 'pagerduty', '--json')).page;
  assert.equal(page.dryRun, true);
  run('incidents', 'mitigate', id, '--by', 'ana', '--note', 'drained node-03');
  run('incidents', 'resolve', id, '--by', 'ana', '--cause', 'hardware', '--component', 'node-03');
  const md = path.join(dir, 'pm.md'), html = path.join(dir, 'tl.html');
  run('incidents', 'postmortem', id, '--out', md); run('incidents', 'timeline', id, '--out', html);
  assert.match(fs.readFileSync(md, 'utf8'), /\*\*Confirmed:\*\* hardware \(node-03\)\. Root-cause analysis ranked it first/);
  assert.match(fs.readFileSync(html, 'utf8'), /injected xid on node-03/);
  const bench = JSON.parse(run('rca', 'bench', '--from-incidents', '--json')).benchmark;
  assert.deepEqual([bench.sources, bench.top1], [['confirmed incidents'], 1]);
});
