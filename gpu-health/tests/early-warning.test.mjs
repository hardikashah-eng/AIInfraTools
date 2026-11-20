import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplesFromExporter } from '../src/ingest.mjs';
import { loadConfig } from '../src/config.mjs';
import { assessHealth } from '../src/health.mjs';
import { analyze } from '../src/analyze.mjs';
import { suggest } from '../src/actions.mjs';
import { demoSamples, demoJobs, demoSteps, demoProbes, demoCluster, demoResults, DEMO_NOW } from '../src/synth.mjs';

const cfg = loadConfig({});
// h hours of 60 s samples for one GPU; f(t) overrides fields
const S = (t, node, gpu, extra = {}) => Object.assign({ t, node, gpu: String(gpu), sku: 'H200', tensor: 0.4, sm: 0.6, dram: 0.3, tempC: 60, memTempC: 66, powerW: 500, throttle: 0, faults: [] }, extra);
const hours = (now, node, gpu, h, f = () => ({})) => Array.from({ length: h * 60 }, (_, i) => { const t = now - (h * 60 - 1 - i) * 60; return S(t, node, gpu, f(t)); });

test('ingest: clock-event bitmask gives power brake and throttle; HBM temperature mapped', () => {
  const s = samplesFromExporter(`DCGM_FI_DEV_CLOCKS_EVENT_REASONS{gpu="0",Hostname="n1"} 128\nDCGM_FI_DEV_CLOCKS_EVENT_REASONS{gpu="1",Hostname="n1"} 64\nDCGM_FI_DEV_MEMORY_TEMP{gpu="1",Hostname="n1"} 81`, { t: 1 });
  const g0 = s.find(x => x.gpu === '0'), g1 = s.find(x => x.gpu === '1');
  assert.equal(g0.powerBrake, 1); assert.equal(g0.throttle, 0); assert.equal(g0.clockReasons, undefined);
  assert.equal(g1.powerBrake, 0); assert.equal(g1.throttle, 1); assert.equal(g1.memTempC, 81);
});

test('AMD: uncorrectable XGMI_WAFL errors quarantine the GPU', () => {
  const now = 100000;
  const prom = v => `gpu_gfx_activity{gpu_id="2",hostname="m1"} 50\ngpu_ecc_uncorrect_xgmi_wafl{gpu_id="2",hostname="m1"} ${v}\ngpu_ecc_correct_xgmi_wafl{gpu_id="2",hostname="m1"} 3`;
  const samples = [...samplesFromExporter(prom(0), { t: now - 120 }), ...samplesFromExporter(prom(0), { t: now - 60 }), ...samplesFromExporter(prom(1), { t: now })];
  assert.equal(samples[2].linkUeTotal, 1); assert.equal(samples[2].linkErrTotal, 3);
  const h = assessHealth({ samples, cfg, now });
  assert.equal(h.gpus['m1/2'].state, 'quarantined'); assert.equal(h.gpus['m1/2'].faultClass, 'link'); assert.match(h.gpus['m1/2'].why, /XGMI/);
});

test('persistence: a signal in 1 of 4 windows is ignored, in 3 of 4 it makes the GPU suspect', () => {
  const now = 400000;
  const peers = g => hours(now, 'p', g, 4);
  const brief = hours(now, 'p', 0, 4, t => (t > now - 3600 ? { throttle: 0.6 } : {}));
  let h = assessHealth({ samples: [brief, peers(1), peers(2), peers(3)].flat(), cfg, now });
  assert.equal(h.gpus['p/0'].state, 'serving', 'one hot hour is not enough');
  const lasting = hours(now, 'p', 0, 4, t => (t > now - 3 * 3600 ? { throttle: 0.6 } : {}));
  h = assessHealth({ samples: [lasting, peers(1), peers(2), peers(3)].flat(), cfg, now });
  assert.equal(h.gpus['p/0'].state, 'suspect'); assert.equal(h.gpus['p/0'].signals.find(s => s.key === 'throttle').persist, '3/4');
});

test('cooldown: a cleared signal stays quiet, then may fire again', () => {
  let now = 500000;
  const run = (hot, prev) => assessHealth({ samples: [hours(now, 'c', 0, 4, () => (hot ? { throttle: 0.6 } : {})), hours(now, 'c', 1, 4)].flat(), prev, cfg, now });
  let h = run(true); assert.equal(h.gpus['c/0'].state, 'suspect');
  now += 4 * 3600; h = run(false, { gpus: h.gpus }); assert.equal(h.gpus['c/0'].state, 'serving'); assert.match(h.gpus['c/0'].why, /cleared/);
  now += 3600; h = run(true, { gpus: h.gpus }); assert.equal(h.gpus['c/0'].state, 'serving', 'inside the 120-minute cooldown');
  now += 2 * 3600; h = run(true, { gpus: h.gpus }); assert.equal(h.gpus['c/0'].state, 'suspect', 'cooldown over');
});

test('peers: same node and job first; HBM trend against the GPU\'s own history', () => {
  const now = 900000;
  const jobs = [{ id: 'j', class: 'training', gpus: [0, 1, 2, 3].map(g => ({ node: 'h', gpu: String(g) })) }];
  const day = 86400;
  const g0 = hours(now, 'h', 0, 72, t => (t > now - day ? { memTempC: 80 } : {}));
  const h = assessHealth({ samples: [g0, hours(now, 'h', 1, 72), hours(now, 'h', 2, 72), hours(now, 'h', 3, 72)].flat(), jobs, cfg, now });
  const keys = h.gpus['h/0'].signals.map(s => s.key);
  assert.ok(keys.includes('hbm-temp-peers')); assert.ok(keys.includes('hbm-temp-rise'));
  assert.equal(h.gpus['h/0'].evidence.peerScope, 'same node and job');
  assert.equal(h.gpus['h/1'].state, 'serving');
});

test('telemetry: one GPU thinning is suspect; a whole node thinning points at the exporter', () => {
  const now = 300000;
  const thin = (node, g) => hours(now, node, g, 3).filter(s => !(s.t > now - 3600 && Math.floor(s.t / 60) % 2 === 0));
  let h = assessHealth({ samples: [thin('a', 0), hours(now, 'a', 1, 3), hours(now, 'a', 2, 3)].flat(), cfg, now });
  assert.equal(h.gpus['a/0'].state, 'suspect'); assert.equal(h.gpus['a/0'].faultClass, 'telemetry');
  h = assessHealth({ samples: [thin('b', 0), thin('b', 1), thin('b', 2), hours(now, 'c', 0, 3)].flat(), cfg, now });
  assert.deepEqual(h.nodesThin, ['b']); assert.equal(h.gpus['b/0'].state, 'serving');
  const sug = suggest({ health: h, jobs: [], risk: [], recommendations: [], partitionPlan: [] }, cfg);
  assert.ok(sug.some(a => a.id === 'exporter-check:node:b'));
  const vanished = hours(now, 'd', 0, 3).map(s => (s.t > now - 3600 ? Object.assign({}, s, { tempC: undefined, memTempC: undefined }) : s));
  h = assessHealth({ samples: [vanished, hours(now, 'd', 1, 3), hours(now, 'd', 2, 3)].flat(), cfg, now });
  assert.match(h.gpus['d/0'].why, /metrics stopped reporting: tempC, memTempC/);
});

test('SDC: one event is suspect, two or a replay mismatch quarantine; attributed through job and rank', () => {
  const now = 700000;
  const jobs = [{ id: 't', class: 'training', gpus: [{ node: 'x', gpu: '0' }, { node: 'x', gpu: '1' }] }];
  const base = [hours(now, 'x', 0, 2), hours(now, 'x', 1, 2)].flat();
  const ev = (rank, type, ago) => ({ kind: 'sdc', job: 't', rank, type, t: now - ago });
  let h = assessHealth({ samples: base, jobs, results: [ev(1, 'nan', 600)], cfg, now });
  assert.equal(h.gpus['x/1'].state, 'suspect'); assert.equal(h.gpus['x/0'].state, 'serving');
  h = assessHealth({ samples: base, jobs, results: [ev(1, 'nan', 6000), ev(1, 'loss-spike', 600)], cfg, now });
  assert.equal(h.gpus['x/1'].state, 'quarantined'); assert.equal(h.gpus['x/1'].faultClass, 'sdc');
  h = assessHealth({ samples: base, jobs, results: [ev(0, 'replay-mismatch', 600)], cfg, now });
  assert.equal(h.gpus['x/0'].state, 'quarantined');
});

test('old hard events do not block repair: SDC quarantine → diag pass → burn-in', () => {
  let now = 800000;
  const jobs = [{ id: 't', class: 'training', gpus: [{ node: 'y', gpu: '0' }] }];
  const results = [{ kind: 'sdc', job: 't', rank: 0, type: 'replay-mismatch', t: now - 600 }];
  let h = assessHealth({ samples: hours(now, 'y', 0, 2), jobs, results, cfg, now });
  assert.equal(h.gpus['y/0'].state, 'quarantined');
  now += 3600;
  h = assessHealth({ samples: hours(now, 'y', 0, 2), jobs, results: [...results, { kind: 'diag', node: 'y', gpu: '0', t: now - 60, pass: true, level: 4 }], prev: { gpus: h.gpus }, cfg, now });
  assert.equal(h.gpus['y/0'].state, 'burnin');
});

test('staleness follows the scrape interval', () => {
  const now = 600000;
  const slow = Array.from({ length: 20 }, (_, i) => S(now - 600 - i * 600, 'z', 0)); // 10-minute scrapes, last one 10 min ago
  assert.equal(assessHealth({ samples: slow, cfg, now }).gpus['z/0'].stale, false);
  assert.equal(assessHealth({ samples: slow, cfg, now: now + 1800 }).gpus['z/0'].stale, true);
});

test('demo: work moves off risky GPUs before they fail', () => {
  const a = analyze({ samples: demoSamples(), jobs: demoJobs(), steps: demoSteps(), probes: demoProbes(), results: demoResults(), cluster: demoCluster(), cfg: loadConfig({ pricePerGpuHour: { B200: 6, H200: 4.5 } }), now: DEMO_NOW });
  const by = Object.fromEntries(a.suggestions.map(s => [s.id, s]));
  assert.equal(by['swap-at-checkpoint:train-llm@n1/3'].mode, 'approve');
  assert.ok(by['swap-at-checkpoint:train-llm@n2/5'].weekly > 3000, 'straggler savings merged into the swap');
  assert.match(by['swap-at-checkpoint:train-llm@n1/2'].reason, /silent-data-corruption/);
  assert.match(by['drain-inference:embed-svc@n3/6'].reason, /3 other replica/);
  assert.match(by['drain-inference:rerank-svc@n4/4'].reason, /only replica/);
  assert.ok(!Object.keys(by).some(id => id.includes('serve-chat')), 'healthy memory-bound decode left alone');
});
