import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasksFromSwebench, capAt, capCurve, bestCap, runSummary, outcomeReport } from '../src/outcomes.mjs';
import { tracelab, detect } from '../src/importers.mjs';
import { priceTable } from '../src/prices.mjs';
import { loadOutcomes, ledger } from '../src/ledger.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'harness-ledger.mjs');
const details = { a: { cost: 1, api_calls: 10, resolved: true }, b: { cost: 3, api_calls: 30, resolved: false }, c: { cost: 2, api_calls: 20, resolved: true }, d: { cost: 4, api_calls: 40, resolved: false } };

test('outcomes: cost per success, spend on failures, and what a call cap saves against the successes it loses', () => {
  const ts = tasksFromSwebench(details, { run: 'r', model: 'M' }), s = runSummary(ts);
  assert.equal(s.rate, 0.5); assert.equal(s.costPerSuccess, 5); assert.equal(s.failShare, 0.7);
  // cap at 20 calls: a and c in full, b and d cut to 2/3 and 1/2 of their cost; no success lost
  assert.deepEqual(capAt(ts, 20), { cap: 20, cost: 1 + 2 + 2 + 2, successes: 2 });
  const curve = capCurve(ts, [10, 20]);
  assert.equal(curve[0].successesLost, 1); assert.ok(Math.abs(curve[1].saved - 0.3) < 1e-12);
  assert.equal(bestCap(curve, 1).cap, 20);
  const R = outcomeReport([...ts, ...tasksFromSwebench({ x: { cost: 0, api_calls: 3, resolved: false } }, { run: 'empty' })]);
  assert.deepEqual(R.skipped, ['empty']); assert.equal(R.runs.length, 1);
});

test('outcomes feed --outcomes too: SWE-bench per-instance results read as session outcomes', () => {
  const m = loadOutcomes(JSON.stringify(details));
  assert.equal(m.get('a'), 'success'); assert.equal(m.get('b'), 'failure');
});

test('TraceLab importer: provider cache accounting, tools with result sizes and errors; detected by content', () => {
  const ev = (type, ts) => ({ event_type: type, timestamp: ts });
  const line = { provider: 'claude', session_id: 's', round_id: 'r1', model: 'claude-opus-4-8', input_tokens_total: 50000, claude_cache_read_input_tokens: 48000, claude_cache_creation_input_tokens: 1994,
    claude_uncached_input_tokens: 6, output_tokens: 80, timing_events: [ev('tool_result', '2026-06-01T00:00:00Z'), ev('tool_call', '2026-06-01T00:00:03Z')], tools: [{ tool_name: 'Bash', tool_call_id: 't', result_chars: 40000, is_error: true }] };
  const codex = { provider: 'codex', session_id: 'c', round_id: 'r2', model: 'gpt-5.5', input_tokens_total: 9000, prefix_tokens: 8192, output_tokens: 30, timing_events: [ev('user_message', '2026-06-01T00:00:00Z')], tools: [] };
  const text = JSON.stringify(line) + '\n' + JSON.stringify(codex);
  assert.equal(detect(text, 'syfi_coding_trace.jsonl'), 'tracelab');
  const [a, b] = tracelab(text);
  assert.equal(a.harness, 'claude-code'); assert.equal(a.cacheRead, 48000); assert.equal(a.cacheWrite, 1994); assert.equal(a.durS, 3);
  assert.deepEqual(a.toolCalls[0], { name: 'Bash', id: 't', resultTokens: 10000, error: true });
  assert.equal(b.harness, 'codex'); assert.equal(b.cacheRead, 8192);
});

test('prices: a prefix matches the next part of an id, not another model; relative units price everything alike', () => {
  const t = priceTable();
  assert.equal(t.find('gpt-5-codex').key, 'gpt-5'); assert.equal(t.find('gpt-5.5'), null); assert.equal(t.find('claude-sonnet-4-5-20250929').key, 'claude-sonnet-4-5');
  const r = priceTable('relative'); assert.equal(r.find('anything').cacheRead, 0.1); assert.equal(r.currency, 'units');
  const calls = [{ kind: 'llm_call', t: 1, harness: 'h', session: 's', id: 'x', model: 'gpt-5.5', input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, toolCalls: [] }];
  assert.equal(ledger(calls, { prices: 'relative' }).report.totals.cost, 1);
});

test('cli outcomes: per_instance_details.json with its metadata.yaml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-out-')), run = path.join(dir, 'run1');
  fs.mkdirSync(run); fs.writeFileSync(path.join(run, 'per_instance_details.json'), JSON.stringify(details)); fs.writeFileSync(path.join(run, 'metadata.yaml'), 'info:\n  name: Model One\n');
  const r = spawnSync(process.execPath, [CLI, 'outcomes', dir, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout); assert.equal(j.runs[0].model, 'Model One'); assert.equal(j.runs[0].run, 'run1'); assert.equal(j.runs[0].costPerSuccess, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
