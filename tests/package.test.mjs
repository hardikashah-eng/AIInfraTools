// The npm package: packed and installed for real into an empty project (no mocks, no network: it has no
// dependencies), then every bin run the way a user would, through npm's symlinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS, main } from '../bin/aiinfra.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const hasNpm = spawnSync(npm, ['--version']).status === 0;

test('every tool and bin points at a file that exists, and the version matches', () => {
  for (const [k, t] of Object.entries(TOOLS)) assert.ok(fs.existsSync(path.join(ROOT, t.file)), k);
  for (const [k, f] of Object.entries(pkg.bin)) assert.ok(fs.existsSync(path.join(ROOT, f)), k);
  assert.equal(pkg.license, 'Apache-2.0'); assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')));
  assert.equal(main(['nope']), 2);
});

test('installed from the packed tarball, every bin runs through its npm symlink', { skip: !hasNpm && 'npm not found', timeout: 300000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiinfra-pkg-'));
  const tgz = execFileSync(npm, ['pack', '--pack-destination', dir, '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
  const st = fs.statSync(path.join(dir, tgz));
  assert.ok(st.size < 3e6, `package is ${(st.size / 1e6).toFixed(1)} MB packed`);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"t","version":"1.0.0","private":true}');
  execFileSync(npm, ['install', '--offline', '--no-audit', '--no-fund', '--silent', path.join(dir, tgz)], { cwd: proj, stdio: 'pipe' });
  const bin = n => path.join(proj, 'node_modules', '.bin', n);
  const run = (n, args) => { const r = spawnSync(bin(n), args, { cwd: proj, encoding: 'utf8', timeout: 120000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  for (const n of Object.keys(pkg.bin)) assert.ok(fs.lstatSync(bin(n)).isSymbolicLink() || process.platform === 'win32', `${n} is linked`);
  assert.equal(run('aiinfra', ['version']).out.trim(), pkg.version);
  assert.equal(run('aiinfra-tools', ['version']).out.trim(), pkg.version, 'npx aiinfra-tools runs the bin named after the package');
  assert.match(run('aiinfra', ['--help']).out, /sizer[\s\S]*ledger[\s\S]*fleetops/);
  // each CLI prints its help, or does real work, when called through the symlink (fleetops and gpu-health didn't
  // before: they compared argv[1], the link, with their own path)
  for (const [n, args, want] of [
    ['fleetops', ['--help'], /fleetops data import/], ['gpu-health', ['--help'], /gpu-health/i], ['gpu-ledger', ['--help'], /gpu-ledger/],
    ['fleetscope', ['--help'], /FleetScope/], ['inference-sizer', ['--model', 'llama33-70b', '--gpu', 'H100'], /Llama 3\.3 70B on NVIDIA H100/],
    ['fix-skew', ['--help'], /skew/i]]) {
    const r = run(n, args); assert.match(r.out, want, `${n}: ${r.out.slice(0, 300)}`);
  }
  const s = run('aiinfra', ['sizer', '--model', 'llama31-8b', '--gpu', 'L40S', '--json']);
  assert.equal(s.code, 0); assert.ok(JSON.parse(s.out).plan || JSON.parse(s.out).result || JSON.parse(s.out), 'JSON output parses');
  assert.equal(run('aiinfra', ['path', 'fleetops']).out.trim(), fs.realpathSync(path.join(proj, 'node_modules', 'aiinfra-tools', 'fleetops', 'tools', 'fleetops.mjs')));
});
