// aiinfra report: plan → verify → account on one page, read from a fleetops store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, render } from '../bin/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = a => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aiinfra.mjs'), 'report', ...a], { encoding: 'utf8' });

test('report --demo: the sizer corrected by a shadow test, the verdict, the calibration, the economics', () => {
  const t = run(['--demo']); assert.equal(t.status, 0, t.stderr);
  for (const s of ['PLAN', 'VERIFY', 'CALIBRATION', 'ACCOUNT']) assert.match(t.stdout, new RegExp(`^${s}$`, 'm'));
  assert.match(t.stdout, /with measured efficiencies: \d+ GPUs serving/); assert.match(t.stdout, /prediction was off: .*predicted .*measured/);
  assert.match(t.stdout, /H200\|llama33-70b: prefill/); assert.match(t.stdout, /per resolved task at the API/); assert.match(t.stdout, /sized with the measured efficiencies/);
  const j = JSON.parse(run(['--demo', '--json']).stdout);
  assert.equal(j.model, 'llama33-70b'); assert.equal(j.gpu, 'H200', 'the only calibrated model and GPU are the default');
  assert.ok(j.plan.calibrated.provisionedGpus >= j.plan.sizer.provisionedGpus, 'the measured engine is slower than the spec sheet: more GPUs');
  assert.equal(j.verify.last.decision, 'roll back'); assert.equal(j.verify.last.prediction.holds, false);
  assert.match(String(j.account.selfHost.calibrated), /shadow/); assert.ok(j.account.selfHost.tokensPerSecPerMW > 0);
  assert.match(run(['--demo', '--format', 'md']).stdout, /^# AI infrastructure report: llama33-70b on H200$/m);
});

test('report: canaries waiting for a person, the last promotion, and what is missing', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'report-')), c = path.join(store, 'shadow', 'canaries');
  fs.mkdirSync(c, { recursive: true });
  // a canary at 5% with the step to 25% queued (queued by the judge, not approved: the report only reads it)
  fs.writeFileSync(path.join(c, 'chat.json'), JSON.stringify({ kind: 'fleetops.llmd-canary', version: 1, name: 'chat', baseline: 'chat-v1', candidate: 'chat-v2', steps: [1, 5, 25, 50, 100], step: 1, status: 'running', pending: { id: 'chat-2', toStep: 2 } }));
  fs.writeFileSync(path.join(c, 'old.json'), JSON.stringify({ kind: 'fleetops.llmd-canary', version: 1, name: 'old', baseline: 'a', candidate: 'b', steps: [1, 5], step: 1, status: 'rolled back', pending: null }));
  fs.writeFileSync(path.join(store, 'shadow', 'promoted.jsonl'), JSON.stringify({ t: 1795000000, label: 'H100 → H200', calibration: 'H200|llama33-70b' }) + '\n');
  const r = gather({ store, set: [] });
  assert.equal(r.plan, null); assert.equal(r.account, null);
  assert.deepEqual(r.verify.canaries.map(x => [x.name, x.share, x.awaitingApproval && x.awaitingApproval.toShare]), [['chat', 5, 25], ['old', 0, null]]);
  assert.ok(r.next.some(n => /canary chat: the step to 25% waits for a person: fleetops shadow canary approve --name chat --by NAME/.test(n)));
  assert.ok(r.next.some(n => /--model M --gpu G/.test(n)) && r.next.some(n => /--harness/.test(n)) && r.next.some(n => /no shadow verdict/.test(n)));
  const txt = render(r); assert.match(txt, /canary chat \(chat-v1 → chat-v2\): running, candidate at 5%; step to 25% awaiting a person's approval/);
  assert.match(txt, /last promotion .*H100 → H200 \(recalibrated H200\|llama33-70b\)/); assert.match(txt, /^NEXT$/m);
  // a model and GPU without calibration: the uncalibrated estimate, said so
  const u = render(gather({ store, model: 'llama33-70b', gpu: 'H100', set: ['tpot=50'] }));
  assert.match(u, /Inference Sizer: \d+ GPUs serving .*TPOT 50 ms/); assert.match(u, /no calibration for this model and GPU yet/);
  assert.match(render(gather({ store, model: 'nope', gpu: 'H100', set: [] })), /sizer: .*nope/);
  assert.match(run(['--help']).stdout, /plan → verify → account/);
});
