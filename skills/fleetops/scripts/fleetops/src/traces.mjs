// Request and rank tracing: spans → per-request records with stages; profiler traces and step logs → per-rank steps.
//
// Serving. A request is one trace. Its stages come from child spans named like the stage (router/gateway, queue/
// scheduler, prefill, decode) or, for vLLM's OpenTelemetry tracing, from latency attributes on its request span
// (gen_ai.latency.time_in_queue, .time_to_first_token, .e2e, .time_in_model_prefill, .time_in_model_decode). Tokens
// come from gen_ai.usage.input_tokens/output_tokens (or prompt_tokens/completion_tokens), the pool from
// gen_ai.request.model or the service name, and the replica from the engine span's pod, host or server address.
//
// Training. A step record is one rank's step: { t, job, rank, node, gpu?, step, durS, commS?, dataS?, computeS?, ckptS? }.
// From PyTorch profiler (Kineto) traces: ProfilerStep#N spans, NCCL kernels inside them (communication), DataLoader
// and checkpoint annotations; or from JSON-lines step logs a training loop writes.

const STAGES = [['router', /route|gateway|proxy/i], ['queue', /queue|schedul|waiting/i], ['prefill', /prefill/i], ['decode', /decode|generat/i]];
const num = v => (v == null || v === '' ? null : Number(v));

// Spans (records of kind span) → request records, one per trace with a root span.
export function requestsFromSpans(spans, { poolAttr = 'gen_ai.request.model' } = {}) {
  const byTrace = new Map();
  for (const s of spans) { if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []); byTrace.get(s.traceId).push(s); }
  const out = [];
  for (const [traceId, ss] of byTrace) {
    const ids = new Set(ss.map(s => s.spanId));
    const root = ss.find(s => !s.parentSpanId || !ids.has(s.parentSpanId));
    if (!root || root.durS == null) continue;
    const a = Object.assign({}, ...ss.map(s => s.attrs || {}));
    const stages = {};
    for (const s of ss) { if (s === root) continue; const st = STAGES.find(([, re]) => re.test(s.name)); if (st && s.durS != null) stages[st[0]] = (stages[st[0]] || 0) + s.durS; }
    // vLLM-style latency attributes fill what child spans didn't
    const lat = k => num(a[`gen_ai.latency.${k}`]);
    if (stages.queue == null && lat('time_in_queue') != null) stages.queue = lat('time_in_queue');
    if (stages.prefill == null && lat('time_in_model_prefill') != null) stages.prefill = lat('time_in_model_prefill');
    if (stages.decode == null && lat('time_in_model_decode') != null) stages.decode = lat('time_in_model_decode');
    const engine = ss.find(s => /prefill|decode|engine|llm/i.test(s.name)) || root;
    const ea = engine.attrs || {};
    const ttft = lat('time_to_first_token') ?? (stages.prefill != null ? (stages.router || 0) + (stages.queue || 0) + stages.prefill : null);
    const isl = num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens']), osl = num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens']);
    const rec = { t: root.t, traceId, pool: a[poolAttr] || a.pool || root.service, replica: ea['k8s.pod.name'] || ea.replica || ea['server.address'] || engine.node || engine.service,
      node: engine.node, isl: isl ?? 0, osl: osl ?? 0, tokens: isl != null && osl != null, ttft, e2e: lat('e2e') ?? root.durS, stages, status: root.status, source: 'traces' };
    for (const k of Object.keys(rec)) if (rec[k] === undefined || rec[k] === null) delete rec[k];
    out.push(rec);
  }
  return out.sort((x, y) => x.t - y.t);
}

// The slowest requests of a pool in a window: exemplars for a latency incident.
export function slowRequests(store, { pool, from, to, by = 'ttft', top = 10 } = {}) {
  return store.query('request', { from, to, where: r => (!pool || r.pool === pool) && Number.isFinite(r[by]) }).sort((a, b) => b[by] - a[by]).slice(0, top);
}

// PyTorch profiler trace (Chrome trace JSON from torch.profiler / Kineto) → step records for one rank.
//   t0: epoch seconds of the trace's time zero when its timestamps are relative (default: baseTimeNanoseconds, else 0)
export function kineto(json, { job, node, rank, t0 } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const ev = j.traceEvents || [];
  const r = rank ?? (j.distributedInfo || {}).rank ?? 0;
  const base = t0 ?? (j.baseTimeNanoseconds ? Number(BigInt(String(j.baseTimeNanoseconds)) / 1000n) / 1e6 : 0);
  const at = us => (us > 1e15 ? us / 1e6 : base + us / 1e6); // absolute µs since the epoch, or relative to t0
  const steps = ev.filter(e => e.ph === 'X' && /^ProfilerStep#\d+$/.test(e.name)).sort((a, b) => a.ts - b.ts);
  const inside = (e, s) => e.ts >= s.ts && e.ts < s.ts + s.dur;
  const comm = ev.filter(e => e.ph === 'X' && /nccl/i.test(e.name) && (e.cat === 'kernel' || e.cat === 'gpu_op' || /Kernel/.test(e.name)));
  const data = ev.filter(e => e.ph === 'X' && /DataLoader|dataloader/.test(e.name)), ckpt = ev.filter(e => e.ph === 'X' && /checkpoint|save_state|torch\.save/i.test(e.name));
  return steps.map(s => {
    const c = comm.filter(e => inside(e, s)).reduce((t, e) => t + e.dur, 0) / 1e6, d = data.filter(e => inside(e, s)).reduce((t, e) => t + e.dur, 0) / 1e6, k = ckpt.filter(e => inside(e, s)).reduce((t, e) => t + e.dur, 0) / 1e6;
    const durS = s.dur / 1e6;
    const rec = { t: at(s.ts + s.dur), job, rank: r, node, step: +s.name.split('#')[1], durS, commS: +c.toFixed(6), dataS: +d.toFixed(6), computeS: +Math.max(0, durS - c - d).toFixed(6), source: 'kineto' };
    if (k) rec.ckptS = +k.toFixed(6);
    return rec;
  });
}

// JSON-lines step log: { t|ts|time, rank, node|host, step, durS|step_time|duration, commS?, dataS?, ckptS?, mfu?, tflops? }
export function stepLog(text, { job } = {}) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = num(o.t ?? o.ts ?? o.time), durS = num(o.durS ?? o.step_time ?? o.duration);
    if (t == null || o.rank == null || o.step == null || durS == null) continue;
    const rec = { t, job: o.job || job, rank: +o.rank, node: o.node || o.host, gpu: o.gpu != null ? String(o.gpu) : undefined, step: +o.step, durS, commS: num(o.commS ?? o.comm_time), dataS: num(o.dataS ?? o.data_time), ckptS: num(o.ckptS ?? o.ckpt_time), mfu: num(o.mfu), loss: num(o.loss), gradNorm: num(o.gradNorm ?? o.grad_norm), n: num(o.n ?? o.steps), source: 'step-log' };
    if (rec.commS != null) rec.computeS = Math.max(0, durS - rec.commS - (rec.dataS || 0));
    for (const k of Object.keys(rec)) if (rec[k] == null) delete rec[k];
    out.push(rec);
  }
  return out;
}

// NCCL Inspector JSON output (NCCL_INSPECTOR_ENABLE=1, the profiler plugin): one object per operation per
// communicator, { header: { id, comm_name, rank, n_ranks, nnodes }, metadata: { dump_timestamp_us, hostname, pid, … },
// coll_perf: { coll, coll_sn, coll_msg_size_bytes, coll_exec_time_us, coll_timing_source, coll_algobw_gbs,
// coll_busbw_gbs } | p2p_perf: { p2p, p2p_sn, p2p_peer, … } }. Files may hold JSON lines, concatenated objects or an
// array; all are read. → collective records.
export function ncclInspector(text, { job, node } = {}) {
  const objs = [], s = String(text);
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) { // split concatenated / line-delimited JSON objects without assuming newlines
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && --depth === 0 && start >= 0) { try { objs.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip a torn record */ } start = -1; }
  }
  const out = [];
  for (const o of objs) {
    const h = o.header || {}, m = o.metadata || {}, c = o.coll_perf, p = o.p2p_perf, perf = c || p;
    if (!perf) continue;
    const pre = c ? 'coll' : 'p2p', ts = Number(m.dump_timestamp_us ?? h.dump_timestamp_us);
    if (!Number.isFinite(ts)) continue;
    const rec = { t: ts / 1e6, job: job || o.job, node: node || m.hostname || h.hostname, rank: h.rank, comm: h.id ?? h.comm_hash, commName: h.comm_name, nranks: h.n_ranks ?? h.nranks, nnodes: h.nnodes,
      op: perf[pre], sn: perf[`${pre}_sn`], bytes: perf[`${pre}_msg_size_bytes`], execS: perf[`${pre}_exec_time_us`] / 1e6, busbw: perf[`${pre}_busbw_gbs`], algobw: perf[`${pre}_algobw_gbs`], timing: perf[`${pre}_timing_source`], peer: p ? p.p2p_peer : undefined, source: 'nccl-inspector' };
    for (const k of Object.keys(rec)) if (rec[k] === undefined || (typeof rec[k] === 'number' && !Number.isFinite(rec[k]))) delete rec[k];
    out.push(rec);
  }
  return out.sort((a, b) => a.t - b.t);
}
