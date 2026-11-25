#!/usr/bin/env node
// gpu-ledger: GPU billing and waste, for any cluster. See README.md.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as A from '../src/adapters.mjs';
import * as Cloud from '../src/cloud.mjs';
import { ledger, groupBy, budgets as budgetsOf, loaded } from '../src/ledger.mjs';
import { insights, sizerFrom } from '../src/insights.mjs';
import { reportText, showbackCsv, focusCsv, toCsv } from '../src/export.mjs';
import { html } from '../src/html.mjs';
import { rateCard } from '../src/core.mjs';
import { demo } from '../src/demo.mjs';

const HELP = `gpu-ledger: who used which GPUs, what it cost, how much of it was useful, and where to save.

Bring usage in (appends to --out, JSON lines):
  gpu-ledger import k8s --pods pods.json [--nodes nodes.json] [--prom dcgm_sm.json,dcgm_fb_used.json,dcgm_fb_free.json,vllm_tokens.json] [--cluster C] --out usage.jsonl
  gpu-ledger import slurm sacct.txt [--cluster C] [--gpu-type H100] --out usage.jsonl
        (sacct -a -P -X --format=JobID,JobName,User,Account,Partition,State,Start,End,NodeList,AllocTRES)
  gpu-ledger import opencost allocation.json [--cluster C] --out usage.jsonl     (/allocation?aggregate=pod&step=1h)
  gpu-ledger import csv FILE [--map start=Start,end=End,gpus=GPUs,user=Owner,...] --out usage.jsonl
  gpu-ledger import aws-cur cur.csv[.gz] [--cluster C] --out usage.jsonl          (AWS CUR 2.0 or legacy CUR, with resource IDs)
  gpu-ledger import acme acme_trace_kalos.csv --out usage.jsonl                    (public trace)
  gpu-ledger import philly --jobs cluster_job_log --util cluster_gpu_util --machines cluster_machine_list [--from T --to T] [--capacity-out cap.json] --out usage.jsonl

Read it (every command takes --usage FILE[,FILE] and --config ledger.json, or --prices, --attribution, --capacity,
--budgets, --policy separately; --from/--to as ISO dates or epoch seconds; --json):
  gpu-ledger report [--by org,team] [--top 10] [--format text|md|json|html] [--out FILE]
  gpu-ledger insights [--top 20]                    where to save, per month, with evidence, owner and basis
  gpu-ledger showback [--by org,team,user,project,useCase,gpuType] [--period month|week|day] --out showback.csv
  gpu-ledger focus --out focus.csv [--account ID]    FOCUS 1.4 cost-and-usage rows (+ x_ columns for the classes)
  gpu-ledger rates                                   the price per GPU-hour per type and provider, with its parts
  gpu-ledger demo [--out DIR]                        a demo org with planted waste (files + the commands to try)

Classes: every allocated GPU-hour is useful, idle (allocated, GPU not working: needs utilization) or lost (work a
failure or preemption threw away: since the last checkpoint when known, otherwise estimated, and all of it when every
attempt failed). Capacity nobody allocated is counted per cluster and GPU type (--capacity).`;

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v == null || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } else o._.push(a); } return o; }
const o = args(process.argv.slice(2)), J = !!o.json, opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined);
const read = f => fs.readFileSync(f, 'utf8'), json = f => JSON.parse(read(f));
const time = s => (s == null ? undefined : /^\d+(\.\d+)?$/.test(s) ? +s : Math.floor(Date.parse(s) / 1000));
const say = s => { if (!J) process.stdout.write(s.endsWith('\n') ? s : s + '\n'); };
const here = path.dirname(fileURLToPath(import.meta.url));

function writeUsage(recs) {
  const out = opt('out'); if (!out) throw new Error('--out usage.jsonl');
  fs.appendFileSync(out, recs.map(r => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
  const gh = recs.reduce((a, r) => a + r.gpus * (((r.end ?? r.start) - r.start) / 3600), 0);
  if (J) console.log(JSON.stringify({ records: recs.length, gpuHours: gh, out })); else say(`${recs.length} usage record(s), ${Math.round(gh).toLocaleString('en-US')} GPU-h → ${out}`);
}
function loadUsage() {
  const files = (opt('usage') || '').split(',').filter(Boolean); if (!files.length) throw new Error('--usage usage.jsonl (gpu-ledger import … first, or gpu-ledger demo)');
  const recs = []; for (const f of files) for (const l of read(f).split('\n')) if (l.trim()) recs.push(JSON.parse(l));
  return recs;
}
function loadConfig() {
  const c = opt('config') ? json(opt('config')) : {};
  for (const k of ['prices', 'attribution', 'capacity', 'budgets', 'policy', 'models', 'thresholds']) if (opt(k)) c[k] = json(opt(k));
  if (c.attribution && typeof c.attribution.directory === 'string') { const f = c.attribution.directory, base = opt('config') ? path.dirname(opt('config')) : '.'; c.attribution.directory = directory(fs.existsSync(f) ? f : path.join(base, f)); }
  return c;
}
// people.csv: user,team,org → { user: { team, org } }
function directory(f) { return Object.fromEntries(A.parseCsv(read(f)).map(r => [r.user, { team: r.team, org: r.org }])); }
function sizer() {
  const p = opt('sizer') || path.join(here, '..', '..', 'inference-sizer', 'src');
  try { const req = createRequire(import.meta.url); const SC = req(path.join(p, 'catalog.js')), SM = req(path.join(p, 'model.js')), FIT = req(path.join(p, 'fit.js')); return sizerFrom(FIT, SC, SM); } catch { return null; }
}
function build() {
  const c = loadConfig(), L = ledger(loadUsage(), { from: time(opt('from')), to: time(opt('to')), prices: c.prices, attribution: c.attribution, capacity: c.capacity, policy: c.policy });
  return { c, L };
}

async function main() {
  const [cmd, sub] = o._;
  if (!cmd || o.help || cmd === 'help') return say(HELP);
  if (cmd === 'import') {
    const f = o._[2], text = () => read(f), common = { cluster: opt('cluster'), provider: opt('provider') };
    if (sub === 'k8s') return writeUsage(A.k8s(Object.assign({ pods: json(opt('pods')), nodes: opt('nodes') ? json(opt('nodes')) : null, prom: (opt('prom') || '').split(',').filter(Boolean).map(json) }, common)));
    if (sub === 'slurm') return writeUsage(A.slurm(text(), Object.assign({ gpuType: opt('gpu-type') }, common)));
    if (sub === 'opencost') return writeUsage(A.opencost(json(f), common));
    if (sub === 'csv') return writeUsage(A.csv(text(), Object.assign({ map: Object.fromEntries((opt('map') || '').split(',').filter(Boolean).map(x => x.split('='))) }, common)));
    if (sub === 'aws-cur') { const recs = Cloud.awsCur(f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString() : text(), common); if (!J) process.stderr.write(`aws-cur: ${recs.length} GPU instance line(s); skipped ${JSON.stringify(recs.skipped)}${recs.unknownTypes.length ? `; GPU-like instance types not in the registry: ${recs.unknownTypes.join(', ')}` : ''}\n`); return writeUsage(recs); }
    if (sub === 'acme') return writeUsage(A.acme(text(), { cluster: opt('cluster') || 'kalos' }));
    if (sub === 'philly') { const recs = await A.philly({ jobs: json(opt('jobs')), utilPath: opt('util'), machines: opt('machines') ? A.phillyMachines(read(opt('machines'))) : [], from: time(opt('from')), to: time(opt('to')) }); if (opt('capacity-out')) { fs.writeFileSync(opt('capacity-out'), JSON.stringify(recs.inventory, null, 1)); say(`capacity (GPUs reporting utilization) → ${opt('capacity-out')}`); } return writeUsage(recs); }
    throw new Error('import k8s | slurm | opencost | csv | aws-cur | acme | philly');
  }
  if (cmd === 'demo') {
    const dir = opt('out') || 'ledger-demo', d = demo(); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'usage.jsonl'), d.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ prices: d.prices, attribution: d.attribution, capacity: d.capacity, budgets: d.budgets }, null, 1));
    const base = `--usage ${dir}/usage.jsonl --config ${dir}/ledger.json`;
    if (J) return console.log(JSON.stringify({ dir, records: d.records.length, answers: d.answers }));
    return say(`demo org in ${dir}/: ${d.records.length} usage records over a week, two clusters, planted waste.\n\ntry:\n  gpu-ledger report ${base} --by org,team\n  gpu-ledger insights ${base}\n  gpu-ledger report ${base} --format html --out ${dir}/ledger.html\n  gpu-ledger focus ${base} --out ${dir}/focus.csv\n\nshould find: ${d.answers.kinds.join(', ')}`);
  }
  if (cmd === 'rates') {
    const card = rateCard(loadConfig().prices || {}); if (J) return console.log(JSON.stringify({ rates: card }));
    for (const [g, ps] of Object.entries(card)) for (const [p, r] of Object.entries(ps)) say(`${g.padEnd(10)} ${p.padEnd(10)} $${r.rate.toFixed(3)}/GPU-h${r.parts ? `  (capex ${r.parts.capex.toFixed(3)} + power ${r.parts.power.toFixed(3)} + opex ${r.parts.opex.toFixed(3)})` : '  (list)'}`);
    return;
  }
  const { c, L } = build();
  const ins = () => insights(L, { opts: c.thresholds, sizer: sizer(), models: c.models || {} });
  const bud = budgetsOf(L, c.budgets || {});
  const by = (opt('by') || 'org,team').split(','), top = +(opt('top') || 10);
  if (cmd === 'report') {
    const fmt = opt('format') || (J ? 'json' : 'text'), I = ins();
    let s;
    if (fmt === 'json') s = JSON.stringify({ from: L.from, to: L.to, currency: L.currency, totals: L.totals, coverage: L.coverage, unallocated: L.unallocated, lostBases: L.lostBases, groups: loaded(L, groupBy(L, by)), budgets: bud, insights: I }, null, 1);
    else if (fmt === 'html') s = html(L, { by, ins: I, budgets: bud });
    else s = reportText(L, { by, ins: I, top, budgets: bud, md: fmt === 'md' });
    if (opt('out')) { fs.writeFileSync(opt('out'), s); if (!J) say(`wrote ${opt('out')}`); } else process.stdout.write(s.endsWith('\n') ? s : s + '\n');
    return;
  }
  if (cmd === 'insights') { const I = ins(); if (J) return console.log(JSON.stringify({ insights: I })); return say(reportText(L, { by, ins: I, top: +(opt('top') || 20) }).split(/\n(?=Where to save)/)[1] || 'nothing above the thresholds'); }
  if (cmd === 'showback') { const s = showbackCsv(L, { by: opt('by') ? by : undefined, period: opt('period') || 'month' }); if (opt('out')) { fs.writeFileSync(opt('out'), s); say(`wrote ${opt('out')}`); } else process.stdout.write(s); return; }
  if (cmd === 'focus') { const s = focusCsv(L, { account: opt('account') || 'gpu-ledger', provider: opt('provider-name') || 'On-premises' }); if (opt('out')) { fs.writeFileSync(opt('out'), s); say(`wrote ${opt('out')} (${s.split('\n').length - 2} rows)`); } else process.stdout.write(s); return; }
  throw new Error(`unknown command: ${cmd} (gpu-ledger --help)`);
}
main().catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error(`error: ${e.message}`); process.exit(1); });
