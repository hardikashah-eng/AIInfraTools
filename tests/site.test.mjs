// The Pages site: every page and image is there, the landing page links only to things that exist, and the two
// tools open in a real headless Chrome when one is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, PAGES } from '../scripts/build-site.mjs';

test('the site holds every page, and the landing page\'s relative links resolve', () => {
  const out = build(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')));
  for (const p of Object.keys(PAGES)) assert.ok(fs.statSync(path.join(out, p)).size > 1000, p);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const rel = [...html.matchAll(/(?:href|src)="([^"#:]+)(?:#[^"]*)?"/g)].map(m => m[1]).filter(u => !u.startsWith('//'));
  assert.ok(rel.length >= 6);
  for (const u of rel) assert.ok(fs.existsSync(path.join(out, u.endsWith('/') ? u + 'index.html' : u)), `${u} exists in the site`);
  // repository links point at files that exist in this checkout
  const repo = [...html.matchAll(/github\.com\/hardikashah-eng\/AIInfraTools\/(?:blob|tree)\/main\/([^"#]+)/g)].map(m => m[1]);
  for (const f of repo) if (!f.startsWith('docs/RESULTS.md')) assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), f)), f);
});

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(c => { try { execFileSync('bash', ['-lc', `command -v ${c}`], { stdio: 'ignore' }); return true; } catch { return false; } });
test('no mocks: the landing page and both tools render in headless Chrome', { skip: !CHROME && 'no Chrome on this host', timeout: 120000 }, () => {
  const out = build(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')));
  const dom = p => execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=4000', '--dump-dom', 'file://' + path.join(out, p)], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(dom('index.html'), /Open tools for running GPU fleets/);
  assert.match(dom('sizer/index.html'), /id="fitview"/);
  assert.match(dom('fleetscope/index.html'), /FleetScope/);
});
