import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { samplesFromExporter, detectVendor, readSamples, MAPPINGS } from '../src/ingest.mjs';
import { loadConfig } from '../src/config.mjs';
import { assessHealth } from '../src/health.mjs';
import { analyze } from '../src/analyze.mjs';
import { plan } from '../src/executors.mjs';
import { faultDef, ladderFor, supports, coverage } from '../src/vendors.mjs';
import { demoMixed, DEMO_NOW } from '../src/synth.mjs';

const cfg = loadConfig();
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SAMBANOVA = `# HELP sambanova_tile_exec_percent Execution time percentage
sambanova_tile_exec_percent{instance="sn-01:9100",rdu="0",tile="0",xrdu="0"} 60
sambanova_tile_exec_percent{instance="sn-01:9100",rdu="0",tile="1",xrdu="0"} 80
sambanova_tile_aload_percent{instance="sn-01:9100",rdu="0",tile="0",xrdu="0"} 30
sambanova_tile_aload_percent{instance="sn-01:9100",rdu="0",tile="1",xrdu="0"} 50
sambanova_tile_exec_percent{instance="sn-01:9100",rdu="1",tile="0",xrdu="0"} 10
sambanova_tile_frequency_mhz{instance="sn-01:9100",rdu="1",tile="0",xrdu="0"} 1500
sambanova_platform_fault_count{instance="sn-01:9100",namespace="sambanova"} 3
`;

test('vendors: SambaNova exporter text is detected and normalized (tiles averaged, node-level fault count)', () => {
  assert.equal(detectVendor(SAMBANOVA), 'sambanova');
  assert.equal(detectVendor('DCGM_FI_DEV_GPU_TEMP{gpu="0"} 50'), 'nvidia');
  assert.equal(detectVendor('gpu_gfx_activity{gpu_id="0"} 50'), 'amd');
  const s = samplesFromExporter(SAMBANOVA, { t: 1000 });
  const r0 = s.find(x => x.gpu === '0'), r1 = s.find(x => x.gpu === '1');
  assert.equal(s.length, 2);
  assert.equal(r0.node, 'sn-01'); assert.equal(r0.vendor, 'sambanova'); assert.equal(r0.kind, 'rdu'); assert.equal(r0.sku, 'RDU');
  assert.ok(Math.abs(r0.sm - 0.7) < 1e-9 && Math.abs(r0.tensor - 0.4) < 1e-9, 'per-tile values are averaged per RDU');
  assert.equal(r1.clockMHz, 1500);
  assert.equal(r0.faultCountTotal, 3); assert.equal(r1.faultCountTotal, 3); // node-level counter copied to every RDU
  assert.ok(MAPPINGS.nvidia && MAPPINGS.amd, 'MAPPINGS still exported for older callers');
  assert.throws(() => samplesFromExporter('x 1', { vendor: 'tpu' }), /JSONL/);
});

test('vendors: a rise in the vendor platform fault count makes the node\'s RDUs suspect', () => {
  const now = 100000, samples = [];
  for (let i = 0; i < 24; i++) for (const gpu of ['0', '1']) samples.push({ t: now - (23 - i) * 600, node: 'sn-01', gpu, vendor: 'sambanova', kind: 'rdu', sku: 'RDU', tensor: 0.4, sm: 0.6, faultCountTotal: i < 20 ? 3 : 5, faults: [] });
  const h = assessHealth({ samples, cfg, now });
  for (const k of ['sn-01/0', 'sn-01/1']) {
    assert.equal(h.gpus[k].state, 'suspect');
    assert.ok(h.gpus[k].signals.some(s => s.key === 'vendor-faults' && s.class === 'platform'));
    assert.equal(h.gpus[k].vendor, 'sambanova');
  }
});

test('vendors: fault codes, ladders and unsupported actions resolve per vendor', () => {
  assert.equal(faultDef(cfg, 'nvidia', 'xid79').severity, 'hard');
  assert.equal(faultDef(cfg, '', 'xid79').class, 'bus', 'JSONL without a vendor still finds the code');
  assert.equal(faultDef(cfg, 'sambanova', 'FTYPE_RDU_REMOVED').severity, 'hard');
  assert.equal(faultDef(cfg, 'tpu', 'tpu_maintenance').severity, 'ignore');
  assert.deepEqual(faultDef(cfg, 'nvidia', 'something-new'), { class: 'default', severity: 'soft' });
  const over = loadConfig({ faults: { xid63: { class: 'ecc', severity: 'hard' } } });
  assert.equal(faultDef(over, 'nvidia', 'xid63').severity, 'hard', 'global faults in the config override a vendor\'s');
  assert.deepEqual(ladderFor(cfg, 'tpu', 'ecc'), ['node-reboot', 'rma']);
  assert.deepEqual(ladderFor(cfg, 'nvidia', 'ecc'), ['gpu-reset', 'node-reboot', 'rma']);
  assert.deepEqual(ladderFor(cfg, 'sambanova', 'slow'), ['gpu-reset', 'reseat', 'rma'], 'config-reset is not offered on SambaNova');
  assert.equal(supports(cfg, 'tpu', 'gpu-reset'), false); assert.equal(supports(cfg, undefined, 'gpu-reset'), true);
});

test('vendors: executors are the vendor\'s own (amd-smi on AMD, a person on TPU), overridable in the config', () => {
  const a = { kind: 'gpu-reset', node: 'a1', gpu: '1', reason: 'r' };
  assert.deepEqual(plan(Object.assign({ vendor: 'nvidia' }, a), cfg).commands, [['ssh', 'a1', 'sudo', 'nvidia-smi', '-r', '-i', '1']]);
  assert.deepEqual(plan(Object.assign({ vendor: 'amd' }, a), cfg).commands, [['ssh', 'a1', 'sudo', 'amd-smi', 'reset', '--gpureset', '--gpu', '1']]);
  const sn = plan(Object.assign({ vendor: 'sambanova' }, a), cfg);
  assert.equal(sn.webhook, true); assert.match(sn.text, /To do: Reset the RDU with the SambaNova Fault Management/);
  const custom = loadConfig({ vendors: { amd: { executors: { 'gpu-reset': [['ssh', '{node}', 'my-reset', '{gpu}']] } } } });
  assert.deepEqual(plan(Object.assign({ vendor: 'amd' }, a), custom).commands, [['ssh', 'a1', 'my-reset', '1']]);
  assert.deepEqual(plan(Object.assign({ vendor: 'amd' }, a), loadConfig()).commands[0].slice(3, 5), ['amd-smi', 'reset'], 'overrides do not leak into the defaults');
});

test('vendors: mixed fleet demo quarantines each planted fault with vendor-appropriate repairs', () => {
  const d = demoMixed({ now: DEMO_NOW });
  const a = analyze({ samples: d.samples, jobs: d.jobs, results: d.results, cfg, now: DEMO_NOW });
  const st = k => a.health.gpus[k].state;
  assert.equal(st('a1/1'), 'quarantined'); assert.equal(st('s1/2'), 'quarantined'); assert.equal(st('t1/3'), 'quarantined');
  assert.equal(st('t1/0'), 'serving', 'planned maintenance is not a device fault');
  const bad = Object.values(a.health.gpus).filter(g => g.state !== 'serving').map(g => g.key).sort();
  assert.deepEqual(bad, ['a1/1', 's1/2', 't1/3']);
  const ids = a.suggestions.map(s => s.id);
  assert.ok(ids.includes('gpu-reset:a1/1'));
  assert.ok(ids.includes('node-reboot:t1/3') && !ids.some(i => i.startsWith('gpu-reset:t1/')), 'no device reset proposed on Cloud TPU');
  assert.ok(a.suggestions.find(s => s.id === 'notify-owner:t1/3:train-tpu').reason.startsWith('TPU chip t1/3 quarantined'));
  const cov = Object.fromEntries(a.coverage.map(c => [c.vendor, c]));
  assert.equal(cov.tpu.kind, 'tpu'); assert.ok(cov.tpu.blind.includes('ecc') && cov.tpu.blind.includes('temperature') && cov.tpu.checks.includes('utilization'));
  assert.ok(cov.amd.checks.includes('ecc') && cov.amd.checks.includes('interconnect'));
  assert.ok(cov.sambanova.blind.includes('memory'));
});

test('vendors: coverage on an NVIDIA-only fleet reports nothing blind for the fields it has', () => {
  const s = [{ t: 1, node: 'n', gpu: '0', vendor: 'nvidia', tensor: 0.1, sm: 0.2, dram: 0.1, memUsedGB: 1, eccSbeTotal: 0, remapUsed: 0, tempC: 50, memTempC: 55, powerW: 300, throttle: 0, pcieWidth: 16, linkErrTotal: 0 }];
  const c = coverage(s, cfg);
  assert.equal(c.length, 1); assert.deepEqual(c[0].blind, []);
});

const py = spawnSync('python3', ['--version']);
test('vendors: tpu-collect.py turns libtpu metrics into JSONL samples', { skip: py.status !== 0 && 'python3 not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-libtpu-'));
  fs.mkdirSync(path.join(dir, 'libtpu', 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'libtpu', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'libtpu', 'sdk', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'libtpu', 'sdk', 'tpumonitoring.py'), `
DATA = {'duty_cycle_pct': ['10.00', '90.00'], 'tensorcore_util': ['5.5', '61.0'], 'hbm_capacity_usage': ['2000000000', '30000000000'], 'hbm_capacity_total': ['95000000000', '95000000000']}
class _M:
    def __init__(self, n): self.n = n
    def data(self):
        if self.n not in DATA: raise ValueError('unsupported metric')
        return DATA[self.n]
def get_metric(name): return _M(name)
`);
  const r = spawnSync('python3', [path.join(HERE, '..', 'tools', 'tpu-collect.py'), '--count', '1', '--node', 'tpu-vm-1', '--sku', 'v5p'], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONPATH: dir }) });
  assert.equal(r.status, 0, r.stderr);
  const s = readSamples(r.stdout);
  assert.equal(s.length, 2);
  assert.deepEqual([s[1].node, s[1].gpu, s[1].vendor, s[1].kind, s[1].sku], ['tpu-vm-1', '1', 'tpu', 'tpu', 'v5p']);
  assert.equal(s[1].sm, 0.9); assert.equal(s[1].tensor, 0.61); assert.equal(s[1].memUsedGB, 30); assert.equal(s[1].memTotalGB, 95);
});
