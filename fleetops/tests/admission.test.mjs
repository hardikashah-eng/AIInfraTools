import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import * as Adm from '../src/admission.mjs';
import * as RO from '../src/rollout.mjs';
import { Store as GhStore } from '../../gpu-health/src/actions.mjs';
import { loadConfig } from '../../gpu-health/src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'admit-'));
const H = 3600, T0 = Date.UTC(2026, 10, 20) / 1000, NOW = T0 + 2 * 86400;
const V = { driver: '550.54.15', cuda: '12.4', nccl: '2.21.5', vbios: '96.00.89.00.01', kernel: '5.15.0-105' };

// five admitted H100 peers, and a candidate whose results are shaped by `o`
function fleet(o = {}) {
  const s = new MemStore(), peers = ['p1', 'p2', 'p3', 'p4', 'p5'];
  s.append('inventory', peers.map(n => ({ t: T0 - 30 * 86400, node: n, sku: 'H100', devices: 8, versions: V })));
  s.append('admission', peers.map(n => ({ t: T0 - 20 * 86400, node: n, verdict: 'admit' })));
  s.append('check', peers.flatMap(n => [{ t: T0 - 20 * 86400, node: n, check: 'nccl-allreduce', value: 400 }, { t: T0 - 20 * 86400, node: n, check: 'pcie', value: 'gen5x16' }]));
  const links = (n, k) => Array.from({ length: 8 }, (_, g) => Array.from({ length: k }, (_, l) => ({ t: T0 - 20 * 86400, kind: 'nvlink', from: `${n}/gpu${g}`, to: `nvlink:${n}/gpu${g}/link${l}` }))).flat();
  s.append('topology', peers.flatMap(n => links(n, 18)));
  const N = 'new1';
  s.append('inventory', [{ t: NOW - 86400, node: N, sku: 'H100', devices: 8, versions: Object.assign({}, V, o.versions) }]);
  if (o.burnH !== 0) { const dev = []; for (let i = 0; i < (o.burnH ?? 7) * 60; i++) for (let g = 0; g < 8; g++) dev.push({ t: NOW - 10 * H + i * 60, node: N, gpu: g, tensor: 0.85, tempC: o.temp ?? 74, memTempC: 80, eccDbeTotal: 0 }); s.append('device', dev); }
  if (o.diag !== null) s.append('check', [{ t: NOW - 2 * H, node: N, check: 'dcgm-diag', ok: o.diag ?? true, detail: o.diag === false ? 'level 3: Memory gpu 3' : 'level 3: 120 results passed' }]);
  if (o.sdc !== null) s.append('sdc_check', Array.from({ length: 8 }, (_, g) => ({ t: NOW - H, check: 'canary', node: N, gpu: String(g), ok: !(o.sdc === 'bad' && g === 5) })));
  s.append('check', [{ t: NOW - H, node: N, check: 'nccl-allreduce', value: o.nccl ?? 395 }, { t: NOW - H, node: N, check: 'pcie', value: o.pcie ?? 'gen5x16' }]);
  s.append('topology', links(N, o.links ?? 18));
  return { s, N };
}
const ev = (o, policy) => { const { s, N } = fleet(o); return Adm.evaluate(s, N, { now: NOW, policy }); };
const st = (v, name) => v.checks.find(c => c.name === name).status;

test('admission: a healthy node passes every check against its admitted peers', () => {
  const v = ev({});
  assert.equal(v.verdict, 'admit', JSON.stringify(v.checks));
  assert.ok(v.checks.every(c => c.status === 'pass'));
  assert.match(v.checks.find(c => c.name === 'nccl').evidence, /99% of 400 \(median of 5 admitted H100/);
});

test('admission: each failure rejects with the evidence; missing checks leave it incomplete with the fix', () => {
  const nccl = ev({ nccl: 300 }); assert.equal(nccl.verdict, 'reject'); assert.equal(st(nccl, 'nccl'), 'fail'); assert.match(nccl.checks.find(c => c.name === 'nccl').evidence, /75%/);
  const ver = ev({ versions: { driver: '535.104.05' } }); assert.equal(ver.verdict, 'reject'); assert.match(ver.checks.find(c => c.name === 'versions').evidence, /driver 535\.104\.05, baseline 550\.54\.15/);
  assert.equal(st(ev({ temp: 93 }), 'burn-in'), 'fail');
  assert.equal(st(ev({ links: 12 }), 'topology'), 'fail');
  assert.equal(st(ev({ pcie: 'gen4x8' }), 'topology'), 'fail');
  assert.equal(st(ev({ diag: false }), 'dcgm-diag'), 'fail');
  const sdc = ev({ sdc: 'bad' }); assert.equal(sdc.verdict, 'reject'); assert.match(sdc.checks.find(c => c.name === 'sdc-canary').evidence, /GPU 5/);
  const short = ev({ burnH: 2 }); assert.equal(short.verdict, 'incomplete'); assert.match(short.checks.find(c => c.name === 'burn-in').fix, /--burn-in 6h/);
  const nosdc = ev({ sdc: null }); assert.deepEqual(nosdc.missing, ['sdc-canary']);
  // a fail wins over a missing check; a policy can drop a check from the gate
  assert.equal(ev({ sdc: null, nccl: 200 }).verdict, 'reject');
  assert.equal(ev({ sdc: null }, { require: ['burn-in', 'dcgm-diag', 'nccl', 'topology', 'versions'] }).verdict, 'admit');
  assert.equal(st(ev({ versions: { driver: '560.35.03' } }, { golden: { H100: { driver: '560.35.03' } } }), 'versions'), 'pass', 'a golden version overrides the fleet');
});

test('admission: pending lists new nodes, nodes back from quarantine and hand-changed nodes', () => {
  const { s } = fleet({});
  s.append('health', [{ t: NOW - H, key: 'p2/3', node: 'p2', gpu: '3', from: 'quarantined', to: 'healthy', why: 'released' }]);
  s.append('change', [{ t: NOW - H, kind: 'hardware', target: 'p4', summary: 'replaced GPU 2' }]);
  const p = Adm.pending(s, { now: NOW });
  assert.deepEqual(p.map(x => x.node), ['new1', 'p2', 'p4']);
  assert.match(p.find(x => x.node === 'p4').reasons[0], /hardware change: replaced GPU 2/);
});

test('rollout comparison: a bad driver regresses on faults, NCCL and step compute; a good one does not', () => {
  for (const bad of [true, false]) {
    const d = RO.synth({ bad }), s = new MemStore(); for (const [k, v] of Object.entries(d.records)) s.append(k, v);
    const g = RO.compare(s, { field: 'driver', version: d.neu, since: d.canaryAt, now: d.end });
    if (bad) { assert.equal(g.ok, false); for (const m of ['hard faults', 'NCCL bus bandwidth', 'compute time per step (same job)']) assert.ok(g.metrics.find(x => x.name === m).regression, m); }
    else { assert.equal(g.ok, true, g.note); assert.ok(!g.metrics.some(x => x.regression)); }
  }
  assert.ok(RO.poissonSf(5, 1) < 0.01 && RO.poissonSf(1, 1) > 0.6); assert.ok(RO.mwLess([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]) < 0.01);
});

test('rollout: canary across racks → approval → apply (dry run) → bake → bad: rolled back and halted; good: verified, next wave waits', async () => {
  for (const bad of [true, false]) {
    const d = RO.synth({ bad, canary: ['gpu-a01', 'gpu-b01'] }), s = new MemStore(); for (const [k, v] of Object.entries(d.records)) s.append(k, v);
    const dir = tmp(), p = RO.plan(s, { field: 'driver', version: d.neu, canary: 2, waves: ['25%', '100%'], now: d.canaryAt - 1, apply: [['ansible-playbook', 'driver.yml', '-l', '{node}', '-e', 'v={version}']], rollback: [['ansible-playbook', 'driver.yml', '-l', '{node}', '-e', 'v=550.54.15']] });
    assert.deepEqual(p.stages[0].nodes, ['gpu-a01', 'gpu-b01'], 'the canary spans racks');
    assert.equal(p.stages.reduce((a, x) => a + x.nodes.length, 0), 24); assert.equal(p.from, d.old);
    assert.deepEqual(p.stages[0].apply[0], ['ansible-playbook', 'driver.yml', '-l', 'gpu-a01', '-e', `v=${d.neu}`]);
    const ids = RO.enqueue(p, dir, d.canaryAt - 1), cfg = loadConfig();
    let r = await RO.advance(p, { store: s, stateDir: dir, cfg, now: d.canaryAt });
    assert.match(r.log.at(-1), /waits for approval/);
    const q = new GhStore(dir); const a = q.get(ids[0]); a.status = 'approved'; a.approvedBy = 'test'; q.save();
    r = await RO.advance(p, { store: s, stateDir: dir, cfg, now: d.canaryAt });
    assert.equal(p.stages[0].status, 'applied'); assert.ok(p.stages[0].applyResult.dryRun, 'dry run unless --live');
    r = await RO.advance(p, { store: s, stateDir: dir, cfg, now: d.canaryAt + 3 * H });
    assert.match(r.log[0], /baking/);
    r = await RO.advance(p, { store: s, stateDir: dir, cfg, now: d.end });
    if (bad) {
      assert.equal(p.status, 'halted'); assert.equal(p.stages[0].status, 'rolled-back'); assert.equal(p.stages[1].status, 'pending', 'later waves never run');
      assert.deepEqual(p.stages[0].rollbackResult.commands[0], ['ansible-playbook', 'driver.yml', '-l', 'gpu-a01', '-e', 'v=550.54.15']);
      assert.ok(s.query('rollout', {}).some(x => x.event === 'rolled-back'));
      assert.match((await RO.advance(p, { store: s, stateDir: dir, cfg, now: d.end + H })).log[0], /halted/);
    } else {
      assert.equal(p.stages[0].status, 'verified'); assert.match(r.log.at(-1), /wave 1.*waits for approval/);
    }
  }
});

test('admit-node.sh against stand-in nvidia-smi, dcgmi and all_reduce_perf; import; verdict; apply needs approval to admit', async () => {
  const dir = tmp(), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  w('nvidia-smi', `case "$*" in
  *compute-apps*) ;;
  *--query-gpu=name*) for i in 0 1 2 3 4 5 6 7; do echo "NVIDIA H100 80GB HBM3"; done;;
  *--query-gpu=index*) for i in 0 1 2 3 4 5 6 7; do echo $i; done;;
  *driver_version*) echo 550.54.15;;
  *vbios_version*) for i in 0 1 2 3 4 5 6 7; do echo 96.00.89.00.01; done;;
  *pcie.link*) for i in 0 1 2 3 4 5 6 7; do echo "5, 16"; done;;
  *"nvlink -s"*) for g in 0 1; do echo "GPU $g: NVIDIA H100"; for l in 0 1 2; do echo "	 Link $l: 26.562 GB/s"; done; done;;
  *) echo "| NVIDIA-SMI 550.54.15   Driver Version: 550.54.15   CUDA Version: 12.4 |";;
esac`);
  w('dcgmi', `echo '{"DCGM GPU Diagnostic":{"test_categories":[{"category":"Hardware","tests":[{"name":"Memory","results":[{"gpu_id":"0","status":"Pass"},{"gpu_id":"1","status":"Pass"}]}]}]}}'`);
  w('all_reduce_perf', `echo "# Avg bus bandwidth    : 412.50"`);
  w('python3', `exec ${spawnSync('bash', ['-lc', 'command -v python3']).stdout.toString().trim()} "$@"`);
  const out = path.join(dir, 'admit.jsonl'), env = Object.assign({}, process.env, { PATH: `${bin}:/usr/bin:/bin` });
  const r = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', 'new1', '--skip', 'sdc', '--out', out], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const recs = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const inv = recs.find(x => x.record === 'inventory'); assert.equal(inv.devices, 8); assert.equal(inv.versions.driver, '550.54.15'); assert.equal(inv.versions.cuda, '12.4');
  assert.equal(recs.find(x => x.check === 'pcie').value, 'gen5x16'); assert.equal(recs.find(x => x.check === 'nccl-allreduce').value, 412.5);
  assert.equal(recs.find(x => x.check === 'dcgm-diag').ok, true); assert.equal(recs.filter(x => x.record === 'topology').length, 6);
  // refuses while jobs run on the GPUs
  w('nvidia-smi', `case "$*" in *compute-apps*) echo 1234;; esac`);
  const busy = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', 'new1', '--out', path.join(dir, 'x.jsonl')], { env, encoding: 'utf8' });
  assert.notEqual(busy.status, 0); assert.match(busy.stderr, /compute processes are running/);
  // import into a store with peers, then the verdict and the gate's action
  const store = path.join(dir, 'store');
  await run(process.execPath, [cli, 'data', 'import', 'admission', out, '--store', store]);
  const c = JSON.parse((await run(process.execPath, [cli, 'admit', 'check', 'new1', '--store', store, '--json']).catch(e => e)).stdout).admission;
  assert.equal(c.verdict, 'incomplete'); assert.ok(c.missing.includes('burn-in') && c.missing.includes('sdc-canary'));
  const pol = path.join(dir, 'policy.json'); fs.writeFileSync(pol, JSON.stringify({ require: ['dcgm-diag', 'nccl', 'topology', 'versions'], ncclRef: { 'NVIDIA H100 80GB HBM3': 400 }, golden: { 'NVIDIA H100 80GB HBM3': { driver: '550.54.15' } } }));
  const ap = JSON.parse((await run(process.execPath, [cli, 'admit', 'apply', 'new1', '--policy', pol, '--store', store, '--json'])).stdout);
  assert.equal(ap.admission.verdict, 'admit'); assert.equal(ap.action.kind, 'admit-node'); assert.equal(ap.action.status, 'proposed'); assert.equal(ap.result, null, 'admitting waits for a person');
  const q = new GhStore(path.join(store, 'rollouts', 'state')); const a = q.get(ap.action.id); a.status = 'approved'; q.save();
  const ap2 = JSON.parse((await run(process.execPath, [cli, 'admit', 'apply', 'new1', '--policy', pol, '--store', store, '--json'])).stdout);
  assert.ok(ap2.result.dryRun); assert.deepEqual(ap2.result.commands[0], ['kubectl', 'taint', 'node', 'new1', 'aiinfra.dev/admission-']);
});
