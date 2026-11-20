// Actions: what the analysis suggests, who approved it, and what ran.
//
// Each suggestion becomes an action with a stable id (kind + target), so re-running the analysis updates it instead
// of piling up duplicates. Its mode comes from the policy for that action kind and workload class:
//   auto     approved by policy at once (still dry-run unless run live)
//   approve  waits in the queue for a person
//   never    shown as a suggestion only; cannot be approved
// Lifecycle: proposed → approved | rejected → executed | failed. A proposed action that the next analysis no longer
// suggests becomes `superseded`. Every change is appended to audit.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { modeFor } from './config.mjs';
import { run } from './executors.mjs';

const OPEN = new Set(['proposed', 'approved', 'suggested']);
const DISRUPTIVE = new Set(['gpu-reset', 'node-reboot', 'fabric-restart', 'reclaim-idle', 'scale-in', 'resize', 'requeue-at-checkpoint', 'release', 'repartition']);

// Candidate actions from an analysis.
export function suggest(analysis, cfg) {
  const out = [];
  const jobsOn = k => analysis.jobs.filter(j => j.gpus.some(g => g.node + '/' + g.gpu === k));
  const add = (a) => out.push(Object.assign({ evidence: [] }, a));
  const h = analysis.health;
  if (h.breaker) add({ kind: 'exporter-check', target: 'fleet', reason: `${h.staleCount} of ${h.fleet} GPUs stopped reporting at once; checking monitoring before quarantining anything`, severity: 'high' });
  for (const g of Object.values(h.gpus)) {
    const k = g.key, cls = g.faultClass || 'default', ladder = cfg.ladder[cls] || cfg.ladder.default;
    const base = { node: g.node, gpu: g.gpu, target: k, since: g.since, evidence: (g.signals || []).map(s => s.why) };
    const jobs = jobsOn(k);
    if (g.state === 'quarantined') {
      add(Object.assign({}, base, { kind: 'quarantine', reason: g.why, severity: 'high' }));
      for (const j of jobs) add(Object.assign({}, base, { kind: 'notify-owner', job: j.id, class: j.class, target: `${k}:${j.id}`, reason: `GPU ${k} quarantined: ${g.why}. Restart from the last checkpoint on healthy GPUs.`, severity: 'high' }));
      if (cls === 'stale') add(Object.assign({}, base, { kind: 'exporter-check', reason: `no telemetry from ${k}`, severity: 'medium' }));
      else {
        add(Object.assign({}, base, { kind: 'run-diag', params: { level: cfg.diagLevelByClass[cls] || cfg.diagLevelByClass.default }, reason: `confirm ${cls} fault`, severity: 'high' }));
        add(Object.assign({}, base, { kind: ladder[0], reason: `first repair step for ${cls}: ${g.why}`, severity: 'high' }));
      }
    } else if (g.state === 'remediate') {
      add(Object.assign({}, base, { kind: ladder[g.ladderStep || 0], reason: g.why, severity: 'high' }));
      add(Object.assign({}, base, { kind: 'run-diag', params: { level: cfg.diagLevelByClass[cls] || 2 }, reason: `re-test after ${ladder[g.ladderStep || 0]}`, severity: 'medium' }));
    } else if (g.state === 'rma') {
      add(Object.assign({}, base, { kind: 'quarantine', reason: g.why, severity: 'high' }));
      add(Object.assign({}, base, { kind: 'rma', reason: g.why, severity: 'high' }));
    } else if (g.state === 'burnin') {
      add(Object.assign({}, base, { kind: 'run-diag', params: { level: 4 }, reason: 'burn-in before returning to service', severity: 'medium' }));
    } else if (g.state === 'ready') {
      add(Object.assign({}, base, { kind: 'release', reason: 'burn-in passed: return to service', severity: 'medium' }));
    } else if (g.state === 'suspect') {
      add(Object.assign({}, base, { kind: 'deep-diag-next-boundary', params: { level: cfg.diagLevelByClass[cls] || 3 }, reason: g.why, severity: 'medium' }));
      if (g.evidence && g.evidence.remapPending) add(Object.assign({}, base, { kind: 'gpu-reset', reason: 'row remap pending: reset at the next job boundary', severity: 'medium' }));
      for (const j of jobs.filter(j => j.class === 'training' && j.gpus.length >= 8)) add(Object.assign({}, base, { kind: 'notify-owner', job: j.id, class: j.class, target: `${k}:${j.id}`, reason: `GPU ${k} under suspicion (${g.why}); checkpoint more often until it is cleared.`, severity: 'medium' }));
    }
  }
  for (const r of analysis.risk.filter(r => r.tier === 'high' && r.state === 'serving')) {
    add({ kind: 'avoid-large-jobs', node: r.node, gpu: r.gpu, target: r.key, reasonCode: 'high-risk', reason: `failure risk ${(r.score * 100).toFixed(0)}: ${r.why.join(', ')}`, severity: 'medium' });
    add({ kind: 'deep-diag-next-boundary', node: r.node, gpu: r.gpu, target: r.key, params: { level: 3 }, reason: `high failure risk: ${r.why.join(', ')}`, severity: 'medium' });
  }
  for (const rec of analysis.recommendations) {
    const job = analysis.jobs.find(j => j.id === rec.job) || {};
    const a = { kind: rec.action, job: rec.job, class: rec.class, target: rec.job, reason: rec.text, weekly: rec.weekly, confidence: rec.confidence, severity: rec.weekly > 500 ? 'medium' : 'low', params: {} };
    if (rec.replicas != null) a.params.replicas = rec.replicas;
    if (rec.fraction != null) a.params.fraction = rec.fraction;
    if (rec.lever === 'fix-straggler') { const [node, gpu] = rec.target.split('/'); Object.assign(a, { node, gpu }); add({ kind: 'deep-diag-next-boundary', node, gpu, target: rec.target, params: { level: 3 }, reason: `straggler in ${rec.job}`, severity: 'medium' }); }
    a.params.namespace = job.namespace || 'default';
    add(a);
  }
  for (const p of analysis.partitionPlan || []) if (p.gpusNeeded < p.gpusNow) add({ kind: 'repartition', target: `partition:${p.sku}`, reason: `pack fractional jobs on ${p.gpusNeeded} ${p.sku} GPU(s) instead of ${p.gpusNow}: ${p.layout.join(' | ')}`, severity: 'low' });
  // de-duplicate by kind + target
  const seen = new Map();
  for (const a of out) { a.id = `${a.kind}:${a.target}`; if (!seen.has(a.id)) seen.set(a.id, a); else if (a.reason && !seen.get(a.id).reason.includes(a.reason)) seen.get(a.id).reason += '; ' + a.reason; }
  return [...seen.values()].map(a => Object.assign(a, { mode: modeFor(cfg, a.kind, a.class) }));
}

export class Store {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'actions.json'); this.auditFile = path.join(dir, 'audit.jsonl'); this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { actions: [] }; }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1)); fs.renameSync(tmp, this.file); }
  audit(a, event, extra = {}) { fs.appendFileSync(this.auditFile, JSON.stringify(Object.assign({ t: Math.floor(Date.now() / 1000), id: a.id, kind: a.kind, target: a.target, event }, extra)) + '\n'); }
  get(id) { return this.data.actions.find(a => a.id === id) || this.data.actions.find(a => a.id.startsWith(id) && OPEN.has(a.status)); }
  list(status) { return this.data.actions.filter(a => !status || (status === 'open' ? OPEN.has(a.status) : a.status === status)); }

  // Merge the latest suggestions into the queue.
  merge(suggestions, cfg, now) {
    const latest = new Set(suggestions.map(s => s.id));
    const cd = cfg.policy.cooldownSec || { rejected: 7 * 86400, executed: 86400 };
    for (const s of suggestions) {
      const prior = this.data.actions.filter(a => a.id === s.id || a.id.startsWith(s.id + '#'));
      const open = prior.find(a => OPEN.has(a.status));
      if (open) { Object.assign(open, { reason: s.reason, evidence: s.evidence, weekly: s.weekly, params: s.params, lastSeen: now, analyzedAt: now }); continue; }
      const last = prior.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (last && last.status === 'rejected' && now - last.updatedAt < cd.rejected) continue;
      // done already: for a GPU state, once per entry into that state; otherwise not again within the cooldown
      if (last && ['executed', 'failed'].includes(last.status) && (s.since != null ? last.executedAt >= s.since : now - last.updatedAt < cd.executed)) continue;
      const a = Object.assign({}, s, { id: prior.length ? `${s.id}#${prior.length + 1}` : s.id, status: s.mode === 'never' ? 'suggested' : s.mode === 'auto' ? 'approved' : 'proposed', createdAt: now, updatedAt: now, lastSeen: now, analyzedAt: now });
      if (s.mode === 'auto') a.approvedBy = 'policy';
      this.data.actions.push(a);
      this.audit(a, 'created', { status: a.status, mode: a.mode, reason: a.reason });
    }
    for (const a of this.data.actions) if (OPEN.has(a.status) && !latest.has(a.id.split('#')[0])) {
      a.status = 'superseded'; a.updatedAt = now; this.audit(a, 'superseded', { why: 'no longer suggested by the latest analysis' });
    }
    this.save();
  }

  approve(id, by, now = Math.floor(Date.now() / 1000)) {
    const a = this.get(id);
    if (!a) throw new Error(`no action ${id}`);
    if (a.status !== 'proposed') throw new Error(`${a.id} is ${a.status}, not proposed`);
    if (!by) throw new Error('approver name required (--by)');
    Object.assign(a, { status: 'approved', approvedBy: by, approvedAt: now, updatedAt: now });
    this.audit(a, 'approved', { by }); this.save(); return a;
  }
  reject(id, by, why = '', now = Math.floor(Date.now() / 1000)) {
    const a = this.get(id);
    if (!a) throw new Error(`no action ${id}`);
    if (!['proposed', 'approved', 'suggested'].includes(a.status)) throw new Error(`${a.id} is ${a.status}`);
    Object.assign(a, { status: 'rejected', rejectedBy: by || 'unknown', rejectReason: why, updatedAt: now });
    this.audit(a, 'rejected', { by, why }); this.save(); return a;
  }

  // Execute approved actions, within the blast-radius limits.
  async execute(cfg, { ids, live = false, now = Math.floor(Date.now() / 1000), runner, poster, fleetSize = 0 } = {}) {
    const dryRun = !(live && cfg.policy.dryRun === false); // two locks: --live and policy.dryRun=false
    const todo = this.data.actions.filter(a => a.status === 'approved' && (!ids || ids.some(i => a.id === i || a.id.startsWith(i))));
    const lim = cfg.policy.limits || {};
    const maxQ = Math.max(lim.minQuarantinePerRun ?? 2, Math.floor((lim.maxQuarantineShare ?? 0.1) * fleetSize));
    let q = 0, reboots = 0;
    const results = [];
    for (const a of todo.sort((x, y) => (x.severity === 'high' ? 0 : 1) - (y.severity === 'high' ? 0 : 1))) {
      let refuse = null;
      if (a.kind === 'quarantine' && ++q > maxQ) refuse = `quarantine limit reached (${maxQ} per run): check for a fleet-wide cause first`;
      if (a.kind === 'node-reboot' && ++reboots > (lim.maxNodeRebootsPerRun ?? 1)) refuse = 'node reboot limit reached for this run';
      if (!refuse && DISRUPTIVE.has(a.kind) && now - (a.analyzedAt || 0) > (lim.maxActionAgeSec ?? 3600)) refuse = 'analysis is older than the allowed age for this action: re-run analyze to confirm it still applies';
      if (refuse) { results.push({ id: a.id, ok: false, skipped: true, output: refuse }); this.audit(a, 'skipped', { why: refuse }); continue; }
      let r;
      try { r = await run(a, cfg, { dryRun, runner, poster }); } catch (e) { r = { ok: false, dryRun, output: e.message }; }
      if (r.dryRun) { this.audit(a, 'dry-run', { commands: r.commands, text: r.text }); results.push(Object.assign({ id: a.id }, r)); continue; }
      Object.assign(a, { status: r.ok ? 'executed' : 'failed', executedAt: now, updatedAt: now, result: { commands: r.commands, output: r.output } });
      this.audit(a, a.status, { commands: r.commands, output: r.output });
      results.push(Object.assign({ id: a.id }, r));
    }
    this.save();
    return results;
  }
}
