#!/usr/bin/env node
// The Inference Sizer against SemiAnalysis AgentX: agentic multi-turn traffic (long contexts, ~95% prefix-cache hits,
// subagent bursts) measured on real GPUs. For each AgentX result the sizer predicts the same layout at the same load
// (calls in flight from the measured rate and latency, Little's law), with the prompt, output and cache hit the run
// recorded, and is scored on TPOT and output tokens/s per GPU. With --fit it also fits the sizer's efficiencies per GPU
// on one part of the results and scores the rest.
//
//   node tools/validate-agentx.mjs --results DIR|FILE… [--models map.json] [--hf-config ID=config.json] [--fit] [--markdown|--json]
//
// Results: AgentX aggregate JSON as InferenceX writes it (infx/results/agentic: hw, model, framework, precision, conc,
// tp, ep, dp_attention, num_gpus, disagg, request_metrics.{tokens, latency, throughput.per_gpu, qps, cache},
// server_metrics.cache), one per file or as an array. They are not in this repository: download them from InferenceX.
// Models: AgentX names models by prefix (dsv4, glm5.3, kimi-k3…). --models maps a prefix to a sizer model id; a model
// the catalog lacks can be added from its Hugging Face config.json with --hf-config ID=path.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { GPU, summary } from './validate-inferencex.mjs';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js');

export const MODELS = { dsr1: 'deepseek-v3', dsv3: 'deepseek-v3', 'kimi-k2': 'kimi-k2', 'qwen3-235b': 'qwen3-235b', 'qwen3-coder': 'qwen3-coder-480b', 'gpt-oss-120b': 'gpt-oss-120b', llama4: 'llama4-maverick' };
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const firstNum = (o, ps) => { for (const p of ps) { const v = get(o, p); const n = typeof v === 'object' && v ? (v.mean ?? v.avg ?? v.median ?? v.p50) : v; if (Number.isFinite(+n) && n !== null && n !== '') return +n; } return null; };

// One AgentX result → the fields the sizer needs (null when the result can't be scored)
export function normalize(r, models = MODELS, catalog = C.MODELS) {
  const hw = String(r.hw || r.hardware || '').toLowerCase().replace(/-(nv|sxm|oam).*$/, '');
  const prefix = String(r.infmax_model_prefix || r.model || '').toLowerCase();
  const key = Object.keys(models).sort((a, b) => b.length - a.length).find(k => prefix.startsWith(k.toLowerCase()));
  const model = key && catalog.find(m => m.id === models[key]), gpu = C.GPUS.find(g => g.id === GPU[hw]);
  const rm = r.request_metrics || r.metrics || {};
  const tpot = firstNum(rm, ['latency.tpot.median', 'latency.tpot.p50', 'latency.tpot', 'median_tpot']);
  const ttft = firstNum(rm, ['latency.ttft.median', 'latency.ttft.p50', 'latency.ttft', 'median_ttft']);
  const e2e = firstNum(rm, ['latency.e2el.mean', 'latency.e2el.median', 'latency.e2el', 'mean_e2el']);
  const qps = firstNum(rm, ['qps.mean', 'qps', 'mean_qps']);
  const isl = firstNum(rm, ['tokens.input', 'tokens.input_tokens', 'mean_isl']), osl = firstNum(rm, ['tokens.output_actual', 'tokens.output', 'mean_osl']);
  const outPerGpu = firstNum(rm, ['throughput.per_gpu.output_tput_tps', 'output_tput_per_gpu']);
  const hit = firstNum(r, ['server_metrics.cache.gpu_cache_hit_rate', 'request_metrics.cache.theoretical_cache_hit_rate', 'cache_hit_rate']);
  const tp = +(r.decode_tp || r.tp || r.num_gpus || 0), why = [];
  if (!gpu) why.push(`GPU ${r.hw || r.hardware}`); if (!model) why.push(`model ${prefix}`); if (r.disagg) why.push('disaggregated'); if (r.is_multinode) why.push('multi-node');
  if (!(tpot > 0 && outPerGpu > 0 && qps > 0 && e2e > 0 && isl > 0 && osl > 0)) why.push('metrics');
  if (why.length) return { skip: why.join(', ') };
  // seconds, unless the value only makes sense in milliseconds (a TPOT over 5 s, a TTFT or call over 10 minutes)
  const tpotS = tpot > 5 ? tpot / 1000 : tpot, ttftS = ttft != null ? (ttft > 60 ? ttft / 1000 : ttft) : null, e2eS = e2e > 600 ? e2e / 1000 : e2e;
  return { hardware: hw, gpu: gpu.id, model: model.id, prefix, framework: r.framework, precision: r.precision || model.wprec, tp: tp || gpu.domain || 8, dpAttention: !!(r.dp_attention || r.decode_dp_attention),
    conc: +r.conc, inflight: Math.max(1, qps * e2eS), isl, osl, prefixHit: hit != null ? 100 * (hit > 1 ? hit / 100 : hit) : 0, metrics: { tpot: tpotS, ttft: ttftS, outPerGpu } };
}

export function predict(x, over, catalog = C.MODELS) {
  const g = C.GPUS.find(v => v.id === x.gpu), m = catalog.find(v => v.id === x.model);
  const s = Object.assign({}, M.SETTINGS, m, g, { wprec: x.precision, kvprec: 'fp8', avgIn: x.isl, peakIn: x.isl, avgOut: x.osl, peakOut: x.osl, ctx: Math.max(x.isl + x.osl, m.maxCtx || 0), prefixHit: x.prefixHit }, over || {});
  // calls in flight per instance: the run's in-flight calls spread over its instances
  const inst = Math.max(1, Math.round((x.numGpus || x.tp) / x.tp));
  return M.operatingPoint(s, M.derive(s), { g: x.tp, kind: x.dpAttention ? 'DPEP' : 'TPEP', pp: 1, tpl: x.tp }, Math.max(1, Math.round(x.inflight / inst)));
}
const lerr = (p, m) => Math.log(p / m);
const score = (xs, over, cat) => xs.map(x => { const p = predict(x, typeof over === 'function' ? over(x) : over, cat); return { x, tpot: lerr(p.tpot, x.metrics.tpot), thr: lerr(p.outPerGpu, x.metrics.outPerGpu), ttft: x.metrics.ttft ? lerr(p.ttft, x.metrics.ttft) : 0 }; });
const GRID = []; for (const effDecodeBW of [0.4, 0.55, 0.7, 0.85]) for (const effDecodeComp of [0.03, 0.06, 0.1, 0.2, 0.35]) for (const stepMs of [1.5, 4, 8, 14]) for (const effPrefill of [0.05, 0.15, 0.3, 0.5]) GRID.push({ effDecodeBW, effDecodeComp, stepMs, effPrefill });
export function fit(xs, cat) { let best = null; for (const g of GRID) { const l = score(xs, g, cat).reduce((a, e) => a + e.tpot ** 2 + e.thr ** 2, 0); if (!best || l < best.l) best = { g, l }; } return best && best.g; }

export function run(results, opt = {}) {
  const cat = opt.catalog || C.MODELS, models = Object.assign({}, MODELS, opt.models || {});
  const norm = results.map(r => ({ r, x: normalize(r, models, cat) }));
  const xs = norm.filter(n => !n.x.skip).map(n => Object.assign(n.x, { numGpus: +n.r.num_gpus || n.x.tp }));
  const skipped = {}; for (const n of norm) if (n.x.skip) skipped[n.x.skip] = (skipped[n.x.skip] || 0) + 1;
  const res = { results: results.length, scored: xs.length, skipped, overall: xs.length ? { defaults: summary(score(xs, undefined, cat)) } : null, byGpu: {}, byModel: {}, fits: {} };
  for (const gpu of new Set(xs.map(x => x.gpu))) res.byGpu[gpu] = summary(score(xs.filter(x => x.gpu === gpu), undefined, cat));
  for (const m of new Set(xs.map(x => x.model))) res.byModel[m] = summary(score(xs.filter(x => x.model === m), undefined, cat));
  if (opt.fit && xs.length) {
    // fit per GPU on every other concurrency level, score the rest
    const isTrain = x => { const levels = [...new Set(xs.filter(y => y.gpu === x.gpu).map(y => y.conc))].sort((a, b) => a - b); return levels.indexOf(x.conc) % 2 === 0; };
    for (const gpu of new Set(xs.map(x => x.gpu))) { const tr = xs.filter(x => x.gpu === gpu && isTrain(x)); if (tr.length) res.fits[gpu] = fit(tr, cat); }
    const test = xs.filter(x => !isTrain(x) && res.fits[x.gpu]);
    if (test.length) { res.overall.defaultsTest = summary(score(test, undefined, cat)); res.overall.calibratedTest = summary(score(test, x => res.fits[x.gpu], cat)); }
  }
  return res;
}

const P = x => `${Math.round(x * 100)}%`, B = x => `${x.toFixed(2)}×`;
export function markdown(R) {
  const row = (n, s) => `| ${n} | ${s.n} | ${P(s.tpot.median)} | ${P(s.tpot.p90)} | ${B(s.tpot.bias)} | ${P(s.thr.median)} | ${P(s.thr.p90)} | ${B(s.thr.bias)} |`;
  const head = '| | Results | TPOT: median error | p90 | predicted ÷ measured | Output tok/s per GPU: median error | p90 | predicted ÷ measured |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  const L = ['# Inference Sizer against AgentX', '', `${R.scored} of ${R.results} AgentX results scored.${Object.keys(R.skipped).length ? ' Skipped: ' + Object.entries(R.skipped).map(([k, v]) => `${v} (${k})`).join('; ') + '.' : ''}`, '', head];
  if (R.overall) { L.push(row('Sizer defaults', R.overall.defaults)); if (R.overall.calibratedTest) { L.push(row('Defaults, held-out concurrency levels', R.overall.defaultsTest)); L.push(row('**Calibrated per GPU, held-out concurrency levels**', R.overall.calibratedTest)); } }
  L.push('', '| GPU | Results | TPOT error | tok/s error | tok/s predicted ÷ measured |', '| --- | --- | --- | --- | --- |', ...Object.entries(R.byGpu).map(([g, s]) => `| ${g} | ${s.n} | ${P(s.tpot.median)} | ${P(s.thr.median)} | ${B(s.thr.bias)} |`), '');
  return L.join('\n');
}

function readResults(paths) {
  const out = [];
  const add = j => { if (Array.isArray(j)) j.forEach(add); else if (j && (j.data || j.results) && !j.request_metrics) add(j.data || j.results); else if (j && typeof j === 'object') out.push(j); };
  for (const p of paths) {
    const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p];
    for (const f of files) { try { add(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { throw new Error(`${f}: ${e.message}`); } }
  }
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = { results: [], hf: [] };
  for (let i = 0; i < a.length; i++) { if (a[i] === '--results') { while (a[i + 1] && !a[i + 1].startsWith('--')) o.results.push(a[++i]); } else if (a[i] === '--hf-config') o.hf.push(a[++i]); else if (a[i] === '--models') o.models = JSON.parse(fs.readFileSync(a[++i], 'utf8')); else o[a[i].replace(/^--/, '')] = true; }
  if (!o.results.length || o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(o.results.length ? 0 : 2); }
  const catalog = [...C.MODELS];
  for (const h of o.hf) { const [id, f] = h.split('='); const m = C.fromHFConfig(JSON.parse(fs.readFileSync(f, 'utf8'))).model; catalog.push(Object.assign({}, C.MODEL_DEFAULTS || {}, m, { id })); }
  const R = run(readResults(o.results), { fit: !!o.fit, models: o.models, catalog });
  console.log(o.json ? JSON.stringify(R, null, 1) : o.markdown ? markdown(R) : markdown(R));
}
