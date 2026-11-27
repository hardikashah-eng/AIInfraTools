// fleetops CLI: server (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import * as Ingest from '../../src/ingest.mjs';
import * as Sec from '../../src/security.mjs';
import * as Pull from '../../src/pull.mjs';
import * as Agent from '../../src/agent.mjs';
import * as Bundle from '../../src/bundle.mjs';
import * as LiveView from '../../src/live.mjs';
import { J, OUT, say, read, time, hdrs, lokiQueries, dur } from './common.mjs';
import { importBundle } from './data.mjs';

export function tokenCmd(cmd, o) {
  const file = o.tokens && o.tokens !== true ? o.tokens : null;
  if (!file) throw new Error('--tokens FILE');
  if (cmd === 'create') {
    if (!o.name || o.name === true) throw new Error('--name NAME');
    const roles = String(o.roles && o.roles !== true ? o.roles : 'read').split(',');
    const list = k => (o[k] && o[k] !== true ? String(o[k]).split(',') : undefined);
    const scoped = ['namespaces', 'owners', 'pools', 'clusters'].some(k => list(k)) || o.infra;
    const tenant = scoped ? Object.fromEntries([...['namespaces', 'owners', 'pools', 'clusters'].map(k => [k, list(k)]).filter(([, v]) => v), ...(o.infra ? [['infra', true]] : [])]) : '*';
    const { token, entry } = Sec.addToken(file, { name: o.name, roles, tenant });
    console.log(`token for ${entry.name} (${roles.join(', ')}; ${tenant === '*' ? 'all tenants' : JSON.stringify(tenant)}):\n${token}\nOnly its SHA-256 is stored in ${file}; this is the only time it is shown.`);
    return;
  }
  if (cmd === 'list') { for (const t of Sec.loadTokens(file)) console.log(`${t.name.padEnd(20)} ${t.roles.join(',').padEnd(18)} ${t.tenant === '*' ? '*' : JSON.stringify(t.tenant)}`); return; }
  throw new Error('token create|list --tokens FILE');
}

// ---------- live agent ----------
export function agentOpts(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = f => JSON.parse(read(f));
  const agent = Object.assign({}, opt('agent-config') ? json(opt('agent-config')) : {});
  if (opt('interval')) agent.intervalS = +opt('interval');
  if (opt('window')) agent.windowS = dur(opt('window')) ?? +opt('window');
  if (opt('targets')) agent.targets = json(opt('targets'));
  if (opt('min-failures')) agent.minFailures = +opt('min-failures');
  if (opt('page-to')) agent.page = { to: opt('page-to'), key: opt('page-key') || process.env.PAGERDUTY_ROUTING_KEY || process.env.OPSGENIE_API_KEY, url: opt('page-url'), minSeverity: opt('page-min-severity') || 'sev2' };
  const stateDir = opt('state') || path.join(store.dir, 'agent');
  const ghConfig = opt('config') ? json(opt('config')) : undefined;
  // pull from the fleet's own monitoring before each tick, from where the last pull stopped
  let pulledTo = null;
  const before = opt('prom') || opt('loki') ? async now => {
    const from = pulledTo ?? now - (agent.deviceWindowS || Agent.AGENT_DEFAULTS.deviceWindowS);
    if (opt('prom')) await Pull.pullPrometheus(store, opt('prom'), { from, to: now, step: opt('step') ? +opt('step') : 30, headers: hdrs(o) });
    if (opt('loki')) await Pull.pullLoki(store, opt('loki'), lokiQueries(o), { from, to: now, headers: hdrs(o) });
    pulledTo = now;
  } : null;
  return { stateDir, ghConfig, agent, live: !!o.live, before };
}
export function agentLine(r) {
  const acts = r.executed.map(e => `${e.kind}:${e.outcome}`).join(', ');
  return `${new Date(r.t * 1000).toISOString()} agent${r.paused ? ' (paused)' : ''}${r.devices ? ` · ${Object.entries(r.devices.states).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''} · ${r.incidents.length} incident(s)${r.incidents.map(i => `\n  ${i.id}: ${i.rule || 'no cause'} (${i.confidence}) → ${i.decision}${i.actions.length ? ' [' + i.actions.map(a => `${a.kind} ${a.mode}`).join(', ') + ']' : ''}`).join('')}${acts ? `\n  ran: ${acts}` : ''}${r.verified.map(v => `\n  verified ${v.id}: ${v.outcome}`).join('')}`;
}
export async function agentCmd(store, cmd, o) {
  const ao = agentOpts(store, o), opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  if (cmd === 'pause' || cmd === 'resume') { if (!opt('by')) throw new Error(`agent ${cmd} --by NAME`); Agent.setPaused(ao.stateDir, cmd === 'pause', opt('by')); if (J) OUT.paused = cmd === 'pause'; else say(`agent ${cmd === 'pause' ? 'paused' : 'resumed'} by ${opt('by')}`); return; }
  if (cmd === 'status') {
    const v = LiveView.liveView(store, ao.stateDir, { agent: ao.agent, ghConfig: ao.ghConfig });
    if (J) { OUT.status = { agent: v.agent, fleet: v.fleet.states, incidents: v.incidents, waiting: v.actions.open.filter(a => a.status === 'proposed') }; return; }
    say(`agent ${v.agent.paused ? 'PAUSED' : v.agent.lastTick ? `last ran ${new Date(v.agent.lastTick * 1000).toISOString()}` : 'has not run'}${v.agent.live ? ' (live)' : ' (dry run)'} · autonomous actions in the last hour ${v.agent.autoLastHour}/${v.agent.autoLimit}`);
    say(`GPUs: ${Object.entries(v.fleet.states).map(([k, n]) => `${k} ${n}`).join(', ') || 'no telemetry'}`);
    for (const i of v.incidents) say(`  ${i.severity} ${i.status.padEnd(12)} ${i.id}: ${i.title || 'no cause'} → ${i.decision || '–'}${i.verified ? ` (${i.verified.outcome})` : ''}`);
    for (const a of v.actions.open.filter(a => a.status === 'proposed')) say(`  waiting: ${a.id}  ${a.reason.slice(0, 140)}`);
    return;
  }
  if (cmd === 'log') { const d = Agent.decisions(ao.stateDir, o.limit ? +o.limit : 50); if (J) { OUT.log = d; return; } for (const e of d.reverse()) say(`${new Date(e.t * 1000).toISOString()} ${e.decision}${e.incident ? ' ' + e.incident : ''}${e.action ? ' ' + e.action : ''}${e.outcome ? ' → ' + e.outcome : ''}${e.title ? ': ' + e.title : ''}${e.note ? ': ' + e.note : ''}`); return; }
  if (cmd === 'approve' || cmd === 'reject') {
    const { Store: Q } = await import('../../../gpu-health/src/actions.mjs');
    const id = o._[2]; if (!id || !opt('by')) throw new Error(`agent ${cmd} ID --by NAME`);
    const q = new Q(ao.stateDir), a = cmd === 'approve' ? q.approve(id, opt('by')) : q.reject(id, opt('by'), opt('reason') || '');
    fs.appendFileSync(path.join(ao.stateDir, 'agent.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), decision: cmd === 'approve' ? 'approved' : 'rejected', action: a.id, kind: a.kind, by: opt('by'), incident: a.incident }) + '\n');
    if (J) OUT[cmd + 'd'] = a; else say(`${a.id} ${a.status} by ${opt('by')}; it runs on the agent's next tick`);
    return;
  }
  if (cmd && cmd !== 'run') throw new Error(`unknown: agent ${cmd}`);
  if (o.once) {
    if (ao.before) await ao.before(Math.floor(Date.now() / 1000));
    const r = await Agent.tick(store, Object.assign({}, ao, { now: o.now && o.now !== true ? time(o.now) : undefined }));
    if (J) { OUT.tick = r; return; }
    say(agentLine(r)); return;
  }
  if (o.live) console.log('note: --live runs actions only when the gpu-health policy has dryRun: false (--config)');
  Agent.start(store, ao, { onTick: r => console.log(agentLine(r)), before: ao.before });
  const stop = () => { if (store.close) store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

export async function serve(store, o) {
  const port = o.port ? +o.port : 9400, host = o.host && o.host !== true ? o.host : '127.0.0.1';
  const tokens = o.tokens && o.tokens !== true ? Sec.loadTokens(o.tokens) : null;
  // listening beyond this machine without tokens would expose every tenant's data: refuse unless asked for explicitly
  if (!tokens && !['127.0.0.1', 'localhost', '::1'].includes(host) && !o['no-auth']) throw new Error(`--host ${host} needs --tokens FILE (or --no-auth to run open on a trusted network)`);
  const pipe = new Ingest.Pipeline(store, { maxQueue: o['max-queue'] ? +o['max-queue'] : 200000, flushMs: o['flush-ms'] ? +o['flush-ms'] : 1000 }).start();
  let extra = null, page = null, agentRun = null;
  // POST /v1/bundle (role ingest): a trace bundle, imported as `data import bundle` would
  const bundleRoute = async (req, res, who, send) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/bundle') return false;
    if (!Sec.can(who, 'ingest')) { send(res, 403, 'needs the ingest role\n'); return true; }
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > Bundle.MAX_FILE) { send(res, 413, 'bundle too large: import it with fleetops data import bundle\n'); return true; } chunks.push(c); }
    const f = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'fleetops-up-')), 'bundle.tgz');
    try { fs.writeFileSync(f, Buffer.concat(chunks)); const r = await importBundle(store, f, {}); send(res, 200, JSON.stringify({ totals: r.totals, files: r.files.map(x => ({ path: x.path, source: x.source, error: x.error, skipped: x.skipped })) }), 'application/json'); }
    catch (e) { send(res, 400, `${e.message}\n`); }
    finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
    return true;
  };
  extra = bundleRoute;
  if (o.agent) {
    const ao = agentOpts(store, o);
    const live = LiveView.liveRoutes({ store, stateDir: ao.stateDir, agent: ao.agent, ghConfig: ao.ghConfig, audit: Sec.auditor(store.dir) }); page = LiveView.LIVE_HTML;
    extra = async (req, res, who, send) => (await bundleRoute(req, res, who, send)) || live(req, res, who, send);
    agentRun = Agent.start(store, ao, { onTick: r => console.log(agentLine(r)), before: ao.before });
  }
  const srv = Ingest.server(pipe, { site: o.site && o.site !== true ? o.site : undefined, tokens, audit: Sec.auditor(store.dir), extra, page });
  await new Promise(r => srv.listen(port, host, r));
  console.log(`fleetops on http://${host}:${port}  store ${store.dir}  ${tokens ? `${tokens.length} token(s)` : 'open (no tokens)'}${process.env.FLEETOPS_EGRESS_ALLOW != null ? `  egress: ${process.env.FLEETOPS_EGRESS_ALLOW || 'none'}` : ''}\n  POST /api/v1/write /v1/metrics /v1/logs /v1/traces /v1/bundle   GET /api/summary /api/query /api/series /api/incidents /api/diagnose /metrics /healthz${o.agent ? `\n  agent every ${agentOpts(store, o).agent.intervalS ?? Agent.AGENT_DEFAULTS.intervalS} s${o.live ? ' (live: still needs policy.dryRun false)' : ' (dry run)'}; dashboard http://${host}:${port}/live` : ''}`);
  const stop = () => { if (agentRun) agentRun.stop(); srv.close(); pipe.stop(); if (store.close) store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}
