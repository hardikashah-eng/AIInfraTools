// Agent unit economics: cost per resolved task, fixes ranked by what they save per resolved task, exact step caps from
// each session's own calls, and self-hosting vs the API (sized with the Inference Sizer, or at measured prices).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from '../src/record.mjs';
import { ledger } from '../src/ledger.mjs';
import { economics, economicsText, exactCaps, breakEven, busiestDay, typicalDay, period, scaleStats, sizerSettings, gpusFor, rankFixes } from '../src/economics.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'harness-ledger.mjs');
const PRICES = { asOf: 'test', currency: 'USD', models: { big: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } } };

// sessions of an agent loop: a growing prompt read from cache, one call per step; `pause` puts a gap past the cache
// lifetime before step 3 (a cache-expired miss)
function session(id, steps, { t0 = 1_800_000_000, gap = 20, outcome, pause = false } = {}) {
  const out = []; let t = t0, ctx = 8000;
  for (let i = 0; i < steps; i++) {
    if (pause && i === 3) t += 900;
    const miss = i === 0 || (pause && i === 3);
    out.push(call({ t, harness: 'test', session: id, id: `${id}-${i}`, model: 'big', input: ctx, cacheRead: miss ? 0 : ctx - 600, cacheWrite: miss ? ctx : 600, output: 300, durS: 5, outcome }));
    ctx += 900; t += gap;
  }
  return out;
}

test('cost per resolved task and fixes ranked by what they save per resolved task', () => {
  const calls = [...session('a', 8, { outcome: 'success' }), ...session('b', 8, { outcome: 'success', pause: true, t0: 1_800_000_500 }), ...session('c', 30, { outcome: 'failure', pause: true, t0: 1_800_001_000 })];
  const r = ledger(calls, { prices: PRICES }), E = economics(r.calls, r.report, { days: 1 });
  assert.equal(E.perResolved.successes, 2); assert.equal(E.perResolved.failures, 1);
  assert.ok(Math.abs(E.perResolved.costPerResolved - r.report.totals.cost / 2) < 1e-9);
  assert.ok(E.perResolved.failShare > 0.5, 'the long failed session dominates the spend');
  const exp = E.fixes.rows.find(f => f.cause === 'cache-expired'); assert.ok(exp, 'the pauses show up as a fix');
  assert.ok(Math.abs(exp.perResolved - exp.saves / 2) < 1e-12);
  for (let i = 1; i < E.fixes.rows.length; i++) assert.ok(E.fixes.rows[i - 1].saves >= E.fixes.rows[i].saves, 'ranked');
  const last = E.fixes.rows.at(-1); assert.ok(last.cumulative <= r.report.totals.cost + 1e-9); assert.ok(last.costPerResolvedAfter >= 0);
  const cap = E.fixes.rows.find(f => f.cause === 'step-cap'); assert.ok(cap && cap.lostPts === 0, 'capping at a step count above the successes costs none of them');
  assert.match(economicsText(E), /per resolved task/);
});

test('exact step caps: the cost of each session\'s first N calls, and the successes that needed more', () => {
  const calls = [...session('ok', 5, { outcome: 'success' }), ...session('long-ok', 25, { outcome: 'success', t0: 1_800_010_000 }), ...session('fail', 40, { outcome: 'failure', t0: 1_800_020_000 })];
  for (const c of calls) c.cost = 1; // one unit per call makes the arithmetic visible
  const caps = exactCaps(calls, [10, 30]);
  assert.deepEqual(caps.map(c => [c.cap, +(c.saved).toFixed(4), c.successesLost]), [[10, +(1 - (5 + 10 + 10) / 70).toFixed(4), 1], [30, +(1 - (5 + 25 + 30) / 70).toFixed(4), 0]]);
  assert.equal(caps[1].costPerResolved, 30);
  assert.equal(exactCaps(calls.map(c => ({ ...c, outcome: undefined }))), null, 'no outcomes, no caps');
});

test('break-even: the GPU-hour price where both cost the same per resolved task', () => {
  assert.equal(breakEven({ apiMonthly: 730, gpus: 1 }).breakEvenGpuRate, 1);
  const q = breakEven({ apiMonthly: 730, gpus: 1, apiRate: 0.8, selfRate: 0.4 });
  assert.equal(q.qualityRatio, 0.5); assert.equal(q.breakEvenGpuRate, 0.5, 'half the successes: half the GPU price to break even');
  const b = breakEven({ apiMonthly: 1000, gpus: 2, gpuRate: 0.5 }); assert.equal(b.selfMonthly, 730); assert.equal(b.cheaper, 'self-host');
  assert.equal(breakEven({ apiMonthly: 100, gpus: 2, gpuRate: 0.5, unit: 3 }).apiMonthly, 300, 'relative units at a price per unit');
});

test('busiest and typical days, period, scaling', () => {
  const rows = [];
  for (let d = 0; d < 5; d++) for (let i = 0; i < (d === 2 ? 50 : 10); i++) rows.push({ t: d * 86400 + i * 60, isl: 1000, osl: 100, session: `s${d}` });
  assert.equal(busiestDay(rows).length, 50); assert.equal(typicalDay(rows).length, 10);
  assert.equal(period([{ t: 0 }, { t: 3 * 86400 }]).days, 3); assert.ok(period([{ t: 0 }, { t: 3600 }]).short);
  const st = { rps: { p95: 2, mean: 1 }, kvTokens: { p95: 1000 }, inflight: { p95: 3 }, prefillTps: { p95: 10 }, decodeTps: { p95: 5 }, isl: { mean: 1 } };
  const x = scaleStats(st, 4); assert.equal(x.rps.p95, 8); assert.equal(x.kvTokens.p95, 4000); assert.equal(x.inflight.p95, 12); assert.equal(x.isl.mean, 1, 'shape unchanged');
});

test('self-hosting sized with the Inference Sizer: GPUs grow with volume, never shrink, and a cheap enough GPU wins', () => {
  const calls = []; for (let s = 0; s < 40; s++) calls.push(...session(`s${s}`, 12, { outcome: s % 5 ? 'success' : 'failure', t0: 1_800_000_000 + s * 300 }));
  const r = ledger(calls, { prices: PRICES }), base = { model: 'qwen3-32b', gpu: 'H100', days: 1 };
  const E = economics(r.calls, r.report, base), S = E.selfHost;
  assert.ok(S.gpus >= 8, 'whole nodes'); assert.equal(S.successRates.assumed, true); assert.ok(S.breakEvenGpuRate > 0);
  const s = sizerSettings(base), st = { rps: { p95: 0.5 }, isl: { mean: 9000, p99: 20000 }, osl: { mean: 300, p99: 300 }, cacheHit: 0.9, kvTokens: { p95: 200000 }, inflight: { p95: 4 }, prefillTps: { p95: 1 }, decodeTps: { p95: 1 } };
  let prev = 0; for (const x of [1, 4, 16, 64, 256]) { const g = gpusFor(st, s, x).gpus; assert.ok(g >= prev, `${x}×: ${g} < ${prev}`); prev = g; }
  const ds = o => gpusFor(st, sizerSettings({ model: 'deepseek-v3', gpu: 'H200', ...o }), 1).gpus;
  assert.ok(ds({ spare: false }) < ds({}), 'the spare node is optional (a model that fills a node needs a whole spare one)');
  const cheap = economics(r.calls, r.report, { ...base, gpuRate: S.breakEvenGpuRate * 0.5 }).selfHost, dear = economics(r.calls, r.report, { ...base, gpuRate: S.breakEvenGpuRate * 2 }).selfHost;
  assert.equal(cheap.cheaper, 'self-host'); assert.equal(dear.cheaper, 'api');
  assert.ok(dear.volume.from == null || dear.volume.from > 1, 'at twice the break-even price it takes more volume to win');
  const worse = economics(r.calls, r.report, { ...base, selfSuccessRate: 0.4 }).selfHost; assert.ok(worse.breakEvenGpuRate < S.breakEvenGpuRate, 'a weaker model must be cheaper to break even');
  const more = economics(r.calls, r.report, { ...base, tokenScale: 20 }).selfHost; assert.ok(more.gpus >= S.gpus, 'more calls per task: at least as many GPUs');
  assert.match(economicsText(E), /break-even: self-hosting is cheaper per resolved task below \$/);
});

test('self-hosting at measured prices (OpenCost\'s cost per million tokens)', () => {
  const calls = session('a', 10, { outcome: 'success' }), r = ledger(calls, { prices: PRICES });
  const cheap = economics(r.calls, r.report, { days: 1, selfHostPrice: { input: 0.3, cacheRead: 0, output: 1.5 } }).selfHost;
  const dear = economics(r.calls, r.report, { days: 1, selfHostPrice: { input: 30, cacheRead: 3, output: 150 } }).selfHost;
  assert.equal(cheap.cheaper, 'self-host'); assert.equal(dear.cheaper, 'api'); assert.ok(cheap.perResolvedRatio < 1 && dear.perResolvedRatio > 1);
});

test('CLI: economics --demo (text and JSON) and with a self-hosted model', () => {
  const run = a => spawnSync(process.execPath, [CLI, 'economics', ...a], { encoding: 'utf8' });
  const t = run(['--demo']); assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /per resolved task/); assert.match(t.stdout, /Fixes, ranked/);
  const j = JSON.parse(run(['--demo', '--json', '--days', '30', '--self-host-model', 'qwen3-32b', '--gpu', 'H100', '--gpu-rate', '2']).stdout);
  assert.equal(j.selfHost.model, 'qwen3-32b'); assert.ok(j.selfHost.gpus > 0); assert.equal(j.volume.days, 30); assert.ok(j.fixes.rows.length > 0);
  const bad = run(['--demo', '--self-host-model', 'nope']); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /unknown model nope/);
});

test('rankFixes keeps model-tier changes apart as candidates', () => {
  const report = { totals: { cost: 10 }, outcomes: { successes: 2 }, byCause: [{ cause: 'cache-miss', label: 'm', cost: 3, candidate: false, fix: 'x' }, { cause: 'model-tier', label: 't', cost: 4, candidate: true, fix: 'y' }] };
  const f = rankFixes(report, []); assert.deepEqual(f.rows.map(r => r.cause), ['cache-miss']); assert.deepEqual(f.candidates.map(r => r.cause), ['model-tier']); assert.equal(f.rows[0].perResolved, 1.5);
});
