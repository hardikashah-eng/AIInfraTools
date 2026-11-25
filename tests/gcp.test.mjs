// GCP and Cloud TPU: TPUs in the sizer and in serving manifests, GKE node identity and host maintenance, GKE and
// Compute Engine repair through the cloud's own faulty-host path, Cloud Monitoring as telemetry, the billing export
// as a priced ledger source, and DWS calendar mode in planning. Fixtures: tests/fixtures/gcp (README).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { k8sNodes, k8sNodeConditions, cloudMonitoring } from '../fleetops/src/adapters/live.mjs';
import { planDeployment } from '../fleetops/src/serving.mjs';
import { gcpCalendarMode } from '../fleetops/src/procure.mjs';
import { sniff } from '../fleetops/src/bundle.mjs';
import { loadConfig } from '../gpu-health/src/config.mjs';
import { loadPlatformNodes, platformOf } from '../gpu-health/src/platforms.mjs';
import { plan } from '../gpu-health/src/executors.mjs';
import { samplesFromCloudMonitoring } from '../gpu-health/src/ingest.mjs';
import { gcpBilling } from '../gpu-ledger/src/cloud.mjs';
import { ledger } from '../gpu-ledger/src/ledger.mjs';

const require = createRequire(import.meta.url), R = require('../inference-sizer/src/accelerators.js'), C = require('../inference-sizer/src/catalog.js'), M = require('../inference-sizer/src/model.js');
const here = path.dirname(fileURLToPath(import.meta.url)), fx = path.join(here, 'fixtures', 'gcp'), read = f => fs.readFileSync(path.join(fx, f), 'utf8'), run = promisify(execFile);

test('TPUs in the registry and the sizer: GKE labels, machine types, slice topologies; a model sizes on v6e', () => {
  assert.deepEqual(['tpu-v6e-slice', 'tpu-v5p-slice', 'tpu7x', 'tpu-v5-lite-podslice', 'TpuV6e running in Americas'].map(s => R.match(s).id), ['TPU-v6e', 'TPU-v5p', 'TPU7x', 'TPU-v5e', 'TPU-v6e']);
  assert.deepEqual(R.instanceOf('ct6e-standard-8t'), { cloud: 'gcp', chip: 'TPU-v6e', gpus: 8 }); assert.equal(R.instanceOf('a3-ultragpu-8g').chip, 'H200');
  assert.deepEqual([R.tpuTopology('TPU-v6e', 8), R.tpuTopology('TPU-v6e', 4), R.tpuTopology('TPU7x', 4), R.tpuTopology('TPU7x', 8)], ['2x4', '2x2', '2x2x1', '2x2x2']);
  const g = C.GPUS.find(x => x.id === 'TPU-v6e'), m = C.MODELS.find(x => x.id === 'llama31-8b');
  const p = M.plan(Object.assign({}, M.SETTINGS, m, g, { wprec: 'bf16' }), { noSens: true });
  assert.ok(p.chosen && p.chosen.gpus >= 1, 'Llama 3.1 8B fits on v6e chips');
});

test('serving on TPU: vllm-tpu, google.com/tpu, the slice by accelerator and topology labels; one host per instance', () => {
  const d = planDeployment({ model: 'llama33-70b', gpu: 'TPU-v6e', nodes: 2, name: 'chat', weights: 'bf16' });
  assert.equal(d.vendor, 'tpu'); assert.equal(d.image, 'vllm/vllm-tpu:latest');
  const dep = d.docs.find(x => x.kind === 'Deployment'), pod = dep.spec.template.spec, c = pod.containers[0];
  assert.equal(pod.nodeSelector['cloud.google.com/gke-tpu-accelerator'], 'tpu-v6e-slice');
  assert.equal(pod.nodeSelector['cloud.google.com/gke-tpu-topology'], R.tpuTopology('TPU-v6e', d.layout.gpusPerInstance));
  assert.equal(c.resources.limits['google.com/tpu'], String(d.layout.gpusPerInstance));
  assert.ok(!c.args.includes('--kv-cache-dtype') && !c.args.includes('--quantization'), 'quantization flags left to vllm-tpu');
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'TPU-v5p', nodes: 4, name: 'big', weights: 'bf16' }), /needs 8 chips per instance, more than one 4-chip TPU host: multi-host TPU slices are not rendered yet/);
  assert.throws(() => planDeployment({ model: 'llama33-70b', gpu: 'TPU-v6e', rate: 5, name: 'pd', mode: 'disagg' }), /no validated vLLM image for Google Cloud TPU/);
});

test('GKE nodes: project, zone and instance from gce://; TPU nodes by their accelerator label; host maintenance as a planned event', () => {
  const inv = k8sNodes(read('gke-nodes.json'), { t: 1 });
  assert.deepEqual(inv.map(n => [n.vendor, n.kind, n.sku, n.devices, n.cloud.provider, n.cloud.project, n.cloud.zone]), [
    ['nvidia', 'gpu', 'nvidia-h200-141gb', 8, 'gcp', 'acme-ml', 'us-central1-c'], ['tpu', 'tpu', 'tpu-v6e-slice', 8, 'gcp', 'acme-ml', 'us-east5-b']]);
  const logs = k8sNodeConditions(read('gke-nodes.json'), { t: 5 });
  assert.deepEqual(logs.map(l => [l.node, l.code, l.severity, l.at]), [['gke-train-a3u-pool-1a2b3c4d-x7k2', 'scheduled_maintenance', 'info', 1795694400]]);
});

test('gpu-health on GKE and Compute Engine: the cloud\'s faulty-host path, with the fault behavior it wants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcp-')), nodes = path.join(dir, 'nodes.json');
  fs.copyFileSync(path.join(fx, 'gke-nodes.json'), nodes);
  const cfg = loadPlatformNodes(loadConfig({ nodesFrom: nodes })), gpu = 'gke-train-a3u-pool-1a2b3c4d-x7k2', tpu = 'gke-serve-v6e-pool-5e6f7a8b-q9w1';
  assert.equal(platformOf(cfg, gpu), 'gke');
  const act = (a) => plan(Object.assign({ reason: 'r' }, a), cfg);
  assert.deepEqual(act({ kind: 'rma', node: gpu, gpu: 2, vendor: 'nvidia', faultClass: 'ecc' }).commands, [['kubectl', 'label', 'node', gpu, 'cloud.google.com/fault-behavior=XID', '--overwrite']]);
  assert.deepEqual(act({ kind: 'rma', node: gpu, gpu: 2, vendor: 'nvidia', faultClass: 'sdc' }).commands[0][4], 'cloud.google.com/fault-behavior=SDC');
  assert.deepEqual(act({ kind: 'node-reboot', node: gpu, vendor: 'nvidia' }).commands, [['gcloud', 'compute', 'instances', 'reset', gpu, '--zone=us-central1-c', '--project=acme-ml']]);
  assert.ok(act({ kind: 'rma', node: tpu, gpu: 0, vendor: 'tpu' }).webhook, 'TPU slices on GKE keep the TPU steps');
  // a Compute Engine VM (Slurm, VM clusters): report the host as faulty; TPUs as a chip error
  const vm = loadConfig({ nodes: { 'tpu-vm-1': { platform: 'gcp', instance: 'tpu-vm-1', zone: 'us-east5-b', project: 'acme-ml' } } });
  assert.deepEqual(plan({ kind: 'rma', node: 'tpu-vm-1', gpu: 3, vendor: 'tpu', reason: 'r' }, vm).commands, [['gcloud', 'compute', 'instances', 'report-host-as-faulty', 'tpu-vm-1', '--zone=us-east5-b', '--project=acme-ml',
    '--disruption-schedule=IMMEDIATE', '--fault-reasons=behavior=CHIP_ERROR,description=gpu-health']]);
  assert.match(plan({ kind: 'rma', node: 'tpu-vm-1', gpu: 3, vendor: 'nvidia', faultClass: 'perf-slow', reason: 'r' }, vm).commands[0].at(-1), /behavior=PERFORMANCE/);
});

test('Cloud Monitoring: GKE node accelerator metrics become device samples (TPU and GPU), and import into fleetops', async () => {
  const s = samplesFromCloudMonitoring(read('cloud-monitoring.json'));
  assert.equal(s.length, 5, '2 TPU chips × 2 minutes + 1 GPU sample');
  const t0 = s.find(x => x.node.includes('v6e') && x.gpu === '0' && x.t === Date.parse('2026-11-20T10:01:00Z') / 1000);
  assert.deepEqual([t0.vendor, t0.kind, t0.sku, t0.topology, t0.sm, t0.tensor, t0.memUsedGB], ['tpu', 'tpu', 'tpu-v6e-slice', '2x4', 0.92, 0.615, 29]);
  assert.ok(Math.abs(t0.memTotalGB - 34.36) < 0.01);
  const g = s.find(x => x.vendor === 'nvidia'); assert.deepEqual([g.kind, g.sm, g.memUsedGB], ['gpu', 0.97, 120]);
  assert.equal(sniff('cm.json', read('cloud-monitoring.json')), 'cloud-monitoring');
  assert.equal(cloudMonitoring(read('cloud-monitoring.json'))[0].source, 'cloud-monitoring');
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcp-')), 's'), cli = path.join(here, '..', 'fleetops', 'tools', 'fleetops.mjs');
  await run(process.execPath, [cli, 'data', 'import', 'cloud-monitoring', path.join(fx, 'cloud-monitoring.json'), '--store', store]);
  const q = JSON.parse((await run(process.execPath, [cli, 'data', 'query', 'device', '--store', store, '--json'])).stdout);
  assert.equal((q.records || q).length, 5);
  // gpu-health reads it directly too
  const gh = path.join(here, '..', 'gpu-health', 'tools', 'gpu-health.mjs');
  const r = JSON.parse((await run(process.execPath, [gh, 'analyze', '--cloud-monitoring', path.join(fx, 'cloud-monitoring.json'), '--state', path.join(path.dirname(store), 'gh'), '--now', String(Date.parse('2026-11-20T10:02:00Z') / 1000), '--json'])).stdout);
  assert.ok(JSON.stringify(r).includes('tpu'), 'TPU devices analyzed');
});

test('GCP billing export → accelerator-hours at the billed rate, net of credits; commitment fees and VM cores skipped', () => {
  const recs = gcpBilling(read('billing-export.jsonl'));
  assert.deepEqual(recs.map(r => [r.gpuType, r.gpus, r.purchase]), [['H200', 8, 'committed'], ['TPU-v6e', 8, 'on-demand'], ['H100', 4, 'spot'], ['A100-40GB', 1, 'on-demand'], ['TPU-v5p', 4, 'calendar-mode']]);
  const h200 = recs[0];
  assert.ok(Math.abs(h200.rate - (96 - 38.4) / 8) < 1e-9, 'net of the committed-use credit');
  assert.deepEqual([h200.cluster, h200.labels.team, h200.node], ['train', 'research', 'gke-train-a3u-pool-1a2b3c4d-x7k2']);
  assert.equal(recs[1].namespace, 'chat');
  assert.deepEqual(recs.skipped, { notAccelerator: 1, commitmentFee: 1, notUsage: 0 });
  const L = ledger(recs, { from: Date.parse('2026-11-20T10:00:00Z') / 1000, to: Date.parse('2026-11-20T11:00:00Z') / 1000, attribution: {} });
  assert.ok(Math.abs(L.totals.cost - (57.6 + 21.6 + 9 + 2.93 + 8.4)) < 1e-6);
});

test('DWS calendar mode: the read-only advice command for GPUs (machine type × VMs) and TPUs (version × chips)', () => {
  const from = Date.parse('2026-12-01T00:00:00Z') / 1000;
  assert.deepEqual(gcpCalendarMode({ chip: 'H200', gpus: 60, days: 7, region: 'us-central1', from }).argv, ['gcloud', 'compute', 'advice', 'calendar-mode', '--machine-type=a3-ultragpu-8g', '--vm-count=8',
    '--region=us-central1', '--duration-range=min=7d,max=7d', '--start-time-range=from=2026-12-01,to=2026-12-15']);
  const t = gcpCalendarMode({ chip: 'TPU-v6e', gpus: 64, days: 120, region: 'us-east5', from });
  assert.deepEqual(t.argv.slice(4, 8), ['--tpu-version=V6E', '--chip-count=64', '--workload-type=BATCH', '--region=us-east5']);
  assert.match(t.notes.join(' '), /at most 90 days/); assert.equal(t.days, 90);
  assert.throws(() => gcpCalendarMode({ chip: 'H100', gpus: 8, days: 1 }), /need --region/);
});
