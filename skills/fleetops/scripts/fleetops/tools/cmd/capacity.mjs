// fleetops CLI: capacity (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import { run as runAction } from '../../../gpu-health/src/executors.mjs';
import { Store as GhStore } from '../../../gpu-health/src/actions.mjs';
import * as Opt from '../../src/optimize.mjs';
import * as Power from '../../src/power.mjs';
import * as Adm from '../../src/admission.mjs';
import { loadConfig as ghConfig } from '../../../gpu-health/src/config.mjs';
import { J, OUT, say, read, time } from './common.mjs';

// What the fleet costs per week now: GPUs in the inventory (or, without one, distinct GPUs seen) × 168 h × price.
export function baselineWeekly(store, from, to, price) {
  const nodes = new Map(); for (const r of store.scan('inventory', { to })) if (r.kind !== 'cpu') nodes.set(r.node, r.devices || 0);
  let n = [...nodes.values()].reduce((a, b) => a + b, 0);
  if (!n) { const g = new Set(); for (const r of store.scan('device', { from, to })) g.add(`${r.node}:${r.gpu}`); n = g.size; }
  return n * 168 * price;
}
export async function powerCmd(store, cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const to = time(opt('to')) ?? now, from = time(opt('from')) ?? to - (opt('hours') ? +opt('hours') * 3600 : 24 * 3600);
  const opts = Object.assign({}, json('options'), opt('fit-alpha') ? { alphaCompute: +opt('fit-alpha') } : {}, opt('max-slowdown') ? { maxSlowdown: +opt('max-slowdown') } : {}, opt('gpu-share') ? { gpuShare: +opt('gpu-share') } : {});
  const kw = v => (v == null || !Number.isFinite(v) ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  if (cmd === 'demo') {
    const d = Power.synth(); for (const [k, rs] of Object.entries(d.records)) store.append(k, rs);
    const bf = path.join(store.dir, 'power-budgets.json'); fs.writeFileSync(bf, JSON.stringify(d.budgets, null, 1));
    if (J) { OUT.demo = { from: d.from, to: d.to, budgets: bf }; return; }
    return say(`demo in ${store.dir}: two racks of four 8×H100 nodes, rack r1 over its 24 kW budget; budgets in ${bf}\ntry: fleetops power report --budgets ${bf} --from ${d.from} --to ${d.to} --store ${store.dir}\n     fleetops power plan --budgets ${bf} --from ${d.from} --to ${d.to} --out plan.json --store ${store.dir}`);
  }
  if (cmd === 'report') {
    const r = Power.report(store, { from, to, budgets: json('budgets') || {}, opts });
    if (J) { OUT.power = r; return; }
    if (!r.groups.length) return say(r.note);
    say(`${r.nodes} node(s), ${r.bins} × ${r.binS / 60}-min bins; ${r.note}\n`);
    say(`${'group'.padEnd(18)} ${'nodes'.padStart(5)} ${'avg kW'.padStart(8)} ${'p99 kW'.padStart(8)} ${'budget'.padStart(8)} ${'headroom'.padStart(9)}  more nodes`);
    for (const g of r.groups) say(`${g.group.padEnd(18)} ${String(g.nodes).padStart(5)} ${kw(g.avgKw).padStart(8)} ${kw(g.p99Kw).padStart(8)} ${kw(g.budgetKw).padStart(8)} ${(g.headroomKw == null ? '–' : (g.headroomKw < 0 ? 'OVER ' : '') + kw(g.headroomKw)).padStart(9)}  ${g.moreNodes == null ? '' : `${g.moreNodes} × ${g.sku} at ${kw(g.nodeKwP95)} kW (p95)`}${g.overBudgetShare ? `  over ${Math.round(g.overBudgetShare * 100)}% of the time` : ''}`);
    return;
  }
  if (cmd === 'jobs' || cmd === 'predict') {
    let js = Power.jobs(store, { from, to, opts }); if (opt('job')) js = js.filter(j => j.job === opt('job'));
    const cap = opt('cap'), capW = j => (!cap ? null : /%$/.test(cap) ? parseFloat(cap) / 100 * j.limitW : parseFloat(cap));
    if (cmd === 'predict' && !cap) throw new Error('--cap 70% or --cap 500W');
    const rows = js.map(j => Object.assign({}, j, { draws: undefined, devices: undefined }, cap ? { prediction: Power.predict(j, capW(j), opts) } : {}));
    if (cmd === 'predict') rows.sort((a, b) => a.prediction.slowdown - b.prediction.slowdown);
    if (J) { OUT.jobs = rows; return; }
    for (const j of rows) say(`${j.job.padEnd(22)} ${String(j.gpus).padStart(4)} GPU  draw ${kw(j.drawP50)}/${kw(j.drawP95)} W (p50/p95) of ${kw(j.limitW)}  compute-bound ${Math.round(j.computeBound * 100)}%  at limit ${Math.round(j.atLimitShare * 100)}%${j.stepsPerKWh ? `  ${kw(j.stepsPerKWh)} steps/kWh` : ''}${j.prediction ? `\n${''.padEnd(24)}cap ${Math.round(j.prediction.capW)} W → ${(j.prediction.slowdown * 100).toFixed(1)}% slower, −${kw(j.prediction.savedKw)} kW IT${j.prediction.note ? ` (${j.prediction.note})` : ''}` : ''}`);
    return;
  }
  if (cmd === 'fit') { const f = Power.fit(store, { from: time(opt('from')), to }); if (J) { OUT.fit = f; return; } return say(f.alphaCompute == null ? f.note : `${f.note}\nuse it: --fit-alpha ${f.alphaCompute.toFixed(2)} (or options.alphaCompute)`); }
  if (cmd === 'plan') {
    if (!opt('out')) throw new Error('--out plan.json');
    const cfg = ghConfig(json('config')), state = opt('state') || path.join(store.dir, 'rollouts', 'state');
    const p = Power.plan(store, { from, to, budgets: json('budgets') || {}, saveKw: opt('save-kw') ? +opt('save-kw') : null, opts, protect: (opt('protect') || '').split(',').filter(Boolean), cfg, id: opt('id') });
    const guards = json('guards') || {}; for (const s of p.stages) s.guard = guards[s.candidate] || guards.default || null;
    p.state = state; const ids = Opt.enqueue(p, state, now); Opt.savePlan(opt('out'), p);
    if (J) { OUT.plan = p; OUT.queued = ids; return; }
    if (!p.groups.length) return say('every group with a budget is under it: nothing to cap');
    for (const g of p.groups) say(`${g.group}: p99 ${kw(g.p99Kw)} kW against ${kw(g.budgetKw)} → ${g.met ? 'under budget' : 'STILL OVER'} with caps saving ${kw(g.savedKw)} of ${kw(g.needKw)} kW needed`);
    for (const c of p.caps) say(`  ${c.job.padEnd(22)} ${c.class || ''} ${c.capW} W (${Math.round(c.capPct * 100)}% of ${Math.round(c.limitW)}) on ${c.gpus} GPU(s): ${(c.predictedSlowdown * 100).toFixed(1)}% slower, −${kw(c.savedKw)} kW (draws ${kw(c.drawP95)} W p95, ${Math.round(c.computeBound * 100)}% compute-bound)`);
    say(`${p.stages.length} stage(s) queued for approval in ${state}; then: fleetops optimize advance --plan ${opt('out')}`);
    say(`model: slowdown = (draw/cap)^α, α ${p.assumptions.alphaCompute} compute-bound … ${p.assumptions.alphaMemory} memory-bound${opt('fit-alpha') ? ' (fitted)' : ' (defaults: run fleetops power fit to measure)'}`);
    return;
  }
  if (cmd === 'verify') {
    const p = JSON.parse(read(opt('plan') || '')), v = Power.verify(store, p, { now, opts });
    if (J) { OUT.verification = v; return; }
    if (!v.groups) return say(v.note);
    for (const g of v.groups) say(`${g.group}: p99 ${kw(g.p99Before)} → ${kw(g.p99After)} kW (saved ${kw(g.measuredSavedKw)}, predicted ${kw(g.predictedSavedKw)})`);
    for (const j of v.jobs) say(`  ${j.job}: ${j.measuredSlowdown == null ? 'no step records' : `${(j.measuredSlowdown * 100).toFixed(1)}% slower`} (predicted ${(j.predictedSlowdown * 100).toFixed(1)}%)`);
    return;
  }
  throw new Error('fleetops power report | jobs | predict | fit | plan | verify | demo');
}

export async function admitCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const policy = opt('policy') ? JSON.parse(read(opt('policy'))) : {}, state = opt('state') || path.join(store.dir, 'rollouts', 'state'), cfg = ghConfig(opt('config') ? JSON.parse(read(opt('config'))) : undefined);
  if (cmd === 'pending') {
    const p = Adm.pending(store, { now, policy }); if (J) { OUT.pending = p; return; }
    if (!p.length) return say('no nodes waiting for admission');
    for (const x of p) say(`${x.node}${x.sku ? ` (${x.sku})` : ''}: ${x.reasons.join('; ')}${x.last ? ` — last verdict ${x.last.verdict}` : ''}`);
    return say(`\nfleetops admit check NODE   (run tools/admit-node.sh on the node and import its output first)`);
  }
  const node = o._[2]; if (!node) throw new Error('fleetops admit check|apply NODE');
  const v = Adm.evaluate(store, node, { now, policy });
  if (cmd === 'check') {
    if (o.record) store.append('admission', [{ t: now, node, verdict: v.verdict, failed: v.failed, missing: v.missing, sku: v.sku, source: 'fleetops-admit' }]);
    if (v.verdict === 'reject') process.exitCode = 3; else if (v.verdict === 'incomplete') process.exitCode = 2;
    if (J) { OUT.admission = v; return; }
    say(`${node}${v.sku ? ` (${v.sku})` : ''}: ${v.verdict.toUpperCase()}`);
    for (const c of v.checks) say(`  ${c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'FAIL' : 'miss'}  ${c.name.padEnd(11)} ${c.evidence}${c.fix ? `\n        → ${c.fix}` : ''}`);
    return;
  }
  if (cmd === 'apply') {
    // admitting releases the node and needs a person's approval in gpu-health's queue; rejecting keeps it out
    const a = Adm.gateAction(v, now); if (!a) { if (J) { OUT.admission = v; return; } return say(`${node}: incomplete (${v.missing.join(', ')}); nothing to apply`); }
    a.mode = (cfg.policy.actions || {})[a.kind] || (a.kind === 'admit-node' ? 'approve' : 'auto');
    const st = new GhStore(state), prior = st.data.actions.find(x => x.kind === a.kind && x.node === node && ['proposed', 'approved'].includes(x.status));
    const act = prior || Object.assign(a, { status: a.mode === 'auto' ? 'approved' : 'proposed' });
    if (!prior) { st.data.actions.push(act); st.audit(act, 'created', { status: act.status, mode: act.mode, reason: act.reason }); }
    store.append('admission', [{ t: now, node, verdict: v.verdict, failed: v.failed, missing: v.missing, sku: v.sku, source: 'fleetops-admit' }]);
    let r = null;
    if (act.status === 'approved') {
      r = await runAction(act, cfg, { dryRun: !(o.live && cfg.policy.dryRun === false) });
      Object.assign(act, { status: r.dryRun ? 'approved' : r.ok ? 'executed' : 'failed', updatedAt: now }); st.audit(act, r.dryRun ? 'dry-run' : r.ok ? 'executed' : 'failed', { commands: r.commands, text: r.text });
    }
    st.save();
    if (J) { OUT.admission = v; OUT.action = act; OUT.result = r; return; }
    say(`${node}: ${v.verdict}`);
    if (!r) return say(`  ${act.kind} waits for approval: gpu-health actions approve ${act.id} --by NAME --state ${state}, then run this again`);
    say(`  ${act.kind} ${r.dryRun ? 'dry run' : r.ok ? 'done' : 'failed'}: ${(r.commands || []).map(c => c.join(' ')).join(' && ') || r.text}`);
    if (r.dryRun) say('  (add --live, with policy.dryRun false in the gpu-health config, to run it)');
    return;
  }
  throw new Error('fleetops admit pending | check NODE [--record] | apply NODE [--live]');
}
