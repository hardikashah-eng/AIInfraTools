// Reports: weekly (or on-demand) savings and health report in Markdown and self-contained HTML, plus per-job receipts.

const $ = v => '$' + Math.round(v || 0).toLocaleString('en-US');
const pc = v => (v == null || Number.isNaN(v) ? '–' : Math.round(v * 100) + '%');
const gb = v => (v == null ? '–' : v.toFixed(1));
const day = t => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lever = r => (['fewer-gpus', 'partition'].includes(r.lever) ? `${r.lever} → ${r.rightSize.shape}` : r.lever);
const risky = a => a.risk.filter(r => r.score >= 0.05);
const STATE_ORDER = ['rma', 'quarantined', 'remediate', 'burnin', 'ready', 'suspect', 'serving'];

function sections(a, actions) {
  const s = a.summary;
  const notServing = Object.values(a.health.gpus).filter(g => g.state !== 'serving' || g.stale).sort((x, y) => STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state));
  const open = (actions || []).filter(x => ['proposed', 'approved', 'suggested'].includes(x.status));
  return { s, notServing, open };
}

export function markdown(a, actions) {
  const { s, notServing, open } = sections(a, actions);
  const L = [];
  L.push(`# GPU health and efficiency report`, '', `${day(s.window.from)} → ${day(s.window.to)} · ${s.gpus} GPUs · ${s.allocatedGpus} allocated`, '');
  L.push(`| Potential savings | GPUs freeable | Effective utilization | Idle allocated GPU-hours | Out of service | High risk |`, `|---|---|---|---|---|---|`);
  L.push(`| **${$(s.weeklySavings)}/week** | ${s.gpusFreeable.toFixed(1)} | ${pc(s.effectiveUtil)} | ${Math.round(s.idleGpuHours)} | ${notServing.filter(g => !g.schedulable).length} GPU(s) | ${s.highRisk} |`, '');
  if (a.health.breaker) L.push(`> **Monitoring alert:** ${a.health.staleCount} of ${a.health.fleet} GPUs stopped reporting at once. States are held; check exporters before acting on GPUs.`, '');
  L.push('## Savings', '', '| Job | Class | GPUs | Use | Peak memory / GPU | Lever | Saves / week | Confidence |', '|---|---|---|---|---|---|---|---|');
  for (const r of a.recommendations) L.push(`| ${r.job} | ${r.class} | ${r.gpus} ${r.sku} | ${r.usage} (eff p50 ${pc(r.effP50)}) | ${gb(r.memPeakGB)} / ${gb(r.memTotalGB)} GB${r.memSource === 'framework' ? '' : ' *'} | ${lever(r)} | ${$(r.weekly)} | ${r.confidence} |`);
  L.push('', '\\* driver-reported memory: an upper bound, since frameworks reserve memory up front.', '');
  for (const r of a.recommendations) L.push(`- **${r.job}**: ${r.text}`);
  L.push('', '## Health', '', '| GPU | SKU | State | Why |', '|---|---|---|---|');
  for (const g of notServing) L.push(`| ${g.key} | ${g.sku} | ${g.state} | ${g.why || ''} |`);
  if (!notServing.length) L.push('| – | – | all serving | |');
  L.push('', '## Failure risk (top 5)', '', '| GPU | State | Score | Why |', '|---|---|---|---|');
  for (const r of risky(a).slice(0, 5)) L.push(`| ${r.key} | ${r.state} | ${Math.round(r.score * 100)} (${r.tier}) | ${r.why.join(', ') || '–'} |`);
  L.push('', '## Job usage', '', '| Job | Class | GPUs | Tensor p50 | SM p50 | HBM bw p50 | Effective p50 / p95 | Verdict |', '|---|---|---|---|---|---|---|---|');
  for (const u of a.jobUsage) L.push(`| ${u.job} | ${u.class} | ${u.gpus} | ${pc(u.tensorP50)} | ${pc(u.smP50)} | ${pc(u.dramP50)} | ${pc(u.effP50)} / ${pc(u.effP95)} | ${u.usageText} |`);
  if (a.fragmentation) {
    const f = a.fragmentation;
    L.push('', '## Fragmentation', '', `Free healthy GPUs: ${f.freeTotal} · largest block on one node: ${f.largestBlock} · stranded for the smallest waiting request (${f.smallestPending ?? '–'} GPUs): ${f.stranded}`);
    for (const b of f.blocked) L.push(`- ${b.job} (${b.gpus} GPUs) is blocked: ${b.note}`);
  }
  for (const p of a.partitionPlan || []) L.push(`- Partition plan (${p.sku}): ${p.gpusNeeded} GPU(s) instead of ${p.gpusNow}: ${p.layout.join(' | ')}`);
  L.push('', '## Actions', '', '| Id | Mode | Status | Reason |', '|---|---|---|---|');
  for (const x of open) L.push(`| \`${x.id}\` | ${x.mode} | ${x.status} | ${x.reason.replace(/\|/g, '/')} |`);
  if (!open.length) L.push('| – | | | no open actions |');
  L.push('', 'Approve with `gpu-health actions approve <id> --by <name>`, or on the approval page (`gpu-health serve`).');
  return L.join('\n') + '\n';
}

const CSS = `:root{--bg:#fbfaf8;--fg:#1d1d1b;--mut:#6b6a66;--line:#e4e1db;--card:#fff;--acc:#2f5d50;--warn:#b5651d;--bad:#a23b3b;--ok:#3b7a57}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--mut:#9a9893;--line:#2e2d2b;--card:#1f1f1d;--acc:#7fb8a4;--warn:#e0a060;--bad:#e07a7a;--ok:#7fc29b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:36px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.sub{color:var(--mut)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid currentColor}.rma,.quarantined,.high{color:var(--bad)}.suspect,.remediate,.medium,.burnin,.ready{color:var(--warn)}.serving,.low{color:var(--ok)}
.why{color:var(--mut);font-size:13px}.bar{height:6px;background:var(--line);border-radius:3px;min-width:60px}.bar i{display:block;height:100%;background:var(--acc);border-radius:3px}
.alert{border:1px solid var(--bad);color:var(--bad);border-radius:10px;padding:10px 14px;margin:12px 0}code{font-size:12px}`;

export function html(a, actions) {
  const { s, notServing, open } = sections(a, actions);
  const bar = v => `<div class="bar"><i style="width:${Math.round(Math.min(1, v || 0) * 100)}%"></i></div>`;
  const tile = (v, l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  const rows = (arr, f) => arr.map(f).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU health and efficiency report</title><style>${CSS}</style></head><body><main>
<h1>GPU health and efficiency report</h1><div class="sub">${day(s.window.from)} → ${day(s.window.to)} · ${s.gpus} GPUs · ${s.allocatedGpus} allocated</div>
${a.health.breaker ? `<div class="alert">${a.health.staleCount} of ${a.health.fleet} GPUs stopped reporting at once. States are held; check the exporters before acting on GPUs.</div>` : ''}
<div class="tiles">${tile($(s.weeklySavings) + '/wk', 'potential savings')}${tile(s.gpusFreeable.toFixed(1), 'GPUs freeable')}${tile(pc(s.effectiveUtil), 'effective utilization (allocated)')}${tile(Math.round(s.idleGpuHours), 'idle allocated GPU-hours')}${tile(notServing.filter(g => !g.schedulable).length, 'GPUs out of service')}${tile(s.highRisk, 'high failure risk')}</div>
<h2>Savings</h2><table><tr><th>Job</th><th>GPUs</th><th>Use</th><th>Peak memory / GPU</th><th>Lever</th><th>Saves / week</th><th>Confidence</th></tr>
${rows(a.recommendations, r => `<tr><td><b>${esc(r.job)}</b><div class="why">${esc(r.text)}</div></td><td>${r.gpus} ${esc(r.sku)}</td><td>${esc(r.usage)}<br>${bar(r.effP50)}</td><td class="n">${gb(r.memPeakGB)} / ${gb(r.memTotalGB)} GB${r.memSource === 'framework' ? '' : '*'}</td><td>${esc(lever(r))}</td><td class="n"><b>${$(r.weekly)}</b></td><td><span class="pill ${r.confidence === 'high' ? 'low' : r.confidence === 'low' ? 'high' : 'medium'}">${r.confidence}</span></td></tr>`) || '<tr><td colspan="7">Nothing to save.</td></tr>'}</table>
<p class="why">* driver-reported memory: an upper bound, since frameworks reserve memory up front.</p>
<h2>Health</h2><table><tr><th>GPU</th><th>SKU</th><th>State</th><th>Why</th></tr>${rows(notServing, g => `<tr><td>${esc(g.key)}</td><td>${esc(g.sku)}</td><td><span class="pill ${g.state}">${g.state}</span></td><td class="why">${esc(g.why)}</td></tr>`) || '<tr><td colspan="4">All GPUs serving.</td></tr>'}</table>
<h2>Failure risk</h2><table><tr><th>GPU</th><th>State</th><th>Score</th><th>Why</th></tr>${rows(risky(a).slice(0, 8), r => `<tr><td>${esc(r.key)}</td><td>${r.state}</td><td><span class="pill ${r.tier}">${Math.round(r.score * 100)}</span></td><td class="why">${esc(r.why.join(', ') || '–')}</td></tr>`) || '<tr><td colspan="4">No GPU stands out.</td></tr>'}</table>
<h2>Job usage</h2><table><tr><th>Job</th><th>Class</th><th>GPUs</th><th>Tensor</th><th>SM</th><th>HBM bw</th><th>Effective p50 / p95</th><th>Verdict</th></tr>
${rows(a.jobUsage, u => `<tr><td>${esc(u.job)}</td><td>${esc(u.class)}</td><td class="n">${u.gpus}</td><td class="n">${pc(u.tensorP50)}</td><td class="n">${pc(u.smP50)}</td><td class="n">${pc(u.dramP50)}</td><td>${pc(u.effP50)} / ${pc(u.effP95)}${bar(u.effP50)}</td><td class="why">${esc(u.usageText)}</td></tr>`)}</table>
${a.fragmentation ? `<h2>Fragmentation</h2><p>Free healthy GPUs: <b>${a.fragmentation.freeTotal}</b> · largest block on one node: <b>${a.fragmentation.largestBlock}</b> · stranded for the smallest waiting request (${a.fragmentation.smallestPending ?? '–'} GPUs): <b>${a.fragmentation.stranded}</b></p>${a.fragmentation.blocked.map(b => `<p class="why">${esc(b.job)} (${b.gpus} GPUs) is blocked: ${esc(b.note)}</p>`).join('')}` : ''}
${(a.partitionPlan || []).map(p => `<p class="why">Partition plan (${esc(p.sku)}): ${p.gpusNeeded} GPU(s) instead of ${p.gpusNow}: ${esc(p.layout.join(' | '))}</p>`).join('')}
<h2>Actions</h2><table><tr><th>Id</th><th>Mode</th><th>Status</th><th>Reason</th></tr>${rows(open, x => `<tr><td><code>${esc(x.id)}</code></td><td>${x.mode}</td><td>${x.status}</td><td class="why">${esc(x.reason)}</td></tr>`) || '<tr><td colspan="4">No open actions.</td></tr>'}</table>
<p class="why">Approve with <code>gpu-health actions approve &lt;id&gt; --by &lt;name&gt;</code>, or on the approval page (<code>gpu-health serve</code>).</p>
</main></body></html>`;
}

// One job's receipt: what it was given vs what it used.
export function receipt(a, jobId) {
  const u = a.jobUsage.find(x => x.job === jobId);
  if (!u) return `No usage data for ${jobId}.\n`;
  const r = a.recommendations.find(x => x.job === jobId);
  return [`Job ${u.job} (${u.class}, owner ${u.owner || '–'})`, `  allocated   ${u.gpus} x ${u.sku} for ${u.hours.toFixed(0)} h`,
    `  used        tensor ${pc(u.tensorP50)}, SM ${pc(u.smP50)}, HBM bandwidth ${pc(u.dramP50)} (p50); effective ${pc(u.effP50)} p50 / ${pc(u.effP95)} p95`,
    `  memory      peak ${gb(u.memPeakGB)} of ${gb(u.memTotalGB)} GB per GPU (${u.memSource})`, `  verdict     ${u.usageText}`,
    r ? `  suggestion  ${r.text}\n  saves       ${$(r.weekly)}/week (${r.confidence} confidence)` : '  suggestion  none: the allocation fits'].join('\n') + '\n';
}
