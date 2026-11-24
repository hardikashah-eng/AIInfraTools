// Storage I/O per target → `storage` records { target, op, node?, job?, ops, bytes?, latMs?, windowS }. A target is
// the thing behind a data or checkpoint stall: a Lustre OST or MDT, an NFS server:export, an object-store bucket.
//
// Sources: Lustre job_stats (`lctl get_param obdfilter.*.job_stats mdt.*.job_stats`), NFS client mountstats
// (/proc/self/mountstats), and JSON lines from anything else (an S3 client's metrics, a data loader's own timing).
// Lustre and NFS keep totals: give the previous snapshot with --before and the records are what happened between.

// ---------- Lustre job_stats ----------
function parseJobStats(text, target0 = null) {
  const out = []; let target = target0, cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const tg = line.match(/^(?:obdfilter|mdt)\.([\w-]+?)\.job_stats=/); if (tg) { target = tg[1].replace(/^.*-(OST|MDT)/, '$1'); continue; }
    const j = line.match(/^-\s*job_id:\s*(\S+)/); if (j) { cur = { target, job: j[1], ops: {} }; out.push(cur); continue; }
    if (!cur) continue;
    const st = line.match(/^\s*snapshot_time:\s*([\d.]+)/); if (st) { cur.t = Math.floor(+st[1]); continue; }
    const m = line.match(/^\s*(\w+):\s*\{\s*samples:\s*(\d+),\s*unit:\s*(\w+)(?:,\s*min:\s*(\d+),\s*max:\s*(\d+),\s*sum:\s*(\d+))?/);
    if (m) cur.ops[m[1]] = { samples: +m[2], unit: m[3], sum: m[6] != null ? +m[6] : 0, max: m[5] != null ? +m[5] : 0 };
  }
  return out;
}
const OPKIND = { read_bytes: 'read', write_bytes: 'write', read: 'read', write: 'write', open: 'meta', close: 'meta', getattr: 'meta', setattr: 'meta', mknod: 'meta', unlink: 'meta', statfs: 'meta', sync: 'meta', punch: 'meta' };
// the OST or MDT from a path such as /proc/fs/lustre/obdfilter/lustrefs-OST0000/job_stats
export const lustreTargetOf = p => { const m = String(p || '').match(/(?:^|[-/])((?:OST|MDT)[0-9a-f]{4})(?:[/_.]|$)/i); return m ? m[1].toUpperCase() : null; };
// A file read straight from /proc/fs/lustre has no "obdfilter.<target>.job_stats=" line: give `target` (the import
// takes it from the path).
export function lustreJobstats(text, { before, fs: fsName = 'lustre', target = null, t = Math.floor(Date.now() / 1000) } = {}) {
  const now = parseJobStats(text, target), prev = new Map((before ? parseJobStats(before, target) : []).map(e => [`${e.target}|${e.job}`, e]));
  if (now.some(e => !e.target)) throw new Error('Lustre job_stats without a target: use lctl get_param obdfilter.*.job_stats, or name the file after the OST/MDT (or --target)');
  const out = [];
  for (const e of now) {
    const p = prev.get(`${e.target}|${e.job}`), win = p && e.t && p.t ? e.t - p.t : null, by = {};
    for (const [op, v] of Object.entries(e.ops)) {
      const k = OPKIND[op] || 'meta', pv = (p && p.ops[op]) || { samples: 0, sum: 0 }, ds = v.samples - pv.samples, dsum = v.sum - pv.sum;
      if (ds < 0 || ds === 0) continue;
      const b = by[k] || (by[k] = { ops: 0, bytes: 0, latUs: 0, latOps: 0 });
      if (v.unit === 'bytes') { b.bytes += dsum; b.ops += ds; } else if (v.unit === 'usecs' || v.unit === 'usec') { b.latUs += dsum; b.latOps += ds; if (!/_bytes$/.test(op)) b.ops += k === 'meta' ? ds : 0; } else b.ops += ds;
    }
    for (const [op, b] of Object.entries(by)) out.push({ t: e.t || t, target: `${fsName}:${e.target}`, op, job: e.job.replace(/\.\d+$/, ''), ops: b.ops, bytes: b.bytes || undefined, latMs: b.latOps ? b.latUs / b.latOps / 1000 : undefined, windowS: win || undefined, source: 'lustre-jobstats' });
  }
  return out;
}

// ---------- NFS mountstats ----------
// "device filer3:/datasets mounted on /mnt/data with fstype nfs4 …" then per-op lines:
//   READ: ops trans timeouts bytes_sent bytes_recv queue_ms rtt_ms execute_ms [errors]
function parseMountstats(text) {
  const out = []; let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const d = line.match(/^device\s+(\S+)\s+mounted on\s+(\S+)\s+with fstype\s+(nfs\d?)/); if (d) { cur = { target: d[1], mount: d[2], ops: {} }; out.push(cur); continue; }
    if (/^device\s/.test(line)) { cur = null; continue; }
    const m = cur && line.match(/^\s+([A-Z_]+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?/);
    if (m) cur.ops[m[1]] = { ops: +m[2], timeouts: +m[4], sent: +m[5], recv: +m[6], queue: +m[7], rtt: +m[8], exe: +m[9], errors: m[10] != null ? +m[10] : 0 };
  }
  return out;
}
const NFSOP = { READ: 'read', WRITE: 'write', COMMIT: 'write', GETATTR: 'meta', LOOKUP: 'meta', ACCESS: 'meta', OPEN: 'meta', CLOSE: 'meta', READDIR: 'meta', READDIRPLUS: 'meta' };
export function nfsMountstats(text, { node, before, windowS, t = Math.floor(Date.now() / 1000) } = {}) {
  if (!node) throw new Error('mountstats needs --node (it is one client\'s view)');
  const now = parseMountstats(text), prev = new Map((before ? parseMountstats(before) : []).map(e => [e.target, e])), out = [];
  for (const e of now) {
    const p = prev.get(e.target), by = {};
    for (const [op, v] of Object.entries(e.ops)) {
      const k = NFSOP[op]; if (!k) continue;
      const pv = (p && p.ops[op]) || { ops: 0, timeouts: 0, sent: 0, recv: 0, rtt: 0, exe: 0, errors: 0 }, d = v.ops - pv.ops; if (d <= 0) continue;
      const b = by[k] || (by[k] = { ops: 0, bytes: 0, rtt: 0, exe: 0, timeouts: 0, errors: 0 });
      b.ops += d; b.bytes += (k === 'read' ? v.recv - pv.recv : k === 'write' ? v.sent - pv.sent : 0); b.rtt += v.rtt - pv.rtt; b.exe += v.exe - pv.exe; b.timeouts += v.timeouts - pv.timeouts; b.errors += v.errors - pv.errors;
    }
    for (const [op, b] of Object.entries(by)) out.push({ t, node, target: `nfs:${e.target}`, mount: e.mount, op, ops: b.ops, bytes: b.bytes || undefined, latMs: b.rtt / b.ops, exeMs: b.exe / b.ops, timeouts: b.timeouts || undefined, errors: b.errors || undefined, windowS, source: 'mountstats' });
  }
  return out;
}

// ---------- JSON lines ----------
export function storageLines(text) {
  return String(text).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(r => {
    if (!r.target || !Number.isFinite(r.t)) throw new Error('storage lines need t and target');
    return Object.assign({ op: 'read', source: 'storage-lines' }, r);
  });
}
