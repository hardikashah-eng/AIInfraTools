// Admission and rollouts beyond the synthetic demo:
//  - real data: the rollout comparison on a real week of Philly jobs, with versions assigned at random (an A/A test,
//    where any regression it reports is a false alarm) and with failures added to the "new" nodes (where it should);
//  - no mocks: admit-node.sh on this host with nothing stubbed;
//  - mocked: a live admit and reject through a stand-in kubectl, after approval, with both locks open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import * as Philly from '../src/adapters/philly.mjs';
import * as RO from '../src/rollout.mjs';
import { Store as GhStore } from '../../gpu-health/src/actions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const REAL = path.join(here, 'fixtures', 'real');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adm-real-'));

function phillyWeek() {
  const jobs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, 'philly-job-log-2017-11-07-15.json.gz'))).toString());
  const from = Date.UTC(2017, 10, 8, 8) / 1000, to = from + 7 * 86400; // 8–15 Nov, Pacific
  const x = Philly.jobLog(jobs, { from, to });
  const used = new Set(x.placements.flatMap(p => p.devices.map(d => d.node)));
  const inv = Philly.machines(fs.readFileSync(path.join(REAL, 'philly-machine-list.csv'), 'utf8'), { t: from }).filter(m => used.has(m.node));
  return { x, inv, from, to };
}
function splits(n, boost, seed0) {
  const { x, inv, from, to } = phillyWeek();
  const sku = inv.filter(m => m.sku === '12GB GPU').map(m => m.node); // the larger SKU: 238 machines in use that week
  let seed = seed0; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = [];
  for (let r = 0; r < n; r++) {
    const T = new Set(sku.filter(() => rnd() < 0.1)), s = new MemStore();
    s.append('placement', x.placements); s.append('job', x.outcomes);
    s.append('inventory', inv.map(m => Object.assign({}, m, { versions: { driver: T.has(m.node) ? 'new' : 'old' } })));
    // a regression that multiplies the failure rate on the new nodes by (1 + boost)
    if (boost) s.append('job', x.outcomes.filter(o => o.status === 'failed' && o.devices.some(d => T.has(d.node)))
      .flatMap(o => Array.from({ length: boost }, (_, b) => Object.assign({}, o, { job: `${o.job}+${b}`, devices: o.devices.filter(d => T.has(d.node)) }))));
    out.push(RO.compare(s, { field: 'driver', version: 'new', since: from, now: to }));
  }
  return out;
}

test('real data (Philly, one week): random version splits are not called regressions; failures are clustered, and the test allows for it', () => {
  const rs = splits(100, 0, 7);
  assert.ok(rs.every(r => r.ok !== null), 'a week of real jobs is enough exposure to judge');
  const alarms = rs.filter(r => r.ok === false).length;
  // α = 0.01: about one false alarm in 100. A plain Poisson test raised 17 in 100 here (failures cluster on flaky
  // machines and multi-node jobs); the between-node dispersion brings it back to the nominal rate.
  assert.ok(alarms <= 3, `${alarms} false alarms in 100 A/A splits`);
  const jf = rs[0].metrics.find(m => m.name === 'job failures');
  assert.ok(jf.dispersion > 2, `real failures are overdispersed (φ ${jf.dispersion})`);
});

test('real data (Philly, one week): tripling the failure rate on a 10% canary is caught in most splits', () => {
  const rs = splits(30, 2, 11), caught = rs.filter(r => r.ok === false).length;
  assert.ok(caught >= 0.6 * rs.length, `caught ${caught} of ${rs.length}`);
  assert.ok(rs.filter(r => r.ok === false).every(r => r.metrics.find(m => m.name === 'job failures').regression));
});

test('no mocks: admit-node.sh on this host refuses cleanly without NVIDIA tools, or records the node when it has them', () => {
  const dir = tmp(), out = path.join(dir, 'admit.jsonl');
  const r = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', os.hostname(), '--skip', 'burn-in,sdc,nccl,dcgm', '--out', out], { encoding: 'utf8', timeout: 300000 });
  if (spawnSync('bash', ['-lc', 'command -v nvidia-smi']).status !== 0) {
    assert.equal(r.status, 1); assert.match(r.stderr, /nvidia-smi not found/); assert.ok(!fs.existsSync(out) || !fs.readFileSync(out, 'utf8').trim());
  } else {
    assert.ok(r.status === 0 || r.status === 2, r.stderr); // 2: GPUs busy
    if (r.status === 0) { const recs = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l)); assert.ok(recs.find(x => x.record === 'inventory').devices >= 1); }
  }
});

test('mocked kubectl: a live admit runs only after approval and with both locks open; a reject runs on its own', async () => {
  const dir = tmp(), bin = path.join(dir, 'bin'), calls = path.join(dir, 'calls.log'), store = path.join(dir, 'store');
  fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'kubectl'), `#!/usr/bin/env bash\necho "$*" >> ${calls}\n`); fs.chmodSync(path.join(bin, 'kubectl'), 0o755);
  const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}` });
  const now = 1795000000, rec = (node, extra = {}) => [
    { record: 'inventory', t: now, node, sku: 'NVIDIA H100 80GB HBM3', vendor: 'nvidia', devices: 8, versions: { driver: '550.54.15' } },
    ...['dcgm-diag', 'topology', 'versions', 'burn-in', 'sdc-canary'].map(check => ({ record: 'check', t: now, node, check, ok: true })),
    Object.assign({ record: 'check', t: now, node, check: 'nccl-allreduce', value: 410, ok: true }, extra)];
  const f = path.join(dir, 'admit.jsonl');
  fs.writeFileSync(f, [...rec('good1'), ...rec('bad1', { value: 120 })].map(x => JSON.stringify(x)).join('\n'));
  await run(process.execPath, [cli, 'data', 'import', 'admission', f, '--store', store], { env });
  const pol = path.join(dir, 'p.json'); fs.writeFileSync(pol, JSON.stringify({ require: ['dcgm-diag', 'nccl', 'topology', 'versions'], ncclRef: { 'NVIDIA H100 80GB HBM3': 400 }, golden: { 'NVIDIA H100 80GB HBM3': { driver: '550.54.15' } } }));
  const live = path.join(dir, 'gh.json'); fs.writeFileSync(live, JSON.stringify({ policy: { dryRun: false } }));
  const cmd = (node, ...more) => run(process.execPath, [cli, 'admit', 'apply', node, '--policy', pol, '--store', store, '--now', String(now + 60), '--json', ...more], { env }).then(r => JSON.parse(r.stdout), e => JSON.parse(e.stdout));
  // reject: automatic, but still a dry run without --live and the config lock
  const rj0 = await cmd('bad1'); assert.equal(rj0.admission.verdict, 'reject'); assert.ok(rj0.result.dryRun); assert.ok(!fs.existsSync(calls));
  const rj = await cmd('bad1', '--live', '--config', live); assert.equal(rj.result.ok, true);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['label node bad1 aiinfra.dev/admission=rejected --overwrite']);
  // admit: proposed, nothing runs even with --live until a person approves
  const a0 = await cmd('good1', '--live', '--config', live); assert.equal(a0.action.status, 'proposed'); assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  const q = new GhStore(path.join(store, 'rollouts', 'state')); q.get(a0.action.id).status = 'approved'; q.save();
  const a1 = await cmd('good1', '--live', '--config', live); assert.equal(a1.result.ok, true);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').slice(1), ['taint node good1 aiinfra.dev/admission-', 'label node good1 aiinfra.dev/admission=admitted --overwrite']);
});
