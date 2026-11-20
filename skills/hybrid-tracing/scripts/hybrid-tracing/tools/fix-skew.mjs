#!/usr/bin/env node
// Estimates and removes clock skew from exported OTLP/JSON traces (a request, an array, or JSON lines such as the
// collector's file exporter writes). Prints a per-machine offset report.
//
//   node tools/fix-skew.mjs traces.jsonl [-o fixed.jsonl] [--ref-site onprem] [--site-key site]
//                           [--known offsets.json] [--min-correction-ns 1000] [--dry-run] [--json]
//   node tools/fix-skew.mjs --demo            # synthetic hybrid traces with known offsets
//
// Exit code: 0 corrected (or nothing to do), 1 causality violations remain, 2 usage error.
import { readFileSync, writeFileSync } from 'node:fs';
import { readRequests, fix } from '../src/skew.mjs';
import { generate, TRUE_OFFSETS_NS } from '../src/synth.mjs';

const args = process.argv.slice(2), opt = {}, files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') { opt.out = args[++i]; continue; }
  if (!a.startsWith('--')) { files.push(a); continue; }
  const k = a.slice(2), n = args[i + 1];
  if (n !== undefined && !n.startsWith('-')) { opt[k] = n; i++; } else opt[k] = true;
}
const die = msg => { console.error(msg); process.exit(2); };
let requests, truth = null;
if (opt.demo) { const g = generate({ requests: opt.demo === true ? 400 : +opt.demo || 400 }); requests = [g.request]; truth = g.offsets; }
else {
  if (!files.length) die('Usage: fix-skew.mjs <traces.json|jsonl> [-o out.jsonl] [--ref-site onprem] [--dry-run] [--json], or --demo');
  try { requests = files.flatMap(f => readRequests(readFileSync(f, 'utf8'))); } catch (e) { die(e.message); }
}
const { report } = fix(requests, {
  refSite: opt['ref-site'] || 'onprem', siteKey: opt['site-key'] || 'site', dryRun: !!opt['dry-run'],
  minCorrectionNs: +(opt['min-correction-ns'] || 0), known: opt.known ? JSON.parse(readFileSync(opt.known, 'utf8')) : {},
});
if (opt.out) writeFileSync(opt.out, requests.map(r => JSON.stringify(r)).join('\n') + '\n');
if (opt.json) { console.log(JSON.stringify(Object.assign({}, report, { edges: undefined }), null, 2)); }
else {
  const us = ns => ns == null ? '–' : (ns / 1000).toFixed(1);
  console.log(`${report.spans} spans, ${report.twoWaySamples} two-way and ${report.oneWaySamples} one-way cross-machine exchanges`);
  console.log(`Ordering violations: ${report.before.startBeforeParent + report.before.endAfterParent} before → ${report.after.startBeforeParent + report.after.endAfterParent} after (of ${report.before.checked} cross-machine pairs)`);
  console.log('');
  console.log(['machine', 'site', 'method', 'offset µs', '± µs', 'exchanges'].concat(truth ? ['true µs'] : []).map((h, i) => i < 3 ? h.padEnd(i === 0 ? 14 : 10) : h.padStart(11)).join(''));
  for (const r of report.rows) {
    console.log([r.domain.padEnd(14), (r.site || '').padEnd(10), r.method.padEnd(10), us(r.offsetNs).padStart(11), us(r.errNs).padStart(11), String(r.samples || 0).padStart(11)].concat(truth ? [us(truth[r.domain]).padStart(11)] : []).join(''));
  }
  if (report.rows.some(r => r.method === 'unanchored' || r.method === 'none')) console.log('\nMachines marked unanchored or none have no exchange that reaches the reference site and were left as recorded.');
  if (opt.out) console.log(`\nCorrected traces written to ${opt.out}.`);
}
process.exit(report.after.startBeforeParent + report.after.endAfterParent > 0 && !opt['dry-run'] ? 1 : 0);
