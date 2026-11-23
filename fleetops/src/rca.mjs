// Root-cause analysis, version 1: ranked hypotheses from rules over the shared store.
//
// An incident is a symptom in a window: job failures, a serving latency regression, or devices leaving service.
// Each rule looks for one kind of cause and, when it finds support, returns a hypothesis with a score (0–1), the
// records that support it (evidence), what argues against it, and the steps that would confirm it. Hypotheses are
// ranked by score. The narrative is written from the top hypothesis' evidence; it adds nothing the evidence doesn't say.
//
// Rules: workload (one submitter/namespace), hardware (few nodes, device signals), change (a change shortly before
// onset, in scope), infrastructure (many users and nodes at once, devices fine), kv-pressure, load (above baseline or
// calibrated capacity), monitoring-gap (telemetry vanished), device-lag (one device below its peers).

const H = 3600;
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const share = (counts, total) => [...counts.entries()].map(([k, n]) => ({ k, n, share: total ? n / total : 0 })).sort((a, b) => b.n - a.n);
const count = (arr, f) => { const m = new Map(); for (const x of arr) for (const k of [].concat(f(x)).filter(v => v != null)) m.set(k, (m.get(k) || 0) + 1); return m; };
const clamp01 = v => Math.max(0, Math.min(1, v));
const ref = (kind, r, extra = {}) => Object.assign({ kind, t: r.t }, extra);
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

// ---------- incident detection ----------

// Hours whose failed-job count is well above the trailing day's hourly median: { from, to, symptom: 'job-failures', … }.
// Adjacent flagged hours merge into one incident.
export function detectJobFailureSpikes(store, { from, to, minFailures = 50, ratio = 4 } = {}) {
  const jobs = store.query('job', { from: from != null ? from - 86400 : undefined, to, where: j => j.status === 'failed' || j.status === 'retried' });
  const byHour = new Map();
  for (const j of jobs) { const h = Math.floor(j.t / H) * H; byHour.set(h, (byHour.get(h) || 0) + (j.status === 'failed' ? 1 : 0)); }
  const hours = [...byHour.keys()].sort((a, b) => a - b), out = [];
  for (const h of hours) {
    if (from != null && h < from) continue;
    const trail = hours.filter(x => x < h && x >= h - 86400).map(x => byHour.get(x));
    const base = Math.max(1, median(trail.length ? trail : [0]));
    const n = byHour.get(h);
    if (n >= minFailures && n >= ratio * base) {
      const last = out[out.length - 1];
      if (last && last.to === h) { last.to = h + H; last.failures += n; last.peak = Math.max(last.peak, n); }
      else out.push({ symptom: 'job-failures', from: h, to: h + H, failures: n, peak: n, baselinePerHour: base });
    }
  }
  return out.map(i => Object.assign(i, { id: `job-failures@${iso(i.from)}` }));
}

// Serving windows where TTFT or TPOT p99 is above the target (or 1.5× its trailing median when no target is given).
export function detectServingRegressions(store, { from, to, targets = {}, factor = 1.5 } = {}) {
  const recs = store.query('serving', { from: from != null ? from - 86400 : undefined, to });
  const pools = [...new Set(recs.map(r => r.pool))], out = [];
  for (const pool of pools) {
    const rs = recs.filter(r => r.pool === pool);
    for (const r of rs) {
      if (from != null && r.t <= from) continue;
      const trail = rs.filter(x => x.t < r.t && x.t >= r.t - 86400);
      for (const m of ['ttftP99', 'tpotP99']) {
        const lim = (targets[pool] || {})[m] ?? factor * median(trail.map(x => x[m]));
        if (Number.isFinite(lim) && r[m] > lim) {
          const last = out[out.length - 1];
          if (last && last.pool === pool && last.metric === m && r.t - last.to <= 2 * (r.windowS || 300)) { last.to = r.t; last.peak = Math.max(last.peak, r[m]); }
          else out.push({ symptom: 'latency', pool, metric: m, from: r.t - (r.windowS || 300), to: r.t, peak: r[m], limit: lim });
        }
      }
    }
  }
  return out.map(i => Object.assign(i, { id: `latency:${i.pool}:${i.metric}@${iso(i.from)}` }));
}

// ---------- evidence gathering ----------

function context(store, inc, { lookbackH = 24 } = {}) {
  const from = inc.from, to = inc.to;
  const before = from - lookbackH * H;
  const c = { inc, from, to, before };
  c.jobs = store.query('job', { from, to });
  c.jobsBefore = store.query('job', { from: before, to: from });
  c.placements = store.query('placement', { to }).filter(p => (p.end == null || p.end > before));
  c.changes = store.query('change', { from: before, to });
  c.health = store.query('health', { from: before, to });
  c.devices = store.query('device', { from: from - 2 * H, to });
  c.devicesBefore = store.query('device', { from: before, to: from - 2 * H });
  c.serving = store.query('serving', { from: before, to });
  c.calibration = store.query('calibration', { to });
  // owner and namespace of each job, from its placements (attempt suffixes stripped)
  c.jobMeta = new Map();
  for (const p of c.placements) c.jobMeta.set(p.job.split('#')[0], { owner: p.owner, namespace: p.namespace, class: p.class });
  return c;
}
const failedOf = c => c.jobs.filter(j => j.status === 'failed' || j.status === 'retried');
const nodesOf = j => [...new Set((j.devices || []).map(d => d.node).concat(j.nodes || []))];

// ---------- rules ----------

const RULES = {
  // One submitter or namespace owns most of the failures while the rest of the fleet runs normally.
  workload(c) {
    if (c.inc.symptom !== 'job-failures') return null;
    const f = failedOf(c);
    if (f.length < 5) return null;
    const meta = j => c.jobMeta.get(j.job.split('#')[0]) || {};
    const owners = share(count(f, j => meta(j).owner), f.length), nss = share(count(f, j => meta(j).namespace), f.length);
    const top = [owners[0], nss[0]].filter(Boolean).sort((a, b) => b.share - a.share)[0];
    if (!top || top.share < 0.5) return null;
    const dim = top === owners[0] ? 'owner' : 'namespace';
    const others = c.jobs.filter(j => meta(j)[dim] !== top.k), otherFail = others.filter(j => j.status === 'failed').length / Math.max(1, others.filter(j => j.status !== 'retried').length);
    const beforeOthers = c.jobsBefore.filter(j => meta(j)[dim] !== top.k && j.status !== 'retried'), beforeRate = beforeOthers.filter(j => j.status === 'failed').length / Math.max(1, beforeOthers.length);
    const nodes = new Set(f.filter(j => meta(j)[dim] === top.k).flatMap(nodesOf));
    const runMin = median(f.filter(j => meta(j)[dim] === top.k && j.start != null).map(j => (j.end ?? j.t) - j.start)) / 60;
    // what the devices under those jobs were doing: telemetry that stayed up and fault-free argues against hardware
    const seen = new Set(c.devices.map(d => d.node)), watched = [...nodes].filter(n => seen.has(n));
    const bad = c.devices.filter(d => nodes.has(d.node) && ((d.offlineMinutes || 0) > 0 || (d.faults || []).length));
    const sick = c.health.filter(h => nodes.has(h.node) && ['quarantined', 'rma'].includes(h.to) && h.t >= c.from - 2 * H);
    const score = clamp01(0.4 + 0.5 * top.share + (nodes.size >= 10 ? 0.1 : 0) - (otherFail > 2 * beforeRate + 0.05 ? 0.3 : 0) - (sick.length ? 0.2 : 0));
    return {
      cause: 'workload', title: `One ${dim} (${top.k}) owns ${Math.round(top.share * 100)}% of the failures`, score,
      evidence: [
        { what: `${top.n} of ${f.length} failed or retried jobs belong to ${dim} ${top.k}`, refs: [ref('job', { t: c.from }, { [dim]: top.k, count: top.n })] },
        { what: `they ran on ${nodes.size} different nodes${Number.isFinite(runMin) ? `, and failed after a median ${runMin.toFixed(0)} minutes` : ''}` },
        { what: `other ${dim}s failed at ${(otherFail * 100).toFixed(0)}% in the window vs ${(beforeRate * 100).toFixed(0)}% in the day before` },
        ...(watched.length ? [{ what: bad.length || sick.length ? `${bad.length + sick.length} device signal(s) on those nodes` : `telemetry from ${watched.length} of those nodes shows no offline GPUs, fault codes or health events` }] : []),
      ],
      against: otherFail > 2 * beforeRate + 0.05 ? [`other ${dim}s are failing more than usual too`] : [],
      verify: [`Read the exit codes and logs of a few of ${top.k}'s failed jobs: a shared error (bad input, config, code change) confirms it.`,
        `Check whether ${top.k} submitted a new job version or config just before ${iso(c.from)}.`,
        `If they share an error, contact the owner and pause their retries; the GPUs are not the cause.`],
      likelyCause: 'app',
    };
  },

  // Failures or device signals concentrated on a few nodes; device evidence on those nodes.
  hardware(c) {
    const f = c.inc.symptom === 'job-failures' ? failedOf(c) : [];
    const nodeCount = count(f, nodesOf), totalNodes = new Set(c.placements.flatMap(p => (p.devices || []).map(d => d.node).concat(p.node || []))).size || 1;
    const hot = share(nodeCount, f.length).filter(x => x.n >= 3 && x.share >= 0.1).slice(0, 5);
    const sick = c.health.filter(h => ['quarantined', 'rma', 'suspect'].includes(h.to) && h.t >= c.from - 2 * H);
    const faults = c.devices.filter(d => (d.faults || []).length);
    const offline = c.devices.filter(d => (d.offlineMinutes || 0) > 0);
    const scopeNodes = new Set([...hot.map(x => x.k), ...sick.map(h => h.node), ...faults.map(d => d.node), ...(c.inc.nodes || [])]);
    if (!scopeNodes.size) return null;
    let score = 0.15;
    if (hot.length) score += 0.25 * Math.min(1, hot.reduce((t, x) => t + x.share, 0));
    if (sick.length) score += 0.3;
    if (faults.length) score += 0.3;
    if (offline.length) score += 0.1;
    if (hot.length && !sick.length && !faults.length && !offline.length) score -= 0.15; // failures cluster, devices look fine
    const evidence = [];
    for (const x of hot) evidence.push({ what: `${x.n} failed jobs (${Math.round(x.share * 100)}%) ran on ${x.k}`, refs: [ref('job', { t: c.from }, { node: x.k })] });
    for (const h of sick.slice(0, 5)) evidence.push({ what: `${h.key} went ${h.from || 'serving'} → ${h.to} at ${iso(h.t)}: ${h.why}`, refs: [ref('health', h, { key: h.key })] });
    for (const d of faults.slice(0, 5)) evidence.push({ what: `${d.node}/${d.gpu} reported ${d.faults.join(', ')} at ${iso(d.t)}`, refs: [ref('device', d, { node: d.node, gpu: d.gpu })] });
    if (offline.length) evidence.push({ what: `${new Set(offline.map(d => d.node + '/' + d.gpu)).size} device(s) had offline minutes in the window` });
    return {
      cause: 'hardware', title: `Device or node fault on ${[...scopeNodes].slice(0, 3).join(', ')}${scopeNodes.size > 3 ? ` and ${scopeNodes.size - 3} more` : ''}`, score: clamp01(score), evidence,
      against: [...(!sick.length && !faults.length ? ['no health events or fault codes on these devices'] : []), ...(hot.length && totalNodes > 20 && hot.reduce((t, x) => t + x.share, 0) < 0.3 ? ['failures are spread over many nodes'] : [])],
      verify: ['Run a level-3 diag on the named nodes (gpu-health run-diag).', 'Check dmesg for XIDs and the exporter for ECC and link counters around the onset.', 'If jobs fail on these nodes but not elsewhere for the same owner, drain the nodes.'],
      likelyCause: 'device',
    };
  },

  // A change shortly before onset, in scope: the most predictive single signal.
  change(c) {
    const lookback = 6 * H, inScope = ch => {
      const t = String(ch.target || '').toLowerCase();
      const scope = [c.inc.pool, ...(c.inc.nodes || [])].filter(Boolean).map(s => String(s).toLowerCase());
      return !scope.length || scope.some(s => t.includes(s) || s.includes(t.split('/').pop())) || /cluster|fleet|global|all|driver|firmware/.test(t + ' ' + ch.kind);
    };
    const cands = c.changes.filter(ch => ch.t <= c.from + 15 * 60 && ch.t >= c.from - lookback && inScope(ch))
      .map(ch => ({ ch, near: 1 - Math.max(0, c.from - ch.t) / lookback }))
      .sort((a, b) => b.near - a.near);
    if (!cands.length) return null;
    const best = cands[0], ch = best.ch;
    const kindW = { driver: 1, firmware: 1, deploy: 0.9, model: 0.9, config: 0.8, scale: 0.6, policy: 0.6 }[ch.kind] ?? 0.5;
    return {
      cause: 'change', title: `${ch.kind} change "${ch.summary || ch.id}" on ${ch.target}, ${Math.round((c.from - ch.t) / 60)} min before onset`, score: clamp01(0.35 + 0.5 * best.near * kindW),
      evidence: cands.slice(0, 3).map(x => ({ what: `${iso(x.ch.t)} ${x.ch.kind} on ${x.ch.target}: ${x.ch.summary || ''}${x.ch.by ? ` (by ${x.ch.by})` : ''}`, refs: [ref('change', x.ch, { id: x.ch.id, target: x.ch.target })] })),
      against: [],
      verify: [`Compare the symptom on targets the change did and did not reach (canary vs rest).`, `Roll back ${ch.id || 'the change'} on one target, or replay the pre-change config in FleetScope, and see whether the symptom clears.`],
      likelyCause: ch.kind === 'driver' || ch.kind === 'firmware' ? 'infra' : 'app',
    };
  },

  // Many users and nodes failing together while devices look healthy: something they all share.
  infrastructure(c) {
    if (c.inc.symptom !== 'job-failures') return null;
    const f = failedOf(c);
    if (f.length < 10) return null;
    const owners = share(count(f, j => (c.jobMeta.get(j.job.split('#')[0]) || {}).owner), f.length);
    const nodes = new Set(f.flatMap(nodesOf));
    if (!owners.length || owners[0].share >= 0.5 || nodes.size < 5) return null;
    const devOk = !c.health.some(h => h.t >= c.from - H && ['quarantined', 'rma'].includes(h.to)) && !c.devices.some(d => (d.faults || []).length);
    return {
      cause: 'infrastructure', title: `Failures across ${owners.length} owners and ${nodes.size} nodes at once`, score: clamp01(0.3 + 0.3 * (1 - owners[0].share) + (devOk ? 0.2 : 0) + (nodes.size >= 20 ? 0.1 : 0)),
      evidence: [{ what: `${f.length} failed or retried jobs from ${owners.length} owners on ${nodes.size} nodes; the largest owner has ${Math.round(owners[0].share * 100)}%` }, ...(devOk ? [{ what: 'no device health events or fault codes in the window' }] : [])],
      against: devOk ? [] : ['device faults were reported in the window'],
      verify: ['Check shared services at the onset: storage (checkpoint/dataset mounts), network fabric, scheduler, image registry.', 'Look for a common error string in the failed jobs\' logs.'],
      likelyCause: 'infra',
    };
  },

  // KV cache near full while latency rose: preemption and queueing.
  'kv-pressure'(c) {
    if (c.inc.symptom !== 'latency') return null;
    const rs = c.serving.filter(r => r.pool === c.inc.pool), during = rs.filter(r => r.t > c.from && r.t <= c.to), before = rs.filter(r => r.t <= c.from);
    const kv = median(during.map(r => r.kvUsage)), kv0 = median(before.map(r => r.kvUsage));
    if (!Number.isFinite(kv) || kv < 0.85) return null;
    const pre = median(during.map(r => r.preemptions)), q = median(during.map(r => r.queued ?? r.running));
    return {
      cause: 'kv-pressure', title: `KV cache ${Math.round(kv * 100)}% full on ${c.inc.pool}`, score: clamp01(0.4 + (kv - 0.85) * 3 + (Number.isFinite(pre) && pre > 0 ? 0.15 : 0) + (Number.isFinite(kv0) && kv - kv0 > 0.1 ? 0.1 : 0)),
      evidence: [{ what: `KV-cache use ${Math.round(kv * 100)}% during the regression${Number.isFinite(kv0) ? ` vs ${Math.round(kv0 * 100)}% before` : ''}`, refs: during.slice(0, 3).map(r => ref('serving', r, { pool: r.pool })) },
        ...(Number.isFinite(pre) && pre > 0 ? [{ what: `${pre} preemptions per window` }] : []), ...(Number.isFinite(q) ? [{ what: `${q} requests running/queued per window` }] : [])],
      against: [],
      verify: ['Check vLLM preemption counters (vllm:num_preemptions_total) and queue depth over the window.', 'In FleetScope, replay the window with lower per-replica concurrency or one more decode replica and compare TTFT p99.'],
      likelyCause: 'capacity',
    };
  },

  // Request rate well above its baseline, or above the pool's calibrated capacity.
  load(c) {
    if (c.inc.symptom !== 'latency') return null;
    const rs = c.serving.filter(r => r.pool === c.inc.pool), during = rs.filter(r => r.t > c.from && r.t <= c.to), before = rs.filter(r => r.t <= c.from);
    const r1 = median(during.map(r => r.rate)), r0 = median(before.map(r => r.rate));
    if (!Number.isFinite(r1) || !Number.isFinite(r0) || r0 <= 0 || r1 < 1.2 * r0) return null;
    const isl1 = median(during.map(r => r.islMean)), isl0 = median(before.map(r => r.islMean));
    return {
      cause: 'load', title: `Traffic on ${c.inc.pool} ${(r1 / r0).toFixed(1)}× its baseline`, score: clamp01(0.3 + 0.4 * Math.min(1, (r1 / r0 - 1))),
      evidence: [{ what: `request rate ${r1.toFixed(2)}/s vs ${r0.toFixed(2)}/s in the day before`, refs: during.slice(0, 3).map(r => ref('serving', r, { pool: r.pool })) },
        ...(Number.isFinite(isl1) && Number.isFinite(isl0) && isl1 > 1.2 * isl0 ? [{ what: `prompts ${Math.round(isl1)} tokens on average vs ${Math.round(isl0)}` }] : [])],
      against: [],
      verify: ['Check the autoscaler: did replicas scale up, and how fast?', 'Run the FleetScope live twin with this rate to see whether the calibrated pool meets the SLO.'],
      likelyCause: 'capacity',
    };
  },

  // Telemetry vanished: the symptom may be the monitoring, not the fleet.
  'monitoring-gap'(c) {
    const per = d => new Set(d.map(x => x.node + '/' + x.gpu)).size;
    const now = per(c.devices), before = per(c.devicesBefore);
    if (!before || now >= 0.7 * before) return null;
    return {
      cause: 'monitoring-gap', title: `Telemetry from ${before - now} of ${before} devices stopped`, score: clamp01(0.3 + 0.6 * (1 - now / before)),
      evidence: [{ what: `${now} devices reported in the window vs ${before} the day before` }], against: [],
      verify: ['Check the exporters and the scrape pipeline before acting on devices (gpu-health\'s circuit breaker does this too).'],
      likelyCause: 'infra',
    };
  },
};

// Diagnose one incident: every rule, ranked; plus a narrative from the top hypothesis' evidence.
export function diagnose(store, inc, opts = {}) {
  const c = context(store, inc, opts);
  const hyps = Object.entries(RULES).map(([id, f]) => { try { const h = f(c); return h && Object.assign({ rule: id }, h); } catch (e) { return { rule: id, error: e.message, score: 0 }; } })
    .filter(h => h && !h.error && h.score > 0.05).sort((a, b) => b.score - a.score);
  const top = hyps[0], ruledOut = Object.keys(RULES).filter(id => !hyps.some(h => h.rule === id));
  const conf = !top ? 'none' : top.score >= 0.75 && (!hyps[1] || top.score - hyps[1].score >= 0.15) ? 'high' : top.score >= 0.5 ? 'medium' : 'low';
  const narrative = !top ? 'No rule found support for a cause in the store for this window.'
    : `Most likely: ${top.title} (${conf} confidence). ${top.evidence.map(e => e.what).join('; ')}.${top.against.length ? ` Against: ${top.against.join('; ')}.` : ''} To confirm: ${top.verify[0]}${hyps[1] ? ` Next most likely: ${hyps[1].title}.` : ''}`;
  return { t: inc.to, id: inc.id || `${inc.symptom}@${iso(inc.from)}`, incident: inc, confidence: conf, hypotheses: hyps, ruledOut, narrative, source: 'fleetops-rca' };
}

// Top-1 / top-3 accuracy on labeled incidents: [{ incident, cause }] where cause is a rule id.
export function evaluate(store, labeled, opts) {
  const rows = labeled.map(l => { const d = diagnose(store, l.incident, opts); const rank = d.hypotheses.findIndex(h => h.rule === l.cause); return { id: d.id, cause: l.cause, got: d.hypotheses.slice(0, 3).map(h => h.rule), rank: rank < 0 ? null : rank + 1 }; });
  const n = rows.length || 1;
  return { incidents: rows.length, top1: rows.filter(r => r.rank === 1).length / n, top3: rows.filter(r => r.rank && r.rank <= 3).length / n, rows };
}

export function markdown(d) {
  const L = [`## ${d.id}`, '', `**${d.hypotheses[0] ? d.hypotheses[0].title : 'No cause found'}** — confidence ${d.confidence}`, '', d.narrative, '', `Checked with no support: ${d.ruledOut.join(', ') || '–'}.`, ''];
  d.hypotheses.forEach((h, i) => {
    L.push(`### ${i + 1}. ${h.title} (${h.rule}, score ${h.score.toFixed(2)})`, '');
    for (const e of h.evidence) L.push(`- ${e.what}`);
    if (h.against.length) L.push(`- *Against:* ${h.against.join('; ')}`);
    L.push('', 'Verify:', ...h.verify.map(v => `1. ${v}`), '');
  });
  return L.join('\n');
}
