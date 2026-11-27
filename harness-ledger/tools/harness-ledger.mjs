#!/usr/bin/env node
// harness-ledger: where agent harnesses waste model resources, across harnesses. See README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { importText, detect, IMPORTERS, tracelabCall } from '../src/importers.mjs';
import { dedupe } from '../src/record.mjs';
import { ledger, text, loadOutcomes } from '../src/ledger.mjs';
import { DEFAULT_PRICES } from '../src/prices.mjs';
import { html } from '../src/html.mjs';
import { demoInputs } from '../src/demo.mjs';
import { tasksFromSwebench, tasksFromRows, outcomeReport, outcomeText } from '../src/outcomes.mjs';
import { economics, economicsText } from '../src/economics.mjs';
import { fromRest as opencostRest, fromPrometheus as opencostProm, toSelfHostPrice } from '../src/opencost.mjs';

const HELP = `harness-ledger: where agent harnesses waste model resources (tokens, dollars, GPU time), across harnesses.

  harness-ledger scan [--since 7d] [--claude DIR] [--codex DIR]       find local Claude Code and Codex logs and report on them
  harness-ledger report PATH… [options]                              report on logs, traces or exports (files or folders)
  harness-ledger import PATH… [--format F] --out calls.jsonl         convert to llm_call records (counts only, safe to share)
  harness-ledger outcomes PATH… [--json]                             outcome-labelled task runs (SWE-bench per_instance_details.json,
                                                                     or tasks as JSON/CSV): cost per success, spend on failures, call caps
  harness-ledger economics PATH… [--outcomes FILE] [self-host options] [--json]   cost per resolved task, fixes ranked by
                                                                     what they save per resolved task, and self-host vs API
  harness-ledger demo [--html FILE] [--json]                         three harnesses and a vLLM fleet, synthetic
  harness-ledger formats                                             what it reads

Inputs (detected from the file; --format to force):
  claude-code   Claude Code transcripts: ~/.claude/projects/<project>/*.jsonl (subagents included)
  codex         Codex CLI/IDE rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  otel          OpenTelemetry GenAI or OpenInference spans: OTLP JSON or one span per line (any instrumented harness)
  langfuse      Langfuse observation exports (JSON or JSON lines)
  tracelab      the TraceLab coding-agent trace (syfi_coding_trace.jsonl.gz: Claude Code and Codex, streamed)
  calls.jsonl   llm_call records written by "import"

Report options:
  --prices FILE        $/M tokens per model (input, cacheRead, cacheWrite, output, tier, downshift); defaults are examples;
                       --prices relative prices every model in the same units (cache read 0.1, write 1.25, output 5)
  --engine FILE        the serving engine's OTLP traces (vLLM llm_request spans) to charge self-hosted calls GPU time
  --replicas FILE      { "<pod>": { "gpus": 8, "gpuType": "H100", "rate": 2.5 } } or gpu-ledger usage records
  --gpu-prices FILE    gpu-ledger's price file, for replicas without a rate
  --outcomes FILE      session → success/failure (JSON object or CSV session,outcome): cost per successful task
  --since 7d|ISO       only calls after this    --harness NAME   label OTel/Langfuse input
  --cache-ttl S (300)  --big-result TOKENS (8000)   --json   --html FILE   --calls-out FILE

Economics options (with the report options above):
  --self-host-model ID --gpu ID      an open model and GPU from the Inference Sizer catalog (deepseek-v3 on H200, …): the
                                     same workload sized for the busiest day's peak (compute and KV working set)
  --ttft MS (2000) --tpot MS (50)    the targets it is sized for; --no-spare drops the sizer's spare node
  --kv-offload [--cpu-kv-gb 375] [--pcie-gbs 64]   hold the KV working set beyond HBM in host memory, reloaded over PCIe,
                                     when a reload fits the TTFT target and PCIe has room
  --calibration FILE                 measured engine efficiencies (fleetops calibrate, or a promoted shadow upgrade's
                                     <store>/calibration/sizer.json) instead of spec-sheet defaults
  --gpu-rate $/GPU-h                 what a GPU-hour costs you: monthly cost, which is cheaper, and the volume where it flips
  --self-host-success-rate R         the open model's task success rate (e.g. from SWE-bench); --api-success-rate R when
                                     there are no outcomes; --token-scale K when the open model makes K× the calls per task
  --self-host-price FILE             measured self-host prices instead of sizing: { input, cacheRead?, output } $ per M tokens
  --opencost FILE|URL                OpenCost's measured cost per token instead: its /inferenceCost/total answer (a saved file,
                                     or the OpenCost URL), or --opencost-prom URL for its llm_cost_per_million_tokens gauges;
                                     --opencost-model NAME --opencost-namespace NS pick the deployment (allocation basis)
  --days N | --tasks-per-day N       the period the input covers, or the volume to plan for
  --unit-price $ (with --prices relative)   dollars per relative unit (a million fresh input tokens) for the break-even
  --demo                             the synthetic demo input
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

// Large line-per-call traces (TraceLab is 650 MB inflated) are streamed instead of read whole.
async function streamLines(f, each) {
  const s = fs.createReadStream(f), rl = readline.createInterface({ input: f.endsWith('.gz') ? s.pipe(zlib.createGunzip()) : s, crlfDelay: Infinity });
  for await (const l of rl) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } each(o); }
}
function head(f, n = 65536) {
  const fd = fs.openSync(f, 'r'), b = Buffer.alloc(n), k = fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd);
  if (!f.endsWith('.gz')) return b.subarray(0, k).toString('utf8');
  try { return zlib.gunzipSync(b.subarray(0, k), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8'); } catch { return ''; }
}
async function load(paths, o) {
  const files = paths.flatMap(p => walk(p)), calls = [], skipped = [];
  for (const f of files) {
    if ((o.format || detect(head(f), f)) === 'tracelab') { await streamLines(f, x => { const c = x && x.input_tokens_total != null && tracelabCall(x); if (c) calls.push(c); }); continue; }
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
  const opts = { prices: o.prices === 'relative' ? 'relative' : o.prices ? readJson(o.prices) : DEFAULT_PRICES, outcomes: extra.outcomes || loadOutcomes(o.outcomes ? read(o.outcomes) : null),
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

export async function main(argv) {
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
    const { calls, files, skipped } = await load(dirs, { ...o, since: o.since || '30d' });
    process.stderr.write(`scanned ${files} files in ${dirs.join(', ')}${skipped.length ? `; ${skipped.length} not recognised` : ''}\n`);
    return report(calls, o);
  }
  if (cmd === 'economics') {
    let calls, extra = {};
    if (o.demo) { const d = demoInputs(); calls = d.files.flatMap(f => importText(f.text, { file: f.name })); extra = { engine: d.engine, replicas: d.replicas, outcomes: new Map(Object.entries(d.outcomes)) }; }
    else { if (!paths.length) { process.stderr.write('harness-ledger economics: give files or folders (or --demo)\n'); return 2; } ({ calls } = await load(paths, o)); }
    if (!calls.length) { process.stderr.write('harness-ledger: no model calls found in the input\n'); return 1; }
    const opts = { prices: o.prices === 'relative' ? 'relative' : o.prices ? readJson(o.prices) : DEFAULT_PRICES, outcomes: extra.outcomes || loadOutcomes(o.outcomes ? read(o.outcomes) : null),
      engineSpans: extra.engine || (o.engine ? read(o.engine) : null), replicas: extra.replicas || (o.replicas ? readJson(o.replicas) : null), gpuPrices: o['gpu-prices'] ? readJson(o['gpu-prices']) : {} };
    if (o['cache-ttl']) opts.cacheTtlS = Number(o['cache-ttl']);
    const r = ledger(calls, opts), n = k => (o[k] != null && o[k] !== true ? Number(o[k]) : undefined);
    let selfHostPrice = o['self-host-price'] ? readJson(o['self-host-price']) : null;
    const ocPick = { model: o['opencost-model'] || null, namespace: o['opencost-namespace'] || null };
    if (o.opencost) {
      const src = String(o.opencost);
      const j = /^https?:\/\//.test(src) ? await (await fetch(`${src.replace(/\/$/, '')}/inferenceCost/total?window=${o['opencost-window'] || '7d'}&aggregate=model_name,namespace&costBasis=allocation`)).json() : readJson(src);
      selfHostPrice = toSelfHostPrice(opencostRest(j, ocPick));
    } else if (o['opencost-prom']) selfHostPrice = toSelfHostPrice(await opencostProm(String(o['opencost-prom']), { ...ocPick, window: o['opencost-window'] || '24h' }));
    const E = economics(r.calls, r.report, { model: o['self-host-model'] || undefined, gpu: o.gpu || undefined, ttft: n('ttft'), tpot: n('tpot'), gpuRate: n('gpu-rate'),
      selfSuccessRate: n('self-host-success-rate'), apiSuccessRate: n('api-success-rate'), tokenScale: n('token-scale'), days: n('days'), tasksPerDay: n('tasks-per-day'), unitPrice: n('unit-price'),
      selfHostPrice, cacheTtlS: opts.cacheTtlS, spare: !o['no-spare'], calibration: o.calibration ? readJson(o.calibration) : null, kvOffload: !!o['kv-offload'], cpuKvGB: n('cpu-kv-gb'), pcieGBs: n('pcie-gbs') });
    process.stdout.write(o.json ? JSON.stringify(E, null, 1) + '\n' : economicsText(E));
    return 0;
  }
  if (cmd === 'outcomes') {
    if (!paths.length) { process.stderr.write('harness-ledger outcomes: give per_instance_details.json files, folders of them, or task JSON/CSV\n'); return 2; }
    const tasks = [];
    for (const f of paths.flatMap(p => walk(p)).concat(paths.flatMap(p => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter(x => x.endsWith('.csv')).map(x => path.join(p, x)) : p.endsWith('.csv') ? [p] : [])))) {
      const run = path.basename(f).replace(/\.(json|csv)(\.gz)?$/, '').replace(/^per_instance_details$/, path.basename(path.dirname(f)));
      if (f.endsWith('.csv')) { const [h, ...ls] = read(f).trim().split(/\r?\n/); const ks = h.split(',').map(x => x.trim()); tasks.push(...tasksFromRows(ls.map(l => Object.fromEntries(l.split(',').map((v, i) => [ks[i], v.trim()]))), { run })); continue; }
      const j = readJson(f);
      if (Array.isArray(j)) { tasks.push(...tasksFromRows(j, { run })); continue; }
      // a sibling metadata.yaml (SWE-bench experiments layout) names the model
      const meta = [f.replace(/\.json$/, '.yaml'), path.join(path.dirname(f), 'metadata.yaml')].find(x => fs.existsSync(x));
      const name = meta && (read(meta).match(/^\s*name:\s*(.+)$/m) || [])[1];
      tasks.push(...tasksFromSwebench(j, { run, model: name ? name.trim() : null }));
    }
    const R = outcomeReport(tasks);
    process.stdout.write(o.json ? JSON.stringify(R, null, 1) + '\n' : outcomeText(R));
    return R.runs.length ? 0 : 1;
  }
  if (cmd === 'import' || cmd === 'report') {
    if (!paths.length) { process.stderr.write(`harness-ledger ${cmd}: give files or folders\n`); return 2; }
    if (o.format && !IMPORTERS[o.format]) { process.stderr.write(`--format: one of ${Object.keys(IMPORTERS).join(', ')}\n`); return 2; }
    const { calls, files, skipped } = await load(paths, o);
    if (skipped.length) process.stderr.write(`not recognised (pass --format): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}\n`);
    if (cmd === 'report') return report(calls, o);
    const body = calls.map(c => JSON.stringify(c)).join('\n') + (calls.length ? '\n' : '');
    if (o.out) { fs.writeFileSync(o.out, body); process.stderr.write(`${calls.length} calls from ${files} files → ${o.out}\n`); } else process.stdout.write(body);
    return 0;
  }
  process.stderr.write(`harness-ledger: unknown command "${cmd}"\n\n${HELP}`); return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`harness-ledger: ${e.message}\n`); process.exitCode = 1; });
}
