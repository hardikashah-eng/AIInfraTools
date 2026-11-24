// The live agent: watches the fleet as data streams in, finds what is going wrong in training and inference, and
// mitigates it within the limits a person on call would be held to.
//
// Each tick (every --interval seconds, inside `fleetops serve --agent` or as `fleetops agent`):
//   1. Devices: gpu-health's analysis over the recent device records (states, faults, flakiness history).
//   2. Incidents: job-failure, latency, training-slow and training-hang detection over the window, each diagnosed.
//   3. Decide: the top cause's playbook gives actions; the confidence and the guardrails decide how far it may go:
//        high confidence     the playbook as the policy allows (auto actions run, the rest wait for a person)
//        medium confidence   contain only: actions outside the contain list wait for a person
//        low / none          nothing is done: the incident is opened and a person is paged
//        monitoring gap      frozen: only exporter checks, never device actions
//      The agent can only lower an action's autonomy (auto → approve), never raise it.
//   4. Queue and run: one merge into gpu-health's action queue, then the approved actions run, two locks as always
//      (agent --live AND policy.dryRun false). Autonomous runs are capped per hour; a PAUSE file stops all of them.
//   5. Verify: verifyAfter seconds after acting, detection runs again on the time since. Cleared → the incident is
//      marked mitigated; still there → a person is paged. In a dry run the same check says whether it cleared alone.
// Every decision is a line in <state>/agent.jsonl and a note on the incident.

import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../../gpu-health/src/analyze.mjs';
import { loadConfig, modeFor } from '../../gpu-health/src/config.mjs';
import { Store as Queue } from '../../gpu-health/src/actions.mjs';
import { recordTransitions, recordResults } from '../../gpu-health/src/flakiness.mjs';
import { persistable } from '../../gpu-health/src/health.mjs';
import { toGpuHealth } from './export.mjs';
import * as Detect from './detect.mjs';
import { diagnose } from './rca.mjs';
import * as Inc from './incidents.mjs';

export const AGENT_DEFAULTS = {
  intervalS: 30,           // seconds between ticks
  windowS: 3600,           // incidents are looked for in the last hour
  deviceWindowS: 6 * 3600, // device health looks at the last 6 hours (gpu-health needs a few hourly windows)
  minFailures: 5,          // job failures needed for a job-failure incident
  binS: 600,               // job-failure bins (as `rca detect`)
  pools: {},               // serving pools the data can't size: { chat: { namespace: 'serving', replicas: 8 } }
  targets: {},             // latency targets per pool: { chat: { ttftP99: 1.0 } }
  verifyAfterS: 600,       // check whether the symptom cleared this long after acting
  maxAutoActionsPerHour: 6,// autonomous live runs across all ticks (person-approved actions don't count)
  maxCordonShare: 0.1,     // the agent never cordons more than this share of the nodes on its own
  // actions that only stop new work or tell people: allowed on medium confidence
  contain: ['cordon-node', 'avoid-large-jobs', 'notify-owner', 'run-diag', 'deep-diag-next-boundary', 'link-check', 'hold-rollout', 'exporter-check', 'config-reset', 'quarantine'],
  page: null,              // { to: 'pagerduty'|'opsgenie'|'webhook', key, url, minSeverity: 'sev2' }
};
const BY = 'fleetops-agent';
const SEV = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const uniq = a => [...new Set(a.filter(x => x != null && x !== ''))];

// ---------- the playbook: what to do about each cause ----------
// Each entry returns actions in gpu-health's shape ({ kind, target, node?, gpu?, job?, class?, params, reason, severity }).
// ctx: { jobsOn(node) → [{ job, class, namespace }], pool(p) → { namespace, replicas }, inc, h }
const gpuOf = k => { const i = k.lastIndexOf('/'); return { node: k.slice(0, i), gpu: k.slice(i + 1) }; };
function moveWork(ctx, node, gpu, why) {
  return ctx.jobsOn(node).flatMap(j => j.class === 'training'
    ? [{ kind: 'swap-at-checkpoint', job: j.job, class: 'training', node, gpu: gpu ?? '0', target: `${j.job}@${node}/${gpu ?? '0'}`, params: { namespace: j.namespace }, reason: `${why}. At the next checkpoint, restart ${j.job} without ${node}.`, severity: 'high' }]
    : j.class === 'inference' ? [{ kind: 'drain-inference', job: j.job, class: 'inference', node, gpu: gpu ?? '0', target: `${j.job}@${node}/${gpu ?? '0'}`, params: { namespace: j.namespace }, reason: `${why}. Stop new requests to ${j.job}'s replica on ${node}; the others take the load.`, severity: 'high' }] : []);
}
const cordon = (node, why) => ({ kind: 'cordon-node', node, target: `node:${node}`, params: {}, reason: `${why}: no new work lands on ${node} while it is checked`, severity: 'high', undo: 'uncordon-node' });

export const PLAYBOOK = {
  hardware(t, ctx) {
    const out = [], gpus = t.gpus || [], gpuNodes = new Set(gpus.map(k => gpuOf(k).node));
    for (const k of gpus) { const { node, gpu } = gpuOf(k); out.push({ kind: 'quarantine', node, gpu, target: k, params: {}, reason: `fault on ${k} (${ctx.h.title})`, severity: 'high' }, { kind: 'run-diag', node, gpu, target: k, params: { level: 3 }, reason: `confirm the fault on ${k}`, severity: 'high' }, ...moveWork(ctx, node, gpu, `${k} is faulting`)); }
    for (const node of (t.nodes || []).filter(n => !gpuNodes.has(n)).slice(0, 3)) out.push(cordon(node, `jobs fail on ${node}`), ...moveWork(ctx, node, null, `jobs fail on ${node}`));
    return out;
  },
  straggler(t, ctx) {
    if (!t.node) return [];
    const gpu = t.gpu ?? '0', k = `${t.node}/${gpu}`;
    return [{ kind: 'config-reset', node: t.node, gpu, target: k, params: {}, reason: `rank ${t.rank} of ${t.job} on ${k} is slow: reset locked clocks`, severity: 'medium' },
      { kind: 'deep-diag-next-boundary', node: t.node, gpu, target: k, params: { level: 3 }, reason: `straggler in ${t.job}`, severity: 'medium' },
      ...(t.job ? [{ kind: 'swap-at-checkpoint', job: t.job, class: 'training', node: t.node, gpu, target: `${t.job}@${k}`, params: { namespace: ctx.ns(t.job) }, reason: `rank ${t.rank} on ${k} slows every step of ${t.job}: restart it without that GPU at the next checkpoint`, severity: 'high' }] : [])];
  },
  'slow-link'(t, ctx) {
    if (!t.node) return [];
    return [cordon(t.node, `${t.node}'s network is slow`),
      { kind: 'link-check', node: t.node, target: `node:${t.node}`, params: {}, reason: ctx.h.title, severity: 'high' },
      ...(t.job ? [{ kind: 'swap-at-checkpoint', job: t.job, class: 'training', node: t.node, gpu: '0', target: `${t.job}@${t.node}/0`, params: { namespace: ctx.ns(t.job) }, reason: `${ctx.h.title}: restart ${t.job} without ${t.node} at the next checkpoint`, severity: 'high' }] : [])];
  },
  'collective-hang'(t, ctx) {
    if (!t.node) return t.job ? [{ kind: 'notify-owner', job: t.job, class: 'training', target: `hang:${t.job}`, params: {}, reason: `${ctx.h.title}: no culprit rank found; restart from the last checkpoint`, severity: 'high' }] : [];
    return [cordon(t.node, `rank ${t.rank} on ${t.node} never joined the collective`),
      ...(t.job ? [{ kind: 'restart-without-node', job: t.job, class: 'training', node: t.node, target: `${t.job}@${t.node}`, params: { namespace: ctx.ns(t.job) }, reason: `${ctx.h.title}: the job is stuck; restart it from the last checkpoint without ${t.node}`, severity: 'high' },
        { kind: 'notify-owner', job: t.job, class: 'training', target: `hang:${t.job}`, params: {}, reason: `${ctx.h.title}`, severity: 'high' }] : [])];
  },
  'replica-tail'(t, ctx) {
    if (!t.replica) return [];
    const p = ctx.pool(t.pool);
    if (p.replicas != null && p.replicas <= 1) return [{ kind: 'notify-owner', job: t.pool, class: 'inference', target: `tail:${t.replica}`, params: {}, reason: `${ctx.h.title}; it is the only replica, so it can't be drained`, severity: 'high' }];
    return [{ kind: 'drain-replica', job: t.pool, class: 'inference', node: t.node, target: `replica:${t.replica}`, params: { namespace: p.namespace, replica: t.replica }, reason: `${ctx.h.title}: take it out of the Service; ${p.replicas ? p.replicas - 1 : 'the other'} replica(s) take the load`, severity: 'high' },
      ...(t.node ? [{ kind: 'run-diag', node: t.node, gpu: '0', target: `${t.node}/0`, params: { level: 2 }, reason: `slow replica ${t.replica} runs here`, severity: 'medium' }] : [])];
  },
  'kv-pressure': (t, ctx) => scaleOut(t, ctx, 'KV cache is full'),
  load: (t, ctx) => scaleOut(t, ctx, `traffic is ${t.rateRatio ? t.rateRatio.toFixed(1) + '×' : 'above'} its baseline`),
  'slow-stage'(t, ctx) { return t.stage === 'queue' ? scaleOut(t, ctx, 'requests are queueing') : [{ kind: 'notify-owner', job: t.pool, class: 'inference', target: `stage:${t.pool}`, params: {}, reason: ctx.h.title, severity: 'medium' }]; },
  change(t, ctx) {
    const ch = t.change || {}, m = String(ch.id || '').match(/^([^/#]+)\/([^/#]+)#(\d+)$/); // helm history ids: namespace/release#revision
    if (m && +m[3] > 1) return [{ kind: 'rollback-change', target: `change:${ch.id}`, params: { namespace: m[1], release: m[2], revision: String(+m[3] - 1) }, reason: `${ctx.h.title}: roll ${m[2]} back to revision ${+m[3] - 1}`, severity: 'high' }];
    return [{ kind: 'hold-rollout', target: `change:${ch.id || ch.target}`, params: {}, reason: `${ctx.h.title}: roll it back on one target and watch whether the symptom clears`, severity: 'high' }];
  },
  'version-cohort'(t, ctx) {
    return [{ kind: 'hold-rollout', target: `version:${t.field}=${t.version}`, params: {}, reason: ctx.h.title, severity: 'high' }, ...(t.nodes || []).map(n => cordon(n, `${n} runs ${t.field} ${t.version}`))];
  },
  'shared-component'(t, ctx) {
    return [{ kind: 'link-check', target: `group:${t.group}`, node: (t.affected || [])[0], params: {}, reason: `${ctx.h.title}: check it (port counters and logs for a switch; PDU and BMC logs for a rack)`, severity: 'high' }, ...(t.nodes || []).map(n => cordon(n, `${n} sits behind ${t.group}`))];
  },
  workload(t, ctx) {
    const who = t.owner || t.namespace;
    return who ? [{ kind: 'notify-owner', job: who, target: `workload:${who}`, params: {}, reason: `${ctx.h.title}: the GPUs are not the cause; read the jobs' exit codes and pause their retries`, severity: 'medium' }] : [];
  },
  infrastructure: () => [],                 // storage, scheduler, network: a person, paged
  'monitoring-gap': (t, ctx) => [{ kind: 'exporter-check', target: 'fleet', params: {}, reason: ctx.h.title, severity: 'high' }],
};
function scaleOut(t, ctx, why) {
  const p = ctx.pool(t.pool);
  if (!t.pool) return [];
  if (!p.replicas) return [{ kind: 'notify-owner', job: t.pool, class: 'inference', target: `capacity:${t.pool}`, params: {}, reason: `${ctx.h.title}: ${why}, and the replica count is unknown, so add replicas by hand`, severity: 'high' }];
  const add = Math.min(ctx.maxStep, Math.max(1, Math.ceil(p.replicas * 0.25)));
  return [{ kind: 'scale-out', job: t.pool, class: 'inference', target: `pool:${t.pool}`, params: { namespace: p.namespace, replicas: String(p.replicas + add) }, reason: `${ctx.h.title}: ${why}; scale ${t.pool} from ${p.replicas} to ${p.replicas + add} replicas`, severity: 'high' }];
}

// ---------- state ----------
function loadState(dir) { const f = path.join(dir, 'agent-state.json'); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { incidents: {}, dryRuns: {}, auto: [], ticks: 0 }; } }
function saveState(dir, s) { const f = path.join(dir, 'agent-state.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(s)); fs.renameSync(f + '.tmp', f); }
export const paused = dir => fs.existsSync(path.join(dir, 'PAUSE'));
export function setPaused(dir, on, by) {
  const f = path.join(dir, 'PAUSE');
  fs.mkdirSync(dir, { recursive: true });
  if (on) fs.writeFileSync(f, JSON.stringify({ t: Math.floor(Date.now() / 1000), by }));
  else fs.rmSync(f, { force: true });
  log(dir, { t: Math.floor(Date.now() / 1000), decision: on ? 'paused' : 'resumed', by });
}
function log(dir, e) { fs.appendFileSync(path.join(dir, 'agent.jsonl'), JSON.stringify(e) + '\n'); }
export function decisions(dir, n = 100) {
  const f = path.join(dir, 'agent.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map(l => JSON.parse(l)).reverse();
}

// What runs where, for the playbook: jobs on a node (placements live in the window), pools' namespace and replicas.
function context(store, from, to, pools = {}) {
  const live = store.query('placement', { to, where: p => p.end == null || p.end > from });
  const byNode = new Map(), meta = new Map();
  for (const p of live) {
    const job = String(p.job).split('#')[0];
    meta.set(job, { namespace: p.namespace || 'default', class: p.class });
    for (const n of uniq([p.node, ...(p.devices || []).map(d => d.node)])) { if (!byNode.has(n)) byNode.set(n, new Map()); byNode.get(n).set(job, { job, class: p.class || 'batch', namespace: p.namespace || 'default' }); }
  }
  const reqs = store.query('request', { from, to }), replicas = new Map();
  for (const r of reqs) if (r.pool && r.replica) { if (!replicas.has(r.pool)) replicas.set(r.pool, new Set()); replicas.get(r.pool).add(r.replica); }
  const nodes = new Set([...store.query('inventory', { to }).map(r => r.node), ...byNode.keys()]);
  return {
    nodeCount: nodes.size,
    jobsOn: n => [...(byNode.get(n) || new Map()).values()],
    ns: job => (meta.get(job) || {}).namespace || 'default',
    pool: p => Object.assign({ namespace: (meta.get(p) || {}).namespace || 'default', replicas: replicas.has(p) ? replicas.get(p).size : (live.filter(x => String(x.job).split('#')[0] === p).length || null) }, pools[p] || {}),
  };
}

// How far the agent may go with one incident.
function decide(d, breaker) {
  const top = d.hypotheses[0];
  if (breaker || (top && top.rule === 'monitoring-gap')) return 'frozen';
  if (!top || d.confidence === 'low' || d.confidence === 'none') return 'escalate';
  return d.confidence === 'high' ? 'mitigate' : 'contain';
}

// Actions for one diagnosis, with modes set by the policy and lowered by the decision and the guardrails.
export function plan(d, decision, { cfg, acfg, ctx, incId }) {
  const top = d.hypotheses[0];
  if (!top || decision === 'escalate') return [];
  const pb = PLAYBOOK[top.rule];
  if (!pb) return [];
  const raw = pb(top.targets || {}, Object.assign({ h: top, inc: d.incident, maxStep: (cfg.policy.limits || {}).maxScaleOutStep ?? 4 }, ctx));
  return raw.filter(a => decision !== 'frozen' || a.kind === 'exporter-check').map(a => {
    let mode = modeFor(cfg, a.kind, a.class), why = null;
    if (mode === 'auto' && decision === 'contain' && !acfg.contain.includes(a.kind)) { mode = 'approve'; why = 'medium confidence: only containing actions run on their own'; }
    return Object.assign({ evidence: top.evidence.slice(0, 3).map(e => e.what) }, a, { id: `${a.kind}:${a.target}`, mode, incident: incId, rule: top.rule, confidence: d.confidence, lowered: why || undefined, reason: `[${top.rule}, ${d.confidence}] ${a.reason}` });
  });
}

// gpu-health over the recent device records; writes the state files the flakiness view and dashboard read.
function devices(store, dir, cfg, now, windowS) {
  const x = toGpuHealth(store, { from: now - windowS, to: now });
  if (!x.samples.length) return null;
  const hf = path.join(dir, 'health.json'), prev = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, 'utf8')) : { gpus: {} };
  const a = analyze({ samples: x.samples, jobs: x.jobs, results: x.results, prev, cfg, now, windowDays: Math.max(1, windowS / 86400) });
  recordTransitions(dir, prev, a.health);
  recordResults(dir, x.results);
  fs.writeFileSync(hf, JSON.stringify(persistable(a.health)));
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(a));
  return a;
}

// Is the symptom still there in (since, now]? Judged on the data after the action alone, against the incident's own
// baseline: a continuing CUSUM run that began before the action would otherwise always look "still there".
// true = still there, false = cleared, null = no data since the action to tell.
const med = a => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
export function stillThere(store, inc, since, now, acfg) {
  if (now <= since) return true;
  if (inc.symptom === 'job-failures') {
    if (!store.query('job', { from: since, to: now, limit: 1 }).length && !store.query('device', { from: since, to: now, limit: 1 }).length) return null;
    const n = store.query('job', { from: since, to: now, where: j => j.status === 'failed' }).length;
    const expected = (inc.baselinePerBin || 0) * (now - since) / (inc.binS || acfg.binS);
    return n >= Math.max(3, acfg.minFailures / 2) && n > 2 * expected + 1;
  }
  if (inc.symptom === 'latency') {
    const m = inc.metric || 'ttftP99', v = med(store.query('serving', { from: since, to: now, where: r => r.pool === inc.pool }).map(r => r[m]));
    if (!Number.isFinite(v)) return null;
    const lim = Number.isFinite(inc.limit) ? inc.limit : Number.isFinite(inc.baseline) ? 1.3 * inc.baseline : Infinity;
    return v > lim;
  }
  if (inc.symptom === 'training-slow') {
    const v = med(store.query('step', { from: since, to: now, where: x => !inc.job || x.job === inc.job }).map(x => x.durS));
    return Number.isFinite(v) && Number.isFinite(inc.baseline) ? v > 1.15 * inc.baseline : null;
  }
  if (inc.symptom === 'training-hang') {
    if (store.query('log', { from: since, to: now, where: l => l.code === 'nccl_timeout' && (!inc.job || l.job === inc.job) }).length) return true;
    return store.query('step', { from: since, to: now, where: x => !inc.job || x.job === inc.job, limit: 1 }).length ? false : null; // steps again: it moves
  }
  return null;
}

// One tick. Returns what it saw and did.
export async function tick(store, { stateDir, ghConfig, agent = {}, live = false, now = Math.floor(Date.now() / 1000), runner, poster, pagePoster } = {}) {
  const acfg = Object.assign({}, AGENT_DEFAULTS, agent), cfg = loadConfig(ghConfig);
  fs.mkdirSync(stateDir, { recursive: true });
  if (store.flush) store.flush();
  const st = loadState(stateDir), q = new Queue(stateDir), isPaused = paused(stateDir);
  const from = now - acfg.windowS, report = { t: now, live: live && cfg.policy.dryRun === false, paused: isPaused, incidents: [], executed: [], verified: [] };

  // 1. devices
  let dev = null;
  try { dev = devices(store, stateDir, cfg, now, acfg.deviceWindowS); } catch (e) { report.deviceError = e.message; }
  const breaker = !!(dev && dev.health.breaker);
  if (dev) report.devices = { gpus: dev.summary.gpus, states: dev.summary.states, breaker };

  // 2. incidents in the window, diagnosed
  const incs = Detect.groupIncidents([
    ...Detect.detectJobFailures(store, { from, to: now, minFailures: acfg.minFailures, binS: acfg.binS }),
    ...Detect.detectServing(store, { from, to: now, targets: acfg.targets }),
    ...Detect.detectTraining(store, { from, to: now }),
  ]);
  const ctx = context(store, from, now, acfg.pools), suggestions = dev ? dev.suggestions.slice() : [];
  let cordonBudget = Math.max(1, Math.floor(acfg.maxCordonShare * (ctx.nodeCount || 0)));
  cordonBudget -= q.list('executed').filter(a => a.kind === 'cordon-node' && !q.list('executed').some(u => u.kind === 'uncordon-node' && u.node === a.node && u.executedAt > a.executedAt)).length;

  for (const inc of incs) {
    const d = diagnose(store, inc), top = d.hypotheses[0];
    if (!st.incidents[d.id]) {
      // store the diagnosis and open the incident once
      if (!store.query('incident', { where: x => x.id === d.id }).length) store.append('incident', [d]);
      Inc.open(store, d, { by: BY, now });
    }
    const rec = st.incidents[d.id] || (st.incidents[d.id] = { firstSeen: now, incident: { symptom: inc.symptom, pool: inc.pool, job: inc.job, from: inc.from, metric: inc.metric, baseline: inc.baseline, limit: inc.limit, baselinePerBin: inc.baselinePerBin, binS: inc.binS }, actions: [] });
    let decision = isPaused ? 'paused' : decide(d, breaker);
    let acts = isPaused ? [] : plan(d, decision, { cfg, acfg, ctx, incId: d.id });
    if ((decision === 'mitigate' || decision === 'contain') && !acts.length) decision = 'escalate'; // nothing in the playbook can help: a person
    // blast radius: the agent cordons at most maxCordonShare of the nodes on its own
    for (const a of acts.filter(a => a.kind === 'cordon-node' && a.mode === 'auto')) {
      if (q.list('open').some(x => x.id === a.id) || q.list('executed').some(x => x.id.split('#')[0] === a.id)) continue; // already counted
      if (cordonBudget > 0) cordonBudget--; else Object.assign(a, { mode: 'approve', lowered: `cordon limit: the agent may cordon at most ${Math.round(acfg.maxCordonShare * 100)}% of the nodes on its own` });
    }
    suggestions.push(...acts);
    const changed = rec.decision !== decision || rec.rule !== (top && top.rule) || rec.confidence !== d.confidence;
    Object.assign(rec, { lastSeen: now, decision, rule: top ? top.rule : null, title: top ? top.title : null, confidence: d.confidence, actions: uniq([...rec.actions, ...acts.map(a => a.id)]) });
    if (changed) {
      const e = { t: now, incident: d.id, symptom: inc.symptom, decision, rule: rec.rule, confidence: d.confidence, title: rec.title, actions: acts.map(a => ({ id: a.id, kind: a.kind, mode: a.mode, lowered: a.lowered })) };
      log(stateDir, e);
      const note = `agent: ${decision}${rec.rule ? ` (${rec.rule}, ${d.confidence})` : ''}${acts.length ? ` — ${acts.map(a => `${a.kind} ${a.target} [${a.mode}]`).join('; ')}` : ''}`;
      try { Inc.transition(store, d.id, 'note', { by: BY, note, now }); } catch { /* resolved incidents take no notes */ }
      // page a person when the agent can't act, or the incident is severe
      const s = Inc.state(store, d.id);
      if (acfg.page && !rec.paged && (decision === 'escalate' || decision === 'frozen' || (SEV[s && s.severity] || 9) <= (SEV[acfg.page.minSeverity] || 2))) {
        try { const r = await Inc.page(store, d.id, acfg.page.to, 'trigger', { live: report.live, key: acfg.page.key, url: acfg.page.url, by: BY, poster: pagePoster, now }); rec.paged = { t: now, dryRun: r.dryRun }; log(stateDir, { t: now, incident: d.id, decision: 'paged', dryRun: r.dryRun, to: acfg.page.to }); } catch (e) { log(stateDir, { t: now, incident: d.id, decision: 'page-failed', error: e.message }); }
      }
    }
    report.incidents.push({ id: d.id, symptom: inc.symptom, pool: inc.pool, job: inc.job, decision, rule: rec.rule, confidence: d.confidence, title: rec.title, actions: acts.map(a => ({ id: a.id, kind: a.kind, mode: a.mode, lowered: a.lowered })) });
  }

  // 3. one merge (device and incident actions together, so neither supersedes the other), de-duplicated by id
  const byId = new Map();
  for (const s of suggestions) { const p = byId.get(s.id); if (!p) byId.set(s.id, s); else if (s.incident && !p.incident) byId.set(s.id, Object.assign({}, p, { incident: s.incident, rule: s.rule, reason: `${p.reason} ${s.reason}` })); }
  q.merge([...byId.values()], cfg, now);

  // 4. run what is approved: autonomous runs within the hourly budget; dry runs once per action
  if (!isPaused) {
    st.auto = (st.auto || []).filter(x => x.t > now - 3600);
    const dry = !report.live;
    let budget = acfg.maxAutoActionsPerHour - st.auto.length;
    const ids = [];
    for (const a of q.list('approved')) {
      if (dry && st.dryRuns[a.id]) continue;
      // the hourly limit is on autonomous changes to the cluster; messages to people (webhook kinds) don't count
      const message = (() => { const e = cfg.executors[a.kind]; return e === 'webhook' || (e && e.webhook); })();
      if (a.approvedBy === 'policy' && !message) { if (budget <= 0) { if (!st.budgetNoted || st.budgetNoted < now - 600) { log(stateDir, { t: now, decision: 'budget', note: `autonomous action limit reached (${acfg.maxAutoActionsPerHour} per hour); ${a.id} waits` }); st.budgetNoted = now; } continue; } budget--; }
      ids.push(a.id);
    }
    if (ids.length) {
      const fleetSize = dev ? dev.summary.gpus : 0;
      const res = await q.execute(cfg, { ids, live: report.live, now, runner, poster, fleetSize });
      for (const r of res) {
        const a = q.get(r.id) || {};
        const outcome = r.skipped ? 'skipped' : r.dryRun ? 'dry-run' : r.ok ? 'done' : 'failed';
        if (outcome === 'dry-run') st.dryRuns[r.id] = now;
        // dry runs count too, so a dry run shows what the hourly limit would allow live
        const msg = (() => { const e = cfg.executors[a.kind]; return e === 'webhook' || (e && e.webhook); })();
        if ((outcome === 'done' || outcome === 'dry-run') && a.approvedBy === 'policy' && !msg) st.auto.push({ t: now, id: r.id, dryRun: outcome === 'dry-run' });
        report.executed.push({ id: r.id, kind: a.kind, outcome, by: a.approvedBy, commands: r.commands, output: r.output });
        log(stateDir, { t: now, incident: a.incident, decision: 'acted', action: r.id, kind: a.kind, outcome, by: a.approvedBy, commands: r.commands, note: r.skipped ? r.output : undefined });
        const rec = a.incident && st.incidents[a.incident];
        if (rec && (outcome === 'done' || outcome === 'dry-run') && !rec.actedAt) rec.actedAt = now, rec.actedLive = outcome === 'done';
      }
    }
  }

  // 5. verify: did the symptom clear after acting?
  for (const [id, rec] of Object.entries(st.incidents)) {
    if (!rec.actedAt || rec.verified || now - rec.actedAt < acfg.verifyAfterS) continue;
    const persists = stillThere(store, rec.incident, rec.actedAt + 60, now, acfg);
    if (persists === null && now - rec.actedAt < 3 * acfg.verifyAfterS) continue; // no data yet: look again next tick
    rec.verified = { t: now, outcome: persists === null ? 'no-data' : persists ? 'persisting' : 'cleared', live: !!rec.actedLive };
    const note = persists === null ? `agent: no new data in the ${Math.round((now - rec.actedAt) / 60)} min since acting, so it can't tell whether the symptom cleared; a person should look`
      : persists ? `agent: symptom still present ${Math.round((now - rec.actedAt) / 60)} min after ${rec.actedLive ? 'acting' : 'the dry run'}; a person is needed`
      : rec.actedLive ? `agent: symptom cleared ${Math.round((now - rec.actedAt) / 60)} min after mitigation` : 'agent: symptom cleared on its own (the agent was in dry-run mode)';
    log(stateDir, { t: now, incident: id, decision: 'verified', outcome: rec.verified.outcome, live: rec.verified.live, note });
    try {
      if (persists === false && rec.actedLive) Inc.transition(store, id, 'mitigate', { by: BY, note, now });
      else Inc.transition(store, id, 'note', { by: BY, note, now });
    } catch { /* already mitigated or resolved by a person */ }
    if (persists !== false && acfg.page && !(rec.paged && rec.paged.escalated)) {
      try { const r = await Inc.page(store, id, acfg.page.to, 'trigger', { live: report.live, key: acfg.page.key, url: acfg.page.url, by: BY, poster: pagePoster, now }); rec.paged = { t: now, dryRun: r.dryRun, escalated: true }; } catch (e) { log(stateDir, { t: now, incident: id, decision: 'page-failed', error: e.message }); }
    }
    report.verified.push(Object.assign({ id }, rec.verified));
  }
  // forget incidents a day after they were last seen
  for (const [id, rec] of Object.entries(st.incidents)) if (now - rec.lastSeen > 86400) delete st.incidents[id];
  for (const [id, t] of Object.entries(st.dryRuns)) if (now - t > 86400) delete st.dryRuns[id];
  Object.assign(st, { lastTick: now, ticks: (st.ticks || 0) + 1, lastReport: { t: now, incidents: report.incidents.length, executed: report.executed.length, live: report.live, paused: isPaused } });
  saveState(stateDir, st);
  if (store.flush) store.flush();
  return report;
}

export const agentState = dir => loadState(dir);

// Run ticks on a timer; errors are logged, never fatal.
export function start(store, opts, { onTick = () => {}, onError = e => console.error(`agent: ${e.message}`), before = null } = {}) {
  const every = (Object.assign({}, AGENT_DEFAULTS, opts.agent).intervalS) * 1000;
  let busy = false, timer = null;
  const run = async () => { if (busy) return; busy = true; try { if (before) await before(Math.floor(Date.now() / 1000)); onTick(await tick(store, opts)); } catch (e) { onError(e); } finally { busy = false; } };
  run();
  timer = setInterval(run, every);
  return { stop: () => clearInterval(timer), run };
}

export { iso as _iso };
