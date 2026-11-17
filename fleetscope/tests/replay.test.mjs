import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const TP = require('../src/templates.js');

const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
function agentLogGraph(mode, instances, extra) {
  const g = TP.TEMPLATES.find(t => t.id === 'agent').build();
  g.nodes = g.nodes.filter(n => n.id !== 'src');
  g.nodes.push(TP.node('src', 'trace', 40, 250, Object.assign({ trace: 'sessions', replay: mode }, extra || {})));
  const on = g.nodes.find(n => n.id === 'on'); on.cfg.instances = instances;
  const neo = g.nodes.find(n => n.id === 'neo'); neo.cfg.min = 0; neo.cfg.max = 0;
  return g;
}
const run = g => { const c = E.compileGraph(g, lookup); assert.deepEqual(c.errors, []); return E.simulate(c.spec); };

test('session planning chains turns and spots parallel calls', () => {
  const rows = [
    { t: 0, isl: 100, osl: 10, e2e: 2, session: 'a' },
    { t: 0.5, isl: 50, osl: 5, e2e: 1, session: 'a' },     // overlaps turn 0: a parallel call
    { t: 5, isl: 200, osl: 10, e2e: 2, session: 'a' },     // after turn 0 finished at 2: think 3 s
    { t: 1, isl: 100, osl: 10, session: 'b' },             // no latency recorded
    { t: 4, isl: 120, osl: 10, session: 'b' },
    { t: 2, isl: 80, osl: 8 }                              // no session: stays open loop
  ];
  const p = E.planSessions(rows);
  assert.equal(p.sessions.length, 2);
  assert.equal(p.loose.length, 1);
  const a = p.sessions.find(s => s.id === 'a').turns;
  assert.deepEqual(a[0].branches, [{ idx: 1, offset: 0.5 }]);
  assert.equal(a[0].next, 2);
  assert.equal(a[2].gap, 3);
  assert.equal(p.branches, 1);
  assert.equal(p.estimated, 1, 'session b has no recorded latency, so its gap is estimated');
});

test('closed-loop replay issues every recorded turn once', () => {
  const r = run(agentLogGraph('sessions', 6));
  const rows = E.genTrace('sessions', 7);
  assert.equal(r.summary.requests, rows.length);
  assert.equal(r.summary.replay.issued, rows.length);
  assert.equal(r.summary.replay.sessions, new Set(rows.map(x => x.session)).size);
  const s0 = r.reqs.filter(q => q.session === 'agent-0').sort((a, b) => a.turn - b.turn);
  assert.ok(s0.length > 1);
  for (let i = 1; i < s0.length; i++) assert.ok(s0[i].t >= s0[i - 1].t, 'turns are issued in order');
});

test('closed loop spreads load when the fleet is slow; open loop piles it up', () => {
  const open = run(agentLogGraph('timestamps', 3)).summary, closed = run(agentLogGraph('sessions', 3)).summary;
  assert.ok(closed.ttftP99 < open.ttftP99 / 2, `closed ${closed.ttftP99} vs open ${open.ttftP99}`);
  assert.ok(closed.replay.driftP50 > 10, 'turns fall behind the recorded timeline');
  const roomy = run(agentLogGraph('sessions', 12)).summary;
  assert.ok(roomy.replay.driftP50 < closed.replay.driftP50);
});

test('giving up abandons the rest of a session after a failure', () => {
  const g = agentLogGraph('sessions', 6, { onFail: 'giveup' });
  g.nodes.find(n => n.type === 'model').cfg.layers = 400; // inflate KV per token so long contexts are rejected
  const r = run(g).summary;
  assert.ok(r.rejected > 0);
  assert.ok(r.replay.abandoned > 0);
  const retry = run(Object.assign(agentLogGraph('sessions', 6, { onFail: 'retry' }), {})).summary;
  assert.equal(retry.replay.abandoned, 0);
});

test('lint flags oversized contexts, slow cold starts, link demand and single points of failure', () => {
  const kinds = id => E.lintSpec(E.compileGraph(TP.TEMPLATES.find(t => t.id === id).build(), lookup).spec).map(x => x.kind);
  assert.ok(kinds('burst').includes('cold'), 'neocloud starts empty with a 90 s cold start');
  assert.ok(kinds('xpd').includes('link'), 'KV demand exceeds the 100 Gbps link');
  assert.ok(kinds('train').includes('contention'));
  assert.ok(kinds('disagg').includes('spof'));
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  Object.assign(g.nodes.find(n => n.type === 'model').cfg, E.MODELS['llama-405b'], { key: 'llama-405b', wPrec: 'bf16', kvPrec: 'bf16' });
  const k = E.lintSpec(E.compileGraph(g, lookup).spec).map(x => x.kind);
  assert.ok(k.includes('kvsmall') || k.includes('multinode'));
});
