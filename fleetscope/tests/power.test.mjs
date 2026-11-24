import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), TP = require('../src/templates.js');
const cache = {}, lookup = (k, s) => E.scaleTrace(cache[k] || (cache[k] = E.genTrace(k, 7)), s || 1, 7);
const here = path.dirname(fileURLToPath(import.meta.url));

function runWith(caps = {}, power = {}) {
  const g = TP.TEMPLATES.find(t => t.id === 'disagg').build(); g.power = power;
  for (const n of g.nodes) if (n.type === 'pool' && caps[n.cfg.role] != null) n.cfg.powerCapPct = caps[n.cfg.role];
  const c = E.compileGraph(g, lookup); assert.deepEqual(c.errors, []);
  const R = E.simulate(c.spec, null); return { R, s: R.summary, p: E.powerBreakdown(R) };
}

test('a cap slows compute-bound prefill more than memory-bound decode', () => {
  const P = E.profile('H100', { params: 70.6, active: 70.6, layers: 80, kvHeads: 8, headDim: 128, mla: 0 }), C = E.capped(P, 60);
  assert.ok(Math.abs(C.prefill / P.prefill - Math.pow(0.6, E.POWER.ALPHA_COMPUTE)) < 1e-9);
  assert.ok(C.a / P.a < 1.05, 'reading weights barely slows'); assert.ok(C.b0 / P.b0 > 1.15);
  assert.equal(E.capped(P, 100), P); assert.equal(E.capped(P, 10).cap.pct, E.POWER.minCap, 'caps have a floor');
  const custom = E.capped(P, 60, { compute: 0.5 }); assert.ok(custom.prefill < C.prefill, 'a fitted exponent is used');
});

test('power per pool and site; a decode cap saves power for free, a prefill cap costs TTFT', () => {
  const base = runWith({}, { sites: { 'On-prem DC': { budgetKw: 6 } } }), dec = runWith({ decode: 60 }), pre = runWith({ prefill: 60 });
  const site = Object.values(base.p.sites)[0];
  assert.ok(site.itKwPeak > 0 && site.budgetKw === 6); assert.ok(site.overBudgetS > 0, 'over a 6 kW budget at peak');
  for (const p of Object.values(base.p.pools)) assert.ok(p.itKwPeak >= p.itKwAvg && p.itKwAvg > 0);
  assert.ok(base.p.tokensPerMWh > 0);
  assert.ok(dec.p.facilityKWh < base.p.facilityKWh); assert.ok(dec.p.tokensPerMWh > base.p.tokensPerMWh);
  assert.ok(Math.abs(dec.s.slo - base.s.slo) < 0.02, 'decode cap: SLO unchanged');
  assert.ok(pre.s.ttftP99 > base.s.ttftP99 * 1.2, 'prefill cap: TTFT p99 rises');
});

test('CLI: fleetscope power with caps and budgets', () => {
  const out = JSON.parse(execFileSync(process.execPath, [path.join(here, '..', 'tools', 'fleetscope.mjs'), 'power', '--template', 'disagg', '--cap', 'Decode H100=60', '--budget', 'On-prem DC=6', '--json'], { encoding: 'utf8' }));
  assert.ok(out.capped && out.base); assert.ok(out.capped.facilityKWh < out.base.facilityKWh);
  assert.equal(Object.values(out.capped.sites)[0].budgetKw, 6);
});
