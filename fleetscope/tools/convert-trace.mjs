#!/usr/bin/env node
// Converts request logs into FleetScope's canonical trace CSV.
// Accepts vLLM OpenTelemetry spans (OTLP JSON lines or Jaeger JSON), gateway JSON logs
// (OpenAI / Anthropic / LiteLLM usage records), and CSV traces. Only timings and token counts are read.
//
// Usage:
//   node tools/convert-trace.mjs <input> [-o out.csv] [--start-offset SECONDS] [--minutes N] [--max-rows N] [--sample FRACTION]
//
//   --start-offset  skip this many seconds after the first request (pick a busy window)
//   --minutes       keep this many minutes from the start of the window (default: all)
//   --max-rows      keep at most this many requests (default: all)
//   --sample        keep this fraction of requests, deterministically (e.g. 0.1); replay with load multiplier 1/FRACTION
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IN = require('../src/ingest.js');

function usage(msg) {
  if (msg) console.error('Error: ' + msg + '\n');
  console.error('Usage: node tools/convert-trace.mjs <input> [-o out.csv] [--start-offset SECONDS] [--minutes N] [--max-rows N] [--sample FRACTION]');
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) usage();
let input = null, out = null;
const opt = { maxSeconds: Infinity, maxRows: Infinity, startOffsetS: 0 };
let sample = 1;
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => { const v = args[++i]; if (v == null) usage(a + ' needs a value'); return v; };
  if (a === '-o' || a === '--out') out = next();
  else if (a === '--start-offset') opt.startOffsetS = +next();
  else if (a === '--minutes') opt.maxSeconds = +next() * 60;
  else if (a === '--max-rows') opt.maxRows = +next();
  else if (a === '--sample') sample = +next();
  else if (a.startsWith('-')) usage('unknown option ' + a);
  else input = a;
}
if (!input) usage('no input file');
if (!(sample > 0 && sample <= 1)) usage('--sample must be in (0, 1]');

const res = IN.parseTrace(readFileSync(input, 'utf8'), opt);
let trace = res.trace;
if (sample < 1) {
  // Deterministic thinning: keep a request when a hash of its index falls under the fraction.
  trace = trace.filter((_, i) => ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296) < sample);
}
const csv = IN.toCSV(trace);
if (out) writeFileSync(out, csv); else process.stdout.write(csv);

const st = res.stats;
const pct = n => (st.requests ? Math.round(100 * n / st.requests) + '%' : '0%');
const span = trace.length ? trace[trace.length - 1].t - trace[0].t : 0;
console.error(`${res.format}: ${trace.length.toLocaleString('en-US')} request${trace.length === 1 ? '' : 's'} over ${Math.round(span)} s` +
  ` (recorded TTFT on ${pct(st.withTtft)}, cache hits on ${pct(st.withCached)}, ${st.sessions} sessions)` +
  (sample < 1 ? `; sampled at ${sample}, replay with load multiplier ${+(1 / sample).toFixed(2)}x` : '') +
  (res.notes.length ? '; ' + res.notes.join('; ') : '') + (out ? ` -> ${out}` : ''));
