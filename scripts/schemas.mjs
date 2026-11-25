#!/usr/bin/env node
// JSON Schemas for the tools' --json output: the contract agents, dashboards and scripts build on.
//
//   node scripts/schemas.mjs           check every command's output against schemas/<id>.schema.json (CI)
//   node scripts/schemas.mjs --update  rewrite the schemas from the current output (after a deliberate change)
//
// A schema is inferred from real runs: a key present in every object seen is required, its type is fixed, and arrays
// carry the merged shape of their items. Extra keys are allowed, so adding a field never breaks the contract; removing
// or renaming one, or changing its type, does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../bin/aiinfra.mjs';
import { COMMANDS } from '../schemas/commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'schemas');
const MAXDEPTH = 6; // deeper than this, only the type is fixed

// all numbers are 'number': a count that happened to be whole in the samples may not be next time
const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

// ---- inference ----------------------------------------------------------------------------------------------------
function infer(values, depth = 0) {
  const types = new Set(values.map(typeOf));
  const s = { type: types.size === 1 ? [...types][0] : [...types].sort() };
  if (depth >= MAXDEPTH) return s;
  const objs = values.filter(v => typeOf(v) === 'object'), arrs = values.filter(v => typeOf(v) === 'array');
  if (objs.length) {
    const keys = [...new Set(objs.flatMap(Object.keys))];
    // objects keyed by data (node names, GPU ids…) rather than fields: describe their values, not their keys
    if (keys.length > 40 || keys.some(k => /[^A-Za-z0-9_$-]/.test(k) || /^\d/.test(k)) && keys.length > 8) {
      s.additionalProperties = infer(objs.flatMap(Object.values), depth + 1);
    } else {
      s.properties = Object.fromEntries(keys.sort().map(k => [k, infer(objs.filter(o => k in o).map(o => o[k]), depth + 1)]));
      const req = keys.filter(k => objs.every(o => k in o)).sort(); if (req.length) s.required = req;
    }
  }
  if (arrs.length) { const items = arrs.flat(); if (items.length) s.items = infer(items, depth + 1); }
  return s;
}

// ---- validation (the subset infer() writes) ----------------------------------------------------------------------
export function validate(s, v, at = '$', errs = []) {
  const t = typeOf(v), want = [].concat(s.type || []);
  const ok = !want.length || want.includes(t);
  if (!ok) { errs.push(`${at}: ${want.join('|')} expected, got ${t}`); return errs; }
  if (t === 'object') {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}: missing "${r}"`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && s.properties[k]) validate(s.properties[k], x, `${at}.${k}`, errs);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(s.additionalProperties, x, `${at}[${JSON.stringify(k)}]`, errs);
    }
  }
  if (t === 'array' && s.items) v.forEach((x, i) => validate(s.items, x, `${at}[${i}]`, errs));
  return errs;
}

// ---- running the commands ----------------------------------------------------------------------------------------
function exec(tool, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(ROOT, TOOLS[tool].file), ...args], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${tool} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
export function outputs(cmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `schema-${cmd.id}-`)), c = { dir };
  const setup = (cmd.setup ? cmd.setup(c) : []).map(([tool, ...a]) => { const o = exec(tool, a, dir); try { return JSON.parse(o); } catch { return o; } });
  const runs = [cmd.args(c, setup), ...(cmd.more || [])].map(a => {
    const o = exec(cmd.tool, a, dir);
    try { return JSON.parse(o); } catch { throw new Error(`${cmd.id}: output is not JSON: ${o.slice(0, 200)}`); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return runs;
}
export const schemaPath = id => path.join(DIR, `${id}.schema.json`);
export function schemaFor(cmd, runs) {
  return Object.assign({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `https://github.com/hardikashah-eng/AIInfraTools/schemas/${cmd.id}.schema.json`,
    title: `aiinfra ${cmd.tool} ${cmd.usage} --json` }, infer(runs));
}

function main() {
  const update = process.argv.includes('--update'), only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
  let bad = 0;
  for (const cmd of COMMANDS.filter(c => !only || c.id === only)) {
    const runs = outputs(cmd);
    if (update) { fs.writeFileSync(schemaPath(cmd.id), JSON.stringify(schemaFor(cmd, runs), null, 1) + '\n'); console.log(`wrote schemas/${cmd.id}.schema.json`); continue; }
    const s = JSON.parse(fs.readFileSync(schemaPath(cmd.id), 'utf8'));
    const errs = runs.flatMap(r => validate(s, r));
    if (errs.length) { bad++; console.error(`✗ ${cmd.id}\n  ${errs.slice(0, 10).join('\n  ')}`); } else console.log(`✓ ${cmd.id}`);
  }
  if (bad) { console.error(`\n${bad} command(s) changed their output. If the change is deliberate: node scripts/schemas.mjs --update`); process.exit(1); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
