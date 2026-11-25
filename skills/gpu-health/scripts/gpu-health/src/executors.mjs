// Executors: turn an approved action into commands and run them.
//
// Commands are argv arrays from the config, never a shell string, and every value filled into a template must
// match SAFE, so a node or job name can't smuggle in options or extra commands. Dry-run (the default) returns the
// commands without running them.
import { spawnSync } from 'node:child_process';
import { executorFor } from './vendors.mjs';
import { nodeVars } from './platforms.mjs';

export const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:\/=-]{0,252}$/;

export function fill(template, vars) {
  return template.map(arg => arg.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v == null || v === '') throw new Error(`template needs {${k}}`);
    const s = String(v);
    if (!SAFE.test(s)) throw new Error(`unsafe value for {${k}}: ${JSON.stringify(s)}`);
    return s;
  }));
}

export const varsOf = (a, cfg) => Object.assign({ node: a.node, gpu: a.gpu, job: a.job, vendor: a.vendor, reason: a.reasonCode }, nodeVars(cfg, a.node, a), a.params || {});

export function message(a, howTo) {
  const target = [a.job && `job ${a.job}`, a.node && `${a.node}${a.gpu != null ? '/' + (a.vendor && a.vendor !== 'nvidia' && a.vendor !== 'amd' ? 'dev' : 'gpu') + a.gpu : ''}`].filter(Boolean).join(' on ');
  return `[gpu-health] ${a.kind} ${target}: ${howTo ? String(a.reason).replace(/[.\s]+$/, '') + '.' : a.reason}${a.weekly ? ` (≈$${Math.round(a.weekly)}/week)` : ''}${howTo ? ` To do: ${howTo}` : ''}${a.approvedBy ? ` — approved by ${a.approvedBy}` : ''}`;
}

export function plan(a, cfg) {
  const t = executorFor(cfg, a.vendor, a.kind, a.node);
  if (!t) throw new Error(`no executor configured for ${a.kind}${a.vendor ? ` (${a.vendor})` : ''}`);
  if (t === 'webhook') return { webhook: true, text: message(a) };
  if (t.webhook) return { webhook: true, text: message(a, t.webhook) }; // a step a person does: post what to do
  try { return { commands: t.map(argv => fill(argv, varsOf(a, cfg))) }; } catch (e) {
    // a cloud executor needs the instance: say where it comes from
    if (/\{(instance|zone|project)\}/.test(e.message)) throw new Error(`${e.message} for ${a.node}: set nodes.${a.node}.${e.message.match(/\{(\w+)\}/)[1]} in the config, or nodesFrom: a \`kubectl get nodes -o json\` file (its spec.providerID)`);
    throw e;
  }
}

const isLark = u => /(feishu\.cn|larksuite\.com|larkoffice\.com)/.test(u);
export async function postWebhook(url, text) {
  const body = isLark(url) ? { msg_type: 'text', content: { text } } : { text };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return `webhook ${res.status}`;
}

export const defaultRunner = argv => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30 * 60 * 1000 });
  return { code: r.error ? -1 : r.status, out: ((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).slice(-2000) };
};

// Run one action. Returns { ok, dryRun, commands?, text?, output }
export async function run(a, cfg, { dryRun = true, runner = defaultRunner, poster = postWebhook } = {}) {
  const p = plan(a, cfg);
  if (p.webhook) {
    if (dryRun || !cfg.notify.webhook) return { ok: true, dryRun: dryRun || !cfg.notify.webhook, text: p.text, output: cfg.notify.webhook ? 'dry-run: not posted' : 'no webhook configured: printed only' };
    return { ok: true, dryRun: false, text: p.text, output: await poster(cfg.notify.webhook, p.text) };
  }
  if (dryRun) return { ok: true, dryRun: true, commands: p.commands, output: 'dry-run: not executed' };
  const outs = [];
  for (const argv of p.commands) {
    const r = runner(argv);
    outs.push(`$ ${argv.join(' ')}\n${r.out}`);
    if (r.code !== 0) return { ok: false, dryRun: false, commands: p.commands, output: outs.join('\n') + `\nexit ${r.code}` };
  }
  return { ok: true, dryRun: false, commands: p.commands, output: outs.join('\n') };
}
