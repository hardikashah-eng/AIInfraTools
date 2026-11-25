#!/usr/bin/env node
// harness-ledger: where agent harnesses waste model resources, across harnesses. See README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { importText, detect, IMPORTERS } from '../src/importers.mjs';
import { dedupe } from '../src/record.mjs';
import { ledger, text, loadOutcomes } from '../src/ledger.mjs';
import { DEFAULT_PRICES } from '../src/prices.mjs';
import { html } from '../src/html.mjs';
import { demoInputs } from '../src/demo.mjs';

const HELP = `harness-ledger: where agent harnesses waste model resources (tokens, dollars, GPU time), across harnesses.

  harness-ledger scan [--since 7d] [--claude DIR] [--codex DIR]       find local Claude Code and Codex logs and report on them
  harness-ledger report PATH… [options]                              report on logs, traces or exports (files or folders)
  harness-ledger import PATH… [--format F] --out calls.jsonl         convert to llm_call records (counts only, safe to share)
  harness-ledger demo [--html FILE] [--json]                         three harnesses and a vLLM fleet, synthetic
  harness-ledger formats                                             what it reads

Inputs (detected from the file; --format to force):
  claude-code   Claude Code transcripts: ~/.claude/projects/<project>/*.jsonl (subagents included)
  codex         Codex CLI/IDE rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  otel          OpenTelemetry GenAI or OpenInference spans: OTLP JSON or one span per line (any instrumented harness)
  langfuse      Langfuse observation exports (JSON or JSON lines)
  calls.jsonl   llm_call records written by "import"

Report options:
  --prices FILE        $/M tokens per model (input, cacheRead, cacheWrite, output, tier, downshift); defaults are examples
  --engine FILE        the serving engine's OTLP traces (vLLM llm_request spans) to charge self-hosted calls GPU time
  --replicas FILE      { "<pod>": { "gpus": 8, "gpuType": "H100", "rate": 2.5 } } or gpu-ledger usage records
  --gpu-prices FILE    gpu-ledger's price file, for replicas without a rate
  --outcomes FILE      session → success/failure (JSON object or CSV session,outcome): cost per successful task
  --since 7d|ISO       only calls after this    --harness NAME   label OTel/Langfuse input
  --cache-ttl S (300)  --big-result TOKENS (8000)   --json   --html FILE   --calls-out FILE
`;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v != null) o[k] = v; else if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) o[k] = argv[++i]; else o[k] = true; }
    else o._.push(a);
  }
  return o;
}
const read = f => { const b = fs.readFileSync(f); return (f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8'); };
const readJson = f => JSON.parse(read(f));
function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) if (!e.startsWith('.') || e === '.claude' || e === '.codex') walk(path.join(p, e), out); }
  else if (/\.(jsonl|json|ndjson)(\.gz)?$/.test(p)) out.push(p);
  return out;
}
function since(v) {
  if (!v) return -Infinity;
  const m = String(v).match(/^(\d+(?:\.\d+)?)([hdw])$/); if (m) return Date.now() / 1000 - Number(m[1]) * { h: 3600, d: 86400, w: 604800 }[m[2]];
  const t = Date.parse(v); if (!Number.isFinite(t)) throw new Error(`--since: can't read ${v}`); return t / 1000;
}

function load(paths, o) {
  const files = paths.flatMap(p => walk(p)), calls = [], skipped = [];
  for (const f of files) {
    const txt = read(f);
    if (/^\s*\{"kind":"llm_call"/.test(txt)) { for (const l of txt.split(/\r?\n/)) if (l.trim()) calls.push(JSON.parse(l)); continue; }
    const kind = o.format || detect(txt, f);
    if (!kind) { skipped.push(f); continue; }
    try { calls.push(...importText(txt, { kind, file: f, harness: o.harness })); } catch (e) { skipped.push(`${f} (${e.message})`); }
  }
  const from = since(o.since);
  return { calls: dedupe(calls).filter(c => c.t == null || c.t >= from), files: files.length, skipped };
}

function report(calls, o, extra = {}) {
  if (!calls.length) { process.stderr.write('harness-ledger: no model calls found in the input\n'); return 1; }
  const opts = { prices: o.prices ? readJson(o.prices) : DEFAULT_PRICES, outcomes: extra.outcomes || loadOutcomes(o.outcomes ? read(o.outcomes) : null),
    engineSpans: extra.engine || (o.engine ? read(o.engine) : null), replicas: extra.replicas || (o.replicas ? readJson(o.replicas) : null), gpuPrices: o['gpu-prices'] ? readJson(o['gpu-prices']) : {} };
  if (o['cache-ttl']) opts.cacheTtlS = Number(o['cache-ttl']);
  if (o['big-result']) opts.bigResultTokens = Number(o['big-result']);
  const r = ledger(calls, opts);
  if (o['calls-out']) fs.writeFileSync(o['calls-out'], r.calls.map(c => JSON.stringify(c)).join('\n') + '\n');
  if (o.html) { fs.writeFileSync(o.html, html(r.report)); process.stderr.write(`wrote ${o.html}\n`); }
  if (o.json) process.stdout.write(JSON.stringify({ ...r.report, findings: o.findings ? r.findings : undefined }, null, 2) + '\n');
  else if (!o.html || o.text) process.stdout.write(text(r.report));
  return 0;
}

export function main(argv) {
  const o = args(argv), [cmd, ...paths] = o._;
  if (!cmd || o.help || cmd === 'help') { process.stdout.write(HELP); return 0; }
  if (cmd === 'formats') { process.stdout.write(HELP.slice(HELP.indexOf('Inputs'), HELP.indexOf('Report options'))); return 0; }
  if (cmd === 'demo') {
    const d = demoInputs(), calls = d.files.flatMap(f => importText(f.text, { file: f.name }));
    return report(calls, o, { engine: d.engine, replicas: d.replicas, outcomes: new Map(Object.entries(d.outcomes)) });
  }
  if (cmd === 'scan') {
    const home = os.homedir(), dirs = [o.claude || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'), o.codex || path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions')].filter(d => fs.existsSync(d));
    if (!dirs.length) { process.stderr.write('harness-ledger scan: no ~/.claude/projects or ~/.codex/sessions here; pass --claude DIR or --codex DIR, or use "report PATH"\n'); return 1; }
    const { calls, files, skipped } = load(dirs, { ...o, since: o.since || '30d' });
    process.stderr.write(`scanned ${files} files in ${dirs.join(', ')}${skipped.length ? `; ${skipped.length} not recognised` : ''}\n`);
    return report(calls, o);
  }
  if (cmd === 'import' || cmd === 'report') {
    if (!paths.length) { process.stderr.write(`harness-ledger ${cmd}: give files or folders\n`); return 2; }
    if (o.format && !IMPORTERS[o.format]) { process.stderr.write(`--format: one of ${Object.keys(IMPORTERS).join(', ')}\n`); return 2; }
    const { calls, files, skipped } = load(paths, o);
    if (skipped.length) process.stderr.write(`not recognised (pass --format): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}\n`);
    if (cmd === 'report') return report(calls, o);
    const body = calls.map(c => JSON.stringify(c)).join('\n') + (calls.length ? '\n' : '');
    if (o.out) { fs.writeFileSync(o.out, body); process.stderr.write(`${calls.length} calls from ${files} files → ${o.out}\n`); } else process.stdout.write(body);
    return 0;
  }
  process.stderr.write(`harness-ledger: unknown command "${cmd}"\n\n${HELP}`); return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`harness-ledger: ${e.message}\n`); process.exitCode = 1; }
}
