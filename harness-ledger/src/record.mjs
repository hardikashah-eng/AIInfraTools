// The llm_call record: one model request made by an agent harness, whatever harness made it.
//
//   { kind: 'llm_call', t (epoch s), harness ('claude-code'|'codex'|'otel'|'openinference'|'langfuse'|…),
//     session, agent? (subagent or agent name), parent? (parent session), id (dedupe key), traceId?, spanId?,
//     model?, provider?,
//     input   total input tokens, cached ones included (the OpenTelemetry GenAI meaning of gen_ai.usage.input_tokens)
//     cacheRead, cacheWrite   parts of input served from / written to the provider's prompt cache (null = not reported)
//     output, reasoning?      output tokens; reasoning is part of output when the provider reports it
//     toolsOffered?  [names]  tool definitions sent with the request (null = the harness doesn't log them)
//     toolDefTokens?          estimated tokens of those definitions
//     toolCalls  [{ name, id?, argHash?, resultTokens?, error? }]  tools the response asked for, with what came back
//     finish?, error?, durS?, costUSD? (when the harness recorded a cost), outcome? ('success'|'failure') }
//
// Records hold counts, names and hashes only. No prompt, completion, argument or tool-result text is kept: the
// importers read transcripts that can hold anything, and what they write out has to be safe to share.
import { createHash } from 'node:crypto';

export const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const hash = s => createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s ?? null)).digest('hex').slice(0, 16);
// A rough token count for text we don't have a tokenizer for: about 4 characters per token for English and code.
export const estTokens = v => { if (v == null) return 0; const s = typeof v === 'string' ? v : JSON.stringify(v); return Math.ceil(s.length / 4); };
export const toSec = v => {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return Number(v[0]) + Number(v[1] || 0) / 1e9;          // [seconds, nanos] (OTel JS hrtime)
  if (typeof v === 'number') return v > 1e17 ? v / 1e9 : v > 1e14 ? v / 1e6 : v > 1e11 ? v / 1e3 : v; // ns, µs, ms or s
  if (/^\d+$/.test(String(v))) return toSec(Number(v));
  const t = Date.parse(v); return Number.isFinite(t) ? t / 1000 : null;
};
export const fresh = c => Math.max(0, (c.input || 0) - (c.cacheRead || 0) - (c.cacheWrite || 0));

export function call(o) {
  const r = { kind: 'llm_call', t: o.t, harness: o.harness, session: o.session ?? 'unknown', id: o.id, model: o.model ?? null,
    input: o.input || 0, cacheRead: o.cacheRead ?? null, cacheWrite: o.cacheWrite ?? null, output: o.output || 0, toolCalls: o.toolCalls || [] };
  for (const k of ['agent', 'parent', 'traceId', 'spanId', 'provider', 'reasoning', 'toolsOffered', 'toolDefTokens', 'finish', 'error', 'durS', 'costUSD', 'outcome', 'source'])
    if (o[k] != null && o[k] !== '') r[k] = o[k];
  return r;
}

// One record per id; later lines of the same response replace earlier ones (Claude Code writes a line per content
// block, each repeating the response's usage).
export function dedupe(calls) {
  const by = new Map();
  for (const c of calls) {
    const k = `${c.harness}|${c.session}|${c.id}`, prev = by.get(k);
    if (!prev) { by.set(k, c); continue; }
    const tools = [...prev.toolCalls]; for (const tc of c.toolCalls) if (!tools.some(x => x.id && x.id === tc.id)) tools.push(tc);
    by.set(k, { ...prev, ...c, t: Math.min(prev.t, c.t), output: Math.max(prev.output, c.output), toolCalls: tools });
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

export const sessionsOf = calls => { const m = new Map(); for (const c of calls) { const k = `${c.harness}|${c.session}`; if (!m.has(k)) m.set(k, []); m.get(k).push(c); } for (const v of m.values()) v.sort((a, b) => a.t - b.t); return m; };
