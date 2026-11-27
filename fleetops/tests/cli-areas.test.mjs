// The CLI's areas in their text forms and their errors, on the demo stores: data (summary, query, node, requests,
// rollup, compact, migrate, export), rca (detect, diagnose, eval, bench), the incident workflow (open, list, show,
// transitions, timeline, postmortem, a dry-run page), training (goodput, tune, sdc) and the usage errors each area
// gives. Nothing here sends: paging is a dry run, injections and game days are not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(here, '..', 'tools', 'fleetops.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fo-cli-'));
const run = (a, env) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { PAGERDUTY_ROUTING_KEY: '', OPSGENIE_API_KEY: '' }, env || {}) });
const ok = (a, env) => { const r = run(a, env); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const FROM = '2026-01-15T06:00:00Z', TO = '2026-01-15T14:00:00Z';
let S = null;
const store = () => { if (!S) { S = path.join(tmp(), 's'); ok(['demo', '--store', S]); } return S; };

test('data: summary, query, a node\'s story, requests from spans, rollups, compaction and migration as text', () => {
  const s = store(), st = ['--store', s];
  assert.match(ok(['data', 'summary', ...st]), /^ {2}device +\d+/m);
  assert.match(ok(['data', 'summary', '--store', tmp()]), /\(empty\)/);
  const q = ok(['data', 'query', 'log', '--where', 'node=node-07', '--limit', '5', ...st]).trim().split('\n'); assert.ok(q.length >= 1 && JSON.parse(q[0]).node === 'node-07');
  const n = ok(['data', 'node', 'node-07', '--from', FROM, '--to', TO, ...st]); assert.match(n, /^node-07 /m); assert.match(n, /log faults \(\d+\)/); assert.match(n, /shares /);
  assert.match(ok(['data', 'node', 'nobody', '--to', TO, ...st]), /not in the inventory/);
  assert.equal(JSON.parse(ok(['data', 'node', 'node-07', '--to', TO, '--json', ...st])).node.node, 'node-07');
  assert.match(ok(['data', 'requests', ...st]), /spans → \d+ requests/);
  assert.match(ok(['data', 'rollup', ...st]), /s: |nothing new to roll up/);
  assert.match(ok(['data', 'rollup', ...st]), /nothing new to roll up/, 'a second rollup has nothing new');
  assert.match(ok(['data', 'compact', '--raw-days', '1', ...st]), /dry run: --apply/);
  assert.match(ok(['data', 'migrate', ...st]), /nothing to do|schema/);
  const d = tmp();
  assert.match(ok(['data', 'export', 'gpu-health', '--out', d, ...st]), /wrote \d+ samples/);
  assert.match(ok(['data', 'export', 'fleetscope-trace', '--out', path.join(d, 't.csv'), ...st]), /wrote \d+ requests/);
  assert.match(ok(['data', 'export', 'gpu-ledger', '--out', path.join(d, 'u.jsonl'), '--capacity', path.join(d, 'cap.json'), '--cluster', 'demo', ...st]), /and capacity to/);
  for (const [a, re] of [[['data', 'export', 'nope'], /export gpu-health \| fleetscope-trace \| gpu-ledger/], [['data', 'export', 'gpu-health'], /--out DIR/], [['data', 'export', 'fleetscope-trace'], /--out FILE/],
    [['data', 'export', 'gpu-ledger'], /--out usage\.jsonl/], [['data', 'node'], /data node NODE/], [['data', 'import', 'philly'], /give a SOURCE and at least one FILE/], [['data', 'bogus'], /unknown: data bogus/], [['bogus'], /unknown command "bogus"/]]) {
    const r = run([...a, ...st]); assert.equal(r.status, 1, a.join(' ')); assert.match(r.stderr, re);
  }
  assert.match(JSON.parse(run(['data', 'bogus', '--json', ...st]).stdout).error, /unknown: data bogus/);
});

test('rca: detection as text and Markdown, the threshold method, diagnose, bench with fitted weights and a bar it misses', () => {
  const s = store(), st = ['--store', s], d = tmp();
  assert.match(ok(['rca', 'detect', '--from', FROM, '--to', TO, '--min-failures', '5', ...st]), /job-failures|node-07/);
  assert.match(ok(['rca', 'detect', '--from', FROM, '--to', TO, '--min-failures', '5', '--diagnose', '--format', 'md', ...st]), /^#/m);
  assert.ok(Array.isArray(JSON.parse(ok(['rca', 'detect', '--from', FROM, '--to', TO, '--method', 'threshold', '--min-failures', '5', '--json', ...st])).incidents));
  const t = ok(['rca', 'diagnose', '--symptom', 'job-failures', '--from', '2026-01-15T12:00:00Z', '--to', '2026-01-15T13:00:00Z', '--nodes', 'node-07', ...st]); assert.match(t, /^ {2}1\. /m);
  const labels = path.join(d, 'labels.jsonl'); fs.writeFileSync(labels, JSON.stringify({ cause: 'hardware', incident: { symptom: 'job-failures', from: '2026-01-15T12:00:00Z', to: '2026-01-15T13:00:00Z' } }) + '\n');
  assert.match(ok(['rca', 'eval', '--labels', labels, ...st]), /1 labeled incidents: top-1/);
  const w = path.join(d, 'w.json'), b = ok(['rca', 'bench', '--per-cause', '1', '--seed', '3', '--labels', labels, '--synthetic', '--fit', w, ...st]);
  assert.match(b, /labeled incidents \(synthetic \+ postmortem\)/); assert.match(b, /weights written to/); assert.ok(JSON.parse(fs.readFileSync(w, 'utf8')).warnings.length >= 0);
  const low = run(['rca', 'bench', '--per-cause', '1', '--min-top1', '1.01', ...st]); assert.notEqual(low.status, 0); assert.match(low.stderr, /below the bar/);
  for (const [a, re] of [[['rca', 'diagnose'], /--symptom job-failures\|latency\|device/], [['rca', 'eval'], /--labels FILE/], [['rca', 'nope'], /unknown: rca nope/],
    [['pull'], /pull needs --from/], [['pull', '--from', FROM], /pull --prom URL and\/or --loki URL/], [['backtest'], /backtest --labels/], [['gameday'], /gameday PLAN\.json/]]) {
    const r = run([...a, ...st]); assert.equal(r.status, 1, a.join(' ')); assert.match(r.stderr, re);
  }
});

test('incidents: open, list, transitions with a confirmed cause, show, timeline and postmortem, a dry-run page', () => {
  const s = path.join(tmp(), 'i'), st = ['--store', s]; ok(['demo', '--store', s]);
  assert.match(ok(['incidents', '--store', s]), /no incidents/);
  assert.match(ok(['incidents', 'open', '--from', FROM, '--to', TO, '--min-failures', '5', ...st]), /incident\(s\) detected, \d+ new/);
  const list = JSON.parse(ok(['incidents', 'list', '--json', ...st])).incidents; assert.ok(list.length >= 1); const id = list[0].id;
  assert.match(ok(['incidents', 'list', ...st]), new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ok(['incidents', 'ack', id, '--by', 'ana', ...st]), /acknowledged/);
  assert.match(ok(['incidents', 'assign', id, '--owner', 'ana', '--by', 'ana', ...st]), /assign/);
  assert.match(ok(['incidents', 'note', id, '--note', 'drained node-07', '--by', 'ana', ...st]), /note/);
  assert.match(ok(['incidents', 'resolve', id, '--cause', 'hardware', '--component', 'node-07', '--by', 'ana', ...st]), /confirmed cause hardware, node-07: stored as a label/);
  const show = ok(['incidents', 'show', id, ...st]); assert.match(show, /resolved by ana/); assert.match(show, /ranked causes:/);
  assert.equal(JSON.parse(ok(['incidents', 'show', id, '--json', ...st])).incident.owner, 'ana');
  const d = tmp(); assert.match(ok(['incidents', 'timeline', id, '--out', path.join(d, 't.html'), ...st]), /written to/); assert.match(ok(['incidents', 'postmortem', id, ...st]), /hardware/i);
  const pg = ok(['incidents', 'page', id, '--key', 'test-key', ...st]); assert.match(pg, /^dry run \(--live to send\): POST /m); assert.ok(!pg.includes('test-key'), 'the routing key is not printed');
  assert.equal(JSON.parse(ok(['incidents', 'page', id, '--to', 'opsgenie', '--key', 'k', '--action', 'resolve', '--json', ...st])).page.dryRun, true);
  assert.match(ok(['rca', 'bench', '--from-incidents', '--per-cause', '1', ...st]), /incident|confirmed/);
  for (const [a, re] of [[['incidents', 'show'], /incidents show ID/], [['incidents', 'show', 'nope'], /no incident nope/], [['incidents', 'frob', id], /unknown: incidents frob/]]) {
    const r = run([...a, ...st]); assert.equal(r.status, 1, a.join(' ')); assert.match(r.stderr, re);
  }
});

test('training: goodput as Markdown and HTML, tune runs, lists, holdouts and applies, sdc as text', () => {
  const s = path.join(tmp(), 't'), st = ['--store', s], to = ['--to', new Date().toISOString()]; ok(['demo', '--training', '--days', '7', '--store', s]);
  assert.match(ok(['goodput', ...st]), /goodput/i);
  const d = tmp(); assert.match(ok(['goodput', '--format', 'html', '--out', path.join(d, 'g.html'), ...st]), /wrote/);
  assert.match(ok(['goodput', '--format', 'md', ...st]), /goodput/i);
  assert.match(ok(['tune', ...st]), /#|recommend/i);
  assert.ok(JSON.parse(ok(['tune', '--json', ...st])).tune.recommendations.length > 0);
  assert.match(ok(['tune', '--format', 'json', '--out', path.join(d, 't.json'), ...st]), /"recommendations"/);
  assert.match(ok(['tune', 'list', ...st]), /nothing applied yet/);
  assert.match(ok(['tune', 'holdout', ...st, ...to]), /checked on/);
  assert.ok(JSON.parse(ok(['tune', 'models', '--json', ...st])).models.length > 5); assert.match(ok(['tune', 'models', ...st]), /^models: /);
  const rec = JSON.parse(fs.readFileSync(path.join(s, 'tune', 'last.json'), 'utf8')).recommendations[0];
  assert.match(ok(['tune', 'apply', rec.id, '--by', 'ana', ...st]), /recorded .* applied at .* by ana/);
  assert.match(ok(['tune', 'verify', rec.id, ...st]), new RegExp(rec.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ok(['sdc', ...st]), /#|silent|SDC/i);
  for (const [a, re] of [[['tune', 'apply'], /tune apply ID --by NAME/], [['tune', 'apply', 'nope', '--by', 'x'], /no recommendation nope/], [['tune', 'frob'], /unknown: tune frob/]]) {
    const r = run([...a, ...st]); assert.equal(r.status, 1, a.join(' ')); assert.match(r.stderr, re);
  }
});

test('data import: each source through the CLI into one store, auto-detection, and the import summary', () => {
  const s = path.join(tmp(), 'imp'), st = ['--store', s], F = (...p) => path.join(here, 'fixtures', ...p), FS = (...p) => path.join(here, '..', '..', 'fleetscope', 'tests', 'fixtures', ...p);
  const cases = [['dcgm', ['exporter', F('dcgm.prom'), '--t', '2026-01-15T10:00:00Z']], ['k8s-pods', ['k8s-pods', F('k8s_pods.json')]], ['slurm', ['slurm-nodes', F('scontrol_nodes.txt')]],
    ['sacct', ['sacct', F('sacct.txt')]], ['topo', ['nvidia-topo', F('signals', 'nvidia_topo.txt'), '--node', 'n1']], ['ib', ['ibnetdiscover', F('signals', 'ibnetdiscover.txt')]],
    ['racks', ['racks', F('signals', 'racks.csv')]], ['events', ['k8s-events', F('signals', 'k8s_events.json')]], ['helm', ['helm-history', F('signals', 'helm_history.json'), '--release', 'chat']],
    ['nccl', ['app-log', F('amd', 'rccl.log'), '--node', 'n1', '--job', 'j1']], ['steps', ['step-log', F('signals', 'train.log'), '--job', 'j1']],
    ['sysfs', ['ib-sysfs', F('real', 'sysfs-infiniband-counters.txt'), '--node', 'n1']], ['nfs', ['mountstats', F('real', 'nfs-mountstats.txt'), '--node', 'n1']],
    ['azure', ['azure-llm', F('azure_llm.csv'), '--limit', '50']], ['mlperf', ['mlperf', F('mlperf_log_summary.txt')]], ['acme', ['acme', F('acme_trace.csv'), '--limit', '20']],
    ['requests', ['requests', FS('openai-gateway.jsonl'), '--pool', 'chat', '--start', '2026-01-15T10:00:00Z']]];
  for (const [name, a] of cases) {
    const r = run(['data', 'import', ...a, ...st]); assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /\d+ written, \d+ already there, \d+ invalid/, name);
  }
  const again = ok(['data', 'import', 'racks', F('signals', 'racks.csv'), ...st]); assert.match(again, / 0 written, [1-9]\d* already there/, 'imports are idempotent');
  const auto = JSON.parse(ok(['data', 'import', 'auto', F('signals', 'nvidia_smi_q.txt'), F('git_log.txt'), '--json', ...st])).imported; assert.ok(Object.keys(auto).length >= 1);
  const unk = path.join(tmp(), 'x.bin'); fs.writeFileSync(unk, 'zzz'); assert.match(ok(['data', 'import', 'auto', unk, ...st]), /not recognized; name its source/);
  assert.match(run(['data', 'import', 'nope', unk, ...st]).stderr, /unknown source "nope"/);
  const sum = JSON.parse(ok(['data', 'summary', '--json', ...st])).summary; for (const k of ['device', 'placement', 'topology', 'change', 'request', 'job']) assert.ok(sum[k] && sum[k].records > 0, k);
});
