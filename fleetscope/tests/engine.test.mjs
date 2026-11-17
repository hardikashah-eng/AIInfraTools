import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const TP = require('../src/templates.js');

const traceCache = {};
const lookup = (key, scale) => E.scaleTrace(traceCache[key] || (traceCache[key] = E.genTrace(key, 7)), scale || 1, 7);
const runTemplate = id => {
  const g = TP.TEMPLATES.find(t => t.id === id).build();
  const c = E.compileGraph(g, lookup);
  assert.deepEqual(c.errors, [], `${id} should compile without errors`);
  return E.simulate(c.spec);
};

test('every template except the blank canvas compiles and runs', () => {
  for (const t of TP.TEMPLATES) {
    const c = E.compileGraph(t.build(), lookup);
    if (t.id === 'blank') { assert.ok(c.errors.length > 0, 'blank canvas has nothing to run'); continue; }
    assert.deepEqual(c.errors, [], t.id);
    const r = E.simulate(c.spec);
    assert.ok(r.D > 0, `${t.id} produced frames`);
    assert.equal(r.frames.length, r.D);
  }
});

test('runs are deterministic for the same graph', () => {
  const a = runTemplate('agent').summary, b = runTemplate('agent').summary;
  const strip = s => { const { simMs, ...rest } = s; return rest; };
  assert.deepEqual(strip(a), strip(b));
});

test('request timelines are causally ordered', () => {
  for (const id of ['burst', 'xpd', 'disagg']) {
    const r = runTemplate(id);
    for (const q of r.reqs) {
      if (q.fail || !isFinite(q.tFinish)) continue;
      assert.ok(q.ttft >= 0, `${id} #${q.id} TTFT is negative`);
      assert.ok(q.tAdmit >= q.tEnq - 1e-9, `${id} #${q.id} admitted before it was queued`);
      assert.ok(q.tPrefEnd >= q.tAdmit - 1e-9, `${id} #${q.id} prefill ended before admission`);
      assert.ok(q.tFinish >= q.tFirst - 1e-9, `${id} #${q.id} finished before first token`);
      if (q.dPool !== q.pPool) assert.ok(q.tXferEnd >= q.tPrefEnd, `${id} #${q.id} KV arrived before prefill ended`);
    }
  }
});

test('every request is accounted for', () => {
  const r = runTemplate('burst');
  assert.equal(r.summary.completed + r.summary.dropped, r.summary.requests);
});

test('cross-site prefill/decode moves KV over the link; aggregated serving does not', () => {
  const x = runTemplate('xpd').summary, b = runTemplate('burst').summary;
  assert.ok(x.crossGB > 100, `expected terabyte-scale KV traffic, got ${x.crossGB} GB`);
  assert.ok(b.crossGB < 1, `aggregated burst should move little data, got ${b.crossGB} GB`);
});

test('a training job split across sites waits on gradient sync; an on-prem one barely does', () => {
  const split = runTemplate('train').summary.train;
  assert.ok(split.commShare > 0.2, `split job comm share ${split.commShare}`);
  const g = TP.TEMPLATES.find(t => t.id === 'train').build();
  g.edges = g.edges.filter(e => e.from !== 'job');
  const local = E.simulate(E.compileGraph(g, lookup).spec).summary.train;
  assert.ok(local.commShare < 0.05, `on-prem job comm share ${local.commShare}`);
  assert.ok(local.stepS < split.stepS);
});

test('more on-prem instances improve SLO attainment on the burst template', () => {
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  g.nodes.find(n => n.id === 'on').cfg.instances = 8;
  const bigger = E.simulate(E.compileGraph(g, lookup).spec).summary;
  const base = runTemplate('burst').summary;
  assert.ok(bigger.slo > base.slo, `${bigger.slo} should beat ${base.slo}`);
});

test('prefix caching raises agent throughput', () => {
  const g = TP.TEMPLATES.find(t => t.id === 'agent').build();
  g.nodes.find(n => n.id === 'src').cfg.prefixHit = 0;
  const cold = E.simulate(E.compileGraph(g, lookup).spec).summary;
  const warm = runTemplate('agent').summary;
  assert.ok(warm.requests > cold.requests, `closed-loop agents finish more turns with caching (${warm.requests} vs ${cold.requests})`);
});

test('profile: tensor parallel and KV size follow the model and GPU', () => {
  const m70 = Object.assign({ wPrec: 'fp8', kvPrec: 'fp8' }, E.MODELS['llama-70b']);
  const p = E.profile('H100', m70);
  assert.equal(p.tp, 2);
  assert.equal(p.kvBytesPerToken, 2 * 80 * 8 * 128);
  assert.equal(E.profile('H200', m70).tp, 1);
  const bf16 = E.profile('H100', Object.assign({}, m70, { kvPrec: 'bf16' }));
  assert.equal(bf16.kvBytesPerToken, 2 * p.kvBytesPerToken);
  const moe = E.profile('H100', Object.assign({ wPrec: 'fp8', kvPrec: 'fp8' }, E.MODELS['moe-671b']));
  assert.ok(moe.multiNode, '671B weights do not fit on 8 H100s');
});

test('compile reports wiring mistakes', () => {
  const g = TP.TEMPLATES.find(t => t.id === 'xpd').build();
  g.edges = g.edges.filter(e => e.to !== 'dec');
  const c = E.compileGraph(g, lookup);
  assert.ok(c.errors.some(e => e.node === 'pre' && /decode pool/.test(e.msg)));
  const g2 = TP.TEMPLATES.find(t => t.id === 'disagg').build();
  g2.nodes.find(n => n.id === 'dec').cfg.site = 'Neocloud A';
  assert.ok(E.compileGraph(g2, lookup).errors.some(e => /different sites/.test(e.msg)));
});

test('CSV trace parser reads Azure and generic formats and rejects bad input', () => {
  const azure = 'TIMESTAMP,ContextTokens,GeneratedTokens\n2023-11-16 18:15:46.6805900,374,44\n2023-11-16 18:15:50.9951690,396,109\n';
  const a = E.parseTraceCSV(azure);
  assert.equal(a.trace.length, 2);
  assert.equal(a.trace[0].t, 0);
  assert.ok(Math.abs(a.trace[1].t - 4.315) < 0.01);
  const gen = E.parseTraceCSV('timestamp_ms,input_tokens,output_tokens\n1000,10,5\n3500,20,7\nbad,1,1\n');
  assert.deepEqual(gen.trace.map(r => r.t), [0, 2.5]);
  assert.ok(gen.notes.some(n => /1 unreadable/.test(n)));
  assert.throws(() => E.parseTraceCSV('a,b,c\n1,2,3\n'), /Columns not found/);
});
