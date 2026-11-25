// Power-aware capacity: what racks, PDUs and sites draw against their budgets, which jobs a power cap slows and by how
// much, the caps that bring a group under budget at the least slowdown, and how many more nodes fit under a budget.
//
// Measured: GPU power per device sample (DCGM_FI_DEV_POWER_USAGE / amd gpu_power_usage), and the power limit when
// exported (DCGM_FI_DEV_POWER_MGMT_LIMIT). Node IT power = GPU power / gpuShare (CPUs, NICs, fans make up the rest).
// Modelled: a cap C on a GPU drawing D > C stretches its work by (D/C)^α, where α is between the compute-bound
// exponent (clocks follow power) and the memory-bound one (HBM bandwidth barely moves), weighted by how compute-bound
// the job is (tensor vs DRAM activity). `fit` measures α from clocks under different limits on your fleet.
import { loadConfig as ghLoad } from '../../gpu-health/src/config.mjs';
import { executorFor } from '../../gpu-health/src/vendors.mjs';
import { fill } from '../../gpu-health/src/executors.mjs';
import { createRequire } from 'node:module';
const REG = createRequire(import.meta.url)('../../inference-sizer/src/accelerators.js');

export const POWER_DEFAULTS = { binS: 300, gpuShare: 0.7, alphaCompute: 0.35, alphaMemory: 0.08, busy: 0.3, atLimit: 0.95, levels: [0.9, 0.8, 0.7, 0.6], minCapPct: 0.6, maxSlowdown: 0.05, pue: 1.3 };
// board power (W) by chip, from the shared accelerator registry, when the limit isn't exported
export const tdpOf = sku => REG.tdpOf(sku);
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };
const mean = a => { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN; };

// group membership: rack, pdu, row, site from topology edges and inventory
function groupsOf(store, to) {
  const g = new Map(), sku = new Map(), vendor = new Map();
  const add = (node, dim, name) => { if (!g.has(node)) g.set(node, {}); g.get(node)[dim] = String(name).replace(/^(rack|pdu|row|site):/, ''); };
  for (const e of store.query('topology', { to, where: e => ['rack', 'pdu', 'row', 'site'].includes(e.kind) })) add(e.from, e.kind, e.to);
  for (const r of store.query('inventory', { to })) { if (r.site) add(r.node, 'site', r.site); if (r.rack) add(r.node, 'rack', r.rack); if (r.sku) sku.set(r.node, r.sku); if (r.vendor) vendor.set(r.node, r.vendor); }
  return { g, sku, vendor };
}
// budgets: { "rack:r1": 40, "pdu:p3": 17, "site:sjc": 2000 } or { rack: { r1: 40 } } (IT kW)
export function normBudgets(b = {}) {
  const out = {};
  for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object') for (const [n, kw] of Object.entries(v)) out[`${k}:${n}`] = +kw; else out[k] = +v; }
  return out;
}

// ---------- what is drawn ----------
export function report(store, { from, to, budgets = {}, opts = {} } = {}) {
  const O = Object.assign({}, POWER_DEFAULTS, opts), B = normBudgets(budgets), { g, sku } = groupsOf(store, to);
  const dev = store.query('device', { from, to, where: d => Number.isFinite(d.powerW) });
  if (!dev.length) return { groups: [], nodes: 0, note: 'no device power samples in the window (DCGM_FI_DEV_POWER_USAGE / gpu_power_usage)' };
  // per node and bin: GPU watts (mean of each GPU's samples in the bin, summed over GPUs)
  const bins = new Map();
  for (const d of dev) { const b = Math.floor(d.t / O.binS), k = `${d.node}|${b}`; if (!bins.has(k)) bins.set(k, new Map()); const m = bins.get(k), gk = String(d.gpu); const a = m.get(gk) || [0, 0]; a[0] += d.powerW; a[1]++; m.set(gk, a); if (!sku.has(d.node) && d.sku) sku.set(d.node, d.sku); }
  const nodeBin = new Map(); // node → Map(bin → IT kW)
  for (const [k, m] of bins) { const [node, b] = k.split('|'); let w = 0; for (const [s, n] of m.values()) w += s / n; if (!nodeBin.has(node)) nodeBin.set(node, new Map()); nodeBin.get(node).set(+b, w / O.gpuShare / 1000); }
  const allBins = [...new Set([...bins.keys()].map(k => +k.split('|')[1]))].sort((a, b) => a - b);
  const members = new Map(); const addM = (key, node) => { if (!members.has(key)) members.set(key, new Set()); members.get(key).add(node); };
  for (const node of nodeBin.keys()) { addM('fleet:all', node); for (const [dim, name] of Object.entries(g.get(node) || {})) addM(`${dim}:${name}`, node); }
  for (const k of Object.keys(B)) if (!members.has(k)) members.set(k, new Set());
  // node power at p95 by SKU while busy, for headroom in nodes
  const perSku = new Map();
  for (const [node, m] of nodeBin) { const s = sku.get(node) || '?'; if (!perSku.has(s)) perSku.set(s, []); perSku.get(s).push(...m.values()); }
  const nodeKw = s => q(perSku.get(s) || [], 0.95);
  const groups = [];
  for (const [key, nodes] of members) {
    const series = allBins.map(b => { let s = 0, n = 0; for (const node of nodes) { const v = (nodeBin.get(node) || new Map()).get(b); if (v != null) { s += v; n++; } } return { b, kw: s, n }; });
    const kws = series.map(x => x.kw), budget = B[key] ?? null, skus = [...nodes].map(n => sku.get(n)).filter(Boolean), main = mostCommon(skus);
    const p99 = q(kws, 0.99), head = budget != null ? budget - p99 : null, per = main ? nodeKw(main) : NaN;
    groups.push({ group: key, nodes: nodes.size, sku: main, avgKw: mean(kws), p99Kw: p99, peakKw: Math.max(0, ...kws), budgetKw: budget, headroomKw: head,
      overBudgetShare: budget != null ? kws.filter(v => v > budget).length / Math.max(1, kws.length) : null,
      nodeKwP95: per, moreNodes: head != null && per > 0 ? Math.max(0, Math.floor(head / per)) : null, facilityKwP99: p99 * O.pue });
  }
  groups.sort((a, b) => (b.budgetKw != null) - (a.budgetKw != null) || (a.headroomKw ?? Infinity) - (b.headroomKw ?? Infinity) || b.p99Kw - a.p99Kw);
  return { groups, nodes: nodeBin.size, bins: allBins.length, binS: O.binS, gpuShare: O.gpuShare, pue: O.pue, note: `IT power = GPU power / ${O.gpuShare} (CPUs, NICs, fans); facility = IT × PUE ${O.pue}` };
}
const mostCommon = a => { const m = new Map(); for (const v of a) m.set(v, (m.get(v) || 0) + 1); let b = null, n = 0; for (const [k, c] of m) if (c > n) { b = k; n = c; } return b; };

// ---------- jobs, and what a cap would do to them ----------
// Per placement with devices: busy samples' draw, how compute-bound it is, the limit, energy, steps per kWh.
export function jobs(store, { from, to, opts = {} } = {}) {
  const O = Object.assign({}, POWER_DEFAULTS, opts), dev = new Map(), { sku, vendor } = groupsOf(store, to);
  for (const d of store.query('device', { from, to, where: d => Number.isFinite(d.powerW) })) { const k = `${d.node}|${d.gpu}`; if (!dev.has(k)) dev.set(k, []); dev.get(k).push(d); }
  const out = [], steps = new Map();
  for (const s of store.query('step', { from, to })) steps.set(s.job, (steps.get(s.job) || 0) + 1 / Math.max(1, s.rank == null ? 1 : 1));
  for (const p of store.query('placement', { to })) {
    const s0 = Math.max(from ?? -Infinity, p.start ?? p.t), e0 = Math.min(to ?? Infinity, p.end ?? to ?? Infinity); if (!(e0 > s0) || !(p.devices || []).length) continue;
    const samples = [];
    for (const d of p.devices) for (const x of dev.get(`${d.node}|${d.gpu}`) || []) if (x.t >= s0 && x.t < e0) samples.push(x);
    if (!samples.length) continue;
    const busy = samples.filter(x => (x.sm ?? x.tensor ?? 1) >= O.busy), node = p.devices[0].node;
    const limit = Math.max(...samples.map(x => x.powerLimitW || 0)) || tdpOf(samples[0].sku || sku.get(node)) || Math.max(...samples.map(x => x.powerW));
    const t = mean(busy.map(x => x.tensor ?? x.sm)), dr = mean(busy.map(x => x.dram)), bound = Number.isFinite(t) && Number.isFinite(dr) && t + dr > 0 ? t / (t + dr) : 0.7;
    const hours = (e0 - s0) / 3600, kWh = mean(samples.map(x => x.powerW)) * p.devices.length * hours / 1000;
    out.push({ job: p.job, class: p.class || null, owner: p.owner || null, gpus: p.devices.length, devices: p.devices, nodes: [...new Set(p.devices.map(d => d.node))], vendor: samples[0].vendor || vendor.get(node) || 'nvidia',
      limitW: limit, drawP50: q(busy.map(x => x.powerW), 0.5), drawP95: q(busy.map(x => x.powerW), 0.95), atLimitShare: busy.length ? busy.filter(x => x.powerW >= O.atLimit * limit).length / busy.length : 0,
      computeBound: bound, busyShare: busy.length / samples.length, gpuKWh: kWh, stepsPerKWh: steps.has(p.job) && kWh ? steps.get(p.job) / (kWh / O.gpuShare) : null, draws: busy.map(x => x.powerW) });
  }
  return out;
}
// A cap of capW on a job: predicted slowdown (time stretch while busy) and IT kW saved.
export function predict(j, capW, { alphaCompute = POWER_DEFAULTS.alphaCompute, alphaMemory = POWER_DEFAULTS.alphaMemory, gpuShare = POWER_DEFAULTS.gpuShare } = {}) {
  const a = j.computeBound * alphaCompute + (1 - j.computeBound) * alphaMemory;
  let stretch = 0, saved = 0;
  for (const d of j.draws) { stretch += d > capW ? Math.pow(d / capW, a) - 1 : 0; saved += Math.max(0, d - capW); }
  const n = Math.max(1, j.draws.length);
  // Below ~60% of the limit clocks hit their floor and work slows far more than (D/C)^α: on real power-limit sweeps
  // (Zeus, 4 GPU types) the model is within a few points from 60% to 100% and badly low below that.
  const out = { capW, capPct: capW / j.limitW, slowdown: stretch / n * j.busyShare, savedKw: saved / n * j.gpus * j.busyShare / gpuShare / 1000, alpha: a };
  if (j.limitW && capW < POWER_DEFAULTS.minCapPct * j.limitW) Object.assign(out, { outOfRange: true, note: `a cap under ${POWER_DEFAULTS.minCapPct * 100}% of the ${j.limitW} W limit: the slowdown is likely much larger than predicted` });
  return out;
}

// ---------- fit α from clocks under different limits ----------
export function fit(store, { from, to, opts = {} } = {}) {
  const O = Object.assign({}, POWER_DEFAULTS, opts), by = new Map();
  for (const d of store.query('device', { from, to, where: d => Number.isFinite(d.powerLimitW) && Number.isFinite(d.clockMHz) && (d.sm ?? d.tensor ?? 0) >= 0.5 })) {
    const k = `${d.node}|${d.gpu}`, L = Math.round(d.powerLimitW / 10) * 10; if (!by.has(k)) by.set(k, new Map()); const m = by.get(k); if (!m.has(L)) m.set(L, []); m.get(L).push(d);
  }
  let sxy = 0, sxx = 0, n = 0, devices = 0, levels = 0; const points = [];
  for (const m of by.values()) {
    if (m.size < 2) continue; devices++; levels += m.size;
    const top = Math.max(...m.keys()), ref = q(m.get(top).map(x => x.clockMHz), 0.5);
    for (const [L, xs] of m) { if (L === top) continue; const c = q(xs.map(x => x.clockMHz), 0.5), x = Math.log(L / top), y = Math.log(c / ref); sxy += x * y; sxx += x * x; n++; points.push({ limitPct: L / top, clockPct: c / ref }); }
  }
  if (!n) return { alphaCompute: null, devices: 0, note: 'no GPU ran busy under two different power limits: the defaults stand (uncalibrated)' };
  const a = sxy / sxx;
  return { alphaCompute: a, devices, points: points.length, note: `clocks fall as limit^${a.toFixed(2)} on ${devices} GPU(s) run under ${levels} limit setting(s) in all; compute-bound work slows the same way` };
}

// ---------- caps that bring groups under budget ----------
// For each group whose p99 IT power is over its budget (or the fleet, with saveKw), choose per job the cap level with
// the least slowdown per kW saved, within maxSlowdown, until the shortfall is covered. Protected classes are skipped.
export function plan(store, { from, to, budgets = {}, saveKw = null, opts = {}, protect = [], cfg = ghLoad(), id } = {}) {
  const O = Object.assign({}, POWER_DEFAULTS, opts), rep = report(store, { from, to, budgets, opts: O }), js = jobs(store, { from, to, opts: O });
  const targets = rep.groups.filter(g => g.budgetKw != null && g.headroomKw < 0).map(g => ({ group: g.group, needKw: -g.headroomKw, g }));
  if (saveKw) targets.push({ group: 'fleet:all', needKw: +saveKw, g: rep.groups.find(x => x.group === 'fleet:all') });
  const { g: gm } = groupsOf(store, to), inGroup = (j, key) => { const [dim, name] = key.split(':'); return key === 'fleet:all' || j.nodes.some(n => (gm.get(n) || {})[dim] === name); };
  const chosen = new Map(), results = [];
  for (const t of targets) {
    let need = t.needKw;
    const opts2 = [];
    for (const j of js.filter(j => inGroup(j, t.group) && !protect.includes(j.class) && !chosen.has(j.job))) for (const lv of O.levels) {
      const p = predict(j, lv * j.limitW, O); if (p.savedKw <= 0 || p.slowdown > O.maxSlowdown) continue; opts2.push({ j, p, cost: p.slowdown / p.savedKw });
    }
    // per job, the level with the best slowdown per kW; then jobs in that order; deeper levels only if still short
    opts2.sort((a, b) => a.cost - b.cost);
    for (const o of opts2) { if (need <= 0) break; const prev = chosen.get(o.j.job); if (prev && prev.p.savedKw >= o.p.savedKw) continue; need -= o.p.savedKw - (prev ? prev.p.savedKw : 0); chosen.set(o.j.job, Object.assign({ group: t.group }, o)); }
    // then back off: each chosen job to the shallowest level that still covers the shortfall
    const mine = [...chosen.values()].filter(c => c.group === t.group).sort((a, b) => b.p.slowdown - a.p.slowdown);
    let total = mine.reduce((a, c) => a + c.p.savedKw, 0);
    for (const c of mine) for (const o of opts2.filter(o => o.j === c.j && o.p.slowdown < c.p.slowdown).sort((a, b) => a.p.slowdown - b.p.slowdown)) {
      if (total - c.p.savedKw + o.p.savedKw >= t.needKw) { total += o.p.savedKw - c.p.savedKw; chosen.set(c.j.job, Object.assign({ group: t.group }, o)); break; }
    }
    results.push({ group: t.group, p99Kw: t.g && t.g.p99Kw, budgetKw: t.g && t.g.budgetKw, needKw: t.needKw, savedKw: total, met: total >= t.needKw });
  }
  const caps = [...chosen.values()].map(({ j, p, group }) => ({ job: j.job, class: j.class, owner: j.owner, group, gpus: j.gpus, devices: j.devices, vendor: j.vendor, limitW: j.limitW, capW: Math.round(p.capW), capPct: p.capPct,
    drawP95: j.drawP95, computeBound: j.computeBound, predictedSlowdown: p.slowdown, savedKw: p.savedKw }));
  // stages: one per group, through gpu-health's executors (vendor-specific power-cap command); undo restores the limit.
  // A job holding every GPU of a node gets one node-wide command.
  const devicesOf = new Map(store.query('inventory', { to }).map(r => [r.node, r.devices]));
  const byNode = c => { const m = new Map(); for (const d of c.devices) { if (!m.has(d.node)) m.set(d.node, []); m.get(d.node).push(d.gpu); } return [...m]; };
  const stages = [];
  for (const r of results) {
    const cs = caps.filter(c => c.group === r.group); if (!cs.length) continue;
    const cmd = (c, watts) => byNode(c).flatMap(([node, gpus]) => {
      const whole = gpus.length >= (devicesOf.get(node) || 8), t = executorFor(cfg, c.vendor, whole ? 'power-cap-node' : 'power-cap', node);
      if (!Array.isArray(t)) return [];
      return whole ? t.map(a => fill(a, { node, watts })) : gpus.flatMap(gpu => t.map(a => fill(a, { node, gpu, watts })));
    });
    const apply = cs.flatMap(c => cmd(c, c.capW)), rollback = cs.flatMap(c => cmd(c, Math.round(c.limitW)));
    stages.push({ candidate: `power:${r.group}`, title: `${r.group}: cap ${cs.length} job(s), −${r.savedKw.toFixed(1)} kW, worst predicted slowdown ${(Math.max(...cs.map(c => c.predictedSlowdown)) * 100).toFixed(1)}%`,
      apply: apply.length ? apply : { webhook: `Set power caps: ${cs.map(c => `${c.job} ${c.capW} W`).join(', ')}` }, rollback: rollback.length ? rollback : { webhook: `Restore power limits: ${cs.map(c => `${c.job} ${Math.round(c.limitW)} W`).join(', ')}` },
      guard: null, bakeS: 1800, caps: cs.map(c => ({ job: c.job, capW: c.capW, predictedSlowdown: c.predictedSlowdown })) });
  }
  stages.forEach((s, i) => Object.assign(s, { n: i + 1, status: 'pending' }));
  return { id: id || `power-${Date.now().toString(36)}`, kind: 'power-caps', report: rep.groups.filter(g => g.budgetKw != null), createdAt: Math.floor(Date.now() / 1000), status: 'planned', groups: results, caps, stages, assumptions: { alphaCompute: O.alphaCompute, alphaMemory: O.alphaMemory, gpuShare: O.gpuShare, maxSlowdown: O.maxSlowdown } };
}

// After the caps: each capped job's step time and each group's p99 power, before and after, against the prediction.
export function verify(store, p, { windowS = 6 * 3600, now = Math.floor(Date.now() / 1000), opts = {} } = {}) {
  const at = Math.min(...p.stages.filter(s => s.appliedAt).map(s => s.appliedAt));
  if (!Number.isFinite(at)) return { note: 'no stage was applied' };
  const w = Math.min(windowS, now - at), before = report(store, { from: at - w, to: at, opts }), after = report(store, { from: at, to: at + w, opts });
  const groups = p.groups.map(g => { const b = before.groups.find(x => x.group === g.group), a = after.groups.find(x => x.group === g.group); return { group: g.group, predictedSavedKw: g.savedKw, p99Before: b && b.p99Kw, p99After: a && a.p99Kw, measuredSavedKw: b && a ? b.p99Kw - a.p99Kw : null }; });
  const jobsOut = p.caps.map(c => {
    const st = (s0, s1) => store.query('step', { from: s0, to: s1, where: x => x.job === c.job }).map(x => x.computeS ?? x.durS);
    const b = q(st(at - w, at), 0.5), a = q(st(at, at + w), 0.5);
    return { job: c.job, capW: c.capW, predictedSlowdown: c.predictedSlowdown, measuredSlowdown: Number.isFinite(a / b) ? a / b - 1 : null };
  });
  return { appliedAt: at, windowS: w, groups, jobs: jobsOut };
}

// ---------- a fleet to try it on ----------
// Two racks of four 8×H100 nodes. Rack r1 runs a compute-bound training job and memory-bound serving and is over its
// 24 kW budget; r2 is under. Two GPUs ran a week under a 560 W limit, so `fit` has something to measure.
export function synth({ t0 = Date.UTC(2026, 10, 20) / 1000, hours = 6, seed = 5, alpha = 0.4 } = {}) {
  let s = seed >>> 0; const R = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rec = { inventory: [], topology: [], placement: [], device: [], step: [] }, nodes = [];
  for (const r of ['r1', 'r2']) for (let i = 1; i <= 4; i++) { const n = `${r}-n${i}`; nodes.push({ n, r }); rec.inventory.push({ t: t0, node: n, vendor: 'nvidia', sku: 'NVIDIA H100 80GB HBM3', devices: 8, site: 'sjc' }); rec.topology.push({ t: t0, kind: 'rack', from: n, to: `rack:${r}` }, { t: t0, kind: 'pdu', from: n, to: `pdu:${r}-a` }); }
  const job = (name, cls, ns, prof) => { const devices = ns.flatMap(n => Array.from({ length: 8 }, (_, g) => ({ node: n, gpu: g }))); rec.placement.push({ t: t0, job: name, class: cls, owner: cls === 'training' ? 'pretrain' : 'serving', start: t0, end: t0 + hours * 3600, devices }); return { name, devices, prof }; };
  const js = [
    job('pretrain-13b', 'training', ['r1-n1', 'r1-n2'], { w: 680, tensor: 0.75, dram: 0.25, sm: 0.9 }),
    job('chat-70b', 'inference', ['r1-n3', 'r1-n4'], { w: 520, tensor: 0.18, dram: 0.72, sm: 0.6 }),
    job('embed', 'inference', ['r2-n1'], { w: 300, tensor: 0.3, dram: 0.4, sm: 0.4 }),
  ];
  for (let t = t0; t < t0 + hours * 3600; t += 60) {
    for (const j of js) for (const d of j.devices) { const w = j.prof.w * (0.92 + 0.1 * R()); rec.device.push({ t, node: d.node, gpu: d.gpu, vendor: 'nvidia', sku: 'NVIDIA H100 80GB HBM3', powerW: Math.min(700, w), powerLimitW: 700, tensor: j.prof.tensor, dram: j.prof.dram, sm: j.prof.sm, clockMHz: 1980 }); }
    for (const n of ['r2-n2', 'r2-n3', 'r2-n4']) for (let g = 0; g < 8; g++) rec.device.push({ t, node: n, gpu: g, vendor: 'nvidia', sku: 'NVIDIA H100 80GB HBM3', powerW: 70 + 5 * R(), powerLimitW: 700, sm: 0, tensor: 0, dram: 0, clockMHz: 345 });
  }
  for (let st = 0; st < hours * 60; st += 5) rec.step.push({ t: t0 + st * 60, job: 'pretrain-13b', rank: 0, node: 'r1-n1', step: st, durS: 2.0 + 0.02 * R(), computeS: 1.7 + 0.02 * R() });
  // a week earlier, two GPUs on r2-n1 ran busy at 700 W and at 560 W: clocks follow limit^alpha
  for (let t = t0 - 7 * 86400; t < t0 - 7 * 86400 + 4 * 3600; t += 60) for (const g of [6, 7]) {
    const L = t < t0 - 7 * 86400 + 2 * 3600 ? 700 : 560;
    rec.device.push({ t, node: 'r2-n1', gpu: g, vendor: 'nvidia', sku: 'NVIDIA H100 80GB HBM3', powerW: L * 0.97, powerLimitW: L, sm: 0.95, tensor: 0.8, dram: 0.2, clockMHz: 1980 * Math.pow(L / 700, alpha) * (0.99 + 0.02 * R()) });
  }
  return { records: rec, from: t0, to: t0 + hours * 3600, budgets: { 'rack:r1': 24, 'rack:r2': 40, 'site:sjc': 120 } };
}
