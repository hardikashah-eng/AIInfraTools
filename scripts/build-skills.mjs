#!/usr/bin/env node
// Builds the Agent Skills in skills/ from the tools in this repo.
//
// Each skill folder holds a hand-written SKILL.md. Everything else in it is generated here: the tool's code under
// scripts/<tool>/, reference docs under references/, and examples under assets/. That makes every skill folder
// self-contained, so it works when copied on its own (claude.ai upload, another agent) as well as inside the plugin.
//
//   node scripts/build-skills.mjs            regenerate skills/*/scripts, references, assets
//   node scripts/build-skills.mjs --check    fail if the generated files are out of date, or a SKILL.md is invalid (CI)
//   node scripts/build-skills.mjs --zip DIR  also write DIR/<skill>.zip for upload
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const GENERATED = ['scripts', 'references', 'assets'];

// README as OVERVIEW.md plus every docs/*.md under its own name, so a new doc needs no edit here.
function docRefs(tool) {
  const dir = path.join(ROOT, tool, 'docs');
  return Object.assign({ 'README.md': 'OVERVIEW.md' }, ...fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => ({ [`docs/${f}`]: f })));
}

const SKILLS = {
  'inference-sizer': { tool: 'inference-sizer', code: ['src', 'tools', 'package.json'], refs: { 'README.md': 'OVERVIEW.md', 'docs/METHOD.md': 'METHOD.md', 'docs/SPEC-SHEETS.md': 'SPEC-SHEETS.md', 'docs/ACCELERATORS.md': 'ACCELERATORS.md' }, assets: { 'specs/example.json': 'example.json' } },
  // agentic.mjs sizes with the Inference Sizer's catalog and model
  'fleetscope': { tool: 'fleetscope', code: ['src', 'tools', 'package.json'], with: { 'inference-sizer': ['src/accelerators.js', 'src/catalog.js', 'src/model.js', 'package.json'] }, refs: { 'docs/ASK.md': 'ASK.md', 'docs/TRACES.md': 'TRACES.md', 'docs/CI.md': 'CI.md', 'docs/CALIBRATION.md': 'CALIBRATION.md', 'docs/AGENTIC.md': 'AGENTIC.md' }, assets: { 'scenarios/hybrid-chat': 'scenarios/hybrid-chat' }, generate: { 'references/NODE-TYPES.md': fleetNodeTypes } },
  'hybrid-tracing': { tool: 'hybrid-tracing', code: ['src', 'tools', 'clock', 'collector', 'deploy', 'package.json'], refs: { 'README.md': 'OVERVIEW.md', 'docs/CLOCKS.md': 'CLOCKS.md' }, assets: {} },
  'fleetops': { tool: 'fleetops', code: ['src', 'tools', 'deploy', 'install', 'examples', 'Dockerfile', 'package.json'],
    // fleetops imports these tools' code through ../../<tool>/src, so they sit next to it under scripts/
    with: { 'gpu-health': ['src', 'tools', 'package.json'], 'fleetscope': ['src', 'package.json'], 'inference-sizer': ['src', 'package.json'] },
    refs: docRefs('fleetops'), assets: {} },
  'gpu-ledger': { tool: 'gpu-ledger', code: ['src', 'tools', 'examples', 'package.json'], with: { 'inference-sizer': ['src', 'package.json'] }, refs: { 'README.md': 'OVERVIEW.md', 'docs/METHOD.md': 'METHOD.md' }, assets: { 'examples/ledger.example.json': 'ledger.example.json', 'examples/people.example.csv': 'people.example.csv' } },
  // harness-ledger prices self-hosted calls with gpu-ledger's rate card, which reads the accelerator registry
  // economics sizes self-hosting with FleetScope's agentic path and the Inference Sizer
  'harness-ledger': { tool: 'harness-ledger', code: ['src', 'tools', 'package.json'], with: { 'gpu-ledger': ['src/core.mjs', 'package.json'], 'inference-sizer': ['src/accelerators.js', 'src/catalog.js', 'src/model.js', 'package.json'], fleetscope: ['src/agentic.js', 'tools/tracelab-data.mjs', 'package.json'] }, refs: docRefs('harness-ledger'), assets: {} },
  'gpu-health': { tool: 'gpu-health', code: ['src', 'tools', 'examples', 'deploy', 'package.json'], refs: { 'README.md': 'OVERVIEW.md', 'docs/CONFIG.md': 'CONFIG.md', 'docs/RISK-PREDICTION.md': 'RISK-PREDICTION.md', 'docs/VENDORS.md': 'VENDORS.md', 'docs/FLAKINESS.md': 'FLAKINESS.md' }, assets: {} },
};

// Markdown copied into a skill: drop images (not shipped) and point doc links at the copied files.
function adaptMarkdown(text, refs) {
  const renamed = Object.fromEntries(Object.entries(refs).map(([from, to]) => [path.basename(from), to]));
  return text.split('\n').filter(l => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l)).join('\n')
    .replace(/\]\((?:\.\/)?(?:docs\/)?([A-Z][A-Z0-9-]*\.md)(#[^)]*)?\)/g, (m, f, h) => (renamed[f] ? `](${renamed[f]}${h || ''})` : m));
}

function fleetNodeTypes() {
  const TP = require(path.join(ROOT, 'fleetscope/src/templates.js'));
  const L = ['# FleetScope node types', '', 'Generated from `fleetscope/src/templates.js`. A graph is `{ "nodes": [{ "id", "type", "x", "y", "cfg": {…} }], "edges": [{ "from", "to" }] }`; the defaults below are what a new node of each type gets. Edit `cfg` fields; keep ids and edges unless adding nodes.', ''];
  for (const [type, t] of Object.entries(TP.NODE_TYPES)) {
    L.push(`## \`${type}\`: ${t.title}`, '', `Group: ${t.group || '–'}. Inputs: ${t.inputs === false ? 'none' : 'yes'}. Outputs: ${t.outputs === false ? 'none' : 'yes'}.`, '', '| Field | Default |', '|---|---|');
    for (const [k, v] of Object.entries(t.defaults())) L.push(`| \`${k}\` | \`${JSON.stringify(v)}\` |`);
    L.push('');
  }
  L.push('## Templates', '', '| id | name | what it shows |', '|---|---|---|', ...TP.TEMPLATES.map(t => `| \`${t.id}\` | ${t.name} | ${t.desc} |`), '');
  return L.join('\n');
}

const copyTree = (src, dst, filter) => {
  const st = fs.statSync(src);
  if (st.isDirectory()) { for (const e of fs.readdirSync(src).sort()) if (!filter || filter(path.join(src, e))) copyTree(path.join(src, e), path.join(dst, e), filter); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  if (st.mode & 0o111) fs.chmodSync(dst, 0o755);
};
const skipJunk = p => !/(^|\/)(node_modules|\.DS_Store|tests?)($|\/)/.test(p);

function buildSkill(name, out) {
  const s = SKILLS[name], toolDir = path.join(ROOT, s.tool);
  for (const g of GENERATED) fs.rmSync(path.join(out, g), { recursive: true, force: true });
  for (const item of s.code) copyTree(path.join(toolDir, item), path.join(out, 'scripts', s.tool, item), skipJunk);
  for (const [dep, items] of Object.entries(s.with || {})) for (const item of items) copyTree(path.join(ROOT, dep, item), path.join(out, 'scripts', dep, item), skipJunk);
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE.txt'));
  fs.writeFileSync(path.join(out, 'scripts', 'VENDORED.md'), `# Generated: do not edit\n\nCopied from \`${[s.tool, ...Object.keys(s.with || {})].join('/`, `')}/\` in the AIInfraTools repo by \`scripts/build-skills.mjs\`. Edit the tool there, then run \`node scripts/build-skills.mjs\`.\n`);
  for (const [from, to] of Object.entries(s.refs)) { const dst = path.join(out, 'references', to); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, adaptMarkdown(fs.readFileSync(path.join(toolDir, from), 'utf8'), s.refs)); }
  for (const [from, to] of Object.entries(s.assets)) copyTree(path.join(toolDir, from), path.join(out, 'assets', to), skipJunk);
  for (const [to, fn] of Object.entries(s.generate || {})) { const dst = path.join(out, to); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, fn()); }
}

// Agent Skills rules (agentskills.io/specification), plus a check that every script path SKILL.md mentions exists.
export function validateSkill(dir) {
  const errors = [], name = path.basename(dir), f = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(f)) return [`${name}: no SKILL.md`];
  const text = fs.readFileSync(f, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return [`${name}: SKILL.md needs YAML frontmatter between --- lines`];
  const fm = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0 && !/^\s/.test(line)) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  for (const k of Object.keys(fm)) if (!allowed.includes(k)) errors.push(`${name}: unknown frontmatter field "${k}"`);
  if (!fm.name) errors.push(`${name}: name is required`);
  else {
    if (fm.name !== name) errors.push(`${name}: name "${fm.name}" must match the folder name`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) || fm.name.length > 64) errors.push(`${name}: name must be 1-64 lowercase letters, digits and single hyphens`);
  }
  if (!fm.description) errors.push(`${name}: description is required`);
  else {
    if (fm.description.length > 1024) errors.push(`${name}: description is ${fm.description.length} characters (max 1024)`);
    if (/[<>]/.test(fm.description)) errors.push(`${name}: description must not contain angle brackets`);
  }
  if (m[2].split('\n').length > 500) errors.push(`${name}: SKILL.md body is over 500 lines`);
  for (const ref of new Set([...m[2].matchAll(/(?:^|[\s`(])((?:scripts|references|assets)\/[A-Za-z0-9._/-]+)/g)].map(x => x[1].replace(/[).,:]+$/, '')))) {
    if (!fs.existsSync(path.join(dir, ref.split('#')[0]))) errors.push(`${name}: SKILL.md mentions ${ref}, which does not exist`);
  }
  return errors;
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap(e => { const p = path.join(dir, e); return fs.statSync(p).isDirectory() ? listFiles(p, base) : [path.relative(base, p)]; });
}

// Minimal zip writer (deflate), so packaging needs nothing beyond Node.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zipDir(dir, prefix, outFile) {
  const parts = [], central = []; let off = 0;
  for (const rel of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, rel)), comp = zlib.deflateRawSync(data), name = Buffer.from(`${prefix}/${rel}`.split(path.sep).join('/'));
    const exec = fs.statSync(path.join(dir, rel)).mode & 0o111;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(0x00210000, 10);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(((exec ? 0o100755 : 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    parts.push(h, name, comp); central.push(c, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(outFile, Buffer.concat([...parts, cd, end]));
}

function main() {
  const args = process.argv.slice(2), check = args.includes('--check'), zi = args.indexOf('--zip');
  const skillsDir = path.join(ROOT, 'skills');
  const names = fs.readdirSync(skillsDir).filter(n => fs.statSync(path.join(skillsDir, n)).isDirectory()).sort();
  const errors = [];
  for (const n of names) if (!SKILLS[n]) errors.push(`${n}: not listed in scripts/build-skills.mjs`);
  for (const n of Object.keys(SKILLS)) if (!names.includes(n)) errors.push(`${n}: skills/${n}/SKILL.md is missing`);
  if (check) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    for (const n of names.filter(n => SKILLS[n])) {
      const want = path.join(tmp, n); fs.mkdirSync(want, { recursive: true });
      fs.copyFileSync(path.join(skillsDir, n, 'SKILL.md'), path.join(want, 'SKILL.md'));
      buildSkill(n, want);
      const a = listFiles(want), b = listFiles(path.join(skillsDir, n));
      const diff = [...new Set([...a, ...b])].filter(f => !a.includes(f) || !b.includes(f) || !fs.readFileSync(path.join(want, f)).equals(fs.readFileSync(path.join(skillsDir, n, f))));
      if (diff.length) errors.push(`${n}: generated files out of date (${diff.slice(0, 5).join(', ')}${diff.length > 5 ? ', …' : ''}). Run: node scripts/build-skills.mjs`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else for (const n of names.filter(n => SKILLS[n])) buildSkill(n, path.join(skillsDir, n));
  for (const n of names) errors.push(...validateSkill(path.join(skillsDir, n)));
  if (zi >= 0) {
    const out = path.resolve(args[zi + 1] || 'dist/skills'); fs.mkdirSync(out, { recursive: true });
    for (const n of names) { zipDir(path.join(skillsDir, n), n, path.join(out, `${n}.zip`)); console.log(`wrote ${path.relative(process.cwd(), path.join(out, n + '.zip'))}`); }
  }
  if (errors.length) { console.error(errors.map(e => '✗ ' + e).join('\n')); process.exit(1); }
  console.log(`${check ? 'checked' : 'built'} ${names.length} skills: ${names.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
