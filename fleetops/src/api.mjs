// The read API of `fleetops serve`, scoped to the caller's tenant and audited.
//
//   GET /api/summary
//   GET /api/query?kind=K&from=T&to=T&limit=N&where=k=v…            records (JSON array)
//   GET /api/series?kind=device&field=sm&from=T&to=T&step=60&agg=avg&node=…&gpu=…&pool=…&where=k=v   [{ t, time, value }] for Grafana
//   GET /api/incidents[?status=S]   /api/incidents/ID   /api/incidents/ID/timeline (HTML)   /api/incidents/ID/postmortem (MD)
//   GET /api/diagnose?symptom=S&from=T&to=T[&pool=P&job=J&nodes=a,b]
//   GET /api/goodput?from=T&to=T[&job=J&format=html|md]    training goodput (unscoped or infra tokens)
//   GET /api/tune?from=T&to=T[&format=md]                    tuning recommendations (unscoped or infra tokens)
// Grafana: the Infinity data source (JSON, backend parser) reads /api/series and /api/incidents directly; see
// deploy/grafana-dashboard.json.
import { whereFrom } from './store.mjs';
import { visible } from './security.mjs';
import * as Inc from './incidents.mjs';
import { diagnose } from './rca.mjs';
import { goodput } from './goodput.mjs';
import { goodputHtml, goodputMarkdown } from './goodput-report.mjs';
import { tune, tuneMarkdown } from './tune.mjs';
import { medianUpper } from './stats.mjs';

const num = (v, d) => (v == null || v === '' ? d : Number(v));
const time = v => (v == null || v === '' ? undefined : /^\d+(\.\d+)?$/.test(v) ? +v : Date.parse(v) / 1000);
const median = a => medianUpper(a, null);
const AGG = { avg: a => a.reduce((t, v) => t + v, 0) / a.length, max: a => Math.max(...a), min: a => Math.min(...a), sum: a => a.reduce((t, v) => t + v, 0), count: a => a.length, p50: median, p99: a => a.slice().sort((x, y) => x - y)[Math.floor(0.99 * (a.length - 1))] };

function jobMetaFor(store, recs, to) {
  if (!recs.some(r => r.job)) return null;
  const m = new Map();
  for (const p of store.query('placement', { to })) m.set(String(p.job).split('#')[0], { namespace: p.namespace, owner: p.owner });
  return m;
}

// → { status, type, body, records } or null when the path isn't an API path.
export function handleApi(store, who, method, rawUrl) {
  const u = new URL(rawUrl, 'http://x'), p = u.pathname, q = Object.fromEntries(u.searchParams), tenant = who.tenant;
  if (method !== 'GET' || !p.startsWith('/api/')) return null;
  const json = (body, records) => ({ status: 200, type: 'application/json', body: JSON.stringify(body), records });
  const scoped = (kind, recs, to) => { const ctx = { jobMeta: jobMetaFor(store, recs, to) }; return recs.filter(r => visible(tenant, kind, r, ctx)); };
  if (store.flush) store.flush();

  if (p === '/api/summary') {
    if (tenant !== '*' && !tenant.infra) return { status: 403, type: 'text/plain', body: 'summary needs an unscoped or infra token\n' };
    return json(store.summary());
  }
  if (p === '/api/query') {
    if (!q.kind) return { status: 400, type: 'text/plain', body: 'kind is required\n' };
    const from = time(q.from), to = time(q.to), limit = Math.min(num(q.limit, 1000), 100000);
    const recs = scoped(q.kind, store.query(q.kind, { from, to, where: whereFrom(u.searchParams.getAll('where')) }), to).slice(0, limit);
    return json(recs, recs.length);
  }
  if (p === '/api/series') {
    const kind = q.kind || 'device', field = q.field, step = Math.max(1, num(q.step, 60)), agg = AGG[q.agg || 'avg'];
    if (!field || !agg) return { status: 400, type: 'text/plain', body: 'field is required; agg is avg|max|min|sum|count|p50|p99\n' };
    const from = time(q.from), to = time(q.to);
    const match = r => (!q.node || r.node === q.node) && (!q.gpu || String(r.gpu) === q.gpu) && (!q.pool || r.pool === q.pool) && (!q.job || r.job === q.job);
    const w = whereFrom(u.searchParams.getAll('where'));
    const recs = scoped(kind, store.query(kind, { from, to, where: r => match(r) && Number.isFinite(r[field]) && (!w || w(r)) }), to);
    const bins = new Map();
    for (const r of recs) { const b = Math.floor(r.t / step) * step; if (!bins.has(b)) bins.set(b, []); bins.get(b).push(r[field]); }
    const out = [...bins].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, time: new Date(t * 1000).toISOString(), value: +agg(v).toFixed(6) }));
    return json(out, recs.length);
  }
  const mInc = p.match(/^\/api\/incidents(?:\/([^/]+))?(?:\/(timeline|postmortem))?$/);
  if (mInc) {
    const ok = s => tenant === '*' || !!tenant.infra || (s.incident && ((tenant.pools || []).includes(s.incident.pool) || (s.incident.job && (tenant.jobs || []).includes(s.incident.job))));
    if (!mInc[1]) { const all = Inc.state(store).filter(s => ok(s) && (!q.status || s.status === q.status)).map(({ events, diagnosis, ...s }) => Object.assign(s, { top: diagnosis && diagnosis.hypotheses[0] ? diagnosis.hypotheses[0].title : null })); return json(all, all.length); }
    const id = decodeURIComponent(mInc[1]), s = Inc.state(store, id);
    if (!s || !ok(s)) return { status: 404, type: 'text/plain', body: 'no such incident\n' };
    if (mInc[2] === 'timeline') return { status: 200, type: 'text/html; charset=utf-8', body: Inc.timelineHtml(store, id), records: 1 };
    if (mInc[2] === 'postmortem') return { status: 200, type: 'text/markdown; charset=utf-8', body: Inc.postmortem(store, id), records: 1 };
    return json(s, 1);
  }
  if (p === '/api/tune') {
    if (tenant !== '*' && !tenant.infra) return { status: 403, type: 'text/plain', body: 'tune needs an unscoped or infra token\n' };
    const to = time(q.to) ?? Math.floor(Date.now() / 1000), from = time(q.from) ?? to - 7 * 86400;
    const t = tune(store, { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)) });
    if (q.format === 'md') return { status: 200, type: 'text/markdown; charset=utf-8', body: tuneMarkdown(t), records: t.recommendations.length };
    return json(t, t.recommendations.length);
  }
  if (p === '/api/goodput') {
    if (tenant !== '*' && !tenant.infra) return { status: 403, type: 'text/plain', body: 'goodput needs an unscoped or infra token\n' };
    const to = time(q.to) ?? Math.floor(Date.now() / 1000), from = time(q.from) ?? to - 7 * 86400;
    const g = goodput(store, { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)), job: q.job });
    if (q.format === 'html') return { status: 200, type: 'text/html; charset=utf-8', body: goodputHtml(g), records: g.jobs.length };
    if (q.format === 'md') return { status: 200, type: 'text/markdown; charset=utf-8', body: goodputMarkdown(g), records: g.jobs.length };
    return json(Object.assign({}, g, { jobs: g.jobs.map(({ attemptsList, ...j }) => j) }), g.jobs.length);
  }
  if (p === '/api/diagnose') {
    if (!q.symptom || q.from == null || q.to == null) return { status: 400, type: 'text/plain', body: 'symptom, from and to are required\n' };
    if (tenant !== '*' && !tenant.infra && !(q.pool && (tenant.pools || []).includes(q.pool))) return { status: 403, type: 'text/plain', body: 'this token may diagnose only its own pools\n' };
    const d = diagnose(store, { symptom: q.symptom, from: time(q.from), to: time(q.to), pool: q.pool, job: q.job, metric: q.metric, nodes: q.nodes ? q.nodes.split(',') : undefined });
    return json(d, 1);
  }
  return { status: 404, type: 'text/plain', body: 'not found\n' };
}
