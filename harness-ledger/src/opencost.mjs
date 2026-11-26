// What self-hosting costs per token, measured: OpenCost's inference cost tracking (INFERENCE_COST_ENABLED=true) for vLLM
// and llm-d deployments. Two sources, same numbers:
//   REST    GET <opencost>/inferenceCost/total?window=7d&aggregate=model_name,namespace&costBasis=allocation
//           → data.inferenceCosts["<model>:<namespace>"] { inputCostPerMillionTokens, outputCostPerMillionTokens,
//             cacheSavingsFraction, promptTokens, generationTokens, totalCost, allocationMethod, costBasis }
//   Prometheus  llm_cost_per_million_tokens{phase="prompt"|"generation", cost_basis, model_name, namespace} and
//           llm_cache_savings_fraction{model_name, namespace}
// The allocation basis (the default) includes idle and shared infrastructure and reconciles to the bill.
//
// OpenCost's prompt price is per delivered input token (cached ones included), so it already carries that model's own
// cache hit rate. Applied to a workload whose cache hit rate differs, it is turned into a price per prefilled token:
// prompt price / (1 − cacheSavingsFraction), charged on the workload's fresh input only (cache hits cost ~no compute).

export function fromRest(json, { model = null, namespace = null } = {}) {
  const d = (json && json.data) || json || {}, costs = d.inferenceCosts || (Array.isArray(d.inferenceCostSets) && d.inferenceCostSets.at(-1) && d.inferenceCostSets.at(-1).inferenceCosts) || {};
  const rows = Object.entries(costs).map(([key, v]) => {
    const [m, ns] = key.includes(':') ? [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)] : [key, null];
    return { key, model: (v.properties && v.properties.modelName) || m, namespace: (v.properties && v.properties.namespace) || ns, costBasis: v.costBasis || 'allocation', input: v.inputCostPerMillionTokens, output: v.outputCostPerMillionTokens,
      blended: v.costPerMillionTokens, cacheSavings: v.cacheSavingsFraction ?? null, promptTokens: v.promptTokens, generationTokens: v.generationTokens, totalCost: v.totalCost, allocationMethod: v.allocationMethod || '' };
  });
  return pick(rows, { model, namespace });
}

function pick(rows, { model, namespace }) {
  const match = r => (!model || r.model === model || String(r.model).split('/').pop() === String(model).split('/').pop()) && (!namespace || r.namespace === namespace);
  const ok = rows.filter(r => match(r) && Number.isFinite(r.input) && Number.isFinite(r.output) && (r.input > 0 || r.output > 0));
  if (!ok.length) {
    const zero = rows.filter(match);
    throw new Error(zero.length ? `OpenCost has ${zero.map(r => r.key).join(', ')} but no cost on it (allocationMethod "${zero[0].allocationMethod}"): check the pod's model label matches vLLM's model_name` : `no OpenCost inference cost${model ? ` for ${model}` : ''}${namespace ? ` in ${namespace}` : ''}; have: ${rows.map(r => r.key).join(', ') || 'nothing'}`);
  }
  if (ok.length > 1 && !model) throw new Error(`OpenCost has several models (${ok.map(r => r.key).join(', ')}): pass --opencost-model`);
  // several namespaces of one model: token-weighted
  if (ok.length === 1) return ok[0];
  const w = r => (r.promptTokens || 0) + (r.generationTokens || 0) || 1, W = ok.reduce((a, r) => a + w(r), 0);
  const avg = k => ok.reduce((a, r) => a + (r[k] ?? 0) * w(r), 0) / W;
  return { key: ok.map(r => r.key).join('+'), model: ok[0].model, namespace: ok.map(r => r.namespace).join(','), costBasis: ok[0].costBasis, input: avg('input'), output: avg('output'), cacheSavings: avg('cacheSavings'), allocationMethod: ok[0].allocationMethod };
}

// Prometheus instant queries (the gauges OpenCost exports every collection interval; averaged over `window`)
export async function fromPrometheus(prom, { model = null, namespace = null, costBasis = 'allocation', window = '24h', fetcher = fetch, headers } = {}) {
  const sel = [`cost_basis="${costBasis}"`, model ? `model_name="${String(model).replace(/"/g, '')}"` : null, namespace ? `namespace="${String(namespace).replace(/"/g, '')}"` : null].filter(Boolean).join(',');
  const q = async expr => { const r = await fetcher(`${prom.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(expr)}`, { headers }); if (!r.ok) throw new Error(`prometheus: HTTP ${r.status}`); const j = await r.json(); if (j.status !== 'success') throw new Error(`prometheus: ${j.error || j.status}`); return j.data.result; };
  const price = await q(`avg_over_time(llm_cost_per_million_tokens{${sel},phase=~"prompt|generation"}[${window}])`);
  const cache = await q(`avg_over_time(llm_cache_savings_fraction{${sel.replace(/cost_basis="[^"]*",?/, '')}}[${window}])`);
  const rows = new Map();
  for (const s of price) { const k = `${s.metric.model_name}:${s.metric.namespace}`; if (!rows.has(k)) rows.set(k, { key: k, model: s.metric.model_name, namespace: s.metric.namespace, costBasis, allocationMethod: s.metric.allocation_method || '' }); rows.get(k)[s.metric.phase === 'prompt' ? 'input' : 'output'] = +s.value[1]; }
  for (const s of cache) { const r = rows.get(`${s.metric.model_name}:${s.metric.namespace}`); if (r) r.cacheSavings = +s.value[1]; }
  return pick([...rows.values()], { model, namespace });
}

// → economics' selfHostPrice: $ per million fresh (prefilled) input tokens, cache reads free, output as measured
export function toSelfHostPrice(r) {
  const f = Number.isFinite(r.cacheSavings) ? Math.min(0.99, Math.max(0, r.cacheSavings)) : 0;
  return { input: r.input / (1 - f), cacheRead: 0, output: r.output, source: `OpenCost ${r.costBasis} cost for ${r.model}${r.namespace ? ` in ${r.namespace}` : ''} (${r.allocationMethod || 'split unknown'}; its own cache hit ${(100 * f).toFixed(0)}%)`, opencost: r };
}
