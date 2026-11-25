// AWS: EFA counters, EKS node identity and health conditions, instance-level repair, the CUR as a priced ledger
// source, and Capacity Blocks in planning. Fixtures in tests/fixtures/aws follow AWS's documented formats (README).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ibSysfs, growth, ERROR_COUNTERS, CONGESTION_COUNTERS } from '../fleetops/src/adapters/fabric.mjs';
import { k8sNodes, k8sNodeConditions } from '../fleetops/src/adapters/live.mjs';
import { awsCapacityBlocks, instancesFor } from '../fleetops/src/procure.mjs';
import { loadConfig } from '../gpu-health/src/config.mjs';
import { loadPlatformNodes, platformOf, nodesFromK8s } from '../gpu-health/src/platforms.mjs';
import { plan } from '../gpu-health/src/executors.mjs';
import { supports, ladderFor } from '../gpu-health/src/vendors.mjs';
import { awsCur } from '../gpu-ledger/src/cloud.mjs';
import { ledger } from '../gpu-ledger/src/ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), fx = path.join(here, 'fixtures', 'aws'), read = f => fs.readFileSync(path.join(fx, f), 'utf8');

test('EFA: hw_counters read per device; retransmits, timeouts and impaired connections count as congestion, RDMA errors as errors', () => {
  const a = ibSysfs(read('efa-hw-counters-start.txt'), { node: 'p5-a', t: 0 }), b = ibSysfs(read('efa-hw-counters-end.txt'), { node: 'p5-a', t: 600 });
  assert.equal(a.length, 2); assert.ok(a.every(p => p.efa && p.nic));
  const bad = b.find(p => p.port === 'rdmap80s0/1');
  assert.deepEqual([bad.retransPkts, bad.retransTimeouts, bad.impairedConns, bad.rdmaErrors], [182000, 37, 12, 5], 'read + write errors add up');
  const g = growth([...a, ...b].filter(p => p.port === 'rdmap80s0/1'), 0, 600);
  assert.equal(g.retransTimeouts, 37); assert.equal(g.txBytes, 4e11);
  assert.ok(CONGESTION_COUNTERS.includes('retransTimeouts') && ERROR_COUNTERS.includes('rdmaErrors'));
});

test('EKS nodes: instance and zone from providerID, GPU from the instance type when GFD labels are missing, node-agent conditions as faults', () => {
  const inv = k8sNodes(read('eks-nodes.json'), { t: 1 });
  assert.deepEqual(inv.map(n => [n.node, n.sku, n.instanceType, n.cloud.instance, n.cloud.zone]), [
    ['ip-10-0-1-11.ec2.internal', 'NVIDIA-H100-80GB-HBM3', 'p5.48xlarge', 'i-0a1b2c3d4e5f60711', 'us-east-1a'],
    ['ip-10-0-1-12.ec2.internal', 'H100', 'p5.48xlarge', 'i-0a1b2c3d4e5f60712', 'us-east-1a'],
    ['ip-10-0-1-13.ec2.internal', 'H200', 'p5en.48xlarge', 'i-0a1b2c3d4e5f60713', 'us-east-1a']]);
  const logs = k8sNodeConditions(read('eks-nodes.json'));
  assert.deepEqual(logs.map(l => [l.node, l.code, l.class, l.condition]), [
    ['ip-10-0-1-12.ec2.internal', 'xid79', 'gpu', 'AcceleratedHardwareReady'], ['ip-10-0-1-13.ec2.internal', 'k8s_KernelDeadlock', 'node', 'KernelDeadlock']]);
  assert.equal(logs[0].t, Date.parse('2026-11-20T10:15:00Z') / 1000);
});

test('gpu-health on AWS: reboot and replace act on the EC2 instance; reseat is not offered; EKS auto repair can own both', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-')), nodes = path.join(dir, 'nodes.json');
  fs.copyFileSync(path.join(fx, 'eks-nodes.json'), nodes);
  const cfg = loadPlatformNodes(loadConfig({ nodesFrom: nodes })), n = 'ip-10-0-1-12.ec2.internal';
  assert.equal(platformOf(cfg, n), 'aws'); assert.equal(cfg.nodes[n].instance, 'i-0a1b2c3d4e5f60712');
  const act = kind => plan({ kind, node: n, gpu: 3, vendor: 'nvidia', reason: 'XID 79' }, cfg);
  assert.deepEqual(act('node-reboot').commands, [['aws', 'ec2', 'reboot-instances', '--instance-ids', 'i-0a1b2c3d4e5f60712']]);
  assert.deepEqual(act('rma').commands, [['aws', 'autoscaling', 'set-instance-health', '--instance-id', 'i-0a1b2c3d4e5f60712', '--health-status', 'Unhealthy', '--no-should-respect-grace-period']]);
  assert.deepEqual(act('gpu-reset').commands[0].slice(0, 4), ['ssh', n, 'sudo', 'nvidia-smi'], 'device actions stay the vendor\'s');
  assert.equal(supports(cfg, 'nvidia', 'reseat', n), false); assert.equal(supports(cfg, 'nvidia', 'reseat', 'onprem-1'), true);
  assert.ok(!ladderFor(cfg, 'nvidia', 'bus', n).includes('reseat'));
  // with EKS node auto repair on, gpu-health says what EKS will do instead of acting
  const auto = loadPlatformNodes(loadConfig({ nodesFrom: nodes, platforms: { aws: { autoRepair: true } } }));
  const p = plan({ kind: 'rma', node: n, gpu: 3, vendor: 'nvidia', reason: 'XID 79' }, auto);
  assert.ok(p.webhook); assert.match(p.text, /EKS node auto repair/);
  // a node with no instance on record: the error says where the instance comes from
  assert.throws(() => plan({ kind: 'node-reboot', node: 'gpu-x', vendor: 'nvidia', reason: 'r' }, loadConfig({ platform: 'aws' })), /set nodes\.gpu-x\.instance in the config, or nodesFrom/);
  assert.deepEqual(Object.keys(nodesFromK8s(read('eks-nodes.json'))).length, 3);
});

test('AWS CUR (2.0 and legacy) → GPU-hours priced at what was billed: Savings Plan, Spot, Reserved; tags attribute', () => {
  const recs = awsCur(read('cur2.csv'));
  assert.equal(recs.length, 3);
  const [sp, spot, g6e] = recs;
  assert.deepEqual([sp.gpuType, sp.gpus, sp.purchase, sp.labels.team, sp.cluster], ['H100', 8, 'savings-plan', 'research', 'eks-train']);
  assert.ok(Math.abs(sp.rate - 31.464 / 8) < 1e-9, 'Savings Plan effective cost, not the on-demand-equivalent unblended cost');
  assert.deepEqual([spot.gpuType, spot.purchase, spot.rate], ['H200', 'spot', 3]);
  assert.deepEqual([g6e.gpuType, g6e.gpus], ['L40S', 2], 'half an hour of a 4-GPU instance spread over the hour');
  assert.ok(Math.abs(g6e.rate - 5.245 / (0.5 * 4)) < 1e-9);
  assert.deepEqual(recs.skipped, { notEc2: 1, notGpu: 2, notUsage: 1 }); assert.deepEqual(recs.unknownTypes, ['trn2.48xlarge']);
  const legacy = awsCur(read('cur-legacy.csv'));
  assert.deepEqual([legacy[0].gpuType, legacy[0].gpus, legacy[0].purchase, legacy[0].labels.team], ['A100', 8, 'reserved', 'training']);
  assert.ok(Math.abs(legacy[0].rate - 589.2 / (24 * 8)) < 1e-9);
  // the ledger costs them at the billed rate, with no rate card at all
  const L = ledger(recs, { from: Date.parse('2026-11-20T10:00:00Z') / 1000, to: Date.parse('2026-11-20T11:00:00Z') / 1000, attribution: {} });
  const row = L.rows.find(x => x.r.purchase === 'savings-plan');
  assert.equal(row.rateBasis, 'bill'); assert.ok(Math.abs(row.cost - 31.464) < 1e-6);
});

test('Capacity Blocks: the read-only describe command for a GPU need, in the steps AWS sells', () => {
  assert.deepEqual(instancesFor('H200', 'aws').map(x => x.type), ['p5e.48xlarge', 'p5en.48xlarge']);
  const from = Date.parse('2026-12-01T00:00:00Z') / 1000;
  const r = awsCapacityBlocks({ chip: 'H100', gpus: 60, days: 20, from });
  assert.deepEqual(r.argv, ['aws', 'ec2', 'describe-capacity-block-offerings', '--instance-type', 'p5.48xlarge', '--instance-count', '8', '--capacity-duration-hours', '504',
    '--start-date-range', '2026-12-01T00:00:00Z', '--end-date-range', '2026-12-15T00:00:00Z']);
  assert.ok(r.notes.some(n => /7-day steps/.test(n)) && r.notes.some(n => /64 GPUs/.test(n)) && r.notes.some(n => /cannot be cancelled/.test(n)));
  assert.equal(awsCapacityBlocks({ chip: 'B200', gpus: 16, days: 3, from }).argv[6], '2');
  assert.match(awsCapacityBlocks({ chip: 'GB200', gpus: 72, days: 7, from }).notes.join(' '), /UltraServers/);
  assert.throws(() => awsCapacityBlocks({ chip: 'MI300X', gpus: 8, days: 1 }), /no AWS instance type known for MI300X/);
});
