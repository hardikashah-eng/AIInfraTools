// What hardware is where and what it runs: versions for inventory records, and `topology` edges
//   { t, kind: nvlink|pcie|ib|rack|row|pdu|site, from, to, ...attrs }
// Node names are plain (gpu-a01); devices are node/gpuN or node/mlx5_0; shared components are prefixed
// (switch:leaf-01, rack:R12, pdu:P3, row:B, site:dc1).
import { normPci } from './logs.mjs';

const kv = line => { const m = line.match(/^\s*([^:]+?)\s+:\s*(.*)$/); return m ? [m[1].trim(), m[2].trim()] : null; };
const mostCommon = a => { const c = new Map(); for (const x of a.filter(Boolean)) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((x, y) => y[1] - x[1]).map(x => x[0])[0]; };

// `nvidia-smi -q` → { inventory, pciMap }. The inventory record carries versions (driver, cuda, vbios, inforom) and
// per-GPU identity (index, PCI address, UUID, serial, VBIOS); pciMap maps PCI address → GPU index for kernelLog().
export function nvidiaSmiQ(text, { node, t = Math.floor(Date.now() / 1000) } = {}) {
  if (!node) throw new Error('nvidia-smi -q output has no hostname: pass node');
  const top = {}, gpus = [];
  let cur = null, section = '';
  for (const line of String(text).split(/\r?\n/)) {
    const g = line.match(/^GPU ([0-9A-Fa-f]{4,8}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\.\d)\s*$/);
    if (g) { cur = { pci: normPci(g[1]) }; gpus.push(cur); section = ''; continue; }
    const indent = line.match(/^(\s*)/)[1].length, p = kv(line);
    if (!p && line.trim() && indent > 0) { section = line.trim(); continue; }
    if (!p) continue;
    const [k, v] = p;
    if (!cur) { top[k] = v; continue; }
    if (indent <= 4) section = '';
    if (k === 'Product Name') cur.sku = v;
    else if (k === 'Serial Number') cur.serial = v;
    else if (k === 'GPU UUID') cur.uuid = v;
    else if (k === 'Minor Number') cur.gpu = /^\d+$/.test(v) ? v : undefined;
    else if (k === 'VBIOS Version') cur.vbios = v;
    else if (k === 'Image Version' && section.startsWith('Inforom')) cur.inforom = v;
    else if (k === 'GPU Part Number') cur.part = v;
  }
  gpus.forEach((x, i) => { if (x.gpu == null) x.gpu = String(i); });
  const versions = { driver: top['Driver Version'], cuda: top['CUDA Version'], vbios: mostCommon(gpus.map(x => x.vbios)), inforom: mostCommon(gpus.map(x => x.inforom)) };
  for (const k of Object.keys(versions)) if (!versions[k]) delete versions[k];
  const mixed = ['vbios', 'inforom'].filter(k => new Set(gpus.map(x => x[k]).filter(Boolean)).size > 1);
  const inventory = { t, node, vendor: 'nvidia', kind: 'gpu', sku: mostCommon(gpus.map(x => x.sku)) || '', devices: gpus.length, versions, gpus, ...(mixed.length ? { mixedVersions: mixed } : {}), source: 'nvidia-smi' };
  return { inventory, pciMap: Object.fromEntries(gpus.map(x => [x.pci, x.gpu])) };
}

// `nvidia-smi topo -m` → topology edges inside one node: GPU↔GPU NVLink, GPU↔NIC PCIe path.
//   PIX/PXB: same PCIe switch (good GPUDirect RDMA affinity); PHB: same host bridge; NODE/SYS: across NUMA/sockets.
export function nvidiaTopo(text, { node, t = Math.floor(Date.now() / 1000) } = {}) {
  if (!node) throw new Error('nvidia-smi topo -m output has no hostname: pass node');
  const lines = String(text).split(/\r?\n/);
  const hi = lines.findIndex(l => /\bGPU0\b/.test(l) && !l.split('\t').some(c => c.trim() === 'X')); // the header has no self (X) cell
  if (hi < 0) throw new Error('no topology matrix header (GPU0 …) found');
  const cols = lines[hi].trim().split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const devCols = cols.filter(c => /^(GPU|NIC|mlx)\w*\d+$/.test(c));
  const nicName = {};
  for (const l of lines) { const m = l.match(/^\s*(NIC\d+):\s*(\S+)/); if (m) nicName[m[1]] = m[2]; }
  const name = c => (c.startsWith('GPU') ? `${node}/gpu${c.slice(3)}` : `${node}/${nicName[c] || c.toLowerCase()}`);
  const out = [], seen = new Set();
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim() || /^Legend|^NIC Legend/.test(l.trim())) break;
    const cells = l.split('\t').map(s => s.trim());
    const row = cells[0];
    if (!/^(GPU|NIC|mlx)\w*\d+$/.test(row)) continue;
    devCols.forEach((col, i) => {
      const v = cells[i + 1];
      if (!v || v === 'X' || col === row) return;
      const key = [row, col].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const nv = v.match(/^NV(\d+)$/);
      if (nv && row.startsWith('GPU') && col.startsWith('GPU')) out.push({ t, kind: 'nvlink', from: name(row), to: name(col), links: +nv[1], node, source: 'nvidia-smi-topo' });
      else if (row.startsWith('GPU') !== col.startsWith('GPU')) {
        const [gpu, nic] = row.startsWith('GPU') ? [row, col] : [col, row];
        out.push({ t, kind: 'pcie', from: name(gpu), to: name(nic), path: v, near: v === 'PIX' || v === 'PXB', node, source: 'nvidia-smi-topo' });
      }
    });
  }
  return out;
}

// `ibnetdiscover` → host↔leaf and leaf↔spine edges. Host names are the first word of the node description
// ("gpu-a01 mlx5_0"); switch names are their description ("leaf-01").
export function ibnetdiscover(text, { t = Math.floor(Date.now() / 1000) } = {}) {
  const out = [], seen = new Set(), guidName = {};
  const desc = s => (s.match(/"([^"]+)"/) || [])[1];
  // first pass: names of every GUID from the Switch/Ca header lines
  for (const l of String(text).split(/\r?\n/)) {
    const m = l.match(/^(Switch|Ca)\s+\d+\s+"([SH]-[0-9a-fA-F]+)".*#\s*"([^"]+)"/);
    if (m) guidName[m[2]] = m[1] === 'Switch' ? `switch:${m[3].trim()}` : m[3].trim().split(/\s+/)[0];
  }
  let sw = null;
  for (const l of String(text).split(/\r?\n/)) {
    const h = l.match(/^(Switch|Ca)\s+\d+\s+"([SH]-[0-9a-fA-F]+)"/);
    if (h) { sw = h[1] === 'Switch' ? guidName[h[2]] : null; continue; }
    if (!sw) continue;
    const p = l.match(/^\[(\d+)\]\s+"([SH]-[0-9a-fA-F]+)"\[(\d+)\].*?#\s*(.*)$/);
    if (!p) continue;
    const peerDesc = desc(p[4]) || '';
    const peer = guidName[p[2]] || (p[2].startsWith('S-') ? `switch:${peerDesc}` : peerDesc.split(/\s+/)[0]);
    if (!peer || peer === 'switch:') continue;
    const key = [sw, peer].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const speed = (p[4].match(/\b(\d+x[A-Z]+)\b/) || [])[1];
    if (p[2].startsWith('H-')) out.push({ t, kind: 'ib', from: peer, to: sw, port: +p[1], hca: peerDesc.split(/\s+/)[1], speed, source: 'ibnetdiscover' });
    else out.push({ t, kind: 'ib', from: sw, to: peer, port: +p[1], speed, uplink: true, source: 'ibnetdiscover' });
  }
  return out;
}

// A racks file (CSV with a header: node, and any of rack, row, pdu, site, zone) → placement edges.
export function racks(text, { t = Math.floor(Date.now() / 1000) } = {}) {
  const rows = String(text).trim().split(/\r?\n/).map(l => l.split(',').map(s => s.trim()));
  const head = rows.shift().map(h => h.toLowerCase());
  const ni = head.indexOf('node');
  if (ni < 0) throw new Error('racks file needs a "node" column');
  const out = [];
  for (const r of rows) for (const k of ['rack', 'row', 'pdu', 'site', 'zone']) {
    const i = head.indexOf(k);
    if (i >= 0 && r[i]) out.push({ t, kind: k === 'zone' ? 'site' : k, from: r[ni], to: `${k === 'zone' ? 'site' : k}:${r[i]}`, source: 'racks' });
  }
  return out;
}

// What each node shares, from the latest edges: { node: { leaf: [...], rack, row, pdu, site } } and the reverse
// { 'switch:leaf-01': Set(nodes) }. Leaf = the switch a host's HCA plugs into; spine = what that leaf uplinks to.
export function groups(edges) {
  const latest = new Map();
  for (const e of edges) { const k = `${e.kind}|${e.from}|${e.to}`; if (!latest.has(k) || latest.get(k).t < e.t) latest.set(k, e); }
  const byNode = {}, members = {};
  const add = (node, dim, g) => {
    byNode[node] = byNode[node] || {};
    if (dim === 'leaf') (byNode[node].leaf = byNode[node].leaf || []).includes(g) || byNode[node].leaf.push(g); else byNode[node][dim] = g;
    (members[g] = members[g] || { dim, nodes: new Set() }).nodes.add(node);
  };
  const uplinks = {};
  for (const e of latest.values()) {
    if (e.kind === 'ib' && !e.uplink) add(e.from, 'leaf', e.to);
    else if (e.kind === 'ib' && e.uplink) (uplinks[e.from] = uplinks[e.from] || new Set()).add(e.to);
    else if (['rack', 'row', 'pdu', 'site'].includes(e.kind)) add(e.from, e.kind, e.to);
  }
  // a spine group holds every node under the leaves that uplink to it
  for (const [leaf, spines] of Object.entries(uplinks)) for (const sp of spines) for (const n of (members[leaf] || { nodes: [] }).nodes) (members[sp] = members[sp] || { dim: 'spine', nodes: new Set() }).nodes.add(n);
  return { byNode, members };
}

// Version fields that changed between two inventory records of the same node → change records.
const VERSION_KIND = { driver: 'driver', cuda: 'driver', vbios: 'firmware', inforom: 'firmware', firmware: 'firmware', kernel: 'config', os: 'config', runtime: 'config', kubelet: 'config', image: 'deploy', nccl: 'deploy' };
export function versionChanges(prev, next) {
  if (!prev || !next || !prev.versions || !next.versions || next.t <= prev.t) return [];
  const out = [];
  for (const [k, v] of Object.entries(next.versions)) {
    const was = prev.versions[k];
    if (was == null || v == null || String(was) === String(v)) continue;
    // it changed somewhere between the two snapshots: `since` … `t`
    out.push({ t: next.t, since: prev.t, kind: VERSION_KIND[k] || 'other', target: next.node, summary: `${k} ${was} → ${v}`, field: k, from: String(was), to: String(v), id: `${next.node}:${k}:${v}`, derived: 'inventory', source: next.source });
  }
  return out;
}
