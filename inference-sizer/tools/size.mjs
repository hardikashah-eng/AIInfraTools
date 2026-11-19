#!/usr/bin/env node
// Inference Sizer from the command line.
//
//   node tools/size.mjs --model llama33-70b --gpu B200 [--set conc=800 --set tpot=25 ...]
//                       [--catalog specs/example.json] [--json] [--fleetscope graph.json] [--list]
//
// --set takes any input name from the page (see docs/METHOD.md); percentages are whole numbers except the
// engine efficiencies, which are fractions (effPrefill=0.4). --catalog adds or overrides GPUs and models
// from a spec sheet or a Hugging Face config.json. Exit code: 0 a plan was found, 1 none meets the targets, 2 usage error.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js'), X = require('../src/fleetscope.js');
const args = process.argv.slice(2), opt = { set: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const n = args[i + 1], has = n !== undefined && !n.startsWith('--');
  if (a === '--set') { if (has) { opt.set.push(n); i++; } continue; }
  opt[a.slice(2)] = has ? n : true; if (has) i++;
}
const die = m => { console.error(m); process.exit(2); };

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
  console.log('GPUs:'); for (const g of gpus) console.log(`  ${g.id.padEnd(16)} ${g.label}`);
  console.log('Models:'); for (const m of models) console.log(`  ${m.id.padEnd(20)} ${m.name}`);
  process.exit(0);
}
const m = models.find(x => x.id === (opt.model || 'llama33-70b')) || die(`Unknown model "${opt.model}". Use --list.`);
const g = gpus.find(x => x.id === (opt.gpu || 'B200')) || die(`Unknown GPU "${opt.gpu}". Use --list.`);
const s = Object.assign({}, M.SETTINGS, m, g, { model: m.id, gpu: g.id, modelLabel: m.name, gpuLabel: g.label });
for (const kv of opt.set) {
  const [k, v] = kv.split('=');
  if (!(k in s)) die(`Unknown input "${k}". Inputs: ${Object.keys(s).filter(x => !['id', 'name', 'label', 'source', 'vendor', 'builtin', 'custom'].includes(x)).join(', ')}`);
  s[k] = v === 'true' ? true : v === 'false' ? false : isFinite(+v) ? +v : v;
}
const r = M.plan(s);
const ms = t => (t * 1000).toFixed(t < 0.1 ? 1 : 0) + ' ms';
const out = {
  model: m.name, gpu: g.label, mode: r.chosen && r.chosen.mode, reason: r.reason,
  gpus: r.chosen && r.chosen.gpus, nodes: r.chosen && r.chosen.totalNodes, gpusPerNode: r.md.D, provisionedGpus: r.chosen && r.chosen.provGPUs,
  pools: !r.chosen ? [] : r.chosen.mode === 'disagg'
    ? [{ role: 'prefill', instances: r.dis.P.N, layout: r.dis.P.label, gpusPerInstance: r.dis.P.c.g }, { role: 'decode', instances: r.dis.D.N, layout: r.dis.D.label, gpusPerInstance: r.dis.D.c.g }]
    : [{ role: 'aggregated', instances: r.agg.best.N, layout: r.agg.best.label, gpusPerInstance: r.agg.best.c.g }],
  estimates: !r.chosen ? null : r.chosen.mode === 'disagg'
    ? { ttftAvgS: r.dis.P.ttftAvg, ttftPeakS: r.dis.P.ttftPeak, tpotS: r.dis.D.tpotOp }
    : { ttftAvgS: r.agg.best.ttftAvg, ttftPeakS: r.agg.best.ttftPeak, tpotS: r.agg.best.tpotOp },
  costPerMOutputTokens: r.econ.perMOut, tpotSensitivity: r.sens,
  floors: { tpotS: r.tpotFloor, ttftS: r.ttftFloor },
};
if (opt.json) console.log(JSON.stringify(out, null, 2));
else if (!r.chosen) console.log(`No ${g.label} layout meets TTFT ${s.ttft} ms / TPOT ${s.tpot} ms for ${m.name}. Fastest possible: TPOT ${ms(r.tpotFloor)}, peak-prompt TTFT ${ms(r.ttftFloor)}.`);
else {
  console.log(`${m.name} on ${g.label}`);
  console.log(`  ${out.pools.map(p => `${p.role}: ${p.instances} × ${p.layout}`).join('; ')}`);
  console.log(`  ${out.gpus} GPUs serving → ${out.nodes} × ${out.gpusPerNode}-GPU ${out.gpusPerNode > 8 ? 'racks' : 'nodes'} = ${out.provisionedGpus} GPUs provisioned`);
  console.log(`  TTFT ${ms(out.estimates.ttftAvgS)} avg / ${ms(out.estimates.ttftPeakS)} peak prompt; TPOT ${ms(out.estimates.tpotS)} (targets ${s.ttft} / ${s.tpot} ms)`);
  if (isFinite(out.costPerMOutputTokens)) console.log(`  $${out.costPerMOutputTokens.toFixed(2)} per 1M output tokens at $${s.price}/GPU-hr`);
  console.log(`  ${r.reason}`);
}
if (opt.fleetscope) {
  const x = X.toGraph(r);
  if (!x.ok) die('FleetScope export skipped: ' + x.errors.join(' '));
  writeFileSync(opt.fleetscope, JSON.stringify(x.graph, null, 1));
  console.error(`FleetScope graph written to ${opt.fleetscope}. ${x.notes.join(' ')}`);
}
process.exit(r.chosen ? 0 : 1);
