/* FleetScope ask: turn a plain-English what-if into graph edits and stress, run it, and explain the result.
   A local, rule-based reader: it understands the phrasings listed in EXAMPLES and says which words it did not use. */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const E = node ? require('./engine.js') : root.FleetEngine;

  const EXAMPLES = [
    'What if coding agents move to H200 and the cloud link drops to 100 Gbps?',
    'Add 4 instances to on-prem',
    'Double the traffic',
    'What if half of on-prem goes down?',
    'Contexts grow 2x',
    'Use Llama 3.1 405B with high reasoning',
    'Turn on KV-aware routing and speculative decoding',
    'Neocloud can scale to 16 instances with a 30 s cold start',
    'Set the TTFT target to 1 s'
  ];
  const GPU_WORDS = { h100: 'H100', h200: 'H200', b200: 'B200', a100: 'A100', l40s: 'L40S', mi300x: 'MI300X', mi300: 'MI300X' };
  const MODEL_WORDS = [[/405\s*b/, 'llama-405b'], [/\b8\s*b\b/, 'llama-8b'], [/70\s*b|llama\s*3\.3/, 'llama-70b'], [/coder|32\s*b|qwen/, 'coder-32b'], [/moe|deepseek|671/, 'moe-671b']];
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16, twenty: 20 };
  const num = w => (w == null ? NaN : NUM[w] != null ? NUM[w] : parseFloat(w));

  // Finds the nodes a phrase names: by full name, by words of the name, by site type (on-prem, neocloud, cloud)
  // or by what flows through them ("coding agents" → pools their router feeds).
  function nodesNamed(phrase, g, types) {
    const p = phrase.toLowerCase().replace(/^(?:and\s+)?the\s+/, '').trim(), out = [];
    if (/\blink\b/.test(p) && types && types.includes('link')) types = ['link'];
    const cands = g.nodes.filter(n => !types || types.includes(n.type));
    for (const n of cands) {
      const nm = (n.cfg.name || '').toLowerCase();
      if (!nm) continue;
      const words = p.split(/[\s-]+/).filter(w => w.length > 2 && !['the', 'and', 'pool', 'pools', 'link'].includes(w));
      if (nm === p || p.includes(nm) || (words.length && words.every(w => nm.includes(w)))) out.push(n);
    }
    if (out.length) return out;
    if (!types || types.includes('pool')) {
      if (/on-?prem|own site|private/.test(p)) return cands.filter(n => n.type === 'pool' && n.cfg.siteKind !== 'neo');
      if (/neo-?cloud|\bcloud\b|burst/.test(p)) return cands.filter(n => n.type === 'pool' && n.cfg.siteKind === 'neo');
      // a traffic source's name: the pools its router feeds first
      const src = g.nodes.find(n => ['agent', 'chat', 'trace'].includes(n.type) && n.cfg.name && (p.includes(n.cfg.name.toLowerCase()) || n.cfg.name.toLowerCase().includes(p)));
      if (src) { const e = g.edges.find(x => x.from === src.id); const rt = e && g.nodes.find(n => n.id === e.to); const tgt = rt && g.edges.filter(x => x.from === rt.id).map(x => g.nodes.find(n => n.id === x.to)).find(n => n && n.type === 'pool'); if (tgt) return [tgt]; }
    }
    return [];
  }

  function parse(question, graph) {
    const q = ' ' + String(question).toLowerCase().replace(/[?!]/g, ' ').replace(/[“”"]/g, '').replace(/\b(what happens if|what if|suppose|imagine|if)\b/g, ' ').replace(/\s+/g, ' ') + ' ';
    const g = JSON.parse(JSON.stringify(graph)), edits = [], stress = { name: '', outages: [] }, used = [], notes = [];
    const set = (n, field, value, text) => { if (n.cfg[field] === value) { notes.push(text); return; } edits.push({ id: n.id, name: n.cfg.name, field, from: n.cfg[field], to: value, text }); n.cfg[field] = value; };
    const take = (re, fn) => { let m; const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = r.exec(q))) { if (fn(m) !== false) used.push([m.index, m.index + m[0].length]); } };
    const sized = n => (n.cfg.autoscale ? 'max' : 'instances');

    // GPU moves: "<x> (moves|move|switch|switches|goes) to H200", "put <x> on B200", "<x> on H200"
    take(/\b(?:move|put|switch|run)\s+(.+?)\s+(?:to|on|onto)\s+(h100|h200|b200|a100|l40s|mi300x?)\b/, m => { const ns = nodesNamed(m[1], g, ['pool']); if (!ns.length) return false; for (const n of ns) set(n, 'gpu', GPU_WORDS[m[2]], n.cfg.name + ' on ' + GPU_WORDS[m[2]]); });
    take(/\b([a-z][\w -]{2,40}?)\s+(?:moves?|switch(?:es)?|goes|go|migrates?)\s+to\s+(h100|h200|b200|a100|l40s|mi300x?)\b/, m => { const ns = nodesNamed(m[1].replace(/^(what if|if|and)\s+/, ''), g, ['pool']); if (!ns.length) return false; for (const n of ns) set(n, 'gpu', GPU_WORDS[m[2]], n.cfg.name + ' on ' + GPU_WORDS[m[2]]); });
    // link bandwidth: "(cloud) link (drops|cut|set|goes) to 100 gbps", "100 gbps link"
    take(/\b([\w -]*?link)\s+(?:drops?|falls?|is cut|cut|set|goes|shrinks?|grows?|upgraded|is upgraded|increases?|rises?)\s+(?:down\s+|up\s+)?to\s+(\d+(?:\.\d+)?)\s*(g|t)bps\b/, m => { const ns = nodesNamed(m[1], g, ['link']); const L = ns.length ? ns : g.nodes.filter(n => n.type === 'link'); if (!L.length) return false; const v = +m[2] * (m[3] === 't' ? 1000 : 1); for (const n of L) set(n, 'gbps', v, n.cfg.name + ' at ' + v + ' Gbps'); });
    take(/\b(?:cut|set|drop|reduce|raise|upgrade)\s+(?:the\s+)?([\w -]*?link)\s+to\s+(\d+(?:\.\d+)?)\s*(g|t)bps\b/, m => { const ns = nodesNamed(m[1], g, ['link']); const L = ns.length ? ns : g.nodes.filter(n => n.type === 'link'); if (!L.length) return false; const v = +m[2] * (m[3] === 't' ? 1000 : 1); for (const n of L) set(n, 'gbps', v, n.cfg.name + ' at ' + v + ' Gbps'); });
    // instances: "add 4 instances to x", "remove 2 from x", "x (has|with|to) 8 instances", "double x", "halve x"
    take(/\b(add|remove)\s+(\w+)\s+(?:more\s+)?(?:instances?|replicas?|servers?|nodes?)\s+(?:to|from|in|on)\s+(.+?)(?=\s+(?:and|with|,)\s|\s*$)/, m => { const k = num(m[2]); const ns = nodesNamed(m[3], g, ['pool']); if (!ns.length || !isFinite(k)) return false; for (const n of ns) { const f = sized(n), v = Math.max(0, n.cfg[f] + (m[1] === 'add' ? k : -k)); set(n, f, v, n.cfg.name + ' with ' + v + (f === 'max' ? ' instances at most' : ' instances')); } });
    take(/\b([a-z][\w -]{2,40}?)\s+(?:has|with|to|at|runs|can scale to|scales to|up to)\s+(\w+)\s+(?:instances?|replicas?)\b/, m => { const k = num(m[2]); const ns = nodesNamed(m[1].replace(/^(what if|if|and|set)\s+/, ''), g, ['pool']); if (!ns.length || !isFinite(k)) return false; for (const n of ns) { const f = sized(n); set(n, f, k, n.cfg.name + ' with ' + k + (f === 'max' ? ' instances at most' : ' instances')); } });
    take(/\b(double|triple|halve)\s+(?:the\s+)?(?!traffic|load|users|requests|contexts?)([a-z][\w -]{2,30}?)(?=\s+(?:and|with|,)\s|\s*$)/, m => { const f0 = { double: 2, triple: 3, halve: 0.5 }[m[1]]; const ns = nodesNamed(m[2], g, ['pool']); if (!ns.length) return false; for (const n of ns) { const f = sized(n), v = Math.max(1, Math.round(n.cfg[f] * f0)); set(n, f, v, n.cfg.name + ' with ' + v + ' instances'); } });
    take(/\bcold start (?:of |to )?(\d+)\s*(s|sec|seconds|min|minutes)\b|\b(\d+)\s*(s|sec|seconds|min|minutes) cold start\b/, m => { const v = +(m[1] || m[3]) * (/^m/.test(m[2] || m[4]) ? 60 : 1); const ns = g.nodes.filter(n => n.type === 'pool' && n.cfg.autoscale); if (!ns.length) return false; for (const n of ns) set(n, 'coldStart', v, n.cfg.name + ' cold start ' + v + ' s'); });
    // traffic and contexts
    take(/\b(double|triple|quadruple)\s+(?:the\s+)?(traffic|load|requests|users)\b|\b(traffic|load|requests|users)\s+(?:doubles|triples|grows|rises|increases|goes up)\s*(?:by\s+)?(\d+(?:\.\d+)?)?\s*(x|%|times)?/, m => {
      let k = m[1] ? { double: 2, triple: 3, quadruple: 4 }[m[1]] : m[5] === '%' ? 1 + num(m[4]) / 100 : num(m[4]) || ({ doubles: 2, triples: 3 }[(q.match(/(doubles|triples)/) || [])[1]] || NaN);
      if (!isFinite(k)) return false;
      const who = m[2] || m[3];
      stress.surge = { mult: k, start: 0, dur: 0, target: who === 'users' ? 'sessions' : 'all' }; stress.name += (stress.name ? ', ' : '') + (who === 'users' ? 'users' : 'traffic') + ' ×' + k;
    });
    take(/\b(\d+(?:\.\d+)?)\s*(?:x|times)\s+(?:the\s+)?(traffic|load|users)\b/, m => { const k = +m[1]; stress.surge = { mult: k, start: 0, dur: 0, target: m[2] === 'users' ? 'sessions' : 'all' }; stress.name += (stress.name ? ', ' : '') + m[2] + ' ×' + k; });
    take(/\bcontexts?\s+(?:grows?|double|doubles|triple|are|get)\s*(\d+(?:\.\d+)?)?\s*(x|times)?\b|\b(double|triple)\s+(?:the\s+)?contexts?\b|\b(\d+(?:\.\d+)?)\s*x\s+(?:longer\s+)?contexts?\b/, m => { const k = m[3] ? { double: 2, triple: 3 }[m[3]] : num(m[1] || m[4]) || (/double/.test(m[0]) ? 2 : /triple/.test(m[0]) ? 3 : NaN); if (!isFinite(k)) return false; stress.ctx = { mult: k, add: 0 }; stress.name += (stress.name ? ', ' : '') + 'contexts ×' + k; });
    // outages: "half of on-prem goes down", "the cloud link fails", "lose the neocloud"
    take(/\b(?:(half|a quarter|all|(\d+)\s*%)\s+of\s+)?(?:the\s+)?([a-z][\w -]{2,30}?)\s+(?:goes down|go down|is down|fails|failing|dies|is lost|outage)\b|\blose\s+(?:(half|all)\s+of\s+)?(?:the\s+)?([a-z][\w -]{2,30}?)(?=\s+(?:and|for|,)\s|\s*$)/, m => {
      const frac = (m[1] || m[4]) === 'half' ? 0.5 : (m[1] || m[4]) === 'a quarter' ? 0.25 : m[2] ? +m[2] / 100 : 1;
      const ns = nodesNamed((m[3] || m[5]).replace(/^(what if|if|and)\s+/, ''), g, ['pool', 'link']); if (!ns.length) return false;
      for (const n of ns) stress.outages.push({ target: n.id, fraction: frac, start: 0, dur: 1e9, recovery: 60 });
      stress.name += (stress.name ? ', ' : '') + ns.map(n => n.cfg.name).join(' and ') + (frac < 1 ? ' ' + Math.round(frac * 100) + '%' : '') + ' down';
    });
    // model, reasoning, SLO
    const model = g.nodes.find(n => n.type === 'model');
    take(/\b(?:use|switch to|serve|with|move to|try)\s+(?:the\s+)?([\w .-]*?(?:405\s*b|70\s*b|\b8\s*b|32\s*b|coder|qwen|moe|deepseek|671\s*b?)[\w .-]*?)(?=\s+(?:and|with|for|on|,)\s|\s*$)/, m => { if (!model) return false; const hit = MODEL_WORDS.find(([re]) => re.test(m[1])); if (!hit) return false; const M = E.MODELS[hit[1]]; Object.assign(model.cfg, { key: hit[1], params: M.params, active: M.active, layers: M.layers, kvHeads: M.kvHeads, headDim: M.headDim, mla: M.mla, label: M.label }); edits.push({ id: model.id, name: 'Model', field: 'key', to: hit[1], text: 'serve ' + M.label }); });
    take(/\b(no|low|medium|high|max)\s+(?:reasoning|thinking)\b|\b(?:reasoning|thinking)\s+(?:of\s+)?(\d+)\s*k?\s*tokens?\b|\b(?:turn on|enable|with)\s+(?:reasoning|thinking)\b/, m => { if (!model) return false; const lv = { no: 0, low: 500, medium: 2000, high: 8000, max: 16000 }; let v = m[1] ? lv[m[1]] : m[2] ? +m[2] * (/k\s*tokens?/.test(m[0]) ? 1000 : 1) : 2000; set(model, 'thinkTokens', v, v ? 'reasoning with ' + v + ' hidden thinking tokens' : 'no reasoning'); });
    const slo = g.nodes.find(n => n.type === 'slo');
    take(/\bttft\s+(?:target|slo)?\s*(?:to|of|=|at|under)?\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/, m => { if (!slo) return false; const v = +m[1] / (m[2] === 'ms' ? 1000 : 1); set(slo, 'ttft', v, 'TTFT target ' + v + ' s'); });
    take(/\btpot\s+(?:target|slo)?\s*(?:to|of|=|at|under)?\s*(\d+(?:\.\d+)?)\s*ms\b/, m => { if (!slo) return false; set(slo, 'tpotMs', +m[1], 'TPOT target ' + m[1] + ' ms'); });
    // routing and serving features
    const routers = g.nodes.filter(n => n.type === 'router'), poolsAll = g.nodes.filter(n => n.type === 'pool'), mdl = model;
    take(/\b(?:turn on |enable |use )?(?:kv[- ]aware|prefix[- ]aware)(?: routing)?\b|\bsession affinity\b/, () => { if (!routers.length) return false; for (const r of routers) set(r, 'affinity', 'session', r.cfg.name + ': KV-aware routing'); });
    take(/\bcache[- ]oblivious\b|\bwithout (?:kv|prefix)[- ]aware\b/, () => { for (const r of routers) set(r, 'affinity', 'none', r.cfg.name + ': cache-oblivious routing'); });
    take(/\bleast[- ]wait\b|\bleast[- ]loaded\b/, () => { for (const r of routers) set(r, 'policy', 'least-wait', r.cfg.name + ': least estimated wait'); });
    take(/\bround[- ]robin\b/, () => { for (const r of routers) set(r, 'policy', 'round-robin', r.cfg.name + ': round robin'); });
    take(/\bspeculative decoding\b|\bspec(?:ulative)? decode\b/, () => { if (!mdl) return false; set(mdl, 'specK', 3, 'speculative decoding, 3 draft tokens'); });
    take(/\b(?:cpu |kv )?offload\b/, () => { for (const p of poolsAll) set(p, 'offloadGB', 512, p.cfg.name + ': 512 GB CPU KV offload'); });
    take(/\benforce (?:data )?residency\b|\bkeep confidential (?:data )?on-?prem\b/, () => { for (const r of routers) set(r, 'enforceResidency', true, r.cfg.name + ': enforce data residency'); });

    let rest = q.split('');
    for (const [a, b] of used) for (let i = a; i < b; i++) rest[i] = ' ';
    const ignored = rest.join('')
      .replace(/\b(what|if|happens|would|happen|when|and|the|a|an|to|we|our|us|i|me|with|then|also|please|show|how|does|do|is|are|it|of|in|on|for|what's|set|turn|enable|use|can)\b/g, ' ').replace(/[,.;:]/g, ' ').replace(/\s+/g, ' ').trim();
    const hasStress = !!(stress.surge || stress.ctx || stress.outages.length);
    return { graph: g, edits, notes, stress: hasStress ? stress : null, understood: edits.length > 0 || hasStress, ignored };
  }

  // Runs the parsed what-if against the current graph and explains the difference.
  function answer(question, graph, opt) {
    opt = opt || {};
    const P = parse(question, graph);
    const lookup = opt.traceLookup || ((k, s) => E.scaleTrace(E.genTrace(k === 'uploaded' || k === 'live' ? 'chat' : k, 7), s || 1, 7));
    if (!P.understood) return Object.assign(P, { text: 'I could not match that to a change. Try phrasings like: ' + EXAMPLES.slice(0, 4).join(' / ') });
    const c0 = E.compileGraph(graph, lookup), c1 = E.compileGraph(P.graph, lookup);
    if (c1.errors.length) return Object.assign(P, { text: 'That change leaves the graph unable to run: ' + c1.errors.map(e => e.msg).join('; ') });
    const before = E.simulate(c0.spec, opt.stress || null).summary, after = E.simulate(c1.spec, P.stress ? mergeStress(opt.stress, P.stress) : opt.stress || null).summary;
    return Object.assign(P, { before, after, text: explain(P, before, after) });
  }
  function mergeStress(a, b) { if (!a) return b; return Object.assign({}, a, b, { name: a.name + ', ' + b.name, outages: (a.outages || []).concat(b.outages || []) }); }
  function explain(P, b, a) {
    const pct = v => Math.round(v * 1000) / 10 + '%', $ = v => '$' + v.toFixed(2), sec = v => (v >= 10 ? v.toFixed(0) : v.toFixed(2)) + ' s';
    const what = P.edits.map(e => e.text).concat(P.stress ? [P.stress.name] : []).join('; ');
    const dir = a.slo - b.slo > 0.005 ? 'rises' : b.slo - a.slo > 0.005 ? 'falls' : 'stays';
    let t = 'With ' + what + ': SLO attainment ' + dir + ' from ' + pct(b.slo) + (dir === 'stays' ? '' : ' to ' + pct(a.slo)) + ', TTFT p99 ' + sec(b.ttftP99) + ' → ' + sec(a.ttftP99) + ', serving cost ' + $(b.costPerHr) + ' → ' + $(a.costPerHr) + ' an hour';
    if (a.peakGpus !== b.peakGpus) t += ', peak GPUs ' + b.peakGpus + ' → ' + a.peakGpus;
    t += '.';
    if (P.notes && P.notes.length) t += ' Already the case, so unchanged: ' + P.notes.join('; ') + '.';
    const fb = b.bottleneck.first, fa = a.bottleneck.first;
    if (fa && (!fb || fa.id !== fb.id || fa.kind !== fb.kind)) t += ' The first bottleneck ' + (fb ? 'moves from ' + fb.name + ' (' + fb.label + ') to ' : 'is now ') + fa.name + ' (' + fa.label + ').';
    else if (!fa && fb) t += ' No bottleneck any more.';
    else if (fa) t += ' It still breaks first at ' + fa.name + ' (' + fa.label + ').';
    if (a.rejected > b.rejected) t += ' ' + (a.rejected - b.rejected) + ' more requests are rejected because their context no longer fits the KV cache.';
    if (a.lost > b.lost) t += ' ' + (a.lost - b.lost) + ' streams are cut mid-answer by the outage.';
    return t;
  }

  const api = { EXAMPLES, parse, answer, explain };
  if (node) module.exports = api; else root.FleetAsk = api;
})(typeof window !== 'undefined' ? window : this);
