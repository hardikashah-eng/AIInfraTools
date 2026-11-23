import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DataStore, whereFrom } from '../src/store.mjs';
import { validate } from '../src/schema.mjs';
import { toEpoch } from '../src/adapters/time.mjs';
import { readLines } from '../src/lines.mjs';
import * as Philly from '../src/adapters/philly.mjs';
import * as Pub from '../src/adapters/public.mjs';
import * as Live from '../src/adapters/live.mjs';
import { toGpuHealth, toFleetScopeTrace } from '../src/export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), FX = f => path.join(HERE, 'fixtures', f), read = f => fs.readFileSync(FX(f), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-'));
const CLI = path.join(HERE, '..', 'tools', 'fleetops.mjs');
const cli = (...a) => { const r = spawnSync('node', [CLI, ...a, '--json'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };

test('store: append by day, dedupe, validate, query by window and filter', () => {
  const s = new DataStore(tmp());
  const recs = [{ t: 86400 * 2 + 5, node: 'a', gpu: '0', sm: 0.5 }, { t: 86400 * 3 + 5, node: 'a', gpu: '1', sm: 0.1 }, { t: 5, gpu: '0' }];
  const r = s.append('device', recs, { source: 'test' });
  assert.equal(r.written, 2); assert.equal(r.invalid, 1); assert.match(r.errors[0], /node is required/);
  assert.equal(s.append('device', recs.slice(0, 2), { source: 'test', dedupe: true }).written, 0, 're-import writes nothing');
  assert.equal(s.files('device').length, 2);
  assert.equal(s.query('device', { from: 86400 * 3 }).length, 1);
  assert.equal(s.query('device', { where: whereFrom(['sm>0.2']) })[0].gpu, '0');
  assert.equal(s.query('device', { where: whereFrom(['node~a', 'gpu=1']) }).length, 1);
  assert.deepEqual(Object.keys(s.summary()), ['device']);
  assert.equal(s.summary().device.sources.test, 2);
  assert.deepEqual(validate('job', { t: 1, job: 'x', status: 'exploded' }), ['status "exploded" is not one of ok, failed, killed, cancelled, timeout, retried']);
  assert.throws(() => s.append('nonsense', []), /unknown kind/);
});

test('time: zones, Pacific daylight saving, epoch numbers', () => {
  assert.equal(toEpoch('2017-11-08 00:00:00 PST'), Date.UTC(2017, 10, 8, 8) / 1000);
  assert.equal(toEpoch('2017-10-07 01:12:09', { tz: 'pacific' }), Date.UTC(2017, 9, 7, 8, 12, 9) / 1000, 'PDT before November');
  assert.equal(toEpoch('2017-11-08 01:00:00', { tz: 'pacific' }), Date.UTC(2017, 10, 8, 9) / 1000, 'PST after the first Sunday of November');
  assert.equal(toEpoch('2023-05-17 11:00:58+00:00'), Date.UTC(2023, 4, 17, 11, 0, 58) / 1000);
  assert.equal(toEpoch(1763640000000), 1763640000); assert.equal(toEpoch('None'), null);
});

test('philly: machines, per-GPU utilization steps with offline GPUs, attempts and outcomes', () => {
  const inv = Philly.machines(read('philly_machine_list.csv'));
  assert.deepEqual(inv.map(m => [m.node, m.devices, m.deviceMemGB]), [['m1', 8, 24], ['m2', 2, 12]]);
  const s = [...Philly.gpuUtil(readLines(FX('philly_gpu_util.csv')), { stepMin: 10, skus: { m1: '24GB GPU' } })];
  const g = k => s.find(x => x.node + '/' + x.gpu === k);
  assert.ok(Math.abs(g('m1/0').sm - 0.8) < 1e-9); assert.equal(g('m1/1').offlineMinutes, 1); assert.equal(g('m1/2'), undefined, 'all minutes NA: no sample');
  assert.equal(g('m1/0').sku, '24GB GPU'); assert.equal(g('m2/1').sm, 0.3);
  assert.equal(new Set(s.map(x => x.t)).size, 1, 'one 10-minute step');
  const { placements, outcomes } = Philly.jobLog(JSON.parse(read('philly_job_log.json')), { from: toEpoch('2017-11-07 23:45:00', { tz: 'pacific' }) });
  assert.deepEqual(placements.map(p => p.job), ['app_1#1', 'app_1#2', 'app_2']);
  assert.deepEqual(placements[0].devices, [{ node: 'm1', gpu: '0' }, { node: 'm1', gpu: '1' }]);
  assert.deepEqual(outcomes.map(o => [o.job, o.status]), [['app_1#1', 'retried'], ['app_1#2', 'failed']], 'a still-running job has no outcome');
});

test('public: Azure LLM trace, MLPerf summary, AcmeTrace', () => {
  const a = Pub.azureLlm(read('azure_llm.csv'), { pool: 'code' });
  assert.deepEqual(a.map(r => [r.isl, r.osl, r.pool]), [[4808, 10, 'code'], [3180, 8, 'code']]);
  assert.equal(a[0].t, Date.UTC(2023, 10, 16, 18, 15, 46, 680) / 1000);
  const m = Pub.mlperfSummary(read('mlperf_log_summary.txt'), { path: 'closed/NVIDIA/results/H200-SXM-141GBx8_TRT/llama2-70b-99/Server/performance/run_1/mlperf_log_summary.txt' });
  assert.deepEqual([m.submitter, m.gpu, m.gpus, m.model, m.scenario, m.valid], ['NVIDIA', 'H200', 8, 'llama2-70b-99', 'Server', true]);
  assert.equal(m.ttftP50, 0.4); assert.equal(m.tpotP99, 0.18); assert.equal(m.qps, 101.5); assert.equal(m.oslMean, 290);
  assert.equal(Pub.mlperfSummary('x', { path: 'closed/AMD/results/8xMI325X_2xEPYC_9575F/llama2-70b-99/Server/x' }).gpus, 8);
  const j = Pub.acme(read('acme_trace.csv'), { cluster: 'kalos' });
  assert.deepEqual(j.map(x => [x.job, x.status, x.cause, x.gpus]), [['kalos:j1', 'failed', 'infra', 64], ['kalos:j2', 'ok', 'unknown', 8]]);
});

test('live: exporter, Kubernetes, Slurm, git change feed', () => {
  const d = Live.exporterScrape(read('dcgm.prom'), { t: 100 });
  assert.deepEqual([d[0].node, d[0].vendor, d[0].tensor, d[0].source], ['n1', 'nvidia', 0.42, 'exporter:nvidia']);
  const inv = Live.k8sNodes(read('k8s_nodes.json'), { t: 1 });
  assert.deepEqual(inv.map(n => [n.node, n.vendor, n.sku, n.devices, n.site]), [['gpu-a', 'nvidia', 'NVIDIA-H100-80GB-HBM3', 8, 'us-west-2a']]);
  const pods = Live.k8sPods(read('k8s_pods.json'));
  assert.deepEqual(pods.map(p => [p.job, p.node, p.gpuCount, p.namespace, p.class]), [['chat', 'gpu-a', 4, 'serving', 'inference']]);
  assert.deepEqual(Live.slurmNodes(read('scontrol_nodes.txt')).map(n => [n.node, n.vendor, n.sku, n.devices]), [['gpu01', 'nvidia', 'h100', 8], ['gpu02', 'amd', 'mi300x', 8]]);
  const jobs = Live.slurmSacct(read('sacct.txt'));
  assert.deepEqual(jobs.map(j => [j.job, j.status, j.cause, j.gpus, j.nodes.join(' ')]), [['101', 'failed', 'infra', 16, 'gpu01 gpu02'], ['102', 'ok', 'unknown', 1, 'gpu01']]);
  assert.deepEqual(Live.expandNodes('gpu[01-03,07],cpu5'), ['gpu01', 'gpu02', 'gpu03', 'gpu07', 'cpu5']);
  const ch = Live.gitLog(read('git_log.txt'), { repo: 'infra' });
  assert.deepEqual(ch.map(c => [c.kind, c.target, c.by]), [['deploy', 'clusters/prod/serving/chat', 'alice'], ['driver', 'clusters/prod/nodes', 'bob']]);
});

test('export: the data layer becomes gpu-health and FleetScope inputs', () => {
  const s = new DataStore(tmp());
  s.append('device', [...Philly.gpuUtil(readLines(FX('philly_gpu_util.csv')))]);
  const x = Philly.jobLog(JSON.parse(read('philly_job_log.json')));
  s.append('placement', x.placements); s.append('job', x.outcomes);
  const g = toGpuHealth(s, {});
  assert.ok(g.samples.length > 0 && !('source' in g.samples[0]) && g.samples[0].faults);
  assert.deepEqual(g.jobs.map(j => j.id).sort(), ['app_1#2', 'app_2'], 'the later attempt owns the GPUs');
  assert.deepEqual(g.results.map(r => [r.job, r.status, r.node, r.gpu]), [['app_1#2', 'failed', 'm1', '0']], 'retries are not job ends');
  s.append('request', Pub.azureLlm(read('azure_llm.csv'), { pool: 'code' }));
  assert.equal(toFleetScopeTrace(s, { pool: 'code' }).split('\n')[1], '2023-11-16T18:15:46.680Z,4808,10');
});

test('cli: import, summary, query and export round trip', () => {
  const store = tmp(), out = tmp();
  cli('data', 'import', 'philly-machines', FX('philly_machine_list.csv'), '--store', store);
  cli('data', 'import', 'philly-gpu', FX('philly_gpu_util.csv'), '--store', store, '--machines', '1');
  const again = cli('data', 'import', 'philly-gpu', FX('philly_gpu_util.csv'), '--store', store, '--machines', '1');
  assert.equal(again.imported.device.written, 0, 'idempotent');
  cli('data', 'import', 'k8s-nodes', FX('k8s_nodes.json'), '--store', store);
  cli('data', 'import', 'git-log', FX('git_log.txt'), '--store', store, '--repo', 'infra');
  const sum = cli('data', 'summary', '--store', store).summary;
  assert.equal(sum.device.records, 3, 'only m1 (the one 8-GPU machine): GPUs 0, 1 and 3 reported, GPU 2 was offline');
  assert.equal(sum.change.records, 2);
  assert.equal(cli('data', 'query', 'change', '--store', store, '--where', 'kind=driver').records.length, 1);
  const ex = cli('data', 'export', 'gpu-health', '--store', store, '--out', out).exported;
  assert.equal(ex.samples, 3);
  assert.ok(fs.existsSync(path.join(out, 'jobs.json')));
});
