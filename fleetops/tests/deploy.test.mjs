import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as S from '../src/security.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), FO = path.join(here, '..'), inst = f => path.join(FO, 'install', f);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetops-dep-'));
const run = promisify(execFile);
const require = createRequire(import.meta.url);
let YAML = null; try { YAML = require('yaml'); } catch { /* optional, like DuckDB */ }
const has = cmd => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

test('installer scripts parse', () => {
  for (const f of ['install.sh', 'install-k8s.sh', 'install-docker.sh', 'uninstall.sh', 'lib.sh']) execFileSync('bash', ['-n', inst(f)]);
});

test('Kubernetes manifest: rendered by install-k8s.sh --dry-run; structure, security and wiring hold', { skip: (!YAML && 'npm install --no-save yaml@2 to run') || (!has('openssl') && 'needs openssl') }, async () => {
  const dir = tmp(), toks = path.join(dir, 'tokens.txt');
  const { stdout } = await run('bash', [inst('install-k8s.sh'), '--image', 'reg.example.com/fleetops:9.9', '--namespace', 'gpu-ops', '--storage', '200Gi', '--egress', 'prom.monitoring.svc', '--dry-run', '--tokens-out', toks]);
  assert.equal(fs.statSync(toks).mode & 0o777, 0o600, 'the tokens file is private');
  const docs = YAML.parseAllDocuments(stdout).map(d => d.toJSON()).filter(Boolean), by = k => docs.filter(d => d.kind === k);
  assert.deepEqual(docs.map(d => d.kind), ['Namespace', 'PersistentVolumeClaim', 'Deployment', 'Service', 'CronJob', 'Secret']);
  assert.ok(docs.every(d => d.kind === 'Namespace' ? d.metadata.name === 'gpu-ops' : d.metadata.namespace === 'gpu-ops'));
  assert.ok(!stdout.includes('REGISTRY/'), 'image placeholder replaced');
  const dep = by('Deployment')[0], pod = dep.spec.template.spec, c = pod.containers[0];
  assert.deepEqual(dep.spec.selector.matchLabels, dep.spec.template.metadata.labels);
  assert.deepEqual(by('Service')[0].spec.selector, dep.spec.template.metadata.labels);
  assert.equal(by('Service')[0].spec.ports[0].targetPort, c.ports[0].name);
  assert.equal(dep.spec.replicas, 1); assert.equal(dep.spec.strategy.type, 'Recreate', 'one writer: no overlap during rollouts');
  assert.equal(c.image, 'reg.example.com/fleetops:9.9');
  assert.equal(pod.securityContext.runAsNonRoot, true); assert.equal(c.securityContext.readOnlyRootFilesystem, true); assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.ok(c.readinessProbe.httpGet.path === '/healthz' && c.livenessProbe.httpGet.path === '/healthz');
  const vols = new Set(pod.volumes.map(v => v.name));
  for (const m of c.volumeMounts) assert.ok(vols.has(m.name), `mount ${m.name} has a volume`);
  assert.ok(c.volumeMounts.some(m => m.mountPath === '/tmp'), 'writable /tmp under a read-only root (DuckDB temp files)');
  assert.equal(pod.volumes.find(v => v.name === 'tokens').secret.secretName, by('Secret')[0].metadata.name);
  assert.equal(pod.volumes.find(v => v.name === 'data').persistentVolumeClaim.claimName, by('PersistentVolumeClaim')[0].metadata.name);
  assert.equal(by('PersistentVolumeClaim')[0].spec.resources.requests.storage, '200Gi');
  assert.equal(c.env.find(e => e.name === 'FLEETOPS_EGRESS_ALLOW').value, 'prom.monitoring.svc');
  assert.deepEqual(c.args.slice(c.args.indexOf('--tokens'), c.args.indexOf('--tokens') + 2), ['--tokens', `/etc/fleetops/tokens.jsonl`]);
  const cron = by('CronJob')[0].spec.jobTemplate.spec.template.spec;
  assert.equal(cron.volumes.find(v => v.name === 'data').persistentVolumeClaim.claimName, 'fleetops-data');
  // the Secret's hashes accept the tokens the installer printed, with the right roles
  const jsonl = path.join(dir, 't.jsonl');
  fs.writeFileSync(jsonl, Buffer.from(by('Secret')[0].data['tokens.jsonl'], 'base64'));
  const T = S.loadTokens(jsonl), plain = Object.fromEntries(fs.readFileSync(toks, 'utf8').trim().split('\n').map(l => l.split('=')));
  assert.deepEqual(['admin', 'collector', 'grafana'].map(n => { const w = S.authenticate(T, `Bearer ${plain[n]}`); return [w.name, w.roles[0]]; }), [['admin', 'admin'], ['collector', 'ingest'], ['grafana', 'read']]);
  await assert.rejects(run('bash', [inst('install-k8s.sh'), '--image', 'x; rm -rf /', '--dry-run', '--tokens-out', path.join(dir, 'x')]), /unexpected characters/);
});

test('install.sh: one command to a running, token-protected service; rerun keeps tokens; uninstall', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), port = 20000 + Math.floor(Math.random() * 20000), env = Object.assign({}, process.env, { HOME: dir });
  try {
    const { stdout } = await run('bash', [inst('install.sh'), '--dir', path.join(dir, 'fo'), '--port', String(port), '--backend', 'jsonl', '--no-service'], { env, timeout: 120000 });
    assert.match(stdout, new RegExp(`fleetops is running: http://127.0.0.1:${port}`));
    assert.match(stdout, /remote_write:/); assert.match(stdout, /otlphttp\/fleetops/);
    const plain = Object.fromEntries(fs.readFileSync(path.join(dir, 'fo', 'etc', 'initial-tokens.txt'), 'utf8').trim().split('\n').map(l => l.split('=')));
    assert.equal(fs.statSync(path.join(dir, 'fo', 'etc', 'initial-tokens.txt')).mode & 0o777, 0o600);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/summary`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/summary`, { headers: { authorization: `Bearer ${plain.admin}` } })).status, 200);
    assert.ok(!fs.readFileSync(path.join(dir, 'fo', 'etc', 'tokens.jsonl'), 'utf8').includes(plain.admin), 'only hashes at rest');
    const before = fs.readFileSync(path.join(dir, 'fo', 'etc', 'tokens.jsonl'), 'utf8');
    const again = await run('bash', [inst('install.sh'), '--dir', path.join(dir, 'fo'), '--port', String(port), '--backend', 'jsonl', '--no-service'], { env, timeout: 120000 });
    assert.match(again.stdout, /tokens: kept/); assert.equal(fs.readFileSync(path.join(dir, 'fo', 'etc', 'tokens.jsonl'), 'utf8'), before);
    const out = execFileSync(path.join(dir, 'fo', 'bin', 'fleetops'), ['data', 'summary', '--json'], { encoding: 'utf8' });
    assert.ok(JSON.parse(out), 'the fleetops command uses the install\'s store');
  } finally {
    await run('bash', [inst('uninstall.sh'), '--dir', path.join(dir, 'fo'), '--purge', '--yes'], { env });
  }
  assert.ok(!fs.existsSync(path.join(dir, 'fo')));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});
