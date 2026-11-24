// Fabric and storage adapters on real files, the collector on this host, and the collector against a stand-in sysfs
// and ethtool (the case a CI runner with Mellanox NICs hits, made deterministic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as F from '../src/adapters/fabric.mjs';
import * as S from '../src/adapters/storage.mjs';
import { sniff } from '../src/bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), REAL = path.join(here, 'fixtures', 'real'), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const read = f => fs.readFileSync(path.join(REAL, f), 'utf8'), T = 1.79e9;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fab-real-'));
const has = c => spawnSync('bash', ['-lc', `command -v ${c}`]).status === 0;

test('real sysfs IB counters (mlx4, mlx5, hfi1): per port, data in bytes, the same values as prometheus/procfs', () => {
  const text = read('sysfs-infiniband-counters.txt'), rs = F.ibSysfs(text, { node: 'h1', t: T });
  const p = k => rs.find(r => r.port === k);
  assert.deepEqual(rs.map(r => r.port).sort(), ['hfi1_0/1', 'mlx4_0/1', 'mlx4_0/2', 'mlx5_0/1']);
  // procfs's own test expects these (port_rcv_data and port_xmit_data are 4-byte words)
  assert.equal(p('mlx4_0/1').rxBytes, 8884894436); assert.equal(p('mlx4_0/1').txBytes, 106036453180); assert.equal(p('mlx4_0/1').xmitWait, 3599);
  assert.equal(p('mlx4_0/2').rxBytes, 9841747136); assert.equal(p('mlx4_0/2').xmitWait, 3846);
  assert.equal(p('hfi1_0/1').rxBytes, 1380366808104); assert.equal(p('mlx5_0/1').rxBytes, 72505381512);
  // RoCE retransmit and sequence counters come only from hw_counters
  assert.equal(p('mlx5_0/1').ackTimeouts, 131); assert.equal(p('mlx5_0/1').outOfSequence, 1); assert.equal(p('mlx5_0/1').outOfBuffer, 0);
  for (const r of rs) for (const c of F.COUNTERS) if (c in r) assert.ok(Number.isFinite(r[c]), `${r.port} ${c}`);
  assert.equal(sniff('ib.txt', text.slice(0, 4096)), 'ib-sysfs');
  // growth over a window from two real-format snapshots
  const later = text.replace('mlx4_0/ports/1/counters/port_xmit_wait:3599', 'mlx4_0/ports/1/counters/port_xmit_wait:9599');
  const g = F.growth([...F.ibSysfs(text, { node: 'h1', t: T }), ...F.ibSysfs(later, { node: 'h1', t: T + 60 })].filter(r => r.port === 'mlx4_0/1'), T, T + 60);
  assert.equal(g.xmitWait, 6000); assert.equal(g.rxBytes, 0);
});

test('ethtool: every mlx5 counter the adapter reads is one the driver documents; CNP and ECN come from sysfs instead', () => {
  const names = new Set(read('mlx5-ethtool-counter-names.txt').trim().split('\n'));
  const used = ['rx_prio0_pause', 'tx_prio3_pause', 'rx_pause_ctrl_phy', 'tx_pause_ctrl_phy', 'rx_global_pause', 'rx_discards_phy', 'tx_discards_phy', 'rx_out_of_buffer',
    'rx_crc_errors_phy', 'rx_symbol_err_phy', 'rx_pcs_symbol_err_phy', 'link_down_events_phy', 'rx_bytes_phy', 'tx_bytes_phy', 'rx_vport_rdma_unicast_bytes', 'tx_vport_rdma_unicast_bytes'];
  for (const n of used) assert.ok(names.has(n.replace(/prio\d+/, 'prio[p]')), `${n} is not an mlx5 ethtool counter`);
  for (const n of ['np_cnp_sent', 'rp_cnp_handled', 'np_ecn_marked_roce_packets']) assert.ok(!names.has(n), `${n} is an RDMA hw_counter, not ethtool`);
  // and each documented name the adapter maps lands in a field
  const r = F.ethtool(used.map((n, i) => `     ${n}: ${i + 1}`).join('\n'), { node: 'n', iface: 'ens1' })[0];
  for (const f of ['pfcPause', 'xmitDiscards', 'outOfBuffer', 'symbolErrors', 'linkDowned', 'rxBytes', 'txBytes']) assert.ok(r[f] > 0, f);
});

test('real NFS mountstats (statvers 1.1, 8-field op lines, a wrapped 64-bit queue time): read latency per export', () => {
  const text = read('nfs-mountstats.txt');
  const one = S.nfsMountstats(text, { node: 'n1', t: T });
  const rd = one.find(r => r.op === 'read');
  assert.equal(rd.target, 'nfs:192.168.1.1:/srv/test'); assert.equal(rd.ops, 1298); assert.equal(rd.bytes, 1210292152);
  assert.ok(Math.abs(rd.latMs - 79386 / 1298) < 1e-9, 'RTT per op, not the queue time');
  const meta = one.find(r => r.op === 'meta'); assert.ok(meta.latMs > 0 && meta.latMs < 10, `the wrapped ACCESS queue time (18446743919241604546) is not used: ${meta.latMs}`);
  assert.equal(one.length, 2, 'rootfs, sysfs, proc and ext4 mounts are skipped');
  const before = text.replace('READ: 1298 1298 0 207680 1210292152 6 79386 79407', 'READ: 298 298 0 47680 210292152 2 19386 19407');
  const w = S.nfsMountstats(text, { node: 'n1', before, windowS: 60, t: T }).find(r => r.op === 'read');
  assert.deepEqual([w.ops, w.bytes, w.latMs, w.windowS], [1000, 1e9, 60, 60]);
  assert.equal(sniff('m', text), 'mountstats');
});

test('real Lustre 2.10 job_stats read from /proc: the target comes from the path; writes are write_bytes, not punch', async () => {
  const ost = read('lustre/lustrefs-OST0000/job_stats'), mdt = read('lustre/lustrefs-MDT0000/job_stats');
  assert.throws(() => S.lustreJobstats(ost), /without a target/);
  assert.equal(S.lustreTargetOf('/proc/fs/lustre/obdfilter/lustrefs-OST0000/job_stats'), 'OST0000');
  assert.equal(S.lustreTargetOf('fixtures/real/lustre/lustrefs-MDT0000/job_stats'), 'MDT0000');
  const rs = S.lustreJobstats(ost, { target: 'OST0000' }), j24 = rs.find(r => r.job === '24' && r.op === 'write');
  assert.equal(j24.target, 'lustre:OST0000'); assert.equal(j24.ops, 64575); assert.equal(j24.bytes, 215147593728);
  assert.equal(j24.latMs, undefined, 'Lustre 2.10 keeps no per-op latency: newer servers add it');
  assert.ok(rs.every(r => r.op !== 'write' || r.bytes > 0));
  const md = S.lustreJobstats(mdt, { target: 'MDT0000' }); assert.ok(md.length && md.every(r => r.op === 'meta' && r.target === 'lustre:MDT0000'));
  assert.equal(sniff('job_stats', ost), 'lustre-jobstats');
  // the CLI names the target from the file's path
  const st = tmp(), out = JSON.parse((await run(process.execPath, [cli, 'data', 'import', 'lustre-jobstats', path.join(REAL, 'lustre/lustrefs-OST0000/job_stats'), '--store', st, '--json'])).stdout);
  assert.ok(JSON.stringify(out).includes('storage'));
  const q = JSON.parse((await run(process.execPath, [cli, 'data', 'query', 'storage', '--store', st, '--json'])).stdout);
  const recs = q.records || q.rows || q; assert.ok(Array.isArray(recs) && recs.length === rs.length && recs.every(r => r.target === 'lustre:OST0000'));
});

test('no mocks: ethtool and the collector on this host as it is', async () => {
  const ifs = fs.readdirSync('/sys/class/net').filter(n => n !== 'lo');
  if (has('ethtool') && ifs.length) {
    const r = spawnSync('ethtool', ['-S', ifs[0]], { encoding: 'utf8' });
    if (r.status === 0) { const rec = F.ethtool(r.stdout, { node: os.hostname(), iface: ifs[0], t: T })[0]; assert.equal(rec.port, ifs[0]); for (const c of F.COUNTERS) if (c in rec) assert.ok(Number.isFinite(rec[c])); }
  }
  const d = tmp(), c = spawnSync('bash', [path.join(here, '..', 'tools', 'collect.sh'), '--no-gpu', '--no-kernel', '--dcgm', 'http://127.0.0.1:1/none', '--out', path.join(d, 'b')], { encoding: 'utf8', timeout: 120000 });
  assert.equal(c.status, 0, c.stderr);
  const mf = JSON.parse(fs.readFileSync(path.join(d, 'b', 'manifest.json'), 'utf8'));
  const ib = fs.existsSync('/sys/class/infiniband') && fs.readdirSync('/sys/class/infiniband').length;
  assert.equal(mf.files.some(f => f.source === 'ib-sysfs'), !!ib, 'IB counters exactly when the host has IB devices');
  if (mf.files.length) {
    const r = JSON.parse((await run(process.execPath, [cli, 'data', 'import', 'bundle', path.join(d, 'b.tar.gz'), '--store', path.join(d, 's'), '--json'])).stdout).bundle;
    assert.ok(r.totals);
  }
});

test('mocked sysfs and ethtool: counters at the start and the end of the window, imported as port growth', async () => {
  const d = tmp(), sys = path.join(d, 'sys'), bin = path.join(d, 'bin'), port = path.join(sys, 'class/infiniband/mlx5_0/ports/1');
  for (const sub of ['counters', 'hw_counters']) fs.mkdirSync(path.join(port, sub), { recursive: true });
  fs.mkdirSync(path.join(sys, 'class/infiniband/mlx5_0/device/net/ens1f0'), { recursive: true }); fs.mkdirSync(bin);
  // the real mlx5_0 port 1 counters; the collector's 30 s window ends with xmit_wait and CNPs grown
  for (const l of read('sysfs-infiniband-counters.txt').split('\n').filter(x => x.includes('mlx5_0/ports/1/'))) {
    const [p, v] = l.split(':'); fs.writeFileSync(path.join(port, p.split('/ports/1/')[1]), v + '\n');
  }
  fs.writeFileSync(path.join(port, 'hw_counters/np_cnp_sent'), '1000\n');
  const grow = path.join(d, 'grow.sh'); fs.writeFileSync(grow, `sleep 8; echo 800000 > ${port}/counters/port_xmit_wait; echo 1600 > ${port}/hw_counters/np_cnp_sent\n`);
  const n = path.join(d, 'n'); fs.writeFileSync(n, '0');
  fs.writeFileSync(path.join(bin, 'ethtool'), `#!/usr/bin/env bash\nc=$(cat ${n}); echo $((c+1)) > ${n}\necho "NIC statistics:"\necho "     rx_prio3_pause: $((c*500))"\necho "     rx_discards_phy: 7"\n`, { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, FLEETOPS_SYSFS: sys, FLEETOPS_MOUNTSTATS: path.join(REAL, 'nfs-mountstats.txt') });
  spawn('bash', [grow], { detached: true, stdio: 'ignore' }).unref(); // grows the counters 8 s into the window
  const c = spawnSync('bash', [path.join(here, '..', 'tools', 'collect.sh'), '--node', 'gpu-a1', '--no-gpu', '--no-kernel', '--dcgm', 'http://127.0.0.1:1/none', '--out', path.join(d, 'b')], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(c.status, 0, c.stderr);
  const mf = JSON.parse(fs.readFileSync(path.join(d, 'b', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.files.map(f => f.source).sort(), ['ethtool', 'ethtool', 'ib-sysfs', 'ib-sysfs', 'mountstats']);
  const st = path.join(d, 's');
  await run(process.execPath, [cli, 'data', 'import', 'bundle', path.join(d, 'b.tar.gz'), '--store', st, '--json']);
  const q = JSON.parse((await run(process.execPath, [cli, 'data', 'query', 'port', '--store', st, '--json'])).stdout), ports = q.records || q.rows || q;
  const ib = ports.filter(r => r.source === 'ib-sysfs').sort((a, b) => a.t - b.t), et = ports.filter(r => r.source === 'ethtool').sort((a, b) => a.t - b.t);
  assert.equal(ib.length, 2); assert.ok(ib[1].t - ib[0].t >= 30, 'start and end of the window');
  const g = F.growth(ib, ib[0].t, ib[1].t); assert.equal(g.xmitWait, 800000); assert.equal(g.cnpSent, 600);
  const ge = F.growth(et, et[0].t, et[1].t); assert.equal(ge.pfcPause, 500); assert.equal(ge.xmitDiscards, 0);
  assert.ok(ib.every(r => r.switch === 'gpu-a1' && r.port === 'mlx5_0/1'));
});
