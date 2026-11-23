import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'size.mjs');
const size = (...a) => JSON.parse(spawnSync('node', [CLI, ...a, '--json'], { encoding: 'utf8' }).stdout);

test('--calibration applies measured efficiencies for the GPU and model; --set still wins', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sizer-cal-')), 'profile.json');
  fs.writeFileSync(f, JSON.stringify({ sizer: { 'H200|llama33-70b': { effPrefill: 0.76, effDecodeBW: 0.95, effDecodeComp: 0.57, fitOn: 'test run' } } }));
  const base = size('--model', 'llama33-70b', '--gpu', 'H200', '--set', 'conc=800');
  const cal = size('--model', 'llama33-70b', '--gpu', 'H200', '--set', 'conc=800', '--calibration', f);
  assert.equal(base.calibration, null);
  assert.equal(cal.calibration.profile, 'H200|llama33-70b'); assert.equal(cal.calibration.fitOn, 'test run');
  assert.equal(cal.calibration.efficiencies.effDecodeBW, 0.95);
  assert.ok(cal.gpus < base.gpus, `higher measured efficiencies need fewer GPUs (${cal.gpus} vs ${base.gpus})`);
  const over = size('--model', 'llama33-70b', '--gpu', 'H200', '--set', 'conc=800', '--calibration', f, '--set', 'effDecodeBW=0.5');
  assert.equal(over.calibration.efficiencies.effDecodeBW, 0.5);
  const other = size('--model', 'llama33-70b', '--gpu', 'B200', '--set', 'conc=800', '--calibration', f);
  assert.equal(other.calibration, null, 'no entry for B200: spec-sheet efficiencies');
});
