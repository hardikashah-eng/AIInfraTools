#!/usr/bin/env node
// Checks the Inference Sizer against measured runs from InferenceX (SemiAnalysis's open, continuous inference
// benchmark): for each aggregated, single-node run of a GPU the sizer knows, the sizer predicts time per output token
// and output tokens/s per GPU for the same layout and concurrency, and compares with what was measured.
//
//   node inference-sizer/tools/validate-inferencex.mjs [--data benchmarks.json] [--json] [--markdown FILE]
//
// Three predictors, so the numbers mean something:
//   roofline    the datasheet back-of-envelope: 100% of spec bandwidth and compute, no per-step overhead
//   defaults    the sizer as shipped (spec sheet × default efficiencies)
//   calibrated  efficiencies fitted per GPU on the 1k-in/1k-out runs, scored only on the 8k/1k and 1k/8k runs
//
// Data: a recorded snapshot of the InferenceX public API (the dashboard's test fixture), fetched with git at a pinned
// commit and checked by SHA-256. It is not copied into this repository (the dashboard repository is GPL-3.0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const C = require('../src/catalog.js'), M = require('../src/model.js');

export const SOURCE = {
  repo: 'https://github.com/SemiAnalysisAI/InferenceX-app', commit: '187628924b6ec899b1f3f771617655dd4cd61d8c',
  path: 'packages/app/cypress/fixtures/api/benchmarks.json', sha256: 'f46823a76cb63248705329f327e1494df02b4dfa4df0898b7ee084c75c20bd52',
};
export const GPU = { b200: 'B200', b300: 'B300', h200: 'H200', h100: 'H100', mi300x: 'MI300X', mi325x: 'MI325X', mi355x: 'MI355X', gb200: 'GB200-NVL72', gb300: 'GB300-NVL72' };
const MODEL = { dsr1: 'deepseek-v3' }; // DeepSeek-R1 has DeepSeek-V3's architecture

export function fetchData(cache = path.join(os.homedir(), '.cache', 'aiinfra-tools', 'inferencex', SOURCE.commit.slice(0, 12))) {
  const file = path.join(cache, 'benchmarks.json');
  if (!fs.existsSync(file)) {
    const repo = path.join(cache, 'repo'); fs.mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: Object.assign({}, process.env, { GIT_LFS_SKIP_SMUDGE: '1' }), timeout: 600000 });
    if (!fs.existsSync(path.join(repo, '.git'))) { git('init', '-q'); git('remote', 'add', 'origin', SOURCE.repo); }
    git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', SOURCE.commit);
    fs.writeFileSync(file, git('show', `${SOURCE.commit}:${SOURCE.path}`));
    fs.rmSync(repo, { recursive: true, force: true });
  }
  return check(file);
}
function check(file) {
  const buf = fs.readFileSync(file), h = crypto.createHash('sha256').update(buf).digest('hex');
  if (h !== SOURCE.sha256) throw new Error(`${file}: SHA-256 ${h} is not the pinned snapshot's ${SOURCE.sha256}`);
  return JSON.parse(buf.toString());
}

// the same layout and concurrency, predicted by the sizer
export function predict(r, over) {
  const g = C.GPUS.find(x => x.id === GPU[r.hardware]), m = C.MODELS.find(x => x.id === MODEL[r.model]);
  const s = Object.assign({}, M.SETTINGS, m, g, { wprec: r.precision, kvprec: 'fp8', avgIn: r.isl, peakIn: r.isl, avgOut: r.osl, peakOut: r.osl, ctx: r.isl + r.osl, prefixHit: 0 }, over || {});
  const n = r.decode_tp;
  return M.operatingPoint(s, M.derive(s), { g: n, kind: r.decode_dp_attention ? 'DPEP' : 'TPEP', pp: 1, tpl: n }, r.conc);
}
export const usable = rows => rows.filter(r => !r.disagg && !r.is_multinode && GPU[r.hardware] && MODEL[r.model] && r.metrics && r.metrics.median_tpot > 0 && r.metrics.output_tput_per_gpu > 0);
const ROOF = { effDecodeBW: 1, effDecodeComp: 1, effPrefill: 1, stepMs: 0 };
const GRID = []; for (const effDecodeBW of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) for (const effDecodeComp of [0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.45]) for (const stepMs of [1.5, 3, 4.5, 6, 8, 10, 13, 16]) for (const effPrefill of [0.03, 0.05, 0.08, 0.12, 0.2, 0.3, 0.45]) GRID.push({ effDecodeBW, effDecodeComp, stepMs, effPrefill });

const lerr = (p, m) => Math.log(p / m); // signed log error: >0 the sizer predicts more than measured
function score(rs, over) {
  return rs.map(r => { const p = predict(r, typeof over === 'function' ? over(r) : over), m = r.metrics;
    return { r, tpot: lerr(p.tpot, m.median_tpot), thr: lerr(p.outPerGpu, m.output_tput_per_gpu), ttft: lerr(p.ttft, m.median_ttft) }; });
}
export function fit(rs) {
  let best = null;
  for (const g of GRID) { const l = score(rs, g).reduce((a, x) => a + x.tpot ** 2 + x.thr ** 2, 0); if (!best || l < best.l) best = { g, l }; }
  return best.g;
}
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))] : NaN; };
// "off by" as a ratio: exp(|log error|) - 1, so 0.4 means 40% too high or 1.4× too low alike
export function summary(e) {
  const abs = k => e.map(x => Math.abs(x[k])), sg = k => e.map(x => x[k]);
  const f = x => Math.exp(x) - 1;
  return { n: e.length, tpot: { median: f(q(abs('tpot'), 0.5)), p90: f(q(abs('tpot'), 0.9)), bias: Math.exp(q(sg('tpot'), 0.5)) },
    thr: { median: f(q(abs('thr'), 0.5)), p90: f(q(abs('thr'), 0.9)), bias: Math.exp(q(sg('thr'), 0.5)) }, ttft: { median: f(q(abs('ttft'), 0.5)), bias: Math.exp(q(sg('ttft'), 0.5)) } };
}

export function run(rows) {
  const all = usable(rows), isTrain = r => r.isl === 1024 && r.osl === 1024;
  const train = all.filter(isTrain), test = all.filter(r => !isTrain(r));
  const fits = {}; for (const hw of new Set(train.map(r => r.hardware))) fits[hw] = fit(train.filter(r => r.hardware === hw));
  const cal = r => fits[r.hardware];
  const calTest = test.filter(r => fits[r.hardware]);
  const res = {
    source: SOURCE, rows: rows.length, used: all.length, train: train.length, test: calTest.length,
    dates: [all.map(r => r.date).sort()[0], all.map(r => r.date).sort().pop()],
    overall: { roofline: summary(score(all, ROOF)), defaults: summary(score(all)), defaultsTest: summary(score(calTest)), calibratedTest: summary(score(calTest, cal)), calibratedTrain: summary(score(train, cal)) },
    byGpu: {}, byFramework: {}, byConc: {}, fits,
  };
  for (const hw of new Set(all.map(r => r.hardware))) { const a = all.filter(r => r.hardware === hw), t = calTest.filter(r => r.hardware === hw);
    res.byGpu[hw] = { runs: a.length, defaults: summary(score(a)), calibratedTest: t.length ? summary(score(t, cal)) : null }; }
  for (const fw of new Set(all.map(r => r.framework))) res.byFramework[fw] = summary(score(all.filter(r => r.framework === fw)));
  for (const b of [[1, 8], [16, 32], [64, 1e9]]) res.byConc[`${b[0]}–${b[1] > 1e8 ? '' : b[1]}`] = summary(score(all.filter(r => r.conc >= b[0] && r.conc <= b[1])));
  return res;
}

const P = x => `${Math.round(x * 100)}%`, B = x => `${x.toFixed(2)}×`;
export function markdown(R) {
  const row = (name, s) => `| ${name} | ${s.n} | ${P(s.tpot.median)} | ${P(s.tpot.p90)} | ${B(s.tpot.bias)} | ${P(s.thr.median)} | ${P(s.thr.p90)} | ${B(s.thr.bias)} |`;
  const head = '| | Runs | TPOT: median error | p90 | median predicted ÷ measured | Output tok/s per GPU: median error | p90 | median predicted ÷ measured |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  return [`# Inference Sizer against InferenceX`, '',
    `Generated by \`node inference-sizer/tools/validate-inferencex.mjs --markdown\`. Data: ${R.used} measured runs (aggregated, one node) of DeepSeek-R1 on ${Object.keys(R.byGpu).map(h => GPU[h]).join(', ')}, from a snapshot of the [InferenceX](https://github.com/SemiAnalysisAI/InferenceX) public API (runs dated ${R.dates[0]} to ${R.dates[1]}; [snapshot](${SOURCE.repo}/blob/${SOURCE.commit}/${SOURCE.path}), SHA-256 \`${SOURCE.sha256.slice(0, 16)}…\`). For each run the sizer predicts the same layout (TP, DP-attention) at the same concurrency, input and output lengths and precision.`, '',
    'Error is how far off the prediction is either way, as a ratio: 40% means 1.4× too high or 1.4× too low. "Predicted ÷ measured" says which way: for TPOT, below 1 means the sizer predicts faster tokens than were measured; for throughput, above 1 means it predicts more than was measured. Both are the optimistic direction.', '',
    '## Overall', '', head,
    row('Datasheet roofline (100% of spec, no overhead)', R.overall.roofline),
    row('Sizer defaults', R.overall.defaults),
    row('Sizer defaults, held-out runs only', R.overall.defaultsTest),
    row('**Calibrated per GPU on 1k/1k, scored on 8k/1k and 1k/8k**', R.overall.calibratedTest),
    row('Calibrated, on the runs it was fitted to', R.overall.calibratedTrain), '',
    '## By GPU (sizer defaults; calibrated on held-out runs)', '',
    '| GPU | Runs | Defaults: TPOT error | Defaults: tok/s error | Defaults: tok/s predicted ÷ measured | Calibrated (held out): TPOT error | Calibrated: tok/s error | Fitted efficiencies (decode BW, decode compute, step ms, prefill) |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(R.byGpu).map(([h, g]) => { const f = R.fits[h]; return `| ${GPU[h]} | ${g.runs} | ${P(g.defaults.tpot.median)} | ${P(g.defaults.thr.median)} | ${B(g.defaults.thr.bias)} | ${g.calibratedTest ? P(g.calibratedTest.tpot.median) : '–'} | ${g.calibratedTest ? P(g.calibratedTest.thr.median) : '–'} | ${f ? `${f.effDecodeBW}, ${f.effDecodeComp}, ${f.stepMs}, ${f.effPrefill}` : '–'} |`; }), '',
    '## By framework and concurrency (sizer defaults)', '', '| | Runs | TPOT error | tok/s error | tok/s predicted ÷ measured |', '| --- | --- | --- | --- | --- |',
    ...Object.entries(R.byFramework).map(([k, s]) => `| ${k} | ${s.n} | ${P(s.tpot.median)} | ${P(s.thr.median)} | ${B(s.thr.bias)} |`),
    ...Object.entries(R.byConc).map(([k, s]) => `| concurrency ${k} | ${s.n} | ${P(s.tpot.median)} | ${P(s.thr.median)} | ${B(s.thr.bias)} |`), ''].join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const rows = opt('--data') ? check(opt('--data')) : fetchData();
    const R = run(rows);
    if (a.includes('--json')) console.log(JSON.stringify(R, null, 1));
    else if (a.includes('--markdown')) { const f = opt('--markdown'); const md = markdown(R); if (f && !f.startsWith('--')) { fs.writeFileSync(f, md); console.log(`wrote ${f}`); } else console.log(md); }
    else { const o = R.overall; const line = (n, s) => console.log(`${n.padEnd(52)} TPOT off by ${P(s.tpot.median)} (p90 ${P(s.tpot.p90)}); tok/s/GPU off by ${P(s.thr.median)} (p90 ${P(s.thr.p90)}); n=${s.n}`);
      console.log(`InferenceX: ${R.used} runs of DeepSeek-R1 on ${Object.keys(R.byGpu).map(h => GPU[h]).join(', ')} (${R.dates[0]} to ${R.dates[1]})`);
      line('datasheet roofline', o.roofline); line('sizer defaults', o.defaults); line('calibrated on 1k/1k, scored on 8k/1k + 1k/8k', o.calibratedTest); }
  } catch (e) { console.error('validate-inferencex: ' + e.message); process.exit(1); }
}
