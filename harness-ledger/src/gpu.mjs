// Self-hosted models: what a harness's call cost in GPU time, from the serving engine's own trace.
//
// The join: harness call → engine request → replica → GPUs → $/GPU-hour.
//   1. Engine request spans. vLLM with --otlp-traces-endpoint writes one span per request (named llm_request) with
//      gen_ai.latency.time_in_queue / time_to_first_token / e2e / time_in_model_prefill / time_in_model_decode and
//      gen_ai.usage.* tokens. Any engine span carrying gen_ai.latency.e2e is read the same way.
//   2. Matching. When the harness propagates W3C trace context to the engine (OTel HTTP client instrumentation does),
//      the engine span's parent is the harness's chat span: match on that. Otherwise match within the trace by time
//      (the engine request that started closest after the call started).
//   3. Replicas. --replicas maps a pod or service name to { gpus, gpuType?, rate? ($/GPU-h) }, or gpu-ledger usage
//      records are given; a missing rate comes from gpu-ledger's rate card (--gpu-prices, gpu-ledger's format).
//   4. Allocation. A replica's GPU cost while it was busy (the union of its requests' intervals) is split across
//      those requests by their time in the model (prefill + decode; e2e when the split is missing). Time the replica
//      was up between requests is idle cost, reported per replica (gpu-ledger's idle class), not charged to a harness.
//   5. Per-token prices for the waste checks: prefill cost spread over the tokens prefilled (fresh input; prefix-cache
//      hits cost ~nothing), decode cost over the output tokens.
import { flattenSpans } from './importers.mjs';
import { num } from './record.mjs';
import { rateCard, priceOf, gpuKey } from '../../gpu-ledger/src/core.mjs';

export function engineRequests(input) {
  const out = [];
  for (const s of flattenSpans(input)) {
    const a = s.attrs, e2e = num(a['gen_ai.latency.e2e']);
    if (e2e == null && s.name !== 'llm_request') continue;
    out.push({ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, t: s.t, e2e: e2e ?? (s.end - s.t),
      prefill: num(a['gen_ai.latency.time_in_model_prefill']), decode: num(a['gen_ai.latency.time_in_model_decode']), queue: num(a['gen_ai.latency.time_in_queue']),
      replica: a['k8s.pod.name'] || a['host.name'] || a['server.address'] || s.service || 'engine', model: a['gen_ai.response.model'] || a['gen_ai.request.model'],
      isl: num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens']), osl: num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens']),
      cached: num(a['gen_ai.usage.cache_read.input_tokens']) });
  }
  return out;
}

// replicas: { name: { gpus, gpuType?, rate? } } or gpu-ledger usage records [{ name|id|labels.pod, gpus, gpuType, rate? }]
export function replicaRates(replicas, gpuPrices = {}) {
  const card = rateCard(gpuPrices), out = new Map();
  const add = (name, r) => {
    const rate = r.rate ?? (r.gpuType ? (priceOf(card, gpuPrices, gpuKey(r.gpuType), r.provider) || {}).rate : null);
    if (name && r.gpus) out.set(String(name), { gpus: Number(r.gpus), gpuType: r.gpuType, rate: rate ?? null });
  };
  if (Array.isArray(replicas)) for (const r of replicas) add(r.name || (r.labels && r.labels.pod) || r.id, r);
  else for (const [k, v] of Object.entries(replicas || {})) add(k, v);
  return out;
}

export function joinGpu(calls, requests, rates) {
  const bySpan = new Map(requests.filter(r => r.parentSpanId).map(r => [r.parentSpanId, r])), used = new Set(), match = new Map();
  for (const c of calls) { const r = c.spanId && bySpan.get(c.spanId); if (r) { match.set(c, r); used.add(r); } }
  for (const c of calls) {
    if (match.has(c) || !c.traceId) continue;
    const r = requests.filter(x => x.traceId === c.traceId && !used.has(x) && x.t >= c.t - 1).sort((x, y) => x.t - y.t)[0];
    if (r) { match.set(c, r); used.add(r); }
  }
  // Each replica's cost while it was serving (the union of its requests' intervals) is split across those requests by
  // their time in the model; batching makes requests overlap, so they share the busy time. The rest of the window the
  // replica was up but idle: reported per replica, not charged to any harness.
  const byRep = new Map(); for (const r of requests) { if (!byRep.has(r.replica)) byRep.set(r.replica, []); byRep.get(r.replica).push(r); }
  const alloc = new Map(), replicas = [];
  for (const [rep, rs] of byRep) {
    const rr = rates.get(rep), from = Math.min(...rs.map(r => r.t)), to = Math.max(...rs.map(r => r.t + (r.e2e || 0)));
    const iv = rs.map(r => [r.t, r.t + (r.e2e || 0)]).sort((a, b) => a[0] - b[0]); let busyS = 0, cur = null;
    for (const [a, b] of iv) { if (!cur || a > cur[1]) { if (cur) busyS += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); } if (cur) busyS += cur[1] - cur[0];
    const windowS = Math.max(busyS, to - from), w = r => ((r.prefill ?? 0) + (r.decode ?? 0)) || r.e2e || 0, W = rs.reduce((s, r) => s + w(r), 0) || 1;
    const perS = rr && rr.rate != null ? rr.gpus * rr.rate / 3600 : null, busyCost = perS != null ? perS * busyS : null;
    replicas.push({ replica: rep, gpus: rr ? rr.gpus : null, gpuType: rr && rr.gpuType, rate: rr && rr.rate, windowS, busyS, busyShare: windowS > 0 ? busyS / windowS : null,
      requests: rs.length, busyCost, idleCost: perS != null ? perS * (windowS - busyS) : null, priced: perS != null });
    for (const r of rs) alloc.set(r, { cost: busyCost != null ? busyCost * w(r) / W : null, gpuS: rr ? rr.gpus * busyS * w(r) / W : null });
  }
  const prices = new Map();
  for (const [c, r] of match) {
    const a = alloc.get(r); c.engine = { replica: r.replica, e2e: r.e2e, prefill: r.prefill, decode: r.decode, queue: r.queue, gpuS: a.gpuS };
    if (a.cost == null) continue;
    const pf = r.prefill != null && r.decode != null && r.prefill + r.decode > 0 ? r.prefill / (r.prefill + r.decode) : 0.5;
    const freshT = Math.max(1, (c.input || 0) - (c.cacheRead || 0)); // prefilled tokens: everything not served from the prefix cache
    const pin = a.cost * pf / freshT, pout = a.cost * (1 - pf) / Math.max(1, c.output || 0);
    prices.set(c, { in: pin, read: 0, write: pin, out: pout, source: `GPU time on ${r.replica}`, total: a.cost });
  }
  return { prices, matched: match.size, requests: requests.length, replicas };
}
