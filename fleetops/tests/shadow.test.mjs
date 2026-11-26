import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from '../src/shadow.mjs';
import * as R from '../src/shadow-replay.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'fleetops.mjs');

test('matched load: a candidate 8% slower that got lighter traffic looks faster naively and is caught', () => {
  const d = S.synth();
  const r = S.compare(d.baseline, d.candidate, { boot: 200 });
  assert.equal(r.paired, false);
  assert.ok(r.metrics.tpot.naive < -0.03, `naive ${r.metrics.tpot.naive}`);
  assert.ok(r.metrics.tpot.effect > 0.05 && r.metrics.tpot.lo > 0.05, JSON.stringify(r.metrics.tpot));
  assert.equal(r.metrics.tpot.verdict, 'worse'); assert.equal(r.decision, 'roll back');
});

function pairedArms(factor, n = 400, seed = 5) {
  const u = (() => { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  const base = [], cand = [];
  for (let i = 0; i < n; i++) {
    const t = 1e9 + i * 0.5, isl = 500 + Math.round(u() * 4000), osl = 50 + Math.round(u() * 300), ttft = 0.05 + isl / 20000 * (0.7 + 0.6 * u()), tpot = 0.02 * (0.8 + 0.4 * u());
    base.push({ t, pair: i, isl, osl, ttft, tpot, e2e: ttft + tpot * (osl - 1) });
    const n1 = 0.97 + 0.06 * u(), n2 = 0.97 + 0.06 * u();
    cand.push({ t, pair: i, isl, osl, ttft: ttft * factor * n1, tpot: tpot * factor * n2, e2e: ttft * factor * n1 + tpot * factor * n2 * (osl - 1) });
  }
  return { base, cand };
}
test('paired replay: per-request ratios settle a 10% regression, and an identical candidate is promoted', () => {
  let { base, cand } = pairedArms(1.1);
  let r = S.compare(base, cand, { boot: 300 });
  assert.equal(r.paired, true); assert.ok(Math.abs(r.metrics.tpot.effect - 0.1) < 0.02); assert.equal(r.metrics.tpot.verdict, 'worse');
  ({ base, cand } = pairedArms(1.0));
  r = S.compare(base, cand, { boot: 300 });
  assert.equal(r.decision, 'promote', r.why);
  for (const m of ['ttft', 'tpot', 'e2e']) assert.equal(r.metrics[m].verdict, 'same');
});

test('verdicts: worse, better, same, inconclusive with how many more requests to settle it', () => {
  const e = (est, lo, hi) => ({ est: Math.log1p(est), lo: Math.log1p(lo), hi: Math.log1p(hi) });
  assert.equal(S.judge(e(0.1, 0.07, 0.13), 0.05, 100).verdict, 'worse');
  assert.equal(S.judge(e(-0.1, -0.13, -0.07), 0.05, 100).verdict, 'better');
  assert.equal(S.judge(e(0.0, -0.02, 0.02), 0.05, 100).verdict, 'same');
  const j = S.judge(e(0.03, -0.01, 0.07), 0.05, 100); assert.equal(j.verdict, 'inconclusive'); assert.ok(j.more > 0);
});

test('plan: the sizer predicts the change, and pairing shrinks the test', () => {
  const w = { isl: 2000, osl: 250, prefixHit: 60, inflight: 16 };
  const p = S.plan({ baseline: { model: 'llama33-70b', gpu: 'H100', tp: 4, rate: 2.5 }, candidate: { model: 'llama33-70b', gpu: 'B200', tp: 4, rate: 5 }, workload: w, rps: 4 });
  assert.ok(p.predicted.tokPerGpuS > 0.2 && p.predicted.tpot < 0, JSON.stringify(p.predicted));
  assert.ok(Number.isFinite(p.predicted.costPerMTok));
  assert.ok(S.testSize({ paired: true }).requestsPerArm < S.testSize({ paired: false }).requestsPerArm / 4);
  // prediction vs measurement in compare: off by more than 15% asks for recalibration
  const { base, cand } = pairedArms(1.0);
  const r = S.compare(base, cand, { boot: 100, predicted: { tpot: -0.3 } });
  assert.equal(r.prediction.holds, false); assert.match(r.why, /recalibrate/);
});

test('baseline and drift: the same service is within its baseline; a slower one drifts', () => {
  const d = S.synth({ seed: 9 }), b = S.makeBaseline('svc', d.baseline);
  assert.equal(S.drift(b, S.synth({ seed: 11 }).baseline, { boot: 150 }).drifted, false);
  const slow = d.baseline.map(r => Object.assign({}, r, { ttft: r.ttft * 1.2, tpot: r.tpot * 1.2, e2e: r.e2e * 1.2 }));
  const dr = S.drift(b, slow, { boot: 150 }); assert.equal(dr.drifted, true); assert.equal(dr.metrics.tpot.verdict, 'worse');
});

// ---------- replay against two mock OpenAI-compatible servers ----------
function mockServer({ perTokenMs, prefillPer1k = 2, tokenFlip = null }) {
  const seen = [], cache = new Set();
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => (body += c)); req.on('end', async () => {
      const j = JSON.parse(body); seen.push(j);
      // a prefix cache: the longest earlier prompt this one starts with is served from cache
      const words = j.prompt.split(' ').filter(Boolean);
      let cached = 0; for (const p of cache) if (j.prompt.startsWith(p)) cached = Math.max(cached, p.split(' ').filter(Boolean).length);
      cache.add(j.prompt);
      if (!j.stream) { // greedy with logprobs (answers)
        const toks = Array.from({ length: j.max_tokens }, (_, i) => `t${(j.prompt.length + i) % 50}`);
        if (tokenFlip && tokenFlip(j.prompt)) toks[5] = 'X';
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ choices: [{ text: toks.join(''), logprobs: { tokens: toks, token_logprobs: toks.map((_, i) => -0.1 * (i % 3)) } }] }));
      }
      res.setHeader('content-type', 'text/event-stream');
      await new Promise(r => setTimeout(r, prefillPer1k * (words.length - cached) / 1000));
      for (let i = 0; i < j.max_tokens; i++) { res.write(`data: ${JSON.stringify({ choices: [{ text: 'x' }] })}\n\n`); await new Promise(r => setTimeout(r, perTokenMs)); }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: words.length, completion_tokens: j.max_tokens, prompt_tokens_details: { cached_tokens: cached } } })}\n\ndata: [DONE]\n\n`); res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('replay: same requests to both endpoints at the same moments; sessions share a prefix; dry run sends nothing', async () => {
  const rows = []; for (let s = 0; s < 4; s++) for (let k = 0; k < 4; k++) rows.push({ t: s * 0.05 + k * 0.2, isl: 300 + 200 * k, osl: 8, session: 's' + s });
  const reqs = R.requestsFrom(rows, { speed: 1 });
  const s0 = reqs.filter(r => r.session === 's0');
  assert.ok(s0[1].prompt.startsWith(s0[0].prompt) && s0[3].prompt.startsWith(s0[2].prompt), 'a session\'s prompts grow by appending');
  let calls = 0; const dry = await R.run(reqs, [{ name: 'baseline', url: 'http://x' }, { name: 'candidate', url: 'http://y' }], { fetchImpl: () => { calls++; } });
  assert.equal(dry.dryRun, true); assert.equal(calls, 0); assert.equal(dry.plan.requests, 16);
  const A = await mockServer({ perTokenMs: 12 }), B = await mockServer({ perTokenMs: 4 });
  try {
    const res = await R.run(reqs, [{ name: 'baseline', url: A.url }, { name: 'candidate', url: B.url }], { live: true, model: 'm' });
    assert.equal(res.records.length, 32); assert.ok(res.records.every(r => !r.error), JSON.stringify(res.records.find(r => r.error)));
    assert.equal(A.seen.length, 16); assert.equal(B.seen.length, 16); assert.equal(A.seen[0].ignore_eos, true);
    assert.ok(res.records.some(r => r.cached > 0), 'the engine\'s cached tokens are recorded');
    const r = S.compare(res.records.filter(x => x.variant === 'baseline'), res.records.filter(x => x.variant === 'candidate'), { boot: 200 });
    assert.equal(r.paired, true); assert.ok(r.metrics.tpot.effect < -0.4, JSON.stringify(r.metrics.tpot));
  } finally { A.srv.close(); B.srv.close(); }
});

test('the same answers: greedy tokens compared; a numerics change fails the comparison even when it is faster', async () => {
  const A = await mockServer({ perTokenMs: 1 }), B = await mockServer({ perTokenMs: 1, tokenFlip: p => p.length % 2 === 0 });
  try {
    assert.equal((await R.answers([{ name: 'a', url: A.url }, { name: 'b', url: B.url }])).dryRun, true);
    const res = await R.answers([{ name: 'a', url: A.url }, { name: 'b', url: B.url }], { live: true, model: 'm', maxTokens: 12 });
    assert.ok(res.matchRate < 1 && res.matchRate > 0); assert.equal(res.meanFirstDivergence, 5);
    const { base, cand } = pairedArms(0.8);
    const r = S.compare(base, cand, { boot: 100, answers: res });
    assert.equal(r.decision, 'roll back'); assert.match(r.why, /answers differ/);
  } finally { A.srv.close(); B.srv.close(); }
});

test('cli: demo → compare → baseline → watch', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-')), run = (...a) => spawnSync(process.execPath, [CLI, 'shadow', ...a, '--store', d, '--json'], { encoding: 'utf8' });
  try {
    assert.equal(run('demo').status, 0);
    const c = run('compare', '--baseline', 'variant=baseline', '--candidate', 'variant=candidate'); assert.equal(c.status, 0, c.stderr);
    assert.equal(JSON.parse(c.stdout).shadow.decision, 'roll back');
    assert.equal(run('baseline', 'save', '--name', 'chat', '--select', 'variant=baseline').status, 0);
    const w = JSON.parse(run('watch', '--name', 'chat', '--select', 'variant=candidate').stdout); assert.equal(w.watch.drifted, true);
    assert.ok(fs.existsSync(path.join(d, 'shadow', 'verdicts.jsonl')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
