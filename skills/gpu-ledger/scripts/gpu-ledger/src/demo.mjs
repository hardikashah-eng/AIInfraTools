// A demo org: a week on two clusters with planted waste, so every insight has something to find. `answers` lists
// what a correct run should report.
export const DEMO_PRICES = {
  currency: 'USD', default: { provider: 'onprem' },
  gpus: {
    H100: { onprem: { capex: 30000, years: 4, watts: 1100, pue: 1.3, kwh: 0.10, opexYear: 1500 }, neocloud: 2.49 },
    H200: { onprem: { capex: 36000, years: 4, watts: 1200, pue: 1.3, kwh: 0.10, opexYear: 1500 }, neocloud: 3.2 },
    L40S: { onprem: { capex: 9000, years: 4, watts: 450, pue: 1.3, kwh: 0.10, opexYear: 800 }, neocloud: 0.95 },
    A100: { onprem: { capex: 15000, years: 4, watts: 700, pue: 1.3, kwh: 0.10, opexYear: 1200 }, neocloud: 1.4 },
  },
  commitments: [{ provider: 'neocloud', gpuType: 'H100', gpus: 32, rate: 2.1 }],
};
export const DEMO_ATTRIBUTION = {
  directory: { alice: { team: 'nlp', org: 'research' }, bob: { team: 'nlp', org: 'research' }, carol: { team: 'vision', org: 'research' }, dave: { team: 'speech', org: 'research' },
    erin: { team: 'vision', org: 'research' }, frank: { team: 'serving', org: 'product' }, gina: { team: 'pretrain', org: 'research' } },
  teams: { platform: 'infra' },
  shared: [{ match: { namespace: '^(kube-system|monitoring)$' } }],
};

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function demo({ t0 = Date.UTC(2026, 10, 9) / 1000, days = 7, seed = 7 } = {}) {
  const R = rng(seed), H = 3600, recs = [], end = t0 + days * 86400; let id = 0;
  const add = r => recs.push(Object.assign({ id: `d${++id}`, cluster: 'onprem-a', provider: 'onprem' }, r));
  // pretraining: steady 64 × H100, a couple of node failures with checkpoints every 40 min
  add({ start: t0, end: t0 + 2.5 * 86400, gpus: 64, gpuType: 'H100', user: 'gina', name: 'pretrain-7b', group: 'pretrain-7b', status: 'failed', checkpoint: { intervalS: 2400 }, util: { busy: 0.97, sm: 0.62, memPeak: 0.88, idleLong: 0 } });
  add({ start: t0 + 2.5 * 86400 + 600, end: end, gpus: 64, gpuType: 'H100', user: 'gina', name: 'pretrain-7b', group: 'pretrain-7b', status: 'running', checkpoint: { intervalS: 2400 }, util: { busy: 0.96, sm: 0.6, memPeak: 0.88, idleLong: 0 } });
  // alice: notebooks left open overnight (long idle stretches)
  for (let d = 0; d < days; d++) add({ start: t0 + d * 86400 + 9 * H, end: t0 + d * 86400 + 23 * H, gpus: 2, gpuType: 'H100', user: 'alice', kind: 'notebook', name: 'jupyter-alice', util: { busy: 0.25, sm: 0.4, memPeak: 0.5, idleLong: 2 * 9.5 * H } });
  // bob: a sweep that fails over and over and never succeeds
  for (let i = 0; i < 9; i++) { const s = t0 + i * 16 * H; add({ start: s, end: s + 2.5 * H, gpus: 8, gpuType: 'H100', user: 'bob', name: 'sweep-lr', group: 'sweep-lr', status: 'failed', util: { busy: 0.9, sm: 0.5, memPeak: 0.7, idleLong: 0 } }); }
  // carol: fine-tuning a small model on H100 that would fit an L40S
  for (let d = 0; d < days; d++) add({ start: t0 + d * 86400, end: t0 + d * 86400 + 20 * H, gpus: 4, gpuType: 'H100', user: 'carol', name: 'sft-1b', group: 'sft-1b', status: 'succeeded', util: { busy: 0.92, sm: 0.22, memPeak: 0.3, idleLong: 0 } });
  // erin: single-GPU evaluations that barely use a GPU
  for (let i = 0; i < 60; i++) { const s = t0 + i * 2.6 * H; add({ start: s, end: s + 2 * H, gpus: 1, gpuType: 'A100', user: 'erin', name: `eval-${i}`, group: 'eval', useCase: 'evaluation', status: 'succeeded', util: { busy: 0.85, sm: 0.15, memPeak: 0.2, idleLong: 0 } }); }
  // dave: a job that holds 16 GPUs and waits on data most of the time
  add({ start: t0 + 86400, end: t0 + 3 * 86400, gpus: 16, gpuType: 'H100', user: 'dave', name: 'asr-train', group: 'asr-train', status: 'succeeded', util: { busy: 0.12, sm: 0.5, memPeak: 0.6, idleLong: 0 } });
  // monitoring: shared
  add({ start: t0, end, gpus: 1, gpuType: 'L40S', namespace: 'monitoring', name: 'dcgm-canary', util: { busy: 0.05, sm: 0.1, memPeak: 0.05, idleLong: 0 } });
  // serving: llama33-70b on H100 (8 × TP2 replicas all week) and H200 (2 × TP2), diurnal traffic
  for (let h = 0; h < days * 24; h++) {
    const hs = t0 + h * H, diurnal = 0.25 + 0.75 * Math.max(0, Math.sin(Math.PI * (((h % 24) - 6) / 16))), noise = 0.9 + 0.2 * R();
    const tokH100 = 16 * 900 * H * diurnal * noise * 0.55, tokH200 = 4 * 1500 * H * diurnal * noise * 0.7;
    add({ start: hs, end: hs + H, gpus: 16, gpuType: 'H100', user: 'frank', namespace: 'chat', kind: 'deployment', name: 'chat-70b', status: 'running', serving: { model: 'llama33-70b', tokensOut: tokH100, tokensIn: tokH100 * 4, requests: tokH100 / 300 }, util: { busy: 0.6 + 0.35 * diurnal, sm: 0.45, memPeak: 0.9, idleLong: 0 } });
    add({ start: hs, end: hs + H, gpus: 4, gpuType: 'H200', user: 'frank', namespace: 'chat', kind: 'deployment', name: 'chat-70b-h200', status: 'running', serving: { model: 'llama33-70b', tokensOut: tokH200, tokensIn: tokH200 * 4, requests: tokH200 / 300 }, util: { busy: 0.7 + 0.25 * diurnal, sm: 0.5, memPeak: 0.85, idleLong: 0 } });
    // a 70B router that answers with a label: short outputs on a big model, on rented H100s under the commitment
    const rq = 40 * H * diurnal * noise;
    add({ start: hs, end: hs + H, gpus: 16, gpuType: 'H100', cluster: 'neocloud-1', provider: 'neocloud', user: 'frank', namespace: 'router', kind: 'deployment', name: 'intent-router', status: 'running',
      serving: { model: 'llama31-70b-instruct', tokensOut: rq * 6, tokensIn: rq * 800, requests: rq }, util: { busy: 0.5 + 0.4 * diurnal, sm: 0.3, memPeak: 0.85, idleLong: 0 } });
  }
  const capacity = [{ cluster: 'onprem-a', gpuType: 'H100', gpus: 160 }, { cluster: 'onprem-a', gpuType: 'H200', gpus: 16 }, { cluster: 'onprem-a', gpuType: 'A100', gpus: 16 }, { cluster: 'onprem-a', gpuType: 'L40S', gpus: 8 }];
  const answers = { kinds: ['idle-timeout', 'repeated-failure', 'gpu-type', 'share-gpu', 'held-idle', 'serving-gpu', 'serving-scale', 'serving-model-size', 'commitment', 'unallocated'],
    owners: { 'idle-timeout': 'alice', 'repeated-failure': 'bob', 'gpu-type': 'carol', 'share-gpu': 'erin', 'held-idle': 'dave' } };
  return { records: recs, from: t0, to: end, prices: DEMO_PRICES, attribution: DEMO_ATTRIBUTION, capacity, answers, budgets: { 'org:research': 150000, 'team:serving': 20000 } };
}
