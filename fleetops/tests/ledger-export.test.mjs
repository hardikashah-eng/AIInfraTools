import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../src/memstore.mjs';
import { toGpuLedger } from '../src/export.mjs';

test('export gpu-ledger: placements become usage records with status, GPU type and utilization; capacity from inventory', () => {
  const s = new MemStore(), t0 = 1.79e9;
  s.append('inventory', [{ t: t0, node: 'n1', sku: 'NVIDIA H100 80GB HBM3', devices: 8 }, { t: t0, node: 'n2', sku: 'NVIDIA H100 80GB HBM3', devices: 8 }]);
  s.append('placement', [{ t: t0, job: 'train#1', class: 'training', owner: 'gina', namespace: 'pretrain', start: t0, end: t0 + 7200, devices: [{ node: 'n1', gpu: 0 }, { node: 'n1', gpu: 1 }] }]);
  s.append('job', [{ t: t0 + 7200, job: 'train#1', status: 'failed', cause: 'device' }]);
  const dev = [];
  for (let i = 0; i < 120; i++) for (const g of [0, 1]) dev.push({ t: t0 + i * 60, node: 'n1', gpu: g, sm: i < 60 ? 0.6 : 0.0, memUsedGB: 40, memTotalGB: 80 });
  s.append('device', dev);
  const { usage, capacity } = toGpuLedger(s, { from: t0, to: t0 + 7200, cluster: 'a' });
  assert.equal(usage.length, 1);
  const u = usage[0];
  assert.deepEqual([u.gpus, u.status, u.user, u.group, u.useCase, u.cluster], [2, 'failed', 'gina', 'train', 'training', 'a']);
  assert.match(u.gpuType, /H100/);
  assert.ok(Math.abs(u.util.busy - 0.5) < 0.01); assert.ok(Math.abs(u.util.sm - 0.6) < 1e-9); assert.equal(u.util.memPeak, 0.5);
  assert.equal(u.util.idleLong, 2 * 3600, 'the idle hour on each GPU is a long idle stretch');
  assert.deepEqual(capacity, [{ cluster: 'a', gpuType: 'NVIDIA H100 80GB HBM3', gpus: 16 }]);
});
