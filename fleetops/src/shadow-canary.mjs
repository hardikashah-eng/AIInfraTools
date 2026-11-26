// An llm-d canary driven by the shadow-upgrade judge: two LLMInferenceServices (KServe v1alpha2) in one routing group,
// spec.router.route.weight setting each one's share (proportional, 0–1,000,000), the judge deciding each step.
//
//   start     the canary at its first step (by default 1% of traffic to the candidate)
//   advance   ask the judge about the traffic since the last weight change, then:
//               rollback  the candidate's weight goes to 0 at once (with --live): stopping is always allowed
//               wait      nothing changes
//               promote   the next step is queued for a person; it is applied by the next advance --live only after
//                         `approve --by NAME`. Raising a canary's share is never automatic.
//   approve   a person approves the queued step (their name is recorded)
//
// Nothing touches the cluster without --live; without it the kubectl commands are printed. Weights are written with
// kubectl patch (a merge patch on spec.router.route), so the rest of each resource is left alone.
import { execFileSync } from 'node:child_process';

export const TOTAL = 1000000; // KServe's maximum weight: shares are written as parts per million
export const DEFAULT_STEPS = [1, 5, 25, 50, 100];

export function start({ name, namespace = 'default', group, baseline, candidate, steps = DEFAULT_STEPS, bakeS = 600, now = Math.floor(Date.now() / 1000) }) {
  if (!name || !group || !baseline || !candidate) throw new Error('name, group, baseline and candidate are required');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(group) || group.length > 63) throw new Error(`group ${group}: lowercase letters, digits and -, at most 63 characters (KServe's rule)`);
  const st = steps.map(Number);
  if (!st.length || st.some((x, i) => !(x > 0 && x <= 100) || (i && x <= st[i - 1]))) throw new Error('steps: increasing percentages in (0, 100]');
  return { kind: 'fleetops.llmd-canary', version: 1, name, namespace, group, baseline, candidate, steps: st, step: 0, bakeS, status: 'running', since: now, pending: null, history: [{ t: now, event: 'start', share: st[0] }] };
}
export const share = s => (s.status === 'rolled back' ? 0 : s.steps[s.step]);
export function weightsFor(pct) { const c = Math.round(pct * TOTAL / 100); return { baseline: TOTAL - c, candidate: c }; }
// the kubectl calls that set both members' weights
export function patches(s, pct, kubectl = 'kubectl') {
  const w = weightsFor(pct);
  return ['baseline', 'candidate'].map(k => [kubectl, 'patch', 'llminferenceservice', s[k], '-n', s.namespace, '--type', 'merge', '-p', JSON.stringify({ spec: { router: { route: { group: s.group, weight: w[k] } } } })]);
}
// the judge's selectors for the two members (llm-d labels each member's pods with llm_isvc_name through the PodMonitor)
export const selectors = s => ({ select: `namespace="${s.namespace}"`, baseline: `llm_isvc_name="${s.baseline}"`, candidate: `llm_isvc_name="${s.candidate}"` });

// What the verdict means for the canary. Returns { state, action }: action.type is rollback | apply | queued |
// awaiting-approval | wait | bake | done | stopped; action.patch is set when something should be written.
export function decide(s0, verdict, { now = Math.floor(Date.now() / 1000), why = '' } = {}) {
  const s = JSON.parse(JSON.stringify(s0)), log = (event, extra = {}) => s.history.push(Object.assign({ t: now, event, share: share(s) }, extra));
  if (s.status !== 'running') return { state: s, action: { type: 'stopped', note: `canary is ${s.status}` } };
  if (verdict === 'rollback') {
    s.status = 'rolled back'; s.pending = null; s.since = now; log('rollback', { why });
    return { state: s, action: { type: 'rollback', share: 0, patch: true, note: `the judge says roll back: ${why}` } };
  }
  if (s.pending && s.pending.approvedBy) {
    const to = s.pending.toStep, by = s.pending.approvedBy; s.step = to; s.since = now; log('step', { approvedBy: by, to: s.steps[to] }); s.pending = null;
    if (to === s.steps.length - 1) { s.status = 'done'; log('done'); }
    return { state: s, action: { type: 'apply', share: s.steps[to], patch: true, note: `step to ${s.steps[to]}% approved by ${by}` } };
  }
  if (verdict === 'wait') return { state: s, action: { type: 'wait', note: why || 'not settled yet' } };
  if (verdict !== 'promote') return { state: s, action: { type: 'wait', note: `unknown verdict ${verdict}` } };
  if (now - s.since < s.bakeS) return { state: s, action: { type: 'bake', note: `${s.bakeS - (now - s.since)} s more at ${share(s)}% before a step up is considered` } };
  if (s.step === s.steps.length - 1) { s.status = 'done'; log('done'); return { state: s, action: { type: 'done', note: 'the candidate already carries its final share' } }; }
  if (s.pending) return { state: s, action: { type: 'awaiting-approval', note: `step to ${s.steps[s.pending.toStep]}% waits for: fleetops shadow canary approve --name ${s.name} --by NAME` } };
  s.pending = { id: `${s.name}-${s.step + 1}`, toStep: s.step + 1, createdAt: now, why }; log('queued', { to: s.steps[s.step + 1] });
  return { state: s, action: { type: 'queued', note: `the judge says promote; the step to ${s.steps[s.step + 1]}% is queued for approval: fleetops shadow canary approve --name ${s.name} --by NAME` } };
}

export function approve(s0, by, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!by || by === true) throw new Error('approver name required (--by NAME)');
  if (!s0.pending) throw new Error(`nothing waits for approval on ${s0.name}`);
  if (s0.pending.approvedBy) throw new Error(`${s0.pending.id} is already approved by ${s0.pending.approvedBy}`);
  const s = JSON.parse(JSON.stringify(s0));
  Object.assign(s.pending, { approvedBy: String(by), approvedAt: now }); s.history.push({ t: now, event: 'approved', by: String(by), to: s.steps[s.pending.toStep] });
  return s;
}

// write the weights (live) or say what would be written
export function apply(s, pct, { live = false, kubectl = 'kubectl', run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const cmds = patches(s, pct, kubectl);
  if (!live) return { dryRun: true, commands: cmds };
  const out = []; for (const [cmd, ...args] of cmds) out.push(run(cmd, args));
  return { dryRun: false, commands: cmds, output: out };
}
