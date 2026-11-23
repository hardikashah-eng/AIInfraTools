#!/usr/bin/env node
// Inference Sizer from the command line.
//
//   node tools/size.mjs --model llama33-70b --gpu B200 [--set conc=800 --set tpot=25 ...]
//                       [--input inputs.json|-] [--catalog specs/example.json] [--calibration profile.json] [--json] [--fleetscope graph.json]
//   node tools/size.mjs --model llama33-70b --compare B200,H200,MI300X [--json]   # same targets on several GPUs, cheapest first
//   node tools/size.mjs --list [--json]                                           # GPU and model ids (with specs in JSON)
//
// --input takes a JSON object of inputs ({ "model": "...", "gpu": "...", "conc": 800, "tpot": 25, ... }; "-" reads stdin).
// --set takes any input name from the page (see docs/METHOD.md) and wins over --input. Percentages are whole numbers
// except the engine efficiencies, which are fractions (effPrefill=0.4). --catalog adds or overrides GPUs and models
// from a spec sheet or a Hugging Face config.json. --calibration applies measured engine efficiencies for the GPU and
// model from a calibration profile (fleetops calibrate benchmarks); --input and --set still win over it.
// Exit code: 0 a plan was found (for --compare: on at least one GPU), 1 none meets the targets, 2 usage error.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js'), X = require('../src/fleetscope.js');
const args = process.argv.slice(2), opt = { set: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const n = args[i + 1], has = n !== undefined && (!n.startsWith('--') || n === '-');
  if (a === '--set') { if (has) { opt.set.push(n); i++; } continue; }
  opt[a.slice(2)] = has ? n : true; if (has) i++;
}
const die = m => { if (opt.json) console.log(JSON.stringify({ error: m })); else console.error(m); process.exit(2); };

let gpus = C.GPUS.slice(), models = C.MODELS.slice();
if (opt.catalog) {
  for (const f of String(opt.catalog).split(',')) {
    const r = C.parseSheet(readFileSync(f, 'utf8'));
    if (!r.gpus.length && !r.models.length) die(`${f}: ${r.errors.join('; ')}`);
    if (r.errors.length) console.error(`${f}: skipped ${r.errors.join('; ')}`);
    gpus = C.merge(gpus, r.gpus); models = C.merge(models, r.models);
  }
}
if (opt.list) {
  if (opt.json) {
    const strip = o => Object.fromEntries(Object.entries(o).filter(([k]) => !['builtin', 'custom'].includes(k)));
    console.log(JSON.stringify({ gpus: gpus.map(strip), models: models.map(strip), inputs: Object.keys(M.SETTINGS) }, null, 1));
  } else {
    console.log('GPUs:'); for (const g of gpus) console.log(`  ${g.id.padEnd(16)} ${g.label}`);
    console.log('Models:'); for (const m of models) console.log(`  ${m.id.padEnd(20)} ${m.name}`);
  }
  process.exit(0);
}

let input = {};
if (opt.input) {
  try { input = JSON.parse(readFileSync(opt.input === '-' ? 0 : opt.input, 'utf8')); } catch (e) { die(`--input: ${e.message}`); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) die('--input must be a JSON object of inputs');
}
const modelId = opt.model || input.model || 'llama33-70b';
const m = models.find(x => x.id === modelId) || die(`Unknown model "${modelId}". Use --list.`);
const META = ['id', 'name', 'label', 'source', 'vendor', 'builtin', 'custom'];
const coerce = v => (v === 'true' ? true : v === 'false' ? false : typeof v === 'string' && v !== '' && isFinite(+v) ? +v : v);

let calibration = null;
if (opt.calibration) { try { calibration = JSON.parse(readFileSync(opt.calibration, 'utf8')); } catch (e) { die(`--calibration: ${e.message}`); } }
const EFF_KEYS = ['effPrefill', 'effDecodeBW', 'effDecodeComp', 'stepMs'];
// The profile entry for this GPU and model, if the calibration has one: { key, eff: {…}, fitOn }.
function calibrationFor(g) {
  const p = calibration && calibration.sizer && (calibration.sizer[`${g.id}|${m.id}`] || calibration.sizer[`${g.id}|*`]);
  if (!p) return null;
  return { key: calibration.sizer[`${g.id}|${m.id}`] ? `${g.id}|${m.id}` : `${g.id}|*`, eff: Object.fromEntries(EFF_KEYS.filter(k => typeof p[k] === 'number').map(k => [k, p[k]])), fitOn: p.fitOn || '' };
}

function settingsFor(g) {
  const s = Object.assign({}, M.SETTINGS, m, g, { model: m.id, gpu: g.id, modelLabel: m.name, gpuLabel: g.label });
  const cal = calibrationFor(g);
  if (cal) Object.assign(s, cal.eff);
  const apply = (k, v) => { if (!(k in s)) die(`Unknown input "${k}". Inputs: ${Object.keys(s).filter(x => !META.includes(x)).join(', ')}`); s[k] = coerce(v); };
  for (const [k, v] of Object.entries(input)) if (!['model', 'gpu', 'compare'].includes(k)) apply(k, v);
  for (const kv of opt.set) { const i = kv.indexOf('='); apply(kv.slice(0, i), kv.slice(i + 1)); }
  return s;
}

function planFor(g) {
  const s = settingsFor(g), r = M.plan(s);
  const out = {
    model: m.name, modelId: m.id, gpu: g.label, gpuId: g.id, found: !!r.chosen, mode: r.chosen && r.chosen.mode, reason: r.reason,
    targets: { ttftMs: s.ttft, tpotMs: s.tpot, concurrency: r.conc != null ? r.conc : s.conc, contextTokens: s.ctx },
    gpus: r.chosen && r.chosen.gpus, nodes: r.chosen && r.chosen.totalNodes, gpusPerNode: r.md.D, provisionedGpus: r.chosen && r.chosen.provGPUs,
    pools: !r.chosen ? [] : r.chosen.mode === 'disagg'
      ? [{ role: 'prefill', instances: r.dis.P.N, layout: r.dis.P.label, gpusPerInstance: r.dis.P.c.g }, { role: 'decode', instances: r.dis.D.N, layout: r.dis.D.label, gpusPerInstance: r.dis.D.c.g }]
      : [{ role: 'aggregated', instances: r.agg.best.N, layout: r.agg.best.label, gpusPerInstance: r.agg.best.c.g }],
    estimates: !r.chosen ? null : r.chosen.mode === 'disagg'
      ? { ttftAvgS: r.dis.P.ttftAvg, ttftPeakS: r.dis.P.ttftPeak, tpotS: r.dis.D.tpotOp }
      : { ttftAvgS: r.agg.best.ttftAvg, ttftPeakS: r.agg.best.ttftPeak, tpotS: r.agg.best.tpotOp },
    pricePerGpuHour: s.price, costPerHour: r.chosen ? r.chosen.provGPUs * s.price : null,
    costPerMOutputTokens: r.econ.perMOut, tpotSensitivity: r.sens,
    floors: { tpotS: r.tpotFloor, ttftS: r.ttftFloor },
    calibration: (() => { const c = calibrationFor(g); return c ? { profile: c.key, fitOn: c.fitOn, efficiencies: Object.fromEntries(EFF_KEYS.map(k => [k, s[k]])) } : null; })(),
  };
  return { s, r, out };
}

const ms = t => (t * 1000).toFixed(t < 0.1 ? 1 : 0) + ' ms';
const compare = opt.compare || input.compare;
if (compare) {
  const ids = (Array.isArray(compare) ? compare : String(compare).split(',')).map(x => String(x).trim()).filter(Boolean);
  const rows = ids.map(id => { const g = gpus.find(x => x.id === id) || die(`Unknown GPU "${id}". Use --list.`); return planFor(g).out; });
  rows.sort((a, b) => (b.found - a.found) || ((a.costPerHour ?? Infinity) - (b.costPerHour ?? Infinity)));
  if (opt.json) console.log(JSON.stringify({ model: m.name, modelId: m.id, results: rows }, null, 2));
  else {
    console.log(`${m.name}: cheapest first`);
    for (const o of rows) console.log(o.found
      ? `  ${o.gpu.padEnd(30)} ${String(o.provisionedGpus).padStart(5)} GPUs  $${o.costPerHour.toFixed(0)}/h  ${o.pools.map(p => `${p.role} ${p.instances}×${p.layout}`).join(', ')}  TTFT ${ms(o.estimates.ttftPeakS)} peak, TPOT ${ms(o.estimates.tpotS)}`
      : `  ${o.gpu.padEnd(30)}  no layout meets the targets (fastest TPOT ${ms(o.floors.tpotS)}, TTFT ${ms(o.floors.ttftS)})`);
  }
  process.exit(rows.some(o => o.found) ? 0 : 1);
}

const gpuId = opt.gpu || input.gpu || 'B200';
const g = gpus.find(x => x.id === gpuId) || die(`Unknown GPU "${gpuId}". Use --list.`);
const { s, r, out } = planFor(g);
if (opt.json) console.log(JSON.stringify(out, null, 2));
else if (!r.chosen) console.log(`No ${g.label} layout meets TTFT ${s.ttft} ms / TPOT ${s.tpot} ms for ${m.name}. Fastest possible: TPOT ${ms(r.tpotFloor)}, peak-prompt TTFT ${ms(r.ttftFloor)}.`);
else {
  console.log(`${m.name} on ${g.label}`);
  console.log(`  ${out.pools.map(p => `${p.role}: ${p.instances} × ${p.layout}`).join('; ')}`);
  console.log(`  ${out.gpus} GPUs serving → ${out.nodes} × ${out.gpusPerNode}-GPU ${out.gpusPerNode > 8 ? 'racks' : 'nodes'} = ${out.provisionedGpus} GPUs provisioned`);
  console.log(`  TTFT ${ms(out.estimates.ttftAvgS)} avg / ${ms(out.estimates.ttftPeakS)} peak prompt; TPOT ${ms(out.estimates.tpotS)} (targets ${s.ttft} / ${s.tpot} ms)`);
  if (isFinite(out.costPerMOutputTokens)) console.log(`  $${out.costPerMOutputTokens.toFixed(2)} per 1M output tokens at $${s.price}/GPU-hr`);
  console.log(`  ${r.reason}`);
  if (out.calibration) console.log(`  calibrated efficiencies (${out.calibration.profile}, fit on ${out.calibration.fitOn || 'measurements'}): ${Object.entries(out.calibration.efficiencies).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
if (opt.fleetscope) {
  const x = X.toGraph(r);
  if (!x.ok) die('FleetScope export skipped: ' + x.errors.join(' '));
  writeFileSync(opt.fleetscope, JSON.stringify(x.graph, null, 1));
  console.error(`FleetScope graph written to ${opt.fleetscope}. ${x.notes.join(' ')}`);
}
process.exit(r.chosen ? 0 : 1);
