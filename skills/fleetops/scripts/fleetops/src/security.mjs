// Running fleetops as a shared service: tokens with roles and tenant scopes, redaction at ingest, an egress allowlist
// for on-prem / no-external-calls mode, and an audit trail of reads.
//
// Tokens (--tokens FILE, JSON lines or an array): { name, sha256, roles: [ingest|read|admin], tenant }
//   tenant: '*' (everything), or { namespaces?, owners?, pools?, clusters?, infra? }. infra: true also shows the
//   shared hardware records (device, log, topology, inventory, health); a team scope sees its own jobs, pools and
//   incidents. Only the SHA-256 of a token is stored: `fleetops token create` prints the token once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export function newToken() { return `fo_${crypto.randomBytes(24).toString('base64url')}`; }

export function loadTokens(file) {
  if (!file) return null;
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!text) return [];
  const list = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  for (const t of list) if (!t.sha256 || !t.name || !Array.isArray(t.roles)) throw new Error(`token entries need name, sha256, roles (${JSON.stringify(t).slice(0, 80)})`);
  return list;
}
export function addToken(file, { name, roles, tenant }) {
  const token = newToken(), entry = { name, sha256: sha256(token), roles, tenant: tenant || '*', created: new Date().toISOString() };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return { token, entry };
}

// Who is calling: null when tokens aren't configured (open mode, for a single-user or localhost setup).
export function authenticate(tokens, header) {
  if (!tokens) return { name: 'anonymous', roles: ['ingest', 'read', 'admin'], tenant: '*', open: true };
  const m = String(header || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const h = sha256(m[1]);
  const t = tokens.find(x => x.sha256.length === h.length && crypto.timingSafeEqual(Buffer.from(x.sha256), Buffer.from(h)));
  return t ? { name: t.name, roles: t.roles, tenant: t.tenant || '*' } : null;
}
export const can = (who, role) => !!who && (who.roles.includes(role) || who.roles.includes('admin'));

// Does a record belong to the caller's tenant scope?
const INFRA = new Set(['device', 'log', 'topology', 'inventory', 'health', 'benchmark', 'calibration', 'drift']);
export function visible(tenant, kind, r, ctx = {}) {
  if (!tenant || tenant === '*') return true;
  if (INFRA.has(kind)) return !!tenant.infra;
  const inList = (list, v) => Array.isArray(list) && v != null && list.includes(v);
  const meta = ctx.jobMeta && r.job ? ctx.jobMeta.get(String(r.job).split('#')[0]) || {} : {};
  const inc = r.incident || {};
  return inList(tenant.namespaces, r.namespace ?? meta.namespace) || inList(tenant.owners, r.owner ?? meta.owner) || inList(tenant.pools, r.pool ?? inc.pool) || inList(tenant.clusters, r.cluster ?? r.site)
    || (kind === 'change' && (tenant.namespaces || []).some(ns => String(r.target || '').startsWith(ns + '/')))
    || (!!tenant.infra && !r.namespace && !r.pool && !meta.namespace);
}

// ---------- redaction at ingest ----------
// Span attributes that carry request content are dropped; secrets in log lines are masked. Counted, never stored.
const CONTENT_KEY = /(^|\.)(prompt|prompts|completion|completions|messages|input\.value|output\.value|input_messages|output_messages|content|body)(\.|$)|gen_ai\.(prompt|completion|input|output)|llm\.(prompts|input|output)|http\.(request|response)\.body/i;
const SECRETS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [redacted]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[redacted-token]'],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
];
export function redactText(s) { let out = String(s), n = 0; for (const [re, rep] of SECRETS) out = out.replace(re, (...m) => { n++; return rep.replace('$1', m[1] || ''); }); return { text: out, n }; }
export function redact(kind, recs) {
  let n = 0;
  for (const r of recs) {
    if (r.attrs) for (const k of Object.keys(r.attrs)) if (CONTENT_KEY.test(k)) { delete r.attrs[k]; n++; } else if (typeof r.attrs[k] === 'string') { const x = redactText(r.attrs[k]); if (x.n) { r.attrs[k] = x.text; n += x.n; } }
    if (typeof r.msg === 'string') { const x = redactText(r.msg); if (x.n) { r.msg = x.text; n += x.n; } }
    if (kind === 'request') for (const k of ['prompt', 'completion', 'messages', 'input', 'output']) if (k in r) { delete r[k]; n++; }
  }
  return n;
}

// ---------- egress ----------
// FLEETOPS_EGRESS_ALLOW="prometheus.monitoring.svc,*.corp.example" (or --on-prem: nothing but localhost) refuses any
// outbound HTTP call fleetops would make (paging, webhooks, Prometheus guards) to a host not on the list.
export function egressAllowed(url, allow = process.env.FLEETOPS_EGRESS_ALLOW) {
  if (allow == null) return true;
  const host = new URL(url).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  return String(allow).split(',').map(s => s.trim()).filter(Boolean).some(p => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));
}
export function checkEgress(url) { if (!egressAllowed(url)) throw new Error(`egress to ${new URL(url).hostname} is not allowed (FLEETOPS_EGRESS_ALLOW / --on-prem)`); }

// ---------- audit ----------
export function auditor(dir) {
  const f = path.join(dir, 'audit', 'api.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return e => fs.appendFileSync(f, JSON.stringify(Object.assign({ t: Date.now() / 1000 }, e)) + '\n');
}
