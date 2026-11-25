// Harness logs → llm_call records. One importer per harness; the waste checks downstream only see llm_call.
//
//   claudeCode   Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl, subagents/agent-*.jsonl)
//   codex        Codex CLI / IDE rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
//   otel         OpenTelemetry GenAI spans and OpenInference spans (OTLP JSON, or one span per line): any harness
//                instrumented with OTel (Copilot, Gemini CLI, Claude Code's telemetry, LangGraph, OpenAI Agents SDK,
//                CrewAI, LlamaIndex, Strands, Pydantic AI…)
//   langfuse     Langfuse observation exports (GENERATION, TOOL, AGENT observations)
//
// Token meanings differ by source; every importer converts to llm_call's (input includes cached tokens):
//   Anthropic usage (Claude Code): input_tokens excludes cache reads and writes → input = sum of the three.
//   Codex (OpenAI): input_tokens includes cached_input_tokens.
//   OTel GenAI: gen_ai.usage.input_tokens SHOULD include cache_read/cache_write; OpenInference: llm.token_count.prompt
//   includes prompt_details.cache_read/cache_write.
//   Langfuse: canonical usage keys are exclusive (input + input_cached_tokens + input_cache_creation); OpenAI-style
//   prompt_tokens is inclusive.
import { call, dedupe, num, hash, estTokens, toSec } from './record.mjs';

const lines = text => { const out = []; for (const l of String(text).split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* partial line while the harness writes */ } } return out; };
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x && (x.text ?? x.content ?? (x.type === 'image' ? '[image]' : JSON.stringify(x))))).join('') : c == null ? '' : JSON.stringify(c));

// ---------- Claude Code ----------
export function claudeCode(text, { file } = {}) {
  const out = [], byToolId = new Map();
  for (const o of lines(text)) {
    const m = o.message || {};
    if (o.type === 'assistant' && m.usage && m.model !== '<synthetic>') {
      const u = m.usage, cr = num(u.cache_read_input_tokens), cw = num(u.cache_creation_input_tokens);
      const sid = o.sessionId || (file && file.replace(/^.*[\\/]|\.jsonl$/g, '')) || 'unknown';
      const side = o.isSidechain ? (o.agentId || 'subagent') : null;
      const toolCalls = (Array.isArray(m.content) ? m.content : []).filter(b => b && b.type === 'tool_use').map(b => {
        const tc = { name: b.name, id: b.id, argHash: hash(b.input) }; if (b.id) byToolId.set(b.id, tc); return tc; });
      out.push(call({ t: toSec(o.timestamp), harness: 'claude-code', session: side ? `${sid}:${side}` : sid, parent: side ? sid : null, agent: side || 'main',
        id: `${m.id || o.uuid}|${o.requestId || ''}`, model: m.model, provider: 'anthropic',
        input: (num(u.input_tokens) || 0) + (cr || 0) + (cw || 0), cacheRead: cr ?? 0, cacheWrite: cw ?? 0, output: num(u.output_tokens) || 0,
        toolCalls, finish: m.stop_reason, costUSD: num(o.costUSD), source: 'claude-code-jsonl' }));
    } else if (o.type === 'assistant' && o.isApiErrorMessage) {
      out.push(call({ t: toSec(o.timestamp), harness: 'claude-code', session: o.sessionId || 'unknown', id: o.uuid, model: null, error: 'api_error', agent: o.isSidechain ? (o.agentId || 'subagent') : 'main', source: 'claude-code-jsonl' }));
    } else if (o.type === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === 'tool_result') {
        const tc = byToolId.get(b.tool_use_id); if (!tc) continue;
        tc.resultTokens = estTokens(textOf(b.content)); if (b.is_error) tc.error = true;
      }
    }
  }
  return dedupe(out);
}

// ---------- Codex ----------
const CODEX_TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call']);
const CODEX_OUTPUT_ITEMS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_call_output']);
function codexToolError(output) {
  let o = output; if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return /\b(exit code|exit_code)[:= ]+[1-9]/i.test(output) ? true : undefined; } }
  if (o && typeof o === 'object') { if (o.success === false) return true; const ec = o.metadata && o.metadata.exit_code; if (ec != null && Number(ec) !== 0) return true; }
  return undefined;
}
export function codex(text, { file } = {}) {
  const rows = lines(text);
  let session = (file && (file.match(/rollout-[\dT:-]+-(.+)\.jsonl$/) || [])[1]) || null, parent = null, sub = false, model = null;
  const out = [], byCallId = new Map(); let pending = [], prevTotal = null;
  const hasRecords = rows.some(o => o.type === 'token_usage_record');
  const emit = (t, id, u, extra = {}) => {
    out.push(call({ t, harness: 'codex', session: session || 'unknown', parent, agent: sub ? 'subagent' : 'main', id, model: extra.model || model, provider: 'openai',
      input: num(u.input_tokens) || 0, cacheRead: num(u.cached_input_tokens) ?? 0, cacheWrite: num(u.cache_creation_input_tokens) ?? 0, output: num(u.output_tokens) || 0,
      reasoning: num(u.reasoning_output_tokens), toolCalls: pending, source: 'codex-rollout' }));
    pending = [];
  };
  for (const o of rows) {
    const p = o.payload || {}, t = toSec(o.timestamp);
    if (o.type === 'session_meta') {
      session = p.id || session; const sp = p.source && p.source.subagent && p.source.subagent.thread_spawn;
      sub = !!(p.source && p.source.subagent); parent = (sp && sp.parent_thread_id) || p.forked_from_id || parent;
    } else if (o.type === 'turn_context') model = p.model || model;
    else if (o.type === 'response_item' && CODEX_TOOL_ITEMS.has(p.type)) {
      const tc = { name: p.name || p.type, id: p.call_id || p.id, argHash: hash(p.arguments ?? p.input ?? p.action ?? null) };
      if (tc.id) byCallId.set(tc.id, tc); pending.push(tc);
    } else if (o.type === 'response_item' && CODEX_OUTPUT_ITEMS.has(p.type)) {
      const tc = byCallId.get(p.call_id); if (!tc) continue;
      const res = p.output && typeof p.output === 'object' && 'content' in p.output ? p.output.content : p.output;
      tc.resultTokens = estTokens(textOf(res)); if (codexToolError(p.output)) tc.error = true;
    } else if (o.type === 'token_usage_record' && hasRecords) {
      if (p.thread_id && session && p.thread_id !== session) continue; // lines a fork copied from its parent
      emit(t, p.response_id || `${t}`, p.usage || {}, { model: p.model });
    } else if (o.type === 'event_msg' && p.type === 'token_count' && !hasRecords) {
      const info = p.info || {}, last = info.last_token_usage, total = info.total_token_usage;
      if (!last) continue;
      const tot = total ? `${total.input_tokens}|${total.output_tokens}` : null;
      if (tot && tot === prevTotal) continue;                  // the same snapshot repeated
      if (prevTotal == null && parent && total && last.input_tokens === total.input_tokens && last.output_tokens === total.output_tokens && pending.length === 0 && out.length === 0 && rows.some(r => r.type === 'session_meta' && r.payload && r.payload.forked_from_id)) { prevTotal = tot; continue; } // a fork's inherited history
      prevTotal = tot; emit(t, tot || `${t}`, last, { model: info.model });
    }
  }
  return dedupe(out);
}

// ---------- OpenTelemetry GenAI / OpenInference ----------
const anyVal = v => (v == null ? null : 'stringValue' in v ? v.stringValue : 'intValue' in v ? Number(v.intValue) : 'doubleValue' in v ? v.doubleValue : 'boolValue' in v ? v.boolValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(anyVal) : 'kvlistValue' in v ? Object.fromEntries((v.kvlistValue.values || []).map(x => [x.key, anyVal(x.value)])) : null);
const attrsOf = a => (Array.isArray(a) ? Object.fromEntries(a.map(x => [x.key, anyVal(x.value)])) : a || {});
// OTLP JSON bodies, arrays of spans, or one span per line → flat spans
export function flattenSpans(input) {
  const docs = typeof input === 'string' ? (() => { try { return [JSON.parse(input)]; } catch { return lines(input); } })() : Array.isArray(input) ? input : [input];
  const out = [];
  const flat = (sp, res = {}) => {
    const a = attrsOf(sp.attributes);
    const t = toSec(sp.startTimeUnixNano ?? sp.startTime ?? sp.start_time ?? sp.timestamp), end = toSec(sp.endTimeUnixNano ?? sp.endTime ?? sp.end_time);
    const st = sp.status || {}; const code = st.code ?? st.status_code;
    out.push({ traceId: sp.traceId || sp.trace_id || (sp.context && sp.context.trace_id), spanId: sp.spanId || sp.span_id || (sp.context && sp.context.span_id),
      parentSpanId: sp.parentSpanId || sp.parent_span_id || sp.parentId || null, name: sp.name, t: t ?? end, end: end ?? t, attrs: a, service: res['service.name'],
      error: code === 2 || code === 'STATUS_CODE_ERROR' || code === 'ERROR' || a['error.type'] != null });
  };
  for (const d of docs.flat()) {
    if (!d || typeof d !== 'object') continue;
    if (d.resourceSpans) for (const rs of d.resourceSpans) { const res = attrsOf((rs.resource || {}).attributes); for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) for (const sp of ss.spans || []) flat(sp, res); }
    else if (d.spans) for (const sp of d.spans) flat(sp, attrsOf((d.resource || {}).attributes));
    else if (d.name || d.attributes) flat(d, attrsOf((d.resource || {}).attributes));
  }
  return out.filter(s => s.traceId && s.spanId && s.t != null);
}

const LLM_OPS = new Set(['chat', 'text_completion', 'generate_content', 'responses', 'completion']);
const isLLM = a => LLM_OPS.has(a['gen_ai.operation.name']) || a['openinference.span.kind'] === 'LLM';
const isTool = a => a['gen_ai.operation.name'] === 'execute_tool' || a['openinference.span.kind'] === 'TOOL';
const isAgent = a => a['gen_ai.operation.name'] === 'invoke_agent' || a['gen_ai.operation.name'] === 'create_agent' || a['openinference.span.kind'] === 'AGENT';
function toolDefs(a) {
  let defs = a['gen_ai.tool.definitions'];
  if (typeof defs === 'string') { try { defs = JSON.parse(defs); } catch { defs = null; } }
  if (Array.isArray(defs)) return { names: defs.map(d => d && (d.name || (d.function && d.function.name))).filter(Boolean), tokens: estTokens(defs) };
  const names = [], schemas = [];                           // OpenInference: llm.tools.<i>.tool.name / .tool.json_schema
  for (const [k, v] of Object.entries(a)) { const m = k.match(/^llm\.tools\.(\d+)\.tool\.(name|json_schema)$/); if (!m) continue;
    if (m[2] === 'name') names[m[1]] = v; else { schemas[m[1]] = v; if (names[m[1]] == null) { try { const j = JSON.parse(v); names[m[1]] = j.name || (j.function && j.function.name); } catch { /* not JSON */ } } } }
  return names.length ? { names: names.filter(Boolean), tokens: schemas.length ? estTokens(schemas.join('')) : null } : null;
}
export function otel(input, { harness } = {}) {
  const spans = flattenSpans(input), byId = new Map(spans.map(s => [s.spanId, s]));
  const agentOf = s => { for (let p = s, i = 0; p && i < 50; p = byId.get(p.parentSpanId), i++) { const n = p.attrs['gen_ai.agent.name'] || p.attrs['agent.name']; if (n && (isAgent(p.attrs) || p === s)) return n; } return null; };
  const calls = [], byTrace = new Map();
  for (const s of spans.filter(x => isLLM(x.attrs))) {
    const a = s.attrs, oi = a['openinference.span.kind'] === 'LLM' && a['gen_ai.usage.input_tokens'] == null;
    const g = k => num(a[k]);
    const input = oi ? g('llm.token_count.prompt') : g('gen_ai.usage.input_tokens') ?? g('gen_ai.usage.prompt_tokens');
    const cacheRead = oi ? g('llm.token_count.prompt_details.cache_read') : g('gen_ai.usage.cache_read.input_tokens') ?? g('gen_ai.usage.cache_read_input_tokens');
    const cacheWrite = oi ? g('llm.token_count.prompt_details.cache_write') : g('gen_ai.usage.cache_write.input_tokens') ?? g('gen_ai.usage.cache_creation.input_tokens') ?? g('gen_ai.usage.cache_creation_input_tokens');
    const defs = toolDefs(a), fr = a['gen_ai.response.finish_reasons'];
    const c = call({ t: s.t, harness: harness || s.service || (oi ? 'openinference' : 'otel'), session: a['gen_ai.conversation.id'] || a['session.id'] || s.traceId,
      agent: agentOf(s), id: s.spanId, traceId: s.traceId, spanId: s.spanId, model: a['gen_ai.response.model'] || a['gen_ai.request.model'] || a['llm.model_name'],
      provider: a['gen_ai.provider.name'] || a['gen_ai.system'] || a['llm.provider'], input: input || 0, cacheRead, cacheWrite,
      output: (oi ? g('llm.token_count.completion') : g('gen_ai.usage.output_tokens') ?? g('gen_ai.usage.completion_tokens')) || 0,
      reasoning: oi ? g('llm.token_count.completion_details.reasoning') : g('gen_ai.usage.reasoning.output_tokens'),
      toolsOffered: defs && defs.names, toolDefTokens: defs && defs.tokens, finish: Array.isArray(fr) ? fr.join(',') : fr,
      error: s.error ? (a['error.type'] || 'error') : null, durS: s.end != null && s.t != null ? s.end - s.t : null, costUSD: g('llm.cost.total'), source: oi ? 'openinference' : 'otel-genai' });
    calls.push(c); if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []); byTrace.get(s.traceId).push({ s, c });
  }
  // A tool span belongs to the latest model call in its trace that ended before it started (the call that asked for it).
  for (const s of spans.filter(x => isTool(x.attrs)).sort((x, y) => x.t - y.t)) {
    const a = s.attrs, cands = (byTrace.get(s.traceId) || []).filter(x => x.s.end <= s.t + 1e-6);
    if (!cands.length) continue;
    const owner = cands.reduce((b, x) => (x.s.end > b.s.end ? x : b)).c;
    const result = a['gen_ai.tool.call.result'] ?? a['output.value'];
    const tc = { name: a['gen_ai.tool.name'] || a['tool.name'] || s.name, id: a['gen_ai.tool.call.id'] || a['tool_call.id'] || s.spanId,
      argHash: hash(a['gen_ai.tool.call.arguments'] ?? a['input.value'] ?? a['tool.parameters'] ?? null) };
    if (result != null) tc.resultTokens = estTokens(result);
    if (s.error) tc.error = true;
    owner.toolCalls.push(tc);
  }
  return dedupe(calls);
}

// ---------- Langfuse ----------
function langfuseUsage(o) {
  const d = o.usageDetails || o.usage_details || {}, u = o.usage || {};
  const g = (...ks) => { for (const k of ks) { const v = num(d[k] ?? u[k]); if (v != null) return v; } return null; };
  const cacheRead = g('input_cached_tokens', 'cache_read_input_tokens', 'input_cache_read', 'cached_tokens', 'input_cached') ?? 0;
  const cacheWrite = g('input_cache_creation', 'cache_creation_input_tokens', 'input_cache_write', 'cache_write_tokens') ?? 0;
  const inclusive = g('prompt_tokens', 'promptTokens');
  const input = inclusive != null ? inclusive : (g('input') || 0) + cacheRead + cacheWrite;
  return { input, cacheRead, cacheWrite, output: g('output', 'completion_tokens', 'completionTokens') || 0, reasoning: g('output_reasoning_tokens', 'output_reasoning', 'reasoning_tokens') };
}
export function langfuse(input, { harness = 'langfuse' } = {}) {
  let docs = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return lines(input); } })() : input;
  if (docs && !Array.isArray(docs)) docs = docs.data || docs.observations || [docs];
  const obs = [];
  for (const d of docs.flat()) { if (!d) continue; if (Array.isArray(d.observations)) for (const o of d.observations) obs.push({ ...o, sessionId: o.sessionId ?? d.sessionId, traceId: o.traceId ?? d.id }); else obs.push(d); }
  const calls = [], gens = obs.filter(o => o.type === 'GENERATION').map(o => {
    const u = langfuseUsage(o), t = toSec(o.startTime), end = toSec(o.endTime) ?? t;
    const toolCalls = (((o.output && (o.output.tool_calls || o.output.toolCalls)) || [])).map(tc => ({ name: tc.name || (tc.function && tc.function.name), id: tc.id, argHash: hash(tc.arguments || (tc.function && tc.function.arguments) || null) }));
    const tools = (o.modelParameters && o.modelParameters.tools) || (o.input && o.input.tools);
    const c = call({ t, harness: (o.metadata && o.metadata.harness) || harness, session: o.sessionId || o.traceId, id: o.id, traceId: o.traceId, model: o.model || o.providedModelName,
      ...u, toolCalls, toolsOffered: Array.isArray(tools) ? tools.map(x => x.name || (x.function && x.function.name)).filter(Boolean) : null, toolDefTokens: Array.isArray(tools) ? estTokens(tools) : null,
      error: o.level === 'ERROR' ? (o.statusMessage ? 'error' : 'error') : null, durS: end != null && t != null ? end - t : null,
      costUSD: num(o.calculatedTotalCost ?? (o.costDetails && o.costDetails.total) ?? o.totalCost), agent: o.agentName || null, source: 'langfuse' });
    calls.push(c); return { o, c, end };
  });
  for (const o of obs.filter(x => x.type === 'TOOL').sort((x, y) => toSec(x.startTime) - toSec(y.startTime))) {
    const t = toSec(o.startTime), cands = gens.filter(g => g.o.traceId === o.traceId && g.end <= t + 1e-6);
    if (!cands.length) continue;
    const owner = cands.reduce((b, x) => (x.end > b.end ? x : b)).c;
    const existing = owner.toolCalls.find(x => x.name === o.name && x.resultTokens == null);
    const tc = existing || { name: o.name, id: o.id, argHash: hash(o.input ?? null) };
    if (o.output != null) tc.resultTokens = estTokens(o.output); if (o.level === 'ERROR') tc.error = true;
    if (!existing) owner.toolCalls.push(tc);
  }
  return dedupe(calls);
}

// Which importer reads this file? By name first, then by content.
export function detect(text, file = '') {
  if (/rollout-.*\.jsonl$/.test(file)) return 'codex';
  const head = String(text).slice(0, 20000);
  if (/"resourceSpans"|"gen_ai\.|"openinference\.span\.kind"|"llm\.token_count\./.test(head)) return 'otel';
  if (/"type"\s*:\s*"(session_meta|turn_context|event_msg|response_item)"/.test(head)) return 'codex';
  if (/"sessionId"\s*:/.test(head) && /"type"\s*:\s*"(assistant|user|summary|system)"/.test(head)) return 'claude-code';
  if (/"type"\s*:\s*"GENERATION"|"usageDetails"/.test(head)) return 'langfuse';
  return null;
}
export const IMPORTERS = { 'claude-code': claudeCode, codex, otel, openinference: otel, langfuse };
export function importText(text, { kind, file, harness } = {}) {
  const k = kind || detect(text, file); const f = IMPORTERS[k];
  if (!f) throw new Error(`can't tell what ${file || 'this input'} is; pass --format ${Object.keys(IMPORTERS).join('|')}`);
  return f(text, { file, harness });
}
