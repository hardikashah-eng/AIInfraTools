// The shared accelerator registry: one list of chips and vendor adapters behind the sizer, FleetScope, fleetops' power
// model and serving manifests, and gpu-health's vendor profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { VENDORS as GH } from '../gpu-health/src/vendors.mjs';
import { tdpOf } from '../fleetops/src/power.mjs';
import { planDeployment } from '../fleetops/src/serving.mjs';
import { k8sNodes } from '../fleetops/src/adapters/live.mjs';

const require = createRequire(import.meta.url);
const R = require('../inference-sizer/src/accelerators.js'), C = require('../inference-sizer/src/catalog.js'), E = require('../fleetscope/src/engine.js');

test('registry: every chip is a valid sizer entry, ids are unique, every vendor has an adapter and a gpu-health profile', () => {
  const ids = R.ACCELERATORS.concat(R.OTHER_SKUS).flatMap(a => [a.id, a.short].filter(Boolean));
  assert.equal(new Set(ids).size, ids.length);
  for (const a of R.ACCELERATORS) {
    const v = C.validateGPU(a);
    assert.ok(v.ok, `${a.id}: ${v.errors.join('; ')}`);
    for (const k of ['tdpW', 'match', 'vendorKey', 'kind', 'source']) assert.ok(a[k], `${a.id} has ${k}`);
    assert.ok(/^https:\/\//.test(a.source));
  }
  for (const a of R.ACCELERATORS.concat(R.OTHER_SKUS)) {
    assert.ok(R.VENDORS[a.vendorKey], `${a.id}: adapter for ${a.vendorKey}`);
    assert.ok(GH[a.vendorKey], `${a.id}: gpu-health profile for ${a.vendorKey}`);
  }
  for (const [k, v] of Object.entries(R.VENDORS)) for (const f of ['k8sResource', 'productLabels', 'smi', 'collectives', 'images']) assert.ok(v[f], `${k}.${f}`);
});

test('registry: telemetry SKU names resolve to the most specific chip (power falls back to its board power)', () => {
  const cases = {
    'NVIDIA GB200': 'GB200-NVL72', 'NVIDIA GB300': 'GB300-NVL72', 'NVIDIA B200': 'B200', 'NVIDIA B300 SXM6 AC': 'B300', 'NVIDIA H200': 'H200', 'NVIDIA H20': 'H20',
    'NVIDIA H100 80GB HBM3': 'H100', 'NVIDIA H100 PCIe': 'H100-PCIe', 'NVIDIA H800': 'H100', 'NVIDIA A100-SXM4-80GB': 'A100', 'NVIDIA A100 80GB PCIe': 'A100-PCIe',
    'NVIDIA L40S': 'L40S', 'NVIDIA L4': 'L4', 'NVIDIA A10': 'A10', 'Tesla T4': 'T4', 'Tesla V100-SXM2-32GB': 'V100',
    'AMD Instinct MI300X': 'MI300X', 'AMD Instinct MI325X OAM': 'MI325X', 'AMD Instinct MI355X': 'MI355X', 'AMD Instinct MI350X': 'MI350X', 'AMD Instinct MI250X': 'MI250',
    'MI355X': 'MI355X', 'GB300': 'GB300-NVL72', 'unknown-chip': null, '': null,
  };
  for (const [sku, id] of Object.entries(cases)) assert.equal((R.match(sku) || {}).id || null, id, sku);
  // the values the old hard-coded power table had, unchanged
  const old = { 'GB200': 1200, 'B300': 1100, 'B200': 1000, 'H200': 700, 'H100 PCIe': 350, 'H100': 700, 'H800': 700, 'H20': 400, 'A100 PCIe': 300, 'A100': 400, 'A800': 400,
    'L40S': 350, 'L4': 72, 'A10': 150, 'T4': 70, 'MI325X': 1000, 'MI300X': 750, 'MI250': 560, 'V100': 300 };
  for (const [sku, w] of Object.entries(old)) assert.equal(tdpOf(`NVIDIA ${sku}`.replace(/NVIDIA (MI)/, 'AMD Instinct $1')), w, sku);
  assert.equal(tdpOf('AMD Instinct MI355X'), 1400);
  assert.equal(tdpOf(null), null);
  assert.equal(R.vendorKeyOf('AMD'), 'amd'); assert.equal(R.vendorKeyOf('NVIDIA H100 80GB HBM3'), 'nvidia'); assert.equal(R.vendorKeyOf({ id: 'MI355X' }), 'amd');
  assert.throws(() => R.vendor('acme-npu'), /no vendor adapter for acme-npu; known: nvidia, amd/);
});

test('registry: the sizer catalog and FleetScope read it (same figures for the chips they had, plus the new ones)', () => {
  for (const id of ['MI325X', 'MI355X', 'GB300-NVL72']) assert.ok(C.GPUS.find(g => g.id === id), id);
  assert.equal(C.GPUS[0].id, 'B200', 'the default GPU is unchanged');
  const was = { A100: [80, 2.0, 312, 312, 0.9, 1.6, 400], L40S: [48, 0.864, 362, 733, 0.7, 1.1, 350], H100: [80, 3.35, 989, 1979, 1.4, 2.4, 700], H200: [141, 4.8, 989, 1979, 2.0, 3.5, 700],
    MI300X: [192, 5.3, 1307, 2615, 1.5, 2.6, 750], B200: [180, 8.0, 2250, 4500, 3.2, 5.5, 1000], B300: [262, 8.0, 2250, 4500, 4.0, 7.0, 1100], GB200: [186, 8.0, 2500, 5000, 3.6, 6.0, 1200] };
  for (const [k, v] of Object.entries(was)) { const g = E.GPUS[k]; assert.deepEqual([g.hbm, g.bw, g.bf16, g.fp8, g.onprem, g.rent, g.tdpW], v, k); }
  assert.deepEqual(Object.keys(E.GPUS).slice(0, 8), Object.keys(was), 'FleetScope keeps its order');
  for (const k of ['GB300', 'MI325X', 'MI355X']) assert.ok(E.GPUS[k] && E.GPUS[k].hbm > 0, k);
  // both pages inline the registry ahead of the code that reads it
  for (const f of ['inference-sizer/dist/index.html', 'fleetscope/dist/index.html']) {
    const h = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(h.indexOf('root.AIInfraAccelerators = api') > 0 && h.indexOf('root.AIInfraAccelerators = api') < h.indexOf('AIInfraAccelerators;'), f);
  }
});

test('vendor adapters: manifests take the resource, image and KV buffer from the chip\'s vendor', () => {
  const amd = planDeployment({ model: 'llama33-70b', gpu: 'MI355X', nodes: 1, name: 'chat' });
  assert.equal(amd.vendor, 'amd');
  assert.match(amd.yaml, /amd\.com\/gpu/); assert.match(amd.yaml, /image: rocm\/vllm:latest/); assert.doesNotMatch(amd.yaml, /nvidia\.com/);
  const nv = planDeployment({ model: 'llama33-70b', gpu: 'GB300-NVL72', nodes: 1, name: 'chat' });
  assert.equal(nv.vendor, 'nvidia'); assert.match(nv.yaml, /nvidia\.com\/gpu/);
  const pd = planDeployment({ model: 'llama33-70b', gpu: 'MI300X', rate: 20, isl: 8000, osl: 300, mode: 'disagg', name: 'pd' });
  assert.match(pd.yaml, /vllm-openai-rocm/); assert.match(pd.yaml, /kv_buffer_device\\?":\\?"cpu/);
  // Kubernetes inventory reads each vendor's resource and product label
  const nodes = k8sNodes({ items: [
    { metadata: { name: 'a', labels: { 'amd.com/gpu.product-name': 'AMD_Instinct_MI355X' } }, status: { capacity: { 'amd.com/gpu': '8' } } },
    { metadata: { name: 'n', labels: { 'nvidia.com/gpu.product': 'NVIDIA-GB300' } }, status: { capacity: { 'nvidia.com/gpu': '4' } } }] }, { t: 1 });
  assert.deepEqual(nodes.map(n => [n.node, n.vendor, n.sku, n.devices]), [['a', 'amd', 'AMD_Instinct_MI355X', 8], ['n', 'nvidia', 'NVIDIA-GB300', 4]]);
});
