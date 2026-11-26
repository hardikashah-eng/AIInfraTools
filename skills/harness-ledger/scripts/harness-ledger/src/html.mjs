// One self-contained HTML page: the funnel from tokens to avoidable dollars, causes, harnesses, tools, sessions, and
// GPU replicas when the engine's trace was joined. Same palette and layout as gpu-ledger's page.
import { CAUSES, fmtN, pct, moneyFor } from './ledger.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = t => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '–');

export function html(r, { title = 'Harness ledger: where agents waste model resources' } = {}) {
  const t = r.totals, fmt$ = moneyFor(r);
  const fmax = Math.max(1, ...r.funnel.map(f => f.tokens));
  const funnel = r.funnel.map((f, i) => {
    const avoid = /Avoidable/.test(f.stage);
    return `<div class="row" tabindex="0" title="${esc(`${f.stage}: ${f.tokens.toLocaleString('en-US')} tokens`)}"><div class="lab">${esc(f.stage)}</div><div class="track"><span class="seg ${avoid ? 's2' : 's1'}" style="width:${(100 * f.tokens / fmax).toFixed(2)}%"></span></div><div class="val">${fmtN(f.tokens)} tokens${i ? ` · ${pct(f.tokens / fmax)}` : ''}</div></div>`;
  }).join('');
  const real = r.byCause.filter(c => !c.candidate), cmax = Math.max(1e-12, ...real.map(c => c.cost));
  const causes = real.map(c => `<div class="row" tabindex="0" title="${esc(`${c.label}: ${fmt$(c.cost)}, ${c.fullPrice.toLocaleString('en-US')} tokens at full price, ${Math.round(c.tokens - c.fullPrice).toLocaleString('en-US')} re-read from cache, ${c.findings} findings in ${c.sessions} sessions`)}"><div class="lab">${esc(c.label)}</div><div class="track"><span class="seg s2" style="width:${(100 * c.cost / cmax).toFixed(2)}%"></span></div><div class="val">${fmt$(c.cost)} · ${fmtN(c.fullPrice)} full-price · ${c.findings}×</div></div>`).join('');
  const fixes = r.byCause.filter(c => c.cost > 0 || c.tokens > 0).map(c => `<tr><td><b>${esc(c.label)}</b></td><td class="num">${fmt$(c.cost)}</td><td>${esc(c.fix)}</td></tr>`).join('');
  const hmax = Math.max(1e-12, ...r.byHarness.map(h => h.cost || 0));
  const harness = r.byHarness.map(h => {
    const need = Math.max(0, (h.cost || 0) - h.avoidableCost);
    return `<div class="row" tabindex="0" title="${esc(`${h.harness}: ${fmt$(h.cost)} over ${h.sessions} sessions, ${fmt$(h.avoidableCost)} avoidable; cache hit ${pct(h.cacheHit)}; models ${h.models.join(', ')}`)}"><div class="lab">${esc(h.harness)}</div><div class="track"><span class="seg s1" style="width:${(100 * need / hmax).toFixed(2)}%"></span><span class="seg s2" style="width:${(100 * h.avoidableCost / hmax).toFixed(2)}%"></span></div><div class="val">${fmt$(h.cost)} · avoidable ${fmt$(h.avoidableCost)} · cache hit ${pct(h.cacheHit)}${h.costPerSuccess != null ? ` · ${fmt$(h.costPerSuccess)}/success` : ''}</div></div>`;
  }).join('');
  const tools = r.byTool.map(x => `<tr><td>${esc(x.tool)}</td><td>${esc(CAUSES[x.cause] || x.cause)}</td><td class="num">${x.count}</td><td class="num">${fmtN(x.tokens)}</td><td class="num">${fmt$(x.cost)}</td></tr>`).join('');
  const sess = r.sessions.slice(0, 15).map(s => `<tr><td>${esc(s.harness)}</td><td title="${esc(s.session)}">${esc(String(s.session).slice(0, 28))}${s.agent && s.agent !== 'main' ? ` <span class="muted">${esc(s.agent)}</span>` : ''}</td><td>${day(s.from)}</td><td class="num">${s.calls}</td><td class="num">${fmt$(s.cost)}</td><td class="num">${fmt$(s.avoidableCost)}</td><td>${esc(CAUSES[s.topCause] || '–')}</td><td>${esc(s.outcome)}</td></tr>`).join('');
  const top = r.top.slice(0, 15).map(f => `<tr><td class="num">${fmt$(f.cost)}</td><td>${esc(f.label)}</td><td>${esc(f.harness)} · ${esc(String(f.session).slice(0, 20))}</td><td>${esc(f.note)}</td></tr>`).join('');
  const models = r.byModel.slice(0, 12).map(m => `<tr><td>${esc(m.model)}</td><td class="num">${m.calls}</td><td class="num">${fmtN(m.tokens)}</td><td class="num">${m.cost == null ? 'unpriced' : fmt$(m.cost)}</td><td class="num">${pct(m.cacheHit)}</td></tr>`).join('');
  const gpu = r.gpu ? `<h2>Self-hosted: GPU time behind the calls</h2><div class="muted">${r.gpu.matched} of ${r.gpu.requests} engine requests matched to a harness call. Busy time is charged to the calls; idle time between requests is the replica's, not the harness's.</div>
<table><tr><th>Replica</th><th class="num">GPUs</th><th class="num">Requests</th><th class="num">Busy</th><th class="num">Busy cost</th><th class="num">Idle cost</th></tr>${r.gpu.replicas.map(x => `<tr><td>${esc(x.replica)}</td><td class="num">${x.gpus ?? '–'} ${esc(x.gpuType || '')}</td><td class="num">${x.requests}</td><td class="num">${pct(x.busyShare)}</td><td class="num">${fmt$(x.busyCost)}</td><td class="num">${fmt$(x.idleCost)}</td></tr>`).join('')}</table>` : '';
  const o = r.outcomes;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f3f2ef;--text-primary:#0b0b0b;--text-secondary:#52514e;--grid:#e4e3df;--series-1:#2a78d6;--series-2:#eb6834}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#34342f;--series-1:#3987e5;--series-2:#d95926}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#34342f;--series-1:#3987e5;--series-2:#d95926}
body{margin:0}.viz-root{background:var(--surface-1);color:var(--text-primary);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px;min-height:100vh;box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}.muted{color:var(--text-secondary);font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}.tile{background:var(--surface-2);border-radius:10px;padding:12px 14px}.tile .k{color:var(--text-secondary);font-size:12px}.tile .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:16px;margin:6px 0 10px;color:var(--text-secondary);font-size:12.5px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.row{display:grid;grid-template-columns:280px 1fr 330px;gap:10px;align-items:center;padding:3px 0;border-radius:6px}.row:hover,.row:focus{background:var(--surface-2);outline:none}
.lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.val{color:var(--text-secondary);font-size:12.5px;font-variant-numeric:tabular-nums}
.track{display:flex;gap:2px;height:14px}.seg{display:block;height:100%;min-width:0}.seg:first-child{border-radius:4px 0 0 4px}.seg:last-child{border-radius:0 4px 4px 0}.s1{background:var(--series-1)}.s2{background:var(--series-2)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--grid);vertical-align:top}th{color:var(--text-secondary);font-weight:500;font-size:12.5px}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
@media (max-width:760px){.row{grid-template-columns:1fr}.val{margin-bottom:6px}}
</style></head><body><div class="viz-root">
<h1>${esc(title)}</h1><div class="muted">${t.calls} model calls · ${t.sessions} sessions · ${esc(t.harnesses.join(', '))} · prices: ${esc(r.pricing ? `${r.pricing.source}${r.pricing.asOf ? ', as of ' + r.pricing.asOf : ''}` : '–')}${t.unpricedCalls ? ` · ${t.unpricedCalls} calls unpriced (${esc(t.unpricedModels.join(', '))})` : ''}</div>
<div class="tiles">
<div class="tile"><div class="k">Model cost</div><div class="v">${fmt$(t.cost)}</div></div>
<div class="tile"><div class="k">Avoidable</div><div class="v">${fmt$(t.avoidableCost)}</div><div class="muted">${pct(t.avoidableShare)} of cost</div></div>
<div class="tile"><div class="k">Input from cache</div><div class="v">${pct(t.input ? t.cacheRead / t.input : null)}</div><div class="muted">${fmtN(t.cacheRead)} of ${fmtN(t.input)}</div></div>
<div class="tile"><div class="k">Cost per successful task</div><div class="v">${o.known ? fmt$(o.costPerSuccess) : '–'}</div><div class="muted">${o.known ? `${o.successes} succeeded, ${o.failures} failed (${fmt$(o.costOnFailure)})` : 'pass --outcomes to see it'}</div></div>
</div>
<h2>From tokens to waste</h2><div class="legend"><span><i style="background:var(--series-1)"></i>processed</span><span><i style="background:var(--series-2)"></i>avoidable</span></div>${funnel}
<h2>Avoidable cost by cause</h2>${causes || '<div class="muted">Nothing found.</div>'}
<h2>By harness</h2><div class="legend"><span><i style="background:var(--series-1)"></i>needed</span><span><i style="background:var(--series-2)"></i>avoidable</span></div>${harness}
<h2>What to change</h2><table><tr><th>Cause</th><th class="num">Cost</th><th>Fix</th></tr>${fixes}</table>
${tools ? `<h2>Tools behind the waste</h2><table><tr><th>Tool</th><th>Cause</th><th class="num">Count</th><th class="num">Tokens</th><th class="num">Cost</th></tr>${tools}</table>` : ''}
<h2>Largest findings</h2><table><tr><th class="num">Cost</th><th>Cause</th><th>Where</th><th>Evidence</th></tr>${top}</table>
<h2>Sessions with the most waste</h2><table><tr><th>Harness</th><th>Session</th><th>Started (UTC)</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">Avoidable</th><th>Top cause</th><th>Outcome</th></tr>${sess}</table>
<h2>Models</h2><table><tr><th>Model</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Cache hit</th></tr>${models}</table>
${gpu}
<p class="muted">Counts, tool names and hashes only: no prompt, completion, argument or tool-output text is in this report. Tool output sizes are estimated at 4 characters per token. Method: harness-ledger/docs/METHOD.md.</p>
</div></body></html>`;
}
