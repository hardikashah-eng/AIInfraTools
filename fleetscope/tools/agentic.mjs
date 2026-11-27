#!/usr/bin/env node
// Agentic workloads for capacity planning: fit a profile of agent sessions from a real trace, generate synthetic sessions
// at any load, measure what a workload asks of a fleet, size GPUs for it, and check a profile against held-out sessions.
//
//   node tools/agentic.mjs fit TRACE [-o profile.json] [--cache-ttl 300]
//   node tools/agentic.mjs synth PROFILE --sessions-per-hour N [--hours 1] [--seed 1] [-o trace.csv|trace.jsonl]
//   node tools/agentic.mjs stats TRACE|PROFILE [--sessions-per-hour N] [--hours 1] [--ideal]
//   node tools/agentic.mjs size TRACE|PROFILE --sessions-per-hour N [--model qwen3-coder-480b] [--gpu B200] [--ttft 2000] [--tpot 30]
//        [--kv-offload [--cpu-kv-gb 375] [--pcie-gbs 64]]   KV beyond HBM held in host memory and reloaded over PCIe
//   node tools/agentic.mjs validate TRACE [--sessions-per-hour 600] [--hours 1] [--seeds 5] [--holdout 0.3] [--model …] [--gpu …] [--markdown]
//
// TRACE: TraceLab (syfi_coding_trace.jsonl[.gz], or the word "tracelab" to fetch the public release), AgentX / "weka" session
// JSON lines, Mooncake JSON lines, or FleetScope trace CSV/JSONL with session ids. Every command takes --json.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tracelabFile, TRACELAB } from './tracelab-data.mjs';

const require = createRequire(import.meta.url);
const IN = require('../src/ingest.js'), A = require('../src/agentic.js');
const C = require('../../inference-sizer/src/catalog.js'), M = require('../../inference-sizer/src/model.js');

export async function loadRows(file) {
  const stream = fs.createReadStream(file), input = file.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let kind = null; const rows = [], docs = [], text = [];
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    if (!kind) kind = s[0] === '{' || s[0] === '[' ? 'json' : 'csv';
    if (kind === 'csv') { text.push(line); continue; }
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o && o.timing_events && o.input_tokens_total != null) { const r = IN.tracelabRow(o); if (r) rows.push(r); }
    else if (o && o.kind === 'llm_call') rows.push({ t: o.t, isl: o.input, osl: Math.max(1, o.output), cached: o.cacheRead ?? undefined, session: o.session, agent: o.agent !== 'main' ? o.agent : undefined, api: o.durS });
    else if (o && o.t != null && o.isl != null) rows.push(o);
    else docs.push(o);
  }
  const ALL = { maxRows: Infinity, maxSeconds: Infinity };
  if (kind === 'csv') return { rows: IN.parseCSV(text.join('\n'), ALL).trace, format: 'FleetScope CSV' };
  if (rows.length) return { rows, format: rows[0].model !== undefined ? 'TraceLab' : 'rows' };
  const d0 = docs[0] || {};
  if (Array.isArray(d0.requests) || Array.isArray(d0)) { const r = IN.parseAgentX(docs, ALL); return { rows: r.trace, format: r.format }; }
  if (d0.input_length != null) { const r = IN.parseMooncake(docs, ALL); return { rows: r.trace, format: r.format }; }
  throw new Error(`${file}: not a trace this tool reads (TraceLab, AgentX, Mooncake, FleetScope CSV/JSONL)`);
}
const isProfile = f => { if (!/\.json$/.test(f)) return null; try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && j.kind === 'fleetscope.agentic-profile' ? j : null; } catch { return null; } };

function settings(o) {
  const m = C.MODELS.find(x => x.id === (o.model || 'qwen3-coder-480b')), g = C.GPUS.find(x => x.id === (o.gpu || 'B200'));
  if (!m) throw new Error(`unknown model ${o.model}; one of ${C.MODELS.map(x => x.id).join(', ')}`);
  if (!g) throw new Error(`unknown GPU ${o.gpu}; one of ${C.GPUS.map(x => x.id).join(', ')}`);
  return Object.assign({}, M.SETTINGS, m, g, { ttft: +(o.ttft || 2000), tpot: +(o.tpot || 30), ctx: m.maxCtx || M.SETTINGS.ctx, modelId: m.id, gpuId: g.id });
}
// requests longer than the model's context can't be served by it: cap them (and say how many)
function capped(rows, ctx) { let n = 0; const out = rows.map(r => (r.isl + r.osl > ctx ? (n++, Object.assign({}, r, { isl: Math.max(1, ctx - r.osl), cached: r.cached != null ? Math.min(r.cached, ctx - r.osl - 1) : r.cached })) : r)); return { rows: out, over: n }; }

export function sizeReport(rows, s, o = {}) {
  const c = capped(rows, s.ctx), st = A.workloadStats(c.rows, { cacheTtlS: o.cacheTtlS || 300 }), so = o.sizeOpts || {};
  return { stats: st, overContext: c.over, agentic: A.sizeFor(st, s, M, so), flat: A.sizeFor(A.flatStats(st), s, M), model: s.modelId, gpu: s.gpuId };
}

const pct = x => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
const k = x => (x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : (+x).toFixed(x < 10 ? 2 : 0));
export function validationMarkdown(V, sz, meta) {
  const L = [`# Agentic workload profiles against held-out sessions`, '',
    `Generated by \`node fleetscope/tools/agentic.mjs validate ${meta.file === TRACELAB.url.split('/').pop() ? 'tracelab' : meta.file} --hours ${V.settings.horizonS / 3600} --markdown\`. Data: ${meta.format === 'TraceLab' ? `[TraceLab](https://github.com/uw-syfi/TraceLab) ${TRACELAB.release} (${TRACELAB.license}; ${TRACELAB.citation})` : meta.format}, ${V.train.sessions + V.test.sessions} sessions (${k(V.train.rows + V.test.rows)} model calls). The profile is fitted on ${V.train.sessions} sessions and checked on the other ${V.test.sessions}: both are started on the same Poisson arrivals (${V.settings.sessionsPerHour} sessions/hour for ${V.settings.horizonS / 3600} h, ${V.settings.seeds.length} seeds); the held-out sessions keep their own recorded timing, the synthetic ones are drawn from the profile.`, '',
    '## What the workload asks of a fleet: synthetic vs replay', '', '| Metric | Replay (held out) | Synthetic | Mean error over seeds |', '| --- | --- | --- | --- |'];
  const r0 = V.runs[0];
  const label = { cacheHit: 'Prefix-cache hit rate', 'isl.mean': 'Prompt tokens, mean', 'isl.p90': 'Prompt tokens, p90', 'osl.mean': 'Output tokens, mean', 'rps.mean': 'Calls/s, mean', 'rps.p95': 'Calls/s, p95 minute', 'prefillTps.mean': 'Prefill tokens/s (uncached), mean', 'prefillTps.p95': 'Prefill tokens/s (uncached), p95 minute', 'decodeTps.mean': 'Output tokens/s, mean', 'decodeTps.p95': 'Output tokens/s, p95 minute', 'kvTokens.p95': 'KV working set (tokens), p95' };
  for (const key of A.KEYS) { const c = r0.cmp[key]; L.push(`| ${label[key]} | ${key === 'cacheHit' ? (100 * c.real).toFixed(1) + '%' : k(c.real)} | ${key === 'cacheHit' ? (100 * c.synth).toFixed(1) + '%' : k(c.synth)} | ${pct(V.agg[key].meanErr)} (abs ${(100 * V.agg[key].meanAbsErr).toFixed(1)}%) |`); }
  if (sz) {
    L.push('', `## GPUs: ${sz.real.model} on ${sz.real.gpu}, TTFT ${meta.ttft} ms, TPOT ${meta.tpot} ms`, '',
      '| Sized from | Compute GPUs | GPUs to hold the KV working set | GPUs | Bound by |', '| --- | --- | --- | --- | --- |',
      `| Held-out sessions, agentic (cache reuse and idle sessions counted) | ${sz.real.agentic.compute} | ${sz.real.agentic.kvGpus} | **${sz.real.agentic.gpus}** | ${sz.real.agentic.bound} |`,
      `| Synthetic sessions from the profile | ${sz.synth.agentic.compute} | ${sz.synth.agentic.kvGpus} | **${sz.synth.agentic.gpus}** | ${sz.synth.agentic.bound} |`,
      `| Held-out sessions, flat (same calls/s and mean ISL/OSL, no reuse, no idle sessions) | ${sz.real.flat.compute ?? 'no layout meets the targets'} | ${sz.real.flat.kvGpus} | **${sz.real.flat.gpus ?? '–'}** | ${sz.real.flat.compute == null ? 'prefilling the whole prompt every call misses the TTFT target' : sz.real.flat.bound} |`,
      `| The same flat sizing with the TTFT target relaxed to 10 s | ${sz.flatRelaxed.compute ?? '–'} | ${sz.flatRelaxed.kvGpus} | **${sz.flatRelaxed.gpus ?? '–'}** | ${sz.flatRelaxed.bound} |`, '',
      `${sz.real.overContext} of ${sz.real.stats.requests} replayed calls were longer than the model's ${k(meta.ctx)}-token context and were capped to it.`);
  }
  L.push('', '## Notes', '', '- Timing comes from the providers that served the trace (model time per call), not from the GPUs being sized; the profile carries the shape of the work — context growth, reuse, gaps, tool time — not latency.',
    '- The KV working set assumes contexts stay resident from one call to the next for up to the cache lifetime (' + V.settings.cacheTtlS + ' s). Offloading to CPU memory or storage lowers the GPUs it needs and adds reload time.',
    '- The flat row is how most sizing is done today: it overstates prefill (it re-prefills the whole prompt every call) and understates memory (it only counts in-flight requests).', '');
  return L.join('\n');
}

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '-o') o.out = argv[++i]; else if (a.startsWith('--')) { const n = argv[i + 1]; if (n !== undefined && !n.startsWith('--')) { o[a.slice(2)] = n; i++; } else o[a.slice(2)] = true; } else o._.push(a); } return o; }

export async function main(argv) {
  const o = args(argv), [cmd] = o._, out = (obj, txt) => console.log(o.json ? JSON.stringify(obj, null, 1) : txt);
  const ttl = +(o['cache-ttl'] || 300), horizonS = +(o.hours || 1) * 3600, sph = +(o['sessions-per-hour'] || 0);
  if (!cmd || o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  // "tracelab" stands for the public TraceLab trace, fetched at a pinned release and checked
  const file = o._[1] === 'tracelab' ? await tracelabFile(o.file) : o._[1];
  if (!file) throw new Error(`${cmd}: give a trace or profile file (or "tracelab")`);
  const prof = isProfile(file);
  const workload = async () => {
    if (prof) { if (!sph) throw new Error('a profile needs --sessions-per-hour'); return A.synthesize(prof, { sessionsPerHour: sph, horizonS, seed: +(o.seed || 1) }); }
    const { rows } = await loadRows(file);
    return sph ? A.replay(rows, { sessionsPerHour: sph, horizonS, seed: +(o.seed || 1) }) : rows;
  };
  if (cmd === 'fit') {
    const { rows, format } = await loadRows(file), p = A.fitProfile(rows, { cacheTtlS: ttl, source: `${format}: ${file.replace(/^.*[\\/]/, '')}` });
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(p) + '\n');
    const col = (name, f = 0.5) => { const i = p.main.paramsCols.indexOf(name), v = p.main.params.map(x => x[i]).sort((a, b) => a - b); return v[Math.floor(f * (v.length - 1))]; };
    out(o.out ? { wrote: o.out, sessions: p.sessions, requests: p.requests } : p, `${format}: ${p.sessions} sessions, ${p.requests} calls; cache hit ${(100 * p.cacheHit).toFixed(1)}%\n  per session (median): ${col('turns')} calls, first prompt ${k(col('firstIsl'))}, +${k(col('appendMean'))} tokens/call, ${col('shortGapMean').toFixed(1)} s between calls in the tool loop, ${(100 * col('longShare')).toFixed(0)}% of gaps over ${p.longGapS} s${o.out ? `\n  → ${o.out}` : ''}`);
    return 0;
  }
  if (cmd === 'synth') {
    if (!prof) throw new Error('synth needs a profile (from "fit")');
    const rows = A.synthesize(prof, { sessionsPerHour: sph || 600, horizonS, seed: +(o.seed || 1) });
    const body = o.out && o.out.endsWith('.csv') ? IN.toCSV(rows) : rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    if (o.out) fs.writeFileSync(o.out, body); else process.stdout.write(body);
    if (o.out) console.error(`${rows.length} calls in ${new Set(rows.map(r => r.session)).size} sessions → ${o.out}`);
    return 0;
  }
  if (cmd === 'stats') {
    const st = A.workloadStats(await workload(), { cacheTtlS: ttl, ideal: !!o.ideal });
    out(st, `${st.requests} calls, ${st.sessions} sessions over ${(st.seconds / 3600).toFixed(2)} h; cache hit ${(100 * st.cacheHit).toFixed(1)}%\n  prompt mean ${k(st.isl.mean)} p99 ${k(st.isl.p99)}; output mean ${k(st.osl.mean)}\n  p95 minute: ${st.rps.p95.toFixed(2)} calls/s, ${k(st.prefillTps.p95)} prefill tok/s, ${k(st.decodeTps.p95)} output tok/s\n  KV working set p95 ${k(st.kvTokens.p95)} tokens; in flight p95 ${st.inflight.p95}`);
    return 0;
  }
  if (cmd === 'size') {
    const sizeOpts = { kvOffload: !!o['kv-offload'], offload: Object.fromEntries([['cpuGBPerGpu', o['cpu-kv-gb']], ['pcieGBs', o['pcie-gbs']]].filter(([, v]) => v != null && v !== true).map(([k, v]) => [k, +v])) };
    const s = settings(o), rep = sizeReport(await workload(), s, { cacheTtlS: ttl, sizeOpts }), a = rep.agentic, f = a.offload;
    out(rep, `${rep.model} on ${rep.gpu}: agentic ${a.gpus} GPUs (compute ${a.compute}, KV working set ${a.kvGpus} → bound by ${a.bound}); flat ISL/OSL sizing would say ${rep.flat.gpus ?? 'no layout meets the targets'}${rep.overContext ? `; ${rep.overContext} calls capped at the model's context` : ''}`
      + `\n  KV offload ${a.kvOffloadUsed ? 'used' : !f.usable ? 'not usable here' : f.gpus < a.gpus ? 'would bring it to ' + f.gpus + ' GPUs (--kv-offload)' : 'not needed: compute sets the count'}: ${f.cpuGBPerGpu} GB host memory per GPU, ${(100 * f.offloadedShare).toFixed(0)}% of the working set off the GPUs, reload ${f.reloadMs.toFixed(0)} ms, PCIe ${(100 * (f.pcieUtil || 0)).toFixed(0)}% busy`
      + (a.power && a.power.tokensPerSecPerMW != null ? `\n  ${Math.round(a.power.tokensPerSecPerMW).toLocaleString('en-US')} output tokens/s per MW at the peak minute (${a.power.kw.toFixed(0)} kW, ${a.power.basis})` : ''));
    return 0;
  }
  if (cmd === 'validate') {
    const { rows, format } = await loadRows(file);
    const V = A.validate(rows, { sessionsPerHour: sph || 600, horizonS, holdout: +(o.holdout || 0.3), cacheTtlS: ttl, source: format, seeds: Array.from({ length: +(o.seeds || 5) }, (_, i) => i + 1) });
    const s = settings(o), r0 = V.runs[0], seed = r0.seed, starts = A.arrivals(0, V.settings.sessionsPerHour, horizonS, A.rng(seed * 7919));
    const real = A.replay(V.testRows, { seed, starts, horizonS });
    const sz = { real: sizeReport(real, s, { cacheTtlS: ttl }), synth: sizeReport(A.synthesize(V.profile, { seed, starts, horizonS }), s, { cacheTtlS: ttl }) };
    // flat sizing usually can't meet the TTFT at all (it prefills the whole prompt each call): what it asks for with 10 s
    sz.flatRelaxed = sizeReport(real, Object.assign({}, s, { ttft: 10000 }), { cacheTtlS: ttl }).flat;
    const res = { format, train: V.train, test: V.test, agg: V.agg, runs: V.runs.map(r => ({ seed: r.seed, cmp: r.cmp })), sizing: { real: { agentic: sz.real.agentic, flat: sz.real.flat, flatRelaxedTtft: sz.flatRelaxed, overContext: sz.real.overContext }, synth: { agentic: sz.synth.agentic } } };
    if (o.markdown) { console.log(validationMarkdown(V, sz, { file: file.replace(/^.*[\\/]/, ''), format, ttft: s.ttft, tpot: s.tpot, ctx: s.ctx })); return 0; }
    out(res, `${format}: fit on ${V.train.sessions} sessions, checked on ${V.test.sessions}\n` + A.KEYS.map(key => `  ${key.padEnd(15)} mean error ${pct(V.agg[key].meanErr)}`).join('\n') + `\n  GPUs (${s.modelId} on ${s.gpuId}): held-out ${sz.real.agentic.gpus}, synthetic ${sz.synth.agentic.gpus}, flat sizing ${sz.real.flat.gpus ?? 'no layout meets the targets'}`);
    return 0;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(`agentic: ${e.message}`); process.exitCode = 2; });
}
