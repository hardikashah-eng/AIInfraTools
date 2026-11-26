// Shadow replay: send the same recorded workload to a baseline and a candidate endpoint at the same moments, and
// measure each request on both. Every request goes to both arms with one pair id, so compare() can use per-request
// ratios, which need several times fewer requests than comparing two separate streams.
//
// Endpoints are OpenAI-compatible completion servers (vLLM, SGLang, TGI, llm-d gateways): POST /v1/completions with
// stream: true. Only model calls are sent; nothing else a recorded agent did (tools, writes) is repeated.
//
// Prompts are synthetic text of the recorded length. Requests of one session share a growing prefix, so the engine's
// prefix cache sees the same reuse the session had. Output length is the recorded one (max_tokens; with
// --exact-output, vLLM's ignore_eos too).
//
// Without live: true nothing is sent: run() returns the plan (requests, tokens, duration) so it can be checked first.

const WORDS = 'the of and to in is that for on with as at by from this be or are was it an which not have has can will one all their more would there what about out up into than them only other new some could time these two may first then do any like my now over such our man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three'.split(' ');
// n tokens of text: about one token per short word plus its space
export function text(seed, nTokens) {
  let s = (seed >>> 0) || 1, out = '';
  for (let i = 0; i < nTokens; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out += WORDS[s % WORDS.length] + ' '; }
  return out;
}
const hash = x => { let h = 2166136261; for (const ch of String(x)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

// rows: FleetScope trace rows { t, isl, osl, session?, cached? }. The first request of a session gets its whole prompt;
// each later one repeats the previous prompt and appends new text, as an agent loop does.
export function requestsFrom(rows, { speed = 1, maxRequests = Infinity, durationS = Infinity, from = null } = {}) {
  const sorted = [...rows].sort((a, b) => a.t - b.t), t0 = from ?? (sorted[0] ? sorted[0].t : 0), prefix = new Map(), out = [];
  for (const r of sorted) {
    const at = (r.t - t0) / speed; if (at > durationS || out.length >= maxRequests) break;
    const sess = r.session != null ? String(r.session) : null, prev = sess ? prefix.get(sess) : null;
    let prompt;
    if (prev && r.isl > prev.tokens) prompt = prev.text + text(hash(sess + ':' + out.length), r.isl - prev.tokens);
    else prompt = text(hash((sess || 'r') + ':' + out.length + ':' + r.isl), Math.max(1, r.isl));
    if (sess) prefix.set(sess, { text: prompt, tokens: Math.max(1, r.isl) });
    out.push({ pair: out.length, at, session: sess, isl: r.isl, osl: Math.max(1, r.osl || 1), prompt });
  }
  return out;
}

export function summary(reqs, arms) {
  const inTok = reqs.reduce((a, r) => a + r.isl, 0), outTok = reqs.reduce((a, r) => a + r.osl, 0), dur = reqs.length ? reqs[reqs.length - 1].at : 0;
  return { requests: reqs.length, sessions: new Set(reqs.map(r => r.session).filter(Boolean)).size, seconds: dur, promptTokens: inTok, outputTokens: outTok,
    arms: arms.map(a => ({ name: a.name, url: a.url })), note: `each request goes to ${arms.length} endpoints; ${(inTok / 1e6).toFixed(2)}M prompt and ${(outTok / 1e6).toFixed(2)}M output tokens per endpoint` };
}

// One streamed completion; times from the first byte of the response body that carries text.
export async function complete(arm, req, { model, exact = true, timeoutS = 600, fetchImpl = fetch, now = () => performance.now() / 1000 } = {}) {
  const body = { model: arm.model || model, prompt: req.prompt, max_tokens: req.osl, temperature: 0, stream: true, stream_options: { include_usage: true } };
  if (exact) Object.assign(body, { ignore_eos: true, min_tokens: req.osl });
  const headers = { 'content-type': 'application/json' }; if (arm.apiKey) headers.authorization = `Bearer ${arm.apiKey}`;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutS * 1000);
  const t0 = now(); let ttft = null, chunks = 0, usage = null;
  try {
    const res = await fetchImpl(arm.url.replace(/\/$/, '') + '/v1/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}`, e2e: now() - t0 };
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.usage) usage = j.usage;
        const txt = j.choices && j.choices[0] && (j.choices[0].text ?? (j.choices[0].delta && j.choices[0].delta.content));
        if (txt) { chunks++; if (ttft == null) ttft = now() - t0; }
      }
    }
    const e2e = now() - t0, osl = usage ? usage.completion_tokens : chunks;
    const out = { ttft, e2e, osl, isl: usage ? usage.prompt_tokens : req.isl };
    const cached = usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens; if (cached != null) out.cached = cached;
    if (ttft != null && osl > 1) out.tpot = (e2e - ttft) / (osl - 1);
    return out;
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), e2e: now() - t0 }; }
  finally { clearTimeout(timer); }
}

// Send every request to every arm at its scheduled time (open loop), at most maxInflight per arm at once.
export async function run(reqs, arms, { live = false, maxInflight = 64, model, exact = true, timeoutS = 600, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), t0 = Math.floor(Date.now() / 1000), onRecord } = {}) {
  if (!live) return { dryRun: true, plan: summary(reqs, arms) };
  const records = [], start = performance.now() / 1000, inflight = new Map(arms.map(a => [a.name, 0])), pending = [];
  const one = async (arm, req) => {
    while (inflight.get(arm.name) >= maxInflight) await sleep(5);
    inflight.set(arm.name, inflight.get(arm.name) + 1);
    const sent = performance.now() / 1000 - start;
    try {
      const m = await complete(arm, req, { model, exact, timeoutS, fetchImpl });
      const rec = Object.assign({ t: t0 + sent, variant: arm.name, pair: req.pair, session: req.session || undefined, isl: req.isl, osl: req.osl, source: 'shadow-replay' }, m);
      if (m.error) rec.error = m.error;
      records.push(rec); if (onRecord) onRecord(rec);
    } finally { inflight.set(arm.name, inflight.get(arm.name) - 1); }
  };
  for (const req of reqs) {
    const wait = req.at - (performance.now() / 1000 - start); if (wait > 0) await sleep(wait * 1000);
    for (const arm of arms) pending.push(one(arm, req));
  }
  await Promise.all(pending);
  return { dryRun: false, records: records.sort((a, b) => a.t - b.t || a.pair - b.pair), plan: summary(reqs, arms) };
}

// ---------- the same answers ----------
// Greedy decoding with log-probabilities on a fixed prompt set: identical tokens on both arms, the first position where
// they part, and how far the log-probabilities of the shared tokens moved. Numerics changes (kernels, FP8, a new tensor-
// parallel layout, an engine upgrade) show up here before they show up in any latency metric.
export const PROMPTS = [
  'Write a Python function that returns the n-th Fibonacci number iteratively.',
  'Explain in three sentences why the sky is blue.',
  'List five prime numbers greater than 100.',
  'Translate to French: The meeting has been moved to Thursday afternoon.',
  'Summarize the plot of a story about a lighthouse keeper who finds a message in a bottle.',
  'What is 17 multiplied by 23? Show the steps.',
  'Write a SQL query that returns the ten customers with the highest total order value.',
  'Give three tips for reducing memory use in a large Python program.',
  'Describe the difference between TCP and UDP for a beginner.',
  'Complete the sequence: 2, 6, 12, 20, 30, …',
  'Write a two-line slogan for a bicycle repair shop.',
  'Convert 72 degrees Fahrenheit to Celsius and explain the formula.',
  'What does the Unix command `grep -rn TODO .` do?',
  'Name the planets of the solar system in order from the sun.',
  'Write a regular expression that matches a US ZIP code with an optional four-digit extension.',
  'Explain what a hash map is and its average lookup cost.',
];
export async function greedy(arm, prompt, { model, maxTokens = 64, fetchImpl = fetch } = {}) {
  const headers = { 'content-type': 'application/json' }; if (arm.apiKey) headers.authorization = `Bearer ${arm.apiKey}`;
  const res = await fetchImpl(arm.url.replace(/\/$/, '') + '/v1/completions', { method: 'POST', headers, body: JSON.stringify({ model: arm.model || model, prompt, max_tokens: maxTokens, temperature: 0, logprobs: 1, seed: 0 }) });
  if (!res.ok) throw new Error(`${arm.name}: HTTP ${res.status}`);
  const j = await res.json(), c = j.choices[0], lp = c.logprobs || {};
  return { tokens: lp.tokens || (c.text ? [...c.text] : []), logprobs: lp.token_logprobs || [] };
}
export function compareAnswers(pairs) {
  let same = 0, divergeSum = 0, diffs = [];
  for (const { a, b } of pairs) {
    let k = 0; while (k < a.tokens.length && k < b.tokens.length && a.tokens[k] === b.tokens[k]) k++;
    if (k === a.tokens.length && k === b.tokens.length) same++; else divergeSum += k;
    for (let i = 0; i < k; i++) if (Number.isFinite(a.logprobs[i]) && Number.isFinite(b.logprobs[i])) diffs.push(Math.abs(a.logprobs[i] - b.logprobs[i]));
  }
  const n = pairs.length, differ = n - same;
  return { prompts: n, identical: same, matchRate: n ? same / n : 0, meanFirstDivergence: differ ? divergeSum / differ : null, meanAbsLogprobDiff: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null };
}
export async function answers(arms, { prompts = PROMPTS, live = false, model, maxTokens = 64, fetchImpl = fetch } = {}) {
  if (!live) return { dryRun: true, prompts: prompts.length, arms: arms.map(a => a.name), note: `${prompts.length} prompts × ${arms.length} endpoints, greedy, ${maxTokens} tokens each` };
  const [A, B] = arms, pairs = [];
  for (const p of prompts) pairs.push({ prompt: p, a: await greedy(A, p, { model, maxTokens, fetchImpl }), b: await greedy(B, p, { model, maxTokens, fetchImpl }) });
  return Object.assign({ dryRun: false }, compareAnswers(pairs));
}
