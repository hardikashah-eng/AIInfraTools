// The sizer against measured InferenceX runs (real data, fetched with git at a pinned commit and checked by SHA-256),
// and the operating-point model those checks use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fetchData, run, usable, predict } from '../tools/validate-inferencex.mjs';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js');

test('operating point: TPOT and throughput per GPU rise with concurrency, all finite', () => {
  const s = Object.assign({}, M.SETTINGS, C.MODELS.find(m => m.id === 'deepseek-v3'), C.GPUS.find(g => g.id === 'H200'), { wprec: 'fp8', avgIn: 1024, peakIn: 1024, avgOut: 1024, peakOut: 1024, ctx: 2048 });
  const md = M.derive(s), c = { g: 8, kind: 'TPEP', pp: 1, tpl: 8 };
  const pts = [1, 4, 16, 64, 256].map(B => M.operatingPoint(s, md, c, B));
  for (const p of pts) for (const k of ['tpot', 'ttft', 'outPerGpu']) assert.ok(Number.isFinite(p[k]) && p[k] > 0, k);
  for (let i = 1; i < pts.length; i++) { assert.ok(pts[i].tpot >= pts[i - 1].tpot); assert.ok(pts[i].outPerGpu >= pts[i - 1].outPerGpu * 0.99); }
});

let rows = null, why = '';
try { rows = fetchData(); } catch (e) { why = `InferenceX snapshot not reachable: ${e.message.split('\n')[0]}`; }

test('real data (InferenceX): the snapshot is the pinned one and has enough runs the sizer can model', { skip: !rows && why }, () => {
  assert.equal(rows.length, 435);
  const u = usable(rows);
  assert.ok(u.length >= 120, `${u.length} usable runs`);
  assert.ok(u.every(r => Number.isFinite(predict(r).tpot)));
});

test('real data (InferenceX): defaults beat the datasheet roofline; calibrating on one shape carries to the others', { skip: !rows && why }, () => {
  const R = run(rows), o = R.overall;
  assert.ok(o.roofline.tpot.median > 2 * o.defaults.tpot.median, 'a datasheet roofline is far worse than the sizer');
  // defaults are optimistic on this data (DeepSeek-R1): faster tokens and more throughput than measured
  assert.ok(o.defaults.tpot.bias < 1 && o.defaults.thr.bias > 1);
  assert.ok(o.defaults.tpot.median < 0.6 && o.defaults.thr.median < 0.6, JSON.stringify(o.defaults));
  // fitted on the 1k/1k runs, scored only on 8k/1k and 1k/8k
  assert.ok(R.test >= 60);
  assert.ok(o.calibratedTest.tpot.median < 0.2 && o.calibratedTest.thr.median < 0.2, JSON.stringify(o.calibratedTest));
  assert.ok(o.calibratedTest.thr.median < o.defaultsTest.thr.median / 2);
});
