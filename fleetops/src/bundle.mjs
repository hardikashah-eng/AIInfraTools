// Trace bundles: everything a cluster has, in one file, imported in one command.
//
//   tools/collect.sh [--since 24h] [--vllm URL] [--dcgm URL] [--step-log FILE] … → fleetops-bundle-HOST-DATE.tar.gz
//   fleetops data import bundle FILE.tar.gz|DIR     (or POST /v1/bundle with an ingest token, or fleetops send)
//
// A bundle is a tar (gzip optional) holding files and a manifest.json:
//   { "version": 1, "collectedAt": "…", "host": "…", "files": [ { "path": "k8s/nodes.json", "source": "k8s-nodes",
//     "opts": { "node": "gpu-a17" } }, … ] }
// Files the manifest doesn't name, or bundles without a manifest, are recognized by content (sniff), so a directory
// or archive of whatever was at hand also works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const MAX_FILE = 512 * 2 ** 20, MAX_TOTAL = 4 * 2 ** 30, MAX_FILES = 20000;

// ustar (and GNU long names), regular files only. Returns [{ name, data }].
export function readTar(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TOTAL });
  const out = [];
  let off = 0, longName = null, total = 0;
  const str = (o, n) => buf.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    if (h.subarray(257, 262).toString('latin1') !== 'ustar') throw new Error('bundle: not a tar archive (make one with tools/collect.sh, or tar -czf)');
    let name = str(off, 100);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8), type = String.fromCharCode(h[156] || 48), prefix = str(off + 345, 155);
    if (!Number.isFinite(size) || size < 0) throw new Error('bundle: bad tar header');
    const body = off + 512, next = body + Math.ceil(size / 512) * 512;
    if (next > buf.length + 512) throw new Error('bundle: truncated tar');
    if (type === 'L') { longName = buf.subarray(body, body + size).toString('utf8').replace(/\0.*$/s, ''); off = next; continue; }
    if (longName) { name = longName; longName = null; } else if (prefix) name = `${prefix}/${name}`;
    if (type === '0' || type === '\0' || type === '7') {
      if (size > MAX_FILE) throw new Error(`bundle: ${name} is larger than ${MAX_FILE >> 20} MB`);
      total += size;
      if (total > MAX_TOTAL || out.length >= MAX_FILES) throw new Error('bundle: too large');
      out.push({ name: safeName(name), data: buf.subarray(body, body + size) });
    }
    off = next;
  }
  if (!out.length && buf.length >= 512 && !buf.subarray(0, 512).every(b => b === 0)) throw new Error('bundle: no files in the archive');
  if (buf.length < 512) throw new Error('bundle: not a tar archive (make one with tools/collect.sh, or tar -czf)');
  return out;
}

// No absolute paths, no "..": a bundle can only write inside the directory it is unpacked into.
export function safeName(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some(p => p === '..')) throw new Error(`bundle: unsafe path ${name}`);
  return n;
}

// A tar of files, for `fleetops send` from a directory and for tests. entries: [{ name, data }]
export function writeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data)), h = Buffer.alloc(512);
    const name = safeName(e.name);
    if (Buffer.byteLength(name) > 100) { const ln = Buffer.from(name + '\0'); const lh = Buffer.alloc(512); header(lh, '././@LongLink', ln.length, 'L'); blocks.push(lh, pad(ln)); header(h, name.slice(0, 99), data.length, '0'); }
    else header(h, name, data.length, '0');
    blocks.push(h, pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function header(h, name, size, type) {
  h.write(name, 0, 100, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
}
const pad = b => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

// Unpack into a new temporary directory; returns { dir, files: [relative paths] }.
export function unpack(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-bundle-')), files = [];
  for (const e of readTar(buf)) {
    const p = path.join(dir, e.name);
    if (!p.startsWith(dir + path.sep)) throw new Error(`bundle: unsafe path ${e.name}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.data);
    files.push(e.name);
  }
  return { dir, files };
}

// What kind of file this is, from its name and first bytes. Returns a source name for `data import`, or null.
export function sniff(name, head) {
  const n = name.toLowerCase(), h = String(head).slice(0, 65536), t = h.trimStart();
  if (n.endsWith('manifest.json')) return null;
  if (/^\s*<\?xml[\s\S]{0,200}<nvidia_smi_log|^==============NVSMI LOG==============/m.test(h) || /\bProduct Name\s+:/.test(h) && /\bSerial Number\s+:/.test(h)) return 'nvidia-smi-q';
  if (/\bGPU0\b/.test(h) && /Legend:/.test(h)) return 'nvidia-topo';
  if (/^(Switch|Ca)\s+\d+\s+"/m.test(h) || /vendid=0x/.test(h)) return 'ibnetdiscover';
  if (/^Errors for\s+0x[0-9a-f]+/im.test(h)) return 'ibqueryerrors';
  if (/^#\s*Port (extended )?counters:\s*Lid/im.test(h)) return 'perfquery';
  if (/^device\s+\S+\s+mounted on\s+\S+\s+with fstype nfs/m.test(h)) return 'mountstats';
  if (/^(obdfilter|mdt)\.[\w-]+\.job_stats=/m.test(h)) return 'lustre-jobstats';
  if (/^# (HELP|TYPE) vllm:|^vllm:\w+/m.test(h)) return 'vllm';
  if (/^(# (HELP|TYPE) )?(DCGM_FI_|amd_|gpu_|sambanova_)/m.test(h)) return 'exporter';
  if (/NodeName=\S+/.test(h) && /State=/.test(h)) return 'slurm-nodes';
  if (/^JobID(Raw)?\|/im.test(t)) return 'sacct';
  if (/^timestamp,\s*contexttokens,\s*generatedtokens/im.test(t)) return 'azure-llm';
  if (/^node,/i.test(t) && /rack|pdu|row/i.test(t.split(/\r?\n/)[0])) return 'racks';
  if (t[0] === '{' || t[0] === '[') {
    // a JSON document, or JSON lines
    let j = null;
    try { j = JSON.parse(h.length < String(head).length ? null : t); } catch { j = null; }
    const first = (() => { try { return JSON.parse(t.split(/\r?\n/)[0]); } catch { return null; } })();
    const o = j ?? first;
    if (o && !Array.isArray(o)) {
      if (o.kind === 'List' || Array.isArray(o.items)) {
        const k = (o.items && o.items[0] && o.items[0].kind) || '';
        if (k === 'Node' || /nodes/.test(n)) return 'k8s-nodes';
        if (k === 'Pod' || /pods/.test(n)) return 'k8s-pods';
        if (k === 'Event' || /events/.test(n)) return 'k8s-events';
      }
      if (o.traceEvents || /"traceEvents"\s*:/.test(h)) return 'kineto';
      if (o.resourceSpans) return 'otlp-traces';
      if (o.header && (o.coll_perf || o.p2p_perf || o.metadata)) return 'nccl-inspector';
      if (first && first.check && first.node) return 'sdc-checks';
      if (first && first.step != null && (first.durS != null || first.step_time != null || first.stepTime != null)) return 'step-log';
      if (first && (first.isl != null || first.input_tokens != null || first.prompt_tokens != null || first.usage)) return 'requests';
      if (first && first.target && (first.kind || first.summary)) return 'changes';
    }
    if (!o) {
      // a large document cut off at 64 KB: recognize it by its keys
      const kind = (h.match(/"kind"\s*:\s*"(Node|Pod|Event)"/) || [])[1];
      if (/"kind"\s*:\s*"List"/.test(h) && kind) return { Node: 'k8s-nodes', Pod: 'k8s-pods', Event: 'k8s-events' }[kind];
      if (/"traceEvents"\s*:/.test(h)) return 'kineto';
      if (/"resourceSpans"\s*:/.test(h)) return 'otlp-traces';
      if (/"coll_perf"\s*:/.test(h)) return 'nccl-inspector';
      if (/"revision"\s*:/.test(h) && /"chart"\s*:/.test(h)) return 'helm-history';
      if (/"jobid"\s*:/.test(h) && /"attempts"\s*:/.test(h)) return 'philly-jobs';
      return null;
    }
    if (Array.isArray(o)) {
      if (o[0] && o[0].revision != null && o[0].chart) return 'helm-history';
      if (o[0] && o[0].attempts && o[0].jobid) return 'philly-jobs';
      if (o[0] && o[0].header && o[0].coll_perf) return 'nccl-inspector';
    }
    return null;
  }
  if (/^\[ *\d+\.\d+\]|kernel:|NVRM: Xid|amdgpu|mlx5_core/m.test(h) && !/NCCL (WARN|INFO)/.test(h)) return 'kernel-log';
  if (/NCCL (WARN|INFO)|Watchdog caught collective operation timeout|ProcessGroupNCCL|Traceback \(most recent call last\)/.test(h)) return 'app-log';
  if (/^(t|timestamp|time),/i.test(t) && /isl|input|prompt/i.test(t.split(/\r?\n/)[0])) return 'requests';
  return null;
}

// Plan the import of an unpacked bundle: manifest entries first, then anything else recognized by content.
export function plan(dir) {
  const mf = path.join(dir, 'manifest.json'), entries = [], named = new Set();
  let manifest = null;
  if (fs.existsSync(mf)) {
    manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    for (const e of manifest.files || []) {
      const rel = safeName(e.path), abs = path.join(dir, rel);
      if (!fs.existsSync(abs)) { entries.push({ path: rel, source: e.source, missing: true }); continue; }
      named.add(rel);
      entries.push({ path: rel, abs, source: e.source || sniffFile(abs, rel), opts: e.opts || {}, from: 'manifest' });
    }
  }
  for (const rel of walk(dir)) {
    if (named.has(rel) || rel === 'manifest.json') continue;
    const abs = path.join(dir, rel), source = sniffFile(abs, rel);
    entries.push({ path: rel, abs, source, opts: {}, from: 'sniffed' });
  }
  return { manifest, entries };
}
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel)); else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}
export function sniffFile(abs, rel = abs) {
  const fd = fs.openSync(abs, 'r'), b = Buffer.alloc(Math.min(65536, fs.statSync(abs).size));
  try { fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
  if (b[0] === 0x1f && b[1] === 0x8b) return null; // nested archives are not opened
  return sniff(rel, b.toString('utf8'));
}
