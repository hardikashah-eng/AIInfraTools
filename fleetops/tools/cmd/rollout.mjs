// fleetops CLI: rollout (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import * as Sec from '../../src/security.mjs';
import { postWebhook } from '../../../gpu-health/src/executors.mjs';
import { toFleetScopeTrace } from '../../src/export.mjs';
import * as Opt from '../../src/optimize.mjs';
import * as RO from '../../src/rollout.mjs';
import { loadConfig as ghConfig } from '../../../gpu-health/src/config.mjs';
import { FSIN, J, OUT, say, read, time, pc, money } from './common.mjs';
import { HELP } from './help.mjs';
import { baselineWeekly } from './capacity.mjs';

export async function rolloutCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined);
  const state = opt('state') || path.join(store.dir, 'rollouts', 'state'), cfg = ghConfig(json('config'));
  const hours = s => (s == null ? undefined : /h$/.test(s) ? parseFloat(s) * 3600 : /m$/.test(s) ? parseFloat(s) * 60 : +s);
  if (cmd === 'demo') {
    const d = RO.synth({ bad: !o.good }); for (const [k, rs] of Object.entries(d.records)) store.append(k, rs);
    if (J) { OUT.demo = { canary: d.canary, canaryAt: d.canaryAt, end: d.end, old: d.old, new: d.neu, bad: !o.good }; return; }
    return say(`demo fleet in ${store.dir}: 24 H100 nodes on driver ${d.old}; ${d.canary.join(' and ')} moved to ${d.neu} on ${new Date(d.canaryAt * 1000).toISOString().slice(0, 16)}${o.good ? '' : ' (a bad driver)'}\ntry: fleetops rollout check --field driver --version ${d.neu} --from ${d.canaryAt} --to ${d.end} --store ${store.dir}`);
  }
  if (cmd === 'check') {
    if (!opt('field') || !opt('version')) throw new Error('--field driver --version V [--from T] [--to T]');
    const to = time(opt('to')) ?? now, g = RO.compare(store, { field: opt('field'), version: opt('version'), since: time(opt('from')) ?? to - 7 * 86400, now: to, policy: json('policy') });
    if (J) { OUT.comparison = g; if (g.ok === false) process.exitCode = 4; return; }
    say(`${opt('field')} ${opt('version')} on ${(g.treated || []).length} node(s) vs ${g.control ?? 0} on other versions: ${g.ok === false ? 'REGRESSION' : g.ok ? 'no regression' : 'not enough data yet'}`);
    for (const m of g.metrics) say(`  ${m.regression ? 'WORSE' : 'ok   '} ${m.name}: ×${m.ratio.toFixed(2)}${m.p != null ? ` (p ${m.p < 1e-4 ? '<1e-4' : m.p.toFixed(4)})` : ''}  ${m.detail}`);
    if (g.ok == null) say(`  ${g.note}`);
    if (g.ok === false) process.exitCode = 4;
    return;
  }
  if (cmd === 'plan') {
    if (!opt('out')) throw new Error('--out rollout.json');
    const tmpl = k => (opt(k) ? [opt(k).split(' ').filter(Boolean)] : undefined);   // "ansible-playbook driver.yml -l {node} -e v={version}"
    const p = RO.plan(store, { field: opt('field'), version: opt('version'), nodes: opt('nodes'), sku: opt('sku'), canary: opt('canary') ?? 2, waves: opt('waves') ? opt('waves').split(',') : undefined, bakeS: hours(opt('bake')), apply: tmpl('apply'), rollback: tmpl('rollback'), id: opt('id'), now, policy: json('policy') });
    p.state = state; const ids = RO.enqueue(p, state, now); fs.writeFileSync(opt('out'), JSON.stringify(p, null, 1));
    if (J) { OUT.plan = p; OUT.queued = ids; return; }
    say(`${p.id}: ${p.field} ${p.from} → ${p.version} on ${p.stages.reduce((a, s) => a + s.nodes.length, 0)} node(s), ${p.stages.length} wave(s), each queued for approval in ${state}:`);
    for (const s of p.stages) say(`  ${s.n}. ${s.title}: ${s.nodes.slice(0, 6).join(', ')}${s.nodes.length > 6 ? ` … +${s.nodes.length - 6}` : ''}  (bake ${(s.bakeS / 3600).toFixed(1)} h)`);
    return say(`then: gpu-health actions approve ${ids[0]} --by NAME --state ${state}; fleetops rollout advance --plan ${opt('out')}`);
  }
  const planFile = opt('plan'); if (!planFile) throw new Error('fleetops rollout demo | check | plan | advance --plan FILE | status --plan FILE');
  const p = JSON.parse(read(planFile));
  if (cmd === 'advance') {
    const poster = (url, text) => { Sec.checkEgress(url); return postWebhook(url, text); };
    const r = await RO.advance(p, { store, stateDir: opt('state') || p.state || state, cfg, live: !!o.live, now, poster });
    fs.writeFileSync(planFile, JSON.stringify(p, null, 1));
    if (J) { OUT.plan = p; OUT.log = r.log; return; }
    for (const l of r.log) say(l); say(`${p.id}: ${p.status}`);
    if (p.status === 'halted') process.exitCode = 4;
    return;
  }
  if (cmd === 'status') { if (J) { OUT.plan = p; return; } say(`${p.id}: ${p.status}${p.haltReason ? ` — ${p.haltReason}` : ''}`); for (const s of p.stages) say(`  ${s.n}. ${s.status.padEnd(11)} ${s.title}${s.guardResult ? `  [${s.guardResult.note}]` : ''}`); return; }
  throw new Error(`unknown: rollout ${cmd}`);
}

export async function optimize(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined);
  const now = o.now ? +o.now : Math.floor(Date.now() / 1000), price = o.price ? +o.price : 4;
  const state = opt('state') || path.join(store.dir, 'rollouts', 'state');
  const cfg = ghConfig(json('config'));
  if (cmd === 'candidates') {
    const from = time(o.from), to = time(o.to);
    const cands = [...Opt.fromGpuHealth(store, { from, to, cfg }), ...Opt.fromRetryStorms(store, { from, to, price, maxAttempts: o['max-attempts'] ? +o['max-attempts'] : 2 })];
    if (opt('graph')) {
      // the store's requests go through the same CSV and parser as FleetScope's own --trace option
      const rows = opt('trace-pool') ? FSIN.parseTrace(toFleetScopeTrace(store, { pool: o['trace-pool'], from: time(o['trace-from']), to: time(o['trace-to']) })).trace : null;
      if (rows && !rows.length) throw new Error(`no request records for pool ${o['trace-pool']}`);
      if (rows) say(`replaying ${rows.length} requests of ${o['trace-pool']} through the graph`);
      cands.push(...Opt.fromFleetScope(json('graph'), { target: o.target ? +o.target : 0.99, traceRows: rows }));
    }
    const out = { from, to, price, baselineWeekly: baselineWeekly(store, from, to, price), candidates: cands.map(c => Object.assign({}, c, { graph: undefined })) };
    if (opt('out')) fs.writeFileSync(o.out, JSON.stringify(out, null, 1));
    if (J) { Object.assign(OUT, out); return; }
    say(`${cands.length} candidates (fleet ≈ ${money(out.baselineWeekly)}/week at $${price}/GPU-hour)`);
    say('  savings/week  risk    SLO                       candidate');
    for (const c of cands.slice().sort((a, b) => b.savingsWeekly - a.savingsWeekly)) say(`  ${money(c.savingsWeekly).padStart(11)}  ${c.risk.padEnd(6)}  ${(c.protected ? 'PROTECTED' : c.slo.impact).padEnd(24)}  ${c.title}${c.realized ? ` (${c.realized})` : ''}`);
    if (opt('out')) say(`written to ${o.out}`);
    return;
  }
  if (cmd === 'plan') {
    const c = json('candidates'); if (!c || !opt('out')) throw new Error('--candidates FILE --out plan.json');
    const sel = Opt.select(c.candidates, { savePct: o['save-pct'] ? +o['save-pct'] : undefined, baselineWeekly: o['baseline-weekly'] ? +o['baseline-weekly'] : c.baselineWeekly, maxRisk: opt('max-risk') || 'medium' });
    const plan = Opt.planRollout(sel, { guards: json('guards') || {}, deployments: json('deployments') || {}, bakeS: o.bake ? +o.bake : 1800, cfg });
    plan.goal = { savePct: o['save-pct'] ? +o['save-pct'] : null, baselineWeekly: sel.baselineWeekly, savedPct: sel.savedPct, meetsGoal: sel.meetsGoal }; plan.skipped = sel.skipped; plan.state = state;
    const ids = Opt.enqueue(plan, state, now);
    Opt.savePlan(o.out, plan);
    if (J) { OUT.plan = plan; OUT.queued = ids; return; }
    say(`plan ${plan.id}: ${money(plan.totalWeekly)}/week${plan.potentialWeekly > plan.totalWeekly ? ` firm, up to ${money(plan.potentialWeekly)} if notified owners act` : ''}${sel.savedPct != null ? ` (${(sel.savedPct * 100).toFixed(1)}% of ${money(sel.baselineWeekly)})` : ''}${plan.goal.savePct ? ` — goal ${plan.goal.savePct}% ${sel.meetsGoal ? 'met' : 'NOT met'}` : ''}`);
    const many = plan.candidates.length > 8;
    for (const x of many ? plan.candidates.slice(0, 6) : plan.candidates) say(`  + ${x.title}  ${money(x.savingsWeekly)}/week, risk ${x.risk}`);
    if (many) say(`  + … ${plan.candidates.length - 6} more`);
    for (const x of sel.skipped.slice(0, 8)) say(`  - ${x.id}: ${x.why}`);
    if (sel.skipped.length > 8) say(`  - … ${sel.skipped.length - 8} more skipped`);
    say(`${plan.stages.length} stages queued for approval in ${state}:`);
    plan.stages.forEach((st, i) => say(`  ${st.n}. ${st.title}${st.guard ? `  [guard: pool ${st.guard.pool} ${st.guard.metric} ≤ ${st.guard.limit ?? `+${Math.round((st.guard.maxRegression ?? 0.1) * 100)}%`}, bake ${st.bakeS}s]` : ''}\n     approve: gpu-health actions approve ${ids[i]} --by NAME --state ${state}`));
    say(`then: fleetops optimize advance --plan ${o.out}`);
    return;
  }
  const planFile = opt('plan'); if (!planFile) throw new Error('--plan plan.json');
  const plan = JSON.parse(read(planFile));
  if (cmd === 'advance') {
    const poster = (url, text) => { Sec.checkEgress(url); return postWebhook(url, text); }; // gpu-health's webhook (Lark-aware), behind the egress allowlist
    const r = await Opt.advance(plan, { store, stateDir: opt('state') || plan.state || state, cfg, live: !!o.live, now, poster });
    Opt.savePlan(planFile, plan);
    if (J) { OUT.plan = plan; OUT.log = r.log; return; }
    for (const l of r.log) say(l);
    say(`plan ${plan.id}: ${plan.status}`);
    if (plan.status === 'rolled-back') process.exitCode = 4;
    return;
  }
  if (cmd === 'verify') {
    const v = Opt.verify(plan, store, { days: o.days ? +o.days : 7, now });
    store.append('optimization', [Object.assign({ t: now, id: plan.id, status: plan.status, expectedWeekly: plan.totalWeekly }, v)]);
    if (J) { OUT.verification = v; return; }
    if (!v.window) return say(v.note);
    say(`${plan.id}: allocated GPU-hours ${v.before.gpuHours.toFixed(0)} → ${v.after.gpuHours.toFixed(0)} (${pc(v.gpuHoursChange)}) over ${(v.window / 86400).toFixed(1)} days; guard breaches ${v.before.breaches} → ${v.after.breaches}: ${v.verified ? 'verified' : 'NOT verified'}`);
    return;
  }
  throw new Error(`unknown: optimize ${cmd}\n\n${HELP}`);
}
