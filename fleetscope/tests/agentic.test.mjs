import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const IN = require('../src/ingest.js'), A = require('../src/agentic.js');
const C = require('../../inference-sizer/src/catalog.js'), M = require('../../inference-sizer/src/model.js');
const here = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(here, '..', 'tools', 'agentic.mjs');
const J = o => JSON.stringify(o);

test('AgentX traces: sessions laid end to end, subagents kept, cache from 64-token block hashes within a session', () => {
  const a = { id: 'a', requests: [{ t: 0, type: 'n', model: 'm', in: 128, out: 10, hash_ids: [1, 2], api_time: 1 }, { t: 5, type: 'n', model: 'm', in: 256, out: 5, hash_ids: [1, 2, 3, 4], api_time: 1 },
    { type: 'subagent', agent_id: 'x', t: 7, requests: [{ t: 7, model: 'h', in: 192, out: 3, hash_ids: [1, 9, 10], api_time: 0.5 }] }] };
  const b = { id: 'b', requests: [{ t: 0, in: 128, out: 1, hash_ids: [1, 2], api_time: 2 }] };
  const r = IN.parseTrace(J(a) + '\n' + J(b));
  assert.equal(r.format, 'AgentX agentic trace');
  assert.deepEqual(r.trace.map(x => [x.t, x.cached, x.session, x.agent || null]), [[0, 0, 'a', null], [5, 128, 'a', null], [7, 64, 'a', 'x'], [7.5, 0, 'b', null]], 'b reuses nothing: hashes are per session');
});

test('Mooncake traces: 512-token blocks in one hash space', () => {
  const r = IN.parseTrace([{ timestamp: 0, input_length: 1024, output_length: 10, hash_ids: [0, 1] }, { timestamp: 1000, input_length: 1500, output_length: 5, hash_ids: [0, 1, 2] }].map(J).join('\n'));
  assert.equal(r.format, 'Mooncake trace'); assert.deepEqual(r.trace.map(x => x.cached), [0, 1024]);
});

test('TraceLab rows: provider cache accounting, call start at its input, model time to its last event', () => {
  const ev = (type, ts) => ({ event_type: type, timestamp: ts });
  const claude = { provider: 'claude', session_id: 's', input_tokens_total: 40000, claude_cache_read_input_tokens: 38000, claude_cache_creation_input_tokens: 1990, output_tokens: 120, prefix_tokens: 0,
    timing_events: [ev('tool_result', '2026-06-01T00:00:10Z'), ev('text', '2026-06-01T00:00:14Z'), ev('tool_call', '2026-06-01T00:00:15Z')], tools: [{ tool_name: 'Read', result_chars: 400 }] };
  const codex = { provider: 'codex', session_id: 'c', input_tokens_total: 9000, prefix_tokens: 8192, output_tokens: 30, timing_events: [ev('user_message', '2026-06-01T00:00:00Z'), ev('usage_report', '2026-06-01T00:00:02Z')], tools: [] };
  const r = IN.parseTrace(J(claude) + '\n' + J(codex));
  assert.equal(r.format, 'TraceLab coding-agent trace');
  const c = r.trace.find(x => x.session === 's'), x = r.trace.find(x => x.session === 'c');
  assert.equal(c.cached, 38000); assert.equal(c.api, 5); assert.equal(c.tools, 1); assert.equal(x.cached, 8192); assert.equal(x.api, 2);
});

// a known workload: sessions of growing contexts with tool-loop gaps and occasional long pauses
function sessions(n, seed = 1) {
  const r = A.rng(seed), out = [];
  for (let s = 0; s < n; s++) {
    let t = r() * 3600, isl = 10000 + Math.round(r() * 20000), prev = 0; const turns = 5 + Math.floor(r() * 40), pace = 0.5 + r() * 3, grow = 500 + r() * 3000;
    for (let i = 0; i < turns; i++) { const osl = 50 + Math.round(r() * 400), api = 2 + r() * 8; out.push({ t, isl, osl, cached: i ? Math.min(isl - 1, prev) : 0, session: 'u' + s, api });
      prev = isl; isl += Math.round(grow * (0.2 + 1.6 * r())); t += api + (r() < 0.05 ? 120 + r() * 900 : pace * (0.2 + 1.6 * r())); }
  }
  return out.sort((a, b) => a.t - b.t);
}

test('profile → synthetic sessions reproduce the workload (fit on one set, compare with another)', () => {
  const V = A.validate(sessions(1500, 3), { sessionsPerHour: 300, horizonS: 3600, seeds: [1, 2], holdout: 0.3 });
  for (const k of ['cacheHit', 'osl.mean', 'rps.mean', 'decodeTps.mean', 'prefillTps.mean']) assert.ok(V.agg[k].meanAbsErr < 0.2, `${k}: ${V.agg[k].meanAbsErr}`);
  assert.ok(V.agg['isl.mean'].meanAbsErr < 0.25 && V.agg['kvTokens.p95'].meanAbsErr < 0.35);
  // deterministic for a seed
  const a = A.synthesize(V.profile, { sessionsPerHour: 100, horizonS: 600, seed: 9 }), b = A.synthesize(V.profile, { sessionsPerHour: 100, horizonS: 600, seed: 9 });
  assert.deepEqual(a, b); assert.ok(a.length > 0 && a.every(x => x.cached < x.isl && x.osl >= 1));
});

test('workload stats: the KV working set counts contexts held between calls up to the cache lifetime', () => {
  const rows = [{ t: 0, isl: 1000, osl: 10, cached: 0, session: 'a', api: 1 }, { t: 100, isl: 2000, osl: 10, cached: 1000, session: 'a', api: 1 }, { t: 1000, isl: 3000, osl: 10, cached: 0, session: 'a', api: 1 }];
  const short = A.workloadStats(rows, { windowS: 60, cacheTtlS: 300 }), none = A.workloadStats(rows, { windowS: 60, cacheTtlS: 0 });
  // with a 300 s lifetime the first context is still held a minute later (between calls); with none, only calls in flight count
  assert.equal(short.kvTokens.max, 3010); assert.equal(short.kvTokens.p95, 3010); assert.equal(none.kvTokens.max, 1010); assert.equal(none.kvTokens.p95, 0);
  assert.equal(short.cacheHit, 1000 / 6000);
});

test('GPUs for an agentic workload: cache reuse cuts prefill; flat ISL/OSL sizing asks for far more', () => {
  const g = C.GPUS.find(x => x.id === 'B200'), m = C.MODELS.find(x => x.id === 'qwen3-coder-480b');
  const s = Object.assign({}, M.SETTINGS, m, g, { ttft: 10000, tpot: 30, ctx: m.maxCtx });
  const st = A.workloadStats(A.synthesize(A.fitProfile(sessions(800, 5)), { sessionsPerHour: 3000, horizonS: 1800, seed: 2 }));
  const ag = A.sizeFor(st, s, M), flat = A.sizeFor(A.flatStats(st), s, M);
  assert.ok(ag.gpus > 0 && ag.kvGpus > 0, JSON.stringify(ag));
  assert.ok(flat.gpus == null || flat.gpus > ag.gpus, `flat ${flat.gpus} vs agentic ${ag.gpus}`);
});

test('cli: fit a profile, then size and stats from it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-')), tr = path.join(dir, 't.jsonl'), pf = path.join(dir, 'p.json');
  fs.writeFileSync(tr, sessions(300, 7).map(J).join('\n') + '\n');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  let r = run('fit', tr, '-o', pf); assert.equal(r.status, 0, r.stderr);
  r = run('size', pf, '--sessions-per-hour', '500', '--json'); assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout); assert.ok(j.agentic.gpus > 0);
  r = run('stats', tr, '--json'); assert.equal(JSON.parse(r.stdout).sessions, 300);
  r = run('synth', pf, '--sessions-per-hour', '50', '-o', path.join(dir, 's.csv')); assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 's.csv'), 'utf8'), /^timestamp,input_tokens/);
  fs.rmSync(dir, { recursive: true, force: true });
});
