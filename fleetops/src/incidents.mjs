// Incidents as a workflow: lifecycle, paging, timeline, postmortem, and the confirmed cause fed back as a label.
//
// The lifecycle is an append-only log of incident_event records ({ id, event, by, … }); an incident's state is the
// fold of its events. Diagnoses stay `incident` records (rca), joined by id.
//   open → acknowledged → mitigated → resolved   (resolved can reopen; assign, severity, note at any time)
// Resolving with --cause (a rule id) and optional --component stores the confirmed cause: `rca bench --from-incidents`
// scores root-cause analysis on it, and the postmortem cites it.
// Paging (PagerDuty Events v2, Opsgenie Alerts, or a JSON webhook) is a dry run unless --live: nothing is sent otherwise.

import { checkEgress } from './security.mjs';

export const STATES = ['open', 'acknowledged', 'mitigated', 'resolved'];
const NEXT = { open: ['acknowledged', 'mitigated', 'resolved'], acknowledged: ['mitigated', 'resolved'], mitigated: ['resolved', 'acknowledged'], resolved: ['open'] };
const EVENT_STATE = { opened: 'open', acknowledged: 'acknowledged', mitigated: 'mitigated', resolved: 'resolved', reopened: 'open' };
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// sev1 (worst) … sev4, from the symptom's size.
export function severityOf(inc) {
  const i = inc.incident || inc;
  if (i.symptom === 'job-failures') return i.failures >= 500 ? 'sev1' : i.failures >= 100 ? 'sev2' : 'sev3';
  if (i.symptom === 'latency') { const r = i.peak / (i.limit || i.baseline || i.peak); return r >= 3 ? 'sev1' : r >= 1.5 ? 'sev2' : 'sev3'; }
  if (i.symptom === 'training-hang') return 'sev2';
  return 'sev3';
}

// Current state of one incident (or all): events folded, latest diagnosis attached.
export function state(store, id) {
  const evs = store.query('incident_event', { where: e => !id || e.id === id });
  const diags = new Map(store.query('incident', { where: d => !id || d.id === id }).map(d => [d.id, d]));
  const out = new Map();
  for (const e of evs) {
    let s = out.get(e.id);
    if (!s) out.set(e.id, (s = { id: e.id, status: null, severity: null, owner: null, openedAt: null, events: [] }));
    s.events.push(e);
    if (EVENT_STATE[e.event]) { s.status = EVENT_STATE[e.event]; s[`${s.status}At`] = e.t; }
    if (e.event === 'opened') { s.openedAt = e.t; s.incident = e.incident; }
    if (e.severity) s.severity = e.severity;
    if (e.owner) s.owner = e.owner;
    if (e.event === 'resolved' && e.cause) Object.assign(s, { cause: e.cause, component: e.component || null });
    if (e.event === 'reopened') { delete s.cause; delete s.component; }
  }
  for (const s of out.values()) s.diagnosis = diags.get(s.id) || null;
  return id ? out.get(id) || null : [...out.values()].sort((a, b) => b.openedAt - a.openedAt);
}

// Open an incident for a diagnosis (once per id).
export function open(store, diag, { by = 'fleetops', severity, now = Date.now() / 1000 } = {}) {
  if (state(store, diag.id)) return null;
  const inc = diag.incident || diag;
  const e = { t: now, id: diag.id, event: 'opened', by, severity: severity || severityOf(inc), incident: { symptom: inc.symptom, from: inc.from, to: inc.to, pool: inc.pool, job: inc.job, nodes: inc.nodes, metric: inc.metric, failures: inc.failures, peak: inc.peak },
    summary: diag.hypotheses && diag.hypotheses[0] ? `${inc.symptom}: ${diag.hypotheses[0].title}` : inc.symptom, source: 'fleetops-incidents' };
  store.append('incident_event', [e]);
  if (store.flush) store.flush();
  return e;
}

// acknowledge | mitigate | resolve | reopen | assign | severity | note
export function transition(store, id, action, { by, note, owner, severity, cause, component, now = Date.now() / 1000 } = {}) {
  const s = state(store, id);
  if (!s) throw new Error(`no incident ${id}`);
  if (!by) throw new Error('--by NAME: who is doing this');
  const event = { acknowledge: 'acknowledged', mitigate: 'mitigated', resolve: 'resolved', reopen: 'reopened', assign: 'assigned', severity: 'severity', note: 'note' }[action];
  if (!event) throw new Error(`unknown action ${action}`);
  const to = EVENT_STATE[event];
  if (to && !NEXT[s.status].includes(to)) throw new Error(`${id} is ${s.status}: can't go to ${to}`);
  if (event === 'assigned' && !owner) throw new Error('assign needs --owner');
  if (event === 'severity' && !/^sev[1-4]$/.test(severity || '')) throw new Error('severity needs --severity sev1..sev4');
  const e = { t: now, id, event, by };
  if (note) e.note = note; if (owner) e.owner = owner; if (severity) e.severity = severity;
  if (event === 'resolved' && cause) { e.cause = cause; if (component) e.component = component; }
  store.append('incident_event', [e]);
  if (store.flush) store.flush();
  return e;
}

// ---------- paging ----------
const PD_SEV = { sev1: 'critical', sev2: 'error', sev3: 'warning', sev4: 'info' }, OG_PRI = { sev1: 'P1', sev2: 'P2', sev3: 'P3', sev4: 'P4' };
export function pagePayload(provider, action, s, { key, url } = {}) {
  const top = s.diagnosis && s.diagnosis.hypotheses[0], summary = `[${s.severity}] ${s.incident ? s.incident.symptom : ''} ${s.id}${top ? `: ${top.title}` : ''}`.slice(0, 1024);
  const details = { status: s.status, owner: s.owner, confidence: s.diagnosis && s.diagnosis.confidence, narrative: s.diagnosis && s.diagnosis.narrative };
  if (provider === 'pagerduty') return { url: 'https://events.pagerduty.com/v2/enqueue', headers: { 'content-type': 'application/json' },
    body: { routing_key: key || '<PAGERDUTY_ROUTING_KEY>', event_action: { trigger: 'trigger', ack: 'acknowledge', resolve: 'resolve' }[action], dedup_key: s.id, ...(action === 'trigger' ? { payload: { summary, source: 'fleetops', severity: PD_SEV[s.severity] || 'warning', timestamp: new Date((s.openedAt || Date.now() / 1000) * 1000).toISOString(), custom_details: details } } : {}) } };
  if (provider === 'opsgenie') {
    const alias = encodeURIComponent(s.id), base = 'https://api.opsgenie.com/v2/alerts';
    return { url: action === 'trigger' ? base : `${base}/${alias}/${action === 'ack' ? 'acknowledge' : 'close'}?identifierType=alias`, headers: { 'content-type': 'application/json', authorization: `GenieKey ${key || '<OPSGENIE_API_KEY>'}` },
      body: action === 'trigger' ? { message: summary.slice(0, 130), alias: s.id, description: details.narrative || '', priority: OG_PRI[s.severity] || 'P3', details: { status: s.status, confidence: details.confidence || '' }, source: 'fleetops' } : { source: 'fleetops', note: `fleetops: ${action}` } };
  }
  if (provider === 'webhook') { if (!url) throw new Error('webhook needs --url'); return { url, headers: { 'content-type': 'application/json' }, body: { action, incident: { id: s.id, status: s.status, severity: s.severity, owner: s.owner, summary }, diagnosis: details } }; }
  throw new Error(`provider: pagerduty | opsgenie | webhook (not ${provider})`);
}
export async function page(store, id, provider, action, { live = false, key, url, by = 'fleetops', poster, now = Date.now() / 1000 } = {}) {
  const s = state(store, id);
  if (!s) throw new Error(`no incident ${id}`);
  if (!['trigger', 'ack', 'resolve'].includes(action)) throw new Error('--action trigger | ack | resolve');
  const p = pagePayload(provider, action, s, { key, url });
  if (!live) return { dryRun: true, request: p };
  if (!key && provider !== 'webhook') throw new Error(`${provider} needs a key (--key or the environment)`);
  checkEgress(p.url); // on-prem mode: only listed hosts
  const post = poster || ((u, o) => fetch(u, o).then(async r => ({ status: r.status, text: await r.text() })));
  const r = await post(p.url, { method: 'POST', headers: p.headers, body: JSON.stringify(p.body) });
  store.append('incident_event', [{ t: now, id, event: 'paged', by, provider, action, status: r.status }]);
  if (store.flush) store.flush();
  return { dryRun: false, status: r.status, ok: r.status >= 200 && r.status < 300 };
}

// ---------- the record of what happened ----------
function gather(store, s, pad = 3600) {
  const inc = s.incident || (s.diagnosis && s.diagnosis.incident) || {};
  const from = (inc.from ?? s.openedAt) - pad, to = Math.max(inc.to ?? s.openedAt, ...s.events.map(e => e.t)) + pad / 4;
  const failures = store.query('job', { from, to, where: j => j.status === 'failed' });
  const serving = inc.pool ? store.query('serving', { from, to, where: r => r.pool === inc.pool }) : [];
  return { inc, from, to, failures, serving, changes: store.query('change', { from, to }), logs: store.query('log', { from, to, where: l => l.severity === 'hard' || l.severity === 'soft' }),
    health: store.query('health', { from, to }), injections: store.query('injection', { from, to }) };
}

// A self-contained HTML timeline: the symptom, changes, log faults, health events and the lifecycle on one time axis.
export function timelineHtml(store, id) {
  const s = state(store, id);
  if (!s) throw new Error(`no incident ${id}`);
  const g = gather(store, s), W = 960, L = 150, R = 20, x = t => L + (t - g.from) / (g.to - g.from) * (W - L - R);
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const lanes = [], rowH = 46;
  let y = 0;
  const lane = (label, body) => { lanes.push(`<g transform="translate(0,${y})"><text class="lane" x="${L - 12}" y="${rowH / 2 + 4}" text-anchor="end">${esc(label)}</text><line class="grid" x1="${L}" x2="${W - R}" y1="${rowH - 0.5}" y2="${rowH - 0.5}"/>${body}</g>`); y += rowH; };
  // symptom: failures per 5-minute bin, or the latency series
  if (g.serving.length) {
    const m = (g.inc.metric || 'ttftP99'), vals = g.serving.map(r => r[m]).filter(Number.isFinite), hi = Math.max(...vals, 1e-9);
    const pts = g.serving.filter(r => Number.isFinite(r[m])).map(r => `${x(r.t).toFixed(1)},${(rowH - 6 - (r[m] / hi) * (rowH - 12)).toFixed(1)}`).join(' ');
    lane(`${g.inc.pool} ${m}`, `<polyline class="series" points="${pts}"/>${g.serving.filter(r => Number.isFinite(r[m])).map(r => `<circle class="hit" cx="${x(r.t).toFixed(1)}" cy="${(rowH - 6 - (r[m] / hi) * (rowH - 12)).toFixed(1)}" r="6"><title>${esc(iso(r.t))}  ${m} ${r[m].toFixed(3)} s</title></circle>`).join('')}`);
  } else {
    const bin = 300, c = new Map(); for (const j of g.failures) { const b = Math.floor(j.t / bin) * bin; c.set(b, (c.get(b) || 0) + 1); }
    const hi = Math.max(1, ...c.values()), bw = Math.max(2, x(g.from + bin) - x(g.from) - 2);
    lane('failed jobs / 5 min', [...c].map(([b, n]) => { const h = Math.max(2, n / hi * (rowH - 12)); return `<rect class="bar" x="${x(b).toFixed(1)}" y="${(rowH - 6 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${esc(iso(b))}  ${n} failed jobs</title></rect>`; }).join(''));
  }
  const marks = (list, cls, shape, tip) => list.map(e => { const cx = x(e.t).toFixed(1), cy = rowH / 2; return shape === 'diamond' ? `<path class="${cls(e)}" d="M${cx} ${cy - 6} l6 6 -6 6 -6 -6z"><title>${esc(tip(e))}</title></path>` : `<circle class="${cls(e)}" cx="${cx}" cy="${cy}" r="5"><title>${esc(tip(e))}</title></circle>`; }).join('');
  lane('changes', marks(g.changes, () => 'change', 'diamond', e => `${iso(e.t)}  ${e.kind} on ${e.target}: ${e.summary || e.id || ''}`));
  lane('log faults', marks(g.logs, e => (e.severity === 'hard' ? 'hard' : 'soft'), 'circle', e => `${iso(e.t)}  ${e.severity === 'hard' ? '▲ hard' : '● soft'}  ${e.node}${e.gpu != null ? '/' + e.gpu : ''} ${e.code}: ${e.msg || ''}`));
  if (g.health.length) lane('device health', marks(g.health, e => (['quarantined', 'rma'].includes(e.to) ? 'hard' : 'soft'), 'circle', e => `${iso(e.t)}  ${e.key}: ${e.from || ''} → ${e.to} (${e.why || ''})`));
  if (g.injections.length) lane('injected faults', g.injections.map(i => `<rect class="inject" x="${x(i.from).toFixed(1)}" y="12" width="${Math.max(3, x(i.to ?? i.from + (i.forS || 300)) - x(i.from)).toFixed(1)}" height="${rowH - 24}" rx="3"><title>${esc(`${iso(i.from)}  injected ${i.fault} on ${(i.nodes || []).join(', ')}`)}</title></rect>`).join(''));
  lane('lifecycle', s.events.filter(e => e.event !== 'note').map(e => `<line class="life" x1="${x(e.t).toFixed(1)}" x2="${x(e.t).toFixed(1)}" y1="6" y2="${rowH - 6}"/><text class="lifel" x="${(x(e.t) + 4).toFixed(1)}" y="16">${esc(e.event)}</text><rect class="hitr" x="${(x(e.t) - 6).toFixed(1)}" y="0" width="12" height="${rowH}"><title>${esc(`${iso(e.t)}  ${e.event} by ${e.by}${e.note ? `: ${e.note}` : ''}${e.cause ? ` (cause ${e.cause}${e.component ? `, ${e.component}` : ''})` : ''}`)}</title></rect>`).join(''));
  const win = g.inc.from != null ? `<rect class="window" x="${x(g.inc.from).toFixed(1)}" y="0" width="${Math.max(2, x(g.inc.to ?? g.inc.from) - x(g.inc.from)).toFixed(1)}" height="${y}"/>` : '';
  const ticks = Array.from({ length: 7 }, (_, i) => g.from + i * (g.to - g.from) / 6).map(t => `<text class="tick" x="${x(t).toFixed(1)}" y="${y + 16}" text-anchor="middle">${iso(t).slice(11, 16)}</text>`).join('');
  const hyps = s.diagnosis ? s.diagnosis.hypotheses.slice(0, 3).map((h, i) => `<li><b>${i + 1}. ${esc(h.title)}</b> <span class="muted">(${esc(h.rule)}, ${h.score.toFixed(2)})</span><ul>${h.evidence.map(e => `<li>${esc(e.what)}</li>`).join('')}</ul></li>`).join('') : '<li class="muted">No diagnosis stored for this incident.</li>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(id)}</title><style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--series-1:#2a78d6;--critical:#d03b3b;--warning:#fab219;--border:rgba(11,11,11,.10)}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--series-1:#3987e5;--border:rgba(255,255,255,.10)}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--series-1:#3987e5;--border:rgba(255,255,255,.10)}
body{margin:0;background:var(--page)}.viz-root{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text-primary);background:var(--page);padding:24px;max-width:1000px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0}
svg text{fill:var(--text-secondary);font-size:12px}.lane{fill:var(--text-primary)}.tick{fill:var(--muted)}.grid{stroke:var(--grid)}.series{fill:none;stroke:var(--series-1);stroke-width:2}
.bar{fill:var(--series-1)}.change{fill:var(--text-secondary)}.hard{fill:var(--critical);stroke:var(--surface-1);stroke-width:2}.soft{fill:var(--warning);stroke:var(--surface-1);stroke-width:2}
.inject{fill:none;stroke:var(--text-secondary);stroke-dasharray:4 3}.life{stroke:var(--text-primary);stroke-width:1.5}.lifel{fill:var(--text-primary);font-size:11px}.window{fill:var(--series-1);opacity:.07}
.hit,.hitr{fill:transparent}.hit:hover,.bar:hover,.hard:hover,.soft:hover,.change:hover{opacity:.75}.legend span{margin-right:16px}.k{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:-1px;margin-right:4px}
ul{margin:4px 0 8px 18px;padding:0}li{margin:2px 0}</style></head><body><div class="viz-root">
<h1>${esc(id)}</h1><div class="muted">${esc(s.severity)} · ${esc(s.status)}${s.owner ? ` · owner ${esc(s.owner)}` : ''} · opened ${esc(iso(s.openedAt))}${s.cause ? ` · confirmed cause: ${esc(s.cause)}${s.component ? ` (${esc(s.component)})` : ''}` : ''}</div>
<div class="card"><svg viewBox="0 0 ${W} ${y + 24}" width="100%" role="img" aria-label="Incident timeline">${win}${lanes.join('')}<line stroke="var(--axis)" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>${ticks}</svg>
<div class="legend muted"><span><i class="k" style="background:var(--critical)"></i>▲ hard fault</span><span><i class="k" style="background:var(--warning)"></i>● soft fault</span><span>◆ change</span><span>shaded: incident window (UTC)</span></div></div>
<div class="card"><b>Ranked causes</b><ol style="list-style:none;margin:8px 0 0;padding:0">${hyps}</ol></div>
<div class="card"><b>Lifecycle</b><ul>${s.events.map(e => `<li>${esc(iso(e.t))} — ${esc(e.event)} by ${esc(e.by)}${e.note ? `: ${esc(e.note)}` : ''}${e.provider ? ` (${esc(e.provider)} ${esc(e.action)}, HTTP ${esc(e.status)})` : ''}</li>`).join('')}</ul></div>
</div></body></html>`;
}

// A postmortem draft in Markdown. Facts come from the store; sections people must write are marked _To write._
export function postmortem(store, id) {
  const s = state(store, id);
  if (!s) throw new Error(`no incident ${id}`);
  const g = gather(store, s, 0), d = s.diagnosis, top = d && d.hypotheses[0];
  const dur = (s.resolvedAt || s.mitigatedAt || g.inc.to) - (g.inc.from ?? s.openedAt);
  const lostGpuH = g.failures.reduce((t, j) => t + (j.start != null ? Math.max(0, (j.end ?? j.t) - j.start) / 3600 * (j.gpus || (j.devices || []).length || 1) : 0), 0);
  const tl = [...(g.inc.from != null ? [{ t: g.inc.from, what: `onset (${g.inc.symptom})` }] : []), ...g.changes.map(c => ({ t: c.t, what: `${c.kind} on ${c.target}: ${c.summary || c.id || ''}` })), ...g.logs.filter(l => l.severity === 'hard').slice(0, 10).map(l => ({ t: l.t, what: `${l.node}${l.gpu != null ? '/' + l.gpu : ''} logged ${l.code}` })), ...s.events.map(e => ({ t: e.t, what: `${e.event} by ${e.by}${e.note ? `: ${e.note}` : ''}` }))].sort((a, b) => a.t - b.t);
  const cause = s.cause ? `**Confirmed:** ${s.cause}${s.component ? ` (${s.component})` : ''}.${top && top.rule === s.cause ? ` Root-cause analysis ranked it first: ${top.title}.` : top ? ` Root-cause analysis ranked ${top.rule} first (${top.title}), and the confirmed cause ${d.hypotheses.findIndex(h => h.rule === s.cause) >= 0 ? `ranked #${d.hypotheses.findIndex(h => h.rule === s.cause) + 1}` : 'was not among its hypotheses'}.` : ''}`
    : top ? `**Not confirmed yet.** Most likely, per root-cause analysis (${d.confidence} confidence): ${top.title}.` : '_To write._';
  return [`# Postmortem: ${id}`, '', `| | |`, `|---|---|`, `| Severity | ${s.severity} |`, `| Status | ${s.status} |`, `| Owner | ${s.owner || '_unassigned_'} |`,
    `| Window | ${g.inc.from != null ? `${iso(g.inc.from)} – ${iso(g.inc.to)}` : '–'} |`, `| Duration to ${s.resolvedAt ? 'resolution' : s.mitigatedAt ? 'mitigation' : 'end of window'} | ${Number.isFinite(dur) ? `${Math.round(dur / 60)} min` : '–'} |`,
    `| Impact | ${g.failures.length ? `${g.failures.length} failed jobs, ${lostGpuH.toFixed(1)} GPU-hours` : g.serving.length ? `${g.inc.metric || 'latency'} peak ${(g.inc.peak ?? median(g.serving.map(r => r.ttftP99))).toFixed(3)} s on ${g.inc.pool}` : '–'} |`, '',
    '## Summary', '', '_To write: two or three sentences for someone who wasn\'t there._', '',
    '## Cause', '', cause, '', ...(top ? ['Evidence:', ...top.evidence.map(e => `- ${e.what}`), ''] : []),
    ...(d && d.hypotheses.length > 1 ? ['Other hypotheses considered:', ...d.hypotheses.slice(1, 4).map(h => `- ${h.title} (${h.rule}, ${h.score.toFixed(2)})`), ''] : []),
    '## Timeline (UTC)', '', ...tl.map(e => `- ${iso(e.t)}: ${e.what}`), '',
    '## What went well', '', '_To write._', '', '## What went wrong', '', '_To write._', '',
    '## Action items', '', ...(top ? top.verify.map(v => `- [ ] ${v}`) : []), '- [ ] _To write: prevention._', '',
    `_Drafted by fleetops from the store at ${iso(Date.now() / 1000)}. Facts above are from records; sections marked "To write" need a person._`, ''].join('\n');
}

// Resolved incidents with a confirmed cause, as labels for the benchmark (rca bench --from-incidents).
export function labelsFromIncidents(store) {
  return state(store).filter(s => s.status === 'resolved' && s.cause && s.incident).map(s => ({ incident: Object.assign({ id: s.id }, s.incident), cause: s.cause, component: s.component || undefined }));
}
