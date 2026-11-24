// The ledger: usage records + prices + attribution → classified rows, groups, fleet totals and coverage.
import { attribute, classify, rateCard, priceOf, POLICY, gpuKey } from './core.mjs';

export const UNATTRIBUTED = '(unattributed)';
const DAY = 86400;

// opts: { from, to, now, prices, attribution, capacity: [{ cluster?, gpuType, gpus, provider? }], policy }
export function ledger(records, opts = {}) {
  const prices = opts.prices || {}, card = rateCard(prices), policy = Object.assign({}, POLICY, opts.policy || {});
  let from = opts.from, to = opts.to;
  if (from == null) from = Math.min(...records.map(r => r.start).filter(Number.isFinite).concat([Infinity]));
  if (to == null) { let m = -Infinity; for (const r of records) m = Math.max(m, r.end ?? opts.now ?? r.start); to = m; }
  const now = opts.now ?? to, rows = [];
  // a group (a job and its retries) that failed at least policy.neverSucceeded times and never succeeded produced
  // nothing: all of it is lost, not only the tails
  const fails = new Map(), okGroups = new Set();
  for (const r of records) { const g = r.group; if (g == null) continue; if (r.status === 'succeeded' || r.status === 'running' || r.status === 'cancelled') okGroups.add(g); else if (policy.lostOn.includes(r.status)) fails.set(g, (fails.get(g) || 0) + 1); }
  for (const r0 of records) {
    const r = attribute(Object.assign({}, r0, { gpuType: gpuKey(r0.gpuType) }), opts.attribution || {});
    if (policy.neverSucceeded && r.group != null && !okGroups.has(r.group) && (fails.get(r.group) || 0) >= policy.neverSucceeded) r._neverSucceeded = true;
    for (const k of ['org', 'team', 'user', 'project']) if (r[k] == null) r[k] = UNATTRIBUTED;
    const c = classify(r, { from, to, now, policy, card, prices });
    if (c) rows.push(c);
  }
  const totals = sum(rows);
  // capacity nobody was allocated, per cluster and GPU type
  const unallocated = [];
  for (const cap of opts.capacity || []) {
    const t = gpuKey(cap.gpuType), s = Math.max(from, cap.from ?? from), e = Math.min(to, cap.to ?? to);
    if (!(e > s)) continue;
    const have = cap.gpus * (e - s), used = rows.filter(x => x.r.gpuType === t && (cap.cluster == null || x.r.cluster === cap.cluster)).reduce((a, x) => a + x.alloc, 0);
    const p = priceOf(card, prices, t, cap.provider), free = Math.max(0, have - used);
    unallocated.push({ cluster: cap.cluster || null, gpuType: t, capacity: have, allocated: Math.min(have, used), unallocated: free, share: have ? free / have : 0, overcommitted: used > have * 1.01 ? used / have : null,
      cost: p ? p.rate * free / 3600 : null, powerCost: p && p.parts ? p.parts.power * free / 3600 : null, rate: p ? p.rate : null, rateBasis: p ? p.basis : null });
  }
  const g = totals.alloc || 1;
  const coverage = {
    attributedOrg: rows.filter(x => x.r.org !== UNATTRIBUTED).reduce((a, x) => a + x.alloc, 0) / g,
    attributedUser: rows.filter(x => x.r.user !== UNATTRIBUTED).reduce((a, x) => a + x.alloc, 0) / g,
    utilization: rows.filter(x => x.measured).reduce((a, x) => a + x.alloc, 0) / g,
    priced: rows.filter(x => x.rate != null).reduce((a, x) => a + x.alloc, 0) / g,
    gpuType: rows.filter(x => x.r.gpuType).reduce((a, x) => a + x.alloc, 0) / g,
  };
  const lostBases = {};
  for (const x of rows) if (x.lost > 0) lostBases[x.lostBasis] = (lostBases[x.lostBasis] || 0) + x.lost;
  return { from, to, days: (to - from) / DAY, currency: prices.currency || 'USD', policy, card, prices, rows, totals, unallocated, coverage, lostBases, attribution: opts.attribution || {} };
}

export function sum(rows) {
  const t = { alloc: 0, useful: 0, idle: 0, lost: 0, cost: 0, wasted: 0, idleLong: 0, smW: 0, smBase: 0, tokensOut: 0, records: 0, priced: 0 };
  for (const x of rows) {
    t.alloc += x.alloc; t.useful += x.useful; t.idle += x.idle; t.lost += x.lost; t.records++;
    if (x.cost != null) { t.cost += x.cost; t.wasted += x.wasted; t.priced += x.alloc; }
    if (x.idleLong) t.idleLong += x.idleLong;
    if (x.smBusy != null) { const busy = x.alloc - x.idle; t.smW += x.smBusy * busy; t.smBase += busy; }
    t.tokensOut += x.tokensOut || 0;
  }
  t.efficiency = t.alloc ? t.useful / t.alloc : null;
  t.sm = t.smBase ? t.smW / t.smBase : null;
  return t;
}

// Group rows by any record fields (org, team, user, project, useCase, gpuType, cluster, model, status, …) and an
// optional period (day | week | month). A period splits each allocation at the boundaries.
export function groupBy(L, keys = ['org'], period = null) {
  const keyOf = x => keys.map(k => (k === 'model' ? (x.r.serving || {}).model || '–' : x.r[k] ?? '–'));
  const out = new Map();
  const add = (pk, x) => { const kk = keyOf(x), id = JSON.stringify([pk, ...kk]); if (!out.has(id)) out.set(id, { period: pk, key: Object.fromEntries(keys.map((k, i) => [k, kk[i]])), rows: [] }); out.get(id).rows.push(x); };
  if (!period) for (const x of L.rows) add(null, x);
  else {
    const card = L.card;
    for (const [ps, pe] of periods(L.from, L.to, period)) {
      for (const x of L.rows) { const c = classify(x.r, { from: ps, to: pe, now: L.to, policy: L.policy, card, prices: L.prices }); if (c) add(new Date(ps * 1000).toISOString().slice(0, 10), c); }
    }
  }
  return [...out.values()].map(g => Object.assign({ period: g.period, key: g.key }, sum(g.rows)))
    .sort((a, b) => (a.period || '').localeCompare(b.period || '') || (b.cost - a.cost) || (b.alloc - a.alloc));
}

export function periods(from, to, period) {
  const out = []; let d = new Date(from * 1000);
  const start = { day: () => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), week: () => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)), month: () => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }[period];
  if (!start) throw new Error(`period must be day, week or month: ${period}`);
  let s = start() / 1000;
  while (s < to) {
    const sd = new Date(s * 1000);
    const e = (period === 'day' ? Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate() + 1) : period === 'week' ? Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate() + 7) : Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth() + 1, 1)) / 1000;
    out.push([Math.max(s, from), Math.min(e, to)]); s = e; d = new Date(s * 1000);
  }
  return out;
}

// Shared costs (records marked shared, unallocated capacity) spread over the rest in proportion to direct cost.
export function loaded(L, groups) {
  const shared = L.rows.filter(x => x.r.shared).reduce((a, x) => a + (x.cost || 0), 0) + L.unallocated.reduce((a, u) => a + (u.cost || 0), 0);
  const direct = groups.filter(g => !g.key.shared).reduce((a, g) => a + g.cost, 0) || 1;
  return groups.map(g => Object.assign({}, g, { loadedCost: g.cost + shared * g.cost / direct }));
}

// Budgets: { "org:research": 50000, "team:vision": 8000 } per month → spend in the window, run rate, forecast.
export function budgets(L, b = {}) {
  const out = [], monthS = 30 * DAY;
  for (const [k, budget] of Object.entries(b)) {
    const [field, value] = k.split(':');
    const spend = L.rows.filter(x => String(x.r[field]) === value).reduce((a, x) => a + (x.cost || 0), 0);
    const perMonth = spend * monthS / Math.max(1, L.to - L.from);
    out.push({ key: k, budget, spend, perMonth, share: perMonth / budget, over: perMonth > budget });
  }
  return out.sort((a, b) => b.share - a.share);
}
