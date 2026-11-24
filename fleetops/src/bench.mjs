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
import { detectJobFailures, detectServing, detectTraining, groupIncidents } from './detect.mjs';

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
  s.append('topology', nodes.flatMap((x, i) => [{ t: T0 - 30 * 86400, kind: 'ib', from: x, to: `switch:${leafOf[x]}`, port: (i % 4) + 1 }, { t: T0 - 30 * 86400, kind: 'rack', from: x, to: `rack:${rackOf[x]}` }, { t: T0 - 30 * 86400, kind: 'pdu', from: x, to: `pdu:P${rackOf[x].slice(1)}` }]));
  s.append('topology', [...new Set(Object.values(leafOf))].map(l => ({ t: T0 - 30 * 86400, kind: 'ib', from: `switch:${l}`, to: 'switch:spine-1', port: 33, uplink: true })));
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
  'straggler: one slow GPU in a training job': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(2, Math.min(6, f.nodes.length))), ranks = [];
    for (const x of nodes) for (const g of ['0', '1', '2', '3']) ranks.push({ node: x, gpu: g });
    const bad = r.pick(ranks), slow = 1.3 + r.u() * 1.2, base = 0.8 + r.u() * 0.6, steps = [];
    for (let i = 0; i < 160; i++) {
      const t = T0 - 3 * H + i * 90, after = t > T0;
      for (const [k, rk] of ranks.entries()) {
        const comp = base * (after && rk === bad ? slow : 1) * (1 + (r.u() - 0.5) * 0.04), slowest = base * (after ? slow : 1);
        const comm = 0.1 + (after ? slowest - comp : 0) + r.u() * 0.01; // the others wait for the slowest
        steps.push({ t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: comp + comm, commS: +comm.toFixed(4), computeS: +comp.toFixed(4) });
      }
    }
    f.s.append('step', steps);
    if (r.chance(0.6)) f.s.append('device', [0, 1, 2, 3].map(i => ({ t: T0 + 300 + i * 600, node: bad.node, gpu: bad.gpu, vendor: 'nvidia', kind: 'gpu', clockMHz: r.int(700, 1200), maxClockMHz: 1980, tempC: r.int(85, 92), faults: [] })));
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'straggler', component: bad.node };
  },
  'silent-corruption: one GPU corrupts its replica': f => {
    // three or more data-parallel replicas: with two, a disagreement can't say which one is wrong
    const { r } = f, nodes = r.sample(f.nodes, r.int(3, Math.min(5, f.nodes.length))), ranks = nodes.flatMap(x => ['0', '1', '2', '3'].map(g => ({ node: x, gpu: g })));
    const bad = r.pick(ranks), badK = ranks.indexOf(bad), startStep = r.int(40, 70), steps = [], checks = [];
    // 4-way tensor parallel inside a node, data parallel across nodes: each tensor-parallel rank's replicas must agree
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90;
      for (const [k, rk] of ranks.entries()) { const s = { t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: +(1.2 + r.u() * 0.02).toFixed(4), gradNorm: +(1 + r.u() * 0.1 + (k === badK && i >= startStep && r.chance(0.5) ? 40 : 0)).toFixed(3) }; if (i % 25 === 24 && k === 0) s.ckptS = 30; steps.push(s); }
      if (i % 10 === 0) for (const [k, rk] of ranks.entries()) checks.push({ t: t + 5, check: 'param-checksum', job: 'train-llm', step: i, rank: k, node: rk.node, gpu: rk.gpu, group: `tp${rk.gpu}`, value: k === badK && i >= startStep ? `bad${i}` : `ok${i}-${rk.gpu}` });
    }
    f.s.append('step', steps);
    f.s.append('sdc_check', checks);
    if (r.chance(0.5)) f.s.append('log', [{ t: T0 - 2 * H + (startStep + 15) * 90, node: bad.node, gpu: bad.gpu, job: 'train-llm', rank: badK, code: 'non_finite', class: 'app', severity: 'soft', msg: 'loss is nan', source: 'app-log' }]);
    const first = T0 - 2 * H + Math.ceil(startStep / 10) * 10 * 90 + 5;
    return { incident: { symptom: 'training-divergence', job: 'train-llm', from: first - 60, to: T0 - 2 * H + 120 * 90 }, cause: 'silent-corruption', component: bad.node };
  },
  'collective-hang: one rank never joins': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(2, Math.min(4, f.nodes.length))), ranks = nodes.flatMap(x => ['0', '1', '2', '3'].map(g => ({ node: x, gpu: g })));
    const badK = r.int(0, ranks.length - 1), stuckAt = T0 + 60, steps = [];
    for (let i = 0; i < 80; i++) { const t = T0 - 2 * H + i * 90; if (t > stuckAt) break; for (const [k, rk] of ranks.entries()) steps.push({ t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: 1.1 }); }
    f.s.append('step', steps);
    const silent = r.chance(0.5);
    f.s.append('log', ranks.map((rk, k) => ({ k, rk })).filter(x => !(silent && x.k === badK)).map(({ k, rk }) => ({ t: stuckAt + 600 + r.int(0, 5), node: rk.node, job: 'train-llm', rank: k, code: 'nccl_timeout', class: 'network', severity: 'hard', op: 'ALLREDUCE', seq: k === badK ? 4120 : 4121, ms: 600000, msg: 'Watchdog caught collective operation timeout', source: 'app-log' })));
    if (r.chance(0.4)) f.s.append('log', [kernel(ranks[badK].node, stuckAt - 30, 'xid79', ranks[badK].gpu)]);
    return { incident: { symptom: 'training-hang', job: 'train-llm', from: stuckAt, to: stuckAt + 700 }, cause: 'collective-hang', component: ranks[badK].node };
  },
  'slow-link: one node\'s network degraded': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(3, Math.min(6, f.nodes.length))), bad = r.pick(nodes), deg = 0.25 + r.u() * 0.35, steps = [], coll = [];
    const ranks = nodes.flatMap(x => ['0', '1', '2', '3'].map(g => ({ node: x, gpu: g })));
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90, after = t > T0;
      for (const [k, rk] of ranks.entries()) {
        const comm = after ? 0.1 / deg : 0.1; // every rank waits for the slowest link
        steps.push({ t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: 0.9 + comm, commS: comm, computeS: 0.9 * (1 + (r.u() - 0.5) * 0.03) });
        for (const [op, bytes, bw] of [['AllReduce', 268435456, 380], ['AllGather', 67108864, 300]]) coll.push({ t, job: 'train-llm', node: rk.node, rank: k, op, bytes, busbw: bw * (after && rk.node === bad ? deg : 1) * (1 + (r.u() - 0.5) * 0.06), execS: bytes / 1e9 / bw, source: 'nccl-inspector' });
      }
    }
    f.s.append('step', steps); f.s.append('collective', coll);
    if (r.chance(0.5)) f.s.append('log', [kernel(bad, T0 + r.int(0, 300), 'ib_link_down')]);
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'slow-link', component: bad };
  },
  'slow-link: a bad cable on a leaf port': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(3, Math.min(6, f.nodes.length))), bad = r.pick(nodes), deg = 0.3 + r.u() * 0.3, steps = [], coll = [];
    const ranks = nodes.flatMap(x => ['0', '1', '2', '3'].map(g => ({ node: x, gpu: g })));
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90, after = t > T0;
      for (const [k, rk] of ranks.entries()) {
        const comm = after ? 0.1 / deg : 0.1;
        steps.push({ t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: 0.9 + comm, commS: comm, computeS: 0.9 * (1 + (r.u() - 0.5) * 0.03) });
        coll.push({ t, job: 'train-llm', node: rk.node, rank: k, op: 'AllReduce', bytes: 268435456, busbw: 380 * (after && rk.node === bad ? deg : 1) * (1 + (r.u() - 0.5) * 0.06), execS: 0.7 });
      }
    }
    f.s.append('step', steps); f.s.append('collective', coll);
    // the leaf ports of the job's nodes: the bad node's port starts counting symbol errors and link recoveries
    const portNo = n => f.nodes.indexOf(n) % 4 + 1, ports = [];
    for (let t = T0 - 6 * H; t <= T0 + H; t += 300) for (const n of nodes) {
      const k = Math.max(0, t - T0) / 300, b = n === bad;
      ports.push({ t, switch: f.leafOf[n], port: portNo(n), symbolErrors: b ? Math.round(k * (200 + r.int(0, 100))) : 3, linkRecovery: b ? Math.floor(k / 3) : 0, xmitWait: Math.round((t - T0 + 7 * H) * 50) });
    }
    f.s.append('port', ports);
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'slow-link', component: `port:${f.leafOf[bad]}/${portNo(bad)}` };
  },
  'fabric-congestion: a leaf\'s uplinks saturated': f => {
    const { r } = f, ls = r.sample(leaves(f), 2), nodes = ls.flatMap(l => r.sample(behind(f, 'leaf', l), 2)), hot = ls[0], slow = 1.8 + r.u(), steps = [], coll = [];
    const ranks = nodes.flatMap(x => ['0', '1', '2', '3'].map(g => ({ node: x, gpu: g })));
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90, after = t > T0, comm = 0.15 * (after ? slow : 1) * (1 + (r.u() - 0.5) * 0.05);
      for (const [k, rk] of ranks.entries()) {
        steps.push({ t, job: 'train-llm', rank: k, node: rk.node, gpu: rk.gpu, step: i, durS: 0.9 + comm, commS: comm, computeS: 0.9 * (1 + (r.u() - 0.5) * 0.03) });
        coll.push({ t, job: 'train-llm', node: rk.node, rank: k, op: 'AllReduce', bytes: 268435456, busbw: 380 / (after ? slow : 1) * (1 + (r.u() - 0.5) * 0.06), execS: 0.7 });
      }
    }
    f.s.append('step', steps); f.s.append('collective', coll);
    const ports = []; let w = {};
    for (let t = T0 - 6 * H; t <= T0 + H; t += 300) for (const l of leaves(f)) { w[l] = (w[l] || 0) + (t > T0 && l === hot ? 5e6 : 4e4) * (1 + r.u() * 0.2); ports.push({ t, switch: l, port: 33, xmitWait: Math.round(w[l]), txBytes: t * 1e3 }); }
    f.s.append('port', ports);
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'fabric-congestion', component: `switch:${hot}` };
  },
  'storage-stall: a slow Lustre OST': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(2, 4)), osts = ['OST0000', 'OST0001', 'OST0002', 'OST0003', 'OST0004', 'OST0005'], bad = r.pick(osts), slow = 5 + r.u() * 6, steps = [], st = [];
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90, after = t > T0, data = after ? 0.08 * slow * (1 + r.u() * 0.2) : 0.05 * (1 + r.u() * 0.2);
      for (const [k, n] of nodes.entries()) steps.push({ t, job: 'train-llm', rank: k, node: n, gpu: '0', step: i, durS: 1.0 + data, dataS: data, computeS: 0.9 * (1 + (r.u() - 0.5) * 0.03), commS: 0.1 });
    }
    for (let t = T0 - 6 * H; t <= T0 + H; t += 300) for (const o of osts) {
      const lat = (o === bad && t > T0 ? 2 * slow : 2) * (1 + (r.u() - 0.5) * 0.2);
      st.push({ t, target: `lustre:${o}`, op: 'read', job: 'train-llm', ops: 500 + r.int(0, 100), bytes: 5e8, latMs: lat, windowS: 300 });
      if (o === bad) st.push({ t, target: `lustre:${o}`, op: 'read', job: 'eval-sweep', ops: 200, bytes: 1e8, latMs: lat, windowS: 300 });
    }
    f.s.append('step', steps); f.s.append('storage', st);
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'storage-stall', component: `storage:lustre:${bad}` };
  },
  'storage-stall: checkpoint writes to a slow NFS export': f => {
    const { r } = f, nodes = r.sample(f.nodes, r.int(2, 4)), targets = ['nfs:filer1:/ckpt', 'nfs:filer2:/datasets'], slow = 4 + r.u() * 4, steps = [], st = [];
    for (let i = 0; i < 120; i++) {
      const t = T0 - 2 * H + i * 90, after = t > T0, ck = i % 5 === 0 ? (after ? 6 * slow : 6) * (1 + r.u() * 0.1) : 0;
      for (const [k, n] of nodes.entries()) steps.push({ t, job: 'train-llm', rank: k, node: n, gpu: '0', step: i, durS: 1.0 + ck, ckptS: ck || undefined, dataS: 0.04, computeS: 0.9, commS: 0.06 });
    }
    for (let t = T0 - 6 * H; t <= T0 + H; t += 300) for (const n of nodes) for (const tg of targets) {
      const w = tg.endsWith('/ckpt');
      st.push({ t, node: n, target: tg, op: w ? 'write' : 'read', ops: 300, latMs: (w && t > T0 ? 3 * slow : 3) * (1 + (r.u() - 0.5) * 0.2), windowS: 300 });
    }
    f.s.append('step', steps); f.s.append('storage', st);
    if (r.chance(0.3)) f.s.append('log', [kernel(nodes[0], T0 + 600, 'nfs_timeout', undefined, 'nfs: server filer1 not responding, still trying')]);
    return { incident: { symptom: 'training-slow', job: 'train-llm', from: T0, to: T0 + H }, cause: 'storage-stall', component: 'storage:nfs:filer1:/ckpt' };
  },
  'replica-tail: one serving replica slow': f => {
    const { r } = f, reps = Array.from({ length: r.int(4, 8) }, (_, i) => `chat-70b-${i}`), bad = r.pick(reps), slow = 2 + r.u() * 2, rq = [];
    for (let t = T0 - 24 * H; t <= T0 + 1800; t += r.int(20, 40)) {
      const rep = r.pick(reps), m = t > T0 && rep === bad ? slow : 1, q = 0.02 * m, pf = 0.25 * m * (1 + r.u() * 0.3), dc = 4 * (1 + r.u() * 0.2);
      rq.push({ t, pool: 'chat-70b', replica: rep, node: rep, isl: 900, osl: 220, ttft: q + pf, e2e: q + pf + dc * m, stages: { queue: q, prefill: pf, decode: dc * m } });
    }
    f.s.append('request', rq);
    serving(f, 'chat-70b', { ttft: [0.6, 0.6 * (1 + slow / 2)] });
    return { incident: { symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: T0, to: T0 + 1800 }, cause: 'replica-tail', component: bad };
  },
  'slow-stage: prefill slows on every replica': f => {
    const { r } = f, reps = Array.from({ length: r.int(3, 6) }, (_, i) => `chat-70b-${i}`), m = 1.8 + r.u() * 1.5, rq = [];
    for (let t = T0 - 24 * H; t <= T0 + 1800; t += r.int(20, 40)) {
      const after = t > T0, q = 0.02 * (1 + r.u() * 0.2), pf = 0.25 * (after ? m : 1) * (1 + r.u() * 0.3), dc = 4 * (1 + r.u() * 0.2);
      rq.push({ t, pool: 'chat-70b', replica: r.pick(reps), isl: 900, osl: 220, ttft: q + pf, e2e: q + pf + dc, stages: { queue: q, prefill: pf, decode: dc } });
    }
    f.s.append('request', rq);
    serving(f, 'chat-70b', { ttft: [0.6, 0.6 * m] });
    return { incident: { symptom: 'latency', pool: 'chat-70b', metric: 'ttftP99', from: T0, to: T0 + 1800 }, cause: 'slow-stage' };
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
    const incs = groupIncidents([...detectJobFailures(store, { from: inj.from - 1800, to: end + 3600, binS }), ...detectServing(store, { from: inj.from - 1800, to: end + 3600, targets }), ...detectTraining(store, { from: inj.from - 1800, to: end + 3600 })]);
    const hit = incs.filter(i => i.to > inj.from && i.from < end + 1800 && (!inj.pool || !i.pool || i.pool === inj.pool)).sort((a, b) => (a.alarmAt ?? a.to) - (b.alarmAt ?? b.to))[0];
    const training = ['straggler', 'collective-hang'].includes(inj.expect);
    const inc = hit || { id: `${inj.id}:window`, symptom: inj.pool ? 'latency' : training ? (inj.expect === 'straggler' ? 'training-slow' : 'training-hang') : 'job-failures', pool: inj.pool, metric: inj.pool ? 'ttftP99' : undefined, from: inj.from, to: end + 900 };
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
