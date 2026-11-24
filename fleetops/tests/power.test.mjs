import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MemStore } from '../src/memstore.mjs';
import * as PW from '../src/power.mjs';
import { tick } from '../src/agent.mjs';
import { loadConfig } from '../../gpu-health/src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'tools', 'fleetops.mjs'), run = promisify(execFile);
const load = () => { const d = PW.synth(), s = new MemStore(); for (const [k, v] of Object.entries(d.records)) s.append(k, v); return { d, s }; };

test('report: IT power per rack, PDU and site against budgets, and how many more nodes fit', () => {
  const { d, s } = load(), r = PW.report(s, { from: d.from, to: d.to, budgets: d.budgets });
  const g = k => r.groups.find(x => x.group === k);
  // r1: 16 GPUs near 690 W + 16 near 528 W, over 0.7 → ~28 kW
  assert.ok(g('rack:r1').p99Kw > 25 && g('rack:r1').p99Kw < 29); assert.ok(g('rack:r1').headroomKw < 0); assert.equal(g('rack:r1').overBudgetShare, 1);
  assert.ok(g('rack:r2').headroomKw > 30); assert.equal(g('rack:r2').moreNodes, Math.floor(g('rack:r2').headroomKw / g('rack:r2').nodeKwP95));
  assert.equal(g('site:sjc').nodes, 8); assert.ok(g('pdu:r1-a')); assert.equal(PW.normBudgets({ rack: { r1: 40 } })['rack:r1'], 40);
  assert.match(PW.report(new MemStore(), {}).note, /no device power samples/);
});

test('predict: memory-bound serving barely slows under a cap; compute-bound training does; below the draw nothing changes', () => {
  const { d, s } = load(), js = PW.jobs(s, { from: d.from, to: d.to }), j = n => js.find(x => x.job === n);
  assert.ok(j('pretrain-13b').computeBound > 0.7 && j('chat-70b').computeBound < 0.3);
  const t = PW.predict(j('pretrain-13b'), 490), c = PW.predict(j('chat-70b'), 490), e = PW.predict(j('embed'), 490);
  assert.ok(t.slowdown > 0.07 && t.slowdown < 0.12, `training ${t.slowdown}`); assert.ok(c.slowdown < 0.01, `serving ${c.slowdown}`);
  assert.equal(e.slowdown, 0); assert.equal(e.savedKw, 0, 'a cap above the draw saves nothing');
  assert.ok(t.savedKw > c.savedKw);
  assert.equal(PW.tdpOf('NVIDIA H100 80GB HBM3'), 700); assert.equal(PW.tdpOf('AMD Instinct MI300X'), 750); assert.equal(PW.tdpOf('NVIDIA H100 PCIe'), 350);
});

test('fit: recovers how clocks follow the power limit', () => {
  const { s } = load(), f = PW.fit(s, {});
  assert.ok(Math.abs(f.alphaCompute - 0.4) < 0.03, `α ${f.alphaCompute}`); assert.equal(f.devices, 2);
  assert.equal(PW.fit(new MemStore(), {}).alphaCompute, null);
});

test('plan: caps the job a cap slows least first, only as deep as needed; protects classes; vendor commands per node', () => {
  const { d, s } = load(), cfg = loadConfig();
  const p = PW.plan(s, { from: d.from, to: d.to, budgets: d.budgets, cfg });
  assert.equal(p.groups.length, 1); assert.equal(p.groups[0].group, 'rack:r1'); assert.ok(p.groups[0].met);
  const by = Object.fromEntries(p.caps.map(c => [c.job, c]));
  assert.ok(by['chat-70b'] && by['chat-70b'].capPct <= 0.6, 'serving capped deep: it costs little');
  assert.ok(by['pretrain-13b'].predictedSlowdown <= 0.05, 'within maxSlowdown');
  assert.ok(!by.embed, 'rack r2 is under budget');
  // a job holding every GPU of a node gets one node-wide command; undo restores the default limit
  assert.deepEqual(p.stages[0].apply.find(a => a.includes('r1-n3')), ['ssh', 'r1-n3', 'sudo', 'nvidia-smi', '-pl', String(by['chat-70b'].capW)]);
  assert.ok(p.stages[0].rollback.every(a => a.at(-1) === '700'));
  const prot = PW.plan(s, { from: d.from, to: d.to, budgets: d.budgets, protect: ['training'], cfg });
  assert.deepEqual(prot.caps.map(c => c.job), ['chat-70b']); assert.equal(prot.groups[0].met, false, 'serving alone is not enough: it says so');
  // AMD nodes get amd-smi
  const amd = new MemStore(); for (const [k, v] of Object.entries(d.records)) amd.append(k, k === 'device' ? v.map(x => Object.assign({}, x, { vendor: 'amd', sku: 'AMD Instinct MI300X' })) : v);
  const pa = PW.plan(amd, { from: d.from, to: d.to, budgets: d.budgets, cfg });
  assert.ok(pa.stages[0].apply.some(a => a.includes('amd-smi') && a.includes('--power-cap')));
});

test('verify: measured kW and step slowdown against the prediction', () => {
  const { d, s } = load(), p = PW.plan(s, { from: d.from, to: d.to - 3 * 3600, budgets: d.budgets });
  const at = d.to - 3 * 3600; p.stages[0].appliedAt = at;
  // after the cap: r1 draws less and the training steps run 4% slower
  const after = s.query('device', { from: at, to: d.to }).filter(x => x.node.startsWith('r1'));
  for (const x of after) { const c = p.caps.find(c => c.devices.some(dv => dv.node === x.node && dv.gpu === x.gpu)); if (c) x.powerW = Math.min(x.powerW, c.capW); }
  for (const st of s.query('step', { from: at, to: d.to })) st.computeS *= 1.04;
  const v = PW.verify(s, p, { now: d.to, windowS: 3 * 3600 });
  assert.ok(v.groups[0].measuredSavedKw > 2, `saved ${v.groups[0].measuredSavedKw}`);
  const tj = v.jobs.find(j => j.job === 'pretrain-13b'); assert.ok(Math.abs(tj.measuredSlowdown - 0.04) < 0.01);
});

test('agent: a rack over its power budget gets power caps proposed for approval', async () => {
  const { d, s } = load(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
  const r = await tick(s, { stateDir: dir, agent: { power: { budgets: d.budgets, windowS: 6 * 3600 } }, now: d.to });
  assert.equal(r.power[0].group, 'rack:r1');
  const q = JSON.parse(fs.readFileSync(path.join(dir, 'actions.json'), 'utf8')).actions.filter(a => a.kind === 'power-cap-node');
  assert.ok(q.length >= 2); assert.ok(q.every(a => a.status === 'proposed' && a.mode === 'approve'), 'never applied on its own');
});

test('CLI: power demo → report, predict, fit, plan (queued) ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwc-')), st = path.join(dir, 's');
  const d = JSON.parse((await run(process.execPath, [cli, 'power', 'demo', '--store', st, '--json'])).stdout).demo;
  const w = ['--from', String(d.from), '--to', String(d.to), '--store', st];
  const rep = JSON.parse((await run(process.execPath, [cli, 'power', 'report', '--budgets', d.budgets, ...w, '--json'])).stdout).power;
  assert.ok(rep.groups.find(g => g.group === 'rack:r1').headroomKw < 0);
  const pr = JSON.parse((await run(process.execPath, [cli, 'power', 'predict', '--cap', '70%', ...w, '--json'])).stdout).jobs;
  assert.equal(pr[0].job, 'embed'); assert.equal(pr.at(-1).job, 'pretrain-13b', 'sorted by slowdown');
  assert.match((await run(process.execPath, [cli, 'power', 'fit', '--store', st])).stdout, /limit\^0\.4/);
  const pl = JSON.parse((await run(process.execPath, [cli, 'power', 'plan', '--budgets', d.budgets, '--out', path.join(dir, 'plan.json'), ...w, '--json'])).stdout);
  assert.equal(pl.queued.length, 1); assert.ok(fs.existsSync(path.join(dir, 'plan.json')));
});
