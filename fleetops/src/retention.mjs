// Rollups and retention: keep raw data for days, minute and hour rollups for months, incident windows at full
// resolution for good.
//
//   <store>/rollup-60/device/…     one record per device per minute   (mean of each numeric field, max of tempC and
//   <store>/rollup-3600/device/…   one record per device per hour      powerW, faults unioned, n = samples)
//   <store>/keep/<kind>/…          raw records inside incident windows, copied before the raw days are dropped
//
// Rollup stores use the same backend as the store. Only high-volume kinds are dropped (device, request, span); logs,
// changes, jobs and everything else stay.
import path from 'node:path';
import { DataStore, openStore } from './store.mjs';

export const HIGH_VOLUME = ['device', 'request', 'span'];
const MEAN = ['sm', 'tensor', 'dram', 'memUsedGB', 'clockMHz', 'tempC', 'powerW', 'memTempC'], MAX = ['tempC', 'powerW', 'eccSbeTotal', 'eccDbeTotal', 'linkErrTotal', 'remapPending'];
const dayStart = d => Date.parse(d + 'T00:00:00Z') / 1000;

// Device samples → one record per device per `step` seconds (t = start of the bin, so a bin stays in its samples' day).
// `samples` may be any iterable (a store scan streams: memory holds the bins, not the raw day).
export function rollupDevices(samples, step) {
  const bins = new Map();
  for (const s of samples) {
    const t = Math.floor(s.t / step) * step, k = `${s.node}|${s.gpu}|${t}`;
    let b = bins.get(k);
    if (!b) bins.set(k, (b = { t, node: s.node, gpu: String(s.gpu), vendor: s.vendor, kind: s.kind, sku: s.sku, site: s.site, step, n: 0, sums: {}, cnt: {}, max: {}, faults: new Set(), offlineMinutes: 0 }));
    b.n++;
    for (const f of MEAN) if (Number.isFinite(s[f])) { b.sums[f] = (b.sums[f] || 0) + s[f]; b.cnt[f] = (b.cnt[f] || 0) + 1; }
    for (const f of MAX) if (Number.isFinite(s[f])) b.max[f] = Math.max(b.max[f] ?? -Infinity, s[f]);
    for (const x of s.faults || []) b.faults.add(x);
    b.offlineMinutes += s.offlineMinutes || 0;
  }
  return [...bins.values()].map(b => {
    const r = { t: b.t, node: b.node, gpu: b.gpu, vendor: b.vendor, kind: b.kind, sku: b.sku, step: b.step, n: b.n };
    if (b.site) r.site = b.site;
    for (const f of MEAN) if (b.cnt[f]) r[f] = +(b.sums[f] / b.cnt[f]).toFixed(4);
    for (const f of MAX) if (b.max[f] != null) r[`${f}Max`] = b.max[f];
    r.faults = [...b.faults]; if (b.offlineMinutes) r.offlineMinutes = b.offlineMinutes;
    r.rollup = true;
    return r;
  }).sort((a, b) => a.t - b.t);
}

// The rollup store for a step, next to the raw store (same backend).
export async function rollupStore(store, step) {
  const dir = path.join(store.dir, `rollup-${step}`);
  return store instanceof DataStore ? new DataStore(dir) : openStore(dir, { backend: 'parquet' });
}

// Roll up the raw device days that have no rollup yet (or `days`), for each step.
export async function rollup(store, { steps = [60, 3600], days } = {}) {
  const out = [];
  for (const step of steps) {
    const rs = await rollupStore(store, step), done = new Set(rs.days('device'));
    for (const d of days || store.days('device')) {
      if (!days && done.has(d)) continue;
      if (done.has(d)) rs.dropDay('device', d);
      if (store.rollupDay) { out.push({ step, day: d, rolled: store.rollupDay('device', d, step, rs.dir) }); continue; } // in DuckDB
      const from = dayStart(d);
      let raw = 0;
      const recs = rollupDevices((function* () { for (const r of store.scan('device', { from: from - 1e-6, to: from + 86400 - 1e-6 })) { raw++; yield r; } })(), step);
      rs.append('device', recs); if (rs.flush) rs.flush();
      out.push({ step, day: d, raw, rolled: recs.length });
    }
  }
  return out;
}

// Retention: raw high-volume days older than rawDays are dropped once they are rolled up, after copying every record
// inside an incident window (incident records, ±pad) into <store>/keep. Dry-run unless apply.
export async function compact(store, { rawDays = 7, now = Date.now() / 1000, apply = false, pad = 2 * 3600, steps = [60, 3600] } = {}) {
  const cutoff = new Date((now - rawDays * 86400) * 1000).toISOString().slice(0, 10);
  const windows = store.query('incident').map(i => { const inc = i.incident || i; return [(inc.from ?? i.t) - pad, (inc.to ?? i.t) + pad]; });
  const plan = [];
  for (const kind of HIGH_VOLUME) for (const d of store.days(kind)) {
    if (d >= cutoff) continue;
    const from = dayStart(d), to = from + 86400;
    const keep = windows.filter(([a, b]) => a < to && b > from);
    plan.push({ kind, day: d, keepWindows: keep.length });
  }
  if (!apply) return { cutoff, plan, applied: false };
  const keepStore = store instanceof DataStore ? new DataStore(path.join(store.dir, 'keep')) : await openStore(path.join(store.dir, 'keep'), { backend: 'parquet' });
  const devDays = plan.filter(p => p.kind === 'device').map(p => p.day);
  if (devDays.length) await rollup(store, { steps }); // never drop a device day that isn't rolled up
  for (const p of plan) {
    const from = dayStart(p.day), to = from + 86400;
    for (const [a, b] of windows.filter(([a, b]) => a < to && b > from)) {
      const recs = store.query(p.kind, { from: Math.max(a, from - 1e-6), to: Math.min(b, to - 1e-6) });
      keepStore.append(p.kind, recs, { dedupe: true });
      p.kept = (p.kept || 0) + recs.length;
    }
    if (keepStore.flush) keepStore.flush();
    store.dropDay(p.kind, p.day);
    p.dropped = true;
  }
  return { cutoff, plan, applied: true };
}
