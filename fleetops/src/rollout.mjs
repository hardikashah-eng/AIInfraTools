// Safe rollouts of driver, firmware, CUDA, NCCL and kernel versions: a canary cohort first, then waves, each compared
// automatically with the nodes still on the old version. A regression rolls the wave back and halts the rollout, so a
// bad version is stopped on a few nodes instead of found afterwards by the version-cohort rule.
//
// Waves are actions in gpu-health's approval queue (`rollout-stage`): applying one needs a person, rolling back does
// not. Commands run through gpu-health's executors: argv only, values checked, dry run unless --live and
// policy.dryRun: false. Applied waves become `change` records, so root-cause analysis sees them too.
import { loadConfig as ghLoad } from '../../gpu-health/src/config.mjs';
import { Store } from '../../gpu-health/src/actions.mjs';
import { run as runAction, fill } from '../../gpu-health/src/executors.mjs';

const H = 3600, DAY = 86400;
export const ROLLOUT_POLICY = {
  bakeS: 6 * H, minGpuHours: 100,           // treated exposure before a wave can be called good
  failRatio: 1.5, alpha: 0.01,             // failures or hard faults: this many times the control rate, and significant
  busbwDrop: 0.1, computeSlowdown: 0.05, ttftSlowdown: 0.1, minSamples: 20,
  appliedShare: 0.8,                       // share of a wave's nodes that must report the new version before judging it
};
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mode = a => { const m = new Map(); for (const v of a) if (v != null) m.set(String(v), (m.get(String(v)) || 0) + 1); let b = null, n = 0; for (const [k, c] of m) if (c > n) { b = k; n = c; } return b; };
// P(X ≥ k) for X ~ Poisson(λ)
export function poissonSf(k, lam) { if (k <= 0) return 1; let term = Math.exp(-lam), cdf = term; for (let i = 1; i < k; i++) { term *= lam / i; cdf += term; } return Math.max(0, 1 - cdf); }
// Mann-Whitney U, normal approximation: one-sided p that `a` tends to be smaller than `b`
export function mwLess(a, b) {
  const all = a.map(v => [v, 0]).concat(b.map(v => [v, 1])).sort((x, y) => x[0] - y[0]); let r = 0, i = 0;
  const ranks = new Array(all.length);
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1; i = j + 1; }
  for (let k = 0; k < all.length; k++) if (all[k][1] === 0) r += ranks[k];
  const n1 = a.length, n2 = b.length, u = r - n1 * (n1 + 1) / 2, mu = n1 * n2 / 2, sd = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
  return normCdf((u - mu) / (sd || 1));
}
const normCdf = z => 0.5 * erfc(-z / Math.SQRT2);
function erfc(x) { const t = 1 / (1 + 0.5 * Math.abs(x)), y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? y : 2 - y; }

function versionsAt(store, to) {
  const m = new Map();
  for (const r of store.query('inventory', { to })) { const p = m.get(r.node); m.set(r.node, { sku: r.sku ?? (p && p.sku), rack: r.rack ?? (p && p.rack), v: Object.assign({}, p && p.v, r.versions) }); }
  return m;
}

// ---------- the plan ----------
// opts: { field, version, nodes?: [names] | regex string, sku?, canary: 2 | '5%', waves: ['25%','100%'], bakeS,
//         apply?: [[argv with {node} {version} {field}]], rollback?: [[…]], id }
export function plan(store, opts) {
  const now = opts.now ?? Math.floor(Date.now() / 1000), field = opts.field, version = String(opts.version);
  if (!field || !opts.version) throw new Error('--field driver|firmware|cuda|nccl|vbios|kernel and --version V');
  const inv = versionsAt(store, now);
  let nodes = [...inv.entries()].filter(([n, r]) => String(r.v[field]) !== version && (!opts.sku || r.sku === opts.sku));
  if (Array.isArray(opts.nodes)) nodes = nodes.filter(([n]) => opts.nodes.includes(n)); else if (opts.nodes) { const re = new RegExp(opts.nodes); nodes = nodes.filter(([n]) => re.test(n)); }
  if (!nodes.length) throw new Error(`no nodes to move to ${field} ${version} (all there already, or none match)`);
  const from = mode(nodes.map(([, r]) => r.v[field]));
  // canary: spread over racks (and SKUs), avoiding nodes with recent hard faults, deterministic by name
  const faulty = new Set(store.query('log', { from: now - 7 * DAY, to: now, where: l => l.severity === 'hard' }).map(l => l.node));
  const byRack = new Map(); for (const [n, r] of nodes.sort((a, b) => a[0].localeCompare(b[0]))) { const k = `${r.sku}|${r.rack || '-'}`; if (!byRack.has(k)) byRack.set(k, []); byRack.get(k).push(n); }
  const order = []; const queues = [...byRack.values()].map(q => q.filter(n => !faulty.has(n)).concat(q.filter(n => faulty.has(n))));
  while (queues.some(q => q.length)) for (const q of queues) if (q.length) order.push(q.shift());
  const count = (spec, total) => (String(spec).endsWith('%') ? Math.max(1, Math.ceil(total * parseFloat(spec) / 100)) : Math.max(1, +spec));
  const canaryN = Math.min(order.length, count(opts.canary ?? 2, order.length));
  const cuts = [canaryN, ...(opts.waves || ['25%', '100%']).map(w => Math.min(order.length, count(w, order.length)))].filter((c, i, a) => i === 0 || c > a[i - 1]);
  const vars = n => ({ node: n, version, field });
  const cmds = (t, ns) => (Array.isArray(t) ? ns.flatMap(n => t.map(argv => fill(argv, vars(n)))) : null);
  const stages = []; let prev = 0;
  cuts.forEach((c, i) => {
    const ns = order.slice(prev, c); prev = c;
    stages.push({ n: i + 1, title: `${i === 0 ? 'canary' : `wave ${i}`}: ${field} ${from ?? '?'} → ${version} on ${ns.length} node(s)`, nodes: ns,
      apply: cmds(opts.apply, ns) || { webhook: `Move ${field} to ${version} on ${ns.join(', ')} (rollout ${opts.id || ''} ${i === 0 ? 'canary' : `wave ${i}`}).` },
      rollback: cmds(opts.rollback, ns) || { webhook: `Roll ${field} back to ${from} on ${ns.join(', ')}.` },
      bakeS: opts.bakeS ?? ROLLOUT_POLICY.bakeS, status: 'pending' });
  });
  return { id: opts.id || `rollout-${field}-${version}`.replace(/[^A-Za-z0-9._-]/g, '-'), kind: 'version-rollout', field, version, from, createdAt: now, status: 'planned', policy: opts.policy || {}, stages };
}

// ---------- the comparison ----------
// Nodes on `version` (treated) against the same SKUs' nodes still on another version (control), over [since, now].
export function compare(store, { field, version, treated, since, now, policy = {} }) {
  const P = Object.assign({}, ROLLOUT_POLICY, policy), inv = versionsAt(store, now);
  treated = treated || [...inv].filter(([, r]) => String(r.v[field]) === String(version)).map(([n]) => n);
  const T = new Set(treated), skus = new Set(treated.map(n => (inv.get(n) || {}).sku));
  const C = new Set([...inv].filter(([n, r]) => !T.has(n) && skus.has(r.sku) && String(r.v[field]) !== String(version)).map(([n]) => n));
  if (!C.size) return { ok: null, metrics: [], note: 'no control nodes of the same SKU on the old version' };
  // exposure: GPU-hours of placements per side
  const exp = { T: 0, C: 0 }, side = n => (T.has(n) ? 'T' : C.has(n) ? 'C' : null);
  for (const p of store.query('placement', { to: now })) {
    const s = Math.max(since, p.start ?? p.t), e = Math.min(now, p.end ?? now); if (!(e > s)) continue;
    const devs = p.devices && p.devices.length ? p.devices : p.node ? Array.from({ length: p.gpuCount || 1 }, () => ({ node: p.node })) : [];
    for (const d of devs) { const k = side(d.node); if (k) exp[k] += (e - s) / H; }
  }
  const metrics = [], rate = (name, events) => {
    const n = { T: 0, C: 0 }; for (const nd of events) { const k = side(nd); if (k) n[k]++; }
    if (exp.T <= 0 || exp.C <= 0) return;
    const lam = n.C / exp.C * exp.T, p = poissonSf(n.T, lam), ratio = lam > 0 ? n.T / lam : n.T > 0 ? Infinity : 1;
    metrics.push({ name, treated: n.T, expected: lam, ratio, p, regression: n.T >= 2 && ratio >= P.failRatio && p < P.alpha, detail: `${n.T} on the new version vs ${lam.toFixed(1)} expected from the old (${n.C} in ${exp.C.toFixed(0)} GPU-h)` });
  };
  // job failures (not cancellations) on the nodes, and hard faults from logs
  rate('job failures', store.query('job', { from: since, to: now, where: j => ['failed', 'timeout'].includes(j.status) }).flatMap(j => [...new Set((j.devices || []).map(d => d.node).concat(j.nodes || []))]));
  rate('hard faults', store.query('log', { from: since, to: now, where: l => l.severity === 'hard' }).map(l => l.node));
  // NCCL bus bandwidth per node, and per-rank compute time within the same jobs
  const bw = { T: [], C: [] }; for (const c of store.query('collective', { from: since, to: now })) { const k = side(c.node); if (k && Number.isFinite(c.busbw)) bw[k].push(c.busbw); }
  if (bw.T.length >= P.minSamples && bw.C.length >= P.minSamples) {
    const r = median(bw.T) / median(bw.C), p = mwLess(bw.T, bw.C);
    metrics.push({ name: 'NCCL bus bandwidth', ratio: r, p, regression: r < 1 - P.busbwDrop && p < P.alpha, detail: `median ${median(bw.T).toFixed(1)} vs ${median(bw.C).toFixed(1)} GB/s (${bw.T.length} / ${bw.C.length} collectives)` });
  }
  const jobs = new Map(); for (const s of store.query('step', { from: since, to: now })) { const k = side(s.node); if (!k) continue; const v = s.computeS ?? s.durS; if (!Number.isFinite(v)) continue; if (!jobs.has(s.job)) jobs.set(s.job, { T: [], C: [] }); jobs.get(s.job)[k].push(v); }
  const pairs = [...jobs.values()].filter(j => j.T.length >= 5 && j.C.length >= 5);
  if (pairs.length) {
    const ratios = pairs.map(j => median(j.T) / median(j.C)), r = median(ratios), slower = ratios.filter(x => x > 1 + P.computeSlowdown).length;
    metrics.push({ name: 'compute time per step (same job)', ratio: r, regression: r > 1 + P.computeSlowdown && slower / ratios.length >= 0.75, detail: `${((r - 1) * 100).toFixed(1)}% in ${pairs.length} job(s) running on both versions (${slower} slower)` });
  }
  const tt = { T: [], C: [] }; for (const q of store.query('request', { from: since, to: now })) { const k = side(q.node); if (k && Number.isFinite(q.ttft)) tt[k].push(q.ttft); }
  if (tt.T.length >= P.minSamples && tt.C.length >= P.minSamples) {
    const r = median(tt.T) / median(tt.C), p = mwLess(tt.C, tt.T);
    metrics.push({ name: 'TTFT on the nodes', ratio: r, p, regression: r > 1 + P.ttftSlowdown && p < P.alpha, detail: `median ${(median(tt.T) * 1000).toFixed(0)} vs ${(median(tt.C) * 1000).toFixed(0)} ms (${tt.T.length} / ${tt.C.length} requests)` });
  }
  const bad = metrics.filter(m => m.regression);
  if (bad.length) return { ok: false, metrics, exposure: exp, treated: [...T], control: C.size, note: `regression on ${field} ${version}: ${bad.map(m => `${m.name} ${m.detail}`).join('; ')}` };
  if (exp.T < P.minGpuHours && !metrics.some(m => m.name.startsWith('NCCL') || m.name.startsWith('compute'))) return { ok: null, metrics, exposure: exp, treated: [...T], control: C.size, note: `${exp.T.toFixed(0)} GPU-h of work on the new version so far; need ${P.minGpuHours} to judge` };
  return { ok: true, metrics, exposure: exp, treated: [...T], control: C.size, note: `no regression: ${metrics.map(m => `${m.name} ×${m.ratio.toFixed(2)}`).join(', ') || 'no signals'} over ${exp.T.toFixed(0)} GPU-h on ${T.size} node(s)` };
}

// ---------- running it ----------
const actionId = (p, s) => `rollout-stage:${p.id}#${s.n}`;
export function enqueue(p, stateDir, now = Math.floor(Date.now() / 1000)) {
  const st = new Store(stateDir);
  for (const s of p.stages) {
    const id = actionId(p, s); if (st.data.actions.some(a => a.id === id)) continue;
    const a = { id, kind: 'rollout-stage', target: `${p.id}#${s.n}`, mode: 'approve', status: 'proposed', severity: s.n === 1 ? 'medium' : 'high', createdAt: now, updatedAt: now, lastSeen: now, analyzedAt: now,
      reason: `${p.id} ${s.title} (${s.nodes.join(', ')}); compared with the old version after ${Math.round(s.bakeS / H)} h, rolled back automatically on a regression`, params: {}, evidence: [] };
    st.data.actions.push(a); st.audit(a, 'created', { status: 'proposed', mode: 'approve', reason: a.reason });
  }
  st.save(); return p.stages.map(s => actionId(p, s));
}
async function exec(cmd, cfg, { live, runner, poster, label }) {
  const kind = 'rollout-stage', c = Object.assign({}, cfg, { executors: Object.assign({}, cfg.executors, { [kind]: Array.isArray(cmd) ? cmd : cmd && cmd.webhook ? { webhook: cmd.webhook } : 'webhook' }) });
  return runAction({ kind, reason: label, params: {} }, c, { dryRun: !(live && cfg.policy.dryRun === false), runner, poster });
}
const changeKind = f => (/firmware|vbios|inforom|bios/i.test(f) ? 'firmware' : 'driver');

// One step: judge the last wave once baked (roll it back and halt on a regression), else run the next approved wave.
export async function advance(p, { store, stateDir, cfg = ghLoad(), live = false, now = Math.floor(Date.now() / 1000), runner, poster } = {}) {
  const st = new Store(stateDir), log = [], P = Object.assign({}, ROLLOUT_POLICY, p.policy || {});
  if (['halted', 'done'].includes(p.status)) return { plan: p, log: [`rollout is ${p.status}`] };
  const applied = p.stages.filter(s => s.status === 'applied'), last = applied[applied.length - 1];
  if (last) {
    if (now - last.appliedAt < last.bakeS) return { plan: p, log: [`${last.title}: baking until ${new Date((last.appliedAt + last.bakeS) * 1000).toISOString()}`] };
    const inv = versionsAt(store, now), on = last.nodes.filter(n => String(((inv.get(n) || {}).v || {})[p.field]) === p.version);
    if (on.length < P.appliedShare * last.nodes.length && !last.applyResult?.dryRun) return { plan: p, log: [`${last.title}: ${on.length} of ${last.nodes.length} node(s) report ${p.field} ${p.version}; waiting for the inventory`] };
    const treated = p.stages.filter(s => ['applied', 'verified'].includes(s.status)).flatMap(s => s.nodes);
    const g = compare(store, { field: p.field, version: p.version, treated, since: Math.min(...p.stages.filter(s => s.appliedAt).map(s => s.appliedAt)), now, policy: p.policy });
    last.guardResult = g;
    if (g.ok === false) {
      const r = last.rollback ? await exec(last.rollback, cfg, { live, runner, poster, label: `roll back ${p.id} ${last.title}` }) : { dryRun: true };
      last.status = 'rolled-back'; last.rolledBackAt = now; last.rollbackResult = { dryRun: r.dryRun, ok: r.ok, commands: r.commands, text: r.text };
      const a = st.get(actionId(p, last)); if (a) st.audit(a, 'rolled-back', { why: g.note, dryRun: r.dryRun, commands: r.commands });
      p.status = 'halted'; p.haltReason = g.note; st.save();
      if (store) store.append('rollout', [{ t: now, id: p.id, event: 'rolled-back', stage: last.n, field: p.field, version: p.version, nodes: last.nodes, why: g.note, source: 'fleetops-rollout' }]);
      return { plan: p, log: [`regression after ${last.title}: ${g.note}`, `rolled back ${last.nodes.length} node(s)${r.dryRun ? ' (dry run)' : ''}; rollout halted, later waves will not run`] };
    }
    if (g.ok === null) return { plan: p, log: [`${last.title}: ${g.note}; waiting`] };
    last.status = 'verified'; log.push(`${last.title} verified: ${g.note}`);
    if (store) store.append('rollout', [{ t: now, id: p.id, event: 'verified', stage: last.n, field: p.field, version: p.version, nodes: last.nodes, source: 'fleetops-rollout' }]);
  }
  const next = p.stages.find(s => s.status === 'pending');
  if (!next) { p.status = 'done'; st.save(); return { plan: p, log: [...log, 'every wave applied and verified'] }; }
  const a = st.get(actionId(p, next));
  if (!a || a.status !== 'approved') { p.status = 'waiting-approval'; return { plan: p, log: [...log, `${next.title} waits for approval: gpu-health actions approve ${actionId(p, next)} --by NAME --state ${stateDir}`] }; }
  const r = await exec(next.apply, cfg, { live, runner, poster, label: `${p.id} ${next.title}` });
  next.status = r.ok ? 'applied' : 'failed'; next.appliedAt = now; next.applyResult = { dryRun: r.dryRun, ok: r.ok, commands: r.commands, text: r.text, output: r.output };
  Object.assign(a, { status: r.dryRun ? 'approved' : r.ok ? 'executed' : 'failed', executedAt: now, updatedAt: now }); st.audit(a, r.dryRun ? 'dry-run' : r.ok ? 'executed' : 'failed', { commands: r.commands, text: r.text }); st.save();
  if (r.ok && !r.dryRun && store) {
    store.append('change', next.nodes.map(n => ({ t: now, kind: changeKind(p.field), target: n, summary: `${p.field} ${p.from} → ${p.version} (${p.id} ${next.n === 1 ? 'canary' : `wave ${next.n - 1}`})`, from: p.from, to: p.version, id: `${p.id}#${next.n}`, source: 'fleetops-rollout' })));
    store.append('rollout', [{ t: now, id: p.id, event: 'applied', stage: next.n, field: p.field, version: p.version, nodes: next.nodes, source: 'fleetops-rollout' }]);
  }
  p.status = r.ok ? 'rolling-out' : 'failed';
  return { plan: p, log: [...log, `${next.title} ${r.dryRun ? 'dry run' : r.ok ? 'applied' : 'failed'}`] };
}

// ---------- a fleet to try it on ----------
// 24 nodes in 4 racks on one driver; on day 5 two canary nodes move to a new driver. `bad` makes the new driver slower
// on NCCL, slower per step and more likely to fault; otherwise it is the same.
export function synth({ t0 = Date.UTC(2026, 10, 10) / 1000, bad = true, canary = ['gpu-a01', 'gpu-c01'], old = '550.54.15', neu = '560.35.03', seed = 3 } = {}) {
  let s = seed >>> 0; const R = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const nodes = []; for (const rack of ['a', 'b', 'c', 'd']) for (let i = 1; i <= 6; i++) nodes.push({ node: `gpu-${rack}${String(i).padStart(2, '0')}`, rack: `rack-${rack}` });
  const T = t0 + 5 * DAY, end = t0 + 6 * DAY, rec = { inventory: [], topology: [], placement: [], job: [], collective: [], step: [], log: [] };
  for (const n of nodes) {
    rec.inventory.push({ t: t0, node: n.node, vendor: 'nvidia', kind: 'gpu', sku: 'H100', devices: 8, rack: n.rack, versions: { driver: old, cuda: '12.4', nccl: '2.21.5', vbios: '96.00.89.00.01' }, source: 'demo' });
    rec.topology.push({ t: t0, kind: 'rack', from: n.node, to: `rack:${n.rack}`, source: 'demo' });
  }
  for (const c of canary) rec.inventory.push({ t: T, node: c, vendor: 'nvidia', kind: 'gpu', sku: 'H100', devices: 8, rack: nodes.find(n => n.node === c).rack, versions: { driver: neu }, source: 'demo' });
  const isNew = (n, t) => canary.includes(n) && t >= T;
  // jobs: 2-node training jobs every 2 hours on random node pairs, 3 hours each; each logs steps per rank and collectives
  let jid = 0;
  for (let t = t0; t < end; t += 2 * H) for (let k = 0; k < 6; k++) {
    const a = nodes[Math.floor(R() * nodes.length)].node, b0 = nodes[Math.floor(R() * nodes.length)].node, b = b0 === a ? nodes[(nodes.findIndex(n => n.node === a) + 1) % nodes.length].node : b0;
    const pick = R() < 0.5 && t >= T ? canary[k % 2] : a, pair = [pick, b === pick ? a : b], job = `train-${++jid}`, st = t + Math.floor(R() * H), en = st + 3 * H;
    rec.placement.push({ t: st, job, class: 'training', start: st, end: en, devices: pair.flatMap(n => Array.from({ length: 8 }, (_, g) => ({ node: n, gpu: g }))), source: 'demo' });
    const pFail = 0.02 + (bad && pair.some(n => isNew(n, st)) ? 0.25 : 0);
    rec.job.push({ t: en, job, status: R() < pFail ? 'failed' : 'ok', cause: 'unknown', start: st, end: en, devices: pair.map(n => ({ node: n, gpu: 0 })), source: 'demo' });
    for (let step = 0; step < 30; step++) for (const [ri, n] of pair.entries()) {
      const slow = bad && isNew(n, st) ? 1.12 : 1, ts = st + step * 300;
      rec.step.push({ t: ts, job, rank: ri, node: n, step, durS: 1.3, computeS: (1.0 + 0.03 * R()) * slow, commS: 0.2, source: 'demo' });
      rec.collective.push({ t: ts, op: 'AllReduce', job, node: n, rank: ri, comm: job, nranks: 16, execS: 0.05, busbw: (380 + 20 * R()) * (bad && isNew(n, ts) ? 0.78 : 1), source: 'demo' });
    }
  }
  // hard faults: background rate, more on the new driver when bad
  for (let t = t0; t < end; t += H) for (const n of nodes) if (R() < 0.002 + (bad && isNew(n.node, t) ? 0.08 : 0)) rec.log.push({ t: t + 600, node: n.node, gpu: 0, code: 'xid79', class: 'bus', severity: 'hard', msg: 'GPU has fallen off the bus', source: 'demo' });
  return { records: rec, t0, canaryAt: T, end, canary, old, neu };
}
