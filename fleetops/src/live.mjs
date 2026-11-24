// The live dashboard of `fleetops serve`: GPU states and flakiness, open incidents and what the agent did about
// them, the actions waiting for a person, training step times and serving latency. One page, refreshed every few
// seconds from GET /api/live; approvals, rejections and pause go through POST /api/agent/… (role `approve`).
//
//   GET  /live                              the page (no data in it; the API calls carry the token)
//   GET  /api/live                          everything the page shows (role read)
//   GET  /api/flakiness[?format=html]       gpu-health's flakiness view of the agent's history (role read)
//   POST /api/agent/actions/ID/approve      approve a proposed action (role approve; the approver is the token's name)
//   POST /api/agent/actions/ID/reject       { reason }
//   POST /api/agent/pause | /api/agent/resume
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../gpu-health/src/config.mjs';
import { Store as Queue } from '../../gpu-health/src/actions.mjs';
import { flakinessFromState, flakinessDigest, flakinessHtml } from '../../gpu-health/src/flakiness.mjs';
import * as Inc from './incidents.mjs';
import { goodput } from './goodput.mjs';
import { agentState, decisions, paused, setPaused, AGENT_DEFAULTS } from './agent.mjs';
import { can } from './security.mjs';

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readJsonl = (f, n = 200) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map(l => JSON.parse(l)); } catch { return []; } };

// Median per bin of `field`, over [from, to].
function binned(recs, field, from, to, binS) {
  const bins = new Map();
  for (const r of recs) if (Number.isFinite(r[field]) && r.t > from && r.t <= to) { const b = Math.floor(r.t / binS) * binS; if (!bins.has(b)) bins.set(b, []); bins.get(b).push(r[field]); }
  return [...bins].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v: +median(v).toFixed(4) }));
}

export function liveView(store, stateDir, { now = Math.floor(Date.now() / 1000), agent = {}, ghConfig, spanS = 2 * 3600 } = {}) {
  const acfg = Object.assign({}, AGENT_DEFAULTS, agent), cfg = loadConfig(ghConfig), from = now - spanS;
  if (store.flush) store.flush();
  const st = agentState(stateDir), an = readJson(path.join(stateDir, 'analysis.json'));
  // GPUs: state per device, and the flakiness verdicts over the agent's history
  let flaky = null;
  try { if (an) flaky = flakinessDigest(flakinessFromState(stateDir, cfg, { now }), 10); } catch { flaky = null; }
  const verdict = new Map((flaky ? flaky.devices : []).map(d => [d.key, d.verdict]));
  const gpus = an ? Object.values(an.health.gpus).map(g => ({ key: g.key, node: g.node, gpu: String(g.gpu), state: g.state, why: g.why || '', vendor: g.vendor || '', sku: g.sku || '', stale: !!g.stale, verdict: verdict.get(g.key) || null }))
    .sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }) || a.gpu.localeCompare(b.gpu, undefined, { numeric: true })) : [];
  // incidents: open ones, and those resolved or mitigated in the last day
  const incidents = Inc.state(store).filter(s => s.status !== 'resolved' || now - (s.resolvedAt || 0) < 86400).slice(0, 30).map(s => {
    const top = s.diagnosis && s.diagnosis.hypotheses[0], rec = st.incidents[s.id] || {};
    return { id: s.id, status: s.status, severity: s.severity, openedAt: s.openedAt, symptom: s.incident && s.incident.symptom, pool: s.incident && s.incident.pool, job: s.incident && s.incident.job,
      cause: top ? top.rule : null, title: top ? top.title : null, confidence: s.diagnosis ? s.diagnosis.confidence : null, narrative: s.diagnosis ? s.diagnosis.narrative : null,
      decision: rec.decision || null, actions: rec.actions || [], verified: rec.verified || null, paged: rec.paged || null };
  });
  // actions: open ones first, then the latest that ran
  const q = new Queue(stateDir), all = q.list();
  const open = all.filter(a => ['proposed', 'approved', 'suggested'].includes(a.status)).sort((a, b) => (a.status === 'proposed' ? 0 : 1) - (b.status === 'proposed' ? 0 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 60);
  const ran = readJsonl(path.join(stateDir, 'audit.jsonl'), 400).filter(e => ['executed', 'failed', 'dry-run', 'skipped', 'approved', 'rejected'].includes(e.event)).slice(-40).reverse();
  const slim = a => ({ id: a.id, kind: a.kind, target: a.target, status: a.status, mode: a.mode, approvedBy: a.approvedBy, reason: a.reason, incident: a.incident, rule: a.rule, lowered: a.lowered, createdAt: a.createdAt, severity: a.severity });
  // training: median step time per job (median across ranks per step, then per 2-minute bin), against its own history
  const steps = store.query('step', { from: from - 6 * 3600, to: now });
  const training = [...new Set(steps.map(s => s.job))].map(job => {
    const js = steps.filter(s => s.job === job), base = median(js.filter(s => s.t <= from).map(s => s.durS)) ?? median(js.slice(0, Math.ceil(js.length / 3)).map(s => s.durS));
    return { job, baseline: base, series: binned(js, 'durS', from, now, 120), ranks: new Set(js.map(s => s.rank)).size, nodes: new Set(js.map(s => s.node)).size };
  }).filter(j => j.series.length).slice(0, 12);
  // inference: TTFT and TPOT p99 per pool, with targets when given
  const serving = store.query('serving', { from, to: now });
  const inference = [...new Set(serving.map(r => r.pool))].map(pool => {
    const rs = serving.filter(r => r.pool === pool), tg = acfg.targets[pool] || {};
    return { pool, ttft: binned(rs, 'ttftP99', from, now, 120), tpot: binned(rs, 'tpotP99', from, now, 120), kv: binned(rs, 'kvUsage', from, now, 120), targets: { ttftP99: tg.ttftP99 ?? null, tpotP99: tg.tpotP99 ?? null } };
  }).filter(p => p.ttft.length || p.tpot.length).slice(0, 12);
  const autoHour = (st.auto || []).filter(x => x.t > now - 3600);
  // training goodput over the last day (the full report is /api/goodput?format=html)
  let gp = null;
  try { const g = goodput(store, { from: now - 86400, to: now, now, serving: false }); if (g.fleet.totalGpuHours > 0) gp = { goodput: g.fleet.goodput, gpuHours: g.fleet.totalGpuHours, biggest: g.fleet.biggest[0] && g.fleet.biggest[0].gpuHours > 0 ? g.fleet.biggest[0].category : null, upperBound: g.fleet.attemptResolution > 0 }; } catch { gp = null; }
  return {
    now, span: { from, to: now },
    agent: { paused: paused(stateDir), pauseInfo: readJson(path.join(stateDir, 'PAUSE')), lastTick: st.lastTick || null, ticks: st.ticks || 0, live: !!(st.lastReport && st.lastReport.live), intervalS: acfg.intervalS,
      autoLastHour: autoHour.length, autoLimit: acfg.maxAutoActionsPerHour },
    fleet: { gpus, states: an ? an.summary.states : {}, breaker: !!(an && an.health.breaker), at: an ? an.generatedAt : null },
    flakiness: flaky ? { totals: flaky.totals, devices: flaky.devices.map(d => ({ key: d.key, verdict: d.verdict, exits: d.exits, bounces: d.bounces, jobFailures: d.jobFailures, next: d.next, lastWhy: d.lastWhy })), hotCohorts: flaky.hotCohorts, window: flaky.window } : null,
    incidents, actions: { open: open.map(slim), ran: ran.map(e => ({ t: e.t, id: e.id, kind: e.kind, target: e.target, event: e.event, by: e.by, commands: e.commands, why: e.why, text: e.text })) },
    decisions: decisions(stateDir, 60), training, inference, goodput: gp,
  };
}

const body = req => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { rej(new Error('body too large')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); });

// Routes for ingest.server's `extra` hook: returns true when it answered.
export function liveRoutes({ store, stateDir, agent = {}, ghConfig, audit }) {
  return async (req, res, who, send) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (req.method === 'GET' && p === '/api/live') { if (!can(who, 'read')) return send(res, 403, 'needs the read role\n'), true; send(res, 200, JSON.stringify(liveView(store, stateDir, { agent, ghConfig })), 'application/json'); return true; }
    if (req.method === 'GET' && p === '/api/flakiness') {
      if (!can(who, 'read')) return send(res, 403, 'needs the read role\n'), true;
      const f = flakinessFromState(stateDir, loadConfig(ghConfig), { days: +u.searchParams.get('days') || undefined });
      return u.searchParams.get('format') === 'html' ? send(res, 200, flakinessHtml(f), 'text/html; charset=utf-8') : send(res, 200, JSON.stringify(flakinessDigest(f)), 'application/json'), true;
    }
    const m = p.match(/^\/api\/agent\/(?:actions\/([^/]+)\/(approve|reject)|(pause|resume))$/);
    if (!m || req.method !== 'POST') return false;
    if (!can(who, 'approve')) { send(res, 403, 'needs the approve role\n'); return true; }
    const b = await body(req);
    // the approver is a person: the token's own name, or, with no tokens configured, the name they give
    const by = who.open ? String(b.by || '').trim().slice(0, 64) : who.name;
    if (!by) { send(res, 400, 'your name is required (by)\n'); return true; }
    if (audit) audit({ who: by, method: 'POST', path: p });
    try {
      if (m[3]) { setPaused(stateDir, m[3] === 'pause', by); send(res, 200, JSON.stringify({ paused: m[3] === 'pause', by }), 'application/json'); return true; }
      const q = new Queue(stateDir), id = decodeURIComponent(m[1]);
      const a = m[2] === 'approve' ? q.approve(id, by) : q.reject(id, by, String(b.reason || '').slice(0, 500));
      fs.appendFileSync(path.join(stateDir, 'agent.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), decision: m[2] === 'approve' ? 'approved' : 'rejected', action: a.id, kind: a.kind, by, incident: a.incident }) + '\n');
      send(res, 200, JSON.stringify({ id: a.id, status: a.status, by }), 'application/json');
    } catch (e) { send(res, 409, `${e.message}\n`); }
    return true;
  };
}

export const LIVE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fleetops live</title>
<style>
.lv{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--mut:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--s1:#2a78d6;--serving:#e1e0d9;--repair:#2a78d6;--wash:rgba(42,120,214,.08)}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .lv{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--s1:#3987e5;--serving:#383835;--repair:#3987e5;--wash:rgba(57,135,229,.12)}}
:root[data-theme="dark"] .lv{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--s1:#3987e5;--serving:#383835;--repair:#3987e5;--wash:rgba(57,135,229,.12)}
*{box-sizing:border-box}body.lv{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1320px;margin:0 auto;padding:20px 20px 60px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.sub{color:var(--ink2);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ring);border-radius:999px;padding:3px 10px;font-size:12px;background:var(--surface)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
button{font:inherit;font-size:12px;border:1px solid var(--ring);background:var(--surface);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer}button:hover{background:var(--wash)}
button.pri{background:var(--s1);color:#fff;border-color:transparent}button:disabled{opacity:.5;cursor:default}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:10px 12px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{color:var(--ink2);font-size:12px}
.grid2{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:14px}@media (max-width:980px){.grid2{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px;margin-bottom:14px;min-width:0}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin:0 0 8px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.nodes{display:flex;flex-wrap:wrap;gap:8px}.node{font-size:11px;color:var(--mut)}.cells{display:flex;gap:2px;margin-top:2px}
.cell{width:16px;height:16px;border-radius:3px;background:var(--serving);position:relative}.cell.flk::after{content:"";position:absolute;inset:-3px;border:2px solid var(--ink);border-radius:5px}
.inc{border-top:1px solid var(--grid);padding:10px 0}.inc:first-of-type{border-top:0;padding-top:0}.inc .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.chip{font-size:11px;border-radius:4px;padding:1px 6px;border:1px solid var(--ring);white-space:nowrap}.mut{color:var(--mut)}.small{font-size:12px}.ink2{color:var(--ink2)}
.st{font-weight:600}.sev1,.sev2{color:var(--critical)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:5px 6px;border-top:1px solid var(--grid);vertical-align:top;font-size:13px}th{color:var(--ink2);font-weight:500;border-top:0}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.acts{display:flex;gap:6px}.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.chart h3{font-size:13px;margin:0 0 2px}.chart .sub{font-size:12px}svg text{fill:var(--mut);font-size:10px}
.log{max-height:360px;overflow:auto}.log div{padding:4px 0;border-top:1px solid var(--grid);font-size:12px}.log div:first-child{border-top:0}
.tip{position:fixed;display:none;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:320px;z-index:10}
.login{max-width:420px;margin:80px auto}.login input{width:100%;font:inherit;padding:6px 8px;margin:6px 0 10px;border:1px solid var(--ring);border-radius:6px;background:var(--surface);color:var(--ink)}
.err{color:var(--critical);font-size:12px}details summary{cursor:pointer;color:var(--ink2);font-size:12px;margin-top:6px}
</style></head><body class="lv"><main id="app"></main><div class="tip" id="tip" role="tooltip"></div>
<script>
(function(){
var app=document.getElementById('app'),tip=document.getElementById('tip'),TOKEN=sessionStorage.getItem('fo_token')||'',NAME=sessionStorage.getItem('fo_name')||'',data=null,err='',timer=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ago(t){if(!t)return'never';var s=Math.round(Date.now()/1000-t);return s<60?s+' s ago':s<3600?Math.round(s/60)+' min ago':Math.round(s/3600)+' h ago'}
function hm(t){var d=new Date(t*1000);return d.toISOString().slice(11,16)+' UTC'}
var STATE={serving:['var(--serving)','Serving'],suspect:['var(--warning)','Suspect'],quarantined:['var(--critical)','Quarantined'],rma:['var(--critical)','RMA'],remediate:['var(--serious)','In repair'],diagnose:['var(--serious)','In repair'],burnin:['var(--repair)','Burn-in'],ready:['var(--repair)','Ready to release']};
var DEC={mitigate:['var(--s1)','mitigating'],contain:['var(--warning)','containing'],escalate:['var(--critical)','needs a person'],frozen:['var(--critical)','frozen: monitoring gap'],paused:['var(--mut)','paused']};
function api(p,opt){opt=opt||{};opt.headers=Object.assign({authorization:'Bearer '+TOKEN},opt.headers||{});return fetch(p,opt).then(function(r){if(r.status===401){TOKEN='';sessionStorage.removeItem('fo_token');throw new Error('token refused')}if(!r.ok)return r.text().then(function(t){throw new Error(t.trim()||('HTTP '+r.status))});var ct=r.headers.get('content-type')||'';return ct.indexOf('json')>=0?r.json():r.text()})}
function load(){api('/api/live').then(function(d){data=d;err='';render()}).catch(function(e){err=e.message;render()})}
function post(p,b){return api(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({by:NAME},b||{}))}).then(load).catch(function(e){err=e.message;render()})}
window.fo={approve:function(id){post('/api/agent/actions/'+encodeURIComponent(id)+'/approve')},reject:function(id){var r=prompt('Why reject '+id+'?');if(r!==null)post('/api/agent/actions/'+encodeURIComponent(id)+'/reject',{reason:r})},
pause:function(on){post('/api/agent/'+(on?'pause':'resume'))},login:function(){TOKEN=document.getElementById('tok').value.trim();NAME=document.getElementById('nm').value.trim();sessionStorage.setItem('fo_token',TOKEN);sessionStorage.setItem('fo_name',NAME);start()},
open:function(p){api(p).then(function(h){var w=window.open('','_blank');w.document.write(h);w.document.close()}).catch(function(e){alert(e.message)})}};
function login(){app.innerHTML='<div class="login card"><h1>fleetops live</h1><p class="sub">A token with the read role shows the dashboard; approving actions needs the approve role. The token stays in this tab only.</p><label class="small">Token<input id="tok" type="password" autocomplete="off"></label><label class="small">Your name (only when the server runs without tokens)<input id="nm" value="'+esc(NAME)+'"></label><button class="pri" onclick="fo.login()">Open</button>'+(err?'<p class="err">'+esc(err)+'</p>':'')+'</div>'}
// ---------- charts: one series, a reference line, crosshair tooltip ----------
function nice(v){var e=Math.pow(10,Math.floor(Math.log10(v))),m=v/e;return(m<=1?1:m<=2?2:m<=2.5?2.5:m<=5?5:10)*e}
function line(series,o){var W=300,H=120,L=46,R=8,T=8,B=20,w=W-L-R,h=H-T-B;if(!series.length)return'<div class="mut small">no data in the last 2 h</div>';
var t0=data.span.from,t1=data.span.to,vals=series.map(function(p){return p.v});if(o.ref!=null)vals.push(o.ref);var lo=0,hi=nice(Math.max.apply(null,vals)*1.1||1);
function X(t){return L+(t-t0)/(t1-t0)*w}function Y(v){return T+h-(v-lo)/(hi-lo)*h}
var ticks=[0,hi/2,hi].map(function(v){return'<line x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(v)+'" y2="'+Y(v)+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(L-4)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+fmt(v,o.unit)+'</text>'}).join('');
var xt=[t0,(t0+t1)/2,t1].map(function(t,i){return'<text x="'+X(t)+'" y="'+(H-5)+'" text-anchor="'+(i===0?'start':i===2?'end':'middle')+'">'+hm(t)+'</text>'}).join('');
var d=series.map(function(p,i){return(i?'L':'M')+X(p.t).toFixed(1)+','+Y(p.v).toFixed(1)}).join('');
var ref=o.ref!=null?'<line x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(o.ref)+'" y2="'+Y(o.ref)+'" stroke="var(--ink2)" stroke-width="1" stroke-dasharray="4 3"/><text x="'+(W-R)+'" y="'+(Y(o.ref)-3)+'" text-anchor="end">'+esc(o.refLabel)+'</text>':'';
var pts=esc(JSON.stringify(series.map(function(p){return[X(p.t),Y(p.v),p.t,p.v]})));
return'<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="'+esc(o.label)+'" data-pts="'+pts+'" data-unit="'+esc(o.unit)+'" data-name="'+esc(o.label)+'" data-ref="'+(o.ref==null?'':o.ref)+'"><line x1="'+L+'" x2="'+(W-R)+'" y1="'+(T+h)+'" y2="'+(T+h)+'" stroke="var(--axis)"/>'+ticks+xt+ref+'<path d="'+d+'" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/><line class="xh" y1="'+T+'" y2="'+(T+h)+'" stroke="var(--axis)" stroke-width="1" style="display:none"/><circle class="xp" r="4" fill="var(--s1)" stroke="var(--surface)" stroke-width="2" style="display:none"/></svg>'}
function fmt(v,u){if(v==null)return'–';if(u==='s')return v>=10?v.toFixed(0)+' s':v>=1?(+v.toFixed(2))+' s':(+(v*1000).toPrecision(3))+' ms';if(u==='%')return Math.round(v*100)+'%';return String(+v.toFixed(3))}
// ---------- page ----------
function render(){if(!TOKEN)return login();if(!data){app.innerHTML='<p class="sub">Loading…</p>'+(err?'<p class="err">'+esc(err)+'</p>':'');return}
var d=data,a=d.agent,g=d.fleet.gpus,out=g.filter(function(x){return x.state!=='serving'}).length,opened=d.incidents.filter(function(i){return i.status!=='resolved'}),waiting=d.actions.open.filter(function(x){return x.status==='proposed'});
var stale=a.lastTick&&Date.now()/1000-a.lastTick>Math.max(120,a.intervalS*4);
var status=a.paused?['var(--mut)','paused by '+esc((a.pauseInfo||{}).by||'someone')]:stale||!a.lastTick?['var(--critical)','not running']:a.live?['var(--good)','live: acting']:['var(--warning)','dry run: proposing only'];
var h='<div class="top"><h1>fleetops live</h1><span class="pill"><span class="dot" style="background:'+status[0]+'"></span>Agent '+status[1]+'</span><span class="sub">last check '+ago(a.lastTick)+' · refreshes every 5 s</span><span style="flex:1"></span>'
+(a.paused?'<button onclick="fo.pause(false)">Resume agent</button>':'<button onclick="fo.pause(true)">Pause agent</button>')+'<button onclick="fo.open(\\'/api/flakiness?format=html\\')">Flakiness report</button><button onclick="fo.open(\\'/api/goodput?format=html\\')">Goodput report</button></div>'+(err?'<p class="err">'+esc(err)+'</p>':'');
if(d.fleet.breaker)h+='<div class="card" style="border-color:var(--critical)"><b>⚠ Monitoring gap.</b> Many GPUs stopped reporting at once; the agent is frozen and takes no device actions until telemetry is back.</div>';
var fk=d.flakiness?d.flakiness.totals:null;
h+='<div class="tiles">'+tile(g.length?(g.length-out)+' / '+g.length:'–','GPUs serving')+tile(opened.length,'open incidents')+tile(waiting.length,'actions waiting for approval')+tile(a.autoLastHour+' / '+a.autoLimit,'autonomous actions in the last hour')+tile(fk?fk.flaky+fk.rmaCandidates:'–','flaky GPUs'+(fk?' · '+fk.rmaCandidates+' RMA candidate(s)':''))+tile(d.goodput?Math.round(d.goodput.goodput*100)+'%'+(d.goodput.upperBound?' (at most)':''):'–','training goodput, last 24 h'+(d.goodput&&d.goodput.biggest?' · most lost to '+d.goodput.biggest:''))+'</div>';
h+='<div class="grid2"><div>';
// incidents
h+='<div class="card"><h2>Incidents</h2>'+(d.incidents.length?d.incidents.map(incident).join(''):'<p class="mut small">No incidents in the last day.</p>')+'</div>';
// approvals
h+='<div class="card"><h2>Waiting for approval</h2>'+(waiting.length?'<table><tr><th>Action</th><th>Why</th><th></th></tr>'+waiting.map(function(x){return'<tr><td><b>'+esc(x.kind)+'</b><div class="mut small">'+esc(x.target)+'</div></td><td class="small">'+esc(x.reason)+(x.lowered?'<div class="mut small">'+esc(x.lowered)+'</div>':'')+'</td><td><div class="acts"><button class="pri" onclick="fo.approve(\\''+esc(x.id)+'\\')">Approve</button><button onclick="fo.reject(\\''+esc(x.id)+'\\')">Reject</button></div></td></tr>'}).join('')+'</table><p class="mut small">An approved action runs on the agent\\'s next check'+(a.live?'':', as a dry run (the agent is not live)')+'.</p>':'<p class="mut small">Nothing is waiting.</p>')+'</div>';
// training + inference
h+='<div class="card"><h2>Training: step time</h2><p class="sub" style="margin:-6px 0 8px">Median step time across ranks; dashed line is the job\\'s own earlier median.</p><div class="charts">'+(d.training.length?d.training.map(function(j){return'<div class="chart"><h3>'+esc(j.job)+'</h3><div class="sub">'+j.ranks+' ranks on '+j.nodes+' node(s)</div>'+line(j.series,{unit:'s',ref:j.baseline,refLabel:'usual',label:j.job+' step time'})+'</div>'}).join(''):'<p class="mut small">No step records in the last 2 h.</p>')+'</div></div>';
h+='<div class="card"><h2>Inference: latency</h2><p class="sub" style="margin:-6px 0 8px">p99 per 2 minutes; dashed line is the target when one is set.</p><div class="charts">'+(d.inference.length?d.inference.map(function(p){return'<div class="chart"><h3>'+esc(p.pool)+' · TTFT p99</h3>'+line(p.ttft,{unit:'s',ref:p.targets.ttftP99,refLabel:'target',label:p.pool+' TTFT p99'})+'</div><div class="chart"><h3>'+esc(p.pool)+' · TPOT p99</h3>'+line(p.tpot,{unit:'s',ref:p.targets.tpotP99,refLabel:'target',label:p.pool+' TPOT p99'})+'</div>'}).join(''):'<p class="mut small">No serving records in the last 2 h.</p>')+'</div></div>';
h+='</div><div>';
// fleet
var nodes={};g.forEach(function(x){(nodes[x.node]=nodes[x.node]||[]).push(x)});var used={};g.forEach(function(x){used[STATE[x.state]?STATE[x.state][1]:x.state]=STATE[x.state]?STATE[x.state][0]:'var(--serving)'});
h+='<div class="card"><h2>GPUs</h2>'+(g.length?'<div class="legend">'+Object.keys(used).map(function(k){return'<span><i style="background:'+used[k]+'"></i>'+esc(k)+'</span>'}).join('')+(g.some(function(x){return x.verdict&&x.verdict!=='ok'})?'<span><i style="background:transparent;border:2px solid var(--ink)"></i>flaky</span>':'')+'</div><div class="nodes">'+Object.keys(nodes).map(function(n){return'<div><div class="node">'+esc(n)+'</div><div class="cells">'+nodes[n].map(function(x){var s=STATE[x.state]||['var(--serving)',x.state];return'<div class="cell'+(x.verdict&&x.verdict!=='ok'?' flk':'')+'" style="background:'+s[0]+'" tabindex="0" data-tip="'+esc('<b>'+esc(x.key)+'</b> · '+esc(s[1])+(x.verdict&&x.verdict!=='ok'?' · '+esc(x.verdict):'')+(x.why?'<br>'+esc(x.why):''))+'"></div>'}).join('')+'</div></div>'}).join('')+'</div><p class="mut small">As of '+(d.fleet.at?hm(d.fleet.at):'–')+'.</p>':'<p class="mut small">No device telemetry yet.</p>')+'</div>';
// flakiness
var fd=d.flakiness?d.flakiness.devices.filter(function(x){return x.verdict!=='ok'}):[];
h+='<div class="card"><h2>Flakiest GPUs</h2>'+(d.flakiness?(d.flakiness.hotCohorts||[]).map(function(c){return'<p class="small"><b>'+esc(c.dimension)+' '+esc(c.value)+'</b> fails at '+c.ratio.toFixed(1)+'× the fleet rate: look for a shared cause.</p>'}).join('')+(fd.length?'<table><tr><th>GPU</th><th>Verdict</th><th class="n">Exits</th><th class="n">Bounces</th><th>Next step</th></tr>'+fd.map(function(x){return'<tr><td><b>'+esc(x.key)+'</b></td><td>'+esc(x.verdict)+'</td><td class="n">'+x.exits+'</td><td class="n">'+x.bounces+'</td><td class="small">'+esc(x.next||'')+'</td></tr>'}).join('')+'</table>':'<p class="mut small">No GPU has left service more than once in the window.</p>')+'<p class="mut small">History since the agent started: '+(d.flakiness.window?d.flakiness.window.days+' day window':'')+'.</p>':'<p class="mut small">Builds up as the agent runs.</p>')+'</div>';
// agent log
h+='<div class="card"><h2>What the agent did</h2><div class="log">'+(d.decisions.length?d.decisions.map(logLine).join(''):'<p class="mut small">Nothing yet.</p>')+'</div></div>';
// recent runs
h+='<div class="card"><h2>Actions run</h2>'+(d.actions.ran.length?'<table>'+d.actions.ran.slice(0,15).map(function(e){return'<tr><td class="mut small" style="white-space:nowrap">'+hm(e.t)+'</td><td><b>'+esc(e.kind)+'</b> <span class="mut small">'+esc(e.target)+'</span><div class="small ink2">'+esc(e.event==='dry-run'?'dry run: '+((e.commands||[]).map(function(c){return c.join(' ')}).join('; ')||e.text||''):e.event+(e.by?' by '+e.by:'')+(e.why?': '+e.why:''))+'</div></td></tr>'}).join('')+'</table>':'<p class="mut small">Nothing has run.</p>')+'</div>';
h+='</div></div>';app.innerHTML=h}
function tile(v,l){return'<div class="tile"><b>'+esc(v)+'</b><span>'+esc(l)+'</span></div>'}
function incident(i){var dc=DEC[i.decision]||null,acts=data.actions.open.filter(function(x){return x.incident===i.id});
return'<div class="inc"><div class="h"><span class="st '+esc(i.severity)+'">'+esc(i.severity||'')+'</span><b>'+esc(i.symptom)+(i.pool?' · '+esc(i.pool):'')+(i.job?' · '+esc(i.job):'')+'</b><span class="chip">'+esc(i.status)+'</span>'+(dc?'<span class="chip"><span class="dot" style="background:'+dc[0]+'"></span> agent '+dc[1]+'</span>':'')+'<span class="mut small">opened '+ago(i.openedAt)+'</span></div>'
+(i.title?'<div style="margin-top:4px">'+esc(i.title)+' <span class="mut small">('+esc(i.cause)+', '+esc(i.confidence)+' confidence)</span></div>':'<div class="mut small">no cause found</div>')
+(acts.length?'<div class="small ink2" style="margin-top:4px">'+acts.map(function(x){return esc(x.kind)+' '+esc(x.target)+' <span class="mut">['+esc(x.status==='approved'&&x.approvedBy==='policy'?'automatic':x.status)+']</span>'}).join(' · ')+'</div>':'')
+(i.verified?'<div class="small" style="margin-top:4px">'+(i.verified.outcome==='cleared'?'✓ symptom cleared'+(i.verified.live?' after mitigation':' on its own (dry run)'):i.verified.outcome==='no-data'?'? no new data since acting: a person should look':'✗ still present after acting: a person is needed')+'</div>':'')
+'<details><summary>Evidence and timeline</summary><p class="small">'+esc(i.narrative||'')+'</p><button onclick="fo.open(\\'/api/incidents/'+encodeURIComponent(i.id)+'/timeline\\')">Timeline</button></details></div>'}
function logLine(e){var what=e.decision==='acted'?(e.outcome==='dry-run'?'would run':e.outcome)+' <b>'+esc(e.kind)+'</b> '+esc(e.action)+(e.by&&e.by!=='policy'?' (approved by '+esc(e.by)+')':''):e.decision==='verified'?esc(e.note):e.decision==='approved'||e.decision==='rejected'?esc(e.by)+' '+e.decision+' '+esc(e.action):e.decision==='paused'||e.decision==='resumed'?esc(e.by)+' '+e.decision+' the agent':e.decision==='budget'?esc(e.note):e.decision==='paged'?'paged '+esc(e.to)+(e.dryRun?' (dry run)':''):'<b>'+esc((DEC[e.decision]||[0,e.decision])[1])+'</b> '+esc(e.incident||'')+(e.title?': '+esc(e.title)+' <span class="mut">('+esc(e.confidence)+')</span>':'');
return'<div><span class="mut">'+hm(e.t)+'</span> '+what+'</div>'}
// tooltips: data-tip cells, and the crosshair on charts
function show(html,x,y){tip.innerHTML=html;tip.style.display='block';var r=tip.getBoundingClientRect();tip.style.left=Math.min(window.innerWidth-r.width-8,x+12)+'px';tip.style.top=Math.max(8,y-r.height-12)+'px'}
function hide(){tip.style.display='none';document.querySelectorAll('svg .xh,svg .xp').forEach(function(e){e.style.display='none'})}
document.addEventListener('pointermove',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(el)return show(el.getAttribute('data-tip'),e.clientX,e.clientY);
var sv=e.target.closest&&e.target.closest('svg[data-pts]');if(!sv)return hide();var pts=JSON.parse(sv.getAttribute('data-pts'));if(!pts.length)return;var b=sv.getBoundingClientRect(),vb=sv.viewBox.baseVal,x=(e.clientX-b.left)/b.width*vb.width;
var best=pts[0];pts.forEach(function(p){if(Math.abs(p[0]-x)<Math.abs(best[0]-x))best=p});var xh=sv.querySelector('.xh'),xp=sv.querySelector('.xp');xh.setAttribute('x1',best[0]);xh.setAttribute('x2',best[0]);xh.style.display='';xp.setAttribute('cx',best[0]);xp.setAttribute('cy',best[1]);xp.style.display='';
var ref=sv.getAttribute('data-ref');show('<b>'+fmt(best[3],sv.getAttribute('data-unit'))+'</b> '+esc(sv.getAttribute('data-name'))+'<br>'+hm(best[2])+(ref!==''?'<br>reference '+fmt(+ref,sv.getAttribute('data-unit')):''),e.clientX,e.clientY)});
document.addEventListener('focusin',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(!el)return hide();var b=el.getBoundingClientRect();show(el.getAttribute('data-tip'),b.left+b.width/2,b.top)});document.addEventListener('focusout',hide);
function start(){render();load();clearInterval(timer);timer=setInterval(load,5000)}
// with no tokens configured the server answers without one
api('/api/live').then(function(d){if(!TOKEN)TOKEN='-';data=d;start()}).catch(function(){render()});
})();
</script></body></html>`;
