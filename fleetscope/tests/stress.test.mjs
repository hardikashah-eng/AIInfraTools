import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const TP = require('../src/templates.js');

const cache = {};
const lookup = (k, s) => E.scaleTrace(cache[k] || (cache[k] = E.genTrace(k, 7)), s || 1, 7);
const graph = (id, edit) => { const g = TP.TEMPLATES.find(t => t.id === id).build(); if (edit) edit(g); return g; };
const spec = (id, edit) => { const c = E.compileGraph(graph(id, edit), lookup); assert.deepEqual(c.errors, []); return c.spec; };
const node = (g, id) => g.nodes.find(n => n.id === id);

test('peak load surge multiplies requests inside its window only', () => {
  const base = E.simulate(spec('burst'));
  const st = E.simulate(spec('burst'), { surge: { mult: 3, start: 120, dur: 120 } });
  const inWin = r => r.t >= 120 && r.t < 240.5;
  const b = base.reqs.filter(inWin).length, s = st.reqs.filter(inWin).length;
  assert.ok(s / b > 2.7 && s / b < 3.3, `ratio ${s / b}`);
  assert.equal(st.reqs.filter(r => r.t < 100).length, base.reqs.filter(r => r.t < 100).length);
  assert.equal(st.summary.surgeRequests, s - b);
});

test('peak sessions add users who stop starting turns when the window ends', () => {
  const base = E.simulate(spec('agent'));
  const st = E.simulate(spec('agent'), { surge: { mult: 2, start: 60, dur: 180, target: 'sessions' } });
  assert.equal(st.summary.users, base.summary.users * 2);
  const late = st.reqs.filter(r => r.surge && r.t >= 240);
  assert.ok(st.reqs.some(r => r.surge), 'surge users issue requests');
  assert.equal(late.filter(r => r.t > 240 + 1).length, 0, 'no surge turns start after the window');
});

test('large contexts scale prompt size', () => {
  const mean = r => r.reqs.reduce((s, q) => s + q.isl, 0) / r.reqs.length;
  const a = E.simulate(spec('burst')), b = E.simulate(spec('burst'), { ctx: { mult: 2 } });
  assert.ok(Math.abs(mean(b) / mean(a) - 2) < 0.05);
});

test('partial outage drops instances, loses in-flight streams, then recovers', () => {
  const r = E.simulate(spec('burst'), { outages: [{ target: 'on', fraction: 0.5, start: 120, dur: 120, recovery: 30 }] });
  assert.equal(r.frames[130].pools.on.down, 2);
  assert.equal(r.frames[100].pools.on.down, 0);
  assert.equal(r.frames[260].pools.on.down, 0);
  assert.equal(r.frames[300].pools.on.serving, 4, 'all four instances serve again after recovery');
  assert.ok(r.summary.lost > 0);
  assert.equal(r.summary.completed + r.summary.dropped, r.summary.requests);
  assert.ok(r.reqs.filter(q => q.failKind === 'outage').every(q => q.t < 120.1), 'only requests in flight at the failure are lost');
  const down = r.summary.bottleneck.top.find(x => x.kind === 'down');
  assert.ok(down && down.first >= 120 && down.first < 240, 'the outage is attributed inside its window');
});

test('routers steer around a link that is down', () => {
  const r = E.simulate(spec('multi'), { outages: [{ target: 'lka', fraction: 1, start: 100, dur: 200 }] });
  assert.equal(r.frames[150].links.lka.factor, 0);
  const viaA = r.reqs.filter(q => q.t > 101 && q.t < 300 && q.pPool === 'neoa');
  assert.equal(viaA.length, 0);
});

test('a neocloud site outage removes its headroom', () => {
  const a = E.simulate(spec('agent')).summary;
  const b = E.simulate(spec('agent'), { outages: [{ target: 'site:Neocloud A', fraction: 1 }] }).summary;
  assert.ok(b.peakGpus < a.peakGpus);
  assert.ok(b.slo < a.slo);
});

test('headroom search brackets the breaking point', () => {
  const s = spec('burst', g => { node(g, 'on').cfg.instances = 10; });
  const h = E.findHeadroom(s, { kind: 'load', target: 0.95, lo: 0.5, hi: 4, iters: 5 });
  assert.ok(h.limit >= 0.5 && h.failsAt > h.limit, JSON.stringify(h));
  const at = r => h.runs.find(x => x.mult === r);
  assert.ok(at(h.limit).slo >= 0.95 && at(h.failsAt).slo < 0.95);
  assert.ok(h.breaksOn && h.breaksOn.label);
});

test('fleet sizing finds the smallest scale that meets the target', () => {
  const s = spec('burst');
  const z = E.sizeFleet(s, { target: 0.95, iters: 5 });
  assert.ok(z.meets && z.at.slo >= 0.95);
  assert.ok(z.runs.some(r => r.factor < z.at.factor && r.slo < 0.95), 'a smaller fleet misses the target');
});

test('reasoning: thinking tokens delay the visible answer unless thinking is streamed', () => {
  const think = (streamed) => E.simulate(spec('burst', g => {
    node(g, 'on').cfg.instances = 8;
    node(g, 'model').cfg.thinkTokens = 1000;
    node(g, 'slo').cfg.thinkingStreamed = streamed;
  })).summary;
  const plain = E.simulate(spec('burst', g => { node(g, 'on').cfg.instances = 8; })).summary;
  const hidden = think(false), shown = think(true);
  assert.ok(hidden.thinkShare > 0.5, `thinking share ${hidden.thinkShare}`);
  assert.ok(hidden.ttftP50 > plain.ttftP50 * 5, 'hidden thinking pushes back the first visible token');
  assert.ok(shown.ttftP50 < hidden.ttftP50, 'streamed thinking counts as the first token');
  assert.ok(hidden.costPerKReq > plain.costPerKReq);
});

test('model advisor ranks candidates that meet the SLO by cost and honours a quality floor', () => {
  const s = spec('burst', g => { node(g, 'on').cfg.instances = 6; });
  const cands = [{ key: 'llama-8b' }, { key: 'llama-70b' }];
  const a = E.adviseModels(s, { target: 0.95, iters: 4, candidates: cands });
  assert.equal(a.rows.length, 2);
  assert.ok(a.pick && a.pick.meets);
  assert.equal(a.pick.key, 'llama-8b', 'the smaller model is cheaper at the same SLO');
  const q = E.adviseModels(s, { target: 0.95, iters: 4, candidates: cands, quality: { 'llama-8b': 60, 'llama-70b': 80 }, minQuality: 70 });
  assert.equal(q.pick.key, 'llama-70b');
  assert.ok(q.rows.find(r => r.key === 'llama-8b').belowQuality);
});
