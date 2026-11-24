// The DataStore interface in memory: same append (with validation and dedupe), scan, query and summary. For the
// root-cause benchmark, which builds hundreds of small stores, and for tests. The tools take either.
import { KINDS, validate } from './schema.mjs';

export class MemStore {
  constructor() { this.dir = ':memory:'; this.data = {}; }
  append(kind, records, { dedupe = false, source } = {}) {
    if (!KINDS[kind]) throw new Error(`unknown kind "${kind}"`);
    const arr = this.data[kind] || (this.data[kind] = []);
    const seen = dedupe ? new Set(arr.map(r => JSON.stringify(r))) : null;
    let i = 0, written = 0, skipped = 0;
    const errors = [];
    for (const r0 of records) {
      i++;
      const r = source && r0.source == null ? Object.assign({ source }, r0) : r0;
      const bad = validate(kind, r);
      if (bad.length) { if (errors.length < 20) errors.push(`#${i}: ${bad.join('; ')}`); continue; }
      if (seen) { const k = JSON.stringify(r); if (seen.has(k)) { skipped++; continue; } seen.add(k); }
      arr.push(JSON.parse(JSON.stringify(r))); written++;
    }
    this.sorted = Object.assign(this.sorted || {}, { [kind]: false });
    return { kind, written, skipped, invalid: i - written - skipped, errors };
  }
  *scan(kind, { from = -Infinity, to = Infinity, where } = {}) {
    const arr = this.data[kind] || [];
    if (this.sorted && this.sorted[kind] === false) { arr.sort((a, b) => a.t - b.t); this.sorted[kind] = true; }
    for (const r of arr) { if (r.t <= from || r.t > to) continue; if (where && !where(r)) continue; yield r; }
  }
  query(kind, opts = {}) {
    const out = [];
    for (const r of this.scan(kind, opts)) { out.push(r); if (opts.limit && out.length >= opts.limit) break; }
    return out;
  }
  summary() {
    const out = {};
    for (const [kind, arr] of Object.entries(this.data)) {
      if (!arr.length) continue;
      const sources = {};
      for (const r of arr) sources[r.source || '–'] = (sources[r.source || '–'] || 0) + 1;
      out[kind] = { records: arr.length, from: Math.min(...arr.map(r => r.t)), to: Math.max(...arr.map(r => r.t)), sources };
    }
    return out;
  }
}
