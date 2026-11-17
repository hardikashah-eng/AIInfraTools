import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SC = require('../src/scenario.js'), C = require('../src/cluster.js'), E = require('../src/engine.js'), TP = require('../src/templates.js');
const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);

test('a cluster shortfall becomes outages on the linked pool', () => {
  const rd = { target: Int16Array.from([10, 10, 10, 10, 10, 10]), ready: Int16Array.from([10, 6, 6, 8, 10, 10]) };
  const o = SC.linkOutages(rd, 10, 'on', 0, 60);
  assert.deepEqual(o.map(x => [x.start, x.dur, x.fraction]), [[10, 20, 0.4], [30, 10, 0.2]]);
  assert.ok(o.every(x => x.target === 'on' && x.recovery === 0));
  assert.deepEqual(SC.linkOutages(rd, 10, 'on', 40, 20), []);
});

test('describes changes across a graph and a spec', () => {
  const a = TP.TEMPLATES.find(t => t.id === 'burst').build(), b = JSON.parse(JSON.stringify(a));
  b.nodes.find(n => n.id === 'on').cfg.instances = 6; b.nodes.find(n => n.id === 'on').x += 40;
  b.edges = b.edges.filter(e => e.to !== 'lk');
  const g = SC.describeGraph(a, b);
  assert.ok(g.includes('On-prem H100: instances 4 → 6'));
  assert.ok(g.some(l => l.startsWith('unwired Router')));
  assert.ok(!g.some(l => /\.x|: x /.test(l)), 'moving a node is not a change');
  const sa = C.sampleCluster(), sb = JSON.parse(JSON.stringify(sa)); sb.policy.placement = 'binpack'; sb.queues[0].priority = 5;
  assert.deepEqual(SC.describeSpec(sa, sb), ['policy.placement spread → binpack', 'serving: priority 100 → 5']);
});

test('the store pins every view and lists what changed since', () => {
  const st = SC.createStore();
  let g = { nodes: [{ id: 'p', type: 'pool', cfg: { name: 'P', instances: 2 } }], edges: [] }, sp = { policy: { placement: 'spread' }, pools: [] };
  st.register('fleet', { snapshot: () => g, restore: x => { g = x; }, describe: SC.describeGraph });
  st.register('cluster', { snapshot: () => sp, restore: x => { sp = x; } });
  st.pinAll();
  g = JSON.parse(JSON.stringify(g)); g.nodes[0].cfg.instances = 3; sp = { policy: { placement: 'binpack' }, pools: [] };
  assert.deepEqual(st.changes().map(c => c.view + ': ' + c.text), ['fleet: P: instances 2 → 3', 'cluster: policy.placement spread → binpack']);
  st.resetAll();
  assert.equal(g.nodes[0].cfg.instances, 2); assert.equal(sp.policy.placement, 'spread');
  let seen = null; st.onClock(t => { seen = t; }); st.setClock(90, 'cluster'); assert.equal(seen, 90);
});

test('when training preempts serving in the cluster, the linked fleet pool breaks its SLO', () => {
  const cs = C.sampleCluster(); cs.queues.find(q => q.id === 'serving').priority = 5;
  const CR = C.simulateCluster(cs), wi = CR.spec.workloads.findIndex(w => w.name === 'chat-serving');
  const rd = C.inferenceReadiness(CR, wi, 240);
  const spec = E.compileGraph(TP.TEMPLATES.find(t => t.id === 'burst').build(), lookup).spec;
  const outs = SC.linkOutages(rd, CR.step, 'on', 0.5 * 3600, 640);
  assert.ok(outs.length && Math.max(...outs.map(o => o.fraction)) >= 0.5, 'more than half the replicas are not ready after the preemption');
  const free = E.simulate(spec).summary, linked = E.simulate(spec, { name: 'Cluster capacity', outages: outs }).summary;
  assert.ok(linked.slo < free.slo - 0.05, `linked ${linked.slo} vs ${free.slo}`);
});
