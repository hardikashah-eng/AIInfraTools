// The shadow-upgrade judge as a service, for the rollout controllers people already run:
//   Argo Rollouts   an AnalysisTemplate `web` metric: POST /verdict → { verdict: promote | rollback | wait, … }
//                   successCondition result == "promote", failureCondition result == "rollback"; "wait" is inconclusive
//   Flagger         webhooks: POST /flagger/rollout (non-2xx only on rollback, so a failed check means "worse") and
//                   POST /flagger/confirm-promotion (200 only on promote: Flagger holds the promotion until then)
//   anything else   GET /verdict?baseline=…&candidate=…&lookback=900
// Each call queries Prometheus for both versions (shadow-prom.mjs) and judges at matched load. The request names the
// versions by label matchers ({ select, baseline, candidate }); they are checked as matchers before any query is built.
// Nothing here changes the rollout: the controller decides what a verdict does.
import http from 'node:http';
import { authenticate } from './security.mjs';
import { checkSelector } from './shadow-prom.mjs';

const num = v => (v == null || v === '' ? undefined : Number.isFinite(+v) ? +v : NaN);
export function params(src = {}, defaults = {}) {
  const p = Object.assign({}, defaults);
  for (const k of ['select', 'baseline', 'candidate']) if (src[k] != null && src[k] !== '') p[k] = String(src[k]);
  for (const [k, a] of [['lookback', 'lookback'], ['baselineLookback', 'baseline-lookback'], ['baselineLookback', 'baselineLookback']]) { const v = num(src[a]); if (v !== undefined) p[k] = v; }
  if (!p.baseline || !p.candidate) throw new Error('baseline and candidate selectors are required (label matchers, e.g. llm_isvc_name="chat-v2")');
  for (const k of ['select', 'baseline', 'candidate']) if (p[k]) p[k] = checkSelector(p[k]);
  for (const k of ['lookback', 'baselineLookback']) if (p[k] != null && !(p[k] >= 60 && p[k] <= 30 * 86400)) throw new Error(`${k}: seconds between 60 and 30 days`);
  return p;
}

// evaluate(params) → the result of compareWindows (with `verdict`). log(entry) records each decision.
export function gateServer(evaluate, { tokens = null, defaults = {}, log = null, maxBody = 64 << 10 } = {}) {
  const body = req => new Promise((res, rej) => { let n = 0; const parts = []; req.on('data', d => { n += d.length; if (n > maxBody) { rej(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); } else parts.push(d); }); req.on('end', () => res(Buffer.concat(parts).toString('utf8'))); req.on('error', rej); });
  const send = (res, code, obj) => { const json = typeof obj !== 'string'; res.writeHead(code, { 'content-type': json ? 'application/json' : 'text/plain', 'cache-control': 'no-store' }); res.end(json ? JSON.stringify(obj) : obj + '\n'); };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gate');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok');
      if (!authenticate(tokens, req.headers.authorization)) return send(res, 401, 'a valid bearer token is required');
      const route = url.pathname;
      if (!['/verdict', '/flagger/rollout', '/flagger/confirm-promotion'].includes(route)) return send(res, 404, 'not found');
      let src;
      if (req.method === 'GET' && route === '/verdict') src = Object.fromEntries(url.searchParams);
      else if (req.method === 'POST') { const t = await body(req); const j = t.trim() ? JSON.parse(t) : {}; src = route.startsWith('/flagger/') ? Object.assign({}, j.metadata || {}) : j; }
      else return send(res, 405, 'method not allowed');
      let p; try { p = params(src, defaults); } catch (e) { return send(res, 400, e.message); }
      let r; try { r = await evaluate(p); } catch (e) { return send(res, 502, `prometheus: ${e.message}`); }
      const out = { verdict: r.verdict, decision: r.decision, why: r.why, requests: r.requests, load: r.load, metrics: r.metrics, selectors: { select: p.select || null, baseline: p.baseline, candidate: p.candidate } };
      if (log) log({ t: Math.floor(Date.now() / 1000), route, verdict: r.verdict, why: r.why, baseline: p.baseline, candidate: p.candidate, select: p.select || null });
      if (route === '/verdict') return send(res, 200, out);
      if (route === '/flagger/rollout') return r.verdict === 'rollback' ? send(res, 412, `roll back: ${r.why}`) : send(res, 200, out);
      return r.verdict === 'promote' ? send(res, 200, out) : send(res, 412, `${r.decision}: ${r.why}`);
    } catch (e) { return send(res, e.code === 413 ? 413 : 400, e.message); }
  });
}
