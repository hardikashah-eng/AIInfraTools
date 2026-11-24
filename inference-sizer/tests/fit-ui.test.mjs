// The "What fits" view: fit.js and fit-ui.js are inlined into dist, and fit.js works as a browser global.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('dist inlines the fit engine and the view, with no markers left', () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  for (const m of ['/*CATALOG*/', '/*MODEL*/', '/*UI*/', '/*FIT*/', '/*FITUI*/']) assert.ok(!html.includes(m), m);
  assert.ok(html.includes('root.SizerFit = api'));
  assert.ok(html.includes('id="fitview"') && html.includes('data-view="fit"'));
});

test('fit.js runs as a browser global next to the catalog', () => {
  const ctx = { console }; ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['catalog.js', 'model.js', 'fit.js']) vm.runInContext(fs.readFileSync(path.join(root, 'src', f), 'utf8'), ctx, { filename: f });
  assert.ok(ctx.SizerFit && typeof ctx.SizerFit.fitModels === 'function');
  const r = ctx.SizerFit.fitModels({ gpu: 'H100', nodes: 2 }, { isl: 2000, osl: 400, rate: 5 }, { ttftS: 2, tpotS: 0.05 }, { rank: 'largest' });
  assert.ok(r.rows.length > 5);
  assert.ok(r.rows.some(x => x.meetsRate), 'something carries 5 req/s on 16 H100');
  assert.ok(r.rows.some(x => !(x.production.rate > 0)), 'and the 1T-class models do not fit');
  const c = ctx.SizerFit.capacity('llama33-70b', { gpu: 'H100', nodes: 2 }, { isl: 2000, osl: 400 }, { ttftS: 2, tpotS: 0.05 }, {});
  assert.ok(c.production.rate > 5 && c.maxPrompt > 2000);
});
