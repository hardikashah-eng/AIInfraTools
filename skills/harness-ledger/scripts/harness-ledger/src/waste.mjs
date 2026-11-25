// Where a harness wastes model resources. Each check reads priced llm_call records of one session and returns
// findings: { cause, harness, session, agent, model, at (call id), t, tokens, cost, note, detail }.
//
// fullPrice  the part of tokens processed at full price (prefilled, or generated); the rest is context re-read from
//            the prompt cache, cheap per token but still occupying the context window and KV cache
// tokens  model work that needn't have happened: input processed at full price that a prompt cache should have
//         served (that's prefill compute on a self-hosted model), tool output beyond what the agent needed, carried
//         through every later call, repeated calls, retries of failing calls.
// cost    what that work cost at the call's own prices (list prices, the harness's recorded cost, or GPU time).
//
// The causes:
//   cache-miss       the next call re-sent the previous call's context without reading it from cache: the prefix
//                    changed (a timestamp or reordered tools in the system prompt, edited history, a parameter or
//                    tool-set switch) or the harness didn't mark it cacheable
//   cache-expired    the same, after a pause longer than the cache's lifetime (a slow tool, a human away)
//   cache-write-unread  tokens written to cache (billed at a premium) that no later call read
//   tool-output-bloat   a tool result far larger than a summary would be, re-sent in every later call
//   repeated-tool-call  the same tool with the same arguments again in one session (sometimes deliberate: a test
//                    re-run after an edit; the report shows which tools so it can be judged)
//   error-loop       three or more calls in a row whose tool calls all failed, with the same tool
//   failed-call      a model call that errored but still used tokens
//   unused-tools     tool definitions sent with every call that the session never used
//   model-tier       (candidate) a short routing call on a large model whose price file names a cheaper model to try,
//                    counted only where it saves money even after the cheaper model re-reads the context uncached
//
// Causes can overlap on one call (a bloated tool result re-sent uncached); a call's findings are scaled so their cost
// never exceeds what the call cost.
import { sessionsOf, fresh } from './record.mjs';
import { costWith } from './prices.mjs';

export const DEFAULTS = { cacheTtlS: 300, minMissTokens: 1024, missTolerance: 0.02, compaction: 0.5, bigResultTokens: 8000, keepResultTokens: 1500,
  loopMin: 3, tierMaxOutput: 300, repeatWindow: 25, repeatIgnore: /todo|plan|task|think|ask|question|exit/i };

const priceOf = c => c.price || { in: 0, read: 0, write: 0, out: 0 };
const isCompaction = (prev, cur, o) => cur.input < prev.input * (1 - o.compaction);

export function analyzeSession(calls, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, out = [];
  const base = c => ({ harness: c.harness, session: c.session, agent: c.agent || 'main', model: c.model, at: c.id, t: c.t });
  // chains: consecutive calls of one model (side calls on other models — titles, summaries — run their own chain)
  const chains = new Map(); for (const c of calls) { const k = c.model || '?'; if (!chains.has(k)) chains.set(k, []); chains.get(k).push(c); }
  const carriedAfter = new Map(); // call → how many later calls in its chain carry its context (until compaction)
  for (const chain of chains.values()) {
    for (let i = 0; i < chain.length; i++) {
      let k = 0; for (let j = i + 1; j < chain.length; j++) { if (isCompaction(chain[j - 1], chain[j], o)) break; k++; }
      carriedAfter.set(chain[i], k);
    }
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1], cur = chain[i];
      if (cur.cacheRead == null || prev.error || cur.error || isCompaction(prev, cur, o)) continue;
      const prefix = Math.min(prev.input, cur.input), missed = prefix - (cur.cacheRead || 0);
      if (missed < Math.max(o.minMissTokens, o.missTolerance * prefix)) continue;
      const p = priceOf(cur), w = Math.min(missed, cur.cacheWrite || 0), cost = Math.max(0, w * p.write + (missed - w) * p.in - missed * p.read);
      const gap = cur.t - prev.t, expired = gap > o.cacheTtlS;
      out.push({ ...base(cur), cause: expired ? 'cache-expired' : 'cache-miss', tokens: missed, fullPrice: missed, cost,
        note: expired ? `${Math.round(gap)} s after the previous call; the cache lasts ~${o.cacheTtlS} s` : `${Math.round(100 * (cur.cacheRead || 0) / prefix)}% of the previous context came from cache`,
        detail: { prefix, cacheRead: cur.cacheRead || 0, gapS: gap } });
    }
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i], p = priceOf(c);
      if (!(c.cacheWrite > 0) || !(p.write > p.in)) continue;
      const next = chain.slice(i + 1).find(n => n.t - c.t <= o.cacheTtlS && (n.cacheRead || 0) > 0);
      if (next) continue;
      out.push({ ...base(c), cause: 'cache-write-unread', tokens: 0, fullPrice: 0, cost: c.cacheWrite * (p.write - p.in),
        note: i === chain.length - 1 ? 'last call of the session wrote to cache' : 'nothing read it before it expired', detail: { cacheWrite: c.cacheWrite } });
    }
  }
  // tools: bloat, repeats, error loops
  const seen = [], used = new Set();
  calls.forEach((c, i) => {
    const p = priceOf(c), k = carriedAfter.get(c) || 0, laterPrice = c.cacheRead != null ? p.read : p.in;
    for (const tc of c.toolCalls) {
      used.add(tc.name);
      if (tc.resultTokens > o.bigResultTokens) {
        const excess = tc.resultTokens - o.keepResultTokens;
        out.push({ ...base(c), cause: 'tool-output-bloat', tool: tc.name, tokens: excess * (1 + k), fullPrice: c.cacheRead != null ? excess : excess * (1 + k), cost: excess * p.in + excess * k * laterPrice,
          note: `${tc.name} returned ~${Math.round(tc.resultTokens / 1000)}k tokens, carried through ${k} later call${k === 1 ? '' : 's'}`, detail: { resultTokens: tc.resultTokens, carried: k } });
      }
      if (tc.argHash && !o.repeatIgnore.test(tc.name)) {
        const prior = seen.slice(-o.repeatWindow).find(s => s.name === tc.name && s.argHash === tc.argHash && !s.error);
        if (prior) {
          const res = tc.resultTokens || 0, outShare = (c.output || 0) / Math.max(1, c.toolCalls.length);
          out.push({ ...base(c), cause: 'repeated-tool-call', tool: tc.name, tokens: res * (1 + k) + outShare, fullPrice: (c.cacheRead != null ? res : res * (1 + k)) + outShare, cost: res * p.in + res * k * laterPrice + outShare * p.out,
            note: `${tc.name} called again with the same arguments`, detail: { resultTokens: res, carried: k } });
        }
      }
      seen.push(tc);
    }
    if (c.error && (c.input || c.output)) out.push({ ...base(c), cause: 'failed-call', tokens: c.input + c.output, fullPrice: fresh(c) + c.output, cost: c.cost || 0, note: `call failed: ${c.error}` });
  });
  // error loops: runs of calls whose tool calls all failed, same tool
  for (let i = 0; i < calls.length;) {
    const failing = c => c.toolCalls.length > 0 && c.toolCalls.every(t => t.error);
    if (!failing(calls[i])) { i++; continue; }
    const tool = calls[i].toolCalls[0].name; let j = i;
    while (j < calls.length && failing(calls[j]) && calls[j].toolCalls[0].name === tool) j++;
    if (j - i >= o.loopMin) for (const c of calls.slice(i + 2, j))
      out.push({ ...base(c), cause: 'error-loop', tool, tokens: (c.input || 0) + (c.output || 0), fullPrice: fresh(c) + (c.output || 0), cost: c.cost || 0, note: `${j - i} calls in a row with ${tool} failing` });
    i = j;
  }
  // unused tool definitions
  for (const c of calls) {
    if (!c.toolsOffered || !c.toolsOffered.length || !c.toolDefTokens) continue;
    const unused = c.toolsOffered.filter(n => !used.has(n)); if (!unused.length) continue;
    const tokens = c.toolDefTokens * unused.length / c.toolsOffered.length, p = priceOf(c);
    const cached = (c.cacheRead || 0) > tokens;
    out.push({ ...base(c), cause: 'unused-tools', tokens, fullPrice: cached ? 0 : tokens, cost: tokens * (cached ? p.read : p.in),
      note: `${unused.length} of ${c.toolsOffered.length} tools never used in this session`, detail: { unused: unused.slice(0, 20) } });
  }
  // model tier candidates
  for (const c of calls) {
    if (!c.downshift || !c.cheaper || c.error || (c.output || 0) > o.tierMaxOutput || c.toolCalls.length !== 1 || (c.reasoning || 0) > 0) continue;
    // a prompt cache belongs to one model: on the cheaper model the whole context is prefilled again
    const save = (c.cost || 0) - (costWith({ ...c, cacheRead: 0, cacheWrite: 0 }, c.cheaper) || 0);
    if (save > 0) out.push({ ...base(c), cause: 'model-tier', tokens: 0, fullPrice: 0, cost: save, note: `short ${c.toolCalls[0].name} routing call; try ${c.downshift}`, candidate: true });
  }
  // a call's findings never cost more than the call
  const byCall = new Map(); for (const f of out) { const k = f.at; if (!byCall.has(k)) byCall.set(k, []); byCall.get(k).push(f); }
  const byId = new Map(calls.map(c => [c.id, c]));
  for (const [k, fs] of byCall) {
    const c = byId.get(k), real = fs.filter(f => !f.candidate);
    const cap = c && c.cost, sum = real.reduce((s, f) => s + f.cost, 0); if (cap != null && sum > cap && sum > 0) for (const f of real) f.cost *= cap / sum;
    // tokens: a later call carries a result forward, so bloat and repeats can exceed this call's own tokens; only
    // the overlap between causes on the same call's own input is capped
    const own = c ? (c.input || 0) + (c.output || 0) : Infinity, inCall = real.filter(f => f.cause.startsWith('cache') || f.cause === 'failed-call' || f.cause === 'error-loop' || f.cause === 'unused-tools');
    const ts = inCall.reduce((s, f) => s + f.tokens, 0); if (ts > own && ts > 0) for (const f of inCall) { f.tokens *= own / ts; f.fullPrice *= own / ts; }
  }
  return out;
}

export function analyze(calls, opts = {}) {
  const findings = [];
  for (const sess of sessionsOf(calls).values()) findings.push(...analyzeSession(sess, opts));
  return findings;
}
export { fresh };
