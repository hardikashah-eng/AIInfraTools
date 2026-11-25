// AMD at parity with NVIDIA: amd-smi inventory and XGMI topology, RCCL and HIP log lines, kernel RAS lines mapped to
// GPUs, admit-node.sh on an AMD node (stand-in amd-smi, rvs, rccl-tests), and admission reading it all.
// Fixtures: tests/fixtures/amd (amd-smi's documented formats; see its README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as Topo from '../src/adapters/topology.mjs';
import * as Logs from '../src/adapters/logs.mjs';
import { sniff } from '../src/bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), fx = path.join(here, 'fixtures', 'amd'), read = f => fs.readFileSync(path.join(fx, f), 'utf8');
const cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile), py = spawnSync('bash', ['-lc', 'command -v python3']).stdout.toString().trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amd-'));

test('amd-smi static: product, driver, IFWI per GPU, mixed firmware flagged, PCI → GPU map, power limit and PCIe max', () => {
  const { inventory: inv, pciMap } = Topo.amdSmiStatic(read('amd-smi-static.json'), { node: 'mi300-a01', t: 100, rocm: '6.3.1' });
  assert.equal(inv.vendor, 'amd'); assert.equal(inv.sku, 'AMD Instinct MI300X'); assert.equal(inv.devices, 8);
  assert.deepEqual(inv.versions, { driver: '6.8.5', vbios: '022.040.003.042.000001', rocm: '6.3.1' });
  assert.deepEqual(inv.mixedVersions, ['vbios'], 'one GPU on older IFWI');
  assert.equal(pciMap['0000:a6:00'], '5');
  assert.deepEqual([inv.gpus[0].powerLimitW, inv.gpus[0].pcieGenMax, inv.gpus[0].pcieWidthMax, inv.gpus[0].gfx], [750, 5, 16, 'gfx942']);
  // the same data as a plain list (older amd-smi)
  assert.equal(Topo.amdSmiStatic(JSON.stringify(JSON.parse(read('amd-smi-static.json')).gpu_data), { node: 'x' }).inventory.devices, 8);
  assert.throws(() => Topo.amdSmiStatic('[]', { node: 'x' }), /no GPUs/);
});

test('amd-smi topology: a full XGMI mesh (28 links on 8 GPUs); the older layout too; bundles recognize both files', () => {
  const e = Topo.amdSmiTopology(read('amd-smi-topology.json'), { node: 'mi300-a01', t: 1 });
  assert.equal(e.length, 28); assert.ok(e.every(x => x.kind === 'xgmi' && x.hops === 1 && x.enabled));
  const old = Topo.amdSmiTopology(read('amd-smi-topology-old.json'), { node: 'n' });
  assert.deepEqual(old.map(x => [x.kind, x.from, x.to, x.hops, x.weight, x.enabled]), [['pcie-p2p', 'n/gpu0', 'n/gpu1', 2, 40, false]]);
  assert.equal(sniff('static.json', read('amd-smi-static.json')), 'amd-smi-static');
  assert.equal(sniff('topo.json', read('amd-smi-topology.json')), 'amd-smi-topology');
  assert.equal(sniff('topo-old.json', read('amd-smi-topology-old.json')), 'amd-smi-topology');
});

test('RCCL and HIP lines: version, IB completion error, peer lost, HIP out of memory; kernel RAS lines land on the right GPU', () => {
  const r = Logs.ncclLog(read('rccl.log'), { node: 'mi300-a01', job: 'pretrain', t: 1000 });
  const by = Object.fromEntries(r.map(x => [x.code, x]));
  assert.deepEqual([by.nccl_version.lib, by.nccl_version.version], ['rccl', '2.22.3']);
  assert.equal(by.nccl_ib_error.severity, 'hard'); assert.equal(by.nccl_ib_error.rank, 3); assert.equal(by.nccl_ib_error.status, 12);
  assert.ok(by.nccl_peer_lost); assert.ok(by.cuda_oom);
  assert.equal(sniff('train.log', read('rccl.log')), 'app-log');
  const { pciMap } = Topo.amdSmiStatic(read('amd-smi-static.json'), { node: 'mi300-a01' });
  const k = Logs.kernelLog('[ 1234.5] amdgpu 0000:a6:00.0: amdgpu: uncorrectable hardware error (ERREVENT_ATHUB_INTERRUPT) detected!\n', { node: 'mi300-a01', boot: 0, pciMap });
  assert.equal(k[0].code, 'ras_uncorrectable'); assert.equal(String(k[0].gpu), '5');
});

test('amd-admit.py: inventory, gpu-count, slowest PCIe link, XGMI links; busy check', { skip: !py && 'python3 not found' }, () => {
  const out = spawnSync(py, [path.join(here, '..', 'tools', 'amd-admit.py'), '--node', 'mi300-a01', '--t', '5', '--static', path.join(fx, 'amd-smi-static.json'), '--metric', path.join(fx, 'amd-smi-metric-pcie.json'),
    '--topology', path.join(fx, 'amd-smi-topology.json'), '--rocm', '6.3.1', '--rccl', '2.22.3', '--kernel', '6.8.0'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const recs = out.stdout.trim().split('\n').map(l => JSON.parse(l));
  const inv = recs.find(x => x.record === 'inventory');
  assert.deepEqual([inv.vendor, inv.sku, inv.devices, inv.versions.rocm, inv.versions.rccl, inv.versions.driver], ['amd', 'AMD Instinct MI300X', 8, '6.3.1', '2.22.3', '6.8.5']);
  assert.equal(inv.versions.vbios, '022.040.003.041.000001|022.040.003.042.000001', 'both firmware versions, like the NVIDIA path');
  assert.equal(recs.find(x => x.check === 'pcie').value, 'gen5x8', 'the GPU that trained at x8');
  assert.equal(recs.filter(x => x.record === 'topology' && x.kind === 'xgmi').length, 28);
  const busy = f => spawnSync(py, [path.join(here, '..', 'tools', 'amd-admit.py'), '--node', 'n', '--busy-only', '--processes', path.join(fx, f)]).status;
  assert.equal(busy('amd-smi-process-idle.json'), 0); assert.equal(busy('amd-smi-process-busy.json'), 3);
});

test('admit-node.sh on an AMD node (stand-in amd-smi, rvs, all_reduce_perf): records, import, verdict', { skip: !py && 'python3 not found' }, async () => {
  const dir = tmp(), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  w('amd-smi', `case "$1" in
  static) cat ${JSON.stringify(path.join(fx, 'amd-smi-static.json'))};;
  metric) cat ${JSON.stringify(path.join(fx, 'amd-smi-metric-pcie.json'))};;
  topology) cat ${JSON.stringify(path.join(fx, 'amd-smi-topology.json'))};;
  process) cat "${fx}/\${AMD_PROCS:-amd-smi-process-idle.json}";;
esac`);
  w('rvs', 'echo "[RESULT] [1234.5] [gst] gst  GPU 0 Target stress : 1000 met :TRUE"; exit 0');
  w('all_reduce_perf', 'echo "# Avg bus bandwidth    : 318.20"');
  w('python3', `exec ${py} "$@"`);
  const conf = path.join(dir, 'gst.conf'); fs.writeFileSync(conf, 'actions: []\n');
  const out = path.join(dir, 'admit.jsonl'), env = Object.assign({}, process.env, { PATH: `${bin}:/usr/bin:/bin` });
  const r = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', 'mi300-a01', '--skip', 'sdc', '--rvs-conf', conf, '--out', out], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const recs = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(recs.find(x => x.record === 'inventory').vendor, 'amd');
  assert.equal(recs.find(x => x.check === 'rvs-diag').ok, true);
  assert.equal(recs.find(x => x.check === 'nccl-allreduce').value, 318.2);
  assert.equal(recs.filter(x => x.record === 'topology').length, 28);
  // a failing RVS line fails the diagnostic
  w('rvs', 'echo "[RESULT] [1234.5] [gst] gst  GPU 3 Target stress : 1000 met :FALSE"; exit 0');
  const r2 = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', 'mi300-a01', '--skip', 'sdc,nccl', '--rvs-conf', conf, '--out', path.join(dir, 'b.jsonl')], { env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'b.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.check === 'rvs-diag').ok, false);
  // refuses while processes run on the GPUs
  const busy = spawnSync('bash', [path.join(here, '..', 'tools', 'admit-node.sh'), '--node', 'mi300-a01', '--out', path.join(dir, 'x.jsonl')], { env: Object.assign({}, env, { AMD_PROCS: 'amd-smi-process-busy.json' }), encoding: 'utf8' });
  assert.notEqual(busy.status, 0); assert.match(busy.stderr, /compute processes are running/);
  // import and evaluate: the AMD diagnostic and XGMI links count; sdc and burn-in are still to do
  const store = path.join(dir, 'store');
  await run(process.execPath, [cli, 'data', 'import', 'admission', out, '--store', store]);
  const c = JSON.parse((await run(process.execPath, [cli, 'admit', 'check', 'mi300-a01', '--store', store, '--json']).catch(e => e)).stdout).admission;
  const st = n => c.checks.find(x => x.name === n);
  assert.equal(st('diag').status, 'pass'); assert.match(st('diag').evidence, /rvs-diag/);
  assert.equal(st('topology').status, 'pass'); assert.match(st('topology').evidence, /28 XGMI links/);
  assert.equal(c.verdict, 'incomplete'); assert.ok(c.missing.includes('burn-in') && c.missing.includes('sdc-canary'));
  // the amd-smi files import straight into inventory and topology too
  const s2 = path.join(dir, 's2');
  await run(process.execPath, [cli, 'data', 'import', 'amd-smi-static', path.join(fx, 'amd-smi-static.json'), '--node', 'mi300-a01', '--store', s2]);
  await run(process.execPath, [cli, 'data', 'import', 'amd-smi-topology', path.join(fx, 'amd-smi-topology.json'), '--node', 'mi300-a01', '--store', s2]);
  const q = JSON.parse((await run(process.execPath, [cli, 'data', 'query', 'topology', '--store', s2, '--json'])).stdout);
  assert.equal((q.records || q).filter(x => x.kind === 'xgmi').length, 28);
});

test('collect.sh on an AMD node: amd-smi static and topology in the bundle, imported as inventory and XGMI links', async () => {
  const d = tmp(), bin = path.join(d, 'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(d, 'sys'));
  fs.writeFileSync(path.join(bin, 'amd-smi'), `#!/bin/bash\ncase "$1" in static) cat ${fx}/amd-smi-static.json;; topology) cat ${fx}/amd-smi-topology.json;; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/bash\necho "2026-11-20T10:00:00+0000 mi300-a01 kernel: amdgpu 0000:a6:00.0: amdgpu: uncorrectable hardware error (ERREVENT_ATHUB_INTERRUPT) detected!"\n', { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, FLEETOPS_SYSFS: path.join(d, 'sys'), FLEETOPS_MOUNTSTATS: '/dev/null' });
  const c = spawnSync('bash', [path.join(here, '..', 'tools', 'collect.sh'), '--node', 'mi300-a01', '--dcgm', 'http://127.0.0.1:1/none', '--out', path.join(d, 'b')], { env, cwd: d, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const mf = JSON.parse(fs.readFileSync(path.join(d, 'b', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.files.map(f => f.source).filter(s => /amd|kernel/.test(s)).sort(), ['amd-smi-static', 'amd-smi-topology', 'kernel-log']);
  const r = JSON.parse((await run(process.execPath, [cli, 'data', 'import', 'bundle', path.join(d, 'b.tar.gz'), '--store', path.join(d, 's'), '--json'])).stdout).bundle;
  assert.ok(r.files.every(f => !f.error), JSON.stringify(r.files.filter(f => f.error)));
  assert.ok(r.totals.inventory >= 1 && r.totals.topology === 28, JSON.stringify(r.totals));
  const logs = JSON.parse((await run(process.execPath, [cli, 'data', 'query', 'log', '--store', path.join(d, 's'), '--json'])).stdout);
  const ras = (logs.records || logs).find(x => x.code === 'ras_uncorrectable');
  assert.ok(ras, 'the RAS line was imported'); assert.equal(String(ras.gpu), '5', 'mapped to GPU 5 through the amd-smi PCI map');
});
