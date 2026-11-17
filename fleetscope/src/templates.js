/* FleetScope node catalogue and starter graphs. */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.FleetEngine;
  const M = key => Object.assign({ name: 'Model', key, wPrec: 'fp8', kvPrec: 'fp8', thinkTokens: 0, thinkKeep: false }, E.MODELS[key]);
  const NODE_TYPES = {
    agent: { title: 'Coding agents', group: 'Traffic', color: 'src', inputs: false, outputs: true, w: 230,
      defaults: () => ({ name: 'Coding agents', users: 60, turns: 12, systemTokens: 6000, contextTokens: 30000, turnTokens: 2500, outTokens: 350, thinkS: 4, gapS: 30, prefixHit: 85, durationMin: 10 }) },
    chat: { title: 'Chat users', group: 'Traffic', color: 'src', inputs: false, outputs: true, w: 230,
      defaults: () => ({ name: 'Chat users', users: 400, turns: 6, systemTokens: 800, contextTokens: 0, turnTokens: 300, outTokens: 300, thinkS: 20, gapS: 60, prefixHit: 50, durationMin: 10 }) },
    trace: { title: 'Trace replay', group: 'Traffic', color: 'src', inputs: false, outputs: true, w: 230,
      defaults: () => ({ name: 'Trace replay', trace: 'chat', scale: 1, prefixHit: 0, useRecordedCache: true }) },
    router: { title: 'Router', group: 'Routing', color: 'route', inputs: true, outputs: true, w: 200,
      defaults: () => ({ name: 'Router', policy: 'primary-first', burstWait: 1.5 }) },
    pool: { title: 'GPU pool', group: 'Compute', color: 'pool', inputs: true, outputs: true, w: 290,
      defaults: () => ({ name: 'On-prem pool', site: 'On-prem DC', siteKind: 'onprem', role: 'agg', gpu: 'H100', instances: 4, autoscale: false, min: 0, max: 8, coldStart: 90, upWait: 1, downUtil: 30, maxBatch: 256, fabricGbps: 400 }) },
    link: { title: 'Cross-site link', group: 'Network', color: 'link', inputs: true, outputs: true, w: 210,
      defaults: () => ({ name: 'Cloud link', gbps: 100, rttMs: 20, egressPerGB: 0.05 }) },
    train: { title: 'Training job', group: 'Compute', color: 'train', inputs: false, outputs: true, w: 250,
      defaults: () => ({ name: 'Training job', model: 'llama-70b', gpus: 256, gpu: 'H100', site: 'On-prem DC', siteKind: 'onprem', tokensPerStepM: 4, mfu: 40, overlap: true, horizonMin: 10 }) },
    model: { title: 'Model', group: 'Settings', color: 'set', inputs: false, outputs: false, w: 240, singleton: true, fixed: true,
      defaults: () => M('llama-70b') },
    slo: { title: 'SLO targets', group: 'Settings', color: 'set', inputs: false, outputs: false, w: 200, singleton: true, fixed: true,
      defaults: () => ({ name: 'SLO targets', ttft: 2, tpotMs: 60, thinkingStreamed: false }) }
  };
  const PALETTE = [
    { type: 'agent', label: 'Coding agents', hint: 'Concurrent agent sessions with growing context' },
    { type: 'chat', label: 'Chat users', hint: 'Concurrent chat sessions with think time' },
    { type: 'trace', label: 'Trace replay', hint: 'Replay a recorded or sample trace' },
    { type: 'router', label: 'Router', hint: 'Splits traffic across pools' },
    { type: 'pool', label: 'On-prem GPU pool', hint: 'Fixed-size aggregated pool', cfg: {} },
    { type: 'pool', label: 'Neocloud GPU pool', hint: 'Autoscaled burst capacity', cfg: { name: 'Neocloud pool', site: 'Neocloud A', siteKind: 'neo', gpu: 'H200', autoscale: true, min: 0, max: 8, instances: 0 } },
    { type: 'pool', label: 'Prefill pool', hint: 'Disaggregated prefill', cfg: { name: 'Prefill pool', role: 'prefill', instances: 3 } },
    { type: 'pool', label: 'Decode pool', hint: 'Disaggregated decode', cfg: { name: 'Decode pool', role: 'decode', instances: 4 } },
    { type: 'link', label: 'Cross-site link', hint: 'Shared WAN between sites' },
    { type: 'train', label: 'Training job', hint: 'Step-level model; wire to a link to split it' },
    { type: 'model', label: 'Model', hint: 'One per canvas' },
    { type: 'slo', label: 'SLO targets', hint: 'One per canvas' }
  ];
  function node(id, type, x, y, cfg) { return { id, type, x, y, cfg: Object.assign(NODE_TYPES[type].defaults(), cfg || {}) }; }
  function edge(from, to) { return { id: 'e:' + from + '>' + to, from, to }; }
  const NEO = { name: 'Neocloud pool', site: 'Neocloud A', siteKind: 'neo', gpu: 'H200', autoscale: true, min: 0, max: 8, coldStart: 90 };
  const TEMPLATES = [
    { id: 'burst', name: 'Hybrid chat burst', desc: 'A spike outruns a 90 s cold start', build: () => ({
      nodes: [node('model', 'model', 40, 20), node('slo', 'slo', 310, 20),
        node('src', 'trace', 40, 250), node('rt', 'router', 330, 260, { name: 'Router' }),
        node('on', 'pool', 600, 150, { name: 'On-prem H100', instances: 4 }),
        node('lk', 'link', 600, 470), node('neo', 'pool', 880, 410, Object.assign({}, NEO, { name: 'Neocloud H200' }))],
      edges: [edge('src', 'rt'), edge('rt', 'on'), edge('rt', 'lk'), edge('lk', 'neo')] }) },
    { id: 'agent', name: 'Coding agent fleet', desc: '60 agents, 30k-token contexts, 85% cache hits', build: () => ({
      nodes: [Object.assign(node('model', 'model', 40, 20), { cfg: M('coder-32b') }), node('slo', 'slo', 310, 20),
        node('src', 'agent', 40, 250), node('rt', 'router', 330, 260),
        node('on', 'pool', 600, 150, { name: 'On-prem H100', instances: 6 }),
        node('lk', 'link', 600, 470), node('neo', 'pool', 880, 410, Object.assign({}, NEO, { name: 'Neocloud H200', coldStart: 60 }))],
      edges: [edge('src', 'rt'), edge('rt', 'on'), edge('rt', 'lk'), edge('lk', 'neo')] }) },
    { id: 'xpd', name: 'Cross-site P/D split', desc: 'Every KV cache crosses a 100 Gbps link', build: () => ({
      nodes: [node('model', 'model', 40, 20), node('slo', 'slo', 310, 20),
        node('src', 'trace', 40, 250, { trace: 'agentic', name: 'Agentic trace' }), node('rt', 'router', 330, 260),
        node('pre', 'pool', 600, 190, { name: 'On-prem prefill', role: 'prefill', instances: 6 }),
        node('lk', 'link', 930, 250), node('dec', 'pool', 1200, 190, Object.assign({}, NEO, { name: 'Neocloud decode', role: 'decode', min: 4, max: 10 }))],
      edges: [edge('src', 'rt'), edge('rt', 'pre'), edge('pre', 'lk'), edge('lk', 'dec')] }) },
    { id: 'train', name: 'Training shares the link', desc: 'A 256-GPU job split across sites', build: () => {
      const g = TEMPLATES[2].build();
      g.nodes.push(node('job', 'train', 600, 560, { name: 'Pre-training run' }));
      g.edges.push(edge('job', 'lk'));
      return g;
    } },
    { id: 'disagg', name: 'On-prem disaggregated', desc: 'Prefill and decode pools in one site', build: () => ({
      nodes: [node('model', 'model', 40, 20), node('slo', 'slo', 310, 20),
        node('src', 'trace', 40, 250), node('rt', 'router', 330, 260),
        node('pre', 'pool', 600, 190, { name: 'Prefill H100', role: 'prefill', instances: 3 }),
        node('dec', 'pool', 940, 190, { name: 'Decode H100', role: 'decode', instances: 4 })],
      edges: [edge('src', 'rt'), edge('rt', 'pre'), edge('pre', 'dec')] }) },
    { id: 'multi', name: 'Two neoclouds', desc: 'Least-wait routing over two links', build: () => ({
      nodes: [node('model', 'model', 40, 20), node('slo', 'slo', 310, 20),
        node('src', 'trace', 40, 330, { scale: 1.6, name: 'Chat trace at 1.6x' }), node('rt', 'router', 330, 340, { policy: 'least-wait' }),
        node('on', 'pool', 600, 130, { name: 'On-prem H100', instances: 4 }),
        node('lka', 'link', 600, 450, { name: 'Link to cloud A', gbps: 100, rttMs: 15 }),
        node('neoa', 'pool', 880, 410, Object.assign({}, NEO, { name: 'Cloud A H200', site: 'Neocloud A', min: 1 })),
        node('lkb', 'link', 600, 640, { name: 'Link to cloud B', gbps: 40, rttMs: 45, egressPerGB: 0.08 }),
        node('neob', 'pool', 880, 690, Object.assign({}, NEO, { name: 'Cloud B MI300X', site: 'Neocloud B', gpu: 'MI300X', min: 1, coldStart: 150 }))],
      edges: [edge('src', 'rt'), edge('rt', 'on'), edge('rt', 'lka'), edge('lka', 'neoa'), edge('rt', 'lkb'), edge('lkb', 'neob')] }) },
    { id: 'blank', name: 'Blank canvas', desc: 'Model and SLO nodes only', build: () => ({ nodes: [node('model', 'model', 40, 20), node('slo', 'slo', 310, 20)], edges: [] }) }
  ];
  const api = { NODE_TYPES, PALETTE, TEMPLATES, node, edge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetTemplates = api;
})(typeof window !== 'undefined' ? window : this);
