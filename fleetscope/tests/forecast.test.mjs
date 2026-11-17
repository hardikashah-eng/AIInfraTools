import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../src/forecast.js'), E = require('../src/engine.js'), TP = require('../src/templates.js');
const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);

test('reads Prometheus query_range results', () => {
  const j = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { instance: 'a' }, values: [[100, '1.5'], [400, '2']] }, { metric: { instance: 'b' }, values: [[100, '0.5'], [400, '1']] }] } };
  assert.deepEqual(F.seriesFrom(j), [{ t: 100, v: 2 }, { t: 400, v: 3 }]);
  const b = F.bundleFrom({ requests: j, prompt: j });
  assert.equal(b.prompt.length, 2);
});

test('forecasts a daily pattern well enough to trust its band', () => {
  const H = F.sampleHistory({ base: 15 }), end = H[H.length - 1].t;
  let mape = 0, cov = 0, n = 0;
  for (let c = end - 2 * 86400; c <= end - 6 * 3600; c += 3 * 3600) { const b = F.backtest(H, c, 6 * 3600); mape += b.mape; cov += b.coverage; n++; }
  assert.ok(mape / n < 0.15, 'MAPE ' + mape / n);
  assert.ok(cov / n > 0.75, 'coverage ' + cov / n);
  const short = F.forecast(H.slice(-200), 3600);
  assert.equal(short.seasonal, false);
  assert.ok(short.points.length > 0);
});

test('projects the forecast through the graph and names where it breaks', () => {
  const H = F.sampleHistory({ base: 15 }), now = H.filter(p => F.clock(p.t, -8) === '9:00').pop().t;
  const fc = F.forecast(H.filter(p => p.t <= now), 6 * 3600);
  const spec = E.compileGraph(TP.TEMPLATES.find(t => t.id === 'burst').build(), lookup).spec;
  const hi = F.project(spec, fc, { band: 'hi' });
  assert.ok(hi.alerts.length > 0);
  assert.equal(hi.alerts[hi.alerts.length - 1].node, 'on');
  assert.ok(hi.alerts.every(a => a.end > a.start && a.endS - a.startS >= 120));
  assert.match(F.alertText(hi.alerts[0], { fmt: t => F.clock(t, -8) }), /predicts SLO breaches \d+:\d\d–\d+:\d\d/);
  const g = TP.TEMPLATES.find(t => t.id === 'burst').build();
  g.nodes.find(n => n.id === 'on').cfg.instances = 10;
  const big = F.project(E.compileGraph(g, lookup).spec, fc, { band: 'hi' });
  assert.equal(big.alerts.length, 0, 'enough capacity: no alerts');
});

test('the CLI prints alerts and exits 1 when it predicts breaches', () => {
  let out, code = 0;
  try { out = execFileSync('node', ['tools/live-twin.mjs', '--sample', '--hours', '4', '--band', 'hi', '--now', '2026-11-17T17:00:00Z', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }); }
  catch (e) { out = e.stdout; code = e.status; }
  const r = JSON.parse(out);
  assert.equal(code, 1);
  assert.ok(r.alerts.length > 0 && r.reality.points > 0);
  assert.equal(r.nowText, '17:00');
});
