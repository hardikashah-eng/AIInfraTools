#!/usr/bin/env node
// FleetScope live twin: pull request-rate history from Prometheus (or a saved export), forecast the next hours,
// run the forecast through a graph, print predicted SLO breaches, and optionally post them to Slack or Lark.
//
//   node tools/live-twin.mjs --prom http://prometheus:9090 --graph my-graph.json --hours 4 --webhook https://hooks.slack.com/... 
//   node tools/live-twin.mjs --history export.json --graph my-graph.json --now 2026-11-17T17:00:00Z   # backtest
//   node tools/live-twin.mjs --sample --hours 6 --band hi                                          # synthetic week, sample graph
//
// Options: --prom URL, --history FILE, --sample, --graph FILE (from "Copy graph JSON"; default: the Hybrid chat burst template),
//   --hours N (1–12, default 4), --band mid|hi (forecast or its 80% upper band), --now ISO (forecast from this time; actuals after it
//   are scored), --utc-offset H (clock for messages, default 0), --webhook URL, --webhook-kind slack|lark, --export FILE (save the pulled
//   history), --query-requests/--query-prompt/--query-generation PROMQL, --days N (history to pull, default 8), --json (machine output).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), TP = require('../src/templates.js'), F = require('../src/forecast.js');

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const a = args[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); const n = args[i + 1]; if (n === undefined || n.startsWith('--')) opt[k] = true; else { opt[k] = n; i++; } }
const hours = Math.max(1, Math.min(12, +(opt.hours || 4))), offset = +(opt['utc-offset'] || 0), fmt = t => F.clock(t, offset);
const Q = {
  requests: opt['query-requests'] || 'sum(rate(vllm:request_success_total[5m]))',
  prompt: opt['query-prompt'] || 'sum(rate(vllm:prompt_tokens_total[5m]))',
  generation: opt['query-generation'] || 'sum(rate(vllm:generation_tokens_total[5m]))'
};

async function pull(base, days) {
  const end = Math.floor(Date.now() / 1000), start = end - days * 86400, out = { meta: { source: base, start, end, step: 300 } };
  for (const [k, q] of Object.entries(Q)) {
    const u = new URL('/api/v1/query_range', base);
    u.search = new URLSearchParams({ query: q, start, end, step: 300 }).toString();
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Prometheus ${r.status} for ${k}`);
    out[k] = await r.json();
  }
  return out;
}

async function main() {
  let bundle;
  if (opt.sample) bundle = { requests: F.sampleHistory({ base: 15 }), prompt: null, generation: null, meta: { source: 'synthetic week' } };
  else if (opt.history) bundle = F.bundleFrom(readFileSync(opt.history, 'utf8'));
  else if (opt.prom) { const raw = await pull(opt.prom, +(opt.days || 8)); if (opt.export) writeFileSync(opt.export, JSON.stringify(raw)); bundle = F.bundleFrom(raw); }
  else { console.error('Give --prom URL, --history FILE or --sample'); process.exit(2); }
  const all = bundle.requests;
  if (all.length < 20) throw new Error('Not enough history (' + all.length + ' points)');
  const now = opt.now ? Date.parse(opt.now) / 1000 : all[all.length - 1].t;
  const hist = all.filter(p => p.t <= now);
  const mean = s => (s && s.length ? s.slice(-12).reduce((a, p) => a + p.v, 0) / Math.min(12, s.length) : NaN);
  const reqRate = mean(bundle.requests.filter(p => p.t <= now));
  const islMean = bundle.prompt ? mean(bundle.prompt.filter(p => p.t <= now)) / reqRate : 1500;
  const oslMean = bundle.generation ? mean(bundle.generation.filter(p => p.t <= now)) / reqRate : 300;

  const graph = opt.graph ? JSON.parse(readFileSync(opt.graph, 'utf8')) : TP.TEMPLATES.find(t => t.id === 'burst').build();
  const lookup = (k, s) => E.scaleTrace(E.genTrace(k, 7), s || 1, 7);
  const c = E.compileGraph(graph, lookup);
  if (c.errors.length) throw new Error('Graph does not compile: ' + c.errors.map(e => e.msg).join('; '));

  const fc = F.forecast(hist, hours * 3600);
  const band = opt.band === 'hi' ? 'hi' : 'mid';
  const P = F.project(c.spec, fc, { band, islMean: isFinite(islMean) ? islMean : 1500, oslMean: isFinite(oslMean) ? oslMean : 300 });
  const after = all.filter(p => p.t > now && p.t <= now + hours * 3600);
  const bt = after.length ? F.backtest(all, now, hours * 3600) : null;

  const res = {
    now, nowText: fmt(now), hours, band, source: bundle.meta.source || opt.history || opt.prom,
    forecast: { first: fc.points[0].v, peak: Math.max(...fc.points.map(p => p.v)), peakAt: fmt(fc.points.reduce((b, p) => (p.v > b.v ? p : b)).t), seasonal: fc.seasonal },
    projected: { slo: P.R.summary.slo, ttftP99: P.R.summary.ttftP99, tpotP99: P.R.summary.tpotP99, firstBottleneck: P.R.summary.bottleneck.first },
    alerts: P.alerts.map(a => Object.assign({ text: F.alertText(a, { fmt }) }, a)),
    reality: bt ? { mape: bt.mape, coverage: bt.coverage, points: bt.pairs.length } : null
  };
  if (opt.json) console.log(JSON.stringify(res, null, 1));
  else {
    console.log(`Forecast from ${res.nowText} for ${hours} h (${band === 'hi' ? '80% upper band' : 'expected'}): ${res.forecast.first.toFixed(1)} req/s now, peak ${res.forecast.peak.toFixed(1)} req/s at ${res.forecast.peakAt}${fc.seasonal ? '' : ' (no daily pattern: under two days of history)'}.`);
    console.log(`Projected: ${(res.projected.slo * 100).toFixed(1)}% of requests meet the SLO; TTFT p99 ${res.projected.ttftP99.toFixed(2)} s, TPOT p99 ${(res.projected.tpotP99 * 1000).toFixed(0)} ms.`);
    console.log(res.alerts.length ? res.alerts.map(a => '  ! ' + a.text).join('\n') : '  No breaches predicted.');
    if (res.reality) console.log(`Prediction vs reality over ${res.reality.points} points: rate error ${(res.reality.mape * 100).toFixed(1)}% (MAPE), ${(res.reality.coverage * 100).toFixed(0)}% inside the 80% band.`);
  }
  if (opt.webhook && res.alerts.length) {
    const text = res.alerts.map(a => a.text).join('\n');
    const body = opt['webhook-kind'] === 'lark' ? { msg_type: 'text', content: { text } } : { text };
    const r = await fetch(opt.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('Webhook failed: ' + r.status);
  }
  process.exitCode = res.alerts.length ? 1 : 0;
}
main().catch(e => { console.error(e.message); process.exit(2); });
