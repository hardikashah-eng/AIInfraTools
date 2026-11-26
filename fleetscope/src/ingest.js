/* FleetScope trace ingest: turns real request logs into canonical trace rows.
   Canonical row: { t, isl, osl, cached?, ttft?, queue?, e2e?, session? }
     t        arrival, seconds from the first request
     isl/osl  prompt and output tokens (isl includes cached tokens)
     cached   prompt tokens served from a prefix cache, when the log records it
     ttft/queue/e2e  recorded latencies in seconds, used to compare with the simulation
     session  user or session id, when the log records one
     agent    subagent id within a session (agentic traces), gap  seconds since the session's previous request ended
   Only timing and token counts are read; prompt and response text are never touched. */
(function (root) {
  'use strict';

  const LIMITS = { maxRows: 40000, maxSeconds: 1800 };

  // ---------- time parsing ----------
  // Numbers: seconds, or milliseconds / microseconds / nanoseconds since the epoch by magnitude.
  function toSeconds(v, unitHint) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()))) {
      let x = +v;
      if (unitHint === 'ms') return x / 1e3;
      if (unitHint === 'us') return x / 1e6;
      if (unitHint === 'ns') return x / 1e9;
      if (x > 1e17) return x / 1e9;
      if (x > 1e14) return x / 1e6;
      if (x > 1e11) return x / 1e3;
      return x;
    }
    let iso = String(v).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(iso)) iso += 'Z';
    return Date.parse(iso) / 1000;
  }
  // Durations: seconds unless the key says ms.
  function toDuration(v, key) {
    if (v == null || v === '') return NaN;
    const x = +v;
    if (!isFinite(x)) return NaN;
    return /_?ms$|millis/i.test(key || '') ? x / 1000 : x;
  }
  const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  function first(o, paths) {
    for (const p of paths) { const v = get(o, p); if (v != null && v !== '') return { v, p }; }
    return null;
  }

  // ---------- finishing: sort, rebase to t = 0, apply limits ----------
  function finish(rows, format, notes, opt) {
    opt = Object.assign({}, LIMITS, opt || {});
    const bad = rows.filter(r => !isFinite(r.t) || !(r.isl > 0) || !(r.osl > 0)).length;
    let ok = rows.filter(r => isFinite(r.t) && r.isl > 0 && r.osl > 0);
    if (!ok.length) throw new Error('No usable requests found: each needs an arrival time, prompt tokens and output tokens.');
    ok.sort((a, b) => a.t - b.t);
    const t0 = ok[0].t + (opt.startOffsetS || 0);
    const trace = [];
    for (const r of ok) {
      const t = r.t - t0;
      if (t < 0) continue;
      if (t > opt.maxSeconds) { notes.push('kept the first ' + Math.round(opt.maxSeconds / 60) + ' minutes'); break; }
      if (trace.length >= opt.maxRows) { notes.push('kept the first ' + opt.maxRows.toLocaleString('en-US') + ' requests'); break; }
      const row = { t, isl: Math.min(Math.round(r.isl), opt.maxIsl || 200000), osl: Math.max(1, Math.min(Math.round(r.osl), opt.maxOsl || 16000)) };
      if (isFinite(r.cached) && r.cached >= 0) row.cached = Math.min(Math.round(r.cached), row.isl - 1);
      if (isFinite(r.ttft) && r.ttft >= 0) row.ttft = r.ttft;
      if (isFinite(r.queue) && r.queue >= 0) row.queue = r.queue;
      if (isFinite(r.e2e) && r.e2e >= 0) row.e2e = r.e2e;
      if (r.session != null && r.session !== '') row.session = String(r.session);
      if (r.agent != null && r.agent !== '') row.agent = String(r.agent);
      if (isFinite(r.api) && r.api >= 0) row.api = r.api;
      if (isFinite(r.tools)) row.tools = r.tools;
      trace.push(row);
    }
    if (bad) notes.push(bad + ' unreadable record' + (bad > 1 ? 's' : '') + ' skipped');
    const stats = {
      requests: trace.length,
      seconds: trace.length ? trace[trace.length - 1].t : 0,
      withCached: trace.filter(r => r.cached != null).length,
      withTtft: trace.filter(r => r.ttft != null).length,
      sessions: new Set(trace.filter(r => r.session != null).map(r => r.session)).size
    };
    return { trace, format, notes, stats };
  }

  // ---------- CSV ----------
  function splitCsvLine(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }
  const CSV_COLS = {
    t: ['timestamp', 'arrival_ts', 'arrival', 'arrival_time', 'time', 't', 'ts', 'timestamp_ms', 'arrival_ms', 'start_time', 'starttime'],
    isl: ['contexttokens', 'context_tokens', 'input_tokens', 'isl', 'prompt_tokens', 'input_len', 'num_prompt_tokens'],
    osl: ['generatedtokens', 'generated_tokens', 'output_tokens', 'osl', 'completion_tokens', 'output_len', 'num_output_tokens'],
    cached: ['cached_tokens', 'cache_read_tokens', 'cached_prompt_tokens'],
    ttft: ['ttft_s', 'ttft', 'ttft_ms', 'time_to_first_token'],
    queue: ['queue_s', 'queue_time', 'queue_ms', 'time_in_queue'],
    e2e: ['e2e_s', 'e2e', 'latency_s', 'latency', 'latency_ms', 'e2e_ms'],
    session: ['session', 'session_id', 'user', 'user_id', 'conversation_id']
  };
  function parseCSV(text, opt) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) throw new Error('The file has no data rows.');
    const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
    const col = {};
    for (const k in CSV_COLS) col[k] = head.findIndex(h => CSV_COLS[k].includes(h));
    if (col.t < 0 || col.isl < 0 || col.osl < 0) {
      throw new Error('Columns not found. The CSV needs timestamp, input-token and output-token columns, e.g. TIMESTAMP, ContextTokens, GeneratedTokens (Azure trace format) or timestamp, input_tokens, output_tokens.');
    }
    const tUnit = /ms$/.test(head[col.t]) ? 'ms' : null;
    const rows = [];
    for (let k = 1; k < lines.length; k++) {
      const c = splitCsvLine(lines[k]);
      const at = i => (i >= 0 ? c[i] : undefined);
      rows.push({
        t: toSeconds(at(col.t), tUnit), isl: +at(col.isl), osl: +at(col.osl),
        cached: col.cached >= 0 && at(col.cached) !== '' && at(col.cached) != null ? +at(col.cached) : NaN,
        ttft: col.ttft >= 0 ? toDuration(at(col.ttft), head[col.ttft]) : NaN,
        queue: col.queue >= 0 ? toDuration(at(col.queue), head[col.queue]) : NaN,
        e2e: col.e2e >= 0 ? toDuration(at(col.e2e), head[col.e2e]) : NaN,
        session: col.session >= 0 ? at(col.session) : null
      });
    }
    const azure = head.includes('contexttokens');
    return finish(rows, azure ? 'Azure trace CSV' : 'CSV', [], opt);
  }

  // ---------- OpenTelemetry spans (vLLM --otlp-traces-endpoint) ----------
  const VLLM = {
    prompt: 'gen_ai.usage.prompt_tokens', completion: 'gen_ai.usage.completion_tokens',
    queue: 'gen_ai.latency.time_in_queue', ttft: 'gen_ai.latency.time_to_first_token', e2e: 'gen_ai.latency.e2e',
    id: 'gen_ai.request.id'
  };
  function otlpValue(v) {
    if (v == null) return undefined;
    if ('intValue' in v) return +v.intValue;
    if ('doubleValue' in v) return +v.doubleValue;
    if ('stringValue' in v) return v.stringValue;
    if ('boolValue' in v) return v.boolValue;
    return undefined;
  }
  function spanRow(attrs, startS, endS) {
    const p = +attrs[VLLM.prompt], c = +attrs[VLLM.completion];
    if (!(p > 0)) return null;
    return { t: startS, isl: p, osl: c, ttft: toDuration(attrs[VLLM.ttft]), queue: toDuration(attrs[VLLM.queue]),
      e2e: isFinite(+attrs[VLLM.e2e]) ? +attrs[VLLM.e2e] : (isFinite(endS) ? endS - startS : NaN),
      cached: NaN, session: attrs['gen_ai.conversation.id'] || attrs['session.id'] || null };
  }
  // OTLP JSON: collector file exporter (one ExportTraceServiceRequest per line) or a single document; also Tempo "batches".
  function parseOTLP(docs, opt) {
    const rows = [];
    for (const d of docs) {
      const groups = d.resourceSpans || d.batches || [];
      for (const rs of groups) for (const ss of (rs.scopeSpans || rs.instrumentationLibrarySpans || [])) for (const s of (ss.spans || [])) {
        const attrs = {};
        for (const a of s.attributes || []) attrs[a.key] = otlpValue(a.value);
        const r = spanRow(attrs, toSeconds(s.startTimeUnixNano, 'ns'), toSeconds(s.endTimeUnixNano, 'ns'));
        if (r) rows.push(r);
      }
    }
    if (!rows.length) throw new Error('No vLLM request spans found: expected spans with gen_ai.usage.prompt_tokens. Start vLLM with --otlp-traces-endpoint and export from the collector.');
    return finish(rows, 'vLLM OpenTelemetry spans (OTLP JSON)', [], opt);
  }
  // Jaeger UI / API JSON: { data: [ { spans: [ { startTime (µs), duration (µs), tags: [{key, value}] } ] } ] }
  function parseJaeger(doc, opt) {
    const rows = [];
    for (const tr of doc.data || []) for (const s of tr.spans || []) {
      const attrs = {};
      for (const t of s.tags || []) attrs[t.key] = t.value;
      const st = toSeconds(s.startTime, 'us');
      const r = spanRow(attrs, st, st + (+s.duration || 0) / 1e6);
      if (r) rows.push(r);
    }
    if (!rows.length) throw new Error('No vLLM request spans found in this Jaeger export (no gen_ai.usage.prompt_tokens tags).');
    return finish(rows, 'vLLM spans (Jaeger JSON)', [], opt);
  }

  // ---------- gateway logs (JSON lines or a JSON array of records) ----------
  const G = {
    t: ['startTime', 'start_time', 'request_start', 'timestamp', 'created_at', 'created', 'time', '@timestamp', 'ts', 'request_time'],
    first: ['completionStartTime', 'completion_start_time', 'first_token_time'],
    end: ['endTime', 'end_time', 'completed_at'],
    prompt: ['usage.prompt_tokens', 'prompt_tokens', 'response.usage.prompt_tokens', 'usage.input_tokens', 'input_tokens', 'response.usage.input_tokens', 'metrics.prompt_tokens'],
    completion: ['usage.completion_tokens', 'completion_tokens', 'response.usage.completion_tokens', 'usage.output_tokens', 'output_tokens', 'response.usage.output_tokens', 'metrics.completion_tokens'],
    openaiCached: ['usage.prompt_tokens_details.cached_tokens', 'prompt_tokens_details.cached_tokens', 'response.usage.prompt_tokens_details.cached_tokens', 'cached_tokens'],
    anthropicRead: ['usage.cache_read_input_tokens', 'cache_read_input_tokens', 'response.usage.cache_read_input_tokens'],
    anthropicWrite: ['usage.cache_creation_input_tokens', 'cache_creation_input_tokens', 'response.usage.cache_creation_input_tokens'],
    ttft: ['ttft', 'ttft_s', 'ttft_ms', 'time_to_first_token', 'metrics.ttft_ms', 'metrics.time_to_first_token'],
    e2e: ['latency', 'latency_s', 'latency_ms', 'duration', 'duration_ms', 'request_duration_ms', 'metrics.latency_ms'],
    session: ['session_id', 'metadata.session_id', 'conversation_id', 'metadata.conversation_id', 'end_user', 'user', 'metadata.user_api_key_user_id', 'user_id']
  };
  function gatewayRow(o) {
    const ts = first(o, G.t);
    const p = first(o, G.prompt), c = first(o, G.completion);
    if (!ts || !p || !c) return null;
    const t = toSeconds(ts.v, /_ms$/.test(ts.p) ? 'ms' : null);
    let isl = +p.v, cached = NaN;
    const oc = first(o, G.openaiCached);
    const ar = first(o, G.anthropicRead), aw = first(o, G.anthropicWrite);
    if (/input_tokens$/.test(p.p) && (ar || aw)) {
      // Anthropic-style usage: input_tokens excludes cache reads and writes.
      isl += (ar ? +ar.v : 0) + (aw ? +aw.v : 0);
      cached = ar ? +ar.v : 0;
    } else if (oc) cached = +oc.v;
    const fr = first(o, G.first), en = first(o, G.end);
    let ttft = NaN, e2e = NaN;
    if (fr) ttft = toSeconds(fr.v) - t;
    else { const x = first(o, G.ttft); if (x) ttft = toDuration(x.v, x.p); }
    if (en) e2e = toSeconds(en.v) - t;
    else { const x = first(o, G.e2e); if (x) e2e = toDuration(x.v, x.p); }
    const s = first(o, G.session);
    return { t, isl, osl: +c.v, cached, ttft, queue: NaN, e2e, session: s ? s.v : null };
  }
  function parseGateway(records, opt) {
    const rows = [];
    let skipped = 0;
    for (const o of records) { const r = gatewayRow(o); if (r) rows.push(r); else skipped++; }
    if (!rows.length) throw new Error('No request records recognised. Each JSON record needs a start time (startTime, timestamp, created…) and token usage (usage.prompt_tokens / usage.completion_tokens, or input_tokens / output_tokens).');
    const out = finish(rows, 'Gateway JSON logs', [], opt);
    if (skipped) out.notes.push(skipped + ' record' + (skipped > 1 ? 's' : '') + ' without timing or token usage skipped');
    return out;
  }

  // ---------- agentic traces ----------
  // Prefix reuse from block hashes: each request lists the hashes of its prompt's fixed-size blocks, chained so a block's
  // hash depends on everything before it. The cached part of a request is the longest run of leading blocks some earlier
  // request in the same scope already had: what an unbounded prefix cache would serve. scope 'session' (AgentX: hashes are
  // session-scoped) or 'global' (Mooncake: one hash space for the whole trace).
  function prefixReuse(rows, blockTokens, scope) {
    const seen = new Map();
    for (const r of rows) {
      const key = scope === 'global' ? '' : (r.session || ''), set = seen.get(key) || new Set();
      seen.set(key, set);
      let n = 0; const h = r.hashes || [];
      while (n < h.length && set.has(h[n])) n++;
      for (const x of h) set.add(x);
      r.cached = Math.min(r.isl, n * blockTokens);
      delete r.hashes;
    }
    return rows;
  }
  // SemiAnalysis AgentX ("weka" traces, Apache-2.0): one JSON object per session { id, requests: [ { t, type, model, in,
  // out, hash_ids, api_time, think_time? } | { type: 'subagent', agent_id, requests: [...] } ] }; t in seconds from the
  // session start; in = 64-token hash blocks × 64. Sessions are laid end to end unless opt.sessionGapS spaces them.
  function parseAgentX(docs, opt) {
    opt = opt || {};
    const rows = [];
    let offset = 0;
    const sessions = docs.map(d => (Array.isArray(d) ? { id: null, requests: d } : d)).filter(d => d && Array.isArray(d.requests));
    sessions.forEach((d, i) => {
      const id = String(d.id != null ? d.id : 'session-' + i), start = offset;
      let end = start;
      const add = (q, agent) => {
        const t = start + (+q.t || 0), api = +q.api_time || 0;
        rows.push({ t, isl: +q.in || 0, osl: +q.out || 1, session: id, agent, api, hashes: q.hash_ids || [], e2e: api || NaN });
        end = Math.max(end, t + api);
      };
      for (const q of d.requests) {
        if (q && q.type === 'subagent') for (const x of q.requests || []) add(x, String(q.agent_id || 'subagent'));
        else if (q) add(q, null);
      }
      offset = opt.sessionGapS != null ? start + opt.sessionGapS : end;
    });
    rows.sort((a, b) => a.t - b.t);
    prefixReuse(rows, opt.blockTokens || 64, 'session');
    const out = finish(rows, 'AgentX agentic trace', [], Object.assign({ maxIsl: 2e6, maxOsl: 64000 }, opt));
    out.stats.sessions = sessions.length;
    out.notes.push('cached tokens: what an unbounded prefix cache would serve, from 64-token block hashes (within a session)');
    return out;
  }
  // Mooncake (Kimi) traces: one request per line { timestamp (ms), input_length, output_length, hash_ids } with 512-token
  // blocks in one hash space.
  function parseMooncake(docs, opt) {
    opt = opt || {};
    const rows = docs.filter(d => d && d.input_length != null).map(d => ({ t: (+d.timestamp || 0) / 1000, isl: +d.input_length, osl: +d.output_length || 1, hashes: d.hash_ids || [] }));
    rows.sort((a, b) => a.t - b.t);
    prefixReuse(rows, opt.blockTokens || 512, 'global');
    const out = finish(rows, 'Mooncake trace', [], Object.assign({ maxIsl: 2e6 }, opt));
    out.notes.push('cached tokens: what an unbounded prefix cache would serve, from 512-token block hashes');
    return out;
  }
  // TraceLab (UW SyFI coding-agent trace, CC BY 4.0): one model call per line, from Claude Code and Codex, with the
  // provider's own cache accounting, timing events and tool calls.
  function tracelabRow(o) {
    const ev = o.timing_events || [], ts = ev.map(e => toSeconds(e.timestamp)).filter(isFinite);
    if (!ts.length) return null;
    const isClaude = o.claude_cache_read_input_tokens != null || o.provider === 'claude';
    const cached = isClaude ? (+o.claude_cache_read_input_tokens || 0) : (+o.prefix_tokens || 0);
    // the call starts at its input (user message or last tool result) and ends at its last model event
    const inEv = ev.filter(e => /user_message|tool_result/.test(e.event_type)).map(e => toSeconds(e.timestamp)).filter(isFinite);
    const outEv = ev.filter(e => /text|tool_call|reasoning|usage_report/.test(e.event_type)).map(e => toSeconds(e.timestamp)).filter(isFinite);
    const t = inEv.length ? Math.max(...inEv) : Math.min(...ts), endT = outEv.length ? Math.max(...outEv) : t;
    return { t, isl: +o.input_tokens_total || 0, osl: Math.max(1, (+o.output_tokens || 0)), cached, session: o.session_id, api: Math.max(0, endT - t), tools: (o.tools || []).length, model: o.model };
  }
  function parseTraceLab(docs, opt) {
    const rows = docs.map(tracelabRow).filter(Boolean);
    const out = finish(rows, 'TraceLab coding-agent trace', [], Object.assign({ maxIsl: 2e6, maxOsl: 64000 }, opt || {}));
    out.notes.push('cached tokens as each provider reported them (Claude cache reads, Codex cached prefix)');
    return out;
  }

  // ---------- detection ----------
  function parseJsonLines(text) {
    const out = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (e) { bad++; }
    }
    return { docs: out, bad };
  }
  function parseTrace(text, opt) {
    const s = text.replace(/^\uFEFF/, '').trimStart();
    if (s[0] === '{' || s[0] === '[') {
      let docs, bad = 0;
      try { const whole = JSON.parse(s); docs = Array.isArray(whole) ? whole : [whole]; }
      catch (e) { const jl = parseJsonLines(s); docs = jl.docs; bad = jl.bad; }
      if (!docs.length) throw new Error('The file looks like JSON but no record could be parsed.');
      let res;
      const d0 = docs.find(d => d && typeof d === 'object');
      if (docs.some(d => d && (d.resourceSpans || d.batches))) res = parseOTLP(docs, opt);
      else if (d0 && (Array.isArray(d0.requests) || (Array.isArray(d0) && d0[0] && d0[0].hash_ids))) res = parseAgentX(docs, opt);
      else if (d0 && d0.input_length != null && d0.hash_ids) res = parseMooncake(docs, opt);
      else if (d0 && d0.timing_events && d0.input_tokens_total != null) res = parseTraceLab(docs, opt);
      else if (docs.length === 1 && docs[0] && Array.isArray(docs[0].data) && docs[0].data.some(x => x && x.spans)) res = parseJaeger(docs[0], opt);
      else {
        const records = docs.length === 1 && docs[0] && Array.isArray(docs[0].data) ? docs[0].data : docs;
        res = parseGateway(records, opt);
      }
      if (bad) res.notes.push(bad + ' malformed JSON line' + (bad > 1 ? 's' : '') + ' skipped');
      return res;
    }
    return parseCSV(s, opt);
  }

  // Canonical CSV, the round-trip format written by tools/convert-trace.mjs.
  function toCSV(trace) {
    const f = v => (v == null ? '' : (typeof v === 'number' ? +v.toFixed(6) : '"' + String(v).replace(/"/g, '') + '"'));
    const lines = ['timestamp,input_tokens,output_tokens,cached_tokens,ttft_s,queue_s,e2e_s,session'];
    for (const r of trace) lines.push([f(r.t), r.isl, r.osl, f(r.cached), f(r.ttft), f(r.queue), f(r.e2e), f(r.session)].join(','));
    return lines.join('\n') + '\n';
  }

  const api = { parseTrace, parseCSV, toCSV, toSeconds, LIMITS, parseAgentX, parseMooncake, parseTraceLab, tracelabRow, prefixReuse, finish };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetIngest = api;
})(typeof window !== 'undefined' ? window : this);
