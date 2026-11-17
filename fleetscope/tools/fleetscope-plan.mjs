#!/usr/bin/env node
// FleetScope plan for CI: run base and head versions of each scenario and print what changes, like `terraform plan`.
//
//   node tools/fleetscope-plan.mjs --git origin/main --scenarios scenarios [--out plan.md] [--comment 123] [--json]
//   node tools/fleetscope-plan.mjs --base DIR --head DIR [--out plan.md]
//
// A scenario folder holds graph.json, cluster.json, kueue.yaml|kueue.json, training.json and thresholds.json (all optional).
// With --git, base files are read from that git ref; only scenarios whose files differ are planned.
// Exit code: 0 all checks pass, 1 a check failed, 2 usage or read error.
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/plan.js');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const a = args[i]; if (!a.startsWith('--')) continue; const n = args[i + 1]; if (n === undefined || n.startsWith('--')) opt[a.slice(2)] = true; else { opt[a.slice(2)] = n; i++; } }
const FILES = ['graph.json', 'cluster.json', 'training.json', 'kueue.yaml', 'kueue.json', 'thresholds.json'];

function readDir(dir) {
  const sc = { name: dir }; let any = false;
  for (const f of FILES) { const p = join(dir, f); if (!existsSync(p)) continue; any = true; add(sc, f, readFileSync(p, 'utf8')); }
  return any ? sc : null;
}
function gitRead(ref, dir) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const sc = { name: dir }; let any = false;
  for (const f of FILES) {
    const rel = relative(root, resolve(dir, f)).split('\\').join('/');
    try { add(sc, f, execFileSync('git', ['show', ref + ':' + rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); any = true; } catch (e) { /* not in base */ }
  }
  return any ? sc : null;
}
function add(sc, f, text) {
  if (f === 'graph.json') sc.graph = JSON.parse(text);
  else if (f === 'cluster.json') sc.cluster = JSON.parse(text);
  else if (f === 'training.json') sc.training = JSON.parse(text);
  else if (f === 'thresholds.json') sc.thresholds = JSON.parse(text);
  else sc.kueue = text;
}

const plans = [];
try {
  if (opt.base && opt.head) plans.push({ name: opt.head, base: readDir(opt.base), head: readDir(opt.head) });
  else if (opt.git) {
    const root = opt.scenarios || 'scenarios';
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name), head = readDir(dir), base = gitRead(opt.git, dir);
      if (!head) continue;
      if (base && JSON.stringify(base, (k, v) => (k === 'name' ? undefined : v)) === JSON.stringify(head, (k, v) => (k === 'name' ? undefined : v))) continue;
      plans.push({ name: d.name, base, head });
    }
  } else { console.error('Give --git REF [--scenarios DIR], or --base DIR --head DIR'); process.exit(2); }
} catch (e) { console.error(e.message); process.exit(2); }

let failed = false;
const out = [];
for (const p of plans) {
  if (!p.head) { out.push('### ➖ `' + p.name + '` was removed'); continue; }
  const isNew = !p.base;
  const res = P.compare(p.base || p.head, p.head, { thresholds: p.head.thresholds });
  if (res.verdict === 'fail') failed = true;
  out.push(isNew ? P.markdown(res, { scenario: p.name }).replace('No changes to the scenario.', 'New scenario: these are its results.') : P.markdown(res, { scenario: p.name }));
  if (opt.json) console.log(JSON.stringify({ scenario: p.name, verdict: res.verdict, checks: res.checks, changes: res.changes, owners: res.owners }, null, 1));
}
const md = plans.length ? out.join('\n\n---\n\n') : '### ➖ FleetScope plan\nNo scenario changed.';
if (opt.out) writeFileSync(opt.out, md + '\n');
if (!opt.json) console.log(md);
if (opt.comment) execFileSync('gh', ['pr', 'comment', String(opt.comment), '--body', md], { stdio: 'inherit' });
process.exit(failed ? 1 : 0);
