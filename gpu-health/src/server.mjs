// Approval page and API. Binds to 127.0.0.1 by default; every /api call needs a bearer token.
//   GPU_HEALTH_TOKENS="alice:tok1,bob:tok2"  per-person tokens: the approver is the token's owner (preferred)
//   GPU_HEALTH_TOKEN="tok"                   one shared token: the approver types their name
// Commands run live only when the server was started with --allow-live and the config has policy.dryRun=false.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './actions.mjs';

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export function parseTokens(env = process.env) {
  const named = (env.GPU_HEALTH_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf(':'); return { name: s.slice(0, i), token: s.slice(i + 1) }; }).filter(t => t.name && t.token);
  return { named, shared: env.GPU_HEALTH_TOKEN || '' };
}
function who(req, tokens) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  const n = tokens.named.find(t => eq(t.token, tok));
  if (n) return { name: n.name, named: true };
  if (tokens.shared && eq(tokens.shared, tok)) return { name: null, named: false };
  return null;
}
const body = req => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { rej(new Error('body too large')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); });
const send = (res, code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };

export function createServer({ stateDir, cfg, tokens = parseTokens(), allowLive = false }) {
  if (!tokens.named.length && !tokens.shared) throw new Error('set GPU_HEALTH_TOKENS or GPU_HEALTH_TOKEN before serving');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname === '/' && req.method === 'GET') return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const u = who(req, tokens);
      if (!u) return send(res, 401, { error: 'missing or wrong token' });
      const store = new Store(stateDir);
      if (url.pathname === '/api/actions' && req.method === 'GET') {
        const f = path.join(stateDir, 'analysis.json');
        const summary = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).summary : null;
        return send(res, 200, { you: u.name, needName: !u.named, live: allowLive && cfg.policy.dryRun === false, summary, actions: store.list().slice().reverse().slice(0, 300) });
      }
      const m = url.pathname.match(/^\/api\/actions\/([^/]+)\/(approve|reject|execute)$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]), b = await body(req);
        const by = u.named ? u.name : String(b.by || '').trim().slice(0, 64);
        if (!by) return send(res, 400, { error: 'your name is required' });
        if (m[2] === 'approve') return send(res, 200, store.approve(id, by));
        if (m[2] === 'reject') return send(res, 200, store.reject(id, by, String(b.reason || '').slice(0, 500)));
        const a = store.get(id);
        if (!a || a.status !== 'approved') return send(res, 409, { error: 'only approved actions can be executed' });
        store.audit(a, 'execute-requested', { by, live: !!b.live && allowLive });
        const fleetSize = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'analysis.json'), 'utf8')).summary.gpus; } catch { return 0; } })();
        const r = await store.execute(cfg, { ids: [a.id], live: !!b.live && allowLive, fleetSize });
        return send(res, 200, r[0] || { ok: false, output: 'nothing executed' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 400, { error: e.message }); }
  });
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gpu-health · approvals</title>
<style>:root{--bg:#fbfaf8;--fg:#1d1d1b;--mut:#6b6a66;--line:#e4e1db;--card:#fff;--acc:#2f5d50;--bad:#a23b3b;--warn:#b5651d}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--mut:#9a9893;--line:#2e2d2b;--card:#1f1f1d;--acc:#7fb8a4;--bad:#e07a7a;--warn:#e0a060}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 12px}.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{cursor:pointer}button.go{background:var(--acc);color:var(--bg);border-color:var(--acc)}button.no{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
code{font-size:12px}.mut{color:var(--mut);font-size:13px}.pill{font-size:12px;border:1px solid currentColor;border-radius:99px;padding:0 8px;margin-left:6px}.high{color:var(--bad)}.medium{color:var(--warn)}
pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:8px;border-radius:6px;margin:8px 0 0}</style></head><body><main>
<h1>gpu-health · actions</h1>
<div class="bar"><input id="tok" type="password" placeholder="token" size="24"><input id="by" placeholder="your name" size="14" hidden><select id="st"><option value="open">open</option><option value="">all</option><option value="executed">executed</option><option value="rejected">rejected</option></select><button id="load">Load</button><span id="info" class="mut"></span></div>
<div id="list"></div></main>
<script>
let token='';try{token=sessionStorage.getItem('gh_tok')||''}catch(e){}
const $=id=>document.getElementById(id);$('tok').value=token;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,opt={}){const r=await fetch(p,Object.assign({headers:{authorization:'Bearer '+token,'content-type':'application/json'}},opt));const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
let live=false;
async function load(){token=$('tok').value.trim();try{sessionStorage.setItem('gh_tok',token)}catch(e){}
 try{const d=await api('/api/actions');live=d.live;$('by').hidden=!d.needName;const s=d.summary;
  $('info').textContent=(d.you?'signed in as '+d.you+' · ':'')+(s?'$'+Math.round(s.weeklySavings).toLocaleString()+'/week potential · ':'')+(live?'LIVE execution enabled':'dry-run');
  const f=$('st').value;const open=['proposed','approved','suggested'];
  const rows=d.actions.filter(a=>!f||(f==='open'?open.includes(a.status):a.status===f));
  $('list').innerHTML=rows.map(a=>'<div class="card"><div class="top"><div><b>'+esc(a.kind)+'</b> <code>'+esc(a.target)+'</code><span class="pill '+esc(a.severity)+'">'+esc(a.status)+'</span> <span class="mut">'+esc(a.mode)+(a.weekly?' · ≈$'+Math.round(a.weekly)+'/wk':'')+(a.approvedBy?' · approved by '+esc(a.approvedBy):'')+'</span></div><div>'+
   (a.status==='proposed'?'<button class="go" data-a="approve" data-id="'+esc(a.id)+'">Approve</button> ':'')+
   (a.status==='approved'?'<button class="go" data-a="execute" data-id="'+esc(a.id)+'">'+(live?'Execute':'Dry-run')+'</button> ':'')+
   (['proposed','approved','suggested'].includes(a.status)?'<button class="no" data-a="reject" data-id="'+esc(a.id)+'">Reject</button>':'')+
   '</div></div><div class="mut">'+esc(a.reason)+'</div>'+(a.result?'<pre>'+esc(a.result.output)+'</pre>':'')+'<div id="r-'+esc(a.id)+'"></div></div>').join('')||'<p class="mut">Nothing here.</p>';
 }catch(e){$('info').textContent=e.message}}
$('load').onclick=load;$('st').onchange=load;
$('list').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.id,act=b.dataset.a;
 const payload={by:$('by').value.trim()};if(act==='reject'){payload.reason=prompt('Reason for rejecting?')||''}
 if(act==='execute'&&live&&!confirm('Run this action for real?'))return;if(act==='execute')payload.live=live;
 try{const r=await api('/api/actions/'+encodeURIComponent(id)+'/'+act,{method:'POST',body:JSON.stringify(payload)});
  if(act==='execute'){const el=document.getElementById('r-'+id);if(el)el.innerHTML='<pre>'+esc((r.commands||[]).map(c=>'$ '+c.join(' ')).join('\\n')+(r.text?r.text+'\\n':'')+'\\n'+r.output)+'</pre>';setTimeout(load,1500)}else load()}catch(err){alert(err.message)}};
if(token)load();
</script></body></html>`;
