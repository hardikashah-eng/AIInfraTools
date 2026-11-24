// Silent data corruption: GPUs that compute wrong answers without raising an error.
//
// Evidence, strongest first (sdc_check records unless noted):
//   canary          a deterministic test on the GPU gave a different answer than the same test on its peers or the
//                   golden value (tools/sdc-canary.py)                                              → confirms
//   replay          a training step recomputed on another GPU did not match                         → confirms
//   param-checksum  data-parallel replicas must hold identical parameters after each step; a replica whose checksum
//                   differs from the majority of its group (3+ replicas) corrupted something         → strong
//   nan             the first rank whose gradients or loss went non-finite (also `non_finite` app logs with a rank)
//   grad-norm       a rank whose local gradient norm is far from its peers' step after step (step records' gradNorm)
// A device's score combines its evidence (1 − Π(1 − s)); the same device in more than one job, or named by more than one
// kind of evidence, counts more.
// For each affected job: the first step with evidence, and the last checkpoint before it, which is where to resume.

const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const key = r => `${r.node}/${r.gpu ?? '?'}`;
const W = { canary: 1, replay: 0.95, 'param-checksum': 0.7, nan: 0.35, 'grad-norm': 0.2 };

export function findSdc(store, { from, to } = {}) {
  if (store.flush) store.flush();
  const checks = store.query('sdc_check', { from, to });
  const ev = []; // { key, node, gpu, job?, step?, t, check, strength, why }
  const push = (r, check, why, strength = W[check]) => ev.push({ key: key(r), node: r.node, gpu: r.gpu != null ? String(r.gpu) : null, job: r.job, step: r.step, t: r.t, check, strength, why });

  // canary and replay results name the device directly
  for (const c of checks.filter(c => c.check === 'canary' && c.ok === false)) push(c, 'canary', `canary${c.test ? ' ' + c.test : ''} gave ${c.value ?? 'a different result'}${c.expected != null ? `, expected ${c.expected}` : ''}`);
  for (const c of checks.filter(c => c.check === 'replay' && c.ok === false)) push(c, 'replay', `step ${c.step} of ${c.job} recomputed${c.replayNode ? ` on ${c.replayNode}/${c.replayGpu}` : ''} did not match`);

  // parameter checksums: the minority replica within (job, step, group)
  const groups = new Map();
  for (const c of checks.filter(c => c.check === 'param-checksum' && c.value != null)) { const k = `${c.job}|${c.step}|${c.group ?? ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const pairs = new Map();
  for (const rs of groups.values()) {
    if (rs.length === 2 && String(rs[0].value) !== String(rs[1].value)) {
      // two replicas disagree: corruption happened, but not which one; counted once per job and device
      for (const r of rs) if (!pairs.has(`${r.job}|${key(r)}`)) { pairs.set(`${r.job}|${key(r)}`, 1); push(r, 'param-checksum', `the two replicas of rank ${r.rank}'s shard disagree after step ${r.step} of ${r.job} (two replicas can't say which one is wrong)`, 0.25); }
      continue;
    }
    if (rs.length < 3) continue;
    const count = new Map(); for (const r of rs) count.set(String(r.value), (count.get(String(r.value)) || 0) + 1);
    const [maj, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n <= rs.length / 2) continue; // no majority: can't tell which side is wrong
    for (const r of rs.filter(r => String(r.value) !== maj)) push(r, 'param-checksum', `parameters of rank ${r.rank} differ from ${n} of ${rs.length} replicas after step ${r.step} of ${r.job}`);
  }

  // non-finite values: the first rank of each job to go non-finite
  const nans = [...checks.filter(c => c.check === 'nan'), ...store.query('log', { from, to, where: l => l.code === 'non_finite' && l.node })];
  const byJob = new Map();
  for (const r of nans) { const j = r.job || '?'; if (!byJob.has(j) || r.t < byJob.get(j).t) byJob.set(j, r); }
  for (const [j, r] of byJob) {
    const same = nans.filter(x => (x.job || '?') === j && Math.abs(x.t - r.t) < 1);
    if (new Set(same.map(key)).size === 1) push(r, 'nan', `first non-finite ${r.what || 'values'} in ${j}${r.step != null ? ` at step ${r.step}` : ''} came from rank ${r.rank ?? '?'}`);
  }

  // local gradient norms: a rank far from its peers on several steps
  const steps = store.query('step', { from, to, where: s => Number.isFinite(s.gradNorm) && s.gradNorm > 0 });
  const byStep = new Map();
  for (const s of steps) { const k = `${s.job}|${s.step}`; if (!byStep.has(k)) byStep.set(k, []); byStep.get(k).push(s); }
  const outl = new Map();
  for (const ss of byStep.values()) {
    if (ss.length < 4) continue;
    const l = ss.map(s => Math.log(s.gradNorm)), m = med(l), mad = med(l.map(v => Math.abs(v - m))) || 0.01;
    ss.forEach((s, i) => { if (Math.abs(l[i] - m) / (1.4826 * mad) > 8) { const k = `${s.job}|${key(s)}`; if (!outl.has(k)) outl.set(k, []); outl.get(k).push(s); } });
  }
  for (const list of outl.values()) if (list.length >= 3) { const s = list[0]; push(s, 'grad-norm', `rank ${s.rank}'s local gradient norm was far from its peers' on ${list.length} steps of ${s.job}`); }

  // per device
  const devs = new Map();
  for (const e of ev) {
    if (!devs.has(e.key)) devs.set(e.key, { key: e.key, node: e.node, gpu: e.gpu, evidence: [], jobs: new Set() });
    const d = devs.get(e.key); d.evidence.push(e); if (e.job) d.jobs.add(e.job);
  }
  const devices = [...devs.values()].map(d => {
    const kinds = new Set(d.evidence.map(e => e.check));
    let miss = 1;
    for (const e of d.evidence) miss *= 1 - e.strength;
    let score = 1 - miss;
    if (d.jobs.size >= 2) score = Math.min(1, score + 0.2); // the same GPU in different jobs: not the data
    if (kinds.size >= 2) score = Math.min(1, score + 0.15); // different kinds of evidence pointing at the same GPU
    const confirmed = kinds.has('canary') || kinds.has('replay') || d.evidence.filter(e => e.check === 'param-checksum' && e.strength >= 0.7).length >= 2;
    return { key: d.key, node: d.node, gpu: d.gpu, score: +score.toFixed(3), verdict: confirmed ? 'confirmed' : score >= 0.5 ? 'suspect' : 'watch', checks: [...kinds], jobs: [...d.jobs],
      first: Math.min(...d.evidence.map(e => e.t)), evidence: d.evidence.sort((a, b) => a.t - b.t).map(({ key: _k, ...e }) => e) };
  }).sort((a, b) => b.score - a.score);

  // per job: where the corruption started, and the checkpoint to resume from
  const jobs = [];
  for (const j of new Set(ev.filter(e => e.job).map(e => e.job))) {
    const mine = ev.filter(e => e.job === j && devices.find(d => d.key === e.key && d.verdict !== 'watch'));
    if (!mine.length) continue;
    const first = mine.reduce((a, b) => (b.t < a.t ? b : a));
    const ck = [...store.query('step', { to: first.t, where: s => s.job === j && s.ckptS > 0 && (first.step == null || s.step < first.step) }).map(s => ({ step: s.step, t: s.t })),
      ...store.query('log', { to: first.t, where: l => l.code === 'checkpoint_saved' && l.job === j && (first.step == null || l.step == null || l.step < first.step) }).map(l => ({ step: l.step, t: l.t }))]
      .filter(c => c.t < first.t).sort((a, b) => b.t - a.t)[0] || null;
    jobs.push({ job: j, firstBad: { t: first.t, step: first.step ?? null, check: first.check, device: first.key }, lastCleanCheckpoint: ck, devices: [...new Set(mine.map(e => e.key))] });
  }
  return { window: { from, to }, devices, jobs };
}

// Results gpu-health reads (kind "sdc"): confirmed and suspect devices quarantine there with fault class sdc.
export const toGpuHealthResults = r => r.devices.filter(d => d.verdict !== 'watch').flatMap(d => d.evidence.filter(e => e.strength >= 0.35).map(e => ({ t: e.t, kind: 'sdc', node: d.node, gpu: d.gpu, type: e.check === 'replay' ? 'replay-mismatch' : e.check === 'canary' ? 'canary-fail' : e.check === 'param-checksum' ? 'checksum-mismatch' : 'nan-origin', job: e.job, source: 'fleetops-sdc' })));

export function sdcMarkdown(r) {
  const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  const L = ['# Silent data corruption', ''];
  if (!r.devices.length) return L.concat(['No evidence of silent data corruption in the window.', '']).join('\n');
  L.push('| GPU | Verdict | Score | Evidence | Jobs |', '|---|---|---:|---|---|');
  for (const d of r.devices) L.push(`| ${d.key} | ${d.verdict} | ${d.score.toFixed(2)} | ${d.evidence.slice(0, 3).map(e => e.why).join('; ')}${d.evidence.length > 3 ? `; and ${d.evidence.length - 3} more` : ''} | ${d.jobs.join(', ') || '–'} |`);
  if (r.jobs.length) {
    L.push('', '| Job | First sign | Resume from |', '|---|---|---|');
    for (const j of r.jobs) L.push(`| ${j.job} | ${j.firstBad.step != null ? `step ${j.firstBad.step}, ` : ''}${iso(j.firstBad.t)} (${j.firstBad.check} on ${j.firstBad.device}) | ${j.lastCleanCheckpoint ? `checkpoint at step ${j.lastCleanCheckpoint.step ?? '?'} (${iso(j.lastCleanCheckpoint.t)})` : 'no checkpoint before the first sign: from the start, or check older checkpoints with a replay'} |`);
    L.push('', 'Checkpoints saved after the first sign may hold corrupted weights: resume from the one named, on other GPUs.');
  }
  return L.join('\n') + '\n';
}
