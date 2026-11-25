// A synthetic day of three harnesses, written in each harness's own log format so the demo runs the real importers:
// a Claude Code session with a subagent, a Codex CLI session, and a LangGraph-style agent traced with OpenTelemetry
// that calls a self-hosted model on vLLM (with the engine's request spans, for the GPU join).
// Every text field is a placeholder: no real prompts, code or tool output.
const T0 = Date.parse('2026-11-24T16:00:00Z') / 1000;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const iso = t => new Date(t * 1000).toISOString();
const pad = (n, ch = 'x') => ch.repeat(Math.max(0, Math.round(n))); // n characters of filler ≈ n/4 tokens

// ---------- Claude Code ----------
export function claudeCodeSession({ seed = 7 } = {}) {
  const r = rng(seed), L = [], sid = 'demo-cc-1';
  let t = T0, ctx = 18000, prevCtx = 0, n = 0;
  const assistant = ({ model = 'claude-sonnet-4-5-20250929', side = null, tools = [], read, write, inp = 3, out = 120 + Math.round(r() * 400) }) => {
    n++; const id = `msg_${side ? 's' : 'm'}${n}`;
    L.push({ type: 'assistant', sessionId: sid, isSidechain: !!side, agentId: side || undefined, uuid: `u${n}`, requestId: `req_${n}`, timestamp: iso(t),
      message: { id, model, role: 'assistant', stop_reason: tools.length ? 'tool_use' : 'end_turn',
        content: [{ type: 'text', text: 'placeholder' }, ...tools.map((tl, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: tl.name, input: tl.input }))],
        usage: { input_tokens: inp, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out } } });
    for (const [i, tl] of tools.entries()) L.push({ type: 'user', sessionId: sid, isSidechain: !!side, uuid: `r${n}_${i}`, timestamp: iso(t + 2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${n}_${i}`, content: pad(tl.result ?? 1200), is_error: !!tl.error }] } });
    return out;
  };
  const step = (o = {}) => {
    const resultChars = (o.tools || []).reduce((s, x) => s + (x.result ?? 1200), 0);
    const read = o.miss ? 0 : prevCtx, write = Math.max(0, ctx - read);
    const out = assistant({ ...o, read, write });
    prevCtx = ctx; ctx += out + resultChars / 4 + 40; t += o.pause || 6 + r() * 20;
  };
  for (let i = 1; i <= 30; i++) {
    const tools = [];
    if (i === 5) tools.push({ name: 'Read', input: { file_path: 'src/big-generated-file.json' }, result: 160000 });
    else if (i === 8 || i === 15) tools.push({ name: 'Grep', input: { pattern: 'TODO', path: 'src' }, result: 6000 });
    else if (i >= 22 && i <= 25) tools.push({ name: 'Bash', input: { command: 'npm test -- --grep flaky' }, result: 2400, error: true });
    else if (i < 30) tools.push({ name: ['Read', 'Edit', 'Bash', 'Glob'][i % 4], input: { n: i }, result: 800 + r() * 3000 });
    step({ tools, miss: i === 12 || i === 20, pause: i === 19 ? 420 : undefined });
    if (i === 10) { // a one-shot Explore subagent; its last call writes cache nobody reads
      const saved = [t, ctx, prevCtx]; ctx = 9000; prevCtx = 0;
      for (let k = 0; k < 4; k++) { const read = prevCtx, write = ctx - read; const out = assistant({ side: 'agent-explore-1', read, write, tools: k < 3 ? [{ name: 'Grep', input: { k } , result: 3000 }] : [] }); prevCtx = ctx; ctx += out + 800; t += 4; }
      [t, ctx, prevCtx] = [saved[0] + 20, saved[1] + 600, saved[2]];
    }
    if (i === 1 || i === 16) assistant({ model: 'claude-haiku-4-5-20251001', read: 0, write: 0, inp: 600, out: 12 }); // title / summary side calls
  }
  return L.map(x => JSON.stringify(x)).join('\n') + '\n';
}

// ---------- Codex ----------
export function codexSession({ seed = 11 } = {}) {
  const r = rng(seed), L = [], id = 'demo-codex-1';
  let t = T0 + 3600, ctx = 14000, cached = 0, total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  L.push({ timestamp: iso(t), type: 'session_meta', payload: { id, timestamp: iso(t), cwd: '/work/demo', originator: 'codex_cli_rs', cli_version: '0.164.0' } });
  L.push({ timestamp: iso(t), type: 'turn_context', payload: { model: 'gpt-5', cwd: '/work/demo' } });
  for (let i = 1; i <= 20; i++) {
    t += 8 + r() * 25;
    const cmd = i === 6 || i === 13 ? ['cat', 'package-lock.json'] : i === 9 ? ['rg', '--files'] : ['bash', '-lc', `step ${i}`];
    const out = 80 + Math.round(r() * 300), reasoning = Math.round(out * 0.6);
    const last = { input_tokens: ctx, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: reasoning, total_tokens: ctx + out };
    for (const k of Object.keys(total)) total[k] += last[k];
    if (i < 20) L.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: cmd }), call_id: `call_${i}` } });
    L.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 272000 } } });
    const resChars = cmd[1] === 'package-lock.json' ? 120000 : i === 9 ? 40000 : 1500 + r() * 4000;
    if (i < 20) L.push({ timestamp: iso(t + 3), type: 'response_item', payload: { type: 'function_call_output', call_id: `call_${i}`, output: JSON.stringify({ output: pad(resChars), metadata: { exit_code: 0 } }) } });
    cached = i === 15 ? 0 : Math.floor(ctx / 64) * 64;  // call 16 misses: the harness rewrote its instructions
    ctx += out + resChars / 4 + 30;
  }
  return L.map(x => JSON.stringify(x)).join('\n') + '\n';
}

// ---------- OTel (LangGraph-style agent → vLLM) ----------
const TOOLS = ['search_docs', 'get_ticket', 'update_ticket', 'run_sql', 'send_email', 'create_calendar_event', 'translate', 'summarize_pdf', 'web_fetch', 'get_weather', 'lookup_user', 'file_upload'];
export function otelAgent({ seed = 5, runs = 3 } = {}) {
  const r = rng(seed), spans = [], engine = [];
  const ns = s => String(BigInt(Math.round(s * 1e3)) * 1000000n);
  const kv = o => Object.entries(o).filter(([, v]) => v != null).map(([key, v]) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) } }));
  const defs = JSON.stringify(TOOLS.map(name => ({ type: 'function', name, description: pad(160, 'd'), parameters: { type: 'object', properties: { q: { type: 'string', description: pad(80, 'p') } } } })));
  let sp = 0; const id = () => (++sp).toString(16).padStart(16, '0');
  for (let run = 0; run < runs; run++) {
    const traceId = (run + 1).toString(16).padStart(32, 'a'), conv = `support-thread-${run + 1}`, root = id();
    let t = T0 + 7200 + run * 1800, ctx = 2500 + estDefs(defs), prev = 0;
    const steps = 6 + Math.floor(r() * 4), start = t;
    for (let k = 0; k < steps; k++) {
      const chat = id(), out = 60 + Math.round(r() * 200), prefill = ctx / 9000, decode = out / 45, queue = 0.02 + r() * 0.2, e2e = queue + prefill + decode;
      const cachedTok = k === 0 ? 0 : run === 2 && k === 3 ? 0 : Math.floor(prev / 16) * 16;
      spans.push({ traceId, spanId: chat, parentSpanId: root, name: 'chat llama-3.3-70b', kind: 3, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + e2e + 0.01),
        attributes: kv({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'vllm', 'gen_ai.request.model': 'llama-3.3-70b', 'gen_ai.response.model': 'llama-3.3-70b', 'gen_ai.conversation.id': conv,
          'gen_ai.usage.input_tokens': ctx, 'gen_ai.usage.cache_read.input_tokens': cachedTok, 'gen_ai.usage.output_tokens': out, 'gen_ai.tool.definitions': defs }) });
      engine.push({ traceId, spanId: id(), parentSpanId: chat, name: 'llm_request', startTimeUnixNano: ns(t + 0.005), endTimeUnixNano: ns(t + 0.005 + e2e),
        attributes: kv({ 'gen_ai.request.model': 'llama-3.3-70b', 'gen_ai.usage.prompt_tokens': ctx, 'gen_ai.usage.completion_tokens': out, 'gen_ai.latency.time_in_queue': queue,
          'gen_ai.latency.time_to_first_token': queue + prefill, 'gen_ai.latency.e2e': e2e, 'gen_ai.latency.time_in_model_prefill': prefill, 'gen_ai.latency.time_in_model_decode': decode,
          'k8s.pod.name': run % 2 ? 'vllm-llama70b-1' : 'vllm-llama70b-0' }) });
      t += e2e + 0.02;
      if (k < steps - 1) {
        const name = ['search_docs', 'get_ticket', 'update_ticket'][k % 3], big = run === 1 && k === 1, fail = run === 0 && k >= 2 && k <= 5;
        const tool = fail ? 'run_sql' : name, res = big ? 60000 : 1600 + r() * 2000, dur = 0.3 + r() * 1.5;
        spans.push({ traceId, spanId: id(), parentSpanId: root, name: `execute_tool ${tool}`, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + dur), status: fail ? { code: 2 } : {},
          attributes: kv({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool, 'gen_ai.tool.call.id': `tc_${run}_${k}`, 'gen_ai.tool.call.arguments': fail ? '{"q":"select broken"}' : `{"q":"${k}"}`,
            'gen_ai.tool.call.result': pad(res), 'error.type': fail ? 'tool_error' : null }) });
        t += dur; prev = ctx; ctx += out + res / 4 + 20;
      }
    }
    spans.push({ traceId, spanId: root, name: 'invoke_agent support-agent', startTimeUnixNano: ns(start), endTimeUnixNano: ns(t), attributes: kv({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support-agent', 'gen_ai.conversation.id': conv }) });
  }
  const body = s => ({ resourceSpans: [{ resource: { attributes: kv({ 'service.name': s.svc }) }, scopeSpans: [{ scope: { name: s.scope }, spans: s.spans }] }] });
  return { harness: body({ svc: 'langgraph-support', scope: 'opentelemetry.instrumentation.langchain', spans }), engine: body({ svc: 'vllm', scope: 'vllm', spans: engine }),
    replicas: { 'vllm-llama70b-0': { gpus: 4, gpuType: 'H100', rate: 2.5 }, 'vllm-llama70b-1': { gpus: 4, gpuType: 'H100', rate: 2.5 } },
    outcomes: { 'support-thread-1': 'failure', 'support-thread-2': 'success', 'support-thread-3': 'success' } };
}
const estDefs = d => Math.ceil(d.length / 4);

export function demoInputs() {
  const o = otelAgent();
  return { files: [{ name: 'claude-code/demo-cc-1.jsonl', text: claudeCodeSession() }, { name: 'codex/rollout-2026-11-24T17-00-00-demo-codex-1.jsonl', text: codexSession() },
    { name: 'otel/langgraph-support.json', text: JSON.stringify(o.harness) }], engine: o.engine, replicas: o.replicas,
    outcomes: { ...o.outcomes, 'demo-cc-1': 'success', 'demo-codex-1': 'success' } };
}
