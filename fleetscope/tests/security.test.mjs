import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const TP = require('../src/templates.js');

const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
const build = (id, edit) => { const g = TP.TEMPLATES.find(t => t.id === id).build(); if (edit) edit(g); return g; };
const nodeOf = (g, id) => g.nodes.find(n => n.id === id);
const run = g => { const c = E.compileGraph(g, lookup); assert.deepEqual(c.errors, []); return { spec: c.spec, R: E.simulate(c.spec) }; };

test('zone rules', () => {
  const P = E.DEFAULT_POLICY;
  assert.ok(E.zoneAllowed(P, 'confidential', 'private'));
  assert.ok(!E.zoneAllowed(P, 'confidential', 'dedicated'));
  assert.ok(E.zoneAllowed({ confidential: 'dedicated', internal: 'any' }, 'confidential', 'dedicated'));
  assert.ok(E.zoneAllowed(P, 'internal', 'shared'));
  assert.ok(!E.zoneAllowed({ confidential: 'private', internal: 'private' }, 'internal', 'shared'));
  assert.ok(E.zoneAllowed({ confidential: 'private', internal: 'private' }, 'public', 'shared'));
});

test('confidential traffic that bursts to a shared neocloud is counted as a breach', () => {
  const { R, spec } = run(build('agent'));
  const B = E.securityBreakdown(R, 0, R.D);
  const toNeo = R.reqs.filter(q => q.pPool === 'neo').length;
  assert.ok(toNeo > 0);
  assert.equal(B.nodes.neo.viol, toNeo);
  assert.equal(B.nodes.on.viol, 0);
  assert.equal(B.total.viol, toNeo);
  assert.ok(E.lintSpec(spec).some(x => x.kind === 'residency' && x.node === 'rt'));
});

test('enforcing residency keeps confidential traffic on-prem', () => {
  const { R, spec } = run(build('agent', g => { nodeOf(g, 'rt').cfg.enforceResidency = true; }));
  assert.equal(R.reqs.filter(q => q.pPool === 'neo').length, 0);
  assert.equal(E.securityBreakdown(R, 0, R.D).total.viol, 0);
  assert.ok(!E.lintSpec(spec).some(x => x.kind === 'residency'));
});

test('a dedicated zone, or a looser policy, makes bursting legal', () => {
  const ded = run(build('agent', g => { nodeOf(g, 'neo').cfg.zone = 'dedicated'; nodeOf(g, 'slo').cfg.confidentialIn = 'dedicated'; })).R;
  assert.equal(E.securityBreakdown(ded, 0, ded.D).total.viol, 0);
  assert.ok(ded.reqs.some(q => q.pPool === 'neo'));
});

test('enforced residency with no allowed decode pool blocks every request', () => {
  const { R, spec } = run(build('xpd', g => { nodeOf(g, 'src').cfg.dataClass = 'confidential'; nodeOf(g, 'rt').cfg.enforceResidency = true; }));
  assert.equal(R.summary.blocked, R.summary.requests);
  assert.ok(E.lintSpec(spec).some(x => x.kind === 'residency' && /blocked/.test(x.msg)));
});

test('unencrypted links carrying internal data are breaches and flagged', () => {
  const { R, spec } = run(build('xpd', g => { nodeOf(g, 'lk').cfg.encrypted = false; }));
  const B = E.securityBreakdown(R, 0, R.D);
  assert.ok(B.nodes.lk.viol > 0 && B.nodes.lk.violGB > 0);
  assert.ok(E.lintSpec(spec).some(x => x.kind === 'encryption'));
});

test('templates carry owners and the compiler collects them', () => {
  const { spec } = run(build('train'));
  assert.equal(spec.owners.job.owner, 'Foundation Models');
  assert.equal(spec.owners.lk.oncall, '@netops');
});
