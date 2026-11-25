// The whole pass: llm_call records → priced (list prices, recorded cost, or GPU time) → waste findings → a report
// that reads as a funnel: tokens processed → served from cache → processed at full price → avoidable, by cause; and
// dollars: total → avoidable → cost per successful task.
import { sessionsOf, fresh } from './record.mjs';
import { priceTable, priceCalls, DEFAULT_PRICES } from './prices.mjs';
import { engineRequests, replicaRates, joinGpu } from './gpu.mjs';
import { analyze, DEFAULTS } from './waste.mjs';

export const CAUSES = {
  'cache-miss': 'Context re-sent without a cache hit',
  'cache-expired': 'Cache expired during a pause',
  'cache-write-unread': 'Cache writes nobody read',
  'tool-output-bloat': 'Oversized tool output carried forward',
  'repeated-tool-call': 'Same tool call repeated',
  'error-loop': 'Retrying a failing tool',
  'failed-call': 'Failed model calls',
  'unused-tools': 'Tool definitions never used',
  'model-tier': 'Routing calls on a large model (candidate)',
};
export const FIXES = {
  'cache-miss': 'Keep the prompt prefix byte-stable: no timestamps or per-call IDs in the system prompt, a fixed tool order, append-only history; mark the prefix cacheable (cache_control) where the provider needs it.',
  'cache-expired': 'Use a longer cache lifetime (1-hour cache writes) for sessions with long tool runs or human pauses, or send a cheap keep-alive before the TTL lapses.',
  'cache-write-unread': 'Don\'t mark the last turn cacheable when nothing will follow it (one-shot subagents, final answers).',
  'tool-output-bloat': 'Cap or summarize tool output (head/tail, grep instead of cat, paginate), or have a subagent read it and return a summary.',
  'repeated-tool-call': 'Give the agent the earlier result (memoize read-only tools within a session) or tell it the state hasn\'t changed.',
  'error-loop': 'Stop after two identical failures and surface the error; fix the tool\'s error message so the model can act on it.',
  'failed-call': 'Look at the errors: oversized requests, rate limits and timeouts are often fixable in the harness configuration.',
  'unused-tools': 'Offer fewer tools per task (load MCP servers and tool groups on demand, use tool search).',
  'model-tier': 'Route short tool-selection steps to the cheaper model named in the price file; check task success before switching.',
};

const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const group = (xs, k) => { const m = new Map(); for (const x of xs) { const v = k(x); if (!m.has(v)) m.set(v, []); m.get(v).push(x); } return m; };

export function loadOutcomes(text) {
  if (!text) return new Map();
  try { const j = JSON.parse(text); return new Map(Array.isArray(j) ? j.map(r => [String(r.session), norm(r.outcome)]) : Object.entries(j).map(([k, v]) => [k, norm(v)])); }
  catch { return new Map(String(text).split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(',')).map(([s, o]) => [s.trim(), norm(o)])); }
}
const norm = v => (/^(1|true|pass|passed|ok|success|succeeded|resolved|done)$/i.test(String(v).trim()) ? 'success' : /^(0|false|fail|failed|failure|error|unresolved|abandoned)$/i.test(String(v).trim()) ? 'failure' : 'unknown');

export function ledger(calls, { prices = DEFAULT_PRICES, engineSpans = null, replicas = null, gpuPrices = {}, outcomes = new Map(), ...opts } = {}) {
  const table = priceTable(prices);
  let gpu = null, gpuPrice = new Map();
  if (engineSpans) {
    const reqs = engineRequests(engineSpans), j = joinGpu(calls, reqs, replicaRates(replicas || {}, gpuPrices));
    gpuPrice = j.prices; gpu = { requests: j.requests, matched: j.matched, priced: gpuPrice.size, replicas: j.replicas };
  }
  priceCalls(calls, table, gpuPrice);
  for (const c of calls) { const o = outcomes.get(c.session) || outcomes.get(c.parent) || c.outcome; if (o) c.outcome = o; }
  const findings = analyze(calls, opts);
  return { calls, findings, report: summarize(calls, findings, { table, gpu, opts: { ...DEFAULTS, ...opts } }) };
}

export function summarize(calls, findings, { table, gpu, opts } = {}) {
  const real = findings.filter(f => !f.candidate), cand = findings.filter(f => f.candidate);
  const priced = calls.filter(c => c.cost != null);
  const totals = { calls: calls.length, sessions: sessionsOf(calls).size, harnesses: [...new Set(calls.map(c => c.harness))],
    input: sum(calls, c => c.input), cacheRead: sum(calls, c => c.cacheRead), cacheWrite: sum(calls, c => c.cacheWrite), fresh: sum(calls, fresh), output: sum(calls, c => c.output),
    cost: sum(priced, c => c.cost), pricedCalls: priced.length, unpricedCalls: calls.length - priced.length,
    unpricedModels: [...new Set(calls.filter(c => c.cost == null).map(c => c.model || '(none)'))].slice(0, 12),
    cacheReported: calls.filter(c => c.cacheRead != null).length };
  totals.tokens = totals.input + totals.output;
  totals.avoidableTokens = sum(real, f => f.tokens); totals.avoidableFullPrice = sum(real, f => f.fullPrice); totals.avoidableCost = sum(real, f => f.cost); totals.candidateCost = sum(cand, f => f.cost);
  totals.avoidableShare = totals.cost > 0 ? totals.avoidableCost / totals.cost : null;
  const funnel = [
    { stage: 'Tokens processed', tokens: totals.tokens },
    { stage: 'Input served from cache', tokens: totals.cacheRead },
    { stage: 'Input processed at full price', tokens: totals.fresh + totals.cacheWrite },
    { stage: 'Output generated', tokens: totals.output },
    { stage: 'Avoidable work at full price', tokens: totals.avoidableFullPrice },
    { stage: 'Avoidable context re-read from cache', tokens: Math.max(0, totals.avoidableTokens - totals.avoidableFullPrice) },
  ];
  const byCause = [...group(findings, f => f.cause)].map(([cause, fs]) => ({ cause, label: CAUSES[cause] || cause, findings: fs.length, tokens: sum(fs, f => f.tokens), fullPrice: sum(fs, f => f.fullPrice), cost: sum(fs, f => f.cost),
    candidate: fs.every(f => f.candidate), fix: FIXES[cause], sessions: new Set(fs.map(f => `${f.harness}|${f.session}`)).size })).sort((a, b) => a.candidate - b.candidate || b.cost - a.cost || b.tokens - a.tokens);
  const outcomeOf = new Map([...sessionsOf(calls)].map(([k, cs]) => [k, (cs.find(c => c.outcome) || {}).outcome || 'unknown']));
  const harnessRows = [...group(calls, c => c.harness)].map(([harness, cs]) => {
    const fs = real.filter(f => f.harness === harness), sess = sessionsOf(cs), succ = [...sess.keys()].filter(k => outcomeOf.get(k) === 'success').length;
    const inTot = sum(cs, c => c.input), cr = sum(cs, c => c.cacheRead);
    return { harness, sessions: sess.size, calls: cs.length, tokens: inTot + sum(cs, c => c.output), cost: sum(cs, c => c.cost), avoidableCost: sum(fs, f => f.cost), avoidableTokens: sum(fs, f => f.tokens),
      cacheHit: cs.some(c => c.cacheRead != null) && inTot > 0 ? cr / inTot : null, successes: succ, costPerSuccess: succ ? sum(cs, c => c.cost) / succ : null,
      models: [...new Set(cs.map(c => c.model).filter(Boolean))].slice(0, 6) };
  }).sort((a, b) => b.cost - a.cost);
  const sessions = [...sessionsOf(calls)].map(([k, cs]) => {
    const fs = real.filter(f => `${f.harness}|${f.session}` === k), top = [...group(fs, f => f.cause)].map(([c, x]) => [c, sum(x, f => f.cost)]).sort((a, b) => b[1] - a[1])[0];
    return { harness: cs[0].harness, session: cs[0].session, agent: cs[0].agent, calls: cs.length, from: cs[0].t, to: cs.at(-1).t, tokens: sum(cs, c => c.input + c.output), cost: sum(cs, c => c.cost),
      avoidableCost: sum(fs, f => f.cost), avoidableTokens: sum(fs, f => f.tokens), topCause: top && top[0], outcome: outcomeOf.get(k) };
  }).sort((a, b) => b.avoidableCost - a.avoidableCost || b.avoidableTokens - a.avoidableTokens);
  const byTool = [...group(real.filter(f => f.tool), f => `${f.tool}|${f.cause}`)].map(([k, fs]) => ({ tool: fs[0].tool, cause: fs[0].cause, count: fs.length, tokens: sum(fs, f => f.tokens), cost: sum(fs, f => f.cost) }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const byModel = [...group(calls, c => c.model || '(none)')].map(([model, cs]) => ({ model, calls: cs.length, tokens: sum(cs, c => c.input + c.output), cost: cs.some(c => c.cost != null) ? sum(cs, c => c.cost) : null,
    cacheHit: sum(cs, c => c.input) > 0 && cs.some(c => c.cacheRead != null) ? sum(cs, c => c.cacheRead) / sum(cs, c => c.input) : null })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.tokens - a.tokens);
  const out = { succ: 0, fail: 0, unknown: 0, costSuccess: 0, costFailure: 0, costUnknown: 0 };
  for (const s of sessions) { const o = s.outcome === 'success' ? 'Success' : s.outcome === 'failure' ? 'Failure' : 'Unknown'; out[o === 'Success' ? 'succ' : o === 'Failure' ? 'fail' : 'unknown']++; out[`cost${o}`] += s.cost; }
  const outcomes = { successes: out.succ, failures: out.fail, unknown: out.unknown, costOnSuccess: out.costSuccess, costOnFailure: out.costFailure, costUnknown: out.costUnknown,
    costPerSuccess: out.succ ? totals.cost / out.succ : null, known: out.succ + out.fail > 0 };
  const top = real.slice().sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 25).map(f => ({ ...f, label: CAUSES[f.cause] }));
  return { totals, funnel, byCause, byHarness: harnessRows, byModel, byTool: byTool.slice(0, 20), sessions: sessions.slice(0, 30), outcomes, top, gpu,
    pricing: table ? { source: table.source, asOf: table.asOf, currency: table.currency } : null, settings: opts };
}

const fmtN = n => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const fmt$ = n => (n == null ? '–' : n >= 100 ? '$' + n.toFixed(0) : n >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toFixed(4) : '$0');
const pct = x => (x == null ? '–' : (100 * x).toFixed(x < 0.1 ? 1 : 0) + '%');
export { fmtN, fmt$, pct };

export function text(r) {
  const t = r.totals, L = [];
  L.push(`harness-ledger: ${t.calls} model calls in ${t.sessions} sessions from ${t.harnesses.join(', ') || 'no harness'}`);
  L.push(`  tokens ${fmtN(t.tokens)} (input ${fmtN(t.input)}, of which from cache ${fmtN(t.cacheRead)} = ${pct(t.input ? t.cacheRead / t.input : null)}; output ${fmtN(t.output)})`);
  L.push(`  cost ${fmt$(t.cost)} (${t.pricedCalls}/${t.calls} calls priced; ${r.pricing ? r.pricing.source : ''}${r.gpu ? `; ${r.gpu.priced} by GPU time` : ''})`);
  if (t.unpricedCalls) L.push(`  unpriced models: ${t.unpricedModels.join(', ')} (add them to --prices)`);
  L.push(`  avoidable ${fmt$(t.avoidableCost)}${t.avoidableShare != null ? ` (${pct(t.avoidableShare)} of cost)` : ''}: ${fmtN(t.avoidableFullPrice)} tokens of work at full price, ${fmtN(t.avoidableTokens - t.avoidableFullPrice)} of context re-read from cache${t.candidateCost ? `; plus ${fmt$(t.candidateCost)} in model-tier candidates` : ''}`);
  if (r.outcomes.known) L.push(`  outcomes: ${r.outcomes.successes} succeeded, ${r.outcomes.failures} failed (${fmt$(r.outcomes.costOnFailure)} spent on failed tasks); cost per successful task ${fmt$(r.outcomes.costPerSuccess)}`);
  L.push('', 'Where it goes, by cause:');
  L.push(`  ${'cost'.padStart(9)}  ${'full-price'.padStart(10)}  ${'re-read'.padStart(8)}  ${'count'.padStart(5)}`);
  for (const c of r.byCause) L.push(`  ${fmt$(c.cost).padStart(9)}  ${fmtN(c.fullPrice).padStart(10)}  ${fmtN(c.tokens - c.fullPrice).padStart(8)}  ${String(c.findings).padStart(5)}  ${c.label}`);
  if (!r.byCause.length) L.push('  nothing found');
  if (r.byHarness.length > 1) { L.push('', 'By harness:'); for (const h of r.byHarness) L.push(`  ${h.harness.padEnd(14)} ${String(h.sessions).padStart(4)} sessions  ${fmt$(h.cost).padStart(9)}  avoidable ${fmt$(h.avoidableCost).padStart(8)}  cache hit ${pct(h.cacheHit)}`); }
  if (r.byTool.length) { L.push('', 'Tools behind the waste:'); for (const x of r.byTool.slice(0, 8)) L.push(`  ${x.tool.padEnd(22)} ${x.cause.padEnd(20)} ${String(x.count).padStart(4)}×  ${fmtN(x.tokens).padStart(8)} tok  ${fmt$(x.cost)}`); }
  L.push('', 'Fix first:'); for (const c of r.byCause.filter(c => c.cost > 0 || c.tokens > 0).slice(0, 3)) L.push(`  ${c.label}: ${c.fix}`);
  return L.join('\n') + '\n';
}
