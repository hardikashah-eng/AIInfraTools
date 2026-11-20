#!/usr/bin/env node
// Runs the skew-corrector service.
//
//   node tools/skew-corrector.mjs --port 4318 --downstream http://tempo:4318/v1/traces
//        [--ref-site onprem] [--site-key site] [--resolve-ms 30000] [--sample-ttl-ms 900000]
//        [--known offsets.json] [--header 'X-Scope-OrgID: tracing']
//
// Every option also reads from the environment: SKEW_PORT, SKEW_DOWNSTREAM, SKEW_REF_SITE, SKEW_SITE_KEY,
// SKEW_RESOLVE_MS, SKEW_SAMPLE_TTL_MS, SKEW_KNOWN (path), SKEW_HEADERS ("Name: value; Name2: value2").
import { readFileSync } from 'node:fs';
import { startServer } from '../src/service.mjs';

const args = process.argv.slice(2), opt = {};
const headers = [];
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const k = args[i].slice(2), v = args[i + 1];
  if (k === 'header') headers.push(v); else opt[k] = v;
  i++;
}
const env = process.env;
const pick = (k, e, d) => opt[k] != null ? opt[k] : env[e] != null ? env[e] : d;
const hdrs = {};
for (const h of headers.concat((env.SKEW_HEADERS || '').split(';').filter(Boolean))) { const i = h.indexOf(':'); if (i > 0) hdrs[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
const knownPath = pick('known', 'SKEW_KNOWN', '');
const cfg = {
  port: +pick('port', 'SKEW_PORT', 4318),
  downstream: pick('downstream', 'SKEW_DOWNSTREAM', ''),
  refSite: pick('ref-site', 'SKEW_REF_SITE', 'onprem'),
  siteKey: pick('site-key', 'SKEW_SITE_KEY', 'site'),
  resolveMs: +pick('resolve-ms', 'SKEW_RESOLVE_MS', 30000),
  sampleTtlMs: +pick('sample-ttl-ms', 'SKEW_SAMPLE_TTL_MS', 900000),
  known: knownPath ? JSON.parse(readFileSync(knownPath, 'utf8')) : {},
  headers: hdrs,
};
if (!cfg.downstream) console.error('No --downstream set: spans are corrected and dropped (useful for watching /offsets only).');
const { server } = startServer(cfg);
server.listen(cfg.port, () => console.error(`skew-corrector on :${cfg.port} → ${cfg.downstream || '(no downstream)'}; reference site "${cfg.refSite}"`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
