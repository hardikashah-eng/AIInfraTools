// The cases the main suite doesn't reach: Kubernetes pod states and label fallbacks, Slurm and OpenCost edge rows,
// CSV quoting, reports without utilization, and the CLI's other formats and errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from '../src/adapters.mjs';
import { ledger } from '../src/ledger.mjs';
import { reportText, showbackCsv, focusRows, toCsv } from '../src/export.mjs';
import { html } from '../src/html.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), FX = path.join(here, 'fixtures'), CLI = path.join(here, '..', 'tools', 'ledger.mjs');
const T0 = Date.UTC(2026, 10, 10) / 1000, H = 3600, iso = s => new Date(s * 1000).toISOString();
const run = a => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
const pod = (name, o = {}) => ({ metadata: Object.assign({ name, namespace: 'ml', uid: name, creationTimestamp: iso(T0) }, o.md || {}), spec: { nodeName: o.node || 'n1', containers: [{ resources: { limits: o.limits || { 'nvidia.com/gpu': '1' } } }] }, status: Object.assign({ startTime: iso(T0) }, o.st || {}) });

test('k8s: pod states, owners and node labels decide status, kind, name and GPU type', () => {
  const term = (reason, at = T0 + H) => ({ containerStatuses: [{ state: { terminated: { reason, finishedAt: iso(at) } } }] });
  const pods = { items: [
    pod('oom', { st: Object.assign({ phase: 'Failed' }, term('OOMKilled')) }),
    pod('evicted', { st: Object.assign({ phase: 'Failed', reason: 'Evicted' }, term('ContainerStatusUnknown')) }),
    pod('pending', { st: { phase: 'Pending' } }),
    pod('gone', { st: { phase: 'Unknown', reason: 'Evicted' } }),
    pod('web-7d9f8c6b5x', { md: { ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7d9f8c6b5' }] }, st: { phase: 'Running' }, node: 'amd1', limits: { 'amd.com/gpu': '2' } }),
    pod('db-0', { md: { ownerReferences: [{ kind: 'StatefulSet', name: 'db' }], labels: { 'app.kubernetes.io/name': 'vector-db' } }, st: { phase: 'Running' }, node: 'cloud1' }),
    pod('nostart', { md: { creationTimestamp: null }, st: { startTime: null, phase: 'Pending' } }),
    pod('done', { st: { phase: 'Succeeded' } })] };
  const nodes = { items: [{ metadata: { name: 'n1', labels: { 'nvidia.com/gpu.product': 'NVIDIA-H100-80GB-HBM3' } } }, { metadata: { name: 'amd1', labels: { 'amd.com/gpu.product-name': 'AMD Instinct MI300X' } } }, { metadata: { name: 'cloud1' } }] };
  // GPU_UTIL (percent) when there's no SM_ACTIVE; exported_* labels
  const prom = [{ data: { result: [{ metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', exported_pod: 'web-7d9f8c6b5x', exported_namespace: 'ml', gpu: '0' }, values: [[T0, '50'], [T0 + 60, '0'], [T0 + 120, '100']] }, { metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', namespace: 'ml' }, values: [[T0, '1']] }] } }];
  const r = Object.fromEntries(A.k8s({ pods, nodes, prom, now: T0 + 2 * H, cluster: 'c' }).map(x => [x.name, x]));
  assert.deepEqual(['oom', 'evicted', 'pending', 'gone', 'done'].map(n => r[n].status), ['failed', 'preempted', 'succeeded', 'preempted', 'succeeded']);
  assert.equal(r.pending.end, null, 'pending: still holding its GPUs'); assert.equal(r.oom.end, T0 + H); assert.equal(r.done.end, T0 + 2 * H, 'no termination time: now');
  assert.ok(!r.nostart, 'no start time: no record');
  const web = r.web; assert.equal(web.kind, 'deployment'); assert.equal(web.gpus, 2); assert.equal(web.util.smSource, 'gpu_util'); assert.ok(Math.abs(web.util.busy - 2 / 3) < 1e-9);
  assert.equal(r['vector-db'].kind, 'deployment'); assert.equal(r['vector-db'].gpuType, null, 'no GPU label on the node');
});

test('slurm and OpenCost edge rows; CSV quoting and unparseable rows', () => {
  const sacct = ['JobID|JobName|User|Account|Partition|State|Start|End|NodeList|AllocTRES|Comment',
    '1|a|u|acct|gpu|COMPLETED|2026-11-10T00:00:00|2026-11-10T01:00:00|n1|cpu=4,gres/gpu=2,gres/gpu:h100=2|ckpt-every-1h',
    '1.batch|a|u|acct|gpu|COMPLETED|2026-11-10T00:00:00|2026-11-10T01:00:00|n1|gres/gpu=2|',
    '2|b|u|acct|gpu|PENDING|Unknown|Unknown|None|gres/gpu=1|',
    '3|c|u|acct|cpu|COMPLETED|2026-11-10T00:00:00|2026-11-10T01:00:00|n2|cpu=8|',
    '4|d|u|acct|gpu|CANCELLED by 1000|2026-11-10T00:00:00|Unknown|n3|gres/gpu=1|'].join('\n');
  const s = A.slurm(sacct, { now: T0 + 5 * H });
  assert.deepEqual(s.map(x => [x.name, x.gpus, x.gpuType, x.status]), [['a', 2, 'H100', 'succeeded'], ['d', 1, null, 'cancelled']]);
  assert.equal(s[0].labels.comment, 'ckpt-every-1h'); assert.equal(s[1].end, T0 + 5 * H, 'no end: now');
  const oc = A.opencost({ data: [{ __idle__: { gpuHours: 5, start: iso(T0), end: iso(T0 + H) }, zero: { gpuHours: 0 }, bad: { gpuHours: 1, start: iso(T0 + H), end: iso(T0) },
    job: { gpuHours: 2, window: { start: iso(T0), end: iso(T0 + H) }, properties: { pod: 'p1', namespace: 'n' }, gpuAllocation: { gpuModel: 'H100' } } }, null] }, { cluster: 'k' });
  assert.equal(oc.length, 1); assert.deepEqual([oc[0].name, oc[0].kind, oc[0].gpus, oc[0].cluster], ['p1', 'job', 2, 'k']);
  const rows = A.parseCsv('a,b\n"x, y","say ""hi"""\n\n1,2\n'); assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }, { a: '1', b: '2' }]);
  const c = A.csv('start,end,gpus,name,busy,sm,memPeak\n2026-11-10 00:00:00,2026-11-10 01:00:00,2,j,0.5,0.4,0.9\nnever,,1,k,,,\n2026-11-10T00:00:00Z,,0,z,,,\n');
  assert.equal(c.length, 1, 'no start or no GPUs: dropped'); assert.deepEqual(c[0].util, { busy: 0.5, sm: 0.4, memPeak: 0.9 }); assert.equal(c[0].group, 'j');
  assert.equal(A.utilStats([]), null); assert.deepEqual(A.mergeUtil([null], 0.5), { memPeak: 0.5 }); assert.equal(A.mergeUtil([], null), null);
  assert.equal(A.utilStats([[0, 0.5], [60, NaN], [120, null]]).n, 1, 'missing samples are skipped');
});

test('reports without utilization or prices: the caveats, Markdown, showback, FOCUS and HTML still add up', () => {
  const recs = [0, 1, 2, 3].map(i => ({ id: `j${i}`, start: T0 + i * H, end: T0 + (i + 2) * H, gpus: 8, gpuType: 'H100', cluster: 'c', name: `job${i}`, user: 'u' + (i % 2), team: 't', org: 'o', status: i === 0 ? 'cancelled' : i === 1 ? 'failed' : 'succeeded' }));
  const L = ledger(recs, { from: T0, to: T0 + 6 * H, capacity: [{ cluster: 'c', gpuType: 'H100', gpus: 32 }] });
  const t = reportText(L, { by: ['user'], top: 1, md: true, budgets: [{ key: 'o', over: true, perMonth: 10, budget: 5, share: 2 }],
    ins: [{ savings: { gpuHMonth: 12 }, title: 'x', kind: 'k', basis: 'b', confidence: 'low', evidence: 'e', action: 'a' }, { savings: {}, title: 'y', kind: 'k', basis: 'b', confidence: 'low', evidence: 'e', action: 'a', caveat: 'c' }] });
  assert.match(t, /^# GPU ledger/m); assert.match(t, /idle time can't be seen/); assert.match(t, /cancelled runs \(\d+% of GPU-hours\) count as useful/);
  assert.match(t, /^## By user$/m); assert.match(t, /^- OVER o:/m); assert.match(t, /\*\*12 GPU-h\/mo\*\*/); assert.match(t, /… 1 more \(--json for all\)/);
  assert.match(reportText(L, { top: 2, md: true, ins: [{ savings: {}, title: 'y', kind: 'k', basis: 'b', confidence: 'low', evidence: 'e', action: 'a', caveat: 'c' }] }), /unknown\*\* y .*\n.*\n.*→ a \(c\)/); assert.match(t, /unallocated c H100/);
  const sb = showbackCsv(L, { by: ['user'], period: 'day' }); assert.match(sb.split('\n')[0], /^period,user,gpu_hours/); assert.ok(sb.trim().split('\n').length >= 3);
  const f = focusRows(L); assert.ok(f.some(r => r.x_UseCase === 'unallocated')); assert.ok(f.every(r => r.ConsumedUnit === 'GPU-Hours'));
  assert.equal(toCsv(['a', 'b'], [{ a: { x: 1 }, b: null }]), 'a,b\n"{""x"":1}",\n');
  assert.match(html(L, { by: ['org'] }), /<html/);
});

test('CLI: report as Markdown and text, showback and FOCUS to stdout, rates as JSON, CSV import with a column map, errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e-')), d = path.join(dir, 'demo');
  assert.equal(run(['demo', '--out', d]).status, 0);
  const base = ['--usage', path.join(d, 'usage.jsonl'), '--config', path.join(d, 'ledger.json')];
  assert.match(run(['report', ...base, '--format', 'md', '--by', 'org']).stdout, /^# GPU ledger/m);
  const txt = path.join(dir, 'r.txt'); assert.match(run(['report', ...base, '--out', txt]).stdout, /wrote/); assert.match(fs.readFileSync(txt, 'utf8'), /Where to save/);
  assert.match(run(['showback', ...base, '--by', 'team', '--period', 'day']).stdout, /^period,team,/);
  assert.match(run(['focus', ...base]).stdout, /^BilledCost,/);
  assert.ok(JSON.parse(run(['rates', '--config', path.join(d, 'ledger.json'), '--json']).stdout).rates.H100);
  assert.ok(JSON.parse(run(['insights', ...base, '--json']).stdout).insights.length > 0);
  const csvf = path.join(dir, 'u.csv'), out = path.join(dir, 'u.jsonl'); fs.writeFileSync(csvf, 'Begin,Finish,N,Who\n2026-11-10T00:00:00Z,2026-11-10T03:00:00Z,4,zoe\n');
  const im = JSON.parse(run(['import', 'csv', csvf, '--map', 'start=Begin,end=Finish,gpus=N,user=Who', '--out', out, '--json']).stdout); assert.deepEqual([im.records, im.gpuHours], [1, 12]);
  assert.match(run(['import', 'opencost', path.join(FX, 'opencost.json'), '--out', out]).stdout, /1 usage record/);
  assert.match(run(['--help']).stdout, /who used which GPUs/);
  for (const [a, re] of [[['import', 'nope'], /import k8s \| slurm/], [['import', 'slurm', path.join(FX, 'sacct.txt')], /--out usage\.jsonl/], [['report'], /--usage usage\.jsonl/], [['bogus', ...base], /unknown command: bogus/]]) {
    const r = run(a); assert.equal(r.status, 1, a.join(' ')); assert.match(r.stderr, re);
  }
  assert.match(JSON.parse(run(['report', '--json']).stdout).error, /--usage/);
});
