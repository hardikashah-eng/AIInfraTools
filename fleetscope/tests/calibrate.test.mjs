import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), TP = require('../src/templates.js'), K = require('../src/calibrate.js'), T = require('../src/training.js');
const fx = f => readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
const spec = () => E.compileGraph(TP.TEMPLATES.find(t => t.id === 'burst').build(), lookup).spec;
// The fixtures were generated from the on-prem pool running 25% slower prefill and 30% slower decode than its spec sheet.
const TRUTH = { prefill: 0.75, decode: 1.3 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) / b <= tol, `${a} vs ${b}`);

test('calibration multipliers change the profile', () => {
  const P = E.profile('H100', E.MODELS['llama-70b']), C = E.calibrated(P, { prefill: 0.5, decode: 2 });
  assert.equal(C.prefill, P.prefill * 0.5); assert.equal(C.a, P.a * 2); assert.equal(C.c, P.c * 2);
  assert.equal(E.calibrated(P, null), P);
});

test('Prometheus histograms give quantiles', () => {
  const q = K.histQuantiles([{ le: 1, count: 50 }, { le: 2, count: 100 }, { le: Infinity, count: 100 }], [0.5, 0.75]);
  assert.equal(q.q[0.5], 1); assert.equal(q.q[0.75], 1.5);
  const m = K.fromVllmMetrics(fx('vllm-metrics.prom'), { windowS: 600 });
  assert.equal(m.requests, 3613); assert.ok(m.ttftP50 > 0.2 && m.ttftP50 < 0.35); assert.ok(m.tpotP50 > 0.03 && m.tpotP50 < 0.045);
  near(m.rate, 6, 0.05);
});

test('fitting to a vLLM /metrics snapshot recovers the hidden slowdown', () => {
  const f = K.fitPool(spec(), 'on', K.fromVllmMetrics(fx('vllm-metrics.prom'), { windowS: 600 }), { instances: 4 });
  near(f.calib.prefill, TRUTH.prefill, 0.08); near(f.calib.decode, TRUTH.decode, 0.08);
  assert.ok(f.acceptance.pass); assert.ok(!f.acceptanceBefore.pass);
});

test('fitting to a benchmark_serving result recovers it too', () => {
  const b = K.fromBenchmark(fx('benchmark-result.json'));
  assert.equal(b.isl.length, 500);
  const f = K.fitPool(spec(), 'on', b, { instances: 4 });
  near(f.calib.prefill, TRUTH.prefill, 0.08); near(f.calib.decode, TRUTH.decode, 0.08);
  assert.ok(f.acceptance.pass);
});

test('fitting to a recorded trace in the graph uses the graph as drawn', () => {
  // record a trace from the true (slower) pool in a healthy window, then fit the uncalibrated graph to it
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build(); g.nodes.find(n => n.id === 'src').cfg.trace = 'steady';
  const s = E.compileGraph(g, lookup).spec;
  const truth = JSON.parse(JSON.stringify(s)); truth.pools.find(p => p.id === 'on').calib = TRUTH;
  const R = E.simulate(truth);
  s.sources[0].trace = R.reqs.filter(q => isFinite(q.ttft) && isFinite(q.tFinish)).map(q => ({ t: q.t, isl: q.isl, osl: q.osl, cached: q.cached, ttft: q.ttft, e2e: q.tFinish - q.t }));
  s.sources[0].useRecordedCache = true;
  const target = K.recordedTarget(E.simulate(s), 'on');
  const f = K.fitPool(s, 'on', target, { useSpec: true });
  near(f.calib.decode, TRUTH.decode, 0.08); near(f.calib.prefill, TRUTH.prefill, 0.1);
  assert.equal(f.diagnosis, 'fit');
});

test('when the graph lacks capacity, calibration says so instead of forcing a fit', () => {
  const s = E.compileGraph(TP.TEMPLATES.find(t => t.id === 'replay').build(), lookup).spec;
  const f = K.fitPool(s, 'on', K.recordedTarget(E.simulate(s), 'on'), { useSpec: true, iters: 6 });
  assert.ok(!f.acceptance.pass);
  assert.equal(f.diagnosis, 'capacity');
});

test('training: step timings fit kernel efficiency and overlap; fault logs give a rate', () => {
  const meas = K.parseStepLog(fx('step-timings.csv'));
  assert.equal(meas.steps, 200); near(meas.computeS, 30, 0.02);
  const fit = K.fitTraining(T, {}, meas);
  near(fit.after.busy, meas.computeS, 0.02);
  near(fit.after.sync, meas.commS, 0.05);
  const log = T.parseFaultLog('timestamp,hostname,gpu,xid\n2026-11-01T00:00:00Z,a,1,79\n2026-11-11T00:00:00Z,b,2,79\n2026-11-21T00:00:00Z,a,1,48');
  const r = K.faultRate(log, 100);
  near(r.perGpuDay, 3 / (100 * 20), 0.01);
});
