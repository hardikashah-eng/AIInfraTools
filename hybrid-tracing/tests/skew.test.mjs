import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/synth.mjs';
import { fix, readRequests, collect, violations, kindOf, CORRECTED_ATTR } from '../src/skew.mjs';

const run = (opts = {}, gen = {}) => { const g = generate(Object.assign({ requests: 400 }, gen)); return Object.assign(fix([g.request], opts), { truth: g.offsets }); };
const row = (rep, d) => rep.rows.find(r => r.domain === d);

test('recovers each machine\'s offset: microseconds on-prem, within WAN asymmetry across sites', () => {
  const { report, truth } = run();
  for (const d of ['router-1', 'prefill-1', 'prefill-2', 'prefill-3', 'prefill-4']) assert.ok(Math.abs(row(report, d).offsetNs - truth[d]) < 5_000, d);
  // the synthetic WAN path is 900 µs out and 700 µs back: no timestamp method can see that 100 µs asymmetry
  for (let i = 1; i <= 6; i++) { const d = 'decode-' + i; assert.ok(Math.abs(row(report, d).offsetNs - truth[d]) < 150_000, `${d}: ${row(report, d).offsetNs} vs ${truth[d]}`); }
  assert.equal(row(report, 'gw-1').method, 'reference');
  assert.equal(row(report, 'decode-1').method, 'two-way');
});

test('removes every cross-machine ordering violation', () => {
  const { report } = run();
  assert.ok(report.before.startBeforeParent + report.before.endAfterParent > 100);
  assert.equal(report.after.startBeforeParent, 0);
  assert.equal(report.after.endAfterParent, 0);
  assert.equal(report.boundViolations, 0);
});

test('a machine reached only one-way gets a bound-based estimate; an isolated one is left alone', () => {
  const { report, requests, truth } = run();
  const s = row(report, 'stream-1');
  assert.equal(s.method, 'bound');
  assert.ok(Math.abs(s.offsetNs - truth['stream-1']) < 300_000, String(s.offsetNs));
  const b = row(report, 'batch-1');
  assert.equal(b.method, 'none');
  assert.equal(b.offsetNs, null);
  const batchSpan = collect(requests).find(x => x.domain === 'batch-1');
  assert.ok(!(batchSpan.raw.attributes || []).some(a => a.key === CORRECTED_ATTR));
});

test('corrected spans carry the shift they received, and a second pass finds nothing left to fix', () => {
  const { requests, report } = run();
  const sp = collect(requests).find(x => x.domain === 'decode-4');
  const tag = sp.raw.attributes.find(a => a.key === CORRECTED_ATTR);
  assert.equal(Number(tag.value.intValue), row(report, 'decode-4').offsetNs);
  const again = fix(requests).report;
  for (const r of again.rows) if (r.offsetNs != null && r.method !== 'bound') assert.ok(Math.abs(r.offsetNs) < 2_000, `${r.domain} ${r.offsetNs}`);
});

test('the reference site defines zero: choosing the neocloud instead moves the on-prem machines', () => {
  const { report } = run({ refSite: 'neocloud' });
  assert.ok(row(report, 'gw-1').offsetNs !== 0);
  assert.equal(report.after.startBeforeParent, 0);
});

test('measured offsets (e.g. from chrony) fill in machines with no exchanges', () => {
  const { report } = run({ known: { 'batch-1': -3_000_000 } });
  assert.equal(row(report, 'batch-1').method, 'measured');
  assert.equal(row(report, 'batch-1').offsetNs, -3_000_000);
});

test('dry run reports without changing timestamps', () => {
  const g = generate({ requests: 50 });
  const before = JSON.stringify(g.request);
  const { report } = fix([g.request], { dryRun: true });
  assert.equal(JSON.stringify(g.request), before);
  assert.equal(report.corrected, 0);
});

test('reads JSON lines, arrays and string span kinds', () => {
  const g = generate({ requests: 20 });
  const lines = g.request.resourceSpans.map(rs => JSON.stringify({ resourceSpans: [rs] })).join('\n');
  const reqs = readRequests(lines);
  assert.equal(reqs.length, g.request.resourceSpans.length);
  assert.equal(readRequests(JSON.stringify([g.request])).length, 1);
  assert.equal(kindOf('SPAN_KIND_CLIENT'), 3);
  for (const rs of g.request.resourceSpans) for (const sp of rs.scopeSpans[0].spans) sp.kind = ['', 'SPAN_KIND_INTERNAL', 'SPAN_KIND_SERVER', 'SPAN_KIND_CLIENT', 'SPAN_KIND_PRODUCER', 'SPAN_KIND_CONSUMER'][sp.kind];
  const { report } = fix([g.request]);
  assert.equal(report.after.startBeforeParent, 0);
  assert.throws(() => readRequests('{"resourceSpans": []}\nnot json'), /Line 2/);
});

test('violations() flags children that start before their parent across machines', () => {
  const g = generate({ requests: 30 });
  const v = violations(collect([g.request]));
  assert.ok(v.checked > 100);
  assert.ok(v.startBeforeParent > 0);
});
