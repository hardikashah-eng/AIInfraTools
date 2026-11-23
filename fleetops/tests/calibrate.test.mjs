import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DataStore } from '../src/store.mjs';
import * as Calib from '../src/calibrate.mjs';

const require = createRequire(import.meta.url);
const E = require('../../fleetscope/src/engine.js'), Cal = require('../../fleetscope/src/calibrate.js'), TP = require('../../fleetscope/src/templates.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-cal-'));

// An MLPerf-style server run (the numbers have the shape of a real 8×H200 Llama 2 70B result).
const H200 = { t: 1, source: 'mlperf', submitter: 'NVIDIA', system: 'H200-SXM-141GBx8_TRT', gpu: 'H200', gpus: 8, model: 'llama2-70b-99', scenario: 'Server',
  qps: 114.24, samplesPerS: 113.04, tokPerS: 33071, oslMean: 292.6, ttftP50: 0.359, ttftP99: 0.938, tpotP50: 0.173, tpotP99: 0.182, ttftLimit: 2, tpotLimit: 0.2 };

test('calibrate: benchmark model names map to each tool\'s catalog', () => {
  assert.equal(Calib.modelFor('llama2-70b-99', 'fleetscope'), 'llama-70b');
  assert.equal(Calib.modelFor('llama2-70b-interactive-99', 'sizer'), 'llama33-70b');
  assert.equal(Calib.modelFor('mixtral-8x7b', 'sizer'), null);
});

test('calibrate: the sizer is fitted to the GPUs a measured system used, within physical ceilings', () => {
  const f = Calib.fitSizer(H200, { islMean: 300 });
  assert.equal(f.measuredGpus, 8);
  assert.ok(f.before > 8, `spec-sheet efficiencies over-provision (${f.before})`);
  assert.equal(f.after, 8); assert.equal(f.errAfter, 0); assert.ok(f.reached);
  for (const [k, v] of Object.entries(f.eff)) assert.ok(v <= Calib.EFF_CAP[k] + 1e-9, `${k} ${v} within its ceiling`);
  const chk = Calib.checkSizer(H200, f.eff, { islMean: 300 });
  assert.equal(chk.predicted, 8);
  assert.match(Calib.fitSizer(Object.assign({}, H200, { gpu: 'Z9' })).error, /not in the sizer/);
});

test('calibrate: benchmark runs over a store, interactive runs held out, profile for the sizer', () => {
  const s = new DataStore(tmp());
  s.append('benchmark', [H200, Object.assign({}, H200, { model: 'llama2-70b-interactive-99', qps: 67.2, oslMean: 289, ttftP50: 0.098, ttftP99: 0.363, tpotP50: 0.034, tpotP99: 0.036, ttftLimit: 0.45, tpotLimit: 0.04 })]);
  const r = Calib.calibrateBenchmarks(s, { islMean: 300, fleetscope: false, now: 100 });
  assert.equal(r.runs.length, 1); assert.equal(r.heldOut.length, 1);
  const p = r.profile.sizer['H200|llama33-70b'];
  assert.ok(p && p.effPrefill > 0.4 && p.fitOn.includes('H200'));
  assert.equal(r.records[0].target, 'sizer:H200|llama33-70b');
  const h = r.heldOut[0];
  assert.ok(Number.isFinite(h.sizerSpecSheet.predicted) && Number.isFinite(h.sizerCalibrated.predicted), 'both models give a GPU count for the held-out run');
});

// Serving records produced by FleetScope itself with known multipliers: the fit must find them again.
function servingFromTruth(truth, n = 4) {
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  Object.assign(g.nodes.find(x => x.id === 'on').cfg, { instances: 4, autoscale: false });
  const lookup = (k, sc) => E.scaleTrace(E.genTrace(k, 7), sc || 1, 7);
  const c = E.compileGraph(g, lookup);
  const load = { rate: 3, windowS: 600, islMean: 1500, oslMean: 250 };
  const base = Cal.benchSpec(c.spec, 'on', load, { instances: 4, maxS: 300 });
  base.pools.find(p => p.id === 'on').calib = truth;
  const m = Cal.measure(E.simulate(base), 'on');
  const recs = Array.from({ length: n }, (_, i) => ({ t: 1000 + i * 600, pool: 'On-prem H100', windowS: 600, rate: load.rate, islMean: load.islMean, oslMean: load.oslMean,
    ttftP50: m.ttftP50, ttftP99: m.ttftP99, tpotP50: m.tpotP50, tpotP99: m.tpotP99, source: 'test' }));
  return { graph: g, recs, m };
}

test('calibrate: serving records → per-pool multipliers that pass, held-out check, apply to graph, drift', () => {
  const truth = { prefill: 1.6, decode: 1.3 };
  const { graph, recs } = servingFromTruth(truth);
  const s = new DataStore(tmp());
  s.append('serving', recs);
  const r = Calib.calibrateServing(s, graph, { holdout: 0.25, now: 5000 });
  const on = r.pools.find(p => p.pool === 'on');
  assert.ok(on.pass, `fit passes the 10%/20% bar: ${JSON.stringify(on.after)}`);
  assert.ok(Math.abs(on.calib.decode - truth.decode) / truth.decode < 0.15, `decode ${on.calib.decode} near ${truth.decode}`);
  assert.ok(on.heldOut && on.heldOut.pass, 'held-out window predicted within the bar');
  assert.equal(r.pools.find(p => p.pool === 'neo').skipped, 'no serving records');
  const applied = Calib.applyToGraph(graph, r.profile);
  assert.deepEqual(applied.applied, ['on']);
  assert.equal(applied.graph.nodes.find(n => n.id === 'on').cfg.calibDecode, on.calib.decode);
  // no drift on the same data; drift when latency doubles
  assert.equal(Calib.driftCheck(s, graph, r.profile, { now: 6000 })[0].drifted, false);
  const s2 = new DataStore(tmp());
  s2.append('serving', recs.map(x => Object.assign({}, x, { t: x.t + 86400, tpotP50: x.tpotP50 * 2, tpotP99: x.tpotP99 * 2 })));
  const d = Calib.driftCheck(s2, graph, r.profile, { now: 99999 })[0];
  assert.equal(d.drifted, true); assert.match(d.why, /TPOT p\d\d measured .* re-fit/);
});
