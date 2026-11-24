// Store layout migrations. Each one moves a store from version n to n + 1, day by day, so an interrupted run can be
// re-run. `fleetops data migrate` shows what would change; `--apply` rewrites.
import { SCHEMA, readMeta, writeMeta } from './store.mjs';

const str = v => (v == null ? v : String(v));
const devs = list => (Array.isArray(list) ? list.map(d => Object.assign({}, d, { gpu: str(d.gpu) })) : list);

export const MIGRATIONS = {
  // 1 → 2: device indexes are strings everywhere (some adapters wrote numbers, so "0" and 0 were two GPUs)
  2: {
    what: 'GPU indexes as strings in device, log, health, placement and job records',
    kinds: ['device', 'log', 'health', 'placement', 'job'],
    record: r => {
      const o = Object.assign({}, r);
      if (o.gpu != null && typeof o.gpu !== 'string') o.gpu = String(o.gpu);
      if (o.devices) o.devices = devs(o.devices);
      return o;
    },
  },
};

// Plan or apply the migrations from the store's version to SCHEMA. Returns [{ to, what, kind, day, records, changed }].
export function migrate(store, { apply = false } = {}) {
  const meta = readMeta(store.dir) || { schema: 1 };
  const out = [];
  for (let v = meta.schema + 1; v <= SCHEMA; v++) {
    const m = MIGRATIONS[v];
    for (const kind of m.kinds) for (const d of store.days(kind)) {
      const from = Date.parse(d + 'T00:00:00Z') / 1000;
      const recs = store.query(kind, { from: from - 1e-6, to: from + 86400 - 1e-6 });
      const next = recs.map(m.record), changed = next.filter((r, i) => JSON.stringify(r) !== JSON.stringify(recs[i])).length;
      out.push({ to: v, what: m.what, kind, day: d, records: recs.length, changed });
      if (apply && changed) store.rewriteDay(kind, d, next);
    }
    if (apply) writeMeta(store.dir, Object.assign({}, readMeta(store.dir), { schema: v, migratedAt: new Date().toISOString() }));
  }
  return { from: meta.schema, to: SCHEMA, steps: out, applied: apply };
}
