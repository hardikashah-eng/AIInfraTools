// fleetops CLI: incidents (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import { whereFrom } from '../../src/store.mjs';
import * as Inc from '../../src/incidents.mjs';
import * as Pull from '../../src/pull.mjs';
import * as RCA from '../../src/rca.mjs';
import * as Detect from '../../src/detect.mjs';
import * as Bench from '../../src/bench.mjs';
import * as Inject from '../../src/inject.mjs';
import { J, OUT, say, read, time, fmt, hdrs, lokiQueries, dur } from './common.mjs';
import { HELP } from './help.mjs';

export async function rca(store, cmd, o) {
  const show = list => {
    if (J) { OUT.incidents = list; return; }
    if (o.format === 'md') { console.log(list.map(d => RCA.markdown(d)).join('\n')); return; }
    for (const d of list) {
      say(`${d.id}  [${d.confidence}]`);
      d.hypotheses.slice(0, 3).forEach((h, i) => say(`  ${i + 1}. ${h.title}  (${h.rule}, ${h.score.toFixed(2)})`));
      say(`     ${d.narrative}`);
    }
  };
  const weights = o.weights && o.weights !== true ? JSON.parse(read(o.weights)) : undefined;
  if (cmd === 'detect') {
    const from = time(o.from), to = time(o.to), targets = o.targets && o.targets !== true ? JSON.parse(read(o.targets)) : {};
    const where = whereFrom(o.where);
    let incs;
    if (o.method === 'threshold') incs = [...RCA.detectJobFailureSpikes(store, { from, to, minFailures: o['min-failures'] ? +o['min-failures'] : 50, ratio: o.ratio ? +o.ratio : 4 }), ...RCA.detectServingRegressions(store, { from, to, targets })];
    else incs = Detect.groupIncidents([...Detect.detectJobFailures(store, { from, to, binS: o.bin ? +o.bin : 600, minFailures: o['min-failures'] ? +o['min-failures'] : 20, where }), ...Detect.detectServing(store, { from, to, targets }), ...Detect.detectTraining(store, { from, to })], { gapS: o['group-gap'] ? +o['group-gap'] : 1800 });
    if (!o.diagnose) {
      if (J) { OUT.incidents = incs; return; }
      for (const i of incs) say(`${i.id}  ${i.symptom.startsWith('training') ? `${i.job || i.nodes.join(',')}${i.peak != null ? ` step ${i.peak.toFixed(3)} s vs ${i.baseline.toFixed(3)} s` : ''}` : i.failures != null ? `${i.failures} failures` : `${i.metric} peak ${i.peak.toFixed(3)}${i.limit ? ` > ${i.limit.toFixed(3)}` : i.baseline != null ? ` vs ${i.baseline.toFixed(3)}` : ''}`}${i.alarmAt ? `, alarm ${Math.round((i.alarmAt - i.from) / 60)} min after onset` : ''}, ${((i.to - i.from) / 3600).toFixed(1)} h${i.merged ? `, ${i.merged.length + 1} merged` : ''}${i.related ? `; related: ${i.related.join(', ')}` : ''}`);
      return;
    }
    const ds = incs.map(i => RCA.diagnose(store, i, { weights }));
    store.append('incident', ds);
    return show(ds);
  }
  if (cmd === 'diagnose') {
    if (!o.symptom || !o.from || !o.to) throw new Error('--symptom job-failures|latency|device --from T --to T');
    const inc = { symptom: o.symptom, from: time(o.from), to: time(o.to), pool: o.pool !== true ? o.pool : undefined, nodes: o.nodes && o.nodes !== true ? String(o.nodes).split(',') : undefined, metric: o.metric };
    const d = RCA.diagnose(store, inc, { weights });
    store.append('incident', [d]);
    return show([d]);
  }
  if (cmd === 'eval') {
    if (!o.labels || o.labels === true) throw new Error('--labels FILE');
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    const r = RCA.evaluate(store, labeled);
    if (J) { OUT.evaluation = r; return; }
    say(`${r.incidents} labeled incidents: top-1 ${(r.top1 * 100).toFixed(0)}%, top-3 ${(r.top3 * 100).toFixed(0)}%`);
    for (const x of r.rows) say(`  ${x.id}: labeled ${x.cause}, ranked ${x.rank ?? 'not found'} (${x.got.join(', ')})`);
    return;
  }
  if (cmd === 'bench') return bench(store, o, weights);
  throw new Error(`unknown: rca ${cmd}\n\n${HELP}`);
}

// The root-cause benchmark: synthetic scenarios (default), injected faults (--injections), postmortem labels (--labels).
export async function bench(store, o, weights) {
  const pct = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  const rows = [], parts = [];
  const useSynth = !o.injections && !o.labels && !o['from-incidents'] || o.synthetic;
  if (useSynth) { const r = Bench.run(Bench.generate({ perCause: o['per-cause'] ? +o['per-cause'] : 10, seed: o.seed ? +o.seed : 1, only: o.only && o.only !== true ? String(o.only).split(',') : undefined }), { weights }); rows.push(...r.rows); parts.push('synthetic'); }
  let inj = null;
  if (o.injections) { inj = Bench.evalInjections(store, { weights, from: time(o.from), to: time(o.to) }); rows.push(...inj.rows.filter(r => r.cause)); parts.push('injected'); }
  if (o['from-incidents']) { rows.push(...Bench.evalLabels(store, Inc.labelsFromIncidents(store), { weights }).map(r => Object.assign(r, { source: 'incident', scenario: `confirmed: ${r.cause}` }))); parts.push('confirmed incidents'); }
  if (o.labels && o.labels !== true) {
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    rows.push(...Bench.evalLabels(store, labeled, { weights })); parts.push('postmortem');
  }
  let sum = Bench.summarize(rows), fitted = null;
  if (o.fit && o.fit !== true) {
    // fit on half, report the other half; then fit on all for the file
    const train = rows.filter((_, i) => i % 2 === 0), test = rows.filter((_, i) => i % 2 === 1);
    const wHalf = Bench.fitWeights(train), testBefore = Bench.summarize(test), testAfter = Bench.applyWeights(test, wHalf);
    const w = Bench.fitWeights(rows), perCause = {};
    for (const r of rows) perCause[r.cause] = (perCause[r.cause] || 0) + 1;
    const thin = Object.entries(perCause).filter(([, n]) => n < 5).map(([c]) => c);
    fitted = { rules: w, fittedOn: { sources: parts, incidents: rows.length, perCause }, heldOut: { top1Before: testBefore.top1, top1After: testAfter.top1 },
      warnings: [...(parts.every(p => p === 'synthetic') ? ['fitted on synthetic scenarios only: these weights learn the generator, not your fleet; fit on injected or postmortem labels before using them'] : []), ...(thin.length ? [`fewer than 5 labeled incidents for: ${thin.join(', ')}`] : [])] };
    fs.writeFileSync(o.fit, JSON.stringify(fitted, null, 1));
  }
  if (J) { Object.assign(OUT, { benchmark: { sources: parts, top1: sum.top1, top3: sum.top3, lenientTop1: sum.lenientTop1, componentTop1: sum.componentTop1, byScenario: sum.byScenario, misses: sum.misses.map(m => ({ id: m.id, cause: m.cause, top: m.top, rank: m.rank })) }, injections: inj && { injections: inj.injections, detected: inj.detected, delayP50: inj.delayP50, delayP90: inj.delayP90, rows: inj.rows.map(({ hyps, ...r }) => r) }, fitted }); }
  else {
    say(`${sum.incidents} labeled incidents (${parts.join(' + ')}): top-1 ${pct(sum.top1)}, top-3 ${pct(sum.top3)}${sum.lenientTop1 !== sum.top1 ? `, top-1 counting equivalent causes ${pct(sum.lenientTop1)}` : ''}${sum.componentTop1 != null ? `, component named ${pct(sum.componentTop1)}` : ''}`);
    for (const [k, b] of Object.entries(sum.byScenario)) say(`  ${(b.top1 + '/' + b.n).padStart(7)}  ${k}${b.top1 < b.n ? `   ranked first: ${Object.entries(b.tops).map(([r, n]) => `${r} ${n}`).join(', ')}` : ''}`);
    if (inj) say(`injected faults: ${inj.injections}, detected ${pct(inj.detected)}, alarm after ${inj.delayP50 != null ? Math.round(inj.delayP50 / 60) : '–'} min (p50) / ${inj.delayP90 != null ? Math.round(inj.delayP90 / 60) : '–'} min (p90)`);
    if (inj) for (const r of inj.rows) say(`  ${r.id}: ${r.detected ? `detected after ${Math.round(r.delayS / 60)} min` : 'not detected'}; ${r.cause ? `expected ${r.cause}, ranked ${r.rank ?? 'not found'} (top: ${r.top || 'none'})` : `top: ${r.top || 'none'} (detection only)`}`);
    if (fitted) { say(`weights written to ${o.fit}: ${Object.entries(fitted.rules).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ×${v}`).join(', ') || 'all 1'}; held-out top-1 ${pct(fitted.heldOut.top1Before)} → ${pct(fitted.heldOut.top1After)}`); for (const w of fitted.warnings) say(`  warning: ${w}`); }
  }
  const minT1 = o['min-top1'] ? +o['min-top1'] : null, minT3 = o['min-top3'] ? +o['min-top3'] : null;
  if ((minT1 != null && sum.top1 < minT1) || (minT3 != null && sum.top3 < minT3)) { console.error(`below the bar: top-1 ${pct(sum.top1)} (min ${pct(minT1)}), top-3 ${pct(sum.top3)} (min ${pct(minT3)})`); process.exitCode = 5; }
}

// Pull a window from Prometheus and/or Loki into the store.
export async function pull(store, cmd, o) {
  const from = time(o.from), to = time(o.to) ?? Math.floor(Date.now() / 1000);
  if (from == null) throw new Error('pull needs --from (and --to, default now)');
  const out = {};
  if (o.prom && o.prom !== true) out.prometheus = await Pull.pullPrometheus(store, o.prom, { from, to, step: o.step ? +o.step : 60, headers: hdrs(o) });
  if (o.loki && o.loki !== true) out.loki = await Pull.pullLoki(store, o.loki, lokiQueries(o), { from, to, headers: hdrs(o) });
  if (!out.prometheus && !out.loki) throw new Error('pull --prom URL and/or --loki URL');
  if (J) { OUT.pulled = out; return; }
  if (out.prometheus) say(`Prometheus: ${out.prometheus.device} device samples, ${out.prometheus.serving} serving rows, ${out.prometheus.collective} NCCL collective rows (${out.prometheus.unmapped} unmapped series samples)`);
  if (out.loki) say(`Loki: ${out.loki.lines} lines → ${out.loki.logs} classified log records (${out.loki.unmatched} not matched)`);
}

// Backtest: pull each labeled incident's window from the fleet's own monitoring and score root-cause analysis on it.
export async function backtest(store, o) {
  if (!o.labels || o.labels === true) throw new Error('backtest --labels postmortems.jsonl --prom URL [--loki URL]');
  const labels = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
  const lookback = dur(o.lookback) ?? 26 * 3600, pulled = [];
  for (const l of labels) {
    const w = { from: l.incident.from - lookback, to: l.incident.to + 3600 }, got = { id: l.incident.id || `${l.cause}@${l.incident.from}` };
    if (o.prom && o.prom !== true) got.prometheus = await Pull.pullPrometheus(store, o.prom, Object.assign({ step: o.step ? +o.step : 60, headers: hdrs(o) }, w));
    if (o.loki && o.loki !== true) got.loki = await Pull.pullLoki(store, o.loki, lokiQueries(o), Object.assign({ headers: hdrs(o) }, w));
    pulled.push(got);
    if (!J) say(`  pulled ${got.id}: ${got.prometheus ? `${got.prometheus.device} device, ${got.prometheus.serving} serving` : ''}${got.loki ? `, ${got.loki.logs} log records` : ''}`);
  }
  const weights = o.weights && o.weights !== true ? JSON.parse(read(o.weights)) : undefined;
  const rows = Bench.evalLabels(store, labels, { weights }), sum = Bench.summarize(rows);
  if (J) { Object.assign(OUT, { backtest: { incidents: rows.length, top1: sum.top1, top3: sum.top3, componentTop1: sum.componentTop1, rows: rows.map(({ hyps, ...r }) => Object.assign(r, { ranked: hyps.slice(0, 3) })) }, pulled }); return; }
  const pc = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  say(`backtest on ${rows.length} confirmed incidents: top-1 ${pc(sum.top1)}, top-3 ${pc(sum.top3)}${sum.componentTop1 != null ? `, component ${pc(sum.componentTop1)}` : ''}`);
  for (const r of rows) say(`  ${r.rank === 1 ? 'ok  ' : 'MISS'} ${r.id}: confirmed ${r.cause}${r.component ? ` (${r.component})` : ''}; ranked ${r.rank ?? 'not found'}${r.rank !== 1 ? `, top: ${r.top || 'none'} ${r.hyps[0] ? r.hyps[0].score.toFixed(2) : ''}` : ''}`);
  if (sum.misses.length) say('A miss usually means a signal the store didn\'t get (no logs for that window, no topology) or a rule gap: check `fleetops data node` for the component and the window.');
}

// Game day: run a plan of injections on a test cluster one after another, then score them.
export async function gameday(store, cmd, o) {
  const planFile = cmd && cmd !== true ? cmd : o.plan;
  if (!planFile) throw new Error('gameday PLAN.json --allow FILE [--live] [--cooldown 900] [--prom URL --loki URL]');
  const plan = JSON.parse(read(planFile)), allow = Inject.loadAllow(o.allow && o.allow !== true ? o.allow : process.env.FLEETOPS_INJECT_ALLOW);
  const steps = plan.steps || plan, cool = o.cooldown ? +o.cooldown : plan.cooldownS ?? 900, live = !!o.live;
  const preps = steps.map(st => { const { fault, forS: _forS, ...params } = st; return { st, prep: Inject.prepare(fault, params, { allow }) }; }); // check every step before running any
  const done = [];
  for (const [i, { st, prep }] of preps.entries()) {
    if (!J) say(`step ${i + 1}/${preps.length}: ${prep.fault} on ${prep.nodes.join(', ') || prep.params.release || prep.params.host} for ${st.forS || 300} s (expect ${prep.expect || 'detection only'})`);
    const r = await Inject.run(prep, { live, forS: st.forS || 300, store, log: J ? () => {} : l => say('  ' + l.trim()) });
    done.push(r);
    if (live && i < preps.length - 1) { if (!J) say(`  cooling down ${cool} s`); await new Promise(res => setTimeout(res, cool * 1000)); }
  }
  if (!live) { if (!J) say('dry run: nothing was run. Add --live on a test cluster.'); else OUT.gameday = { dryRun: true, steps: preps.length }; return; }
  if (o.prom || o.loki) { const lo = Math.min(...done.map(d => d.from)) - 26 * 3600, hi = Math.max(...done.map(d => d.to || d.from)) + 3600; if (o.prom && o.prom !== true) await Pull.pullPrometheus(store, o.prom, { from: lo, to: hi, headers: hdrs(o) }); if (o.loki && o.loki !== true) await Pull.pullLoki(store, o.loki, lokiQueries(o), { from: lo, to: hi, headers: hdrs(o) }); }
  const r = Bench.evalInjections(store, { from: Math.min(...done.map(d => d.from)) - 1, to: Math.max(...done.map(d => d.to || d.from)) + 1 });
  if (J) { OUT.gameday = { injections: r.injections, detected: r.detected, delayP50: r.delayP50, delayP90: r.delayP90, top1: r.diagnosis.top1, rows: r.rows.map(({ hyps, ...x }) => x) }; return; }
  say(`game day: ${r.injections} injections, detected ${(r.detected * 100).toFixed(0)}%, alarm after ${r.delayP50 != null ? Math.round(r.delayP50 / 60) : '–'} min (p50); diagnosis top-1 ${r.diagnosis.incidents ? (r.diagnosis.top1 * 100).toFixed(0) + '%' : '–'}`);
  for (const x of r.rows) say(`  ${x.id}: ${x.detected ? `detected after ${Math.round(x.delayS / 60)} min` : 'not detected'}; ${x.cause ? `expected ${x.cause}, ranked ${x.rank ?? 'not found'}` : `top ${x.top}`}`);
}

// The incident workflow: open from detection, lifecycle, paging, timeline, postmortem.
export async function incidents(store, cmd, rest, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), id = rest[0];
  if (!cmd || cmd === 'list') {
    const all = Inc.state(store).filter(s => !opt('status') || s.status === o.status);
    if (J) { OUT.incidents = all.map(({ events, diagnosis, ...s }) => Object.assign(s, { top: diagnosis && diagnosis.hypotheses[0] && diagnosis.hypotheses[0].title })); return; }
    for (const s of all) say(`${s.severity}  ${s.status.padEnd(12)} ${s.id}${s.owner ? `  @${s.owner}` : ''}${s.cause ? `  cause: ${s.cause}` : s.diagnosis && s.diagnosis.hypotheses[0] ? `  likely: ${s.diagnosis.hypotheses[0].rule}` : ''}`);
    if (!all.length) say('no incidents');
    return;
  }
  if (cmd === 'open') {
    // detect in the window, diagnose each, open the new ones
    const from = time(o.from), to = time(o.to), weights = opt('weights') ? JSON.parse(read(o.weights)) : undefined;
    const incs = Detect.groupIncidents([...Detect.detectJobFailures(store, { from, to, binS: o.bin ? +o.bin : 600, minFailures: o['min-failures'] ? +o['min-failures'] : 20, where: whereFrom(o.where) }), ...Detect.detectServing(store, { from, to }), ...Detect.detectTraining(store, { from, to })]);
    const opened = [];
    for (const i of incs) { const d = RCA.diagnose(store, i, { weights }); if (!store.query('incident', { where: x => x.id === d.id }).length) store.append('incident', [d]); const e = Inc.open(store, d, { by: opt('by') || 'fleetops' }); if (e) opened.push(e); }
    if (J) { OUT.opened = opened; return; }
    say(`${incs.length} incident(s) detected, ${opened.length} new`); for (const e of opened) say(`  ${e.severity}  ${e.id}  ${e.summary}`);
    return;
  }
  if (!id) throw new Error(`incidents ${cmd} ID`);
  if (['acknowledge', 'ack', 'mitigate', 'resolve', 'reopen', 'assign', 'severity', 'note'].includes(cmd)) {
    const e = Inc.transition(store, id, cmd === 'ack' ? 'acknowledge' : cmd, { by: opt('by'), note: opt('note'), owner: opt('owner'), severity: opt('severity'), cause: opt('cause'), component: opt('component') });
    if (J) { OUT.event = e; return; }
    say(`${id}: ${e.event}${e.cause ? ` (confirmed cause ${e.cause}${e.component ? `, ${e.component}` : ''}: stored as a label for rca bench --from-incidents)` : ''}`);
    return;
  }
  if (cmd === 'show') {
    const s = Inc.state(store, id); if (!s) throw new Error(`no incident ${id}`);
    if (J) { OUT.incident = s; return; }
    say(`${s.id}  ${s.severity} · ${s.status}${s.owner ? ` · @${s.owner}` : ''}${s.cause ? ` · cause ${s.cause}` : ''}`);
    for (const e of s.events) say(`  ${fmt(e.t)}  ${e.event} by ${e.by}${e.note ? `: ${e.note}` : ''}`);
    if (s.diagnosis) { say('  ranked causes:'); s.diagnosis.hypotheses.slice(0, 3).forEach((h, i) => say(`    ${i + 1}. ${h.title} (${h.rule}, ${h.score.toFixed(2)})`)); }
    return;
  }
  if (cmd === 'timeline' || cmd === 'postmortem') {
    const out = cmd === 'timeline' ? Inc.timelineHtml(store, id) : Inc.postmortem(store, id);
    if (opt('out')) { fs.writeFileSync(o.out, out); say(`written to ${o.out}`); } else console.log(out);
    return;
  }
  if (cmd === 'page') {
    const provider = opt('to') || 'pagerduty', key = opt('key') || process.env[provider === 'opsgenie' ? 'OPSGENIE_API_KEY' : 'PAGERDUTY_ROUTING_KEY'];
    const r = await Inc.page(store, id, provider, opt('action') || 'trigger', { live: !!o.live, key, url: opt('url'), by: opt('by') || 'fleetops' });
    if (J) { OUT.page = r; return; }
    if (r.dryRun) { say(`dry run (--live to send): POST ${r.request.url}`); say(JSON.stringify(Object.assign({}, r.request.body, r.request.body.routing_key ? { routing_key: '…' } : {}), null, 1)); }
    else say(`${provider} ${o.action || 'trigger'}: HTTP ${r.status}${r.ok ? '' : ' (failed)'}`);
    return;
  }
  throw new Error(`unknown: incidents ${cmd}`);
}

// Fault injection on a test cluster (dry-run unless --live; targets must be in the --allow file).
export async function inject(store, cmd, o) {
  if (!cmd || cmd === 'list') {
    if (J) { OUT.faults = Object.fromEntries(Object.entries(Inject.FAULTS).map(([k, f]) => [k, { what: f.what, params: Object.keys(f.params), expect: f.expect, undo: !!f.revert, note: f.note }])); return; }
    for (const [k, f] of Object.entries(Inject.FAULTS)) say(`  ${k.padEnd(13)} ${f.what}\n                --${Object.keys(f.params).join(' --')}${f.revert ? ' [--for S]' : ''}   expect: ${f.expect || 'detection only'}${f.note ? `\n                ${f.note}` : ''}`);
    return;
  }
  const allowFile = o.allow && o.allow !== true ? o.allow : process.env.FLEETOPS_INJECT_ALLOW;
  if (!allowFile) throw new Error('--allow FILE (or FLEETOPS_INJECT_ALLOW): the test-cluster targets injection may touch, one per line');
  const params = Object.fromEntries(Object.entries(o).filter(([k]) => !['_', 'where', 'store', 'allow', 'live', 'for', 'json'].includes(k)));
  const prep = Inject.prepare(cmd, params, { allow: Inject.loadAllow(allowFile) });
  const r = await Inject.run(prep, { live: !!o.live, forS: o.for ? +o.for : 300, store, log: J ? () => {} : console.log });
  if (J) OUT.injection = r; else if (!r.dryRun) say(`${r.id}: ${r.applied ? 'applied' : 'FAILED to apply'}${r.reverted != null ? `, reverted ${r.reverted ? 'ok' : 'with errors'}` : ''}; label written to the store (expect ${r.expect || 'detection only'})`);
}
