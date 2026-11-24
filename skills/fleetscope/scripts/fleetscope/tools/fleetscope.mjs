#!/usr/bin/env node
// FleetScope without the browser: run a scenario, ask a what-if, or compare two versions. Made for scripts and LLM agents
// (every command takes --json), and for people who want numbers without opening dist/index.html.
//
//   node tools/fleetscope.mjs templates [--json]                         built-in fleets to start from
//   node tools/fleetscope.mjs template ID [-o graph.json]                write one as a graph file
//   node tools/fleetscope.mjs run  SOURCE [--trace FILE] [--json]        stress suite: SLO, TTFT/TPOT p99, cost, peak GPUs, bottleneck
//   node tools/fleetscope.mjs ask  "QUESTION" SOURCE [--trace FILE] [-o edited-graph.json] [--json]
//   node tools/fleetscope.mjs compare --base DIR --head DIR [--json]      what changes between two versions of a scenario
//   node tools/fleetscope.mjs examples                                    what-if phrasings `ask` understands
//   node tools/fleetscope.mjs power SOURCE [--cap POOL=PCT,...] [--budget SITE=KW,...] [--alpha-compute 0.35] [--json]
//        power per pool and site (IT kW against budgets), tokens per MWh, and what power caps do to latency and power
//
// SOURCE is one of: --scenario DIR (graph.json, cluster.json, training.json, kueue.yaml), --graph FILE (also an
// Inference Sizer export), or --template ID. --trace replays your own request log (vLLM OTLP/Jaeger, gateway JSON, CSV)
// through every trace-replay node instead of the built-in synthetic traffic.
// Exit code: 0 ok, 1 a compare check failed or a question was not understood, 2 usage or input error.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js'), P = require('../src/plan.js'), A = require('../src/ask.js'), TP = require('../src/templates.js'), IN = require('../src/ingest.js');

const argv = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') { opt.out = argv[++i]; continue; }
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const n = argv[i + 1];
  if (n !== undefined && !n.startsWith('-')) { opt[a.slice(2)] = n; i++; } else opt[a.slice(2)] = true;
}
const cmd = pos[0];
const die = (m, code = 2) => { if (opt.json) console.log(JSON.stringify({ error: m })); else console.error(m); process.exit(code); };
const print = (obj, text) => console.log(opt.json ? JSON.stringify(obj, null, 1) : text);
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { die(`${f}: ${e.message}`); } };
const SC_FILES = ['graph.json', 'cluster.json', 'training.json', 'kueue.yaml', 'kueue.json', 'thresholds.json'];

function readScenario(dir) {
  const sc = { name: dir };
  for (const f of SC_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    try {
      if (f === 'kueue.yaml' || f === 'kueue.json') sc.kueue = text;
      else sc[f.replace('.json', '')] = JSON.parse(text);
    } catch (e) { die(`${p}: ${e.message}`); }
  }
  if (!sc.graph && !sc.cluster && !sc.training) die(`${dir}: no graph.json, cluster.json or training.json`);
  return sc;
}
function template(id) {
  const t = TP.TEMPLATES.find(x => x.id === id);
  if (!t) die(`Unknown template "${id}". Templates: ${TP.TEMPLATES.map(x => x.id).join(', ')}`);
  return t.build();
}
function source() {
  if (opt.scenario) return readScenario(opt.scenario);
  if (opt.graph) return { name: opt.graph, graph: readJson(opt.graph) };
  if (opt.template) return { name: opt.template, graph: template(opt.template) };
  die('Give a source: --scenario DIR, --graph FILE or --template ID');
}
function traceOptions(sc) {
  if (!opt.trace) return {};
  let parsed;
  try { parsed = IN.parseTrace(readFileSync(opt.trace, 'utf8')); } catch (e) { die(`${opt.trace}: ${e.message}`); }
  if (!parsed.trace.length) die(`${opt.trace}: no requests found`);
  if (sc.graph) for (const n of sc.graph.nodes || []) if (n.type === 'trace') n.cfg.trace = 'uploaded';
  const synth = (k, s) => E.scaleTrace(E.genTrace(k === 'live' ? 'chat' : k, 7), s || 1, 7);
  return { traceLookup: (k, s) => (k === 'uploaded' ? E.scaleTrace(parsed.trace, s || 1, 7) : synth(k, s)), traceInfo: { file: opt.trace, format: parsed.format, requests: parsed.trace.length, notes: parsed.notes } };
}
const pct = v => (v == null ? '–' : Math.round(v * 1000) / 10 + '%');
const sec = v => (v == null ? '–' : (v >= 10 ? v.toFixed(0) : v.toFixed(2)) + ' s');
const money = v => (v == null ? '–' : '$' + v.toFixed(2));
const brief = s => ({ slo: s.slo, ttftP50: s.ttftP50, ttftP99: s.ttftP99, tpotP99: s.tpotP99, costPerHr: s.costPerHr, costPerMTok: s.costPerMTok, peakGpus: s.peakGpus, completed: s.completed, rejected: s.rejected, lost: s.lost, util: s.util,
  bottleneck: s.bottleneck && s.bottleneck.first ? { at: s.bottleneck.first.t, where: s.bottleneck.first.name, what: s.bottleneck.first.label } : null });

if (!cmd || cmd === 'help' || opt.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(0); }

if (cmd === 'templates') {
  const list = TP.TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.desc }));
  print(list, list.map(t => `${t.id.padEnd(8)} ${t.name}: ${t.description}`).join('\n'));
} else if (cmd === 'template') {
  const g = template(pos[1] || opt.template);
  const text = JSON.stringify(g, null, 1);
  if (opt.out) { writeFileSync(opt.out, text); if (!opt.json) console.error(`wrote ${opt.out}`); else print({ wrote: opt.out }); } else console.log(text);
} else if (cmd === 'examples') {
  print(A.EXAMPLES, A.EXAMPLES.join('\n'));
} else if (cmd === 'run') {
  const sc = source(), t = traceOptions(sc);
  const r = P.runScenario(sc, t);
  if (r.fleetErrors) die('The graph cannot run: ' + r.fleetErrors.join('; '));
  const res = Object.assign({ scenario: sc.name }, t.traceInfo ? { trace: t.traceInfo } : {}, r);
  const lines = [`FleetScope: ${sc.name}${t.traceInfo ? ` (replaying ${t.traceInfo.requests} requests from ${t.traceInfo.file})` : ''}`];
  if (r.fleet) {
    lines.push('', 'Stress test                  SLO      TTFT p99  TPOT p99  $/hour   peak GPUs  first bottleneck');
    for (const f of r.fleet) lines.push(`${f.name.padEnd(28)} ${pct(f.slo).padEnd(8)} ${sec(f.ttftP99).padEnd(9)} ${sec(f.tpotP99).padEnd(9)} ${money(f.costPerHr).padEnd(8)} ${String(f.peakGpus).padEnd(10)} ${f.bottleneck || 'none'}`);
    if (r.lint && r.lint.length) lines.push('', 'Warnings:', ...r.lint.map(x => '  - ' + x));
  }
  if (r.cluster) lines.push('', `Cluster: allocation ${pct(r.cluster.allocation)}, stranded ${Math.round(r.cluster.strandedGpuH)} GPU-h, idle allocated ${Math.round(r.cluster.idleAllocGpuH)} GPU-h, training admitted ${r.cluster.trainingAdmitted}/${r.cluster.trainingTotal}, preemptions ${r.cluster.preemptions}`);
  if (r.training) lines.push('', `Training: goodput ${pct(r.training.goodput)}, MFU ${pct(r.training.mfu)}, ${r.training.tokensB.toFixed(1)}B tokens${r.training.bottleneck ? ', bottleneck: ' + r.training.bottleneck : ''}`);
  lines.push('', 'Uncalibrated: spec-sheet roofline estimates. Treat as directional until calibrated against telemetry.');
  print(res, lines.join('\n'));
} else if (cmd === 'ask') {
  const q = pos.slice(1).join(' ') || opt.question;
  if (!q) die('Give the question: ask "What if the cloud link drops to 25 Gbps?" --template agent');
  const sc = source();
  if (!sc.graph) die('ask needs a fleet graph (--graph, --template, or a scenario with graph.json)');
  const t = traceOptions(sc);
  const a = A.answer(q, sc.graph, t);
  const res = { question: q, understood: !!a.understood, readAs: (a.edits || []).map(e => e.text).concat(a.stress && a.stress.name ? [a.stress.name] : []), notUsed: a.ignored || '',
    edits: (a.edits || []).map(e => ({ node: e.name, field: e.field, from: e.from, to: e.to })), stress: a.stress && a.stress.name ? a.stress : null,
    before: a.before ? brief(a.before) : null, after: a.after ? brief(a.after) : null, answer: a.text };
  if (opt.out && a.understood && a.graph) writeFileSync(opt.out, JSON.stringify(a.graph, null, 1));
  print(res, [`Read as: ${res.readAs.join('; ') || '(nothing)'}`, res.notUsed ? `Not used: ${res.notUsed}` : null, '', res.answer, opt.out && a.understood ? `\nEdited graph written to ${opt.out}` : null].filter(x => x != null).join('\n'));
  process.exit(a.understood ? 0 : 1);
} else if (cmd === 'compare') {
  if (!opt.base || !opt.head) die('compare needs --base DIR and --head DIR');
  const base = readScenario(opt.base), head = readScenario(opt.head);
  const r = P.compare(base, head, { thresholds: head.thresholds });
  print({ verdict: r.verdict, checks: r.checks, changes: r.changes, owners: r.owners }, P.markdown(r, { scenario: opt.head }));
  process.exit(r.verdict === 'fail' ? 1 : 0);
} else if (cmd === 'power') {
  const sc = source(); if (!sc.graph) die('power needs a fleet graph (--graph, --template, or a scenario with graph.json)');
  const t = traceOptions(sc), lookup = t.traceLookup || ((k, s) => E.scaleTrace(E.genTrace(k === 'live' ? 'chat' : k, 7), s || 1, 7));
  const kv = s => Object.fromEntries(String(s || '').split(',').filter(Boolean).map(x => { const i = x.lastIndexOf('='); return [x.slice(0, i), parseFloat(x.slice(i + 1))]; }));
  const caps = kv(opt.cap), budgets = kv(opt.budget);
  const power = Object.assign({ sites: Object.fromEntries(Object.entries(budgets).map(([k, v]) => [k, { budgetKw: v }])) }, opt['alpha-compute'] ? { alphaCompute: +opt['alpha-compute'] } : {}, opt['alpha-memory'] ? { alphaMemory: +opt['alpha-memory'] } : {}, opt.pue ? { pue: +opt.pue } : {});
  const run = withCaps => {
    const g = JSON.parse(JSON.stringify(sc.graph)); g.power = power;
    for (const n of g.nodes) if (n.type === 'pool') { const c = caps[n.id] ?? caps[n.cfg.name] ?? caps['*']; if (withCaps && c != null) n.cfg.powerCapPct = c; }
    const c = E.compileGraph(g, lookup); if (c.errors.length) die('The graph cannot run: ' + c.errors.map(e => e.msg).join('; '));
    const R = E.simulate(c.spec, null); return { s: R.summary, p: E.powerBreakdown(R) };
  };
  const base = run(false), capped = Object.keys(caps).length ? run(true) : null;
  const unknown = Object.keys(caps).filter(k => k !== '*' && !sc.graph.nodes.some(n => n.type === 'pool' && (n.id === k || n.cfg.name === k)));
  if (unknown.length) die(`no pool named ${unknown.join(', ')}`);
  const kw = v => (v == null || !isFinite(v) ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  const view = r => ({ slo: r.s.slo, ttftP99: r.s.ttftP99, tpotP99: r.s.tpotP99, tokensPerMWh: r.p.tokensPerMWh, facilityKWh: r.p.facilityKWh, pools: r.p.pools, sites: r.p.sites });
  const res = { scenario: sc.name, caps, budgets, base: view(base), capped: capped ? view(capped) : null, assumptions: base.p.assumptions };
  const lines = [`FleetScope power: ${sc.name}`, '', 'Pool                     GPU     cap   IT kW avg  IT kW peak  tokens/kWh'];
  for (const [id, p] of Object.entries((capped || base).p.pools)) lines.push(`${(p.name || id).padEnd(24)} ${String(p.gpu).padEnd(7)} ${(p.capPct + '%').padStart(4)}  ${kw(p.itKwAvg).padStart(9)}  ${kw(p.itKwPeak).padStart(10)}  ${kw(p.tokensPerKWh).padStart(10)}`);
  lines.push('', 'Site            IT kW peak  budget   headroom   over budget');
  for (const s of Object.values((capped || base).p.sites)) lines.push(`${String(s.site).padEnd(15)} ${kw(s.itKwPeak).padStart(10)}  ${kw(s.budgetKw).padStart(6)}  ${(s.headroomKw == null ? '–' : kw(s.headroomKw)).padStart(9)}   ${s.budgetKw == null ? '–' : s.overBudgetS + ' s'}`);
  if (capped) lines.push('', `With the caps: SLO ${pct(base.s.slo)} → ${pct(capped.s.slo)}, TTFT p99 ${sec(base.s.ttftP99)} → ${sec(capped.s.ttftP99)}, TPOT p99 ${sec(base.s.tpotP99)} → ${sec(capped.s.tpotP99)}, tokens per MWh ${kw(base.p.tokensPerMWh)} → ${kw(capped.p.tokensPerMWh)}, energy ${kw(base.p.facilityKWh)} → ${kw(capped.p.facilityKWh)} kWh (facility)`);
  else lines.push('', `Tokens per MWh (facility): ${kw(base.p.tokensPerMWh)}. Try --cap POOL=70 to see what a cap does.`);
  lines.push('', `Model: busy GPUs draw ${base.p.assumptions.busyDraw * 100}% of board power or the cap, idle ${base.p.assumptions.idleDraw * 100}%; GPUs are ${base.p.assumptions.gpuShare * 100}% of IT power; PUE ${base.p.assumptions.pue}. A cap slows compute-bound prefill as cap^${base.p.assumptions.alphaCompute}, memory-bound decode as cap^${base.p.assumptions.alphaMemory} (fleetops power fit measures it). Uncalibrated.`);
  print(res, lines.join('\n'));
} else die(`Unknown command "${cmd}". Commands: templates, template, run, ask, compare, examples, power`);
