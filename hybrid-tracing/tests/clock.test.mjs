import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const script = join(here, 'clock/check-clock.sh');
const have = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'clock-'));
const fake = (name, line) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${line ? `echo "${line}"` : 'exit 1'}\n`); chmodSync(p, 0o755); return p; };
const check = (chronyc, args = []) => spawnSync('bash', [script, ...args], { env: Object.assign({}, process.env, { CHRONYC: chronyc }), encoding: 'utf8' });

test('check-clock: synchronised within the bound exits 0 and reports the error bound', () => {
  const r = check(fake('ok', '50545031,PTP,1,1795140000.1,-0.000000210,0,0,0,0,0,0.000000100,0.000002000,1.0,Normal'), ['--site', 'onprem']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clock_synchronized\{host="[^"]+",site="onprem"\} 1/);
  assert.match(r.stdout, /clock_max_error_seconds\{[^}]+\} 0\.00000226/);
});

test('check-clock: synchronised but beyond the bound exits 1', () => {
  const r = check(fake('far', '0A000001,timeserver-1,2,1795140000.1,0.000900000,0,0,0,0,0,0.001800000,0.000400000,64.0,Normal'), ['--max-error-ms', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exceeds 1 ms/);
  assert.equal(check(fake('far2', '0A000001,timeserver-1,2,1795140000.1,0.000900000,0,0,0,0,0,0.001800000,0.000400000,64.0,Normal'), ['--max-error-ms', '5']).status, 0);
});

test('check-clock: unsynchronised or unreachable chrony exits 2, and the textfile is written atomically', () => {
  assert.equal(check(fake('unsync', '00000000,,0,0.0,0.0,0,0,0,0,0,1.0,1.0,0.0,Not synchronised')).status, 2);
  const tf = join(dir, 'clock.prom');
  const r = check(fake('down', ''), ['--textfile', tf]);
  assert.equal(r.status, 2);
  assert.match(readFileSync(tf, 'utf8'), /clock_synchronized\{[^}]+\} 0/);
});

// chronyd is given the directives as arguments rather than the file path: on Ubuntu (including GitHub's runners)
// AppArmor confines chronyd to reading config under /etc/chrony, so `chronyd -p -f <repo file>` is refused.
// With directives on the command line chronyd reads no file, and still rejects any invalid directive.
const directives = file => readFileSync(file, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
const chronyParse = lines => spawnSync('chronyd', ['-p', ...lines], { encoding: 'utf8' });

test('chrony configs parse with chronyd', { skip: !have('chronyd') && 'chronyd not installed' }, () => {
  const files = readdirSync(join(here, 'clock')).filter(f => f.endsWith('.chrony.conf'));
  assert.equal(files.length, 3);
  for (const f of files) {
    const lines = directives(join(here, 'clock', f));
    assert.ok(lines.length > 5, f);
    const r = chronyParse(lines);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(r.stdout.trim().split('\n').length, lines.length, `${f}: chronyd echoed a different number of directives`);
  }
});

test('the chrony check rejects an invalid directive', { skip: !have('chronyd') && 'chronyd not installed' }, () => {
  const r = chronyParse(['makestep 0.1 3', 'serverx timeserver-1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid directive/);
});

test('ptp4l config parses with ptp4l', { skip: !have('ptp4l') && 'linuxptp not installed' }, () => {
  const r = spawnSync('timeout', ['3', 'ptp4l', '-f', join(here, 'clock/ptp4l.conf'), '-i', 'lo', '-m'], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /unknown option|failed to parse|deprecated/i, out);
});

test('collector configs validate with otelcol-contrib', { skip: !have('otelcol-contrib') && 'otelcol-contrib not on PATH (CI validates with the official image)' }, () => {
  const env = Object.assign({}, process.env, { SITE: 'onprem', TIME_SERVER: 'timeserver-1', GATEWAY_ENDPOINT: 'gw:4317', ONPREM_GATEWAY_ENDPOINT: 'onprem:4319', TAILSAMPLER_HEADLESS: 'ts', METRICS_REMOTE_WRITE: 'http://mimir/api/v1/push', SKEW_CORRECTOR_ENDPOINT: 'http://skew:4318' });
  for (const f of readdirSync(join(here, 'collector')).filter(f => f.endsWith('.yaml'))) {
    const r = spawnSync('otelcol-contrib', ['validate', '--config', join(here, 'collector', f)], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
