// fleetops CLI: data (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import { whereFrom } from '../../src/store.mjs';
import * as Retention from '../../src/retention.mjs';
import { migrate } from '../../src/migrate.mjs';
import * as Ingest from '../../src/ingest.mjs';
import * as Traces from '../../src/traces.mjs';
import { readLines } from '../../src/lines.mjs';
import * as Philly from '../../src/adapters/philly.mjs';
import * as Pub from '../../src/adapters/public.mjs';
import * as Live from '../../src/adapters/live.mjs';
import * as NVS from '../../src/adapters/nvsentinel.mjs';
import * as Logs from '../../src/adapters/logs.mjs';
import * as Topo from '../../src/adapters/topology.mjs';
import * as Procure from '../../src/procure.mjs';
import { writeGpuHealth, toFleetScopeTrace, toGpuLedger } from '../../src/export.mjs';
import * as Bench from '../../src/bench.mjs';
import * as Goodput from '../../src/goodput.mjs';
import * as Bundle from '../../src/bundle.mjs';
import * as Tune from '../../src/tune.mjs';
import * as Fabric from '../../src/adapters/fabric.mjs';
import * as Storage from '../../src/adapters/storage.mjs';
import { FSIN, J, OUT, say, read, time, fmt } from './common.mjs';
import { HELP } from './help.mjs';

// PCI address → GPU index per node, from the latest nvidia-smi -q or amd-smi static inventory in the store (for kernel logs).
export function pciMap(store) {
  const m = {};
  for (const r of store.scan('inventory', { where: r => Array.isArray(r.gpus) })) { m[r.node] = m[r.node] || {}; for (const g of r.gpus) if (g.pci) m[r.node][g.pci] = g.gpu; }
  return m;
}
export function importSource(store, src, files, o) {
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
      case 'exporter': put('device', Live.exporterScrape(read(f), { vendor: o.vendor !== true ? o.vendor : undefined, t: o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000), site: o.site })); break;
      case 'vllm': put('serving', [Live.vllmSnapshot(read(f), { before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000), pool: o.pool || 'default', model: o.model, gpu: o.gpu })]); break;
      case 'prom-range': if (!o.field) throw new Error('prom-range needs --field'); put('serving', Live.promRange(read(f), { field: o.field, pool: o.pool })); break;
      case 'nvsentinel': { const r = NVS.nvsentinelEvents(read(f)); put('log', r.logs); if (r.unmatched) console.error(`${f}: ${r.unmatched} object(s) were not NVSentinel health events`); break; }
      case 'k8s-nodes': putInventory(Live.k8sNodes(read(f), { t: tOf(f) })); put('topology', Live.k8sNodeTopology(read(f), { t: tOf(f) })); put('log', Live.k8sNodeConditions(read(f), { t: tOf(f) })); break;
      case 'k8s-pods': put('placement', Live.k8sPods(read(f))); break;
      case 'slurm-nodes': putInventory(Live.slurmNodes(read(f), { t: tOf(f) })); break;
      case 'nvidia-smi-q': putInventory([Topo.nvidiaSmiQ(read(f), { node: nodeOf(f), t: tOf(f) }).inventory]); break;
      case 'nvidia-topo': put('topology', Topo.nvidiaTopo(read(f), { node: nodeOf(f), t: tOf(f) })); break;
      case 'amd-smi-static': putInventory([Topo.amdSmiStatic(read(f), { node: nodeOf(f), t: tOf(f), rocm: o.rocm }).inventory]); break;
      case 'amd-smi-topology': put('topology', Topo.amdSmiTopology(read(f), { node: nodeOf(f), t: tOf(f) })); break;
      case 'cloud-monitoring': put('device', Live.cloudMonitoring(read(f), { site: o.site })); break;
      case 'ibnetdiscover': put('topology', Topo.ibnetdiscover(read(f), { t: tOf(f) })); break;
      case 'perfquery': put('port', Fabric.perfquery(read(f), { switch: o.switch, t: tOf(f) })); break;
      case 'ibqueryerrors': put('port', Fabric.ibqueryerrors(read(f), { t: tOf(f) })); break;
      case 'ib-sysfs': put('port', Fabric.ibSysfs(read(f), { node: o.node || nodeOf(f), t: tOf(f) })); break;
      case 'ethtool': put('port', Fabric.ethtool(read(f), { node: o.node || nodeOf(f), iface: o.iface || 'eth0', t: tOf(f) })); break;
      case 'fabric-prom': put('port', Fabric.fabricProm(JSON.parse(read(f)), { map: o.map ? Object.fromEntries(String(o.map).split(',').map(x => x.split('='))) : {} })); break;
      case 'ports': put('port', read(f).split(/\r?\n/).filter(l => l.trim()).map(l => Object.assign({ source: 'ports' }, JSON.parse(l)))); break;
      case 'lustre-jobstats': put('storage', Storage.lustreJobstats(read(f), { before: o.before ? read(o.before) : undefined, fs: o.fs || 'lustre', target: o.target || Storage.lustreTargetOf(f), t: tOf(f) })); break;
      case 'mountstats': put('storage', Storage.nfsMountstats(read(f), { node: o.node || nodeOf(f), before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: tOf(f) })); break;
      case 'storage': put('storage', Storage.storageLines(read(f))); break;
      case 'racks': put('topology', Topo.racks(read(f), { t: tOf(f) })); break;
      case 'kernel-log': put('log', Logs.kernelLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, boot: time(o.boot), year: o.year ? +o.year : undefined, utcOffset: o['utc-offset'] ? +o['utc-offset'] : 0, pciMap: pciMap(store) })); break;
      case 'app-log': put('log', Logs.ncclLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, job: o.job && o.job !== true ? o.job : undefined, t: o.t ? time(o.t) : tOf(f) })); break;
      case 'k8s-events': { const e = Live.k8sEvents(read(f)); put('change', e.changes); put('log', e.logs); break; }
      case 'kineto': put('step', Traces.kineto(read(f), { job: o.job && o.job !== true ? o.job : path.basename(f).split(/[._]/)[0], node: o.node && o.node !== true ? o.node : undefined, rank: o.rank != null && o.rank !== true ? +o.rank : undefined, t0: o.t0 ? time(o.t0) : undefined })); break;
      case 'nccl-inspector': put('collective', Traces.ncclInspector(read(f), { job: o.job && o.job !== true ? o.job : (path.basename(path.dirname(path.resolve(f))).match(/nccl-inspector-(\S+)/) || [])[1], node: o.node && o.node !== true ? o.node : undefined })); break;
      case 'step-log': put('step', Traces.stepLog(read(f), { job: o.job && o.job !== true ? o.job : undefined })); break;
      case 'admission': {
        // tools/admit-node.sh output: { record: inventory|check|topology|sdc_check, … }
        const by = {};
        for (const l of read(f).split(/\r?\n/).filter(x => x.trim())) { const { record, ...r } = JSON.parse(l); if (!['inventory', 'check', 'topology', 'sdc_check'].includes(record)) throw new Error(`admission file: unexpected record ${record}`); (by[record] = by[record] || []).push(Object.assign({ source: 'admit-node' }, r, r.gpu != null ? { gpu: String(r.gpu) } : {})); }
        for (const [k, rs] of Object.entries(by)) put(k, rs);
        break;
      }
      case 'sdc-checks': put('sdc_check', read(f).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(c => Object.assign({ source: 'sdc-canary' }, c, { gpu: c.gpu != null ? String(c.gpu) : undefined }))); break;
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
        let batch = [];
        for (const s of Philly.gpuUtil(readLines(f), { from, to, stepMin: +(o.step || 10), machines: keep, skus })) { batch.push(s); if (batch.length >= 50000) { put('device', batch); batch = []; } }
        if (batch.length) put('device', batch);
        break;
      }
      case 'philly-jobs': { const x = Philly.jobLog(JSON.parse(read(f)), { from, to }); put('placement', x.placements); put('job', x.outcomes); break; }
      case 'azure-llm': put('request', Pub.azureLlm(read(f), { pool: o.pool || path.basename(f, '.csv'), limit: o.limit ? +o.limit : Infinity })); break;
      case 'mlperf': put('benchmark', [Pub.mlperfSummary(read(f), { path: o.path || f, t: o.t ? time(o.t) : 0, meta: { islMean: o.isl ? +o.isl : undefined } })]); break;
      case 'acme': put('job', Pub.acme(read(f), { cluster: o.cluster || 'acme', limit: o.limit ? +o.limit : Infinity })); break;
      // gateway or proxy request logs (LiteLLM, OpenAI-style usage, OTLP gen_ai spans, CSV), through FleetScope's parser;
      // token counts and latencies only, never prompts or completions
      case 'requests': {
        const parsed = FSIN.parseTrace(read(f), { maxRows: 5000000, maxSeconds: Number.MAX_SAFE_INTEGER });
        const pool = o.pool && o.pool !== true ? o.pool : path.basename(f).replace(/\.(jsonl?|csv|txt)$/, '');
        const t0 = time(o.start) ?? tOf(f) - Math.max(0, ...parsed.trace.map(r => +r.t || 0));
        put('request', parsed.trace.filter(r => +r.isl > 0 && +r.osl > 0).map(r => ({ t: r.abs != null ? r.abs : t0 + +r.t, pool, isl: +r.isl, osl: +r.osl, cached: r.cached != null ? +r.cached : undefined, ttft: r.ttft != null ? +r.ttft : undefined, e2e: r.e2e != null ? +r.e2e : undefined, source: 'requests' })));
        break;
      }
      case 'auto': {
        const s = Bundle.sniffFile(f, f);
        if (!s) { res.push({ kind: 'unrecognized', written: 0, skipped: 0, invalid: 0, errors: [`${f}: not recognized; name its source (fleetops data import SOURCE FILE)`] }); break; }
        const by = importSource(store, s, [f], o);
        for (const [kind, b] of Object.entries(by)) res.push(Object.assign({ kind }, b));
        break;
      }
      default: throw new Error(`unknown source "${src}"\n\n${HELP}`);
    }
  }
  // merge per kind
  const by = {};
  for (const r of res) { const b = by[r.kind] || (by[r.kind] = { written: 0, skipped: 0, invalid: 0, errors: [] }); b.written += r.written; b.skipped += r.skipped; b.invalid += r.invalid; b.errors.push(...r.errors); }
  return by;
}

// A bundle (tar, tar.gz or a directory): manifest entries, then anything recognized by content. One bad file doesn't
// stop the rest; each file's result is reported.
export async function importBundle(store, target, o = {}) {
  if (!target) throw new Error('fleetops data import bundle FILE.tar.gz|DIR');
  let dir = target, tmp = null;
  if (!fs.statSync(target).isDirectory()) { const u = Bundle.unpack(fs.readFileSync(target)); dir = tmp = u.dir; }
  try {
    const p = Bundle.plan(dir), files = [], totals = {};
    // files another entry reads (a vLLM scrape's earlier snapshot) are not imported on their own
    const used = new Set(p.entries.map(e => e.opts && e.opts.before).filter(Boolean).map(Bundle.safeName));
    for (const e of p.entries) {
      if (used.has(e.path)) continue;
      if (e.opts && e.opts.before) e.opts = Object.assign({}, e.opts, { before: path.join(dir, Bundle.safeName(e.opts.before)) });
      if (e.missing) { files.push({ path: e.path, source: e.source, error: 'listed in the manifest but not in the bundle' }); continue; }
      if (!e.source) { files.push({ path: e.path, source: null, skipped: 'not recognized' }); continue; }
      try {
        const opts = Object.assign({}, e.opts);
        if (['kernel-log', 'nvidia-smi-q', 'nvidia-topo', 'amd-smi-static', 'amd-smi-topology', 'app-log'].includes(e.source) && !opts.node && p.manifest && p.manifest.host) opts.node = p.manifest.host;
        if (opts.t != null) opts.t = String(opts.t);
        const by = importSource(store, e.source, [e.abs], opts);
        for (const [k, b] of Object.entries(by)) totals[k] = (totals[k] || 0) + b.written;
        files.push({ path: e.path, source: e.source, from: e.from, imported: by });
      } catch (err) { files.push({ path: e.path, source: e.source, error: err.message.split('\n')[0] }); }
    }
    if (store.flush) store.flush();
    return { manifest: p.manifest, files, totals };
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

// fleetops send: a bundle (or a directory, tarred here) to a fleetops server's POST /v1/bundle.
export async function sendCmd(o) {
  const target = o._[1], url = o.to && o.to !== true ? o.to : null, token = o.token && o.token !== true ? o.token : process.env.FLEETOPS_TOKEN;
  if (!target || !url) throw new Error('fleetops send BUNDLE|DIR --to http://fleetops:9400 [--token T | FLEETOPS_TOKEN]');
  let body;
  if (fs.statSync(target).isDirectory()) {
    const walk = (d, b = '') => fs.readdirSync(path.join(d, b), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d, b ? `${b}/${e.name}` : e.name) : e.isFile() ? [b ? `${b}/${e.name}` : e.name] : []);
    body = (await import('node:zlib')).gzipSync(Bundle.writeTar(walk(target).map(n => ({ name: n, data: fs.readFileSync(path.join(target, n)) }))));
  } else body = fs.readFileSync(target);
  const r = await fetch(url.replace(/\/$/, '') + '/v1/bundle', { method: 'POST', headers: Object.assign({ 'content-type': 'application/gzip' }, token ? { authorization: `Bearer ${token}` } : {}), body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.trim()}`);
  const j = JSON.parse(text);
  if (J) { OUT.sent = j; return; }
  say(`sent ${(body.length / 1e6).toFixed(1)} MB: ${Object.entries(j.totals).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing new'}${j.files.some(f => f.error) ? `\n  errors: ${j.files.filter(f => f.error).map(f => `${f.path}: ${f.error}`).join('; ')}` : ''}`);
}

// A demo store: one benchmark scenario (a fleet with one planted cause and distractors) written to --store, so the
// detect → diagnose → incident flow can be tried without a fleet. The answer is printed so the result can be checked.
export function demo(store, o) {
  if (o.training) {
    const days = o.days ? +o.days : 7, t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - days * 86400;
    const at = o['tuned-at'] && o['tuned-at'] !== true ? t0 + +o['tuned-at'] * 86400 : null;
    // the two changes `tune` recommends for the first period: a faster input pipeline, more frequent checkpoints
    const tuned = at ? { at, 'sft-8b': { data: 0.12 }, 'pretrain-70b': { ckptEvery: 40 * 60 } } : null;
    const recs = Goodput.synthTraining({ t0, days, seed: o.seed ? +o.seed : 7, tuned }), written = {};
    for (const [k, r] of Object.entries(recs)) if (r.length) written[k] = store.append(k, r, { dedupe: true }).written;
    if (store.flush) store.flush();
    if (at) {
      const t = Tune.tune(store, { from: t0, to: at, now: at });
      for (const id of ['data-pipeline:sft-8b', 'checkpoint:pretrain-70b']) { const r = t.recommendations.find(x => x.id === id); if (r) Tune.applyTune(store, r, { by: 'demo', at }); }
    }
    const res = { store: store.dir, written, from: t0, to: t0 + days * 86400, planted: { 'pretrain-70b': 'checkpoints every 3 h on a fleet that interrupts it every ~6 h: lost work', 'sft-8b': 'a slow input pipeline: data stalls', 'rl-policy': 'one slow node for two days: slow steps' } };
    if (J) { OUT.demo = res; return; }
    say(`demo store ${store.dir}: ${days} days of training (${Object.entries(written).map(([k, n]) => `${k} ${n}`).join(', ')})`);
    for (const [j, w] of Object.entries(res.planted)) say(`  ${j}: ${w}`);
    say(at ? `applied on day ${o['tuned-at']}: data-pipeline:sft-8b, checkpoint:pretrain-70b\ntry:\n  fleetops tune --from ${new Date(t0 * 1000).toISOString()} --to ${new Date(at * 1000).toISOString()} --store ${store.dir}\n  fleetops tune verify --store ${store.dir}` : `try:\n  fleetops goodput --days ${days} --store ${store.dir}\n  fleetops tune --days ${days} --store ${store.dir}\n  fleetops goodput --days ${days} --format html --out goodput.html --store ${store.dir}`);
    return;
  }
  const names = Bench.SCENARIO_NAMES;
  if (o.list) { if (J) { OUT.scenarios = names; return; } names.forEach(n => say(n)); return; }
  const want = o.scenario && o.scenario !== true ? String(o.scenario) : 'hardware: GPU fault seen in dmesg';
  const name = names.find(n => n === want) || names.find(n => n.startsWith(want));
  if (!name) throw new Error(`no demo scenario starts with "${want}"; see fleetops demo --list`);
  const [lab] = Bench.generate({ perCause: 1, seed: o.seed ? +o.seed : 1, only: [name] });
  // --now: shift every time so the incident ends a minute ago, for the live agent and dashboard
  const shift = o.now ? Math.floor(Date.now() / 1000) - 60 - lab.incident.to : 0;
  const mv = r => { if (!shift) return r; const x = Object.assign({}, r); for (const k of ['t', 'start', 'end', 'since', 'from', 'to', 'alarmAt']) if (typeof x[k] === 'number' && x[k] > 1e9) x[k] += shift; return x; };
  if (shift) { lab.incident = mv(lab.incident); }
  const written = {};
  for (const [kind, recs] of Object.entries(lab.store.data)) if (recs.length) written[kind] = store.append(kind, recs.map(mv), { dedupe: true }).written;
  if (store.flush) store.flush();
  const inc = lab.incident, iso = t => new Date(t * 1000).toISOString();
  const scope = [inc.pool && `--pool ${inc.pool}`, inc.job && `--job ${inc.job}`, inc.nodes && `--nodes ${[].concat(inc.nodes).join(',')}`].filter(Boolean).join(' ');
  // demo fleets are small (12-24 nodes), so job-failure detection needs a lower floor than the default 20
  const mf = inc.symptom === 'job-failures' ? ' --min-failures 5' : '';
  const next = [`fleetops rca detect --from ${iso(inc.from - 6 * 3600)} --to ${iso(inc.to + 3600)}${mf} --diagnose --store ${store.dir}`,
    `fleetops rca diagnose --symptom ${inc.symptom} --from ${iso(inc.from)} --to ${iso(inc.to)}${scope ? ' ' + scope : ''} --store ${store.dir}`,
    `fleetops incidents open --from ${iso(inc.from - 6 * 3600)} --to ${iso(inc.to + 3600)}${mf} --store ${store.dir}`];
  const res = { scenario: name, store: store.dir, written, incident: Object.assign({}, inc, { fromIso: iso(inc.from), toIso: iso(inc.to) }), planted: { cause: lab.cause, component: lab.component || null }, next };
  if (J) { OUT.demo = res; return; }
  say(`demo store ${store.dir}: ${name}`);
  say(`  ${Object.entries(written).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  say(`  incident: ${inc.symptom}, ${iso(inc.from)} → ${iso(inc.to)}${scope ? ' (' + scope + ')' : ''}`);
  say(`  planted cause: ${lab.cause}${lab.component ? ` (${lab.component})` : ''}`);
  say('try:'); next.forEach(c => say('  ' + c));
}

// read-only procurement lookups: the cloud's own command listing what can be bought (src/procure.mjs)
export async function procureCmd(cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const from = opt('from') ? time(opt('from')) : undefined;
  let r;
  if (cmd === 'aws-blocks') r = Procure.awsCapacityBlocks({ chip: opt('gpu'), instanceType: opt('instance-type'), gpus: num('gpus'), days: num('days'), from, windowDays: num('window-days') });
  else if (cmd === 'gcp-calendar') r = Procure.gcpCalendarMode({ chip: opt('gpu'), machineType: opt('machine-type'), gpus: num('gpus') ?? num('chips'), days: num('days'), region: opt('region'), from, windowDays: num('window-days'), workload: opt('workload') });
  else throw new Error('fleetops procure aws-blocks --gpu H100|--instance-type T --gpus N --days N [--from DATE] [--window-days 14]\n       fleetops procure gcp-calendar --gpu H200|TPU-v6e|--machine-type T --gpus N|--chips N --days N --region R [--from DATE]');
  if (J) { OUT.procure = r; return; }
  const what = r.instanceType ? `${r.instances} × ${r.instanceType} (${r.gpusPerInstance} GPUs each)` : r.machineType ? `${r.vms} × ${r.machineType} (${r.gpusPerVm} GPUs each)` : `${r.chips} ${r.chip} chips`;
  say(`${what} for ${r.days} day(s). To see what is on offer:\n\n  ${r.argv.join(' ')}\n\n${r.notes.map(n => `- ${n}`).join('\n')}`);
}

// fleetops data …: the store itself (import, summary, query, rollup, compact, migrate, requests, node, export)
export async function dataCmd(store, cmd, rest, o) {
  if (cmd === 'import' && rest[0] === 'bundle') {
    const r = await importBundle(store, rest[1], o);
    if (J) { OUT.bundle = r; return; }
    say(`bundle ${rest[1]}${r.manifest ? ` (${r.manifest.host || '?'}, collected ${r.manifest.collectedAt || '?'})` : ''}`);
    for (const e of r.files) say(`  ${e.path.padEnd(40)} ${(e.source || '–').padEnd(15)} ${e.error ? `error: ${e.error}` : e.skipped ? e.skipped : Object.entries(e.imported || {}).map(([k, b]) => `${k} ${b.written}${b.invalid ? ` (${b.invalid} invalid: ${b.errors[0] || ''})` : ''}`).join(', ') || 'nothing new'}`);
    say(`  total: ${Object.entries(r.totals).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing imported'}`);
    return;
  }
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
    if (what === 'gpu-ledger') { if (!o.out) throw new Error('--out usage.jsonl'); const r = toGpuLedger(store, { from: time(o.from), to: time(o.to), cluster: o.cluster && o.cluster !== true ? o.cluster : null }); fs.writeFileSync(o.out, r.usage.map(x => JSON.stringify(x)).join('\n') + (r.usage.length ? '\n' : '')); if (o.capacity && o.capacity !== true) fs.writeFileSync(o.capacity, JSON.stringify(r.capacity, null, 1)); if (J) OUT.exported = { file: o.out, usage: r.usage.length, capacity: r.capacity }; else say(`wrote ${r.usage.length} usage records to ${o.out}${o.capacity && o.capacity !== true ? ` and capacity to ${o.capacity}` : ''} (gpu-ledger report --usage ${o.out})`); return; }
    throw new Error('export gpu-health | fleetscope-trace | gpu-ledger');
  }
  throw new Error(`unknown: data ${cmd}\n\n${HELP}`);
}
