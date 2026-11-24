// Power caps beyond the synthetic demo:
//  - real data: the slowdown model against measured power-limit sweeps (Zeus: 6 training workloads × batch sizes ×
//    optimizers on A40, V100, P100 and RTX 6000, epoch time at every limit);
//  - no mocks: the CLI end to end on those measurements turned into fleetops records;
//  - mocked: a planned cap applied live through a stand-in ssh, only after approval and with both locks open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as PW from '../src/power.mjs';
import { Store as GhStore } from '../../gpu-health/src/actions.mjs';
import { openStore } from '../src/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const ZEUS = path.join(here, 'fixtures', 'real', 'zeus'), GPUS = ['a40', 'v100', 'p100', 'rtx6000'];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };

// per configuration: the run at the top limit is the baseline; every lower limit is a cap
function sweeps(gpu) {
  const [h, ...rows] = fs.readFileSync(path.join(ZEUS, `summary_power_${gpu}.csv`), 'utf8').trim().split('\n'), k = h.split(',');
  const by = new Map();
  for (const r of rows) { const o = Object.fromEntries(r.split(',').map((v, i) => [k[i], v])); const id = [o.dataset, o.network, o.batch_size, o.optimizer].join('|'); if (!by.has(id)) by.set(id, []); by.get(id).push({ limit: +o.power_limit, epochS: +o.time_per_epoch, powerW: +o.average_power }); }
  return [...by.values()].map(xs => { const top = xs.reduce((a, b) => (b.limit > a.limit ? b : a)); return { top, caps: xs.filter(x => x.limit < top.limit) }; });
}
const job = top => ({ computeBound: 1, draws: [top.powerW], busyShare: 1, limitW: top.limit, gpus: 1 }); // training: compute-bound

test('real data (Zeus): from 60% to 100% of the limit the predicted slowdown is within a few points of the measured one', () => {
  for (const g of GPUS) {
    const err = [], meas = [];
    for (const { top, caps } of sweeps(g)) for (const c of caps) {
      if (c.limit < 0.6 * top.limit) continue;
      const p = PW.predict(job(top), c.limit); assert.ok(!p.outOfRange);
      err.push(p.slowdown - (c.epochS / top.epochS - 1)); meas.push(c.epochS / top.epochS - 1);
    }
    assert.ok(err.length > 100 || g === 'p100' && err.length > 50, `${g}: ${err.length} capped runs`);
    // default α 0.35 for compute-bound work, not fitted to these GPUs
    assert.ok(Math.abs(q(err, 0.5)) <= 0.02, `${g} median error ${q(err, 0.5)}`);
    assert.ok(q(err, 0.1) >= -0.08 && q(err, 0.9) <= 0.07, `${g} p10..p90 ${q(err, 0.1)}..${q(err, 0.9)}`);
    assert.ok(q(meas, 0.9) > 0.05, `${g}: the caps do slow the work (p90 ${q(meas, 0.9)})`);
  }
});

test('real data (Zeus): below 60% of the limit the model is far too low, and predict says so', () => {
  const ratio = [];
  for (const { top, caps } of sweeps('a40')) for (const c of caps) {
    if (c.limit >= 0.6 * top.limit) continue;
    const p = PW.predict(job(top), c.limit); assert.ok(p.outOfRange); assert.match(p.note, /under 60%/);
    ratio.push((c.epochS / top.epochS - 1) / Math.max(p.slowdown, 1e-6));
  }
  assert.ok(ratio.length > 50 && q(ratio, 0.5) > 2, `measured/predicted median ${q(ratio, 0.5)} on ${ratio.length} runs`);
  assert.ok(PW.POWER_DEFAULTS.levels.every(l => l >= PW.POWER_DEFAULTS.minCapPct), 'the planner never goes below the validated range');
});

test('no mocks: the CLI on real measurements (one Zeus workload as device, step and placement records) predicts the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-real-')), st = path.join(dir, 's');
  // BERT-base on SQuAD (batch 48) on V100s, as 8 GPUs on one node at the 250 W limit drawing what Zeus measured. Zeus
  // records no DCGM activity: tensor 0.9 and DRAM 0.1 are assumed for fine-tuning.
  const sw = sweeps('v100').find(s => s.caps.some(c => c.limit === 175) && Math.abs(s.top.epochS - 1832.045) < 1);
  const capped = sw.caps.find(c => c.limit === 175), t0 = 1795000000, H = 3600, dev = [], steps = [];
  for (const [from, run_, limit] of [[t0, sw.top, 250], [t0 + H, capped, 175]]) for (let t = from; t < from + H; t += 60) for (let g = 0; g < 8; g++) {
    dev.push({ t, node: 'v100-n1', gpu: String(g), sku: 'Tesla V100-SXM2-32GB', vendor: 'nvidia', powerW: run_.powerW, powerLimitW: limit, sm: 0.95, tensor: 0.9, dram: 0.1 });
    if (g === 0) steps.push({ t, node: 'v100-n1', job: 'bert-squad', rank: 0, durS: run_.epochS / 100 });
  }
  const store = await openStore(st); store.append('device', dev); store.append('step', steps);
  store.append('placement', [{ t: t0, job: 'bert-squad', class: 'training', start: t0, end: t0 + 2 * H, devices: Array.from({ length: 8 }, (_, g) => ({ node: 'v100-n1', gpu: String(g) })) }]); if (store.close) await store.close();
  const pr = JSON.parse((await run(process.execPath, [cli, 'power', 'predict', '--cap', '175W', '--from', String(t0), '--to', String(t0 + H), '--store', st, '--json'])).stdout).jobs;
  const r = pr.find(x => x.job === 'bert-squad'), measured = capped.epochS / sw.top.epochS - 1;
  assert.ok(r, JSON.stringify(pr)); assert.equal(r.limitW, 250); assert.ok(Math.abs(r.drawP50 - sw.top.powerW) < 1e-6);
  assert.ok(measured > 0.1, `Zeus measured ${measured}`);
  assert.ok(Math.abs(r.prediction.slowdown - measured) < 0.06, `predicted ${r.prediction.slowdown}, measured ${measured}`);
  assert.ok(r.prediction.savedKw > 0.3, 'about 50 W less on each of 8 GPUs, over the IT share');
});

test('mocked ssh: a planned cap runs on the node only once approved, with --live and policy.dryRun false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-live-')), st = path.join(dir, 's'), bin = path.join(dir, 'bin'), calls = path.join(dir, 'ssh.log');
  fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env bash\necho "$*" >> ${calls}\n`, { mode: 0o755 });
  const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}` });
  const cli_ = (...a) => run(process.execPath, [cli, ...a, '--store', st], { env });
  const d = JSON.parse((await cli_('power', 'demo', '--json')).stdout).demo, plan = path.join(dir, 'plan.json');
  await cli_('power', 'plan', '--budgets', d.budgets, '--from', String(d.from), '--to', String(d.to), '--out', plan);
  const live = path.join(dir, 'gh.json'); fs.writeFileSync(live, JSON.stringify({ policy: { dryRun: false } }));
  const adv = (...a) => cli_('optimize', 'advance', '--plan', plan, '--now', String(d.to + 60), ...a).catch(e => e);
  await adv('--live', '--config', live); assert.ok(!fs.existsSync(calls), 'waits for approval');
  const P = JSON.parse(fs.readFileSync(plan, 'utf8')), s = new GhStore(P.state);
  for (const a of s.data.actions.filter(x => x.status === 'proposed')) a.status = 'approved'; s.save();
  await adv(); assert.ok(!fs.existsSync(calls), 'approved but without --live: a dry run');
  const P1 = JSON.parse(fs.readFileSync(plan, 'utf8')); if (P1.stages[0].status !== 'pending') { P1.stages[0].status = 'pending'; fs.writeFileSync(plan, JSON.stringify(P1)); }
  await adv('--live', '--config', live);
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1 && lines.every(l => /^r1-n\d sudo nvidia-smi (-i \d+ )?-pl \d+$/.test(l)), lines.join('\n'));
  assert.ok(lines.every(l => +l.split(' ').at(-1) >= 0.6 * 700), 'no cap below 60% of the 700 W limit');
});
