// gpu-ledger core: usage records → attributed, priced, classified GPU-hours.
//
// A usage record is one allocation of GPUs for a span of time (a pod, a Slurm job, a job attempt, a serving replica
// for an hour). Every adapter produces these; nothing below knows where they came from.
//
//   { id, start, end (epoch s; end null = still running), gpus, gpuType?, cluster?, provider?, region?, node?,
//     kind? ('job'|'pod'|'deployment'|'notebook'), name?, namespace?, labels? {}, group? (retries share it),
//     user?, team?, org?, project?, useCase?,
//     status? ('succeeded'|'failed'|'cancelled'|'preempted'|'running'),
//     util? { busy (0–1: share of GPU-time above the idle threshold), sm (0–1 mean SM activity while busy),
//             memPeak (0–1 of HBM), idleLong (GPU-seconds idle in stretches ≥ 30 min), samples },
//     checkpoint? { intervalS?, lastAt? }, serving? { model, tokensIn, tokensOut, requests },
//     rate? ($/GPU-h actually billed, from a cloud bill: wins over the rate card), purchase?, instanceType? }
//
// Classes (they add up to the allocation): useful, idle (allocated, GPU not working), lost (work thrown away by a
// failure or preemption). Unallocated capacity is counted per cluster and GPU type, outside any one workload.

import { createRequire } from 'node:module';

// Spec-sheet numbers: HBM per GPU, dense BF16 TFLOPS. Used only to say whether a job would fit on another GPU.
// Chips the sizer knows come from the shared accelerator registry; older and smaller ones are listed here.
const REG = createRequire(import.meta.url)('../../inference-sizer/src/accelerators.js');
export const GPU_SPECS = Object.assign(
  Object.fromEntries(REG.ACCELERATORS.map(a => [a.kind === 'tpu' ? a.id : a.short || a.id, { hbmGB: a.hbmGB, tflops: a.tfBf16 }])),
  { 'H20': { hbmGB: 96, tflops: 148 }, 'A100-40GB': { hbmGB: 40, tflops: 312 }, 'L4': { hbmGB: 24, tflops: 121 }, 'A10': { hbmGB: 24, tflops: 125 },
    'T4': { hbmGB: 16, tflops: 65 }, 'V100': { hbmGB: 32, tflops: 125 }, 'P100': { hbmGB: 16, tflops: 19 }, 'K80': { hbmGB: 12, tflops: 4 } });
// "NVIDIA-H100-80GB-HBM3", "h100", "Tesla V100-SXM2-32GB" → a key above (or the input when unknown)
export function gpuKey(s) {
  if (!s) return null;
  const u = String(s).toUpperCase().replace(/^NVIDIA[- ]|^TESLA[- ]|^AMD[- ]|^INSTINCT[- ]/g, '');
  if (/A100.*40GB/.test(u)) return 'A100-40GB';
  for (const k of Object.keys(GPU_SPECS).sort((a, b) => b.length - a.length)) if (!k.endsWith('-40GB') && u.includes(k)) return k;
  return String(s);
}

// ---------- prices ----------
// prices: { currency, default: { provider }, gpus: { H100: { onprem: { capex, years, watts, pue, kwh, opexYear },
//           <provider>: $/GPU-h, … } }, commitments: [{ provider, gpuType, gpus, rate, from?, to? }] }
// On-prem: capex over its life + power + opex, per GPU-hour. The breakdown is returned so it can be checked.
export function rateCard(prices = {}) {
  const out = {};
  for (const [g, p] of Object.entries(prices.gpus || {})) {
    out[g] = {};
    for (const [prov, v] of Object.entries(p)) {
      if (prov === 'hbmGB' || prov === 'tflops') continue;
      if (typeof v === 'number') { out[g][prov] = { rate: v, basis: 'list' }; continue; }
      const capex = (v.capex || 0) / ((v.years || 4) * 8760), power = (v.watts || 0) / 1000 * (v.pue || 1.3) * (v.kwh || 0), opex = (v.opexYear || 0) / 8760;
      out[g][prov] = { rate: capex + power + opex, basis: 'amortized', parts: { capex, power, opex } };
    }
  }
  return out;
}
export function priceOf(card, prices, gpuType, provider) {
  const g = card[gpuType] || card[gpuKey(gpuType)], prov = provider || (prices.default || {}).provider || 'onprem';
  if (!g) return null;
  return g[prov] || g.onprem || Object.values(g)[0] || null;
}

// ---------- attribution ----------
// config: { fields: { org: ['label:org', 'namespace'], team: [...], user: [...], project: [...] },
//           rules: [{ match: { namespace: '^research-', 'label:app': 'x' }, set: { org: 'research' } }],
//           directory: { <user>: { team, org } }, useCase: [{ match: {...}, set: 'training' }], shared: [{ match }] }
const DEFAULT_FIELDS = {
  org: ['org', 'label:org', 'label:organization', 'label:department'],
  team: ['team', 'label:team', 'label:group', 'namespace'],
  user: ['user', 'label:user', 'label:owner', 'label:created-by', 'label:app.kubernetes.io/created-by'],
  project: ['project', 'label:project', 'label:app.kubernetes.io/part-of', 'label:app'],
};
const get = (r, f) => (f.startsWith('label:') ? (r.labels || {})[f.slice(6)] : r[f]);
const matches = (r, m) => Object.entries(m || {}).every(([f, re]) => { const v = get(r, f); return v != null && new RegExp(re).test(String(v)); });
const USE_CASES = [
  ['inference', r => !!r.serving || r.kind === 'deployment' || /serv|infer|vllm|triton|tgi|sglang|endpoint/i.test(r.name || '')],
  ['interactive', r => r.kind === 'notebook' || /jupyter|notebook|debug|dev|interactive|ssh|vscode/i.test(r.name || '')],
  ['evaluation', r => /eval|bench|test/i.test(r.name || '')],
  ['fine-tuning', r => /sft|finetun|fine-tun|lora|dpo|rlhf|grpo|ppo/i.test(r.name || '')],
  ['training', r => /train|pretrain|sweep|hpo/i.test(r.name || '')],
  ['data', r => /prep|etl|tokeniz|embed|data/i.test(r.name || '')],
];
export function attribute(r, cfg = {}) {
  const out = { ...r }, fields = Object.assign({}, DEFAULT_FIELDS, cfg.fields || {});
  for (const k of ['org', 'team', 'user', 'project']) if (out[k] == null) for (const f of fields[k] || []) { const v = get(r, f); if (v != null && v !== '') { out[k] = String(v); break; } }
  const dir = cfg.directory || {};
  if (out.user && dir[out.user]) for (const k of ['team', 'org']) if (dir[out.user][k] && (out[k] == null || out[k] === r.namespace)) out[k] = dir[out.user][k];
  for (const rule of cfg.rules || []) if (matches(out, rule.match)) Object.assign(out, rule.set);
  if (out.team && !out.org && (cfg.teams || {})[out.team]) out.org = cfg.teams[out.team];
  if (!out.useCase) { const u = (cfg.useCase || []).find(x => matches(out, x.match)); out.useCase = u ? u.set : ((USE_CASES.find(([, f]) => f(out)) || ['other'])[0]); }
  if ((cfg.shared || []).some(s => matches(out, s.match))) out.shared = true;
  return out;
}

// ---------- classification ----------
// policy: { lostOn: ['failed','preempted'], cancelled: 'useful'|'lost-tail', wholeIfShorterS: 3600, assumedTailS: 1800 }
export const POLICY = { lostOn: ['failed', 'preempted'], cancelled: 'useful', wholeIfShorterS: 3600, assumedTailS: 1800, neverSucceeded: 3 };
// The share of an allocation's span lost to a failure: since the last checkpoint if known, half the checkpoint
// interval if that is known, the whole run if short (it produced nothing worth keeping), else an assumed tail.
export function lostSpan(r, dur, policy = POLICY) {
  const failed = policy.lostOn.includes(r.status) || (r.status === 'cancelled' && policy.cancelled === 'lost-tail');
  if (!failed || dur <= 0) return { s: 0 };
  if (r._neverSucceeded) return { s: dur, basis: 'every attempt failed: all of it' };
  if (r.checkpoint && r.checkpoint.lastAt != null) return { s: Math.min(dur, Math.max(0, (r.end ?? r.start + dur) - r.checkpoint.lastAt)), basis: 'since last checkpoint' };
  if (r.checkpoint && r.checkpoint.intervalS) return { s: Math.min(dur, r.checkpoint.intervalS / 2), basis: 'half the checkpoint interval' };
  if (dur <= policy.wholeIfShorterS) return { s: dur, basis: 'short run: all of it' };
  return { s: Math.min(dur, policy.assumedTailS), basis: `assumed ${Math.round(policy.assumedTailS / 60)} min since the last checkpoint` };
}

// One record within a window → GPU-seconds by class, and its cost.
export function classify(r, { from = -Infinity, to = Infinity, now = Infinity, policy = POLICY, card, prices = {} } = {}) {
  const end = r.end ?? Math.min(to, now), s = Math.max(r.start, from), e = Math.min(end, to);
  if (!(e > s) || !(r.gpus > 0)) return null;
  const whole = end - r.start, frac = (e - s) / whole, alloc = r.gpus * (e - s);
  const u = r.util || {}, busy = u.busy != null ? Math.max(0, Math.min(1, u.busy)) : null;
  const idle = busy != null ? alloc * (1 - busy) : 0;
  // a failure loses the tail of the run: count it only in the slice of the window that holds the end
  const L = lostSpan(r, whole, policy), tailStart = end - L.s, inWin = Math.max(0, Math.min(e, end) - Math.max(s, tailStart));
  const lost = r.gpus * inWin * (busy != null ? busy : 1);
  const useful = Math.max(0, alloc - idle - lost);
  // a record from a cloud bill carries what was paid per GPU-hour; it wins over the rate card
  const p = r.rate != null ? { rate: r.rate, basis: r.rateBasis || 'bill' } : card ? priceOf(card, prices, r.gpuType, r.provider) : null, rate = p ? p.rate : null;
  const usd = h => (rate == null ? null : rate * h / 3600);
  return {
    r, alloc, useful, idle, lost, idleLong: u.idleLong != null ? u.idleLong * frac : null, lostBasis: L.basis, measured: busy != null,
    rate, rateBasis: p ? p.basis : null, cost: usd(alloc), wasted: usd(idle + lost), smBusy: u.sm,
    tokensOut: r.serving ? (r.serving.tokensOut || 0) * frac : 0, tokensIn: r.serving ? (r.serving.tokensIn || 0) * frac : 0,
  };
}
