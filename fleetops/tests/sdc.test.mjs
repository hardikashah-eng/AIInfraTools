import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import { DataStore } from '../src/store.mjs';
import { findSdc, toGpuHealthResults, sdcMarkdown } from '../src/sdc.mjs';
import { toGpuHealth } from '../src/export.mjs';
import { diagnose } from '../src/rca.mjs';
import * as Detect from '../src/detect.mjs';
import * as Bench from '../src/bench.mjs';
import * as Agent from '../src/agent.mjs';
import { ncclLog } from '../src/adapters/logs.mjs';
import { analyze } from '../../gpu-health/src/analyze.mjs';
import { loadConfig } from '../../gpu-health/src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 10, 20) / 1000;
// 4 data-parallel replicas × 2 tensor-parallel ranks; rank 5 (n3/1) corrupts from step 30; checkpoints every 20 steps
function job({ replicas = 4, badFrom = 30, badRank = 5, steps = 60 } = {}) {
  const s = new MemStore(), ranks = [];
  for (let d = 0; d < replicas; d++) for (let g = 0; g < 2; g++) ranks.push({ node: `n${d + 1}`, gpu: String(g) });
  const st = [], ck = [];
  for (let i = 0; i < steps; i++) {
    const t = T0 + i * 60;
    for (const [k, r] of ranks.entries()) { const x = { t, job: 'llm', rank: k, node: r.node, gpu: r.gpu, step: i, durS: 1 }; if (i % 20 === 19 && k === 0) x.ckptS = 10; st.push(x); }
    if (i % 5 === 0) for (const [k, r] of ranks.entries()) ck.push({ t: t + 1, check: 'param-checksum', job: 'llm', step: i, rank: k, node: r.node, gpu: r.gpu, group: `tp${r.gpu}`, value: k === badRank && i >= badFrom ? `x${i}` : `ok${i}${r.gpu}` });
  }
  s.append('step', st); s.append('sdc_check', ck);
  return { s, ranks };
}

test('a replica that disagrees with its peers is found, confirmed by repetition, and the job resumes from the checkpoint before it', () => {
  const { s } = job();
  const r = findSdc(s, { from: T0 - 60, to: T0 + 3600 });
  assert.equal(r.devices.length, 1);
  const d = r.devices[0];
  assert.equal(d.key, 'n3/1'); assert.equal(d.verdict, 'confirmed'); assert.deepEqual(d.checks, ['param-checksum']);
  assert.deepEqual(r.jobs.map(j => [j.job, j.firstBad.step, j.lastCleanCheckpoint.step]), [['llm', 30, 19]], 'first sign at step 30; step 19 was the last checkpoint before it (39 came after)');
  assert.match(sdcMarkdown(r), /checkpoint at step 19/);
});

test('two replicas can only say that something is wrong; a canary or replay names the GPU', () => {
  const { s } = job({ replicas: 2, badRank: 3 });
  let r = findSdc(s, { from: T0 - 60, to: T0 + 3600 });
  assert.ok(r.devices.every(d => d.verdict === 'watch'), 'with two replicas neither is blamed');
  s.append('sdc_check', [{ t: T0 + 3000, check: 'canary', node: 'n2', gpu: '1', test: 'matmul-fp32', value: 'aa', expected: 'bb', ok: false },
    { t: T0 + 3000, check: 'canary', node: 'n1', gpu: '1', test: 'matmul-fp32', value: 'bb', expected: 'bb', ok: true }]);
  r = findSdc(s, { from: T0 - 60, to: T0 + 3600 });
  assert.equal(r.devices[0].key, 'n2/1'); assert.equal(r.devices[0].verdict, 'confirmed');
  assert.ok(!r.devices.some(d => d.key === 'n1/1' && d.verdict !== 'watch'));
  const m = new MemStore();
  m.append('sdc_check', [{ t: T0, check: 'replay', job: 'llm', step: 7, node: 'n9', gpu: '2', replayNode: 'n8', replayGpu: '0', ok: false }]);
  assert.equal(findSdc(m, { from: T0 - 1, to: T0 + 1 }).devices[0].verdict, 'confirmed');
});

test('first rank to go non-finite and gradient-norm outliers; loss-scaler overflows are not evidence', () => {
  const lines = ncclLog('[rank5]: loss is nan at iteration 4120\nGradient overflow. Skipping step, loss scaler 0 reducing loss scale to 32768', { node: 'n3', job: 'llm', t: T0 + 100 });
  assert.deepEqual(lines.map(l => l.code), ['non_finite', 'loss_scale_overflow']);
  const s = new MemStore();
  s.append('log', [Object.assign({}, lines[0], { gpu: '1' })]);
  const st = [];
  for (let i = 0; i < 10; i++) for (let k = 0; k < 8; k++) st.push({ t: T0 + i * 60, job: 'llm', rank: k, node: `n${(k >> 1) + 1}`, gpu: String(k & 1), step: i, durS: 1, gradNorm: k === 5 && i >= 4 ? 300 : 1 + (k % 3) * 0.05 });
  s.append('step', st);
  const r = findSdc(s, { from: T0 - 60, to: T0 + 3600 });
  assert.equal(r.devices[0].key, 'n3/1');
  assert.deepEqual(r.devices[0].checks.sort(), ['grad-norm', 'nan']);
  assert.equal(r.devices[0].verdict, 'suspect', 'suggestive, not proof: a canary or replay confirms');
});

test('detection, diagnosis, the benchmark scenario, gpu-health and the agent', async () => {
  const { s } = job();
  const incs = Detect.detectTraining(s, { from: T0 - 60, to: T0 + 3600 }).filter(i => i.symptom === 'training-divergence');
  assert.equal(incs.length, 1); assert.equal(incs[0].job, 'llm');
  const d = diagnose(s, incs[0]);
  assert.equal(d.hypotheses[0].rule, 'silent-corruption');
  assert.deepEqual([d.hypotheses[0].targets.node, d.hypotheses[0].targets.gpu, d.hypotheses[0].targets.resumeStep], ['n3', '1', 19]);
  // the benchmark scenario ranks first in every seed tried
  const rows = Bench.run(Bench.generate({ perCause: 6, seed: 4, only: ['silent-corruption'] }));
  assert.equal(rows.top1, 1);
  // gpu-health quarantines the GPU with fault class sdc
  const res = toGpuHealthResults(findSdc(s, { from: T0 - 60, to: T0 + 3600 }));
  assert.ok(res.length >= 2 && res.every(x => x.kind === 'sdc' && x.node === 'n3' && x.gpu === '1'));
  const samples = [];
  for (let h = 0; h < 6; h++) for (let n = 1; n <= 4; n++) for (const g of ['0', '1']) samples.push({ t: T0 + h * 600, node: `n${n}`, gpu: g, vendor: 'nvidia', kind: 'gpu', sku: 'H100', tensor: 0.5, sm: 0.6, tempC: 60, faults: [] });
  const a = analyze({ samples, results: res, cfg: loadConfig(), now: T0 + 3600, windowDays: 1 });
  assert.equal(a.health.gpus['n3/1'].state, 'quarantined');
  assert.equal(a.health.gpus['n3/1'].faultClass, 'sdc');
  assert.equal(toGpuHealth(s, { from: T0 - 60, to: T0 + 3600 }).results.filter(x => x.kind === 'sdc').length, res.length);
  // the agent: quarantine and canary on their own; the owner told where to resume; the restart waits for a person
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-')), ds = new DataStore(path.join(dir, 's'));
  for (const k of ['step', 'sdc_check']) ds.append(k, s.query(k));
  const r = await Agent.tick(ds, { stateDir: path.join(dir, 'agent'), now: T0 + 3700 });
  const i = r.incidents.find(x => x.symptom === 'training-divergence');
  assert.equal(i.rule, 'silent-corruption');
  assert.deepEqual(i.actions.map(x => `${x.kind}:${x.mode}`).sort(), ['notify-owner:auto', 'quarantine:auto', 'restart-without-node:approve', 'run-diag:auto']);
  const { Store } = await import('../../gpu-health/src/actions.mjs');
  assert.match(new Store(path.join(dir, 'agent')).get('notify-owner:sdc:llm').reason, /resume from the checkpoint at step 19/);
});

test('the canary script compiles and documents its output', () => {
  const py = spawnSync('python3', ['-m', 'py_compile', path.join(here, '..', 'tools', 'sdc-canary.py')]);
  if (py.error) return; // no python here
  assert.equal(py.status, 0, String(py.stderr));
  const text = fs.readFileSync(path.join(here, '..', 'tools', 'sdc-canary.py'), 'utf8');
  assert.match(text, /"check": "canary"/);
  fs.rmSync(path.join(here, '..', 'tools', '__pycache__'), { recursive: true, force: true });
});
