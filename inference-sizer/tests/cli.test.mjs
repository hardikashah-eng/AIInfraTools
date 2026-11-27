// The command line: listing, spec sheets, inputs from a file or stdin, comparing GPUs, the FleetScope export, and
// every usage error with exit code 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(here, '..', 'tools', 'size.mjs'), SHEET = path.join(here, '..', 'specs', 'example.json');
const C = createRequire(import.meta.url)('../src/catalog.js');
const run = (a, input) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', input });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sizer-cli-'));

test('--list: text and JSON, with a spec sheet\'s GPUs and models added', () => {
  const t = run(['--list']); assert.equal(t.status, 0); assert.match(t.stdout, /^GPUs:/m); assert.match(t.stdout, /^ {2}H200 /m); assert.match(t.stdout, /^Models:/m);
  const j = JSON.parse(run(['--list', '--json', '--catalog', SHEET]).stdout);
  assert.ok(j.gpus.some(g => g.id === 'H200-NVL') && j.models.some(m => m.id === 'qwen3-30b-a3b')); assert.ok(j.inputs.includes('tpot'));
  assert.ok(!('builtin' in j.gpus[0]), 'catalog bookkeeping stays out of the listing');
});

test('inputs from a file and from stdin, --set wins, booleans and numbers coerced, calibration shown', () => {
  const d = tmp(), f = path.join(d, 'in.json'); fs.writeFileSync(f, JSON.stringify({ model: 'qwen3-32b', gpu: 'H100', tpot: 40, conc: 64 }));
  const a = JSON.parse(run(['--input', f, '--set', 'tpot=50', '--json']).stdout);
  assert.equal(a.modelId, 'qwen3-32b'); assert.equal(a.gpuId, 'H100'); assert.equal(a.targets.tpotMs, 50); assert.equal(a.targets.concurrency, 64);
  const b = JSON.parse(run(['--input', '-', '--json'], JSON.stringify({ model: 'llama31-8b', gpu: 'L40S' })).stdout); assert.equal(b.gpuId, 'L40S');
  const cal = path.join(d, 'cal.json'); fs.writeFileSync(cal, JSON.stringify({ sizer: { 'H100|*': { effDecodeBW: 0.5, fitOn: 'bench' } } }));
  const c = run(['--model', 'qwen3-32b', '--gpu', 'H100', '--calibration', cal]); assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /calibrated efficiencies \(H100\|\*, fit on bench\): .*effDecodeBW 0\.5/, 'a GPU-wide profile entry applies to every model');
});

test('--compare: cheapest first, a GPU that can\'t meet the targets last, text and JSON', () => {
  const j = JSON.parse(run(['--model', 'llama33-70b', '--compare', 'L40S,H200,H100', '--set', 'tpot=12', '--json']).stdout);
  assert.equal(j.modelId, 'llama33-70b'); const found = j.results.map(r => r.found);
  assert.deepEqual(found, [...found].sort((x, y) => y - x), 'found ones first');
  const ok = j.results.filter(r => r.found); for (let i = 1; i < ok.length; i++) assert.ok(ok[i].costPerHour >= ok[i - 1].costPerHour);
  const t = run(['--model', 'llama33-70b', '--compare', 'L40S,H200', '--set', 'tpot=12']); assert.match(t.stdout, /cheapest first/); assert.match(t.stdout, /no layout meets the targets \(fastest TPOT/);
  const none = run(['--model', 'llama31-405b', '--compare', 'L40S', '--set', 'tpot=5']); assert.equal(none.status, 1, 'no GPU meets them: exit 1');
});

test('no layout: the fastest possible TPOT and TTFT, exit 1; the FleetScope graph written for a plan', () => {
  const t = run(['--model', 'llama31-405b', '--gpu', 'L40S', '--set', 'tpot=5']); assert.equal(t.status, 1); assert.match(t.stdout, /No .* layout meets TTFT .* Fastest possible: TPOT/);
  const d = tmp(), g = path.join(d, 'graph.json'), r = run(['--model', 'llama33-70b', '--gpu', 'H200', '--fleetscope', g]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /FleetScope graph written/); assert.ok(JSON.parse(fs.readFileSync(g, 'utf8')).nodes.length > 0);
  const bad = run(['--model', 'llama31-405b', '--gpu', 'L40S', '--set', 'tpot=5', '--fleetscope', path.join(d, 'x.json')]); assert.equal(bad.status, 2); assert.match(bad.stderr, /FleetScope export skipped/);
});

test('usage errors: exit 2, as JSON with --json', () => {
  const d = tmp(), arr = path.join(d, 'arr.json'), junk = path.join(d, 'junk.json'), empty = path.join(d, 'empty.json');
  fs.writeFileSync(arr, '[1]'); fs.writeFileSync(junk, '{nope'); fs.writeFileSync(empty, JSON.stringify({ hello: 1 }));
  const cases = [[['--model', 'nope'], /Unknown model "nope"/], [['--gpu', 'nope'], /Unknown GPU "nope"/], [['--compare', 'H100,nope'], /Unknown GPU "nope"/],
    [['--set', 'nope=1'], /Unknown input "nope"/], [['--input', arr], /must be a JSON object/], [['--input', junk], /--input: /], [['--calibration', junk], /--calibration: /],
    [['--catalog', empty, '--list'], /Could not recognise this file/]];
  for (const [a, re] of cases) { const r = run(a); assert.equal(r.status, 2, a.join(' ')); assert.match(r.stderr, re); }
  assert.match(JSON.parse(run(['--model', 'nope', '--json']).stdout).error, /Unknown model/);
});

test('spec sheets: validation errors per field, single entries, overrides of built-ins, round trip', () => {
  const r = C.parseSheet({ gpus: [{ label: 'X', hbmGB: 'lots' }, 7], models: [{ name: 'M', layers: 1e9, wprec: 'int3', total: 1, active: 2, experts: 4, topk: 4 }] });
  assert.equal(r.ok, false);
  for (const re of [/hbmGB must be a number/, /missing/, /entry must be an object/, /layers = .* is outside/, /wprec must be one of/, /active params .* exceed total/, /experts per token must be between 1 and 3/]) assert.ok(r.errors.some(e => re.test(e)), `${re} in ${r.errors.join(' | ')}`);
  assert.match(C.parseSheet('{').errors[0], /Not valid JSON/); assert.match(C.parseSheet('3').errors[0], /Expected a JSON object/);
  assert.match(C.parseSheet({ gpus: [] }).errors[0], /holds no GPUs or models/);
  const sheet = JSON.parse(fs.readFileSync(SHEET, 'utf8')), one = C.parseSheet(sheet.gpus[0]); assert.ok(one.ok && one.gpus[0].id === 'H200-NVL', 'a single GPU entry');
  assert.ok(C.parseSheet(sheet.models[0]).models.length === 1, 'a single model entry');
  const moe = C.validateModel(Object.assign({}, sheet.models[0], { active: sheet.models[0].total, experts: 8, topk: 2 })); assert.ok(moe.errors.some(e => /needs active params below total/.test(e)));
  const merged = C.merge(C.GPUS, [Object.assign({}, C.GPUS.find(g => g.id === 'H100'), { price: 1 }), { id: 'new', label: 'New' }]);
  assert.equal(merged.find(g => g.id === 'H100').overrides, true); assert.equal(merged.find(g => g.id === 'new').custom, true); assert.equal(merged.find(g => g.id === 'B200').builtin, true);
  const back = C.makeSheet(merged.filter(g => g.custom), []); assert.equal(back.kind, C.SHEET_KIND); assert.ok(!('custom' in back.gpus[0]));
  assert.equal(C.slug('  Hello, World!  '), 'hello-world'); assert.equal(C.slug(''), 'item');
  assert.equal(C.validateGPU({ label: 'My GPU!' }).value.id, 'my-gpu', 'no id: one from the label');
});
