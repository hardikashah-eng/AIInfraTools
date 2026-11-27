import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/ask.js'), TP = require('../src/templates.js');
const G = id => TP.TEMPLATES.find(t => t.id === id).build();
const read = (id, q) => { const p = A.parse(q, G(id)); return { edits: p.edits.map(e => e.text), stress: p.stress && p.stress.name, ignored: p.ignored, p }; };

test('reads GPU moves, link changes and instance counts by name, site or traffic source', () => {
  let r = read('agent', 'What if coding agents move to B200 and the cloud link drops to 25 Gbps?');
  assert.deepEqual(r.edits, ['On-prem H100 on B200', 'Cloud link at 25 Gbps']); assert.equal(r.ignored, '');
  r = read('burst', 'Add 4 instances to on-prem'); assert.deepEqual(r.edits, ['On-prem H100 with 8 instances']);
  r = read('burst', 'Neocloud can scale to 16 instances with a 30 s cold start');
  assert.deepEqual(r.edits, ['Neocloud H200 with 16 instances at most', 'Neocloud H200 cold start 30 s']);
});

test('reads traffic, context and outage what-ifs as stress tests', () => {
  assert.equal(read('burst', 'Double the traffic').stress, 'traffic ×2');
  assert.equal(read('agent', 'Contexts grow 2x').stress, 'contexts ×2');
  const r = read('burst', 'What if half of on-prem goes down?');
  assert.equal(r.p.stress.outages[0].fraction, 0.5); assert.equal(r.p.stress.outages[0].target, 'on');
  assert.equal(read('burst', 'what if the cloud link fails').p.stress.outages.map(o => o.target).join(), 'lk');
});

test('reads model, reasoning, SLO and serving features', () => {
  assert.deepEqual(read('burst', 'Use Llama 3.1 405B with high reasoning').edits, ['serve Llama 3.1 405B', 'reasoning with 8000 hidden thinking tokens']);
  assert.deepEqual(read('agent', 'Turn on KV-aware routing and speculative decoding').edits, ['Router: KV-aware routing', 'speculative decoding, 3 draft tokens']);
  assert.deepEqual(read('burst', 'Set the TTFT target to 1 s').edits, ['TTFT target 1 s']);
});

test('answers with before and after numbers, and says what it did not use', () => {
  const r = A.answer('Add 4 instances to on-prem', G('burst'));
  assert.ok(r.after.slo > r.before.slo + 0.3);
  assert.match(r.text, /^With On-prem H100 with 8 instances: SLO attainment rises from 56\.9% to/);
  const same = A.answer('What if the cloud link drops to 100 Gbps', G('agent'));
  assert.match(same.text, /could not match|Already the case/);
  const no = A.answer('make it faster please', G('burst'));
  assert.equal(no.understood, false); assert.match(no.text, /could not match/);
});

test('the other phrasings: link commands, removals, scaling words, user surges, percentages, routing policies and limits', () => {
  const cases = [
    ['xpd', 'Cut the cross-site link to 400 Gbps', /link at 400 Gbps/i],
    ['xpd', 'upgrade the link to 1 tbps', /1000 Gbps/],
    ['burst', 'Put on-prem on B200', /On-prem H100 on B200/],
    ['burst', 'Remove 2 instances from on-prem', /On-prem H100 with 2 instances/],
    ['burst', 'Double on-prem', /On-prem H100 with 8 instances/],
    ['burst', 'Halve on-prem', /On-prem H100 with 2 instances/],
    ['burst', 'cold start of 2 min', /cold start 120 s/],
    ['burst', 'Set the TPOT target to 40 ms', /TPOT target 40 ms/],
    ['multi', 'Use round robin', /round robin/],
    ['multi', 'least-wait routing', /least estimated wait/],
    ['agent', 'cache-oblivious routing', /cache-oblivious/],
    ['burst', 'turn on kv offload', /512 GB CPU KV offload/],
    ['burst', 'enforce data residency', /enforce data residency/],
    ['burst', 'Use DeepSeek V3 with reasoning of 4k tokens', /671B/],
    ['burst', 'no reasoning', /reasoning|thinking/],
  ];
  for (const [id, q, re] of cases) { const r = read(id, q); assert.ok(r.edits.some(e => re.test(e)) || r.p.notes.some(e => re.test(e)), `${q}: ${JSON.stringify(r.edits)} ${JSON.stringify(r.p.notes)}`); }
  for (const [q, name] of [['traffic increases by 50%', 'traffic ×1.5'], ['double the users', 'users ×2'], ['3x the traffic', 'traffic ×3'], ['traffic triples', 'traffic ×3'], ['triple the contexts', 'contexts ×3'], ['4x longer contexts', 'contexts ×4']]) assert.equal(read('burst', q).stress, name, q);
  const o = read('burst', 'What if 25% of on-prem goes down and we lose the neocloud?').p.stress.outages.map(x => [x.target, x.fraction]);
  assert.deepEqual(o.map(x => x[1]).sort(), [0.25, 1]);
  assert.equal(read('burst', 'a quarter of on-prem goes down').p.stress.outages[0].fraction, 0.25);
  assert.equal(read('burst', 'move the moon to H200').edits.length, 0, 'no node by that name: nothing changed');
  assert.equal(read('burst', 'traffic grows').stress, null, 'a growth without a size is not read');
});

test('answers: already the case, a change that breaks the graph, outages cutting streams, no question understood', () => {
  const same = A.answer('Set the TTFT target to ' + G('burst').nodes.find(n => n.type === 'slo').cfg.ttft + ' s and double the traffic', G('burst'));
  assert.match(same.text, /Already the case, so unchanged: TTFT target/);
  const lost = A.answer('What if all of on-prem goes down?', G('burst')); assert.ok(lost.understood); assert.match(lost.text, /SLO attainment/);
  const none = A.answer('sing a song', G('burst')); assert.equal(none.understood, false); assert.match(none.text, /could not match/);
  const merged = A.answer('Double the traffic', G('burst'), { stress: { name: 'base', outages: [] } }); assert.match(merged.text, /traffic ×2/);
});
