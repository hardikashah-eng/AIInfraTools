// The root-cause benchmark: labeled incidents, accuracy per cause, and rule weights fitted on labels.
//
// Labels come from three places, all the same shape ({ store, incident, cause, component?, source }):
//   synthetic   generate(): randomized fleets with one planted cause and distractors (this file)
//   injected    injection records written by `fleetops inject` on a test cluster (see inject.mjs; evalInjections)
//   postmortem  JSON lines { incident, cause, component? } against a store rebuilt for each window (rca eval)
//
// Synthetic scenarios test that each rule finds its cause through realistic noise: unrelated changes, harmless log
// lines, background failures, an old fault outside the window, another tenant failing a little, version skew. They
// do not show accuracy on a real fleet: that needs injected and postmortem labels.
import { MemStore } from './memstore.mjs';
import { diagnose, RULE_IDS } from './rca.mjs';
import { detectJobFailures, detectServing, groupIncidents } from './detect.mjs';

const H = 3600;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000; // a fixed time keeps runs repeatable

const hash = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h % 100000; };
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, int: (lo, hi) => lo + Math.floor(u() * (hi - lo + 1)), pick: arr => arr[Math.floor(u() * arr.length)], chance: p => u() < p,
    sample: (arr, k) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); } };
}

// A fleet: nodes behind leaves of 4, racks (one PDU each), owners running 2-GPU jobs, device telemetry, versions.
function fleet(r) {
  const n = r.pick([12, 16, 20, 24]), rackSize = r.pick([6, 8]);
  const nodes = Array.from({ length: n }, (_, i) => `node-${String(i + 1).padStart(2, '0')}`);
  const leafOf = Object.fromEntries(nodes.map((x, i) => [x, `leaf-${Math.floor(i / 4) + 1}`])), rackOf = Object.fromEntries(nodes.map((x, i) => [x, `R${Math.floor(i / rackSize) + 1}`]));
  const owners = Array.from({ length: r.int(3, 6) }, (_, i) => `team-${String.fromCharCode(97 + i)}`);
  const s = new MemStore(), versions = Object.fromEntries(nodes.map(x => [x, { driver: '550.54.15', kernel: '5.15.0-91-generic', vbios: '96.00.74.00.0D' }]));
  const f = { r, s, nodes, leafOf, rackOf, owners, versions, k: 0, noise: r.u() * 0.15 };
  s.append('topology', nodes.flatMap(x => [{ t: T0 - 30 * 86400, kind: 'ib', from: x, to: `switch:${leafOf[x]}` }, { t: T0 - 30 * 86400, kind: 'rack', from: x, to: `rack:${rackOf[x]}` }, { t: T0 - 30 * 86400, kind: 'pdu', from: x, to: `pdu:P${rackOf[x].slice(1)}` }]));
  s.append('topology', [...new Set(Object.values(leafOf))].map(l => ({ t: T0 - 30 * 86400, kind: 'ib', from: `switch:${l}`, to: 'switch:spine-1', uplink: true })));
  return f;
}
const leaves = f => [...new Set(Object.values(f.leafOf))], racks = f => [...new Set(Object.values(f.rackOf))];
const behind = (f, dim, g) => f.nodes.filter(x => (dim === 'leaf' ? f.leafOf : f.rackOf)[x] === g);
// k nodes no single leaf or rack holds most of: one per leaf, round robin
function spread(f, k) {
  const byLeaf = leaves(f).map(l => f.r.sample(behind(f, 'leaf', l), 4));
  const out = [];
  for (let i = 0; out.length < k && i < 4; i++) for (const g of f.r.sample(byLeaf, byLeaf.length)) if (g[i] && out.length < k) out.push(g[i]);
  return out;
}
function job(f, node, t, status, owner) {
  const id = `j${f.k++}`, o = owner || f.owners[f.k % f.owners.length], devices = [{ node, gpu: '0' }, { node, gpu: '1' }];
  f.s.append('placement', [{ t: t - 900, job: id, owner: o, namespace: `ns-${o}`, class: 'batch', start: t - 900, devices }]);
  f.s.append('job', [{ t, job: id, status, cause: 'unknown', start: t - 900, end: t, devices, gpus: 2 }]);
  return id;
}
// what every scenario has: a day of normal jobs, noise failures, device telemetry, and inventory with versions
function background(f, { silent = [] } = {}) {
  const { r } = f;
  for (const x of f.nodes) {
    for (let i = 0; i < r.int(4, 8); i++) job(f, x, T0 - 22 * H + i * 2.5 * H + r.int(0, 600), 'ok');
    for (let i = 0; i < r.int(1, 3); i++) job(f, x, T0 + r.int(300, 3300), 'ok');
    if (r.chance(f.noise)) job(f, x, T0 - r.int(2, 20) * H, 'failed');
    if (r.chance(f.noise)) job(f, x, T0 + r.int(60, 3500), 'failed');
  }
  const dev = [];
  for (let t = T0 - 3 * H; t <= T0 + H; t += 600) for (const x of f.nodes) {
    if (silent.includes(x) && t > T0 - 1.5 * H) continue;
    for (const g of ['0', '1']) dev.push({ t, node: x, gpu: g, vendor: 'nvidia', kind: 'gpu', sku: 'H100', sm: 0.6 + r.u() * 0.3, tensor: 0.4 + r.u() * 0.3, tempC: 60 + r.int(0, 15), faults: [] });
  }
  f.s.append('device', dev);
  f.s.append('inventory', f.nodes.map(x => ({ t: T0 - 7 * 86400, node: x, vendor: 'nvidia', kind: 'gpu', sku: 'H100', devices: 8, versions: f.versions[x] })));
}
function serving(f, pool, { from = T0 - 26 * H, to = T0 + H, at = T0, ttft = [0.6, 0.6], rate = [20, 20], kv = [0.55, 0.55], pre = [0, 0], isl = [900, 900] } = {}) {
  const { r } = f, out = [];
  for (let t = from; t <= to; t += 300) {
    const i = t > at ? 1 : 0, j = 1 + (r.u() - 0.5) * 0.12;
    out.push({ t, pool, windowS: 300, rate: rate[i] * j, ttftP99: ttft[i] * j, tpotP99: 0.04 * j, ttftP50: ttft[i] * 0.4 * j, kvUsage: Math.min(0.995, kv[i] * (1 + (r.u() - 0.5) * 0.04)), preemptions: pre[i], islMean: isl[i] * j, oslMean: 220 });
  }
  f.s.append('serving', out);
}
const kernel = (node, t, code, gpu, msg) => ({ t, node, gpu, code, class: { xid79: 'bus', xid48: 'ecc', xid94: 'ecc', xid95: 'ecc', xid74: 'link', xid63: 'ecc', pcie_aer_corrected: 'pcie', ib_link_down: 'network', nfs_timeout: 'storage' }[code] || 'firmware',
  severity: ['xid63', 'pcie_aer_corrected'].includes(code) ? 'soft' : 'hard', msg: msg || `${code} (benchmark)`, source: 'kernel' });

// Distractors: things that happen on a real fleet and point the wrong way.
const DISTRACTORS = {
  'unrelated-change': f => f.s.append('change', [{ t: T0 - f.r.int(1, 5) * H, kind: f.r.pick(['deploy', 'config']), target: f.r.pick(['serving/embed-svc', 'ns-billing/etl', 'gateway']), summary: 'routine rollout', id: `d${f.k++}` }]),
  'soft-log': f => f.s.append('log', [kernel(f.r.pick(f.nodes), T0 + f.r.int(0, 3000), f.r.pick(['xid63', 'pcie_aer_corrected']), '0')]),
  'old-hard-fault': f => f.s.append('log', [kernel(f.r.pick(f.nodes), T0 - f.r.int(10, 20) * H, 'xid79', '1')]),
  'other-tenant': f => { const x = f.r.pick(f.nodes), o = f.r.pick(f.owners); job(f, x, T0 + f.r.int(100, 3000), 'failed', o); job(f, x, T0 + f.r.int(100, 3000), 'failed', o); },
  'version-skew': f => { const x = f.r.pick(f.nodes); f.versions[x] = Object.assign({}, f.versions[x], { kernel: '5.15.0-94-generic' }); },
};

// One generator per planted cause → { incident, cause (rule id), component?, note }.
const JOBS_WINDOW = { symptom: 'job-failures', from: T0, to: T0 + H };
const SCENARIOS = {
  'workload: one tenant\'s retry storm': f => {
    const { r } = f, bad = f.owners[0], nodes = r.sample(f.nodes, r.int(6, Math.min(14, f.nodes.length)));
    for (const x of nodes) for (let i = 0; i < r.int(2, 5); i++) { const id = job(f, x, T0 + r.int(60, 3500), 'failed', bad); if (r.chance(0.3)) f.s.append('log', [{ t: T0 + r.int(60, 3500), node: x, job: id, code: 'cuda_oom', class: 'app', severity: 'soft', msg: 'CUDA out of memory', source: 'app-log' }]); }
    for (let i = 0; i < r.int(0, 3); i++) job(f, r.pick(f.nodes), T0 + r.int(60, 3500), 'failed', r.pick(f.owners.slice(1)));
    return { incident: JOBS_WINDOW, cause: 'workload' };
  },
  'hardware: GPU fault seen in dmesg': f => {
    const { r } = f, x = r.pick(f.nodes), g = r.pick(['0', '1']), code = r.pick(['xid79', 'xid48', 'xid94', 'xid95', 'xid74']);
    for (let i = 0; i < r.int(4, 9); i++) job(f, x, T0 + r.int(120, 3500), 'failed');
    f.s.append('log', [kernel(x, T0 + r.int(0, 600), code, g)]);
    if (r.chance(0.4)) f.s.append('device', [{ t: T0 + 600, node: x, gpu: g, vendor: 'nvidia', kind: 'gpu', sku: 'H100', faults: [code] }]);
    return { incident: JOBS_WINDOW, cause: 'hardware', component: x };
  },
  'hardware: GPU quarantined by gpu-health': f => {
    const { r } = f, x = r.pick(f.nodes), g = r.pick(['0', '1']);
    for (let i = 0; i < r.int(4, 8); i++) job(f, x, T0 + r.int(120, 3500), 'failed');
    f.s.append('health', [{ t: T0 - r.int(5, 60) * 60, key: `${x}/${g}`, node: x, gpu: g, from: 'serving', to: r.pick(['quarantined', 'suspect']), why: 'corrected ECC errors rising, row remap pending', faultClass: 'ecc' }]);
    return { incident: JOBS_WINDOW, cause: 'hardware', component: x };
  },
  'change: deploy before a latency regression': f => {
    const { r } = f;
    serving(f, 'chat-70b', { ttft: [0.6, r.pick([1.2, 1.6, 2.4])] });
    serving(f, 'embed-svc', {});
    f.s.append('change', [{ t: T0 - r.int(5, 60) * 60, kind: r.pick(['deploy', 'config', 'model']), target: 'serving/chat-70b', summary: 'vllm 0.6.3 → 0.6.4', id: `c${f.k++}` }]);
    return { incident: { symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: T0, to: T0 + 1800 }, cause: 'change' };
  },
  'kv-pressure: KV cache full': f => {
    const { r } = f;
    serving(f, 'chat-70b', { ttft: [0.6, r.pick([1.3, 2, 3])], kv: [0.55, 0.86 + r.u() * 0.12], pre: [0, r.int(2, 30)] });
    return { incident: { symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: T0, to: T0 + 1800 }, cause: 'kv-pressure' };
  },
  'load: traffic surge': f => {
    const { r } = f, m = 1.5 + r.u() * 1.5;
    serving(f, 'chat-70b', { ttft: [0.6, 0.6 * (1 + m)], rate: [20, 20 * m], kv: [0.5, 0.55 + r.u() * 0.25] });
    return { incident: { symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: T0, to: T0 + 1800 }, cause: 'load' };
  },
  'infrastructure: shared storage outage': f => {
    const { r } = f, nodes = spread(f, r.int(5, Math.min(10, f.nodes.length / 2)));
    for (const x of nodes) for (let i = 0; i < r.int(2, 4); i++) job(f, x, T0 + r.int(300, 3500), 'failed');
    const logged = r.sample(nodes, Math.ceil(nodes.length * (0.5 + r.u() * 0.5)));
    f.s.append('log', logged.map(x => r.chance(0.8) ? kernel(x, T0 + r.int(0, 900), 'nfs_timeout', undefined, 'nfs: server storage01 not responding') : { t: T0 + r.int(0, 900), node: x, code: 'mount_failed', class: 'storage', severity: 'hard', msg: 'MountVolume.SetUp failed', source: 'kubernetes-events' }));
    return { incident: JOBS_WINDOW, cause: 'infrastructure' };
  },
  'infrastructure: many owners fail at once, nothing logged': f => {
    const { r } = f, nodes = spread(f, r.int(8, Math.min(14, f.nodes.length - 2)));
    for (const x of nodes) for (let i = 0; i < r.int(2, 4); i++) job(f, x, T0 + r.int(300, 3500), 'failed');
    return { incident: JOBS_WINDOW, cause: 'infrastructure' };
  },
  'shared-component: bad leaf switch': f => {
    const { r } = f, l = r.pick(leaves(f)), under = behind(f, 'leaf', l), nodes = r.chance(0.6) ? under : r.sample(under, 3);
    for (const x of nodes) for (let i = 0; i < r.int(2, 4); i++) job(f, x, T0 + r.int(300, 3500), 'failed');
    if (r.chance(0.3)) job(f, r.pick(f.nodes.filter(x => !under.includes(x))), T0 + r.int(300, 3500), 'failed');
    if (r.chance(0.75)) f.s.append('log', r.sample(nodes, r.int(1, nodes.length)).map(x => r.chance(0.5) ? kernel(x, T0 + r.int(0, 600), 'ib_link_down') : { t: T0 + r.int(0, 900), node: x, code: 'nccl_ib_error', class: 'network', severity: 'hard', msg: 'NCCL WARN NET/IB : Got completion from peer with error 12', source: 'app-log' }));
    return { incident: JOBS_WINDOW, cause: 'shared-component', component: `switch:${l}` };
  },
  'shared-component: rack loses power': f => {
    const { r } = f, rk = r.pick(racks(f)), under = behind(f, 'rack', rk);
    // more than one leaf's worth of the rack, so the rack (not a switch) is what they share
    const nodes = under.length > 4 ? r.sample(under, r.int(5, under.length)) : under;
    for (const x of nodes) for (let i = 0; i < r.int(2, 4); i++) job(f, x, T0 + r.int(300, 3500), 'failed');
    if (r.chance(0.7)) f.s.append('log', r.sample(nodes, r.int(2, nodes.length)).map(x => ({ t: T0 + r.int(0, 600), node: x, code: 'node_not_ready', class: 'node', severity: 'hard', msg: `Node ${x} status is now: NodeNotReady`, source: 'kubernetes-events' })));
    return { incident: JOBS_WINDOW, cause: 'shared-component', component: `rack:${rk}|pdu:P${rk.slice(1)}` };
  },
  'version-cohort: bad driver on some nodes': f => {
    const { r } = f, nodes = spread(f, r.int(3, 5)), field = r.pick(['driver', 'driver', 'kernel', 'vbios']), v = { driver: '560.35.03', kernel: '6.5.0-35-generic', vbios: '96.00.89.00.01' }[field];
    for (const x of nodes) { f.versions[x] = Object.assign({}, f.versions[x], { [field]: v }); for (let i = 0; i < r.int(2, 4); i++) job(f, x, T0 + r.int(300, 3500), 'failed'); }
    if (r.chance(0.5)) f.s.append('change', nodes.map(x => ({ t: T0 + r.int(0, 1800), since: T0 - r.int(2, 12) * H, kind: field === 'vbios' ? 'firmware' : field === 'kernel' ? 'config' : 'driver', target: x, field, from: 'old', to: v, summary: `${field} → ${v}`, id: `${x}:${field}:${v}`, derived: 'inventory' })));
    return { incident: JOBS_WINDOW, cause: 'version-cohort', also: ['change'] };
  },
  'monitoring-gap: exporters stop': f => {
    const { r } = f;
    f.silent = r.sample(f.nodes, Math.ceil(f.nodes.length * (0.4 + r.u() * 0.5)));
    return { incident: { symptom: 'device', from: T0, to: T0 + H }, cause: 'monitoring-gap' };
  },
};
export const SCENARIO_NAMES = Object.keys(SCENARIOS);

// perCause scenarios of every kind, seeded. Each carries its own store.
export function generate({ perCause = 10, seed = 1, distractors = 2, only } = {}) {
  const out = [];
  for (const [name, gen] of Object.entries(SCENARIOS)) {
    if (only && !only.some(o => name.startsWith(o))) continue;
    for (let i = 0; i < perCause; i++) {
      // a scenario depends only on (seed, kind, index): filtering with `only` reproduces it exactly
      const r = rng(seed * 100003 + hash(name) * 7919 + i), f = fleet(r);
      const lab = gen(f);
      for (const d of r.sample(Object.keys(DISTRACTORS), r.int(0, distractors))) DISTRACTORS[d](f);
      background(f, { silent: f.silent });
      out.push(Object.assign({ id: `${name.split(':')[0]}#${i}`, scenario: name, source: 'synthetic', store: f.s }, lab, { incident: Object.assign({ id: `${name.split(':')[0]}#${i}` }, lab.incident) }));
    }
  }
  return out;
}

// Diagnose each labeled incident: rank of the expected rule, the component when one is named, and the ranking.
export function run(labeled, { weights } = {}) {
  const rows = labeled.map(l => {
    const d = diagnose(l.store, l.incident, { weights });
    const rank = d.hypotheses.findIndex(h => h.rule === l.cause);
    const lenient = d.hypotheses.findIndex(h => h.rule === l.cause || (l.also || []).includes(h.rule));
    const top = d.hypotheses[0];
    const compOk = l.component ? !!top && top.rule === l.cause && l.component.split('|').some(c => (top.title + ' ' + top.evidence.map(e => e.what).join(' ')).includes(c.replace(/^\w+:/, ''))) : null;
    return { id: l.id, scenario: l.scenario, source: l.source, cause: l.cause, rank: rank < 0 ? null : rank + 1, lenientTop1: lenient === 0, component: l.component, componentOk: compOk,
      top: top ? top.rule : null, confidence: d.confidence, hyps: d.hypotheses.map(h => ({ rule: h.rule, score: h.rawScore ?? h.score })) };
  });
  return summarize(rows);
}
export function summarize(rows) {
  const n = rows.length || 1, by = {};
  for (const r of rows) { const b = by[r.scenario] || (by[r.scenario] = { n: 0, top1: 0, top3: 0, tops: {} }); b.n++; if (r.rank === 1) b.top1++; if (r.rank && r.rank <= 3) b.top3++; b.tops[r.top || 'none'] = (b.tops[r.top || 'none'] || 0) + 1; }
  const comp = rows.filter(r => r.componentOk != null);
  return { incidents: rows.length, top1: rows.filter(r => r.rank === 1).length / n, top3: rows.filter(r => r.rank && r.rank <= 3).length / n, lenientTop1: rows.filter(r => r.lenientTop1).length / n,
    componentTop1: comp.length ? comp.filter(r => r.componentOk).length / comp.length : null, byScenario: by, misses: rows.filter(r => r.rank !== 1), rows };
}

// Rule weights (one multiplier per rule) that maximize top-1 on `train`, by coordinate ascent over a grid. Rankings
// are recomputed from each row's raw scores, so fitting never re-runs the rules. Report test accuracy on held-out rows.
export function fitWeights(rows, { grid = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4], passes = 3 } = {}) {
  const w = Object.fromEntries(RULE_IDS.map(r => [r, 1]));
  const top1 = (rs, wt) => {
    let ok = 0, margin = 0;
    for (const r of rs) {
      const sc = r.hyps.map(h => ({ rule: h.rule, s: Math.min(1, h.score * (wt[h.rule] ?? 1)) })).sort((a, b) => b.s - a.s);
      if (!sc.length) continue;
      const mine = sc.find(h => h.rule === r.cause), best = sc.find(h => h.rule !== r.cause);
      if (sc[0].rule === r.cause) ok++;
      margin += Math.max(-0.2, Math.min(0.2, (mine ? mine.s : 0) - (best ? best.s : 0)));
    }
    return ok + 0.01 * margin; // ties broken toward wider margins
  };
  let best = top1(rows, w);
  for (let p = 0; p < passes; p++) for (const rule of RULE_IDS) for (const g of grid) {
    const cand = Object.assign({}, w, { [rule]: g }), v = top1(rows, cand);
    if (v > best + 1e-9) { best = v; w[rule] = g; }
  }
  return w;
}
export const applyWeights = (rows, w) => summarize(rows.map(r => {
  const sc = r.hyps.map(h => ({ rule: h.rule, s: Math.min(1, h.score * (w[h.rule] ?? 1)) })).sort((a, b) => b.s - a.s);
  const rank = sc.findIndex(h => h.rule === r.cause);
  return Object.assign({}, r, { rank: rank < 0 ? null : rank + 1, top: sc.length ? sc[0].rule : null, componentOk: r.componentOk == null ? null : rank === 0 && r.componentOk });
}));

// Injected faults (injection records in a store) → detection and diagnosis rows. For each injection: did an incident
// start within its window, how long after the fault did the alarm fire, and where does the expected cause rank.
// Without a detected incident the injection window itself is diagnosed, so diagnosis is still scored.
export function evalInjections(store, { weights, binS = 300, targets = {}, from, to } = {}) {
  const injs = store.query('injection', { from, to }).filter(i => i.applied !== false);
  const rows = injs.map(inj => {
    const end = inj.to ?? inj.from + (inj.forS || 300);
    const incs = groupIncidents([...detectJobFailures(store, { from: inj.from - 1800, to: end + 3600, binS }), ...detectServing(store, { from: inj.from - 1800, to: end + 3600, targets })]);
    const hit = incs.filter(i => i.to > inj.from && i.from < end + 1800 && (!inj.pool || !i.pool || i.pool === inj.pool)).sort((a, b) => (a.alarmAt ?? a.to) - (b.alarmAt ?? b.to))[0];
    const inc = hit || { id: `${inj.id}:window`, symptom: inj.pool ? 'latency' : 'job-failures', pool: inj.pool, metric: inj.pool ? 'ttftP99' : undefined, from: inj.from, to: end + 900 };
    const d = diagnose(store, inc, { weights });
    const rank = inj.expect ? d.hypotheses.findIndex(h => h.rule === inj.expect) : -1, top = d.hypotheses[0];
    const one = (inj.nodes || []).length === 1 ? inj.nodes[0] : null;
    return { id: inj.id, scenario: `injected: ${inj.fault}`, source: 'injected', cause: inj.expect, detected: !!hit, delayS: hit ? Math.max(0, (hit.alarmAt ?? hit.to) - inj.from) : null,
      rank: inj.expect ? (rank < 0 ? null : rank + 1) : undefined, top: top ? top.rule : null, confidence: d.confidence, component: one,
      componentOk: one && inj.expect && top ? top.rule === inj.expect && (top.title + ' ' + top.evidence.map(e => e.what).join(' ')).includes(one) : null,
      hyps: d.hypotheses.map(h => ({ rule: h.rule, score: h.rawScore ?? h.score })) };
  });
  const delays = rows.map(r => r.delayS).filter(v => v != null).sort((a, b) => a - b);
  const q = p => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(p * delays.length))] : null);
  return { injections: rows.length, detected: rows.length ? rows.filter(r => r.detected).length / rows.length : null, delayP50: q(0.5), delayP90: q(0.9),
    diagnosis: summarize(rows.filter(r => r.cause)), rows };
}

// Labeled incidents from postmortems (JSON lines { incident, cause, component? }) against one store → rows.
export function evalLabels(store, labeled, { weights } = {}) {
  return labeled.map((l, i) => {
    const d = diagnose(store, l.incident, { weights }), rank = d.hypotheses.findIndex(h => h.rule === l.cause), top = d.hypotheses[0];
    return { id: l.incident.id || `label#${i}`, scenario: `postmortem: ${l.cause}`, source: 'postmortem', cause: l.cause, rank: rank < 0 ? null : rank + 1, top: top ? top.rule : null, confidence: d.confidence,
      component: l.component || null, componentOk: l.component && top ? top.rule === l.cause && (top.title + ' ' + top.evidence.map(e => e.what).join(' ')).includes(l.component) : null,
      hyps: d.hypotheses.map(h => ({ rule: h.rule, score: h.rawScore ?? h.score })) };
  });
}
