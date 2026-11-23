import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { analyze } from '../src/analyze.mjs';
import { persistable } from '../src/health.mjs';
import { createServer } from '../src/server.mjs';
import { flakiness, flakinessHtml, flakinessMarkdown, flakinessFromState, flakinessDigest, recordTransitions, recordResults } from '../src/flakiness.mjs';
import { demoSamples, demoJobs, demoSteps, demoProbes, demoResults, demoHistory, DEMO_NOW, toJsonl } from '../src/synth.mjs';

const cfg = loadConfig();
const D = 86400, NOW = 100 * D;
const E = (key, d, from, to, why = '', faultClass = '') => ({ t: NOW - d * D, key, node: key.split('/')[0], gpu: key.split('/')[1], sku: 'H200', site: 's', from, to, why, faultClass });
const fleet = n => Array.from({ length: n }, (_, i) => ({ key: `n${Math.floor(i / 4)}/${i % 4}`, node: `n${Math.floor(i / 4)}`, gpu: String(i % 4), sku: 'H200', site: 's' }));

test('flakiness: bounces, diag-then-fail and verdicts per GPU', () => {
  const events = [
    // n0/0: out and back three times, twice within a week of returning → rma-candidate
    E('n0/0', 50, 'serving', 'suspect', 'hot'), E('n0/0', 49, 'suspect', 'serving'), E('n0/0', 45, 'serving', 'suspect'), E('n0/0', 44, 'suspect', 'serving'),
    E('n0/0', 40, 'serving', 'suspect'), E('n0/0', 39, 'suspect', 'serving'),
    // n0/1: quarantined, released, fails again 3 days later after a diag pass → flaky
    E('n0/1', 30, 'serving', 'quarantined', 'xid48', 'ecc'), E('n0/1', 29, 'quarantined', 'burnin'), E('n0/1', 28, 'burnin', 'ready'), E('n0/1', 27, 'ready', 'serving'),
    E('n0/1', 24, 'serving', 'quarantined', 'xid48', 'ecc'),
    // n0/2: two exits far apart → watch;   n0/3: one exit → ok;   n1/0: before the window → not counted
    E('n0/2', 50, 'serving', 'suspect'), E('n0/2', 49, 'suspect', 'serving'), E('n0/2', 10, 'serving', 'suspect'), E('n0/2', 9, 'suspect', 'serving'),
    E('n0/3', 5, null, 'quarantined', 'xid79', 'bus'),
    E('n1/0', 70, 'serving', 'quarantined'),
  ];
  const results = [
    { t: NOW - 28 * D, kind: 'diag', node: 'n0', gpu: '1', pass: true },
    { t: NOW - 24 * D, kind: 'job-end', job: 'j1', rank: 1, status: 'failed', cause: 'device' },
    { t: NOW - 20 * D, kind: 'job-end', job: 'j1', rank: 1, status: 'failed', cause: 'app' },     // not the GPU's fault
    { t: NOW - 19 * D, kind: 'job-end', job: 'j1', rank: 0, status: 'ok' },
  ];
  const jobs = [{ id: 'j1', gpus: [{ node: 'n0', gpu: '0' }, { node: 'n0', gpu: '1' }] }];
  const f = flakiness({ events, results, fleet: fleet(8), jobs, cfg, now: NOW, days: 60 });
  const by = Object.fromEntries(f.devices.map(r => [r.key, r]));
  assert.equal(by['n0/0'].exits, 3); assert.equal(by['n0/0'].bounces, 2); assert.equal(by['n0/0'].verdict, 'rma-candidate');
  assert.equal(by['n0/1'].bounces, 1); assert.equal(by['n0/1'].diagThenFail, 1); assert.equal(by['n0/1'].jobFailures, 1); assert.equal(by['n0/1'].verdict, 'flaky');
  assert.equal(by['n0/2'].verdict, 'watch'); assert.equal(by['n0/3'].verdict, 'ok');
  assert.ok(!by['n1/0'], 'exits before the window are not counted');
  assert.deepEqual(f.devices.slice(0, 2).map(r => r.key).sort(), ['n0/0', 'n0/1']);
  assert.equal(f.totals.deviceJobFailures, 1);
  assert.equal(f.totals.lostGpuHours, 2, 'estimated as job size (2 GPUs) × 1 h');
  assert.equal(f.perDay.reduce((t, d) => t + d.suspect + d.out, 0), f.totals.exits);
  // timeline: n0/1 ends the window quarantined
  assert.equal(by['n0/1'].segments.at(-1).state, 'quarantined');
  assert.equal(by['n0/1'].segments[0].from, NOW - 60 * D);
});

test('flakiness: repairs hold or not, and recent ones are left out of the rate', () => {
  const events = [
    E('a/0', 40, 'serving', 'quarantined', '', 'ecc'), E('a/0', 39, 'quarantined', 'serving'),                       // held
    E('a/1', 40, 'serving', 'quarantined', '', 'ecc'), E('a/1', 39, 'quarantined', 'serving'), E('a/1', 36, 'serving', 'suspect'), // failed in 4 days
    E('a/2', 40, 'serving', 'quarantined', '', 'ecc'), E('a/2', 39, 'quarantined', 'serving'), E('a/2', 20, 'serving', 'quarantined'), // held 7, not 30
    E('a/3', 3, 'serving', 'quarantined', '', 'ecc'),                                                                  // too recent
  ];
  const audit = ['a/0', 'a/1', 'a/2'].map(k => ({ t: NOW - 39.9 * D, kind: 'gpu-reset', target: k, event: 'executed' }))
    .concat([{ t: NOW - 2.9 * D, kind: 'gpu-reset', target: 'a/3', event: 'executed' }, { t: NOW - 30 * D, kind: 'gpu-reset', target: 'a/0', event: 'dry-run' }]);
  const f = flakiness({ events, audit, fleet: [], cfg, now: NOW, days: 60 });
  assert.equal(f.repairs.length, 4, 'dry runs are not repairs');
  const g = f.repairTable.find(x => x.kind === 'gpu-reset' && x.faultClass === 'ecc');
  assert.deepEqual([g.hold[7].held, g.hold[7].eligible], [2, 3]);
  assert.deepEqual([g.hold[30].held, g.hold[30].eligible], [1, 3]);
  assert.equal(g.verdict, 'mixed');
  assert.ok(Math.abs(f.totals.repairHoldRate - 2 / 3) < 1e-9);
});

test('flakiness: a cohort is flagged only when several of its GPUs fail at twice the fleet rate', () => {
  const events = [];
  for (const g of ['0', '1', '2']) events.push(E('n0/' + g, 10, 'serving', 'suspect'), E('n0/' + g, 9, 'suspect', 'serving'));
  for (let i = 0; i < 4; i++) events.push(E('n1/0', 30 - i * 5, 'serving', 'suspect'), E('n1/0', 29.5 - i * 5, 'suspect', 'serving')); // one bad GPU
  const f = flakiness({ events, fleet: fleet(24), cfg, now: NOW, days: 60 });
  const node = f.cohorts.find(c => c.field === 'node');
  assert.equal(node.groups.find(g => g.value === 'n0').hot, true);
  assert.equal(node.groups.find(g => g.value === 'n1').hot, false, 'one bad GPU is not a cohort');
  assert.deepEqual(f.hotCohorts.map(c => `${c.dimension} ${c.value}`), ['Node n0']);
});

test('flakiness: state changes and results are recorded once each', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-flaky-'));
  const g = (key, state, why = '') => ({ key, node: key.split('/')[0], gpu: key.split('/')[1], sku: 'H200', site: 's', state, why });
  assert.equal(recordTransitions(dir, { gpus: {} }, { now: 10, gpus: { 'a/0': g('a/0', 'serving'), 'a/1': g('a/1', 'suspect', 'hot') } }), 1, 'a GPU first seen serving is not an event');
  assert.equal(recordTransitions(dir, { gpus: { 'a/0': { state: 'serving' }, 'a/1': { state: 'suspect' } } }, { now: 20, gpus: { 'a/0': g('a/0', 'serving'), 'a/1': g('a/1', 'serving', 'signal cleared') } }), 1);
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(ev.map(e => [e.key, e.from, e.to]), [['a/1', null, 'suspect'], ['a/1', 'suspect', 'serving']]);
  const r = [{ t: 1, kind: 'diag', node: 'a', gpu: '0', pass: true }, { t: 2, kind: 'job-end', job: 'x', status: 'failed', cause: 'device', node: 'a', gpu: '0' }, { t: 3, kind: 'other' }];
  assert.equal(recordResults(dir, r), 2); assert.equal(recordResults(dir, r), 0);
});

test('flakiness: the demo history tells its story, and the HTML escapes what came from telemetry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-flaky-demo-'));
  const h = demoHistory({ now: DEMO_NOW });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), toJsonl(h.events)); fs.writeFileSync(path.join(dir, 'audit.jsonl'), toJsonl(h.audit)); fs.writeFileSync(path.join(dir, 'results.jsonl'), toJsonl(h.results));
  const a = analyze({ samples: demoSamples({ now: DEMO_NOW }), jobs: demoJobs(DEMO_NOW), steps: demoSteps({ now: DEMO_NOW }), probes: demoProbes({ now: DEMO_NOW }), results: demoResults({ now: DEMO_NOW }), cfg, now: DEMO_NOW });
  recordTransitions(dir, { gpus: {} }, a.health);
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(a)); fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify(persistable(a.health)));
  const f = flakinessFromState(dir, cfg);
  const by = Object.fromEntries(f.devices.map(r => [r.key, r]));
  assert.equal(f.totals.devices, 32);
  assert.equal(f.devices[0].key, 'n1/2', 'the SDC GPU that passed its diag and corrupted again ranks first');
  assert.equal(by['n1/2'].verdict, 'flaky'); assert.equal(by['n1/2'].jobFailures, 2); assert.equal(by['n1/2'].diagThenFail, 1);
  assert.equal(by['n4/5'].verdict, 'rma-candidate'); assert.equal(by['n4/5'].hardFailures, 3);
  assert.deepEqual(f.hotCohorts.map(c => `${c.dimension} ${c.value}`), ['Node n2']);
  assert.ok(f.badput.find(b => b.job === 'train-llm').lostGpuHours >= 24);
  assert.ok(!f.badput.some(b => b.failures && b.job === 'train-llm' && b.failures > 2), 'the app failure is not counted');
  const d = flakinessDigest(f);
  assert.ok(d.devices.length <= 20 && !('segments' in d.devices[0]));
  assert.match(flakinessMarkdown(f), /Node n2/);
  // untrusted text from telemetry or results ends up escaped
  const evil = flakiness({ events: [E('<img src=x onerror=alert(1)>/0', 2, 'serving', 'quarantined', '<script>alert(1)</script>', 'ecc')], fleet: [], cfg, now: NOW, days: 30 });
  const html = flakinessHtml(evil);
  assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x'));
  assert.equal((html.match(/<script>/g) || []).length, 1, 'only the page\'s own tooltip script');
});

test('flakiness: served behind the token as JSON or HTML', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-flaky-srv-'));
  const t = Math.floor(Date.now() / 1000) - 2 * D; // no analysis.json yet: the window ends now
  fs.writeFileSync(path.join(dir, 'events.jsonl'), toJsonl([Object.assign(E('a/0', 0, 'serving', 'quarantined', 'xid79', 'bus'), { t })]));
  const srv = createServer({ stateDir: dir, cfg, tokens: { named: [{ name: 'alice', token: 't-alice' }], shared: '' } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`, H = { authorization: 'Bearer t-alice' };
  try {
    assert.equal((await fetch(base + '/api/flakiness')).status, 401);
    const j = await (await fetch(base + '/api/flakiness?days=30', { headers: H })).json();
    assert.equal(j.window.days, 30); assert.equal(j.totals.exits, 1);
    const page = await fetch(base + '/api/flakiness?format=html', { headers: H });
    assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /GPU flakiness/);
  } finally { srv.close(); }
});
