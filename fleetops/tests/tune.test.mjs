import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import { synthTraining } from '../src/goodput.mjs';
import { tune, tuneMarkdown, applyTune, verifyTune, holdout } from '../src/tune.mjs';
import { readTar, writeTar, sniff, safeName } from '../src/bundle.mjs';
import { handleApi } from '../src/api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const FX = path.join(here, 'fixtures'), H = 3600, D = 86400, T0 = Date.UTC(2026, 10, 2) / 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tune-'));
const load = (s, recs) => { for (const [k, v] of Object.entries(recs)) if (v.length) s.append(k, v); return s; };

test('training: the planted problems become ranked recommendations with evidence, knobs and a basis', () => {
  const s = load(new MemStore(), synthTraining({ t0: T0 }));
  const t = tune(s, { from: T0, to: T0 + 7 * D });
  const by = Object.fromEntries(t.recommendations.map(r => [r.id, r]));
  assert.equal(t.recommendations[0].id, 'checkpoint:pretrain-70b', 'the biggest saving first');
  assert.equal(by['checkpoint:pretrain-70b'].impact.basis, 'model');
  assert.match(by['checkpoint:pretrain-70b'].change.summary, /→ 3\d min/);
  assert.equal(by['data-pipeline:sft-8b'].impact.basis, 'upper bound');
  assert.ok(by['data-pipeline:sft-8b'].change.knobs.some(k => /num_workers/.test(k.name)));
  assert.match(by['slow-steps:rl-policy'].title, /from 2026-11-04 to 2026-11-06/, 'the two slow days are named');
  assert.ok(t.missing.some(m => /serving metrics/.test(m)));
  assert.match(tuneMarkdown(t), /fleetops tune apply checkpoint:pretrain-70b/);
});

test('verify: two changes applied mid-way are measured as improved, close to what was predicted', () => {
  const at = T0 + 7 * D, s = load(new MemStore(), synthTraining({ t0: T0, days: 14, tuned: { at, 'sft-8b': { data: 0.12 }, 'pretrain-70b': { ckptEvery: 40 * 60 } } }));
  assert.equal(verifyTune(s, 'checkpoint:pretrain-70b').verdict, 'not applied');
  const t = tune(s, { from: T0, to: at, now: at });
  for (const id of ['data-pipeline:sft-8b', 'checkpoint:pretrain-70b']) applyTune(s, t.recommendations.find(r => r.id === id), { by: 'ana', at });
  assert.throws(() => applyTune(s, t.recommendations[0], { at }), /who applied it/);
  const now = T0 + 14 * D;
  const dp = verifyTune(s, 'data-pipeline:sft-8b', { now }), ck = verifyTune(s, 'checkpoint:pretrain-70b', { now });
  assert.equal(dp.verdict, 'improved'); assert.equal(ck.verdict, 'improved');
  assert.ok(dp.ci[1] < 0 && ck.ci[1] < 0);
  // the data pipeline went from 0.6 s to 0.12 s a step: share ~33% → ~9%
  assert.ok(Math.abs(dp.after.mean - 0.12 / 1.32) < 0.03, `${dp.after.mean}`);
  // Young/Daly's prediction and the measured change agree within 15 points
  assert.ok(Math.abs(ck.rel - ck.predicted) < 0.15, `measured ${ck.rel} predicted ${ck.predicted}`);
  // too soon after the change
  assert.equal(verifyTune(s, 'checkpoint:pretrain-70b', { now: at + 2 * D }).verdict, 'not enough data');
  // the applied change is a change record: root-cause analysis sees it like a deploy
  assert.ok(s.query('change', { where: c => c.kind === 'tune' }).length === 2);
});

test('inference: KV-cache contrast is measured; the Inference Sizer sizes the pool; load swings suggest autoscaling', () => {
  // two days of 5-minute serving windows: quiet nights (6 req/s), a busy afternoon (60 req/s); the cache fills now and then
  const s = new MemStore(), sv = [];
  for (let i = 0; i < 2 * 288; i++) {
    const t = T0 + i * 300, hr = (t % D) / H, busy = hr >= 13 && hr < 17, full = i % 4 === 0;
    sv.push({ t, pool: 'chat', windowS: 300, rate: busy ? 60 : 6, islMean: 1500, oslMean: 300, kvUsage: full ? 0.96 : 0.6, ttftP99: full ? 3.2 : 0.8, preemptions: full ? 4 : 0 });
  }
  s.append('serving', sv);
  const t = tune(s, { from: T0, to: T0 + 2 * D, pools: { chat: { model: 'llama33-70b', gpu: 'H100', gpus: 64 } }, targets: { chat: { ttftP99: 2, tpotP99: 0.05 } } });
  const by = Object.fromEntries(t.recommendations.map(r => [r.id, r]));
  assert.equal(by['kv-cache:chat'].impact.basis, 'measured');
  assert.equal(by['kv-cache:chat'].impact.expected, 0.8);
  assert.ok(by['size:chat'] && /Shrink chat from 64/.test(by['size:chat'].title));
  assert.match(by['size:chat'].impact.basis, /uncalibrated/);
  assert.ok(by['autoscale:chat'], 'the afternoon peak is ~10× the night');
  assert.ok(by['autoscale:chat'].impact.gpuHoursPerWeek > 0);
});

test('fleet: nodes in far more failed attempts than their share, found and still there out of sample', () => {
  const s = new MemStore(), place = [], jobs = [];
  let id = 0;
  // 20 nodes × 8 GPUs; one-node jobs of 4 h; n07 fails 40% of its jobs, the rest 3%
  for (let d = 0; d < 8; d++) for (let n = 1; n <= 20; n++) for (let k = 0; k < 6; k++) {
    const node = `n${String(n).padStart(2, '0')}`, start = T0 + d * D + k * 4 * H, job = `j${id++}`, bad = node === 'n07' ? (id % 5 < 2) : id % 33 === 0;
    place.push({ t: start, job, start, end: start + 4 * H, devices: Array.from({ length: 8 }, (_, g) => ({ node, gpu: String(g) })) });
    jobs.push({ t: start + 4 * H, job, status: bad ? 'failed' : 'ok', cause: bad ? 'device' : 'unknown', start, end: start + 4 * H });
  }
  s.append('placement', place); s.append('job', jobs);
  const t = tune(s, { from: T0, to: T0 + 8 * D }), f = t.recommendations.find(r => r.id === 'flaky-nodes');
  assert.equal(f.target, 'n07');
  const h = holdout(s, { from: T0, split: T0 + 4 * D, to: T0 + 8 * D });
  const row = h.rows.find(r => r.id === 'flaky-nodes');
  assert.equal(row.held, true); assert.ok(row.outOfSample.ratio > 5);
});

test('bundles: tar round trip, path safety, content sniffing', () => {
  const tar = zlib.gzipSync(writeTar([{ name: 'a/b.txt', data: 'hello' }, { name: 'x'.repeat(120) + '/long.txt', data: 'long' }]));
  assert.deepEqual(readTar(tar).map(e => [e.name, e.data.toString()]), [['a/b.txt', 'hello'], ['x'.repeat(120) + '/long.txt', 'long']]);
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'C:/x']) assert.throws(() => safeName(bad), /unsafe/);
  assert.throws(() => readTar(Buffer.from('not a tar')), /not a tar/);
  const f = n => fs.readFileSync(path.join(FX, n), 'utf8');
  const expect = { 'dcgm.prom': 'exporter', 'sacct.txt': 'sacct', 'k8s_nodes.json': 'k8s-nodes', 'k8s_pods.json': 'k8s-pods', 'azure_llm.csv': 'azure-llm', 'scontrol_nodes.txt': 'slurm-nodes',
    'signals/kernel.log': 'kernel-log', 'signals/train.log': 'app-log', 'signals/helm_history.json': 'helm-history', 'signals/ibnetdiscover.txt': 'ibnetdiscover', 'signals/nvidia_topo.txt': 'nvidia-topo', 'signals/nvidia_smi_q.txt': 'nvidia-smi-q', 'signals/k8s_events.json': 'k8s-events', 'philly_job_log.json': 'philly-jobs' };
  for (const [n, src] of Object.entries(expect)) assert.equal(sniff(n, f(n)), src, n);
  assert.equal(sniff('s.jsonl', '{"t":1,"rank":0,"node":"a","step":1,"durS":1.1}\n'), 'step-log');
  assert.equal(sniff('r.jsonl', '{"t":1,"isl":100,"osl":20}\n'), 'requests');
  assert.equal(sniff('notes.txt', 'nothing to see'), null);
});

test('collect.sh → bundle → import, and upload to a server by role', async () => {
  if (spawnSync('bash', ['-c', 'true']).status !== 0) return;
  const d = tmp(), bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  // stand-ins for the tools on a GPU node
  fs.writeFileSync(path.join(bin, 'nvidia-smi'), `#!/bin/bash\nif [ "$1" = "-q" ]; then cat ${FX}/signals/nvidia_smi_q.txt; else cat ${FX}/signals/nvidia_topo.txt; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'journalctl'), `#!/bin/bash\ncat ${FX}/signals/kernel.log\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/bash\ncase "$2" in nodes) cat ${FX}/k8s_nodes.json;; pods) cat ${FX}/k8s_pods.json;; events) cat ${FX}/signals/k8s_events.json;; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'steps.jsonl'), '{"t":1795500000,"rank":0,"node":"gpu-a1","step":100,"durS":1.2,"dataS":0.3,"job":"llm"}\n');
  // an empty sysfs and no NFS mounts, so the host's own NICs don't change the bundle (fabric-storage-real covers those)
  fs.mkdirSync(path.join(d, 'sys'));
  const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, FLEETOPS_SYSFS: path.join(d, 'sys'), FLEETOPS_MOUNTSTATS: '/dev/null' });
  const c = spawnSync('bash', [path.join(here, '..', 'tools', 'collect.sh'), '--node', 'gpu-a1', '--dcgm', 'http://127.0.0.1:1/none', '--k8s', '--step-log', path.join(d, 'steps.jsonl'), '--out', path.join(d, 'b')], { env, cwd: d, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const mf = JSON.parse(fs.readFileSync(path.join(d, 'b', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.files.map(f => f.source).sort(), ['k8s-events', 'k8s-nodes', 'k8s-pods', 'kernel-log', 'nvidia-smi-q', 'nvidia-topo', 'step-log']);
  const r = JSON.parse((await run(process.execPath, [cli, 'data', 'import', 'bundle', path.join(d, 'b.tar.gz'), '--store', path.join(d, 's'), '--json'])).stdout).bundle;
  assert.ok(r.totals.inventory >= 2 && r.totals.log >= 1 && r.totals.step === 1 && r.totals.placement >= 1);
  assert.ok(r.files.every(f => !f.error), JSON.stringify(r.files.filter(f => f.error)));
  // upload: ingest role only
  const tf = path.join(d, 'tokens.jsonl'), tok = role => (/fo_[\w-]+/.exec(spawnSync(process.execPath, [cli, 'token', 'create', '--tokens', tf, '--name', role, '--roles', role], { encoding: 'utf8' }).stdout) || [])[0];
  const ing = tok('ingest'), rd = tok('read');
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, [cli, 'serve', '--store', path.join(d, 'up'), '--tokens', tf, '--port', String(20000 + Math.floor(Math.random() * 20000))], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; p.stdout.on('data', b => { out += b; const m = out.match(/127\.0\.0\.1:(\d+)/); if (m) res(+m[1]); }); p.on('exit', () => rej(new Error(out))); });
    const post = token => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: '/v1/bundle', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' } }, r2 => { let b = ''; r2.on('data', x => (b += x)); r2.on('end', () => res({ status: r2.statusCode, body: b })); }); q.on('error', rej); q.end(fs.readFileSync(path.join(d, 'b.tar.gz'))); });
    assert.equal((await post(rd)).status, 403);
    const ok = await post(ing);
    assert.equal(ok.status, 200); assert.ok(JSON.parse(ok.body).totals.step === 1);
  } finally { p.kill(); }
});

test('the API serves recommendations to infra tokens only', () => {
  const s = load(new MemStore(), synthTraining({ t0: T0 }));
  const r = handleApi(s, { tenant: '*' }, 'GET', `/api/tune?from=${T0}&to=${T0 + 7 * D}`);
  assert.equal(r.status, 200); assert.ok(JSON.parse(r.body).recommendations.length >= 3);
  assert.equal(handleApi(s, { tenant: { pools: ['x'] } }, 'GET', '/api/tune').status, 403);
});
