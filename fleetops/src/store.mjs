// The shared data layer: one directory of JSON-lines files, one folder per record kind, one file per UTC day.
//
//   <dir>/device/2026-11-23.jsonl   <dir>/change/2026-11-23.jsonl   …
//
// Plain files, so any tool (or jq, or DuckDB) can read them, they compress well and they are easy to ship between sites.
// Appends are per record; a query streams the day files that overlap the requested window.
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, validate } from './schema.mjs';

const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const dayStart = d => Date.parse(d + 'T00:00:00Z') / 1000;

export class DataStore {
  constructor(dir) { this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true }); }
  files(kind) {
    const d = path.join(this.dir, kind);
    return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map(f => path.join(d, f)) : [];
  }

  // Append records of one kind. Invalid records are skipped and reported. With `dedupe`, a record identical to one
  // already stored for the same day is not written again, so re-running an import is safe.
  append(kind, records, { dedupe = false, source } = {}) {
    if (!KINDS[kind]) throw new Error(`unknown kind "${kind}"`);
    const byDay = new Map(), errors = [];
    let i = 0;
    for (const r0 of records) {
      i++;
      const r = source && r0.source == null ? Object.assign({ source }, r0) : r0;
      const bad = validate(kind, r);
      if (bad.length) { if (errors.length < 20) errors.push(`#${i}: ${bad.join('; ')}`); continue; }
      const d = day(r.t);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(JSON.stringify(r));
    }
    let written = 0, skipped = 0;
    const dir = path.join(this.dir, kind);
    fs.mkdirSync(dir, { recursive: true });
    for (const [d, lines] of byDay) {
      const f = path.join(dir, d + '.jsonl');
      let keep = lines;
      if (dedupe && fs.existsSync(f)) {
        const seen = new Set(fs.readFileSync(f, 'utf8').split('\n'));
        keep = lines.filter(l => !seen.has(l) && seen.add(l));
      } else if (dedupe) { const seen = new Set(); keep = lines.filter(l => !seen.has(l) && seen.add(l)); }
      skipped += lines.length - keep.length;
      if (keep.length) fs.appendFileSync(f, keep.join('\n') + '\n');
      written += keep.length;
    }
    return { kind, written, skipped, invalid: i - written - skipped, errors };
  }

  // Records of one kind with from < t <= to (either bound optional), oldest day first, in file order within a day.
  *scan(kind, { from = -Infinity, to = Infinity, where } = {}) {
    for (const f of this.files(kind)) {
      const d0 = dayStart(path.basename(f, '.jsonl'));
      if (d0 + 86400 <= from || d0 > to) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line);
        if (r.t <= from || r.t > to) continue;
        if (where && !where(r)) continue;
        yield r;
      }
    }
  }
  query(kind, opts = {}) {
    const out = [];
    for (const r of this.scan(kind, opts)) { out.push(r); if (opts.limit && out.length >= opts.limit) break; }
    return opts.sort === false ? out : out.sort((a, b) => a.t - b.t);
  }

  // Per kind: record count, first and last time, sources.
  summary() {
    const out = {};
    for (const kind of Object.keys(KINDS)) {
      const files = this.files(kind);
      if (!files.length) continue;
      let n = 0, first = Infinity, last = -Infinity;
      const sources = new Map();
      for (const r of this.scan(kind)) { n++; if (r.t < first) first = r.t; if (r.t > last) last = r.t; const s = r.source || '–'; sources.set(s, (sources.get(s) || 0) + 1); }
      out[kind] = { records: n, days: files.length, from: first, to: last, sources: Object.fromEntries(sources) };
    }
    return out;
  }
}

// `k=v` filters from the command line (numbers compared as numbers, `k~text` for contains).
export function whereFrom(list) {
  const conds = (list || []).map(s => { const m = String(s).match(/^([\w.]+)(=|~|>|<)(.*)$/); if (!m) throw new Error(`bad filter "${s}": use key=value, key~text, key>n or key<n`); return m.slice(1); });
  if (!conds.length) return undefined;
  const get = (r, k) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), r);
  return r => conds.every(([k, op, v]) => {
    const x = get(r, k);
    if (op === '=') return String(x) === v;
    if (op === '~') return String(x ?? '').includes(v);
    return op === '>' ? +x > +v : +x < +v;
  });
}
