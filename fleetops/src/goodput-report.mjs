// The goodput report: Markdown for chat and tickets, and a self-contained HTML page with charts and table views.
import { CATEGORIES } from './goodput.mjs';

export const LABEL = { productive: 'Productive', 'slow-steps': 'Slow steps', 'data-stall': 'Waiting on data', checkpoint: 'Checkpoint saves', 'lost-work': 'Lost work (redone)', restart: 'Restarts', startup: 'Startup', idle: 'Idle in allocation' };
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = v => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(1)}%`);
const gh = v => (v >= 10000 ? `${(v / 1000).toFixed(0)}K` : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
const hrs = s => (s == null ? '–' : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
const day = t => new Date(t * 1000).toISOString().slice(0, 10);

export function goodputMarkdown(g) {
  const L = [`# Training goodput, ${day(g.window.from)} → ${day(g.window.to)}`, ''];
  const f = g.fleet;
  L.push(`**${pc(f.goodput)}** of ${gh(f.totalGpuHours)} GPU-hours went to kept training steps at each job's own pace. ${gh(f.badputGpuHours)} GPU-hours did not; the biggest losses: ${f.biggest.filter(b => b.gpuHours > 0).map(b => `${LABEL[b.category].toLowerCase()} ${gh(b.gpuHours)}`).join(', ')}.`, '');
  if (f.checkpointSavingsGpuHoursPerWeek > 1) L.push(`Checkpointing at the measured best interval would save about **${gh(f.checkpointSavingsGpuHoursPerWeek)} GPU-hours a week**.`, '');
  if (g.interruptions.perGpuHour) L.push(`Interruptions: ${(g.interruptions.perGpuHour * 1000).toFixed(2)} per 1,000 GPU-hours (${g.interruptions.interruptions} over the last ${Math.round((g.window.to - g.window.from) / 86400) + 7} days).`, '');
  if (f.attemptResolution) L.push(`> ${f.attemptResolution} job(s) have no step records: each attempt counts whole, as productive (finished or running) or lost (failed). That is an upper bound on goodput.`, '');
  if (f.openGpuHours > 1) L.push(`> ${gh(f.openGpuHours)} GPU-hours of allocations have no end and no step records and are left out.`, '');
  L.push('| Job | Team | GPUs | Attempts | Goodput | Biggest loss | Checkpoint advice |', '|---|---|---:|---:|---:|---|---|');
  for (const j of g.jobs.slice(0, 30)) L.push(`| ${j.job} | ${j.owner || '–'} | ${j.gpus} | ${j.attempts}${j.failures ? ` (${j.failures} failed)` : ''} | ${pc(j.goodput)} | ${LABEL[j.top]} ${gh(j.gpuHours[j.top])} GPU-h | ${j.advice ? `${j.advice.verdict}: every ${hrs(j.advice.bestIntervalS)}${j.advice.intervalS ? ` (now ${hrs(j.advice.intervalS)})` : ''}${j.advice.gpuHoursPerWeekSaved > 1 ? `, saves ${gh(j.advice.gpuHoursPerWeekSaved)} GPU-h/week` : ''}` : '–'} |`);
  if (g.owners.length > 1) { L.push('', '| Team | Jobs | GPU-hours | Goodput |', '|---|---:|---:|---:|'); for (const o of g.owners.slice(0, 20)) L.push(`| ${o.owner} | ${o.jobs} | ${gh(o.totalGpuHours)} | ${pc(o.goodput)} |`); }
  const sv = g.serving.filter(s => s.hasTargets);
  if (sv.length) { L.push('', '| Serving pool | Basis | Met the targets |', '|---|---|---:|'); for (const s of sv) L.push(`| ${s.pool} | ${s.basis === 'requests' ? `${s.requests} requests` : `${s.windows} windows`} | ${pc(s.goodput)} |`); }
  return L.join('\n') + '\n';
}

export function goodputHtml(g) {
  const f = g.fleet, jobs = g.jobs.slice(0, 20);
  const vars = (pal) => CATEGORIES.map((c, i) => `--c${i}:${pal[i]}`).join(';');
  const legend = `<div class="legend">${CATEGORIES.map((c, i) => `<span><i style="background:var(--c${i})"></i>${LABEL[c]}</span>`).join('')}</div>`;
  // where the GPU-hours went: one 100% bar per job, 2px surface gaps between segments
  const W = 720, rowH = 30, barH = 18, lab = 150, w = W - lab - 70;
  const bars = jobs.map((j, r) => {
    const y = r * rowH + 6;
    let x = lab;
    const segs = CATEGORIES.map((c, i) => {
      const v = j.gpuHours[c] / (j.totalGpuHours || 1), sw = v * w;
      if (sw < 0.5) return '';
      const tip = `<b>${esc(j.job)}</b> · ${LABEL[c]}<br>${gh(j.gpuHours[c])} GPU-hours (${pc(v)})`;
      const out = `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(0.5, sw - 2).toFixed(1)}" height="${barH}" rx="${i === CATEGORIES.length - 1 || x + sw >= lab + w - 1 ? 4 : 0}" fill="var(--c${i})" tabindex="0" data-tip="${esc(tip)}"/>`;
      x += sw; return out;
    }).join('');
    return `<text x="${lab - 8}" y="${y + 13}" text-anchor="end" class="lbl">${esc(j.job.length > 20 ? j.job.slice(0, 19) + '…' : j.job)}</text>${segs}<text x="${lab + w + 6}" y="${y + 13}" class="val">${pc(j.goodput)}</text>`;
  }).join('');
  const stack = jobs.length ? `<svg viewBox="0 0 ${W} ${jobs.length * rowH + 10}" width="100%" role="img" aria-label="GPU-hours by category per job">${bars}</svg>` : '<p class="mut">No training allocations in the window.</p>';
  const stackTable = `<details><summary>Table view</summary><table><tr><th>Job</th>${CATEGORIES.map(c => `<th class="n">${LABEL[c]}</th>`).join('')}<th class="n">GPU-hours</th></tr>${jobs.map(j => `<tr><td>${esc(j.job)}</td>${CATEGORIES.map(c => `<td class="n">${gh(j.gpuHours[c])}</td>`).join('')}<td class="n">${gh(j.totalGpuHours)}</td></tr>`).join('')}</table></details>`;
  // fleet badput by category: one series, sorted
  const bad = CATEGORIES.slice(1).map(c => ({ c, v: f.gpuHours[c] })).filter(b => b.v > 0).sort((a, b) => b.v - a.v);
  const maxB = Math.max(1, ...bad.map(b => b.v)), bw = 560;
  const badChart = bad.length ? `<svg viewBox="0 0 ${bw + 220} ${bad.length * 28 + 6}" width="100%" role="img" aria-label="GPU-hours lost by category">${bad.map((b, r) => { const len = Math.max(2, b.v / maxB * bw); return `<text x="170" y="${r * 28 + 17}" text-anchor="end" class="lbl">${LABEL[b.c]}</text><rect x="178" y="${r * 28 + 5}" width="${len.toFixed(1)}" height="18" rx="4" fill="var(--c0)" tabindex="0" data-tip="${esc(`<b>${LABEL[b.c]}</b><br>${gh(b.v)} GPU-hours, ${pc(b.v / (f.totalGpuHours || 1))} of the total`)}"/><text x="${(184 + len).toFixed(1)}" y="${r * 28 + 18}" class="val">${gh(b.v)}</text>`; }).join('')}</svg>` : '<p class="mut">No badput.</p>';
  // goodput per day: one series
  const days = g.days, DW = 720, DH = 160, L = 44, T = 10, B = 24, dw = DW - L - 12, dh = DH - T - B;
  const X = i => L + (days.length > 1 ? i / (days.length - 1) : 0.5) * dw, Y = v => T + dh - v * dh;
  const line = days.length ? `<svg viewBox="0 0 ${DW} ${DH}" width="100%" role="img" aria-label="Goodput per day">${[0, 0.5, 1].map(v => `<line x1="${L}" x2="${DW - 12}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end" class="ax">${v * 100}%</text>`).join('')}<path d="${days.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.goodput).toFixed(1)}`).join('')}" fill="none" stroke="var(--c0)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${days.map((d, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(d.goodput).toFixed(1)}" r="4" fill="var(--c0)" stroke="var(--surface)" stroke-width="2" tabindex="0" data-tip="${esc(`<b>${pc(d.goodput)}</b> goodput<br>${day(d.t)}`)}"/>`).join('')}${days.map((d, i) => (days.length <= 10 || i % Math.ceil(days.length / 8) === 0 ? `<text x="${X(i).toFixed(1)}" y="${DH - 6}" text-anchor="middle" class="ax">${day(d.t).slice(5)}</text>` : '')).join('')}</svg>` : '';
  const adv = g.jobs.filter(j => j.advice);
  const advTable = adv.length ? `<table><tr><th>Job</th><th class="n">GPUs</th><th class="n">Save cost</th><th class="n">Interruption every</th><th class="n">Now</th><th class="n">Best</th><th>Verdict</th><th class="n">Saves per week</th></tr>${adv.map(j => `<tr><td>${esc(j.job)}</td><td class="n">${j.gpus}</td><td class="n">${Math.round(j.advice.deltaS)} s</td><td class="n">${hrs(j.advice.mtbiS)}</td><td class="n">${hrs(j.advice.intervalS)}</td><td class="n">${hrs(j.advice.bestIntervalS)}</td><td>${esc(j.advice.verdict)}</td><td class="n">${j.advice.gpuHoursPerWeekSaved > 0.5 ? gh(j.advice.gpuHoursPerWeekSaved) + ' GPU-h' : '–'}</td></tr>`).join('')}</table><p class="mut small">Young/Daly: the best interval is √(2 × save cost × mean time between interruptions), with the interruption rate measured on this fleet and scaled by the job's GPUs.</p>` : '<p class="mut">No job has both checkpoint times and a measured interruption rate.</p>';
  const teams = g.owners.length ? `<table><tr><th>Team</th><th class="n">Jobs</th><th class="n">GPU-hours</th><th class="n">Goodput</th><th>Biggest loss</th></tr>${g.owners.slice(0, 20).map(o => { const top = CATEGORIES.slice(1).sort((a, b) => o.gpuHours[b] - o.gpuHours[a])[0]; return `<tr><td>${esc(o.owner)}</td><td class="n">${o.jobs}</td><td class="n">${gh(o.totalGpuHours)}</td><td class="n">${pc(o.goodput)}</td><td>${LABEL[top]} · ${gh(o.gpuHours[top])} GPU-h</td></tr>`; }).join('')}</table>` : '';
  const sv = g.serving.filter(s => s.hasTargets);
  const serving = sv.length ? `<h2>Serving: requests that met their targets</h2><div class="card"><table><tr><th>Pool</th><th>Targets</th><th>Basis</th><th class="n">Met</th></tr>${sv.map(s => `<tr><td>${esc(s.pool)}</td><td class="small">${Object.entries(s.targets).map(([k, v]) => `${k} ≤ ${v}s`).join(', ')}</td><td>${s.basis === 'requests' ? `${s.requests} requests` : `${s.windows} p99 windows`}</td><td class="n">${pc(s.goodput)}</td></tr>`).join('')}</table></div>` : '';
  const tile = (v, l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  const caveat = [f.attemptResolution ? `${f.attemptResolution} job(s) have no step records, so each attempt counts whole: productive when it finished or is running, lost when it failed. Goodput there is an upper bound.` : '', f.openGpuHours > 1 ? `${gh(f.openGpuHours)} GPU-hours of allocations have no end and no step records and are left out.` : ''].filter(Boolean);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Training goodput</title><style>
.gp{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--mut:#898781;--grid:#e1e0d9;--ring:rgba(11,11,11,.10);${vars(LIGHT)}}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .gp{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--ring:rgba(255,255,255,.10);${vars(DARK)}}}
:root[data-theme="dark"] .gp{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--ring:rgba(255,255,255,.10);${vars(DARK)}}
body.gp{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:26px 0 8px}.sub,.mut{color:var(--ink2)}.small{font-size:12px}.lede{color:var(--ink2);margin:0 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}.tile{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:10px 12px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{color:var(--ink2);font-size:12px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px}.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--ink2);margin-bottom:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
svg text{font-size:11px}svg .lbl{fill:var(--ink2)}svg .val{fill:var(--ink2);font-variant-numeric:tabular-nums}svg .ax{fill:var(--mut);font-size:10px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:5px 6px;border-top:1px solid var(--grid);font-size:13px;vertical-align:top}th{color:var(--ink2);font-weight:500;border-top:0}.n{text-align:right;font-variant-numeric:tabular-nums}
details summary{cursor:pointer;color:var(--ink2);font-size:12px;margin-top:8px}.note{border-left:3px solid var(--grid);padding:4px 10px;color:var(--ink2);font-size:13px;margin:8px 0}
.tip{position:fixed;display:none;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12);z-index:9}
</style></head><body class="gp"><main>
<h1>Training goodput</h1><div class="sub">${day(g.window.from)} → ${day(g.window.to)} · ${g.jobs.length} training job(s) · ${gh(f.totalGpuHours)} GPU-hours allocated</div>
<div class="tiles">${tile(pc(f.goodput), 'of allocated GPU-hours went to kept training steps')}${tile(gh(f.badputGpuHours), 'GPU-hours that did not')}${tile(f.biggest[0] && f.biggest[0].gpuHours > 0 ? LABEL[f.biggest[0].category] : '–', 'biggest loss')}${tile(f.checkpointSavingsGpuHoursPerWeek > 1 ? gh(f.checkpointSavingsGpuHoursPerWeek) : '–', 'GPU-hours a week from better checkpoint intervals')}${tile(g.interruptions.perGpuHour ? (g.interruptions.perGpuHour * 1000).toFixed(2) : '–', 'interruptions per 1,000 GPU-hours')}</div>
${caveat.map(c => `<div class="note">${esc(c)}</div>`).join('')}
<h2>Where the GPU-hours went</h2><p class="lede">Each job's allocation, split. Productive is kept steps at the job's own best pace; everything else is badput. The number at the end is the job's goodput.</p>
<div class="card">${legend}${stack}${stackTable}</div>
<h2>GPU-hours lost, by cause</h2><div class="card">${badChart}<details><summary>Table view</summary><table><tr><th>Cause</th><th class="n">GPU-hours</th><th class="n">Share</th></tr>${bad.map(b => `<tr><td>${LABEL[b.c]}</td><td class="n">${gh(b.v)}</td><td class="n">${pc(b.v / (f.totalGpuHours || 1))}</td></tr>`).join('')}</table></details></div>
${days.length > 1 ? `<h2>Goodput per day</h2><div class="card">${line}<details><summary>Table view</summary><table><tr><th>Day</th><th class="n">Goodput</th></tr>${days.map(d => `<tr><td>${day(d.t)}</td><td class="n">${pc(d.goodput)}</td></tr>`).join('')}</table></details></div>` : ''}
<h2>Checkpoint intervals</h2><div class="card">${advTable}</div>
${teams ? `<h2>By team</h2><div class="card">${teams}</div>` : ''}
${serving}
<div class="tip" id="tip" role="tooltip"></div></main>
<script>(function(){var tip=document.getElementById('tip');function show(el,x,y){tip.innerHTML=el.getAttribute('data-tip');tip.style.display='block';var r=tip.getBoundingClientRect();tip.style.left=Math.min(innerWidth-r.width-8,x+12)+'px';tip.style.top=Math.max(8,y-r.height-12)+'px'}function hide(){tip.style.display='none'}
document.addEventListener('pointermove',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el,e.clientX,e.clientY);else hide()});document.addEventListener('focusin',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(!el)return hide();var b=el.getBoundingClientRect();show(el,b.left+b.width/2,b.top)});document.addEventListener('focusout',hide)})();</script>
</body></html>`;
}
