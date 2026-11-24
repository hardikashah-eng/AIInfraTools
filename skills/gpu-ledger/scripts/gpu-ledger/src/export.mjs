// Outputs: a text/markdown report, a showback CSV, and FOCUS 1.4 cost-and-usage rows (with x_ columns for the classes).
import { groupBy, periods } from './ledger.mjs';
import { classify } from './core.mjs';

const H = 3600;
const n1 = v => (v == null ? '–' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(0) : v.toFixed(1));
const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const money = (v, cur = 'USD') => (v == null ? '–' : `${cur === 'USD' ? '$' : cur + ' '}${n1(v)}`);
const csvCell = v => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';

export function reportText(L, { by = ['org'], ins = [], top = 10, budgets: b = [], md = false } = {}) {
  const t = L.totals, cur = L.currency, out = [], line = s => out.push(s);
  const d0 = new Date(L.from * 1000).toISOString().slice(0, 16).replace('T', ' '), d1 = new Date(L.to * 1000).toISOString().slice(0, 16).replace('T', ' ');
  line(`${md ? '# ' : ''}GPU ledger ${d0} → ${d1} UTC (${L.days.toFixed(1)} days)`);
  line('');
  line(`${md ? '- ' : '  '}allocated ${n1(t.alloc / H)} GPU-h, ${money(t.cost, cur)}${t.priced < t.alloc ? ` (${pct(t.priced / t.alloc)} priced)` : ''}`);
  line(`${md ? '- ' : '  '}useful ${pct(t.useful / t.alloc)} · idle ${pct(t.idle / t.alloc)} · lost to failures ${pct(t.lost / t.alloc)} → ${money(t.wasted, cur)} not buying work`);
  if (t.sm != null) line(`${md ? '- ' : '  '}SM active while busy: ${pct(t.sm)}`);
  for (const u of L.unallocated) line(`${md ? '- ' : '  '}unallocated ${u.cluster ? u.cluster + ' ' : ''}${u.gpuType}: ${pct(u.share)} of capacity (${n1(u.unallocated / H)} GPU-h${u.cost != null ? `, ${money(u.cost, cur)}` : ''})${u.overcommitted ? ` — allocations are ${u.overcommitted.toFixed(1)}× the capacity given: check the capacity file` : ''}`);
  const c = L.coverage;
  line(`${md ? '- ' : '  '}coverage: org known for ${pct(c.attributedOrg)}, person for ${pct(c.attributedUser)}, utilization measured for ${pct(c.utilization)}, priced ${pct(c.priced)} of GPU-hours`);
  if (c.utilization < 0.5) line(`${md ? '- ' : '  '}  without utilization, idle time can't be seen: everything not lost counts as useful (an upper bound)`);
  const canc = L.rows.filter(x => x.r.status === 'cancelled').reduce((a, x) => a + x.alloc, 0);
  if (canc > 0.1 * t.alloc && L.policy.cancelled === 'useful') line(`${md ? '- ' : '  '}cancelled runs (${pct(canc / t.alloc)} of GPU-hours) count as useful: stopping after a checkpoint is normal (--policy with cancelled: lost-tail to change)`);
  const lb = Object.entries(L.lostBases).sort((a, b) => b[1] - a[1]);
  if (lb.length) line(`${md ? '- ' : '  '}lost work estimated as: ${lb.map(([k, v]) => `${k} (${pct(v / Math.max(1, t.lost))})`).join('; ')}`);
  line('');
  const gs = groupBy(L, by);
  const head = [...by, 'GPU-h', 'cost', 'useful', 'idle', 'lost', 'wasted', 'SM'];
  const rows = gs.slice(0, Math.max(top, 25)).map(g => [...by.map(k => String(g.key[k])), n1(g.alloc / H), money(g.priced ? g.cost : null, cur), pct(g.useful / g.alloc), pct(g.idle / g.alloc), pct(g.lost / g.alloc), money(g.priced ? g.wasted : null, cur), pct(g.sm)]);
  if (md) { line(`## By ${by.join(', ')}`); line(''); line(`| ${head.join(' | ')} |`); line(`|${head.map(() => '---').join('|')}|`); for (const r of rows) line(`| ${r.join(' | ')} |`); }
  else { const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length))); line(head.map((h, i) => h.padEnd(w[i])).join('  ')); for (const r of rows) line(r.map((v, i) => (i < by.length ? v.padEnd(w[i]) : v.padStart(w[i]))).join('  ')); }
  if (gs.length > rows.length) line(`… ${gs.length - rows.length} more`);
  if (b.length) { line(''); line(md ? '## Budgets' : 'Budgets (per month):'); for (const x of b) line(`${md ? '- ' : '  '}${x.over ? 'OVER ' : ''}${x.key}: run rate ${money(x.perMonth, cur)} of ${money(x.budget, cur)} (${pct(x.share)})`); }
  if (ins.length) {
    line(''); line(md ? '## Where to save' : 'Where to save (per month):');
    for (const i of ins.slice(0, top)) {
      line(`${md ? '- **' : '  '}${i.savings.usdMonth != null ? money(i.savings.usdMonth, cur) + '/mo' : i.savings.gpuHMonth ? `${n1(i.savings.gpuHMonth)} GPU-h/mo` : 'unknown'}${md ? '**' : ''} ${i.title} [${i.kind}; ${i.basis}; ${i.confidence}]`);
      line(`${md ? '  ' : '      '}${i.evidence}`); line(`${md ? '  ' : '      '}→ ${i.action}${i.caveat ? ` (${i.caveat})` : ''}`);
    }
    if (ins.length > top) line(`  … ${ins.length - top} more (--json for all)`);
  }
  return out.join('\n') + '\n';
}

export function showbackCsv(L, { by = ['org', 'team', 'user', 'project', 'useCase', 'gpuType'], period = 'month' } = {}) {
  const gs = groupBy(L, by, period);
  return toCsv(['period', ...by, 'gpu_hours', 'useful_gpu_hours', 'idle_gpu_hours', 'lost_gpu_hours', 'cost', 'wasted_cost', 'sm_active', 'output_tokens', 'currency'],
    gs.map(g => Object.assign({ period: g.period }, g.key, { gpu_hours: r3(g.alloc / H), useful_gpu_hours: r3(g.useful / H), idle_gpu_hours: r3(g.idle / H), lost_gpu_hours: r3(g.lost / H), cost: r2(g.cost), wasted_cost: r2(g.wasted), sm_active: g.sm == null ? null : r3(g.sm), output_tokens: Math.round(g.tokensOut), currency: L.currency })));
}
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

// FOCUS 1.4 Cost and Usage rows, one per day × cluster × GPU type × provider × owner × use case. On-prem cost is
// amortized internal cost: BilledCost = EffectiveCost = ListCost = ContractedCost. The classes ride in x_ columns.
export const FOCUS_COLUMNS = ['BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingCurrency', 'BillingPeriodStart', 'BillingPeriodEnd', 'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency',
  'ChargePeriodStart', 'ChargePeriodEnd', 'ConsumedQuantity', 'ConsumedUnit', 'ContractedCost', 'ContractedUnitPrice', 'EffectiveCost', 'HostProviderName', 'InvoiceIssuerName', 'ListCost', 'ListUnitPrice',
  'PricingCategory', 'PricingQuantity', 'PricingUnit', 'RegionId', 'RegionName', 'ResourceId', 'ResourceName', 'ResourceType', 'ServiceCategory', 'ServiceName', 'ServiceProviderName', 'SubAccountId', 'SubAccountName',
  'AllocatedMethodId', 'AllocatedResourceId', 'AllocatedResourceName', 'AllocatedTags', 'Tags',
  'x_UseCase', 'x_UsefulGpuHours', 'x_IdleGpuHours', 'x_LostGpuHours', 'x_WastedCost', 'x_SmActive', 'x_OutputTokens', 'x_RateBasis'];
export function focusRows(L, { account = 'gpu-ledger', accountName, provider = 'On-premises' } = {}) {
  const iso = s => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), out = [];
  const month = s => { const d = new Date(s * 1000); return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000]; };
  for (const [ds, de] of periods(L.from, L.to, 'day')) {
    const groups = new Map();
    for (const x of L.rows) {
      const c = classify(x.r, { from: ds, to: de, now: L.to, policy: L.policy, card: L.card, prices: L.prices }); if (!c) continue;
      const r = x.r, k = [r.cluster, r.gpuType, r.provider, r.org, r.team, r.user, r.project, r.useCase].join('\u0001');
      if (!groups.has(k)) groups.set(k, { r, alloc: 0, useful: 0, idle: 0, lost: 0, cost: 0, wasted: 0, smW: 0, smB: 0, tok: 0, rate: c.rate, basis: c.rateBasis });
      const g = groups.get(k); g.alloc += c.alloc; g.useful += c.useful; g.idle += c.idle; g.lost += c.lost; g.cost += c.cost || 0; g.wasted += c.wasted || 0; g.tok += c.tokensOut;
      if (c.smBusy != null) { g.smW += c.smBusy * (c.alloc - c.idle); g.smB += c.alloc - c.idle; }
    }
    const [bs, be] = month(ds);
    for (const g of groups.values()) {
      const r = g.r, prov = r.provider && r.provider !== 'onprem' ? r.provider : provider, q = g.alloc / H, tags = { org: r.org, team: r.team, user: r.user, project: r.project, useCase: r.useCase };
      out.push({ BilledCost: r2(g.cost), BillingAccountId: account, BillingAccountName: accountName || account, BillingCurrency: L.currency, BillingPeriodStart: iso(bs), BillingPeriodEnd: iso(be),
        ChargeCategory: 'Usage', ChargeClass: null, ChargeDescription: `${r.gpuType || 'GPU'} GPU-hours${r.cluster ? ` on ${r.cluster}` : ''} for ${r.team}`, ChargeFrequency: 'Usage-Based',
        ChargePeriodStart: iso(ds), ChargePeriodEnd: iso(de), ConsumedQuantity: r3(q), ConsumedUnit: 'GPU-Hours', ContractedCost: r2(g.cost), ContractedUnitPrice: g.rate == null ? null : r3(g.rate), EffectiveCost: r2(g.cost),
        HostProviderName: prov, InvoiceIssuerName: prov, ListCost: r2(g.cost), ListUnitPrice: g.rate == null ? null : r3(g.rate), PricingCategory: 'Standard', PricingQuantity: r3(q), PricingUnit: 'GPU-Hours',
        RegionId: r.region || r.cluster || null, RegionName: r.region || r.cluster || null, ResourceId: [r.cluster, r.gpuType].filter(Boolean).join('/') || null, ResourceName: r.gpuType ? `${r.gpuType} GPUs` : null, ResourceType: 'GPU',
        ServiceCategory: 'Compute', ServiceName: 'GPU Compute', ServiceProviderName: prov, SubAccountId: r.org, SubAccountName: r.org,
        AllocatedMethodId: 'gpu-ledger/gpu-seconds', AllocatedResourceId: `${r.org}/${r.team}/${r.user}/${r.project}`, AllocatedResourceName: `${r.team} · ${r.user}`, AllocatedTags: tags, Tags: tags,
        x_UseCase: r.useCase, x_UsefulGpuHours: r3(g.useful / H), x_IdleGpuHours: r3(g.idle / H), x_LostGpuHours: r3(g.lost / H), x_WastedCost: r2(g.wasted), x_SmActive: g.smB ? r3(g.smW / g.smB) : null, x_OutputTokens: Math.round(g.tok), x_RateBasis: g.basis });
    }
  }
  for (const u of L.unallocated) if (u.unallocated > 0) {
    const [bs, be] = month(L.from);
    out.push({ BilledCost: r2(u.cost || 0), BillingAccountId: account, BillingAccountName: accountName || account, BillingCurrency: L.currency, BillingPeriodStart: iso(bs), BillingPeriodEnd: iso(be), ChargeCategory: 'Usage', ChargeClass: null,
      ChargeDescription: `Unallocated ${u.gpuType} capacity${u.cluster ? ` on ${u.cluster}` : ''}`, ChargeFrequency: 'Usage-Based', ChargePeriodStart: iso(L.from), ChargePeriodEnd: iso(L.to), ConsumedQuantity: r3(u.unallocated / H), ConsumedUnit: 'GPU-Hours',
      ContractedCost: r2(u.cost || 0), ContractedUnitPrice: u.rate, EffectiveCost: r2(u.cost || 0), HostProviderName: provider, InvoiceIssuerName: provider, ListCost: r2(u.cost || 0), ListUnitPrice: u.rate, PricingCategory: 'Standard',
      PricingQuantity: r3(u.unallocated / H), PricingUnit: 'GPU-Hours', RegionId: u.cluster, RegionName: u.cluster, ResourceId: [u.cluster, u.gpuType].filter(Boolean).join('/'), ResourceName: `${u.gpuType} GPUs`, ResourceType: 'GPU',
      ServiceCategory: 'Compute', ServiceName: 'GPU Compute', ServiceProviderName: provider, SubAccountId: null, SubAccountName: null, AllocatedMethodId: null, AllocatedResourceId: null, AllocatedResourceName: null, AllocatedTags: null,
      Tags: { unallocated: true }, x_UseCase: 'unallocated', x_UsefulGpuHours: 0, x_IdleGpuHours: r3(u.unallocated / H), x_LostGpuHours: 0, x_WastedCost: r2(u.cost || 0), x_SmActive: null, x_OutputTokens: 0, x_RateBasis: u.rateBasis });
  }
  return out;
}
export const focusCsv = (L, o) => toCsv(FOCUS_COLUMNS, focusRows(L, o));
