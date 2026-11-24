#!/usr/bin/env node
// fleetops: the shared data layer for AIInfraTools, with calibration, root-cause analysis and optimization on top.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStore, whereFrom, openStore, SCHEMA } from '../src/store.mjs';
import * as Retention from '../src/retention.mjs';
import { migrate } from '../src/migrate.mjs';
import * as Ingest from '../src/ingest.mjs';
import * as Traces from '../src/traces.mjs';
import { readLines } from '../src/lines.mjs';
import * as Philly from '../src/adapters/philly.mjs';
import * as Pub from '../src/adapters/public.mjs';
import * as Live from '../src/adapters/live.mjs';
import { toEpoch } from '../src/adapters/time.mjs';
import * as Logs from '../src/adapters/logs.mjs';
import * as Topo from '../src/adapters/topology.mjs';
import { writeGpuHealth, toFleetScopeTrace } from '../src/export.mjs';
import * as Calib from '../src/calibrate.mjs';
import * as RCA from '../src/rca.mjs';
import * as Opt from '../src/optimize.mjs';
import * as Detect from '../src/detect.mjs';
import * as Bench from '../src/bench.mjs';
import * as Inject from '../src/inject.mjs';
import { loadConfig as ghConfig } from '../../gpu-health/src/config.mjs';
import { createRequire } from 'node:module';
const FSIN = createRequire(import.meta.url)('../../fleetscope/src/ingest.js');

const HELP = `fleetops — shared data layer for AIInfraTools

  fleetops data import SOURCE FILE... [--store DIR] [options]     load records into the store
  fleetops data summary [--store DIR]                             records per kind, time range and sources
  fleetops data query KIND [--from T] [--to T] [--where k=v]... [--limit N]
  fleetops data node NODE [--from T] [--to T]                    versions, shared switch/rack/PDU, log faults, changes
  fleetops data requests [--from T] [--to T]                     per-request records (stages, replica) from stored spans
  fleetops data rollup [--steps 60,3600]                         minute and hour device rollups (rollup-60/, rollup-3600/)
  fleetops data compact [--raw-days 7] [--apply]                 drop old raw device/request/span days after rolling up,
                                                                 keeping incident windows at full resolution (keep/)
  fleetops data migrate [--apply]                                bring the store to the current schema version
  fleetops serve [--port 9400] [--host 127.0.0.1] [--site S] [--max-queue 200000] [--flush-ms 1000]
        ingest Prometheus remote_write and OTLP/HTTP JSON (metrics, logs, traces) into the store
  fleetops data export gpu-health --out DIR [--from T] [--to T]   samples.jsonl, jobs.json, results.jsonl for gpu-health
  fleetops data export fleetscope-trace --out FILE [--pool P]     CSV for FleetScope's Trace replay node

Sources (SOURCE):
  exporter         DCGM / AMD / SambaNova exporter text      [--vendor V] [--t EPOCH] [--site S]
  vllm             vLLM /metrics snapshot                   --pool P [--before FILE | --window S] [--model M] [--gpu G] [--t EPOCH]
  prom-range       Prometheus query_range JSON              --field ttftP99|tpotP99|rate|kvUsage|… [--pool P]
  k8s-nodes        kubectl get nodes -o json                 inventory with versions; rack and zone edges
  k8s-pods         kubectl get pods -A -o json
  slurm-nodes      scontrol show node -o                     (kernel version from OS=)
  nvidia-smi-q     nvidia-smi -q                             [--node N] (default: file name)  versions, serials, PCI → GPU map
  nvidia-topo      nvidia-smi topo -m                        [--node N]  NVLink and NIC affinity
  ibnetdiscover    ibnetdiscover                             host → leaf → spine
  racks            CSV: node,rack,row,pdu,site
  kernel-log       journalctl -k -o short-iso | dmesg -T | dmesg | syslog   [--node N] [--boot T] [--year Y] [--utc-offset H]
                   XID, NVLink, PCIe AER, AMD RAS, MCE, IB link, NFS/Lustre, OOM (GPU index from nvidia-smi-q imports)
  app-log          NCCL / PyTorch job output                 [--node N] [--job J] [--t T]
  k8s-events       kubectl get events -A -o json             cordon/reboot/scale changes; NotReady/OOM/mount/evict logs
  helm-history     helm history REL -n NS -o json            [--release R] [--namespace NS]
  otlp-traces      OTLP/JSON traces (resourceSpans)          [--derive] (also write per-request records)
  kineto           PyTorch profiler trace JSON (one rank)    [--job J] [--node N] [--rank R] [--t0 T]   per-rank steps
  step-log         JSON lines {t, rank, node, step, durS, commS?, dataS?, ckptS?, mfu?}   [--job J]
  sacct            sacct -P -X --format=JobID,JobName,State,ExitCode,Start,End,NodeList,AllocTRES
  changes          JSON lines of change events
  git-log          git log --date=unix --pretty=format:'@@%H|%ad|%an|%s' --name-only   [--repo NAME]
  gpu-health       a gpu-health state directory (events.jsonl, results.jsonl)
  philly-machines  Philly cluster_machine_list
  philly-gpu       Philly cluster_gpu_util                  [--from T] [--to T] [--step MIN] [--machines N|m1,m2]
  philly-jobs      Philly cluster_job_log                   [--from T] [--to T]
  azure-llm        Azure LLM inference trace CSV            [--pool P] [--limit N]
  mlperf           MLPerf mlperf_log_summary.txt files      [--isl N] (the path names the system, model and scenario)
  acme             AcmeTrace job trace CSV                  [--cluster NAME]

Calibration (fits are stored as calibration records; profiles are JSON files the tools read):
  fleetops calibrate benchmarks [--isl N] [--no-fleetscope] [--profile OUT]
        fit the Inference Sizer (and FleetScope) to benchmark records; runs named *interactive* are held out and checked
  fleetops calibrate serving --graph G [--from T] [--to T] [--holdout 0.25] [--profile OUT] [--graph-out G2] [--every SECONDS]
        fit each FleetScope pool of a graph to its serving records; --every re-fits on a schedule
  fleetops calibrate drift --graph G --profile P [--from T] [--to T] [--fail-on-drift]
        simulate the latest window with the stored multipliers; outside the 10%/20% bar → a drift record
  fleetops calibrate apply --graph G --profile P --out G2      write the multipliers into a FleetScope graph

Root-cause analysis (diagnoses are stored as incident records):
  fleetops rca detect [--from T] [--to T] [--min-failures 20] [--targets targets.json] [--diagnose] [--format md]
        find job-failure and latency incidents (seasonal baseline + CUSUM, grouped); --diagnose ranks causes for each
  fleetops rca diagnose --symptom job-failures|latency|device --from T --to T [--pool P] [--nodes n1,n2] [--format md]
  fleetops rca eval --labels FILE      top-1 / top-3 accuracy on labeled incidents (JSON lines: { incident, cause })
  fleetops rca bench [--per-cause 10] [--seed 1] [--only PREFIX] [--injections] [--labels FILE] [--weights W] [--fit OUT]
        [--min-top1 0.8] [--min-top3 0.95]
        accuracy per cause on synthetic scenarios (default), injected faults and/or postmortem labels; --fit writes rule
        weights fitted on the labels (held-out accuracy reported); exit 5 below the bar
  detect/diagnose/bench take --weights W. detect: --method cusum (default) | threshold, --bin S, --group-gap S, --where k=v

Fault injection on a TEST cluster (dry-run unless --live; every target must be in the --allow file):
  fleetops inject list
  fleetops inject FAULT --allow FILE [--for S] [--live] [--expect RULE] --param value …   writes an injection label

Optimization with safe execution (rollback is automatic; applying a stage always needs approval):
  fleetops optimize candidates [--from T] [--to T] [--price 4] [--max-attempts 2] [--graph G [--trace-pool P [--trace-from T --trace-to T]] [--target 0.99]] [--out cands.json]
        candidate changes from gpu-health (right-size, scale-in, reclaim), rca (retry storms) and FleetScope (pool sizes)
  fleetops optimize plan --candidates cands.json --out plan.json [--save-pct 20] [--baseline-weekly $] [--max-risk medium]
        [--guards guards.json] [--deployments deploy.json] [--bake 1800] [--state DIR]
        pick a set that meets the goal, stage it, and queue every stage for approval in gpu-health's queue
  fleetops optimize advance --plan plan.json [--state DIR] [--config gpu-health.json] [--live]
        check the last stage's SLO guard (regression → roll back, no approval needed), then run the next approved stage
  fleetops optimize verify --plan plan.json [--days 7]     before/after GPU-hours and guard breaches → an optimization record
  Approve a stage with: gpu-health actions approve ID --by NAME --state DIR   (DIR defaults to <store>/rollouts/state)

Times (T) are ISO dates or epoch seconds. Common: --store DIR (default ./fleet-data), --backend jsonl|parquet (new stores;
parquet needs \`npm install --no-save @duckdb/node-api@2.0.1-r.1\` in fleetops/), --json.`;

function args(argv) {
  const o = { _: [], where: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), nx = argv[i + 1], v = nx === undefined || nx.startsWith('--') ? true : (i++, nx); if (k === 'where') o.where.push(v); else o[k] = v; }
    else o._.push(a);
  }
  return o;
}
let J = false; const OUT = {};
const say = (...a) => { if (!J) console.log(...a); };
const read = f => fs.readFileSync(f, 'utf8');
const time = v => (v == null || v === true ? undefined : toEpoch(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v));
const fmt = t => (Number.isFinite(t) ? new Date(t * 1000).toISOString().replace('.000', '') : '–');

// PCI address → GPU index per node, from the latest nvidia-smi -q inventory in the store (for kernel logs).
function pciMap(store) {
  const m = {};
  for (const r of store.scan('inventory', { where: r => Array.isArray(r.gpus) })) { m[r.node] = m[r.node] || {}; for (const g of r.gpus) if (g.pci) m[r.node][g.pci] = g.gpu; }
  return m;
}
function importSource(store, src, files, o) {
  const from = time(o.from), to = time(o.to), res = [];
  const put = (kind, recs) => { const r = store.append(kind, recs, { dedupe: true }); res.push(r); return r; };
  const tOf = f => (o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000));
  const nodeOf = f => (o.node && o.node !== true ? o.node : path.basename(f).replace(/\.(txt|log|out)$/, ''));
  // inventory with versions: a version that differs from the node's previous snapshot becomes a change record
  let lastByNode = null;
  const putInventory = recs => {
    if (!lastByNode) { lastByNode = new Map(); for (const r of store.scan('inventory', { where: r => r.versions })) { const p = lastByNode.get(r.node); if (!p || p.t < r.t) lastByNode.set(r.node, r); } }
    const changes = [];
    for (const r of recs.slice().sort((a, b) => a.t - b.t)) { if (r.versions) { changes.push(...Topo.versionChanges(lastByNode.get(r.node), r)); const p = lastByNode.get(r.node); if (!p || p.t < r.t) lastByNode.set(r.node, r); } }
    put('inventory', recs);
    if (changes.length) put('change', changes);
  };
  const each = f => (fs.statSync(f).isDirectory() ? [f] : [f]);
  for (const f of files.flatMap(each)) {
    switch (src) {
      case 'exporter': put('device', Live.exporterScrape(read(f), { vendor: o.vendor !== true ? o.vendor : undefined, t: o.t ? +o.t : Math.floor(fs.statSync(f).mtimeMs / 1000), site: o.site })); break;
      case 'vllm': put('serving', [Live.vllmSnapshot(read(f), { before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: o.t ? +o.t : Math.floor(fs.statSync(f).mtimeMs / 1000), pool: o.pool || 'default', model: o.model, gpu: o.gpu })]); break;
      case 'prom-range': if (!o.field) throw new Error('prom-range needs --field'); put('serving', Live.promRange(read(f), { field: o.field, pool: o.pool })); break;
      case 'k8s-nodes': putInventory(Live.k8sNodes(read(f), { t: tOf(f) })); put('topology', Live.k8sNodeTopology(read(f), { t: tOf(f) })); break;
      case 'k8s-pods': put('placement', Live.k8sPods(read(f))); break;
      case 'slurm-nodes': putInventory(Live.slurmNodes(read(f), { t: tOf(f) })); break;
      case 'nvidia-smi-q': putInventory([Topo.nvidiaSmiQ(read(f), { node: nodeOf(f), t: tOf(f) }).inventory]); break;
      case 'nvidia-topo': put('topology', Topo.nvidiaTopo(read(f), { node: nodeOf(f), t: tOf(f) })); break;
      case 'ibnetdiscover': put('topology', Topo.ibnetdiscover(read(f), { t: tOf(f) })); break;
      case 'racks': put('topology', Topo.racks(read(f), { t: tOf(f) })); break;
      case 'kernel-log': put('log', Logs.kernelLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, boot: time(o.boot), year: o.year ? +o.year : undefined, utcOffset: o['utc-offset'] ? +o['utc-offset'] : 0, pciMap: pciMap(store) })); break;
      case 'app-log': put('log', Logs.ncclLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, job: o.job && o.job !== true ? o.job : undefined, t: o.t ? time(o.t) : tOf(f) })); break;
      case 'k8s-events': { const e = Live.k8sEvents(read(f)); put('change', e.changes); put('log', e.logs); break; }
      case 'kineto': put('step', Traces.kineto(read(f), { job: o.job && o.job !== true ? o.job : path.basename(f).split(/[._]/)[0], node: o.node && o.node !== true ? o.node : undefined, rank: o.rank != null && o.rank !== true ? +o.rank : undefined, t0: o.t0 ? time(o.t0) : undefined })); break;
      case 'step-log': put('step', Traces.stepLog(read(f), { job: o.job && o.job !== true ? o.job : undefined })); break;
      case 'otlp-traces': { const spans = Ingest.otlpTracesToSpans(JSON.parse(read(f))); put('span', spans); if (o.derive) put('request', Traces.requestsFromSpans(spans)); break; }
      case 'helm-history': put('change', Live.helmHistory(read(f), { release: o.release && o.release !== true ? o.release : path.basename(f, '.json'), namespace: o.namespace && o.namespace !== true ? o.namespace : 'default' })); break;
      case 'sacct': put('job', Live.slurmSacct(read(f))); break;
      case 'changes': put('change', Live.changesJsonl(read(f))); break;
      case 'git-log': put('change', Live.gitLog(read(f), { repo: o.repo || path.basename(f) })); break;
      case 'gpu-health': {
        const ev = path.join(f, 'events.jsonl'), rs = path.join(f, 'results.jsonl');
        if (fs.existsSync(ev)) put('health', Live.gpuHealthEvents(read(ev)));
        if (fs.existsSync(rs)) put('job', Live.gpuHealthResults(read(rs)));
        break;
      }
      case 'philly-machines': put('inventory', Philly.machines(read(f), { t: from ?? 0 })); break;
      case 'philly-gpu': {
        let keep = null;
        if (o.machines && o.machines !== true) keep = /^\d+$/.test(o.machines) ? null : new Set(String(o.machines).split(','));
        const limit = /^\d+$/.test(String(o.machines || '')) ? +o.machines : 0;
        const inv = store.query('inventory', { where: r => r.source === 'philly' }), skus = Object.fromEntries(inv.map(r => [r.node, r.sku]));
        // the first N machines (by number) with 8 GPUs: a fixed, repeatable subset of the cluster
        if (limit) keep = new Set(inv.filter(r => r.devices === 8).map(r => r.node).sort((a, b) => +a.slice(1) - +b.slice(1)).slice(0, limit));
        let batch = [], n = 0;
        for (const s of Philly.gpuUtil(readLines(f), { from, to, stepMin: +(o.step || 10), machines: keep, skus })) { batch.push(s); if (batch.length >= 50000) { n += put('device', batch).written; batch = []; } }
        if (batch.length) put('device', batch);
        break;
      }
      case 'philly-jobs': { const x = Philly.jobLog(JSON.parse(read(f)), { from, to }); put('placement', x.placements); put('job', x.outcomes); break; }
      case 'azure-llm': put('request', Pub.azureLlm(read(f), { pool: o.pool || path.basename(f, '.csv'), limit: o.limit ? +o.limit : Infinity })); break;
      case 'mlperf': put('benchmark', [Pub.mlperfSummary(read(f), { path: o.path || f, t: o.t ? +o.t : 0, meta: { islMean: o.isl ? +o.isl : undefined } })]); break;
      case 'acme': put('job', Pub.acme(read(f), { cluster: o.cluster || 'acme', limit: o.limit ? +o.limit : Infinity })); break;
      default: throw new Error(`unknown source "${src}"\n\n${HELP}`);
    }
  }
  // merge per kind
  const by = {};
  for (const r of res) { const b = by[r.kind] || (by[r.kind] = { written: 0, skipped: 0, invalid: 0, errors: [] }); b.written += r.written; b.skipped += r.skipped; b.invalid += r.invalid; b.errors.push(...r.errors); }
  return by;
}

async function main() {
  const o = args(process.argv.slice(2));
  J = !!o.json;
  const [area, cmd, ...rest] = o._;
  if (!area || o.help || area === 'help') return console.log(HELP);
  const store = await openStore(o.store && o.store !== true ? o.store : 'fleet-data', { backend: o.backend && o.backend !== true ? o.backend : undefined });
  // the hourly rollup answers long lookbacks (root-cause "day before") when it exists
  if (fs.existsSync(path.join(store.dir, 'rollup-3600', 'device'))) store.coarse = await Retention.rollupStore(store, 3600);
  if (store.meta && store.meta.schema < SCHEMA && !(area === 'data' && cmd === 'migrate')) console.error(`note: store ${store.dir} is schema ${store.meta.schema}; run \`fleetops data migrate --apply\` to bring it to ${SCHEMA}`);
  if (area === 'serve') return serve(store, o);
  if (area === 'calibrate') return calibrate(store, cmd, o);
  if (area === 'rca') return rca(store, cmd, o);
  if (area === 'optimize') return optimize(store, cmd, o);
  if (area === 'inject') return inject(store, cmd, o);
  if (area !== 'data') throw new Error(`unknown command "${area}"\n\n${HELP}`);
  if (cmd === 'import') {
    const [src, ...files] = rest;
    if (!src || !files.length) throw new Error('give a SOURCE and at least one FILE');
    const by = importSource(store, src, files, o);
    if (J) { OUT.imported = by; return; }
    for (const [k, b] of Object.entries(by)) say(`${k}: ${b.written} written, ${b.skipped} already there, ${b.invalid} invalid${b.errors.length ? `\n  ${b.errors.slice(0, 5).join('\n  ')}` : ''}`);
    return;
  }
  if (cmd === 'summary') {
    const s = store.summary();
    if (J) { OUT.summary = s; OUT.store = store.dir; return; }
    say(`store ${store.dir}`);
    for (const [k, v] of Object.entries(s)) say(`  ${k.padEnd(10)} ${String(v.records).padStart(9)}  ${fmt(v.from)} → ${fmt(v.to)}  ${Object.entries(v.sources).map(([a, b]) => `${a}:${b}`).join(' ')}`);
    if (!Object.keys(s).length) say('  (empty)');
    return;
  }
  if (cmd === 'query') {
    const kind = rest[0];
    const rows = store.query(kind, { from: time(o.from), to: time(o.to), where: whereFrom(o.where), limit: o.limit ? +o.limit : 1000 });
    if (J) { OUT.records = rows; return; }
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'rollup') {
    const r = await Retention.rollup(store, { steps: o.steps && o.steps !== true ? String(o.steps).split(',').map(Number) : undefined });
    if (J) { OUT.rollup = r; return; }
    for (const x of r) say(`  ${x.day}  ${x.step} s: ${x.raw != null ? `${x.raw} samples → ` : ''}${x.rolled} records`);
    if (!r.length) say('  nothing new to roll up');
    return;
  }
  if (cmd === 'compact') {
    const r = await Retention.compact(store, { rawDays: o['raw-days'] ? +o['raw-days'] : 7, apply: !!o.apply });
    if (J) { OUT.compact = r; return; }
    say(`raw high-volume days before ${r.cutoff}: ${r.plan.length}${r.applied ? '' : ' (dry run: --apply to roll up, keep incident windows and drop them)'}`);
    for (const p of r.plan) say(`  ${p.kind.padEnd(7)} ${p.day}${p.keepWindows ? `  ${p.keepWindows} incident window(s)${p.kept != null ? `: ${p.kept} records kept` : ''}` : ''}${p.dropped ? '  dropped' : ''}`);
    return;
  }
  if (cmd === 'migrate') {
    const r = migrate(store, { apply: !!o.apply });
    if (J) { OUT.migrate = r; return; }
    if (r.from >= r.to) return say(`store is at schema ${r.to}: nothing to do`);
    const changed = r.steps.filter(x => x.changed);
    say(`schema ${r.from} → ${r.to}: ${changed.length} day file(s) with ${changed.reduce((t, x) => t + x.changed, 0)} records to change${r.applied ? ' — done' : ' (dry run: --apply to rewrite)'}`);
    for (const x of changed.slice(0, 20)) say(`  v${x.to} ${x.kind} ${x.day}: ${x.changed} of ${x.records}  (${x.what})`);
    return;
  }
  if (cmd === 'requests') {
    // per-request records (stages, replica, tokens) from the spans in the store
    const from = time(o.from), to = time(o.to), spans = store.query('span', { from, to });
    const reqs = Traces.requestsFromSpans(spans);
    const r = store.append('request', reqs, { dedupe: true });
    if (J) { OUT.requests = { spans: spans.length, requests: reqs.length, written: r.written }; return; }
    say(`${spans.length} spans → ${reqs.length} requests (${r.written} new)`);
    return;
  }
  if (cmd === 'node') {
    // one node, everything the store knows: versions, what it shares, recent log faults and changes
    const node = rest[0]; if (!node) throw new Error('data node NODE [--from T] [--to T]');
    const to = time(o.to), from = time(o.from) ?? (to ?? Math.floor(Date.now() / 1000)) - 7 * 86400;
    const inv = store.query('inventory', { to, where: r => r.node === node }).sort((a, b) => a.t - b.t);
    const g = Topo.groups(store.query('topology', { to })).byNode[node] || {};
    const nvl = store.query('topology', { to, where: e => e.kind === 'nvlink' && e.node === node });
    const logs = store.query('log', { from, to, where: l => l.node === node && l.severity !== 'info' });
    const changes = store.query('change', { from, to, where: c => c.target === node });
    const out = { node, inventory: inv.at(-1) || null, versions: Object.assign({}, ...inv.map(r => r.versions || {})), shares: g, nvlinkPairs: nvl.length, logs, changes };
    if (J) { OUT.node = out; return; }
    const last = inv.at(-1);
    say(`${node}${last ? `  ${last.devices}× ${last.sku || last.vendor}` : '  (not in the inventory)'}`);
    say(`  versions  ${Object.entries(out.versions).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}${last && last.mixedVersions ? `  (mixed across GPUs: ${last.mixedVersions.join(', ')})` : ''}`);
    say(`  shares    ${[...(g.leaf || []), g.rack, g.pdu, g.row, g.site].filter(Boolean).join(', ') || '–'}${nvl.length ? `; ${nvl.length} NVLink pairs` : ''}`);
    say(`  changes   ${changes.length ? `(${changes.length})` : '–'}`); for (const c of changes) say(`    ${fmt(c.t)}  ${c.kind}: ${c.summary || c.id}${c.since != null ? ` (between ${fmt(c.since)} and then)` : ''}`);
    say(`  log faults ${logs.length ? `(${logs.length})` : '–'}`);
    for (const l of logs.slice(-15)) say(`    ${fmt(l.t)}  ${l.gpu != null ? 'gpu' + l.gpu + ' ' : ''}${l.code} [${l.class}/${l.severity}] ${l.msg.slice(0, 90)}`);
    return;
  }
  if (cmd === 'export') {
    const what = rest[0];
    if (what === 'gpu-health') { if (!o.out) throw new Error('--out DIR'); const r = writeGpuHealth(store, o.out, { from: time(o.from), to: time(o.to) }); if (J) OUT.exported = r; else say(`wrote ${r.samples} samples, ${r.jobs} jobs, ${r.results} results to ${r.dir}`); return; }
    if (what === 'fleetscope-trace') { if (!o.out) throw new Error('--out FILE'); const csv = toFleetScopeTrace(store, { from: time(o.from), to: time(o.to), pool: o.pool }); fs.writeFileSync(o.out, csv); const n = csv.split('\n').length - 2; if (J) OUT.exported = { file: o.out, requests: n }; else say(`wrote ${n} requests to ${o.out}`); return; }
    throw new Error('export gpu-health | fleetscope-trace');
  }
  throw new Error(`unknown: data ${cmd}\n\n${HELP}`);
}

const pc = v => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : '') + Math.round(v * 100) + '%');
const errs = rows => (rows || []).map(r => `${r.metric} ${pc(r.err)}`).join(', ');
async function calibrate(store, cmd, o) {
  const now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const writeProfile = p => { if (o.profile && o.profile !== true) { fs.writeFileSync(o.profile, JSON.stringify(p, null, 1)); say(`profile written to ${o.profile}`); } };
  if (cmd === 'benchmarks') {
    const r = Calib.calibrateBenchmarks(store, { islMean: o.isl ? +o.isl : 300, fleetscope: !o['no-fleetscope'], now });
    store.append('calibration', r.records);
    writeProfile(r.profile);
    if (J) { Object.assign(OUT, r); return; }
    say(`Inference Sizer: GPUs predicted for each benchmark's measured load, before and after calibration (mean input ${r.profile.assumptions.islMean} tokens assumed)`);
    for (const x of r.runs) say(x.sizer.error ? `  ${x.system}: ${x.sizer.error}` : `  ${x.system}: used ${x.sizer.measuredGpus}; spec-sheet model ${x.sizer.before} (${pc(x.sizer.errBefore)}) → calibrated ${x.sizer.after} (${pc(x.sizer.errAfter)})${x.sizer.capped.length ? `; at the ceiling: ${x.sizer.capped.join(', ')}` : ''}`);
    if (!o['no-fleetscope']) {
      say('FleetScope: one pool at the benchmark\'s load');
      for (const x of r.runs) if (x.fleetscope) say(x.fleetscope.error ? `  ${x.system}: ${x.fleetscope.error}` : `  ${x.system}: before ${errs(x.fleetscope.before)}\n    fitted prefill ×${x.fleetscope.calib.prefill}, decode ×${x.fleetscope.calib.decode}: ${x.fleetscope.pass ? 'within the bar' : `not within the bar (${x.fleetscope.diagnosis})`}; after ${errs(x.fleetscope.after)}`);
    }
    if (r.heldOut.length) say('Held out (low-latency runs, checked against the profile fitted on the same system):');
    for (const h of r.heldOut) {
      if (h.sizerCalibrated) say(`  ${h.system} ${h.model}: sizer spec-sheet ${h.sizerSpecSheet.predicted} GPUs (${pc(h.sizerSpecSheet.err)}), calibrated ${h.sizerCalibrated.predicted} (${pc(h.sizerCalibrated.err)}) vs ${h.sizerCalibrated.measuredGpus} used`);
      if (h.fleetscopeCalibrated) say(`    FleetScope spec-sheet ${errs(h.fleetscopeSpecSheet.rows)}\n    FleetScope calibrated ${errs(h.fleetscopeCalibrated.rows)}`);
    }
    return;
  }
  const graphFile = o.graph && o.graph !== true ? o.graph : null;
  if (!graphFile) throw new Error('--graph FILE (a FleetScope graph: "Copy graph JSON" in the editor)');
  const graph = JSON.parse(read(graphFile));
  if (cmd === 'serving') {
    const run = () => {
      const t = Math.floor(Date.now() / 1000), to = time(o.to) ?? (o.every ? t : undefined), from = time(o.from) ?? (o.every ? t - 86400 : undefined);
      const r = Calib.calibrateServing(store, graph, { from, to, holdout: o.holdout ? +o.holdout : 0, now: o.now ? +o.now : t });
      store.append('calibration', r.records);
      writeProfile(r.profile);
      if (o['graph-out'] && o['graph-out'] !== true) fs.writeFileSync(o['graph-out'], JSON.stringify(Calib.applyToGraph(graph, r.profile).graph, null, 1));
      if (J) { Object.assign(OUT, r); return; }
      for (const p of r.pools) say(p.skipped ? `  ${p.name}: ${p.skipped}` : `  ${p.name}: prefill ×${p.calib.prefill}, decode ×${p.calib.decode} — ${p.pass ? 'within the bar' : `not within the bar (${p.diagnosis})`}\n    fit: ${errs(p.after)}${p.heldOut ? `\n    held out: ${errs(p.heldOut.rows)} — ${p.heldOut.pass ? 'pass' : 'fail'}` : ''}`);
    };
    run();
    if (o.every) { const every = +o.every * 1000; say(`re-fitting every ${o.every} s`); setInterval(() => { try { run(); } catch (e) { console.error(e.message); } }, every); }
    return;
  }
  if (cmd === 'drift') {
    if (!o.profile || o.profile === true) throw new Error('--profile FILE');
    const d = Calib.driftCheck(store, graph, JSON.parse(read(o.profile)), { from: time(o.from), to: time(o.to), now });
    store.append('drift', d);
    if (J) OUT.drift = d; else for (const x of d) say(`  ${x.pool}: ${x.drifted ? 'DRIFT' : 'ok'} — ${x.why}`);
    if (o['fail-on-drift'] && d.some(x => x.drifted)) process.exitCode = 3;
    return;
  }
  if (cmd === 'apply') {
    if (!o.profile || !o.out) throw new Error('--profile FILE --out FILE');
    const r = Calib.applyToGraph(graph, JSON.parse(read(o.profile)));
    fs.writeFileSync(o.out, JSON.stringify(r.graph, null, 1));
    if (J) OUT.applied = r.applied; else say(`multipliers written for ${r.applied.join(', ') || 'no pools (no profile entries match the graph)'} → ${o.out}`);
    return;
  }
  throw new Error(`unknown: calibrate ${cmd}\n\n${HELP}`);
}

async function rca(store, cmd, o) {
  const show = list => {
    if (J) { OUT.incidents = list; return; }
    if (o.format === 'md') { console.log(list.map(d => RCA.markdown(d)).join('\n')); return; }
    for (const d of list) {
      say(`${d.id}  [${d.confidence}]`);
      d.hypotheses.slice(0, 3).forEach((h, i) => say(`  ${i + 1}. ${h.title}  (${h.rule}, ${h.score.toFixed(2)})`));
      say(`     ${d.narrative}`);
    }
  };
  const weights = o.weights && o.weights !== true ? JSON.parse(read(o.weights)) : undefined;
  if (cmd === 'detect') {
    const from = time(o.from), to = time(o.to), targets = o.targets && o.targets !== true ? JSON.parse(read(o.targets)) : {};
    const where = whereFrom(o.where);
    let incs;
    if (o.method === 'threshold') incs = [...RCA.detectJobFailureSpikes(store, { from, to, minFailures: o['min-failures'] ? +o['min-failures'] : 50, ratio: o.ratio ? +o.ratio : 4 }), ...RCA.detectServingRegressions(store, { from, to, targets })];
    else incs = Detect.groupIncidents([...Detect.detectJobFailures(store, { from, to, binS: o.bin ? +o.bin : 600, minFailures: o['min-failures'] ? +o['min-failures'] : 20, where }), ...Detect.detectServing(store, { from, to, targets }), ...Detect.detectTraining(store, { from, to })], { gapS: o['group-gap'] ? +o['group-gap'] : 1800 });
    if (!o.diagnose) {
      if (J) { OUT.incidents = incs; return; }
      for (const i of incs) say(`${i.id}  ${i.symptom.startsWith('training') ? `${i.job || i.nodes.join(',')}${i.peak != null ? ` step ${i.peak.toFixed(3)} s vs ${i.baseline.toFixed(3)} s` : ''}` : i.failures != null ? `${i.failures} failures` : `${i.metric} peak ${i.peak.toFixed(3)}${i.limit ? ` > ${i.limit.toFixed(3)}` : i.baseline != null ? ` vs ${i.baseline.toFixed(3)}` : ''}`}${i.alarmAt ? `, alarm ${Math.round((i.alarmAt - i.from) / 60)} min after onset` : ''}, ${((i.to - i.from) / 3600).toFixed(1)} h${i.merged ? `, ${i.merged.length + 1} merged` : ''}${i.related ? `; related: ${i.related.join(', ')}` : ''}`);
      return;
    }
    const ds = incs.map(i => RCA.diagnose(store, i, { weights }));
    store.append('incident', ds);
    return show(ds);
  }
  if (cmd === 'diagnose') {
    if (!o.symptom || !o.from || !o.to) throw new Error('--symptom job-failures|latency|device --from T --to T');
    const inc = { symptom: o.symptom, from: time(o.from), to: time(o.to), pool: o.pool !== true ? o.pool : undefined, nodes: o.nodes && o.nodes !== true ? String(o.nodes).split(',') : undefined, metric: o.metric };
    const d = RCA.diagnose(store, inc, { weights });
    store.append('incident', [d]);
    return show([d]);
  }
  if (cmd === 'eval') {
    if (!o.labels || o.labels === true) throw new Error('--labels FILE');
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    const r = RCA.evaluate(store, labeled);
    if (J) { OUT.evaluation = r; return; }
    say(`${r.incidents} labeled incidents: top-1 ${(r.top1 * 100).toFixed(0)}%, top-3 ${(r.top3 * 100).toFixed(0)}%`);
    for (const x of r.rows) say(`  ${x.id}: labeled ${x.cause}, ranked ${x.rank ?? 'not found'} (${x.got.join(', ')})`);
    return;
  }
  if (cmd === 'bench') return bench(store, o, weights);
  throw new Error(`unknown: rca ${cmd}\n\n${HELP}`);
}

// The root-cause benchmark: synthetic scenarios (default), injected faults (--injections), postmortem labels (--labels).
async function bench(store, o, weights) {
  const pct = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  const rows = [], parts = [];
  const useSynth = !o.injections && !o.labels || o.synthetic;
  if (useSynth) { const r = Bench.run(Bench.generate({ perCause: o['per-cause'] ? +o['per-cause'] : 10, seed: o.seed ? +o.seed : 1, only: o.only && o.only !== true ? String(o.only).split(',') : undefined }), { weights }); rows.push(...r.rows); parts.push('synthetic'); }
  let inj = null;
  if (o.injections) { inj = Bench.evalInjections(store, { weights, from: time(o.from), to: time(o.to) }); rows.push(...inj.rows.filter(r => r.cause)); parts.push('injected'); }
  if (o.labels && o.labels !== true) {
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    rows.push(...Bench.evalLabels(store, labeled, { weights })); parts.push('postmortem');
  }
  let sum = Bench.summarize(rows), fitted = null;
  if (o.fit && o.fit !== true) {
    // fit on half, report the other half; then fit on all for the file
    const train = rows.filter((_, i) => i % 2 === 0), test = rows.filter((_, i) => i % 2 === 1);
    const wHalf = Bench.fitWeights(train), testBefore = Bench.summarize(test), testAfter = Bench.applyWeights(test, wHalf);
    const w = Bench.fitWeights(rows), perCause = {};
    for (const r of rows) perCause[r.cause] = (perCause[r.cause] || 0) + 1;
    const thin = Object.entries(perCause).filter(([, n]) => n < 5).map(([c]) => c);
    fitted = { rules: w, fittedOn: { sources: parts, incidents: rows.length, perCause }, heldOut: { top1Before: testBefore.top1, top1After: testAfter.top1 },
      warnings: [...(parts.every(p => p === 'synthetic') ? ['fitted on synthetic scenarios only: these weights learn the generator, not your fleet; fit on injected or postmortem labels before using them'] : []), ...(thin.length ? [`fewer than 5 labeled incidents for: ${thin.join(', ')}`] : [])] };
    fs.writeFileSync(o.fit, JSON.stringify(fitted, null, 1));
  }
  if (J) { Object.assign(OUT, { benchmark: { sources: parts, top1: sum.top1, top3: sum.top3, lenientTop1: sum.lenientTop1, componentTop1: sum.componentTop1, byScenario: sum.byScenario, misses: sum.misses.map(m => ({ id: m.id, cause: m.cause, top: m.top, rank: m.rank })) }, injections: inj && { injections: inj.injections, detected: inj.detected, delayP50: inj.delayP50, delayP90: inj.delayP90, rows: inj.rows.map(({ hyps, ...r }) => r) }, fitted }); }
  else {
    say(`${sum.incidents} labeled incidents (${parts.join(' + ')}): top-1 ${pct(sum.top1)}, top-3 ${pct(sum.top3)}${sum.lenientTop1 !== sum.top1 ? `, top-1 counting equivalent causes ${pct(sum.lenientTop1)}` : ''}${sum.componentTop1 != null ? `, component named ${pct(sum.componentTop1)}` : ''}`);
    for (const [k, b] of Object.entries(sum.byScenario)) say(`  ${(b.top1 + '/' + b.n).padStart(7)}  ${k}${b.top1 < b.n ? `   ranked first: ${Object.entries(b.tops).map(([r, n]) => `${r} ${n}`).join(', ')}` : ''}`);
    if (inj) say(`injected faults: ${inj.injections}, detected ${pct(inj.detected)}, alarm after ${inj.delayP50 != null ? Math.round(inj.delayP50 / 60) : '–'} min (p50) / ${inj.delayP90 != null ? Math.round(inj.delayP90 / 60) : '–'} min (p90)`);
    if (inj) for (const r of inj.rows) say(`  ${r.id}: ${r.detected ? `detected after ${Math.round(r.delayS / 60)} min` : 'not detected'}; ${r.cause ? `expected ${r.cause}, ranked ${r.rank ?? 'not found'} (top: ${r.top || 'none'})` : `top: ${r.top || 'none'} (detection only)`}`);
    if (fitted) { say(`weights written to ${o.fit}: ${Object.entries(fitted.rules).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ×${v}`).join(', ') || 'all 1'}; held-out top-1 ${pct(fitted.heldOut.top1Before)} → ${pct(fitted.heldOut.top1After)}`); for (const w of fitted.warnings) say(`  warning: ${w}`); }
  }
  const minT1 = o['min-top1'] ? +o['min-top1'] : null, minT3 = o['min-top3'] ? +o['min-top3'] : null;
  if ((minT1 != null && sum.top1 < minT1) || (minT3 != null && sum.top3 < minT3)) { console.error(`below the bar: top-1 ${pct(sum.top1)} (min ${pct(minT1)}), top-3 ${pct(sum.top3)} (min ${pct(minT3)})`); process.exitCode = 5; }
}

// Fault injection on a test cluster (dry-run unless --live; targets must be in the --allow file).
async function inject(store, cmd, o) {
  if (!cmd || cmd === 'list') {
    if (J) { OUT.faults = Object.fromEntries(Object.entries(Inject.FAULTS).map(([k, f]) => [k, { what: f.what, params: Object.keys(f.params), expect: f.expect, undo: !!f.revert, note: f.note }])); return; }
    for (const [k, f] of Object.entries(Inject.FAULTS)) say(`  ${k.padEnd(13)} ${f.what}\n                --${Object.keys(f.params).join(' --')}${f.revert ? ' [--for S]' : ''}   expect: ${f.expect || 'detection only'}${f.note ? `\n                ${f.note}` : ''}`);
    return;
  }
  const allowFile = o.allow && o.allow !== true ? o.allow : process.env.FLEETOPS_INJECT_ALLOW;
  if (!allowFile) throw new Error('--allow FILE (or FLEETOPS_INJECT_ALLOW): the test-cluster targets injection may touch, one per line');
  const params = Object.fromEntries(Object.entries(o).filter(([k]) => !['_', 'where', 'store', 'allow', 'live', 'for', 'json'].includes(k)));
  const prep = Inject.prepare(cmd, params, { allow: Inject.loadAllow(allowFile) });
  const r = await Inject.run(prep, { live: !!o.live, forS: o.for ? +o.for : 300, store, log: J ? () => {} : console.log });
  if (J) OUT.injection = r; else if (!r.dryRun) say(`${r.id}: ${r.applied ? 'applied' : 'FAILED to apply'}${r.reverted != null ? `, reverted ${r.reverted ? 'ok' : 'with errors'}` : ''}; label written to the store (expect ${r.expect || 'detection only'})`);
}

const money = v => '$' + Math.round(v).toLocaleString('en-US');
// What the fleet costs per week now: GPUs in the inventory (or, without one, distinct GPUs seen) × 168 h × price.
function baselineWeekly(store, from, to, price) {
  const nodes = new Map(); for (const r of store.scan('inventory', { to })) if (r.kind !== 'cpu') nodes.set(r.node, r.devices || 0);
  let n = [...nodes.values()].reduce((a, b) => a + b, 0);
  if (!n) { const g = new Set(); for (const r of store.scan('device', { from, to })) g.add(`${r.node}:${r.gpu}`); n = g.size; }
  return n * 168 * price;
}
async function optimize(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined);
  const now = o.now ? +o.now : Math.floor(Date.now() / 1000), price = o.price ? +o.price : 4;
  const state = opt('state') || path.join(store.dir, 'rollouts', 'state');
  const cfg = ghConfig(json('config'));
  if (cmd === 'candidates') {
    const from = time(o.from), to = time(o.to);
    const cands = [...Opt.fromGpuHealth(store, { from, to, cfg }), ...Opt.fromRetryStorms(store, { from, to, price, maxAttempts: o['max-attempts'] ? +o['max-attempts'] : 2 })];
    if (opt('graph')) {
      // the store's requests go through the same CSV and parser as FleetScope's own --trace option
      const rows = opt('trace-pool') ? FSIN.parseTrace(toFleetScopeTrace(store, { pool: o['trace-pool'], from: time(o['trace-from']), to: time(o['trace-to']) })).trace : null;
      if (rows && !rows.length) throw new Error(`no request records for pool ${o['trace-pool']}`);
      if (rows) say(`replaying ${rows.length} requests of ${o['trace-pool']} through the graph`);
      cands.push(...Opt.fromFleetScope(json('graph'), { target: o.target ? +o.target : 0.99, traceRows: rows }));
    }
    const out = { from, to, price, baselineWeekly: baselineWeekly(store, from, to, price), candidates: cands.map(c => Object.assign({}, c, { graph: undefined })) };
    if (opt('out')) fs.writeFileSync(o.out, JSON.stringify(out, null, 1));
    if (J) { Object.assign(OUT, out); return; }
    say(`${cands.length} candidates (fleet ≈ ${money(out.baselineWeekly)}/week at $${price}/GPU-hour)`);
    say('  savings/week  risk    SLO                       candidate');
    for (const c of cands.slice().sort((a, b) => b.savingsWeekly - a.savingsWeekly)) say(`  ${money(c.savingsWeekly).padStart(11)}  ${c.risk.padEnd(6)}  ${(c.protected ? 'PROTECTED' : c.slo.impact).padEnd(24)}  ${c.title}${c.realized ? ` (${c.realized})` : ''}`);
    if (opt('out')) say(`written to ${o.out}`);
    return;
  }
  if (cmd === 'plan') {
    const c = json('candidates'); if (!c || !opt('out')) throw new Error('--candidates FILE --out plan.json');
    const sel = Opt.select(c.candidates, { savePct: o['save-pct'] ? +o['save-pct'] : undefined, baselineWeekly: o['baseline-weekly'] ? +o['baseline-weekly'] : c.baselineWeekly, maxRisk: opt('max-risk') || 'medium' });
    const plan = Opt.planRollout(sel, { guards: json('guards') || {}, deployments: json('deployments') || {}, bakeS: o.bake ? +o.bake : 1800, cfg });
    plan.goal = { savePct: o['save-pct'] ? +o['save-pct'] : null, baselineWeekly: sel.baselineWeekly, savedPct: sel.savedPct, meetsGoal: sel.meetsGoal }; plan.skipped = sel.skipped; plan.state = state;
    const ids = Opt.enqueue(plan, state, now);
    Opt.savePlan(o.out, plan);
    if (J) { OUT.plan = plan; OUT.queued = ids; return; }
    say(`plan ${plan.id}: ${money(plan.totalWeekly)}/week${plan.potentialWeekly > plan.totalWeekly ? ` firm, up to ${money(plan.potentialWeekly)} if notified owners act` : ''}${sel.savedPct != null ? ` (${(sel.savedPct * 100).toFixed(1)}% of ${money(sel.baselineWeekly)})` : ''}${plan.goal.savePct ? ` — goal ${plan.goal.savePct}% ${sel.meetsGoal ? 'met' : 'NOT met'}` : ''}`);
    const many = plan.candidates.length > 8;
    for (const x of many ? plan.candidates.slice(0, 6) : plan.candidates) say(`  + ${x.title}  ${money(x.savingsWeekly)}/week, risk ${x.risk}`);
    if (many) say(`  + … ${plan.candidates.length - 6} more`);
    for (const x of sel.skipped.slice(0, 8)) say(`  - ${x.id}: ${x.why}`);
    if (sel.skipped.length > 8) say(`  - … ${sel.skipped.length - 8} more skipped`);
    say(`${plan.stages.length} stages queued for approval in ${state}:`);
    plan.stages.forEach((st, i) => say(`  ${st.n}. ${st.title}${st.guard ? `  [guard: pool ${st.guard.pool} ${st.guard.metric} ≤ ${st.guard.limit ?? `+${Math.round((st.guard.maxRegression ?? 0.1) * 100)}%`}, bake ${st.bakeS}s]` : ''}\n     approve: gpu-health actions approve ${ids[i]} --by NAME --state ${state}`));
    say(`then: fleetops optimize advance --plan ${o.out}`);
    return;
  }
  const planFile = opt('plan'); if (!planFile) throw new Error('--plan plan.json');
  const plan = JSON.parse(read(planFile));
  if (cmd === 'advance') {
    const r = await Opt.advance(plan, { store, stateDir: opt('state') || plan.state || state, cfg, live: !!o.live, now });
    Opt.savePlan(planFile, plan);
    if (J) { OUT.plan = plan; OUT.log = r.log; return; }
    for (const l of r.log) say(l);
    say(`plan ${plan.id}: ${plan.status}`);
    if (plan.status === 'rolled-back') process.exitCode = 4;
    return;
  }
  if (cmd === 'verify') {
    const v = Opt.verify(plan, store, { days: o.days ? +o.days : 7, now });
    store.append('optimization', [Object.assign({ t: now, id: plan.id, status: plan.status, expectedWeekly: plan.totalWeekly }, v)]);
    if (J) { OUT.verification = v; return; }
    if (!v.window) return say(v.note);
    say(`${plan.id}: allocated GPU-hours ${v.before.gpuHours.toFixed(0)} → ${v.after.gpuHours.toFixed(0)} (${pc(v.gpuHoursChange)}) over ${(v.window / 86400).toFixed(1)} days; guard breaches ${v.before.breaches} → ${v.after.breaches}: ${v.verified ? 'verified' : 'NOT verified'}`);
    return;
  }
  throw new Error(`unknown: optimize ${cmd}\n\n${HELP}`);
}

// Streaming ingestion: remote_write and OTLP/HTTP (JSON) into the store.
async function serve(store, o) {
  const pipe = new Ingest.Pipeline(store, { maxQueue: o['max-queue'] ? +o['max-queue'] : 200000, flushMs: o['flush-ms'] ? +o['flush-ms'] : 1000 }).start();
  const srv = Ingest.server(pipe, { site: o.site && o.site !== true ? o.site : undefined });
  const port = o.port ? +o.port : 9400, host = o.host && o.host !== true ? o.host : '127.0.0.1';
  await new Promise(r => srv.listen(port, host, r));
  console.log(`fleetops ingest on http://${host}:${port}  store ${store.dir}\n  POST /api/v1/write (Prometheus remote_write)  /v1/metrics /v1/logs /v1/traces (OTLP JSON)  GET /metrics /healthz`);
  const stop = () => { srv.close(); pipe.stop(); if (store.close) store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().then(() => { if (J && Object.keys(OUT).length) console.log(JSON.stringify(OUT, null, 1)); })
    .catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error('error: ' + e.message); process.exit(1); });
}
