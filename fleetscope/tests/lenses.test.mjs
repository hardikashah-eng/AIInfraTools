import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const TP = require('../src/templates.js');

const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
const spec = id => E.compileGraph(TP.TEMPLATES.find(t => t.id === id).build(), lookup).spec;
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('cost lens adds up to the run cost', () => {
  const R = E.simulate(spec('multi'));
  const C = E.costBreakdown(R, 0, R.D);
  close(C.total, R.summary.cost, 1e-6);
  assert.ok(C.idle > 0 && C.idle < C.total);
  close(C.bySite.onprem + C.bySite.neo + C.egress, C.total, 1e-6);
  const w = E.costBreakdown(R, 100, 110);
  assert.equal(w.seconds, 10);
  assert.ok(w.total < C.total);
});

test('cost lens counts training spend and its egress', () => {
  const R = E.simulate(spec('train'));
  const C = E.costBreakdown(R, 0, R.D);
  const train = C.nodes[R.spec.train.id];
  close(train.spend, R.summary.train.gpuCostPerHr * R.D / 3600, 1e-6);
  assert.ok(C.nodes.lk.trainEgress > 0, 'split training pays egress for gradient sync');
});

test('latency lens splits mean TTFT across nodes', () => {
  const R = E.simulate(spec('xpd'));
  const L = E.latencyBreakdown(R, 0, R.D);
  const done = R.reqs.filter(q => isFinite(q.ttft));
  close(L.meanTtft, done.reduce((a, q) => a + q.ttft, 0) / done.length, 1e-9);
  let share = 0;
  for (const id in L.nodes) if (L.nodes[id].kind !== 'source') share += L.nodes[id].share;
  close(share, 1, 1e-6);
  assert.ok(L.nodes.lk.parts.transfer > 0, 'KV transfers are charged to the link');
  assert.ok(L.nodes.pre.share > L.nodes.dec.share);
});

test('reliability lens ranks the failure that hurts most first', () => {
  const B = E.blastRadius(spec('multi'));
  assert.equal(B.rows[0].id, 'on');
  assert.ok(B.rows[0].dSlo < -0.3);
  const cloudA = B.rows.find(r => r.id === 'neoa'), linkA = B.rows.find(r => r.id === 'lka');
  close(cloudA.dSlo, linkA.dSlo, 0.05);
  const D = E.blastRadius(spec('disagg'));
  for (const r of D.rows) assert.ok(r.failedShare > 0.9, 'losing either half of a P/D pair stops all serving');
});

test('health marks an outage on the failed pool', () => {
  const R = E.simulate(spec('burst'), { outages: [{ target: 'on', fraction: 0.5, start: 100, dur: 120 }] });
  const H = E.healthOf(R);
  assert.equal(H.lvl.on[150], 2);
  assert.equal(H.cause.on[150], 'down');
  assert.ok(H.sum.on.crit > 100);
});
