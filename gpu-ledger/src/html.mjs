// One self-contained HTML page: totals, where GPU-hours went per group (useful / idle / lost), where to save, coverage.
import { groupBy } from './ledger.mjs';

const H = 3600;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = v => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);

export function html(L, { by = ['org', 'team'], ins = [], budgets = [], title = 'GPU ledger' } = {}) {
  const t = L.totals, cur = L.currency === 'USD' ? '$' : L.currency + ' ', money = v => (v == null ? '–' : cur + n0(v));
  const groups = groupBy(L, by).slice(0, 20), people = groupBy(L, ['user', 'team']).sort((a, b) => b.wasted - a.wasted).slice(0, 12);
  const max = Math.max(1, ...groups.map(g => g.alloc));
  const label = g => by.map(k => g.key[k]).join(' · ');
  const bars = groups.map(g => {
    const w = x => (100 * x / max).toFixed(2);
    const tip = `${label(g)}: ${n0(g.alloc / H)} GPU-h, ${money(g.cost)}. Useful ${pct(g.useful / g.alloc)}, idle ${pct(g.idle / g.alloc)}, lost ${pct(g.lost / g.alloc)}`;
    return `<div class="row" title="${esc(tip)}" tabindex="0"><div class="lab">${esc(label(g))}</div><div class="track"><span class="seg s1" style="width:${w(g.useful)}%"></span><span class="seg s2" style="width:${w(g.idle)}%"></span><span class="seg s3" style="width:${w(g.lost)}%"></span></div><div class="val">${n0(g.alloc / H)} GPU-h · ${money(g.cost)} · <b>${pct(g.useful / g.alloc)}</b> useful</div></div>`;
  }).join('');
  const insRows = ins.slice(0, 25).map(i => `<tr><td class="num">${i.savings.usdMonth != null ? money(i.savings.usdMonth) : 'unknown'}</td><td><b>${esc(i.title)}</b><div class="muted">${esc(i.evidence)}</div><div>→ ${esc(i.action)}</div>${i.caveat ? `<div class="muted">${esc(i.caveat)}</div>` : ''}</td><td>${esc([i.owner.user, i.owner.team, i.owner.org].filter(x => x && x !== '(unattributed)').join(' · ') || i.owner.org)}</td><td>${esc(i.basis)}<div class="muted">${esc(i.confidence)} confidence</div></td></tr>`).join('');
  const pplRows = people.map(g => `<tr><td>${esc(g.key.user)}</td><td>${esc(g.key.team)}</td><td class="num">${n0(g.alloc / H)}</td><td class="num">${money(g.cost)}</td><td class="num">${pct(g.useful / g.alloc)}</td><td class="num">${pct(g.idle / g.alloc)}</td><td class="num">${pct(g.lost / g.alloc)}</td><td class="num">${money(g.wasted)}</td></tr>`).join('');
  const unal = L.unallocated.map(u => `<li>${esc(u.cluster ? u.cluster + ' ' : '')}${esc(u.gpuType)}: ${pct(u.share)} unallocated (${n0(u.unallocated / H)} GPU-h${u.cost != null ? `, ${money(u.cost)}` : ''})</li>`).join('');
  const c = L.coverage, d0 = new Date(L.from * 1000).toISOString().slice(0, 10), d1 = new Date(L.to * 1000).toISOString().slice(0, 10);
  const bud = budgets.map(b => `<li>${b.over ? '<b>Over</b> · ' : ''}${esc(b.key)}: ${money(b.perMonth)} a month against ${money(b.budget)} (${pct(b.share)})</li>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f3f2ef;--text-primary:#0b0b0b;--text-secondary:#52514e;--grid:#e4e3df;--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#34342f;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#34342f;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70}
body{margin:0}.viz-root{background:var(--surface-1);color:var(--text-primary);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px;min-height:100vh;box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}.muted{color:var(--text-secondary);font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}.tile{background:var(--surface-2);border-radius:10px;padding:12px 14px}.tile .k{color:var(--text-secondary);font-size:12px}.tile .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:16px;margin:6px 0 10px;color:var(--text-secondary);font-size:12.5px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.row{display:grid;grid-template-columns:200px 1fr 290px;gap:10px;align-items:center;padding:3px 0;border-radius:6px}.row:hover,.row:focus{background:var(--surface-2);outline:none}
.lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.val{color:var(--text-secondary);font-size:12.5px;font-variant-numeric:tabular-nums}
.track{display:flex;gap:2px;height:14px}.seg{display:block;height:100%}.seg:first-child{border-radius:4px 0 0 4px}.seg:last-child{border-radius:0 4px 4px 0}.s1{background:var(--series-1)}.s2{background:var(--series-2)}.s3{background:var(--series-3)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--grid);vertical-align:top}th{color:var(--text-secondary);font-weight:500;font-size:12.5px}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
ul{margin:6px 0;padding-left:18px}
</style></head><body><div class="viz-root">
<h1>${esc(title)}</h1><div class="muted">${d0} → ${d1} · ${L.days.toFixed(1)} days · ${esc(L.currency)}</div>
<div class="tiles">
<div class="tile"><div class="k">GPU-hours allocated</div><div class="v">${n0(t.alloc / H)}</div></div>
<div class="tile"><div class="k">Cost</div><div class="v">${money(t.cost)}</div></div>
<div class="tile"><div class="k">Useful</div><div class="v">${pct(t.useful / t.alloc)}</div><div class="muted">idle ${pct(t.idle / t.alloc)} · lost ${pct(t.lost / t.alloc)}</div></div>
<div class="tile"><div class="k">Not buying work</div><div class="v">${money(t.wasted)}</div></div>
<div class="tile"><div class="k">Largest saving, per month</div><div class="v">${ins.length ? money(Math.max(0, ...ins.map(i => i.savings.usdMonth || 0))) : '–'}</div><div class="muted">${ins.length} insight(s); they overlap, so don't add them up</div></div>
</div>
<h2>Where the GPU-hours went, by ${esc(by.join(' and '))}</h2>
<div class="legend"><span><i class="s1"></i>Useful</span><span><i class="s2"></i>Idle (allocated, not working)</span><span><i class="s3"></i>Lost to failures</span></div>
${bars}
${unal ? `<h2>Capacity nobody allocated</h2><ul>${unal}</ul>` : ''}
${bud ? `<h2>Budgets</h2><ul>${bud}</ul>` : ''}
<h2>Where to save</h2>
<table><thead><tr><th class="num">Per month</th><th>Finding and change</th><th>Owner</th><th>Basis</th></tr></thead><tbody>${insRows || '<tr><td colspan="4" class="muted">Nothing above the thresholds.</td></tr>'}</tbody></table>
<h2>People with the most cost not buying work</h2>
<table><thead><tr><th>Person</th><th>Team</th><th class="num">GPU-h</th><th class="num">Cost</th><th class="num">Useful</th><th class="num">Idle</th><th class="num">Lost</th><th class="num">Not buying work</th></tr></thead><tbody>${pplRows}</tbody></table>
<h2>Coverage</h2>
<div class="muted">Team or org known for ${pct(c.attributedOrg)} of GPU-hours, the person for ${pct(c.attributedUser)}; utilization measured for ${pct(c.utilization)} (idle time is invisible without it, so "useful" is an upper bound there); priced ${pct(c.priced)}. Lost work is an estimate: ${esc(Object.keys(L.lostBases).join('; ') || 'none')}. Savings overlap and don't add up exactly.</div>
</div></body></html>`;
}
