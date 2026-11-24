import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../src/store.mjs';
import { validate } from '../src/schema.mjs';
import * as Logs from '../src/adapters/logs.mjs';
import * as Topo from '../src/adapters/topology.mjs';
import * as Live from '../src/adapters/live.mjs';
import { toGpuHealth } from '../src/export.mjs';
import { diagnose } from '../src/rca.mjs';
import { loadConfig } from '../../gpu-health/src/config.mjs';
import { faultDef } from '../../gpu-health/src/vendors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => fs.readFileSync(path.join(here, 'fixtures', 'signals', f), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-sig-'));
const T0 = Date.UTC(2026, 10, 23, 10, 0, 0) / 1000;

// ---------- adapters ----------

test('signals: kernel logs in every timestamp format, XIDs classed by gpu-health\'s table, GPU index from the PCI map', () => {
  const k = Logs.kernelLog(fx('kernel.log'), { pciMap: { 'gpu-a01': { '0000:18:00': '0', '0000:3b:00': '1' } } });
  assert.deepEqual(k.map(r => r.code), ['xid48', 'xid63', 'pcie_aer_corrected', 'nfs_timeout', 'host_oom']);
  const x48 = k[0];
  assert.equal(x48.gpu, '1'); assert.equal(x48.class, 'ecc'); assert.equal(x48.severity, 'hard'); assert.equal(x48.node, 'gpu-a01');
  assert.equal(x48.t, T0 + 131);
  assert.equal(k[3].server, 'storage01');
  const raw = Logs.kernelLog(fx('dmesg_raw.txt'), { node: 'gpu-a02', boot: T0 - 3600, pciMap: { '0000:18:00': '0' } });
  assert.deepEqual(raw.map(r => [r.code, r.gpu, Math.round(r.t)]), [['xid79', '0', T0 + 2], ['pcie_aer_uncorrected', '0', T0 + 5]]);
  assert.equal(Logs.lineTime('[Mon Nov 23 10:00:00 2026] x', { utcOffset: -10 }).t, T0 + 36000, 'dmesg -T is host local time');
  assert.equal(Logs.lineTime('Nov 23 10:00:00 h kernel: x', { year: 2026 }).t, T0);
  for (const r of [...k, ...raw]) assert.deepEqual(validate('log', r), []);
  // a NIC's PCI address never becomes a GPU index; info lines are dropped unless asked for
  const nic = Logs.kernelLog('2026-11-23T10:00:00Z h kernel: mlx5_core 0000:18:00.0: Port module event: link down', { pciMap: { h: { '0000:18:00': '0' } } });
  assert.equal(nic[0].code, 'ib_link_down'); assert.equal(nic[0].gpu, undefined);
  assert.equal(Logs.kernelLog(fx('kernel.log'), { keepInfo: true }).filter(r => r.severity === 'info').length, 1, 'nfs OK');
  assert.equal(Logs.kernelLog('2026-11-23T10:00:00Z h kernel: nvidia library loaded, link down never').length, 0, 'no false match on words');
});

test('signals: NCCL / PyTorch logs give rank, op, version, and host from the NCCL prefix', () => {
  const r = Logs.ncclLog(fx('train.log'), { node: 'gpu-a01', job: 'train-7b', t: T0 });
  assert.deepEqual(r.map(x => [x.code, x.node, x.rank]), [['nccl_version', 'gpu-a01', 0], ['nccl_timeout', 'gpu-a01', 3], ['nccl_ib_error', 'gpu-a02', 5]]);
  assert.equal(r[0].version, '2.21.5'); assert.equal(r[1].op, 'ALLREDUCE'); assert.equal(r[1].t, T0 + 900.12);
  assert.ok(r.every(x => x.job === 'train-7b'));
});

test('signals: nvidia-smi -q versions and PCI map; topo -m; ibnetdiscover; racks; groups', () => {
  const q = Topo.nvidiaSmiQ(fx('nvidia_smi_q.txt'), { node: 'gpu-a01', t: T0 });
  assert.deepEqual(q.inventory.versions, { driver: '550.54.15', cuda: '12.4', vbios: '96.00.74.00.0D', inforom: 'G520.0200.00.05' });
  assert.deepEqual(q.inventory.mixedVersions, ['vbios'], 'two VBIOS versions in one node is worth knowing');
  assert.deepEqual(q.pciMap, { '0000:18:00': '0', '0000:3b:00': '1' });
  assert.equal(q.inventory.gpus[1].serial, '1650823012399');
  const topo = Topo.nvidiaTopo(fx('nvidia_topo.txt'), { node: 'gpu-a01', t: T0 });
  assert.deepEqual(topo.filter(e => e.kind === 'nvlink').map(e => [e.from, e.to, e.links]), [['gpu-a01/gpu0', 'gpu-a01/gpu1', 18]]);
  assert.deepEqual(topo.filter(e => e.near).map(e => `${e.from}>${e.to}`), ['gpu-a01/gpu0>gpu-a01/mlx5_0', 'gpu-a01/gpu1>gpu-a01/mlx5_1']);
  const ib = Topo.ibnetdiscover(fx('ibnetdiscover.txt'), { t: T0 });
  assert.deepEqual(ib.filter(e => !e.uplink).map(e => `${e.from}>${e.to}`), ['gpu-a01>switch:leaf-01', 'gpu-a02>switch:leaf-01', 'gpu-a03>switch:leaf-02']);
  assert.deepEqual(ib.filter(e => e.uplink).map(e => `${e.from}>${e.to}`), ['switch:leaf-01>switch:spine-01', 'switch:leaf-02>switch:spine-01']);
  const g = Topo.groups([...ib, ...Topo.racks(fx('racks.csv'), { t: T0 })]);
  assert.deepEqual(g.byNode['gpu-a01'], { leaf: ['switch:leaf-01'], rack: 'rack:R12', row: 'row:B', pdu: 'pdu:P3', site: 'site:dc1' });
  assert.deepEqual([...g.members['switch:spine-01'].nodes].sort(), ['gpu-a01', 'gpu-a02', 'gpu-a03']);
  for (const e of [...topo, ...ib]) assert.deepEqual(validate('topology', e), []);
});

test('signals: Kubernetes versions, rack labels, events; Helm history; Slurm kernel', () => {
  const n = Live.k8sNodes(fx('k8s_nodes_versions.json'), { t: T0 });
  assert.deepEqual(n.map(x => x.versions.driver), ['550.54.15', '535.161.08'], 'GFD major/minor/rev and the full-version label');
  assert.equal(n[0].versions.kernel, '5.15.0-91-generic'); assert.equal(n[0].rack, 'R12');
  assert.deepEqual(Live.k8sNodeTopology(fx('k8s_nodes_versions.json'), { t: T0 }).map(e => e.to), ['rack:R12', 'site:dc1', 'rack:R12', 'site:dc1']);
  const ev = Live.k8sEvents(fx('k8s_events.json'));
  assert.deepEqual(ev.changes.map(c => [c.kind, c.target]), [['config', 'gpu-a01'], ['scale', 'serving/vllm-70b']]);
  assert.deepEqual(ev.logs.map(l => [l.code, l.node, l.class]), [['node_not_ready', 'gpu-a03', 'node'], ['mount_failed', 'gpu-a02', 'storage']]);
  const h = Live.helmHistory(fx('helm_history.json'), { release: 'vllm-70b', namespace: 'serving' });
  assert.deepEqual(h.map(c => [c.id, c.to, c.from]), [['serving/vllm-70b#1', 'vllm-0.4.1', undefined], ['serving/vllm-70b#2', 'vllm-0.4.2', 'vllm-0.4.1']]);
  assert.equal(h[1].t, Date.UTC(2026, 10, 23, 9, 55, 0.5) / 1000 + 0.5);
  const s = Live.slurmNodes('NodeName=g01 Arch=x86_64 Gres=gpu:h100:8 OS=Linux 5.15.0-91-generic #101-Ubuntu SMP State=IDLE', { t: T0 });
  assert.equal(s[0].versions.kernel, '5.15.0-91-generic');
});

test('signals: CLI import derives version changes between snapshots and sends log faults to gpu-health', () => {
  const dir = tmp(), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), q2 = path.join(dir, 'q2.txt');
  const run = (...a) => execFileSync(process.execPath, [cli, ...a, '--store', dir], { encoding: 'utf8' });
  const f = n => path.join(here, 'fixtures', 'signals', n);
  run('data', 'import', 'nvidia-smi-q', f('nvidia_smi_q.txt'), '--node', 'gpu-a01', '--t', String(T0 - 3600));
  run('data', 'import', 'kernel-log', f('dmesg_raw.txt'), '--node', 'gpu-a01', '--boot', String(T0 - 3600));
  fs.writeFileSync(q2, fx('nvidia_smi_q.txt').replace('550.54.15', '560.35.03'));
  run('data', 'import', 'nvidia-smi-q', q2, '--node', 'gpu-a01', '--t', String(T0 + 3600));
  const s = new DataStore(dir), ch = s.query('change');
  assert.equal(ch.length, 1);
  assert.deepEqual([ch[0].kind, ch[0].target, ch[0].from, ch[0].to, ch[0].since], ['driver', 'gpu-a01', '550.54.15', '560.35.03', T0 - 3600]);
  const logs = s.query('log');
  assert.equal(logs[0].gpu, '0', 'GPU index from the nvidia-smi -q already in the store');
  const gh = toGpuHealth(s, {});
  assert.deepEqual(gh.results.filter(r => r.kind === 'fault').map(r => [r.node, r.gpu, r.code]), [['gpu-a01', '0', 'xid79'], ['gpu-a01', '0', 'pcie_aer_uncorrected']]);
  // gpu-health knows every code the log adapter can send it
  const cfg = loadConfig();
  for (const [code, cls, sev] of [['xid79', 'bus', 'hard'], ['pcie_aer_uncorrected', 'pcie', 'hard'], ['pcie_aer_corrected', 'pcie', 'ignore'], ['nvlink_error', 'link', 'hard'], ['ras_uncorrectable', 'ecc', 'hard'], ['amd_gpu_reset', 'firmware', 'soft']])
    assert.deepEqual(faultDef(cfg, 'nvidia', code), { class: cls, severity: sev }, code);
});

// ---------- root-cause scenarios (milestone 5's done-when) ----------

// 12 nodes, 3 leaf switches of 4, 2 racks of 6, all on driver 550; four owners run 2-GPU jobs everywhere.
const NODES = Array.from({ length: 12 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`);
function fleet({ fail = {}, logs = [], versions = {}, changes = [] }) {
  const s = new DataStore(tmp()), owners = ['u1', 'u2', 'u3', 'u4'];
  const topo = NODES.flatMap((n, i) => [{ t: T0 - 86400, kind: 'ib', from: n, to: `switch:leaf-${Math.floor(i / 4) + 1}` }, { t: T0 - 86400, kind: 'rack', from: n, to: `rack:R${Math.floor(i / 6) + 1}` }]);
  topo.push(...[1, 2, 3].map(l => ({ t: T0 - 86400, kind: 'ib', from: `switch:leaf-${l}`, to: 'switch:spine-1', uplink: true })));
  s.append('topology', topo);
  s.append('inventory', NODES.map(n => ({ t: T0 - 86400, node: n, vendor: 'nvidia', kind: 'gpu', sku: 'H100', devices: 8, versions: Object.assign({ driver: '550.54.15', kernel: '5.15.0-91' }, versions[n] || {}) })));
  const placements = [], jobs = [];
  let k = 0;
  const job = (n, t, status) => { const id = `j${k++}`, owner = owners[k % 4]; placements.push({ t: t - 600, job: id, owner, namespace: `ns-${owner}`, start: t - 600, devices: [{ node: n, gpu: '0' }, { node: n, gpu: '1' }] }); jobs.push({ t, job: id, status, cause: 'unknown', start: t - 600, end: t, devices: [{ node: n, gpu: '0' }, { node: n, gpu: '1' }], gpus: 2 }); };
  for (const n of NODES) for (let i = 0; i < 6; i++) job(n, T0 - 20 * 3600 + i * 3000, 'ok');   // the day before: all fine
  for (const n of NODES) for (let i = 0; i < 2; i++) job(n, T0 + 600 + i * 1200, 'ok');         // the window: some still fine
  for (const [n, c] of Object.entries(fail)) for (let i = 0; i < c; i++) job(n, T0 + 300 + i * 200, 'failed');
  s.append('placement', placements); s.append('job', jobs);
  if (logs.length) s.append('log', logs);
  if (changes.length) s.append('change', changes);
  return s;
}
const INC = { symptom: 'job-failures', from: T0, to: T0 + 3600 };
const top = d => { if (process.env.SHOW) console.log(d.hypotheses.map(h => `${h.rule} ${h.score.toFixed(2)}`).join(' | '), '·', d.confidence); return d.hypotheses[0]; };

test('rca scenario: a GPU fault seen only in dmesg ranks hardware first, citing the XID', () => {
  const s = fleet({ fail: { n03: 8, n07: 1 }, logs: Logs.kernelLog('[ 60.000001] NVRM: Xid (PCI:0000:3b:00): 79, pid=1, name=python3, GPU has fallen off the bus.', { node: 'n03', boot: T0, pciMap: { '0000:3b:00': '2' } }) });
  const d = diagnose(s, INC);
  assert.equal(top(d).rule, 'hardware', JSON.stringify(d.hypotheses.map(h => [h.rule, h.score.toFixed(2)])));
  assert.ok(top(d).evidence.some(e => /n03\/2 logged xid79/.test(e.what) && e.refs[0].kind === 'log'));
  assert.ok(!d.hypotheses.some(h => h.rule === 'shared-component'), 'one node is not a shared component');
});

test('rca scenario: failures behind one leaf switch rank shared-component first, with the fabric errors', () => {
  const logs = ['n05', 'n06', 'n07'].flatMap(n => Logs.ncclLog(`${n}:1:1 [0] NCCL WARN NET/IB : Got completion from peer 10.0.0.1<1> with error 12`, { t: T0 + 250 }));
  const s = fleet({ fail: { n05: 3, n06: 3, n07: 3, n08: 3 }, logs });
  const d = diagnose(s, INC);
  assert.equal(top(d).rule, 'shared-component', JSON.stringify(d.hypotheses.map(h => [h.rule, h.score.toFixed(2)])));
  assert.match(top(d).title, /leaf switch leaf-2: 4 of 4 affected nodes/);
  assert.ok(top(d).evidence.some(e => /fabric error\(s\) behind it: nccl_ib_error/.test(e.what)));
  assert.ok(!d.hypotheses.some(h => h.rule === 'version-cohort'));
});

test('rca scenario: failures on the nodes that got a new driver rank version-cohort first, citing the rollout', () => {
  const bad = ['n02', 'n06', 'n10', 'n12']; // spread over leaves and racks on purpose
  const s = fleet({ fail: Object.fromEntries(bad.map(n => [n, 3])), versions: Object.fromEntries(bad.map(n => [n, { driver: '560.35.03' }])),
    changes: bad.map(n => ({ t: T0 + 1800, since: T0 - 3 * 3600, kind: 'driver', target: n, field: 'driver', from: '550.54.15', to: '560.35.03', summary: 'driver 550.54.15 → 560.35.03', id: `${n}:driver:560.35.03` })) });
  const d = diagnose(s, INC);
  assert.equal(top(d).rule, 'version-cohort', JSON.stringify(d.hypotheses.map(h => [h.rule, h.score.toFixed(2)])));
  assert.match(top(d).title, /driver 560\.35\.03 on 4 of 4 affected nodes, 0 of 8 others/);
  assert.ok(top(d).evidence.some(e => /moved to 560\.35\.03 recently/.test(e.what)));
  assert.ok(d.hypotheses.some(h => h.rule === 'change'), 'the snapshot change counts though it was seen after onset (since … t)');
  assert.ok(!d.hypotheses.some(h => h.rule === 'shared-component'));
});

test('rca scenario: a storage outage across owners ranks infrastructure first and names storage', () => {
  const failing = ['n01', 'n03', 'n05', 'n07', 'n09', 'n11'];
  const logs = failing.slice(0, 5).flatMap(n => Logs.kernelLog(`2026-11-23T10:04:00Z ${n} kernel: nfs: server storage01 not responding, still trying`));
  const s = fleet({ fail: Object.fromEntries(failing.map(n => [n, 3])), logs });
  const d = diagnose(s, INC);
  assert.equal(top(d).rule, 'infrastructure', JSON.stringify(d.hypotheses.map(h => [h.rule, h.score.toFixed(2)])));
  assert.match(top(d).title, /Shared storage: 5 of 6 failing nodes logged nfs_timeout/);
  assert.match(top(d).verify[0], /storage01/);
});
