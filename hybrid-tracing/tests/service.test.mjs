import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer } from '../src/service.mjs';
import { generate, TRUE_OFFSETS_NS } from '../src/synth.mjs';
import { collect, violations, CORRECTED_ATTR } from '../src/skew.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = srv => new Promise(r => srv.close(r));

async function withDownstream(status, fn) {
  const got = [];
  const ds = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { got.push(JSON.parse(Buffer.concat(c))); res.writeHead(status); res.end('{}'); }); });
  const dport = await listen(ds);
  const { server, corrector } = startServer({ downstream: `http://127.0.0.1:${dport}/v1/traces`, resolveMs: 3_600_000 });
  const port = await listen(server);
  try { await fn({ port, got, corrector }); } finally { await close(server); await close(ds); }
}
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body });

test('learns offsets from live batches and corrects what it forwards', async () => {
  await withDownstream(200, async ({ port, got, corrector }) => {
    // the collector sends one batch per resource here, so parents and children arrive in different requests
    const learn = generate({ requests: 300, seed: 11 }).request;
    for (const rs of learn.resourceSpans) assert.equal((await post(port, JSON.stringify({ resourceSpans: [rs] }))).status, 200);
    assert.ok(got.every(b => b.resourceSpans.every(rs => rs.scopeSpans[0].spans.every(s => !(s.attributes || []).some(a => a.key === CORRECTED_ATTR)))), 'nothing is corrected before the first solve');
    corrector.resolve();
    const off = corrector.offsets;
    assert.ok(Math.abs(off['decode-4'] - TRUE_OFFSETS_NS['decode-4']) < 150_000);
    got.length = 0;
    const fresh = generate({ requests: 50, seed: 99 }).request;
    const gz = zlib.gzipSync(JSON.stringify(fresh));
    assert.equal((await post(port, gz, { 'content-encoding': 'gzip' })).status, 200);
    const out = collect(got);
    assert.equal(violations(out).startBeforeParent, 0);
    assert.ok(out.some(s => (s.raw.attributes || []).some(a => a.key === CORRECTED_ATTR)));
  });
});

test('exposes offsets and Prometheus metrics', async () => {
  await withDownstream(200, async ({ port, corrector }) => {
    await post(port, JSON.stringify(generate({ requests: 100 }).request));
    corrector.resolve();
    const m = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(m, /clock_skew_offset_seconds\{domain="decode-6",site="neocloud",method="two-way"\} 0\.01/);
    assert.match(m, /skew_corrector_spans_total \d+/);
    const o = await (await fetch(`http://127.0.0.1:${port}/offsets`)).json();
    assert.ok(o.rows.find(r => r.domain === 'decode-6'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  });
});

test('refuses protobuf with a hint, and reports downstream failures so the collector retries', async () => {
  await withDownstream(500, async ({ port, corrector }) => {
    const pb = await post(port, 'x', { 'content-type': 'application/x-protobuf' });
    assert.equal(pb.status, 415);
    assert.match((await pb.json()).error, /encoding: json/);
    assert.equal((await post(port, '{nope')).status, 400);
    assert.equal((await post(port, JSON.stringify(generate({ requests: 5 }).request))).status, 503);
    assert.equal(corrector.metrics.forwardErrors, 1);
  });
});
