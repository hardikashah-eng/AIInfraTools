#!/usr/bin/env node
// gpu-health: find unhealthy and wasted GPUs, suggest actions, and run them once approved.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { readSamples, samplesFromExporter } from '../src/ingest.mjs';
import { analyze } from '../src/analyze.mjs';
import { persistable } from '../src/health.mjs';
import { Store } from '../src/actions.mjs';
import { markdown, html, receipt } from '../src/report.mjs';
import { createServer } from '../src/server.mjs';
import { demoSamples, demoJobs, demoSteps, demoProbes, demoCluster, demoResults, demoMixed, demoHistory, toJsonl } from '../src/synth.mjs';
import { flakinessFromState, flakinessHtml, flakinessMarkdown, flakinessDigest, recordTransitions, recordResults } from '../src/flakiness.mjs';

const HELP = `gpu-health — GPU health, efficiency and savings, with an approval queue for fixes

  gpu-health demo [--out DIR] [--mixed]            build a demo fleet with planted problems and analyze it
                                                   (--mixed: AMD, SambaNova and Cloud TPU nodes instead)
  gpu-health analyze --samples F[,F] --jobs F      analyze; writes STATE/analysis.json and updates the action queue
        [--prom F[,F]] [--vendor nvidia|amd|sambanova] [--steps F] [--probes F] [--results F] [--cluster F] [--config F] [--days 7] [--now EPOCH]
        [--execute [--live]]                       also run actions the policy approves automatically
  gpu-health actions list [--status open|all|proposed|approved|executed|rejected]
  gpu-health actions approve ID... --by NAME
  gpu-health actions reject ID --by NAME [--reason TEXT]
  gpu-health actions execute [ID...] [--live]      run approved actions (dry-run unless --live AND policy.dryRun=false)
  gpu-health report [--format md|html] [--out F]   report from the last analysis
  gpu-health receipt JOB                           what one job was given vs what it used
  gpu-health flakiness [--days 60] [--format html|md] [--out F] [--results F]
                                                   GPUs that keep failing, whether repairs hold, where failures cluster
  gpu-health serve [--port 8787] [--host 127.0.0.1] [--allow-live]   approval page (needs GPU_HEALTH_TOKENS or GPU_HEALTH_TOKEN)
  gpu-health watch --scrape URL[,URL] --jobs F [--interval 60] [--execute [--live]]   scrape exporters and analyze on a loop

  Common: --state DIR (default ./gpu-health-state), --config F (JSON, merged over the defaults; see docs/CONFIG.md),
          --json (one JSON object on stdout, for scripts and LLM agents)`;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) o[k] = true; else { o[k] = nx; i++; } }
    else o._.push(a);
  }
  return o;
}
let J = false;            // --json: print one JSON object at the end instead of text
const OUT = {};
const say = (...a) => { if (!J) console.log(...a); };
const read = f => fs.readFileSync(f, 'utf8');
const readJsonl = f => read(f).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
const readJson = f => (f.endsWith('.jsonl') ? readJsonl(f) : JSON.parse(read(f)));
const list = v => (v && v !== true ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
const $ = v => '$' + Math.round(v || 0).toLocaleString('en-US');

function config(o) { return loadConfig(o.config ? JSON.parse(read(o.config)) : {}); }
function stateDir(o) { return path.resolve(o.state && o.state !== true ? o.state : 'gpu-health-state'); }
function prevHealth(dir) { const f = path.join(dir, 'health.json'); return fs.existsSync(f) ? JSON.parse(read(f)) : { gpus: {} }; }
// executed releases feed back into health as results
function releaseResults(store) { return store.list('executed').filter(a => a.kind === 'release').map(a => ({ kind: 'release', node: a.node, gpu: a.gpu, t: a.executedAt, by: a.approvedBy })); }

function digest(a, store) { // what a person or an agent needs from one analysis
  const notServing = Object.values(a.health.gpus).filter(g => g.state !== 'serving' || g.stale)
    .map(g => ({ gpu: g.key, sku: g.sku, state: g.state, schedulable: g.schedulable, why: g.why, signals: (g.signals || []).map(x => x.key) }));
  return { summary: a.summary, breaker: a.health.breaker, gpusNotServing: notServing, recommendations: a.recommendations.map(r => ({ job: r.job, class: r.class, gpus: r.gpus, usage: r.usage, lever: r.lever, action: r.action, weekly: r.weekly, confidence: r.confidence, text: r.text })),
    risk: a.risk.filter(r => r.score >= 0.05).slice(0, 10), fragmentation: a.fragmentation, partitionPlan: a.partitionPlan, jobUsage: a.jobUsage, coverage: a.coverage,
    openActions: store.list('open').map(x => ({ id: x.id, kind: x.kind, target: x.target, mode: x.mode, status: x.status, severity: x.severity, weekly: x.weekly, reason: x.reason })) };
}

function printSummary(a, store) {
  if (J) { Object.assign(OUT, digest(a, store)); return; }
  const s = a.summary;
  console.log(`\n${s.gpus} GPUs · effective utilization ${Math.round((s.effectiveUtil || 0) * 100)}% · idle allocated ${Math.round(s.idleGpuHours)} GPU-h · potential savings ${$(s.weeklySavings)}/week (${s.gpusFreeable.toFixed(1)} GPUs)`);
  console.log(`states: ${Object.entries(s.states).map(([k, v]) => `${k} ${v}`).join(', ')}${a.health.breaker ? '  ⚠ monitoring circuit breaker tripped' : ''}`);
  const open = store.list('open');
  if (open.length) { console.log(`\nactions (${open.length} open):`); for (const x of open) console.log(`  ${x.status.padEnd(9)} ${x.mode.padEnd(7)} ${x.id}${x.weekly ? `  ≈${$(x.weekly)}/wk` : ''}\n            ${x.reason.slice(0, 150)}`); }
}

function runAnalysis(o, input) {
  const cfg = config(o), dir = stateDir(o);
  const store = new Store(dir);
  const results = [...(input.results || []), ...releaseResults(store)];
  const prev = prevHealth(dir);
  const a = analyze(Object.assign({}, input, { results, prev, cfg, windowDays: +(o.days || 7), now: o.now ? +o.now : input.now }));
  recordTransitions(dir, prev, a.health); // history for the flakiness view
  recordResults(dir, input.results);
  fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify(persistable(a.health), null, 1));
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(a));
  store.merge(a.suggestions, cfg, a.generatedAt);
  return { a, cfg, dir, store };
}

async function execApproved(store, cfg, o, fleetSize, ids, now) {
  const live = !!o.live;
  if (live && cfg.policy.dryRun !== false) { const note = '--live given but policy.dryRun is not false in the config, so this is still a dry-run'; if (J) OUT.note = note; else console.log('note: ' + note); }
  const res = await store.execute(cfg, { ids, live, fleetSize, now });
  if (J) { OUT.executed = (OUT.executed || []).concat(res.map(r => ({ id: r.id, outcome: r.skipped ? 'skipped' : r.dryRun ? 'dry-run' : r.ok ? 'done' : 'failed', commands: r.commands, message: r.text, output: r.output }))); return res; }
  for (const r of res) {
    console.log(`\n${r.skipped ? 'SKIPPED' : r.dryRun ? 'DRY-RUN' : r.ok ? 'DONE' : 'FAILED'}  ${r.id}`);
    if (r.commands) for (const c of r.commands) console.log('  $ ' + c.join(' '));
    if (r.text) console.log('  message: ' + r.text);
    if (r.output && !r.dryRun) console.log('  ' + r.output.split('\n').join('\n  '));
    else if (r.skipped) console.log('  ' + r.output);
  }
  if (!res.length) console.log('nothing approved to execute');
  return res;
}

async function main() {
  const o = args(process.argv.slice(2));
  J = !!o.json;
  const cmd = o._[0];
  if (!cmd || o.help || cmd === 'help') return console.log(HELP);

  if (cmd === 'demo') {
    const out = path.resolve(o.out && o.out !== true ? o.out : 'gpu-health-demo');
    const data = path.join(out, 'data'); fs.mkdirSync(data, { recursive: true });
    const write = (n, v) => fs.writeFileSync(path.join(data, n), v);
    const now = o.now ? +o.now : Math.floor(Date.now() / 1000 / 600) * 600; // ends now, so approvals can be executed straight away
    const mixed = o.mixed ? demoMixed({ now }) : null;
    const jobs = mixed ? mixed.jobs : demoJobs(now), steps = mixed ? [] : demoSteps({ now }), probes = mixed ? [] : demoProbes({ now }), results = mixed ? mixed.results : demoResults({ now });
    const cluster = mixed ? null : demoCluster();
    write('samples.jsonl', toJsonl(mixed ? mixed.samples : demoSamples({ now }))); write('jobs.json', JSON.stringify(jobs, null, 1)); write('steps.jsonl', toJsonl(steps));
    write('probes.jsonl', toJsonl(probes)); write('results.jsonl', toJsonl(results)); if (cluster) write('cluster.json', JSON.stringify(cluster, null, 1));
    write('config.json', JSON.stringify({ pricePerGpuHour: { B200: 6.0, H200: 4.5, MI300X: 4.0, RDU: 5.0, v5p: 4.2, default: 4.0 } }, null, 1));
    o.state = path.join(out, 'state'); o.config = path.join(data, 'config.json');
    if (fs.existsSync(o.state)) fs.rmSync(o.state, { recursive: true });
    const hist = mixed ? { events: [], audit: [], results: [] } : demoHistory({ now }); // 60 days of earlier state changes, repairs and job failures, for the flakiness view
    fs.mkdirSync(o.state, { recursive: true });
    fs.writeFileSync(path.join(o.state, 'events.jsonl'), toJsonl(hist.events)); fs.writeFileSync(path.join(o.state, 'audit.jsonl'), toJsonl(hist.audit)); fs.writeFileSync(path.join(o.state, 'results.jsonl'), toJsonl(hist.results));
    const { a, store, dir, cfg } = runAnalysis(o, { samples: readSamples(read(path.join(data, 'samples.jsonl'))), jobs, steps, probes, results, cluster, now });
    fs.writeFileSync(path.join(out, 'report.md'), markdown(a, store.list()));
    fs.writeFileSync(path.join(out, 'report.html'), html(a, store.list()));
    const flaky = flakinessFromState(dir, cfg);
    fs.writeFileSync(path.join(out, 'flakiness.html'), flakinessHtml(flaky)); fs.writeFileSync(path.join(out, 'flakiness.md'), flakinessMarkdown(flaky));
    printSummary(a, store);
    say(`\nauto-approved actions, dry-run:`);
    await execApproved(store, cfg, {}, a.summary.gpus, null, a.generatedAt);
    OUT.files = { reportHtml: path.join(out, 'report.html'), reportMd: path.join(out, 'report.md'), flakinessHtml: path.join(out, 'flakiness.html'), state: dir, data: data };
    say(`\nwrote ${path.relative(process.cwd(), out)}/report.html, report.md and flakiness.html; state in ${path.relative(process.cwd(), dir)}`);
    say(`next: node tools/gpu-health.mjs actions list --state ${path.relative(process.cwd(), dir)}`);
    return;
  }

  if (cmd === 'analyze') {
    const samples = [];
    for (const f of list(o.samples)) samples.push(...readSamples(read(f)));
    const cfgIn = config(o);
    for (const f of list(o.prom)) samples.push(...samplesFromExporter(read(f), { t: o.now ? +o.now : undefined, vendor: o.vendor && o.vendor !== true ? o.vendor : undefined, vendors: cfgIn.vendors, mappings: cfgIn.ingest.mappings }));
    if (!samples.length) throw new Error('give --samples (JSONL) and/or --prom (exporter text)');
    const input = { samples, jobs: o.jobs ? readJson(o.jobs) : [], steps: o.steps ? readJsonl(o.steps) : [], probes: o.probes ? readJsonl(o.probes) : [],
      results: o.results ? readJsonl(o.results) : [], cluster: o.cluster ? readJson(o.cluster) : null };
    const { a, store, cfg } = runAnalysis(o, input);
    printSummary(a, store);
    if (o.execute) await execApproved(store, cfg, o, a.summary.gpus, null, a.generatedAt);
    return;
  }

  if (cmd === 'actions') {
    const sub = o._[1] || 'list', store = new Store(stateDir(o)), cfg = config(o);
    if (sub === 'list') {
      const st = o.status === 'all' ? null : (o.status && o.status !== true ? o.status : 'open');
      const rows = store.list(st);
      if (J) { OUT.actions = rows; return; }
      if (!rows.length) return console.log('no actions');
      for (const x of rows) console.log(`${x.status.padEnd(10)} ${x.mode.padEnd(7)} ${x.id}${x.weekly ? `  ≈${$(x.weekly)}/wk` : ''}${x.approvedBy ? `  (approved by ${x.approvedBy})` : ''}\n           ${x.reason}`);
      return;
    }
    if (sub === 'approve') { OUT.approved = []; for (const id of o._.slice(2)) { const x = store.approve(id, o.by === true ? '' : o.by); OUT.approved.push(x); say(`approved ${x.id} by ${x.approvedBy}`); } return; }
    if (sub === 'reject') { const x = store.reject(o._[2], o.by === true ? '' : o.by, o.reason === true ? '' : o.reason); OUT.rejected = x; say(`rejected ${x.id}`); return; }
    if (sub === 'execute') {
      const f = path.join(stateDir(o), 'analysis.json');
      const fleet = fs.existsSync(f) ? JSON.parse(read(f)).summary.gpus : 0;
      const res = await execApproved(store, cfg, o, fleet, o._.length > 2 ? o._.slice(2) : null, o.now ? +o.now : undefined);
      process.exitCode = res.some(r => !r.ok && !r.skipped) ? 1 : 0;
      return;
    }
    throw new Error(`unknown: actions ${sub}`);
  }

  if (cmd === 'report' || cmd === 'receipt') {
    const dir = stateDir(o), f = path.join(dir, 'analysis.json');
    if (!fs.existsSync(f)) throw new Error(`no analysis in ${dir}; run analyze first`);
    const a = JSON.parse(read(f)), store = new Store(dir);
    if (cmd === 'receipt') {
      if (J) { OUT.job = a.jobUsage.find(x => x.job === o._[1]) || null; OUT.recommendation = a.recommendations.find(x => x.job === o._[1]) || null; return; }
      return process.stdout.write(receipt(a, o._[1]));
    }
    if (J) { Object.assign(OUT, digest(a, store)); return; }
    const text = o.format === 'html' ? html(a, store.list()) : markdown(a, store.list());
    if (o.out && o.out !== true) { fs.writeFileSync(o.out, text); console.log(`wrote ${o.out}`); } else process.stdout.write(text);
    return;
  }

  if (cmd === 'flakiness') {
    const f = flakinessFromState(stateDir(o), config(o), { days: o.days ? +o.days : undefined, now: o.now ? +o.now : undefined, results: o.results ? readJsonl(o.results) : [], jobs: o.jobs ? readJson(o.jobs) : undefined });
    if (J) { Object.assign(OUT, flakinessDigest(f)); return; }
    const text = o.format === 'html' ? flakinessHtml(f) : flakinessMarkdown(f);
    if (o.out && o.out !== true) { fs.writeFileSync(o.out, text); console.log(`wrote ${o.out}`); } else process.stdout.write(text);
    return;
  }

  if (cmd === 'serve') {
    const srv = createServer({ stateDir: stateDir(o), cfg: config(o), allowLive: !!o['allow-live'] });
    const port = +(o.port || 8787), host = o.host && o.host !== true ? o.host : '127.0.0.1';
    srv.listen(port, host, () => console.log(`approval page on http://${host}:${port}/ (state ${stateDir(o)})`));
    return;
  }

  if (cmd === 'watch') {
    const urls = list(o.scrape), every = +(o.interval || 60) * 1000, dir = stateDir(o), keepDays = +(o.days || 7);
    if (!urls.length) throw new Error('give --scrape with exporter URLs');
    fs.mkdirSync(dir, { recursive: true });
    const sf = path.join(dir, 'samples.jsonl');
    const tick = async () => {
      const t = Math.floor(Date.now() / 1000);
      const got = [];
      for (const u of urls) { try { const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); got.push(...samplesFromExporter(await r.text(), { t, vendor: o.vendor && o.vendor !== true ? o.vendor : undefined, vendors: config(o).vendors, mappings: config(o).ingest.mappings })); } catch (e) { console.error(`scrape ${u}: ${e.message}`); } }
      fs.appendFileSync(sf, toJsonl(got));
      const all = readSamples(read(sf)).filter(s => s.t > t - keepDays * 86400);
      if (all.length > got.length * 50) fs.writeFileSync(sf, toJsonl(all)); // trim old samples now and then
      const { a, store, cfg } = runAnalysis(o, { samples: all, jobs: o.jobs ? readJson(o.jobs) : [], cluster: o.cluster ? readJson(o.cluster) : null, now: t });
      console.log(`${new Date().toISOString()} ${got.length} samples · ${Object.entries(a.summary.states).map(([k, v]) => `${k} ${v}`).join(', ')} · ${store.list('open').length} open actions`);
      if (o.execute) await execApproved(store, cfg, o, a.summary.gpus, store.list('approved').filter(x => x.approvedBy === 'policy').map(x => x.id), t);
    };
    await tick();
    setInterval(() => tick().catch(e => console.error(e.message)), every);
    return;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().then(() => { if (J && Object.keys(OUT).length) console.log(JSON.stringify(OUT, null, 1)); })
    .catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error('error: ' + e.message); process.exit(1); });
}
