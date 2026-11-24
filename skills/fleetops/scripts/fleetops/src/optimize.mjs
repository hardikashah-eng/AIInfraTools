// Optimization with safe execution: collect candidate changes, score them on cost, SLO, risk and constraints, pick a
// set that meets a goal, and roll it out in approved stages with an SLO check after each and automatic rollback.
//
// Candidates come from what the tools already compute:
//   gpu-health      right-sizing, scale-in, reclaiming idle allocations (from the store's device and placement data)
//   rca             retry storms: GPU-hours burned by one tenant's failing, retried jobs (from stored incidents)
//   fleetscope      the cheapest graph that still meets the SLO target, simulated on the (calibrated) graph
// Savings are not added blindly: candidates on the same resource exclude each other, and FleetScope changes to one
// graph come from one joint simulation.
//
// Rollout: every stage is an action in gpu-health's approval queue (same Store, same audit log, same `actions approve`
// and approval page). Applying a stage needs a person; rolling back does not. Commands run through gpu-health's
// executors: argv only, values checked, dry-run unless both `--live` and `policy.dryRun: false`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyze } from '../../gpu-health/src/analyze.mjs';
import { loadConfig as ghLoad, priceFor } from '../../gpu-health/src/config.mjs';
import { Store } from '../../gpu-health/src/actions.mjs';
import { run as runAction, fill, SAFE } from '../../gpu-health/src/executors.mjs';
import { toGpuHealth } from './export.mjs';
import { checkEgress } from './security.mjs';

const require = createRequire(import.meta.url);
const E = require('../../fleetscope/src/engine.js'), FO = require('../../fleetscope/src/optimize.js');
const RISK_W = { low: 1, medium: 0.8, high: 0.5 };
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// ---------- candidates ----------

// gpu-health's recommendations on the store's data, as candidates. Protected classes are listed but not selectable.
export function fromGpuHealth(store, { from, to, cfg = ghLoad(), protect = ['training'] } = {}) {
  const x = toGpuHealth(store, { from, to });
  if (!x.samples.length) return [];
  const a = analyze({ samples: x.samples, jobs: x.jobs, results: x.results, cfg, windowDays: Math.max(1, Math.round(((to ?? Math.max(...x.samples.map(s => s.t))) - (from ?? Math.min(...x.samples.map(s => s.t)))) / 86400)) });
  return a.recommendations.filter(r => r.weekly > 0).map(r => {
    const job = a.jobs.find(j => j.id === r.job) || {}, cls = r.class || job.class;
    const risk = r.action === 'reclaim-idle' && cls === 'interactive' ? 'low' : r.action === 'notify-owner' ? 'low' : cls === 'training' ? 'high' : 'medium';
    const replicasNow = r.replicas != null ? Math.max(1, Math.round(r.gpus / Math.max(1, job.gpusPerReplica || 1))) : null;
    return {
      id: `gpu-health:${r.action}:${r.job}`, source: 'gpu-health', kind: r.action, resource: `job:${r.job}`, title: `${r.action} ${r.job} (${r.usage})`,
      // a notification changes nothing, so it is never blocked by protection; its savings count only if the owner acts
      savingsWeekly: r.weekly, gpusFreed: r.gpusFreed || 0, confidence: r.confidence, risk, class: cls, protected: r.action !== 'notify-owner' && protect.includes(cls),
      ...(r.action === 'notify-owner' ? { realized: 'if the owner acts' } : {}),
      slo: cls === 'inference' ? { impact: 'check', note: 'serving capacity drops: verified by the stage SLO check' } : { impact: 'none expected' },
      detail: r.text, change: { action: r.action, job: r.job, namespace: job.namespace || 'default', replicasNow, replicasTarget: r.replicas, fraction: r.fraction },
    };
  });
}

// Retry storms found by rca. A cap of `maxAttempts` per job saves the GPU-hours of the failing attempts beyond it (the
// first attempts still run), per week, at `price` $/GPU-hour.
export function fromRetryStorms(store, { from, to, price = 4, maxAttempts = 2 } = {}) {
  const incidents = store.query('incident', { from, to }).filter(d => d.hypotheses && d.hypotheses[0] && d.hypotheses[0].rule === 'workload');
  if (!incidents.length) return [];
  const meta = new Map(store.query('placement', { to }).map(p => [p.job.split('#')[0], p]));
  const jobs = store.query('job', { from, to, where: j => (j.status === 'failed' || j.status === 'retried') && meta.has(j.job.split('#')[0]) });
  const byTenant = new Map();
  for (const d of incidents) {
    const m = d.hypotheses[0].title.match(/One (owner|namespace) \(([^)]+)\)/);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`, cur = byTenant.get(key) || { dim: m[1], tenant: m[2], incidents: [] };
    cur.incidents.push(d.id); byTenant.set(key, cur);
  }
  return [...byTenant.values()].map(b => {
    const mine = jobs.filter(j => { const p = meta.get(j.job.split('#')[0]) || {}; return (b.dim === 'owner' ? p.owner : p.namespace) === b.tenant; });
    // the window is this tenant's own failing jobs (other clusters' jobs in the same store don't stretch it)
    const ts = mine.map(j => j.t), days = Math.max(1, ((to ?? Math.max(...ts)) - (from ?? Math.min(...ts))) / 86400);
    const gh = j => (j.start != null ? Math.max(0, (j.end ?? j.t) - j.start) / 3600 * (j.gpus || (j.devices || []).length || 1) : 0);
    const byJob = new Map(); for (const j of mine) { const k = j.job.split('#')[0]; if (!byJob.has(k)) byJob.set(k, []); byJob.get(k).push(j); }
    let gpuHours = 0, avoidable = 0, beyond = 0;
    for (const list of byJob.values()) { list.sort((a, b) => (a.start ?? a.t) - (b.start ?? b.t)); list.forEach((j, i) => { gpuHours += gh(j); if (i >= maxAttempts) { avoidable += gh(j); beyond++; } }); }
    const perWeek = avoidable / days * 7;
    return {
      id: `retry-cap:${b.tenant}`, source: 'rca', kind: 'retry-cap', resource: `${b.dim}:${b.tenant}`, title: `Cap retries for ${b.dim} ${b.tenant} (${b.incidents.length} retry storms)`,
      savingsWeekly: perWeek * price, gpuHoursWeekly: perWeek, gpusFreed: perWeek / 168, risk: 'low', protected: false, slo: { impact: 'none expected', note: 'failing jobs only' },
      detail: `${mine.length} failed or retried attempts (${byJob.size} jobs) used ${gpuHours.toFixed(0)} GPU-hours in ${days.toFixed(1)} days; capping at ${maxAttempts} attempts per job avoids ${beyond} attempts, ${avoidable.toFixed(0)} GPU-hours (${perWeek.toFixed(0)}/week). Incidents: ${b.incidents.join(', ')}.`,
      change: { action: 'retry-cap', dim: b.dim, tenant: b.tenant, maxAttempts },
    };
  });
}

// The cheapest version of a FleetScope graph that still meets the SLO target (FleetScope's optimizer), as one candidate.
//   traceRows: real request rows (from the store) replayed by the graph's trace nodes.
export function fromFleetScope(graph, { target = 0.99, traceRows = null, maxEvals = 40 } = {}) {
  const lookup = (k, s) => (k === 'uploaded' && traceRows ? E.scaleTrace(traceRows, s || 1, 7) : E.scaleTrace(E.genTrace(k === 'uploaded' ? 'chat' : k, 7), s || 1, 7));
  const g = JSON.parse(JSON.stringify(graph));
  if (traceRows) for (const n of g.nodes.filter(x => x.type === 'trace')) n.cfg.trace = 'uploaded';
  const r = FO.optimize(g, { target, maxEvals, traceLookup: lookup, residency: false });
  if (!r.after || !(r.after.cost < r.before.cost) || !r.after.ok) return [];
  const pools = r.graph.nodes.filter(n => n.type === 'pool').map(n => { const b = g.nodes.find(x => x.id === n.id); const size = c => (c.autoscale ? c.max : c.instances); return { pool: n.id, name: n.cfg.name, gpu: n.cfg.gpu, from: size(b.cfg), to: size(n.cfg), gpuFrom: b.cfg.gpu }; }).filter(p => p.from !== p.to || p.gpu !== p.gpuFrom);
  return [{
    id: 'fleetscope:graph', source: 'fleetscope', kind: 'resize-pools', resource: 'graph', title: `Resize pools: ${pools.map(p => `${p.name} ${p.from}→${p.to}${p.gpu !== p.gpuFrom ? ` on ${p.gpu}` : ''}`).join(', ')}`,
    savingsWeekly: (r.before.cost - r.after.cost) * 168, risk: 'medium', protected: false,
    slo: { impact: r.after.slo >= target ? 'simulated within target' : 'misses target', before: r.before.slo, after: r.after.slo, target },
    detail: `FleetScope: $${r.before.cost.toFixed(2)}/h → $${r.after.cost.toFixed(2)}/h; SLO attainment ${(r.before.slo * 100).toFixed(1)}% → ${(r.after.slo * 100).toFixed(1)}% (target ${(target * 100).toFixed(1)}%). ${r.changes.join('; ')}`,
    change: { action: 'resize-pools', pools }, graph: r.graph,
  }];
}

const firm = list => list.filter(x => !x.realized).reduce((t, x) => t + x.savingsWeekly, 0);
// Pick a set: best savings per unit of risk first, one candidate per resource, protected classes and SLO misses out.
export function select(cands, { savePct, baselineWeekly, maxRisk = 'medium' } = {}) {
  const allowed = ['low', 'medium', 'high'].slice(0, ['low', 'medium', 'high'].indexOf(maxRisk) + 1);
  const ranked = cands.slice().sort((a, b) => b.savingsWeekly * RISK_W[b.risk] - a.savingsWeekly * RISK_W[a.risk]);
  const used = new Set(), chosen = [], skipped = [];
  for (const c of ranked) {
    const why = c.protected ? `protected class (${c.class})` : !allowed.includes(c.risk) ? `risk ${c.risk} above ${maxRisk}` : c.slo && c.slo.impact === 'misses target' ? 'misses the SLO target in simulation' : used.has(c.resource) ? `another candidate already changes ${c.resource}` : null;
    if (why) { skipped.push({ id: c.id, why }); continue; }
    used.add(c.resource); chosen.push(c);
    if (savePct && baselineWeekly && firm(chosen) >= savePct / 100 * baselineWeekly) break;
  }
  // savings that depend on someone else acting (owner notifications) are reported but don't count toward the goal
  const total = firm(chosen), potential = chosen.reduce((t, x) => t + x.savingsWeekly, 0);
  return { chosen, skipped, totalWeekly: total, potentialWeekly: potential, baselineWeekly, savedPct: baselineWeekly ? total / baselineWeekly : null, meetsGoal: savePct && baselineWeekly ? total >= savePct / 100 * baselineWeekly : null };
}

// ---------- rollout ----------

// Replica counts on the way down: the first step removes one (a canary), each later one up to half the whole gap.
export function shrinkSteps(from, to) {
  const out = [], step = Math.max(1, Math.ceil((from - to) / 2));
  for (let r = from - 1; r > to; r -= step) out.push(r);
  out.push(to); return out;
}

// Stages for each chosen candidate: commands to apply, commands to undo, and the SLO guard checked before the next stage.
//   deployments: { poolId: { namespace, deployment } } maps FleetScope pools to what to scale.
export function planRollout(sel, { id = `opt-${Date.now().toString(36)}`, guards = {}, deployments = {}, bakeS = 1800, cfg = ghLoad() } = {}) {
  const stages = [];
  // gpu-health's executor templates, filled with gpu-health's checks: a value that isn't a plain name stops the plan
  const tmpl = (kind, vars) => { const t = cfg.executors[kind]; return Array.isArray(t) ? t.map(a => fill(a, vars)) : null; };
  const safe = v => { if (!SAFE.test(String(v))) throw new Error(`unsafe value in stage command: ${JSON.stringify(v)}`); return String(v); };
  const webhook = text => ({ webhook: text });
  // owner notifications change nothing: one digest stage for all of them instead of one approval each
  const notes = sel.chosen.filter(c => c.change.action === 'notify-owner');
  if (notes.length) stages.push({ candidate: notes.map(c => c.id).join(','), title: `Notify ${notes.length} owner${notes.length > 1 ? 's' : ''} of idle allocations (up to $${Math.round(notes.reduce((t, c) => t + c.savingsWeekly, 0))}/week if they act)`,
    apply: webhook(notes.map(c => c.detail || c.title).join('\n')), rollback: null, guard: null, bakeS: 0 });
  for (const c of sel.chosen.filter(x => x.change.action !== 'notify-owner')) {
    const ch = c.change, guard = guards[c.resource] || guards.default || null;
    if (ch.action === 'scale-in' && ch.replicasNow && ch.replicasTarget != null) {
      const steps = shrinkSteps(ch.replicasNow, ch.replicasTarget);
      let prev = ch.replicasNow;
      for (const r of steps) { stages.push({ candidate: c.id, title: `${ch.job}: ${prev} → ${r} replicas`, apply: tmpl('scale-in', { namespace: ch.namespace, job: ch.job, replicas: r }), rollback: tmpl('scale-in', { namespace: ch.namespace, job: ch.job, replicas: prev }), guard, bakeS }); prev = r; } // undo goes back to the previous stage, not the start
    } else if (ch.action === 'resize-pools') {
      for (const p of ch.pools) {
        const d = deployments[p.pool], kube = n => [['kubectl', '-n', safe(d.namespace), 'scale', 'deployment', safe(d.deployment), `--replicas=${n}`]];
        // a GPU change is one stage (new hardware); shrinking the same hardware goes in steps, each with its own guard
        const steps = p.gpu !== p.gpuFrom || p.to > p.from ? [p.to] : shrinkSteps(p.from, p.to);
        let prev = p.from;
        for (const n of steps) {
          const apply = d && p.gpu === p.gpuFrom ? kube(n) : webhook(`Resize pool ${p.name} from ${prev} to ${n} instances${p.gpu !== p.gpuFrom ? ` on ${p.gpu}` : ''}.`);
          const rollback = d && p.gpu === p.gpuFrom ? kube(prev) : webhook(`Restore pool ${p.name} to ${prev} instances on ${p.gpuFrom}.`);
          stages.push({ candidate: c.id, title: `${p.name}: ${prev} → ${n}`, apply, rollback, guard: guards[`pool:${p.pool}`] || guard, bakeS });
          prev = n;
        }
      }
    } else if (ch.action === 'retry-cap') {
      stages.push({ candidate: c.id, title: c.title, apply: webhook(`Cap automatic retries for ${ch.dim} ${ch.tenant} at ${ch.maxAttempts} attempts per job and ask them to fix the failing jobs: ${c.detail}`), rollback: webhook(`Lift the retry cap for ${ch.dim} ${ch.tenant}.`), guard: null, bakeS: 0 });
    } else {
      stages.push({ candidate: c.id, title: c.title, apply: webhook(`${c.title}: ${c.detail}`), rollback: webhook(`Undo: ${c.title}.`), guard, bakeS });
    }
  }
  stages.forEach((s, i) => Object.assign(s, { n: i + 1, status: 'pending' }));
  return { id, createdAt: Math.floor(Date.now() / 1000), status: 'planned', totalWeekly: sel.totalWeekly, potentialWeekly: sel.potentialWeekly, candidates: sel.chosen.map(c => ({ id: c.id, title: c.title, savingsWeekly: c.savingsWeekly, risk: c.risk, slo: c.slo })), stages };
}

const actionId = (plan, s) => `rollout-stage:${plan.id}#${s.n}`;
// Put the plan's stages in gpu-health's approval queue (a state directory of its own), each needing approval.
export function enqueue(plan, stateDir, now = Math.floor(Date.now() / 1000)) {
  const st = new Store(stateDir);
  for (const s of plan.stages) {
    const id = actionId(plan, s);
    if (st.data.actions.some(a => a.id === id)) continue;
    const a = { id, kind: 'rollout-stage', target: `${plan.id}#${s.n}`, mode: 'approve', status: 'proposed', severity: 'medium', createdAt: now, updatedAt: now, lastSeen: now, analyzedAt: now,
      reason: `Stage ${s.n}/${plan.stages.length} of ${plan.id}: ${s.title}${s.guard ? ` (guard: ${s.guard.pool} ${s.guard.metric} ≤ ${s.guard.limit ?? `baseline +${Math.round((s.guard.maxRegression ?? 0.1) * 100)}%`}, bake ${s.bakeS}s)` : ''}`, params: {}, evidence: [] };
    st.data.actions.push(a); st.audit(a, 'created', { status: 'proposed', mode: 'approve', reason: a.reason });
  }
  st.save();
  return plan.stages.map(s => actionId(plan, s));
}

// Run commands for one stage through gpu-health's executor (dry-run unless both locks are open).
async function exec(stageCmd, cfg, { live, runner, poster, label }) {
  const kind = 'rollout-stage';
  const c = Object.assign({}, cfg, { executors: Object.assign({}, cfg.executors, { [kind]: Array.isArray(stageCmd) ? stageCmd : stageCmd && stageCmd.webhook ? { webhook: stageCmd.webhook } : 'webhook' }) });
  return runAction({ kind, reason: label, params: {} }, c, { dryRun: !(live && cfg.policy.dryRun === false), runner, poster });
}

// A Prometheus guard, read at check time: { prometheus: URL, query: PromQL, limit } (the value must stay ≤ limit).
export async function promGuard(guard, { fetcher } = {}) {
  const url = `${guard.prometheus.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(guard.query)}`;
  checkEgress(url);
  const j = await (fetcher || (u => fetch(u).then(r => r.json())))(url);
  const v = Number(((((j || {}).data || {}).result || [])[0] || {}).value?.[1]);
  if (!Number.isFinite(v)) return { ok: null, note: `no value from Prometheus for ${guard.query}` };
  return { ok: !(v > guard.limit), value: v, limit: guard.limit, note: `${guard.query} = ${v.toFixed(3)} vs limit ${guard.limit} (Prometheus, now)` };
}

// The guard: serving records for the pool after `since`, compared with the limit or with the same window before.
export function guardCheck(store, guard, since, now) {
  if (!guard) return { ok: true, note: 'no guard' };
  const after = store.query('serving', { from: since, to: now, where: r => r.pool === guard.pool }).map(r => r[guard.metric]);
  const before = store.query('serving', { from: since - Math.max(3600, now - since), to: since, where: r => r.pool === guard.pool }).map(r => r[guard.metric]);
  const a = median(after), b = median(before);
  if (!Number.isFinite(a)) return { ok: null, note: `no ${guard.metric} for ${guard.pool} since the stage ran` };
  const limit = guard.limit ?? (Number.isFinite(b) ? b * (1 + (guard.maxRegression ?? 0.1)) : NaN);
  return { ok: !(a > limit), value: a, baseline: b, limit, note: `${guard.pool} ${guard.metric} ${a.toFixed(3)} vs limit ${Number.isFinite(limit) ? limit.toFixed(3) : '–'}${Number.isFinite(b) ? ` (before ${b.toFixed(3)})` : ''}` };
}

// One step of the rollout. Checks the guard of the last applied stage once its bake time is over: a regression rolls
// back the stages applied since the last verified one, newest first, without waiting for approval (the fleet returns to
// the last state that passed its guard). Otherwise runs the next stage if it is approved.
export async function advance(plan, { store, stateDir, cfg = ghLoad(), live = false, now = Math.floor(Date.now() / 1000), runner, poster, fetcher } = {}) {
  const st = new Store(stateDir), log = [];
  if (['rolled-back', 'done'].includes(plan.status)) return { plan, log: [`plan is ${plan.status}`] };
  const applied = plan.stages.filter(s => s.status === 'applied');
  const last = applied[applied.length - 1];
  if (last) {
    if (now - last.appliedAt < last.bakeS) return { plan, log: [`stage ${last.n} baking until ${new Date((last.appliedAt + last.bakeS) * 1000).toISOString()}`] };
    const g = last.guard && last.guard.prometheus ? await promGuard(last.guard, { fetcher }) : guardCheck(store, last.guard, last.appliedAt, now);
    last.guardResult = g;
    if (g.ok === false) {
      for (const s of applied.slice().reverse()) {
        if (!s.rollback) { s.status = 'kept'; log.push(`stage ${s.n} has nothing to undo: ${s.title}`); continue; }
        const r = await exec(s.rollback, cfg, { live, runner, poster, label: `rollback stage ${s.n} of ${plan.id}: ${s.title}` });
        s.status = 'rolled-back'; s.rolledBackAt = now; s.rollbackResult = { dryRun: r.dryRun, ok: r.ok, commands: r.commands, text: r.text };
        const a = st.get(actionId(plan, s)); if (a) st.audit(a, 'rolled-back', { why: g.note, dryRun: r.dryRun, commands: r.commands });
        log.push(`rolled back stage ${s.n}${r.dryRun ? ' (dry-run)' : ''}: ${s.title}`);
      }
      plan.status = 'rolled-back'; plan.rollbackReason = g.note; st.save();
      return { plan, log: [`guard failed after stage ${last.n}: ${g.note}`, ...log] };
    }
    if (g.ok === null) return { plan, log: [`stage ${last.n}: ${g.note}; waiting for data before going on`] };
    last.status = 'verified'; log.push(`stage ${last.n} verified: ${g.note}`);
  }
  const next = plan.stages.find(s => s.status === 'pending');
  if (!next) { plan.status = 'done'; st.save(); return { plan, log: [...log, 'all stages applied and verified'] }; }
  const a = st.get(actionId(plan, next));
  if (!a || a.status !== 'approved') { plan.status = 'waiting-approval'; return { plan, log: [...log, `stage ${next.n} waits for approval: gpu-health actions approve ${actionId(plan, next)} --by NAME --state ${stateDir}`] }; }
  const r = await exec(next.apply, cfg, { live, runner, poster, label: `stage ${next.n} of ${plan.id}: ${next.title}` });
  next.status = r.ok ? 'applied' : 'failed'; next.appliedAt = now; next.applyResult = { dryRun: r.dryRun, ok: r.ok, commands: r.commands, text: r.text, output: r.output };
  Object.assign(a, { status: r.dryRun ? 'approved' : r.ok ? 'executed' : 'failed', executedAt: now, updatedAt: now });
  st.audit(a, r.dryRun ? 'dry-run' : r.ok ? 'executed' : 'failed', { commands: r.commands, text: r.text });
  st.save();
  plan.status = r.ok ? 'rolling-out' : 'failed';
  return { plan, log: [...log, `stage ${next.n} ${r.dryRun ? 'dry-run' : r.ok ? 'applied' : 'failed'}: ${next.title}`] };
}

// After the rollout: allocated GPU-hours and guard breaches per day, before vs after.
export function verify(plan, store, { days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  const start = Math.min(...plan.stages.filter(s => s.appliedAt).map(s => s.appliedAt));
  if (!Number.isFinite(start)) return { verified: false, note: 'no stage was applied' };
  const win = Math.min(days * 86400, now - start);
  // allocated GPU-hours: each placement's overlap with the window × its devices
  const placements = store.query('placement', { to: now });
  const gpuHours = (a, b) => placements.reduce((t, p) => { const s = Math.max(a, p.start ?? p.t), e = Math.min(b, p.end ?? now); return e > s ? t + (e - s) / 3600 * ((p.devices || []).length || p.gpuCount || 1) : t; }, 0);
  const guards = plan.stages.map(s => s.guard).filter(Boolean);
  const breaches = (a, b) => guards.reduce((t, g) => t + store.query('serving', { from: a, to: b, where: r => r.pool === g.pool }).filter(r => g.limit != null && r[g.metric] > g.limit).length, 0);
  const before = { gpuHours: gpuHours(start - win, start), breaches: breaches(start - win, start) }, after = { gpuHours: gpuHours(start, start + win), breaches: breaches(start, start + win) };
  return { window: win, before, after, gpuHoursChange: before.gpuHours ? (after.gpuHours - before.gpuHours) / before.gpuHours : null, sloBreachesChange: after.breaches - before.breaches,
    verified: after.breaches <= before.breaches && before.gpuHours > 0 && after.gpuHours < before.gpuHours };
}

export const savePlan = (file, plan) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, JSON.stringify(plan, null, 1)); };
export { priceFor };
