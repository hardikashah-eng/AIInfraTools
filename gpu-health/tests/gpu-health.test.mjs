import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePrometheus, samplesFromExporter } from '../src/ingest.mjs';
import { loadConfig, modeFor } from '../src/config.mjs';
import { analyze } from '../src/analyze.mjs';
import { assessHealth } from '../src/health.mjs';
import { rightSize } from '../src/savings.mjs';
import { Store, suggest } from '../src/actions.mjs';
import { fill, run } from '../src/executors.mjs';
import { markdown, html } from '../src/report.mjs';
import { createServer } from '../src/server.mjs';
import { demoSamples, demoJobs, demoSteps, demoProbes, demoCluster, demoResults, DEMO_NOW } from '../src/synth.mjs';

const cfg = loadConfig({ pricePerGpuHour: { B200: 6, H200: 4.5 } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
let demoCache;
const demo = () => demoCache ||= analyze({ samples: demoSamples(), jobs: demoJobs(), steps: demoSteps(), probes: demoProbes(), results: demoResults(), cluster: demoCluster(), cfg, now: DEMO_NOW });

test('ingest: dcgm-exporter text becomes normalized samples', () => {
  const txt = `# HELP DCGM_FI_PROF_SM_ACTIVE x
DCGM_FI_PROF_SM_ACTIVE{gpu="0",UUID="GPU-a",Hostname="n1",modelName="NVIDIA B200",pod="train-0"} 0.81
DCGM_FI_PROF_PIPE_TENSOR_ACTIVE{gpu="0",Hostname="n1"} 0.52
DCGM_FI_PROF_DRAM_ACTIVE{gpu="0",Hostname="n1"} 0.33
DCGM_FI_DEV_FB_USED{gpu="0",Hostname="n1"} 163840
DCGM_FI_DEV_XID_ERRORS{gpu="1",Hostname="n1"} 79
DCGM_FI_DEV_XID_ERRORS{gpu="0",Hostname="n1"} 0`;
  assert.equal(parsePrometheus(txt).length, 6);
  const s = samplesFromExporter(txt, { t: 100 });
  const g0 = s.find(x => x.gpu === '0'), g1 = s.find(x => x.gpu === '1');
  assert.equal(g0.sm, 0.81); assert.equal(g0.tensor, 0.52); assert.equal(g0.memUsedGB, 160); assert.equal(g0.job, 'train-0'); assert.equal(g0.sku, 'NVIDIA B200');
  assert.deepEqual(g0.faults, []); assert.deepEqual(g1.faults, ['xid79']);
});

test('ingest: AMD exporter percentages are scaled and GFX stands in for tensor', () => {
  const s = samplesFromExporter(`gpu_gfx_activity{gpu_id="3",hostname="m1"} 64\ngpu_umc_activity{gpu_id="3",hostname="m1"} 20\ngpu_used_vram{gpu_id="3",hostname="m1"} 10240`, { t: 1 });
  assert.equal(s[0].vendor, 'amd'); assert.equal(s[0].sm, 0.64); assert.equal(s[0].tensor, 0.64); assert.equal(s[0].dram, 0.2); assert.equal(s[0].memUsedGB, 10);
});

test('demo: health finds the planted faults and nothing else', () => {
  const h = demo().health.gpus;
  assert.equal(h['n4/5'].state, 'quarantined'); assert.equal(h['n4/5'].faultClass, 'bus');
  for (const k of ['n2/5', 'n4/4', 'n4/6', 'n1/3', 'n3/6']) assert.equal(h[k].state, 'suspect', k);
  assert.equal(h['n1/2'].state, 'quarantined'); assert.equal(h['n1/2'].faultClass, 'sdc');
  assert.match(h['n4/4'].why, /corrected ECC/); assert.match(h['n4/6'].why, /PCIe/); assert.match(h['n2/5'].why, /clock-limited/);
  assert.match(h['n1/3'].why, /HBM 14°C hotter than peers \(same node and job\)/); assert.match(h['n1/3'].why, /own earlier days/);
  assert.match(h['n3/6'].why, /50% of samples missing/);
  const others = Object.values(h).filter(g => !['n4/5', 'n2/5', 'n4/4', 'n4/6', 'n1/2', 'n1/3', 'n3/6'].includes(g.key));
  assert.ok(others.every(g => g.state === 'serving' && g.schedulable));
  assert.equal(h['n4/4'].schedulable, false, 'suspect GPUs take no new jobs');
});

test('demo: efficiency verdicts, and memory-bound decode is not flagged', () => {
  const a = demo();
  const u = Object.fromEntries(a.jobUsage.map(x => [x.job, x.usage]));
  assert.equal(u['serve-chat'], 'memory-bound'); assert.equal(u['train-llm'], 'compute-bound');
  assert.equal(u['embed-svc'], 'underused'); assert.equal(u['notebook-ana'], 'idle'); assert.equal(u['etl-feature'], 'starved');
  assert.ok(!a.recommendations.some(r => r.job === 'serve-chat'));
  const r = Object.fromEntries(a.recommendations.map(x => [x.job, x]));
  assert.equal(r['embed-svc'].action, 'scale-in'); assert.equal(r['embed-svc'].replicas, 1); assert.equal(r['embed-svc'].gpusFreed, 3);
  assert.equal(r['notebook-ana'].action, 'reclaim-idle');
  assert.equal(r['etl-feature'].lever, 'fix-input'); assert.equal(r['etl-feature'].weekly, 0);
  assert.equal(r['train-llm'].lever, 'fix-straggler'); assert.equal(r['train-llm'].target, 'n2/5');
  assert.equal(r['ocr-svc'].lever, 'partition'); assert.equal(r['ocr-svc'].rightSize.target, 0.25);
  assert.equal(a.stragglers[0].rank, 13);
});

test('demo: fragmentation and partition plan', () => {
  const a = demo();
  assert.equal(a.fragmentation.freeTotal, 4); assert.equal(a.fragmentation.largestBlock, 2); assert.equal(a.fragmentation.stranded, 4);
  assert.match(a.fragmentation.blocked[0].note, /no node has 4 together/);
  assert.equal(a.partitionPlan[0].gpusNeeded, 1); assert.equal(a.partitionPlan[0].gpusNow, 2);
});

test('right-sizing keeps memory-bound jobs whole', () => {
  const js = { gpus: [{}, {}], st: { memPeakGB: 20, memTotalGB: 141, effP95: 0.7, dramP95: 0.7 } };
  assert.equal(rightSize(js, cfg).target, 2);
  const small = { gpus: [{}], st: { memPeakGB: 10, memTotalGB: 141, effP95: 0.15, dramP95: 0.15 } };
  assert.equal(rightSize(small, cfg).target, 0.25);
});

// minimal sample helper
const S = (t, node, gpu, extra = {}) => Object.assign({ t, node, gpu: String(gpu), sku: 'H200', tensor: 0.4, sm: 0.6, dram: 0.3, tempC: 60, powerW: 500, faults: [] }, extra);
const series = (now, node, gpu, extra = {}, n = 12) => Array.from({ length: n }, (_, i) => S(now - (n - 1 - i) * 60, node, gpu, extra));

test('lifecycle: quarantine → diag pass → burn-in → ready → released; a second failure within 30 days goes to RMA', () => {
  let now = 100000;
  const bad = series(now, 'a', 0, {}).map((s, i) => (i === 11 ? Object.assign({}, s, { faults: ['xid48'] }) : s));
  let h = assessHealth({ samples: [...bad, ...series(now, 'a', 1)], cfg, now });
  assert.equal(h.gpus['a/0'].state, 'quarantined'); assert.equal(h.gpus['a/1'].state, 'serving');
  const prev = () => ({ gpus: Object.fromEntries(Object.entries(h.gpus).map(([k, g]) => [k, g])) });
  const ok = t => series(t, 'a', 0);
  now += 3600; h = assessHealth({ samples: ok(now), results: [{ node: 'a', gpu: '0', t: now - 60, kind: 'diag', pass: true, level: 3 }], prev: prev(), cfg, now });
  assert.equal(h.gpus['a/0'].state, 'burnin');
  now += 3600; h = assessHealth({ samples: ok(now), results: [{ node: 'a', gpu: '0', t: now - 60, kind: 'burnin', pass: true }], prev: prev(), cfg, now });
  assert.equal(h.gpus['a/0'].state, 'ready'); assert.equal(h.gpus['a/0'].schedulable, false);
  now += 600; h = assessHealth({ samples: ok(now), results: [{ node: 'a', gpu: '0', t: now - 60, kind: 'release', by: 'ops' }], prev: prev(), cfg, now });
  assert.equal(h.gpus['a/0'].state, 'serving'); assert.equal(h.gpus['a/0'].schedulable, true);
  now += 5 * 86400; const again = series(now, 'a', 0).map((s, i) => (i === 11 ? Object.assign({}, s, { faults: ['xid79'] }) : s));
  h = assessHealth({ samples: again, prev: prev(), cfg, now });
  assert.equal(h.gpus['a/0'].state, 'rma');
});

test('lifecycle: a failed diag climbs the remediation ladder', () => {
  let now = 50000;
  const bad = series(now, 'b', 0).map((s, i) => (i === 11 ? Object.assign({}, s, { faults: ['xid48'] }) : s));
  let h = assessHealth({ samples: bad, cfg, now });
  now += 600; h = assessHealth({ samples: series(now, 'b', 0), results: [{ node: 'b', gpu: '0', t: now - 30, kind: 'diag', pass: false, detail: 'memtest' }], prev: { gpus: h.gpus }, cfg, now });
  assert.equal(h.gpus['b/0'].state, 'remediate'); assert.equal(h.gpus['b/0'].ladderStep, 1); assert.match(h.gpus['b/0'].why, /node-reboot/);
});

test('fail-closed on stale GPUs, but a fleet-wide outage trips the circuit breaker', () => {
  const now = 10000;
  const few = [...series(now, 'c', 0), ...series(now, 'c', 1), ...series(now, 'c', 2), ...series(now, 'c', 3), ...series(now, 'c', 4), ...series(now - 3600, 'c', 5)];
  let h = assessHealth({ samples: few, cfg, now });
  assert.equal(h.gpus['c/5'].state, 'quarantined'); assert.equal(h.gpus['c/5'].faultClass, 'stale'); assert.equal(h.breaker, false);
  const many = [...series(now, 'd', 0), ...series(now - 3600, 'd', 1), ...series(now - 3600, 'd', 2)];
  h = assessHealth({ samples: many, cfg, now });
  assert.equal(h.breaker, true); assert.equal(h.gpus['d/1'].state, 'serving'); assert.equal(h.gpus['d/1'].schedulable, true);
});

test('policy: modes by action and workload class', () => {
  assert.equal(modeFor(cfg, 'quarantine', 'batch'), 'auto');
  assert.equal(modeFor(cfg, 'reclaim-idle', 'training'), 'never');
  assert.equal(modeFor(cfg, 'reclaim-idle', 'interactive'), 'approve');
  assert.equal(modeFor(cfg, 'something-new', 'batch'), 'approve', 'unknown kinds need approval');
});

test('executors: no shell, and unsafe values are refused', () => {
  assert.deepEqual(fill(['kubectl', 'cordon', '{node}'], { node: 'gpu-node-01.dc1' }), ['kubectl', 'cordon', 'gpu-node-01.dc1']);
  for (const bad of ['n1; rm -rf /', '--kubeconfig=/tmp/x', '$(id)', 'a b', '']) assert.throws(() => fill(['x', '{node}'], { node: bad }));
});

test('executors: dry-run never calls the runner; live needs both locks', async () => {
  const calls = [];
  const runner = argv => { calls.push(argv); return { code: 0, out: 'ok' }; };
  const a = { id: 'q', kind: 'quarantine', node: 'n9', gpu: '3', status: 'approved', analyzedAt: 1000, severity: 'high', reason: 'x' };
  const r = await run(a, cfg, { dryRun: true, runner });
  assert.equal(r.dryRun, true); assert.equal(calls.length, 0); assert.equal(r.commands[0][3], 'n9');
  const dir = tmp(); const st = new Store(dir); st.data.actions.push(a); st.save();
  await st.execute(cfg, { live: true, runner, now: 1000, fleetSize: 10 });
  assert.equal(calls.length, 0, 'policy.dryRun=true still blocks --live');
  const liveCfg = loadConfig({ policy: { dryRun: false } });
  const res = await st.execute(liveCfg, { live: true, runner, now: 1000, fleetSize: 10 });
  assert.equal(calls.length, 2); assert.equal(res[0].ok, true); assert.equal(st.get('q').status, 'executed');
  assert.ok(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').includes('"event":"executed"'));
});

test('queue: dedupe, supersede, approval rules, rejected cooldown', () => {
  const st = new Store(tmp());
  const sug = [{ id: 'scale-in:svc', kind: 'scale-in', target: 'svc', job: 'svc', class: 'inference', reason: 'r', mode: 'approve', params: {} },
    { id: 'reclaim-idle:train', kind: 'reclaim-idle', target: 'train', class: 'training', reason: 'r', mode: 'never' }];
  st.merge(sug, cfg, 100); st.merge(sug, cfg, 200);
  assert.equal(st.list().length, 2);
  assert.equal(st.get('scale-in:svc').status, 'proposed'); assert.equal(st.get('reclaim-idle:train').status, 'suggested');
  assert.throws(() => st.approve('reclaim-idle:train', 'me'), /not proposed/);
  assert.throws(() => st.approve('scale-in:svc', ''), /approver/);
  st.reject('scale-in:svc', 'me', 'peak season', 300);
  st.merge(sug, cfg, 400);
  assert.equal(st.list().filter(a => a.kind === 'scale-in').length, 1, 'rejected actions stay quiet during the cooldown');
  st.merge([], cfg, 500);
  assert.equal(st.get('reclaim-idle:train').status, 'superseded');
});

test('queue: quarantine limit and stale analysis guard', async () => {
  const st = new Store(tmp());
  for (let i = 0; i < 5; i++) st.data.actions.push({ id: `quarantine:n/${i}`, kind: 'quarantine', node: 'n', gpu: String(i), status: 'approved', severity: 'high', analyzedAt: 0, reason: 'x' });
  st.data.actions.push({ id: 'scale-in:svc', kind: 'scale-in', job: 'svc', params: { replicas: 1, namespace: 'x' }, status: 'approved', analyzedAt: 0, reason: 'x' });
  const res = await st.execute(cfg, { now: 7200, fleetSize: 20 });
  assert.equal(res.filter(r => r.dryRun).length, 2, 'max(2, 10% of 20) quarantines per run');
  assert.equal(res.filter(r => r.skipped && /quarantine limit/.test(r.output)).length, 3);
  assert.match(res.find(r => r.id === 'scale-in:svc').output, /older than the allowed age/);
});

test('suggest: quarantine brings owner notice, diag and first ladder step; executed quarantine is not repeated', () => {
  const a = demo();
  const s = suggest(a, cfg);
  const ids = s.map(x => x.id);
  for (const id of ['quarantine:n4/5', 'notify-owner:n4/5:batch-sim', 'run-diag:n4/5', 'node-reboot:n4/5', 'swap-at-checkpoint:train-llm@n2/5', 'repartition:partition:H200']) assert.ok(ids.includes(id), id);
  assert.equal(s.find(x => x.id === 'node-reboot:n4/5').mode, 'approve');
  const st = new Store(tmp());
  st.merge(s, cfg, DEMO_NOW);
  Object.assign(st.get('quarantine:n4/5'), { status: 'executed', executedAt: DEMO_NOW + 60, updatedAt: DEMO_NOW + 60 });
  st.merge(s, cfg, DEMO_NOW + 3 * 86400);
  assert.equal(st.list().filter(x => x.kind === 'quarantine' && x.target === 'n4/5').length, 1);
});

test('reports render and escape', () => {
  const a = demo();
  const md = markdown(a, suggest(a, cfg).map(x => Object.assign({ status: 'proposed' }, x)));
  assert.match(md, /Potential savings/); assert.match(md, /embed-svc/); assert.match(md, /n4\/5 \| H200 \| quarantined/);
  const evil = JSON.parse(JSON.stringify(a)); evil.recommendations[0].job = '<script>x</script>';
  const h = html(evil, []);
  assert.ok(!h.includes('<script>x</script>')); assert.ok(h.includes('&lt;script&gt;'));
});

test('server: tokens, approval by token owner, dry-run execute', async () => {
  const dir = tmp(); const st = new Store(dir);
  st.merge([{ id: 'scale-in:svc', kind: 'scale-in', target: 'svc', job: 'svc', class: 'inference', reason: 'r', mode: 'approve', params: { replicas: 1, namespace: 'x' } }], cfg, Math.floor(Date.now() / 1000));
  const srv = createServer({ stateDir: dir, cfg, tokens: { named: [{ name: 'alice', token: 't-alice' }], shared: '' } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/actions')).status, 401);
    assert.equal((await fetch(base + '/api/actions', { headers: { authorization: 'Bearer nope' } })).status, 401);
    const H = { authorization: 'Bearer t-alice', 'content-type': 'application/json' };
    const ap = await (await fetch(base + '/api/actions/scale-in%3Asvc/approve', { method: 'POST', headers: H, body: JSON.stringify({ by: 'mallory' }) })).json();
    assert.equal(ap.approvedBy, 'alice', 'the token decides who approved');
    const ex = await (await fetch(base + '/api/actions/scale-in%3Asvc/execute', { method: 'POST', headers: H, body: JSON.stringify({ live: true }) })).json();
    assert.equal(ex.dryRun, true, 'live needs --allow-live'); assert.deepEqual(ex.commands[0], ['kubectl', '-n', 'x', 'scale', 'deployment', 'svc', '--replicas=1']);
    assert.match(await (await fetch(base + '/')).text(), /gpu-health/);
  } finally { srv.close(); }
});
