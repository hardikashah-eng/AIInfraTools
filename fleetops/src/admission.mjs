// Node admission: a node joins the training pool, or comes back from repair, only after it passes a gate.
//
// Checks (each pass, fail or missing):
//   burn-in      hours under real load (device samples above burnInLoad) with no hard fault, no new uncorrectable ECC,
//                no pending row remap and temperatures within limits; or a burn-in check from tools/admit-node.sh
//   dcgm-diag    `dcgmi diag -r 3` passed (check record from admit-node.sh)
//   sdc-canary   tools/sdc-canary.py on every GPU, all agreeing with their peers / the golden values
//   nccl         all-reduce bus bandwidth within ncclFrac of the same SKU's admitted nodes (or a reference)
//   topology     as many GPUs, NVLink links and the same PCIe link as the same SKU's other nodes
//   versions     driver, CUDA, firmware, VBIOS, NCCL, kernel equal to the fleet's baseline for the SKU
// Any fail rejects; otherwise anything missing leaves the node waiting (incomplete) with what to run.
const H = 3600, DAY = 86400;
export const ADMISSION_POLICY = {
  lookbackS: 3 * DAY, burnInS: 6 * H, burnInLoad: 0.5, maxTempC: 87, maxMemTempC: 95,
  require: ['burn-in', 'dcgm-diag', 'sdc-canary', 'nccl', 'topology', 'versions'],
  ncclFrac: 0.9, ncclRef: {},               // { sku: GB/s } when the fleet has no admitted peers yet
  versionFields: ['driver', 'cuda', 'firmware', 'vbios', 'nccl', 'kernel'], golden: {},   // { sku: { driver: '…' } }
};
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mode = a => { const m = new Map(); for (const v of a) if (v != null) m.set(String(v), (m.get(String(v)) || 0) + 1); let b = null, n = 0; for (const [k, c] of m) if (c > n) { b = k; n = c; } return b; };

function latestInventory(store, to) {
  const inv = new Map();
  for (const r of store.query('inventory', { to })) {
    const p = inv.get(r.node);
    inv.set(r.node, Object.assign({ firstSeen: p ? p.firstSeen : r.t }, p || {}, r, { versions: Object.assign({}, p && p.versions, r.versions) }));
  }
  return inv;
}
function lastAdmissions(store, to) { const m = new Map(); for (const a of store.query('admission', { to })) m.set(a.node, a); return m; }

// Nodes that need the gate: new to the inventory, back from quarantine or repair, or changed by hand since admitted.
export function pending(store, { now = Math.floor(Date.now() / 1000), policy = {} } = {}) {
  const P = Object.assign({}, ADMISSION_POLICY, policy), inv = latestInventory(store, now), adm = lastAdmissions(store, now), out = [];
  const since = n => (adm.get(n) && adm.get(n).verdict === 'admit' ? adm.get(n).t : -Infinity);
  for (const [node, r] of inv) {
    const reasons = [];
    if (!adm.has(node) && r.firstSeen > now - 30 * DAY) reasons.push(`new: first seen ${new Date(r.firstSeen * 1000).toISOString().slice(0, 10)}`);
    for (const h of store.query('health', { from: since(node), to: now, where: h => h.node === node && /quarantin|repair|rma/i.test(String(h.to) + ' ' + String(h.from)) })) reasons.push(`health: ${h.from} → ${h.to}${h.gpu != null ? ` (gpu ${h.gpu})` : ''}`);
    for (const c of store.query('change', { from: since(node), to: now, where: c => c.target === node && ['hardware', 'firmware', 'driver'].includes(c.kind) })) reasons.push(`${c.kind} change: ${c.summary || ''}`.trim());
    if (reasons.length) out.push({ node, sku: r.sku, reasons: [...new Set(reasons)], last: adm.get(node) || null });
  }
  return out.sort((a, b) => a.node.localeCompare(b.node));
}

export function evaluate(store, node, { now = Math.floor(Date.now() / 1000), policy = {} } = {}) {
  const P = Object.assign({}, ADMISSION_POLICY, policy), from = now - P.lookbackS, inv = latestInventory(store, now), me = inv.get(node);
  if (!me) throw new Error(`${node} is not in the inventory (import kubectl nodes, nvidia-smi or the admit-node.sh results first)`);
  const sku = me.sku, peers = [...inv.values()].filter(r => r.node !== node && r.sku === sku), adm = lastAdmissions(store, now);
  const admittedPeers = peers.filter(r => (adm.get(r.node) || {}).verdict === 'admit');
  const checks = [], add = (name, status, evidence, fix) => checks.push({ name, status, evidence, ...(fix ? { fix } : {}) });
  const chk = name => store.query('check', { from, to: now, where: c => c.node === node && c.check === name });
  const logs = store.query('log', { from, to: now, where: l => l.node === node && l.severity === 'hard' });

  // burn-in: from device samples under load, else the script's burn-in record
  const dev = store.query('device', { from, to: now, where: d => d.node === node });
  const loaded = dev.filter(d => (d.tensor ?? d.sm ?? 0) >= P.burnInLoad);
  if (loaded.length) {
    const ts = [...new Set(loaded.map(d => d.t))].sort((a, b) => a - b), step = ts.length > 1 ? median(ts.slice(1).map((t, i) => t - ts[i])) : 60, hours = ts.length * step;
    const hot = Math.max(...loaded.map(d => d.tempC ?? -Infinity)), memHot = Math.max(...loaded.map(d => d.memTempC ?? -Infinity));
    const dbe = Math.max(...dev.map(d => d.eccDbeTotal ?? 0)) - Math.min(...dev.map(d => d.eccDbeTotal ?? 0)), remap = dev.some(d => d.remapPending);
    const faults = [...new Set(dev.flatMap(d => d.faults || []).concat(logs.map(l => l.code)))];
    const problems = [hot > P.maxTempC && `GPU at ${hot}°C (limit ${P.maxTempC})`, memHot > P.maxMemTempC && `HBM at ${memHot}°C (limit ${P.maxMemTempC})`, dbe > 0 && `${dbe} new uncorrectable ECC error(s)`, remap && 'row remap pending', faults.length && `faults: ${faults.join(', ')}`].filter(Boolean);
    if (problems.length) add('burn-in', 'fail', problems.join('; '));
    else if (hours < P.burnInS) add('burn-in', 'missing', `${(hours / H).toFixed(1)} h under load of ${P.burnInS / H} h`, `keep the burn-in running (tools/admit-node.sh --burn-in ${P.burnInS / H}h)`);
    else add('burn-in', 'pass', `${(hours / H).toFixed(1)} h at ≥ ${P.burnInLoad * 100}% load, max ${hot}°C${Number.isFinite(memHot) ? ` (HBM ${memHot}°C)` : ''}, no faults`);
  } else {
    const b = chk('burn-in').pop();
    if (!b) add('burn-in', 'missing', 'no load on the node in the window', `tools/admit-node.sh --burn-in ${P.burnInS / H}h`);
    else if (b.ok === false || logs.length) add('burn-in', 'fail', b.detail || `faults: ${logs.map(l => l.code).join(', ')}`);
    else if ((b.value || 0) < P.burnInS) add('burn-in', 'missing', `${((b.value || 0) / H).toFixed(1)} h of ${P.burnInS / H} h`, `tools/admit-node.sh --burn-in ${P.burnInS / H}h`);
    else add('burn-in', 'pass', `${(b.value / H).toFixed(1)} h${b.maxTempC ? `, max ${b.maxTempC}°C` : ''} (admit-node.sh)`);
  }
  // dcgm diag
  const d = chk('dcgm-diag').pop();
  if (!d) add('dcgm-diag', 'missing', 'no DCGM diagnostic in the window', 'tools/admit-node.sh (runs dcgmi diag -r 3)');
  else add('dcgm-diag', d.ok ? 'pass' : 'fail', d.detail || (d.ok ? 'level 3 passed' : 'failed'));
  // SDC canary on every GPU
  const can = store.query('sdc_check', { from, to: now, where: c => c.node === node && c.check === 'canary' });
  const gpusExpected = me.devices || median(peers.map(p => p.devices)) || null, gpusCovered = new Set(can.map(c => String(c.gpu))).size;
  if (!can.length) add('sdc-canary', 'missing', 'no canary results', 'tools/sdc-canary.py (admit-node.sh runs it when PyTorch is there)');
  else if (can.some(c => c.ok === false)) add('sdc-canary', 'fail', `GPU ${[...new Set(can.filter(c => c.ok === false).map(c => c.gpu))].join(', ')} disagreed with the others: silent data corruption`);
  else if (gpusExpected && gpusCovered < gpusExpected) add('sdc-canary', 'missing', `${gpusCovered} of ${gpusExpected} GPUs checked`, 'run the canary on every GPU');
  else add('sdc-canary', 'pass', `${gpusCovered} GPU(s), ${can.length} result(s), all agree`);
  // NCCL all-reduce bus bandwidth against the same SKU
  const nc = chk('nccl-allreduce').map(c => c.value).filter(Number.isFinite);
  const peerBw = store.query('check', { to: now, where: c => c.check === 'nccl-allreduce' && c.ok !== false && admittedPeers.some(p => p.node === c.node) }).map(c => c.value);
  const ref = peerBw.length >= 3 ? median(peerBw) : (P.ncclRef[sku] ?? null), refWhy = peerBw.length >= 3 ? `median of ${peerBw.length} admitted ${sku} result(s)` : 'the policy reference';
  if (!nc.length) add('nccl', 'missing', 'no all-reduce result', 'tools/admit-node.sh (runs nccl-tests all_reduce_perf when installed)');
  else if (ref == null) add('nccl', 'missing', `${median(nc).toFixed(0)} GB/s but nothing to compare with`, `set ncclRef.${sku} in the policy or admit peers first`);
  else { const bw = median(nc), ok = bw >= P.ncclFrac * ref; add('nccl', ok ? 'pass' : 'fail', `${bw.toFixed(0)} GB/s bus bandwidth, ${Math.round(100 * bw / ref)}% of ${ref.toFixed(0)} (${refWhy}; needs ${Math.round(P.ncclFrac * 100)}%)`); }
  // topology: GPUs, NVLink links, PCIe link against the same SKU
  const topo = [];
  const seenGpus = new Set(dev.map(x => String(x.gpu))).size || (chk('gpu-count').pop() || {}).value || me.devices;
  const peerGpus = median(peers.map(p => p.devices));
  if (seenGpus != null && Number.isFinite(peerGpus) && seenGpus < peerGpus) topo.push(`${seenGpus} GPUs, the same SKU has ${peerGpus}`);
  const links = n => store.query('topology', { to: now, where: e => e.kind === 'nvlink' && String(e.from).startsWith(`${n}/`) }).length;
  const myLinks = links(node), peerLinks = median(peers.map(p => links(p.node)).filter(x => x > 0));
  if (Number.isFinite(peerLinks) && myLinks < peerLinks) topo.push(`${myLinks} NVLink links, the same SKU has ${peerLinks}`);
  const pcie = chk('pcie').pop(), peerPcie = mode(store.query('check', { to: now, where: c => c.check === 'pcie' && peers.some(p => p.node === c.node) }).map(c => c.value));
  if (pcie && peerPcie && String(pcie.value) !== peerPcie) topo.push(`PCIe ${pcie.value}, the same SKU runs ${peerPcie}`);
  const anyTopo = seenGpus != null || myLinks > 0 || pcie;
  if (topo.length) add('topology', 'fail', topo.join('; '));
  else if (!anyTopo) add('topology', 'missing', 'no GPU count, NVLink or PCIe data', 'tools/admit-node.sh (nvidia-smi topo, nvlink, PCIe link)');
  else add('topology', 'pass', [seenGpus != null && `${seenGpus} GPUs`, myLinks && `${myLinks} NVLink links`, pcie && `PCIe ${pcie.value}`].filter(Boolean).join(', '));
  // versions against the baseline: the policy's golden set, else what most of the same SKU's admitted (or all) nodes run
  const base = Object.assign({}, ...P.versionFields.map(f => { const g = (P.golden[sku] || {})[f]; const m = g ?? mode((admittedPeers.length ? admittedPeers : peers).map(p => p.versions[f])); return m != null ? { [f]: m } : {}; }));
  const mine = me.versions || {}, diff = Object.entries(base).filter(([f, v]) => mine[f] != null && String(mine[f]) !== String(v)), unknown = Object.keys(base).filter(f => mine[f] == null);
  if (!Object.keys(base).length) add('versions', 'missing', 'no baseline: no golden versions and no peers of the same SKU', `set golden.${sku} in the policy`);
  else if (diff.length) add('versions', 'fail', diff.map(([f, v]) => `${f} ${mine[f]}, baseline ${v}`).join('; '), 'align the versions (or roll the new one out with fleetops rollout, canary first)');
  else if (unknown.length === Object.keys(base).length) add('versions', 'missing', 'the node reports no versions', 'tools/admit-node.sh (records driver, CUDA, VBIOS, NCCL, kernel)');
  else add('versions', 'pass', Object.entries(base).filter(([f]) => mine[f] != null).map(([f, v]) => `${f} ${v}`).join(', '));

  const req = checks.filter(c => P.require.includes(c.name));
  const verdict = req.some(c => c.status === 'fail') ? 'reject' : req.some(c => c.status === 'missing') ? 'incomplete' : 'admit';
  return { node, sku, verdict, checks, failed: req.filter(c => c.status === 'fail').map(c => c.name), missing: req.filter(c => c.status === 'missing').map(c => c.name), at: now };
}

// The gate's action for gpu-health's queue: admitting releases the node (approval), rejecting keeps it out (automatic).
export function gateAction(v, now = Math.floor(Date.now() / 1000)) {
  if (v.verdict === 'incomplete') return null;
  const admit = v.verdict === 'admit';
  return { id: `${admit ? 'admit-node' : 'reject-node'}:${v.node}:${v.at}`, kind: admit ? 'admit-node' : 'reject-node', node: v.node, target: v.node, severity: admit ? 'medium' : 'high', createdAt: now, updatedAt: now, lastSeen: now, analyzedAt: now,
    reason: admit ? `${v.node} passed admission: ${v.checks.filter(c => c.status === 'pass').map(c => c.name).join(', ')}` : `${v.node} failed admission: ${v.checks.filter(c => c.status === 'fail').map(c => `${c.name} (${c.evidence})`).join('; ')}`,
    params: {}, evidence: v.checks.map(c => `${c.name}: ${c.status}: ${c.evidence}`) };
}
