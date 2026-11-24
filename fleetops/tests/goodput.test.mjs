import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import { goodput, adviseCheckpoint, synthTraining, interruptionRate, CATEGORIES } from '../src/goodput.mjs';
import { goodputHtml, goodputMarkdown } from '../src/goodput-report.mjs';
import { handleApi } from '../src/api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const H = 3600, T0 = Date.UTC(2026, 10, 16) / 1000;
const sum = o => CATEGORIES.reduce((t, c) => t + o[c], 0);

test('demo week: each job loses GPU-hours to its planted cause, the categories add up, the interruption rate is recovered', () => {
  const s = new MemStore(), r = synthTraining({ t0: T0 });
  for (const [k, v] of Object.entries(r)) if (v.length) s.append(k, v);
  const g = goodput(s, { from: T0, to: T0 + 7 * 86400 });
  const by = Object.fromEntries(g.jobs.map(j => [j.job, j]));
  assert.equal(by['pretrain-70b'].top, 'lost-work');
  assert.equal(by['sft-8b'].top, 'data-stall');
  assert.equal(by['rl-policy'].top, 'slow-steps');
  // every attempt's split adds up to its allocation
  const alloc = s.query('placement').reduce((t, p) => t + (Math.min(p.end, T0 + 7 * 86400) - Math.max(p.start, T0)) * p.devices.length / H, 0);
  assert.ok(Math.abs(g.fleet.totalGpuHours - alloc) / alloc < 0.001, `${g.fleet.totalGpuHours} vs ${alloc}`);
  for (const j of g.jobs) assert.ok(Math.abs(sum(j.gpuHours) - j.totalGpuHours) < 0.05);
  // the planted ideal pace and interruption rate come back out
  assert.ok(Math.abs(by['pretrain-70b'].idealStepS - 4.0) < 0.1);
  const mtbiH = by['pretrain-70b'].advice.mtbiS / H;
  assert.ok(mtbiH > 4 && mtbiH < 9, `pretrain interrupted every ${mtbiH} h (planted ~6 h)`);
  assert.equal(by['pretrain-70b'].advice.verdict, 'checkpoint more often');
  assert.ok(by['pretrain-70b'].advice.gpuHoursPerWeekSaved > 1000);
  assert.equal(by['rl-policy'].advice.verdict, 'about right');
  assert.ok(g.fleet.goodput > 0.5 && g.fleet.goodput < 0.9);
  assert.equal(g.fleet.attemptResolution, 0);
});

test('one attempt by hand: startup, kept and lost steps, the hang before the failure, the restart from the checkpoint', () => {
  const s = new MemStore(), devices = Array.from({ length: 8 }, (_, i) => ({ node: 'n1', gpu: String(i) }));
  // attempt 1: starts at 0; the first 10 s step ends at 100, so 90 s of startup; a 5 s checkpoint with step 10;
  // steps 11–15 end at 245, then a failure at 300: 55 s hung
  const steps = [];
  let t = T0 + 90;
  for (let i = 1; i <= 15; i++) { t += 10 + (i === 10 ? 5 : 0); steps.push({ t, job: 'j', rank: 0, node: 'n1', step: i, durS: 10 + (i === 10 ? 5 : 0), ckptS: i === 10 ? 5 : undefined }); }
  s.append('placement', [{ t: T0, job: 'j#1', class: 'training', start: T0, end: T0 + 300, devices }]);
  s.append('job', [{ t: T0 + 300, job: 'j#1', status: 'failed', cause: 'device' }]);
  // attempt 2: starts at 400, its first step begins at 460 (60 s to restart), steps 11–20 again, finishes
  let t2 = T0 + 400 + 60;
  for (let i = 11; i <= 20; i++) { t2 += 10; steps.push({ t: t2, job: 'j', rank: 0, node: 'n1', step: i, durS: 10 }); }
  s.append('placement', [{ t: T0 + 400, job: 'j#2', class: 'training', start: T0 + 400, end: t2 + 20, devices }]);
  s.append('job', [{ t: t2 + 20, job: 'j#2', status: 'ok' }]);
  s.append('step', steps.map(x => { if (x.ckptS === undefined) delete x.ckptS; return x; }));
  const g = goodput(s, { from: T0 - 10, to: T0 + 2000, serving: false }), j = g.jobs[0], gpuS = k => j.gpuHours[k] * H / 8;
  assert.equal(j.attempts, 2); assert.equal(j.failures, 1);
  assert.ok(Math.abs(gpuS('startup') - 90) < 1, `startup ${gpuS('startup')}`);
  assert.ok(Math.abs(gpuS('checkpoint') - 5) < 1);
  assert.ok(Math.abs(gpuS('lost-work') - (50 + 55)) < 1, `lost ${gpuS('lost-work')}: steps 11–15 and the hang`);
  assert.ok(Math.abs(gpuS('restart') - 60) < 1);
  assert.ok(Math.abs(gpuS('productive') - 200) < 1, `productive ${gpuS('productive')}: steps 1–10 and 11–20`);
  assert.ok(Math.abs(gpuS('idle') - 20) < 1, 'teardown after the last step');
});

test('job traces only (no steps): attempts count whole, an upper bound; open allocations are left out', () => {
  const s = new MemStore(), dv = n => Array.from({ length: n }, (_, i) => ({ node: 'n', gpu: String(i) }));
  s.append('placement', [
    { t: T0, job: 'a#1', start: T0, end: T0 + H, devices: dv(4) }, { t: T0 + 2 * H, job: 'a#2', start: T0 + 2 * H, end: T0 + 4 * H, devices: dv(4) },
    { t: T0, job: 'open', start: T0, devices: dv(8) },
  ]);
  s.append('job', [{ t: T0 + H, job: 'a#1', status: 'retried', cause: 'unknown' }, { t: T0 + 4 * H, job: 'a#2', status: 'ok' }]);
  const g = goodput(s, { from: T0, to: T0 + 5 * H, serving: false });
  assert.equal(g.fleet.attemptResolution, 1);
  assert.ok(Math.abs(g.fleet.gpuHours['lost-work'] - 4) < 0.01 && Math.abs(g.fleet.gpuHours.productive - 8) < 0.01);
  assert.ok(Math.abs(g.fleet.openGpuHours - 40) < 0.01);
  assert.match(goodputMarkdown(g), /upper bound/);
});

test('Young/Daly advice and the interruption rate', () => {
  const a = adviseCheckpoint({ deltaS: 120, intervalS: 3 * H, mtbiS: 6 * H, restartS: 900, gpus: 256 });
  assert.ok(Math.abs(a.bestIntervalS - Math.sqrt(2 * 120 * 6 * H)) < 1);
  assert.equal(a.verdict, 'checkpoint more often');
  assert.ok(a.badputBest < a.badputNow);
  assert.equal(adviseCheckpoint({ deltaS: 120, intervalS: Math.sqrt(2 * 120 * 6 * H), mtbiS: 6 * H, gpus: 8 }).verdict, 'about right');
  assert.equal(adviseCheckpoint({ deltaS: 0, intervalS: 100, mtbiS: H, gpus: 8 }), null);
  const s = new MemStore();
  s.append('placement', [{ t: T0, job: 'x#1', start: T0, end: T0 + 10 * H, devices: [{ node: 'n', gpu: '0' }, { node: 'n', gpu: '1' }] }, { t: T0 + 10 * H, job: 'x#2', start: T0 + 10 * H, end: T0 + 20 * H, devices: [{ node: 'n', gpu: '0' }, { node: 'n', gpu: '1' }] }]);
  s.append('job', [{ t: T0 + 10 * H, job: 'x#1', status: 'failed', cause: 'device' }, { t: T0 + 20 * H, job: 'x#2', status: 'ok' }]);
  const r = interruptionRate(s, { from: T0, to: T0 + 20 * H });
  assert.equal(r.interruptions, 1); assert.ok(Math.abs(r.gpuHours - 40) < 1e-6);
});

test('serving goodput, the HTML report, the API, and the CLI with the demo', async () => {
  const s = new MemStore();
  s.append('request', Array.from({ length: 100 }, (_, i) => ({ t: T0 + i, pool: 'chat', isl: 100, osl: 50, ttft: i < 90 ? 0.4 : 2.0, e2e: (i < 90 ? 0.4 : 2.0) + 49 * 0.03 })));
  s.append('serving', [{ t: T0 + 300, pool: 'embed', windowS: 300, ttftP99: 0.2 }, { t: T0 + 600, pool: 'embed', windowS: 300, ttftP99: 0.9 }]);
  const g = goodput(s, { from: T0 - 1, to: T0 + 1000, targets: { chat: { ttftP99: 1.0, tpotP99: 0.05 }, embed: { ttftP99: 0.5 } } });
  const chat = g.serving.find(x => x.pool === 'chat'), embed = g.serving.find(x => x.pool === 'embed');
  assert.equal(chat.goodput, 0.9); assert.equal(embed.goodput, 0.5); assert.equal(embed.basis, 'windows');

  const t = new MemStore(), r = synthTraining({ t0: T0 });
  for (const [k, v] of Object.entries(r)) if (v.length) t.append(k, v);
  const html = goodputHtml(goodput(t, { from: T0, to: T0 + 7 * 86400 }));
  assert.match(html, /Training goodput/); assert.match(html, /Table view/); assert.match(html, /pretrain-70b/);
  const api = handleApi(t, { tenant: '*' }, 'GET', `/api/goodput?from=${T0}&to=${T0 + 7 * 86400}`);
  assert.equal(api.status, 200); assert.equal(JSON.parse(api.body).jobs.length, 3);
  assert.equal(handleApi(t, { tenant: { pools: ['chat'] } }, 'GET', '/api/goodput').status, 403);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goodput-')), st = path.join(dir, 's');
  const demo = JSON.parse((await run(process.execPath, [cli, 'demo', '--training', '--store', st, '--json'])).stdout).demo;
  assert.ok(demo.written.step > 1000);
  const out = JSON.parse((await run(process.execPath, [cli, 'goodput', '--days', '7', '--store', st, '--json'])).stdout).goodput;
  assert.equal(out.jobs.length, 3);
  await run(process.execPath, [cli, 'goodput', '--days', '7', '--format', 'html', '--out', path.join(dir, 'g.html'), '--store', st]);
  assert.ok(fs.statSync(path.join(dir, 'g.html')).size > 5000);
});
