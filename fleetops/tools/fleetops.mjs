#!/usr/bin/env node
// fleetops: the shared data layer for AIInfraTools, plus (in later steps) calibration, root-cause analysis and optimization.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStore, whereFrom } from '../src/store.mjs';
import { readLines } from '../src/lines.mjs';
import * as Philly from '../src/adapters/philly.mjs';
import * as Pub from '../src/adapters/public.mjs';
import * as Live from '../src/adapters/live.mjs';
import { toEpoch } from '../src/adapters/time.mjs';
import { writeGpuHealth, toFleetScopeTrace } from '../src/export.mjs';
import * as Calib from '../src/calibrate.mjs';
import * as RCA from '../src/rca.mjs';

const HELP = `fleetops — shared data layer for AIInfraTools

  fleetops data import SOURCE FILE... [--store DIR] [options]     load records into the store
  fleetops data summary [--store DIR]                             records per kind, time range and sources
  fleetops data query KIND [--from T] [--to T] [--where k=v]... [--limit N]
  fleetops data export gpu-health --out DIR [--from T] [--to T]   samples.jsonl, jobs.json, results.jsonl for gpu-health
  fleetops data export fleetscope-trace --out FILE [--pool P]     CSV for FleetScope's Trace replay node

Sources (SOURCE):
  exporter         DCGM / AMD / SambaNova exporter text      [--vendor V] [--t EPOCH] [--site S]
  vllm             vLLM /metrics snapshot                   --pool P [--before FILE | --window S] [--model M] [--gpu G] [--t EPOCH]
  prom-range       Prometheus query_range JSON              --field ttftP99|tpotP99|rate|kvUsage|… [--pool P]
  k8s-nodes        kubectl get nodes -o json
  k8s-pods         kubectl get pods -A -o json
  slurm-nodes      scontrol show node -o
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
  fleetops rca detect [--from T] [--to T] [--min-failures 50] [--ratio 4] [--targets targets.json] [--diagnose] [--format md]
        find job-failure spikes and serving latency regressions; --diagnose ranks causes for each
  fleetops rca diagnose --symptom job-failures|latency|device --from T --to T [--pool P] [--nodes n1,n2] [--format md]
  fleetops rca eval --labels FILE      top-1 / top-3 accuracy on labeled incidents (JSON lines: { incident, cause })

Times (T) are ISO dates or epoch seconds. Common: --store DIR (default ./fleet-data), --json.`;

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

function importSource(store, src, files, o) {
  const from = time(o.from), to = time(o.to), res = [];
  const put = (kind, recs) => { const r = store.append(kind, recs, { dedupe: true }); res.push(r); return r; };
  const each = f => (fs.statSync(f).isDirectory() ? [f] : [f]);
  for (const f of files.flatMap(each)) {
    switch (src) {
      case 'exporter': put('device', Live.exporterScrape(read(f), { vendor: o.vendor !== true ? o.vendor : undefined, t: o.t ? +o.t : Math.floor(fs.statSync(f).mtimeMs / 1000), site: o.site })); break;
      case 'vllm': put('serving', [Live.vllmSnapshot(read(f), { before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: o.t ? +o.t : Math.floor(fs.statSync(f).mtimeMs / 1000), pool: o.pool || 'default', model: o.model, gpu: o.gpu })]); break;
      case 'prom-range': if (!o.field) throw new Error('prom-range needs --field'); put('serving', Live.promRange(read(f), { field: o.field, pool: o.pool })); break;
      case 'k8s-nodes': put('inventory', Live.k8sNodes(read(f))); break;
      case 'k8s-pods': put('placement', Live.k8sPods(read(f))); break;
      case 'slurm-nodes': put('inventory', Live.slurmNodes(read(f))); break;
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
  const store = new DataStore(o.store && o.store !== true ? o.store : 'fleet-data');
  if (area === 'calibrate') return calibrate(store, cmd, o);
  if (area === 'rca') return rca(store, cmd, o);
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
  if (cmd === 'detect') {
    const from = time(o.from), to = time(o.to);
    const incs = [...RCA.detectJobFailureSpikes(store, { from, to, minFailures: o['min-failures'] ? +o['min-failures'] : 50, ratio: o.ratio ? +o.ratio : 4 }),
      ...RCA.detectServingRegressions(store, { from, to, targets: o.targets && o.targets !== true ? JSON.parse(read(o.targets)) : {} })];
    if (!o.diagnose) { if (J) OUT.incidents = incs; else for (const i of incs) say(`${i.id}${i.failures ? `  ${i.failures} failures (baseline ${i.baselinePerHour}/h)` : `  peak ${i.peak.toFixed(3)} s > ${i.limit.toFixed(3)} s`}`); return; }
    const ds = incs.map(i => RCA.diagnose(store, i));
    store.append('incident', ds);
    return show(ds);
  }
  if (cmd === 'diagnose') {
    if (!o.symptom || !o.from || !o.to) throw new Error('--symptom job-failures|latency|device --from T --to T');
    const inc = { symptom: o.symptom, from: time(o.from), to: time(o.to), pool: o.pool !== true ? o.pool : undefined, nodes: o.nodes && o.nodes !== true ? String(o.nodes).split(',') : undefined, metric: o.metric };
    const d = RCA.diagnose(store, inc);
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
  throw new Error(`unknown: rca ${cmd}\n\n${HELP}`);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().then(() => { if (J && Object.keys(OUT).length) console.log(JSON.stringify(OUT, null, 1)); })
    .catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error('error: ' + e.message); process.exit(1); });
}
