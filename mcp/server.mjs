#!/usr/bin/env node
// AIInfraTools as an MCP server (stdio, JSON-RPC 2.0, one message per line). No dependencies.
//
//   npx aiinfra-tools mcp            or   node mcp/server.mjs
//
// Each tool runs the matching CLI command with --json. Where the output has a schema in schemas/, the tool declares
// it as its outputSchema and returns the result as structuredContent.
//
// Safety: this server only reads, simulates and plans. Nothing it exposes changes a cluster, pages anyone or
// approves an action: there is no --live, --apply, approve or execute here. Proposals land in the approval queue for
// a person (gpu-health actions approve, fleetops … --live) outside the model's reach.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS as CLI } from '../bin/aiinfra.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const schema = id => { try { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', `${id}.schema.json`), 'utf8')); delete s.$schema; delete s.$id; return s.type === 'object' ? s : null; } catch { return null; } };

const str = (description, extra = {}) => Object.assign({ type: 'string', description }, extra);
const num = (description, extra = {}) => Object.assign({ type: 'number', description }, extra);
const T = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }; // writes local files only
const opt = (args, flag, v) => (v === undefined || v === null || v === '' ? args : args.concat(flag, String(v)));
const workload = (a, i) => ['isl', 'osl', 'ttft', 'tpot', 'rate'].reduce((x, k) => opt(x, `--${k}`, i[k]), a);
const WL = {
  isl: num('Median prompt tokens per request', { default: 2000 }), osl: num('Median output tokens per request', { default: 400 }),
  ttft: num('Time-to-first-token target in seconds', { default: 2 }), tpot: num('Time-per-output-token target in seconds', { default: 0.05 }),
};

export const TOOLS = [
  { name: 'list_catalog', title: 'GPUs and models the sizer knows', schema: 'sizer.list', annotations: T,
    description: 'Lists the GPU and model ids the Inference Sizer knows, with their specs. Use it to find valid ids for the other tools.',
    input: { type: 'object', properties: {} }, cli: () => ['sizer', '--list', '--json'] },
  { name: 'size_inference', title: 'GPUs needed to serve a model', schema: 'sizer.plan', annotations: T,
    description: 'How many GPUs, in what layout (TP/EP, aggregated or disaggregated prefill/decode), serve a model at TTFT and TPOT targets, and the cost per million tokens. Give compare to rank several GPUs instead.',
    input: { type: 'object', required: ['model'], properties: {
      model: str('Model id, e.g. llama33-70b (see list_catalog)'), gpu: str('GPU id, e.g. H100, B200'),
      compare: { type: 'array', items: { type: 'string' }, description: 'Several GPU ids to compare, cheapest first (instead of gpu)' },
      inputs: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean'] }, description: 'Sizer inputs, e.g. {"conc": 800, "ttft": 1000, "tpot": 30, "avgIn": 2000, "avgOut": 400, "mode": "auto", "price": 5.5}. ttft/tpot in ms. See inference-sizer/docs/METHOD.md' } } },
    schemaFor: i => (i.compare ? 'sizer.compare' : 'sizer.plan'),
    cli: i => ['sizer', '--model', i.model, ...(i.compare ? ['--compare', [].concat(i.compare).join(',')] : i.gpu ? ['--gpu', i.gpu] : []),
      ...Object.entries(i.inputs || {}).flatMap(([k, v]) => ['--set', `${k}=${v}`]), '--json'] },
  { name: 'what_fits', title: 'Models that fit on given GPUs', schema: 'fleetops.serving.fit', annotations: T,
    description: 'Given GPUs and a workload, every catalog model that fits, the requests per second each carries in production (headroom, N+1 spare) and flat out, cost per million tokens and layout.',
    input: { type: 'object', required: ['gpu', 'nodes'], properties: Object.assign({ gpu: str('GPU id'), nodes: num('Number of nodes'),
      rate: num('Requests per second to carry (optional)'), rank: str('largest or throughput', { enum: ['largest', 'throughput'] }) }, WL) },
    cli: i => opt(workload(['fleetops', 'serving', 'fit', '--gpu', i.gpu, '--nodes', String(i.nodes)], i), '--rank', i.rank).concat('--json') },
  { name: 'model_capacity', title: 'Load one model carries on given GPUs', schema: 'fleetops.serving.capacity', annotations: T,
    description: 'The most load one model carries on given GPUs within the targets: requests per second, concurrency, longest prompt, layout.',
    input: { type: 'object', required: ['model', 'gpu', 'nodes'], properties: Object.assign({ model: str('Model id'), gpu: str('GPU id'), nodes: num('Number of nodes') }, WL) },
    cli: i => workload(['fleetops', 'serving', 'capacity', '--model', i.model, '--gpu', i.gpu, '--nodes', String(i.nodes)], i).concat('--json') },
  { name: 'fleetscope_templates', title: 'FleetScope scenario templates', schema: 'fleetscope.templates', annotations: T,
    description: 'Lists FleetScope\'s scenario templates (hybrid fleets with traffic) to run or ask about.',
    input: { type: 'object', properties: {} }, cli: () => ['fleetscope', 'templates', '--json'] },
  { name: 'fleetscope_run', title: 'Simulate a fleet scenario', schema: 'fleetscope.run', annotations: T,
    description: 'Replays a scenario\'s traffic on its modelled fleet: SLO attainment, TTFT/TPOT p99, bottlenecks and cost per pool.',
    input: { type: 'object', required: ['template'], properties: { template: str('Template id (fleetscope_templates)') } },
    cli: i => ['fleetscope', 'run', '--template', i.template, '--json'] },
  { name: 'fleetscope_ask', title: 'Ask a what-if about a fleet', schema: 'fleetscope.ask', annotations: T,
    description: 'Applies a plain-English what-if ("the cloud link drops to 25 Gbps and traffic doubles") to a scenario and reports the effect.',
    input: { type: 'object', required: ['question', 'template'], properties: { question: str('The what-if, in plain English'), template: str('Template id') } },
    cli: i => ['fleetscope', 'ask', i.question, '--template', i.template, '--json'] },
  { name: 'gpu_health_analyze', title: 'GPU health, efficiency and savings', schema: 'gpu-health.analyze', annotations: WRITES,
    description: 'Analyzes GPU samples (DCGM/nvidia-smi as JSON lines) and jobs: health problems, idle and underused GPUs, savings. Proposes fixes into the approval queue in the state folder; a person approves them outside this server.',
    input: { type: 'object', required: ['samples', 'jobs', 'state'], properties: { samples: str('Path to samples.jsonl'), jobs: str('Path to jobs.json'), state: str('State folder (created if missing)') } },
    cli: i => ['gpu-health', 'analyze', '--samples', i.samples, '--jobs', i.jobs, '--state', i.state, '--json'] },
  { name: 'ledger_report', title: 'GPU-hours and cost by owner', schema: 'ledger.report', annotations: T,
    description: 'GPU-hours and cost by org, team, person or use case, split into useful, idle and lost.',
    input: { type: 'object', required: ['usage', 'config'], properties: { usage: str('Path to usage.jsonl'), config: str('Path to the ledger config JSON'), by: str('Grouping, e.g. org,team', { default: 'org,team' }) } },
    cli: i => ['ledger', 'report', '--usage', i.usage, '--config', i.config, '--by', i.by || 'org,team', '--format', 'json'] },
  { name: 'ledger_insights', title: 'Where to save on GPUs', schema: 'ledger.insights', annotations: T,
    description: 'Ranked savings (idle timeouts, wrong GPU type, oversized serving, commitments…), each with an owner and how it was worked out.',
    input: { type: 'object', required: ['usage', 'config'], properties: { usage: str('Path to usage.jsonl'), config: str('Path to the ledger config JSON') } },
    cli: i => ['ledger', 'insights', '--usage', i.usage, '--config', i.config, '--json'] },
  { name: 'harness_waste', title: 'Where agents waste tokens and money', annotations: T,
    description: 'Reads Claude Code transcripts, Codex rollouts, OpenTelemetry GenAI/OpenInference spans or Langfuse exports and reports avoidable tokens and cost by cause (cache misses, oversized and repeated tool output, retry loops, unused tools), harness, tool and session, with fixes. Optional vLLM traces charge self-hosted calls their GPU time. Keeps counts only.',
    input: { type: 'object', required: ['paths'], properties: { paths: str('Files or folders, comma-separated'), prices: str('Price file ($/M tokens per model); examples are used without it'),
      engine: str('vLLM OTLP traces, for GPU time'), replicas: str('Replica GPUs and $/GPU-h (JSON)'), outcomes: str('Session outcomes (JSON or CSV)'), since: str('Only calls after this, e.g. 7d') } },
    cli: i => ['harness-ledger', 'report', ...String(i.paths).split(',').map(s => s.trim()).filter(Boolean)]
      .concat(...[['prices', i.prices], ['engine', i.engine], ['replicas', i.replicas], ['outcomes', i.outcomes], ['since', i.since]].filter(([, v]) => v).map(([k, v]) => [`--${k}`, String(v)]), '--json') },
  { name: 'rca_diagnose', title: 'Root cause of an incident', schema: 'fleetops.rca.diagnose', annotations: T,
    description: 'Ranks root-cause hypotheses for job failures, a latency regression or device faults in a window, with the evidence for each.',
    input: { type: 'object', required: ['store', 'symptom', 'from', 'to'], properties: { store: str('fleetops store folder'),
      symptom: str('What went wrong', { enum: ['job-failures', 'latency', 'device'] }), from: str('Window start (ISO time or epoch seconds)'), to: str('Window end'),
      pool: str('Serving pool, for latency'), nodes: { type: 'array', items: { type: 'string' }, description: 'Limit to these nodes' } } },
    cli: i => opt(opt(['fleetops', 'rca', 'diagnose', '--symptom', i.symptom, '--from', String(i.from), '--to', String(i.to), '--store', i.store], '--pool', i.pool), '--nodes', i.nodes && [].concat(i.nodes).join(',')).concat('--json') },
  { name: 'rca_detect', title: 'Detect incidents', annotations: T,
    description: 'Finds failure spikes and regressions in a window (CUSUM), optionally diagnosing each.',
    input: { type: 'object', required: ['store'], properties: { store: str('fleetops store folder'), from: str('Window start'), to: str('Window end'), diagnose: { type: 'boolean', description: 'Diagnose each incident' } } },
    cli: i => opt(opt(['fleetops', 'rca', 'detect', '--store', i.store], '--from', i.from), '--to', i.to).concat(i.diagnose ? ['--diagnose'] : [], '--json') },
  { name: 'power_report', title: 'Power against budget', schema: 'fleetops.power.report', annotations: T,
    description: 'IT power (p99 and peak) per rack, PDU, row and site against its budget, with headroom in nodes.',
    input: { type: 'object', required: ['store', 'budgets'], properties: { store: str('fleetops store folder'), budgets: str('Path to the power budgets JSON'), from: str('Window start'), to: str('Window end') } },
    cli: i => opt(opt(['fleetops', 'power', 'report', '--budgets', i.budgets, '--store', i.store], '--from', i.from), '--to', i.to).concat('--json') },
  { name: 'power_plan', title: 'Plan GPU power caps', schema: 'fleetops.power.plan', annotations: WRITES,
    description: 'Plans per-job GPU power caps that bring racks under budget with the least slowdown. Writes a plan file; applying it needs a person\'s approval and --live outside this server.',
    input: { type: 'object', required: ['store', 'budgets', 'out'], properties: { store: str('fleetops store folder'), budgets: str('Path to the power budgets JSON'),
      out: str('Where to write plan.json'), from: str('Window start'), to: str('Window end'), maxSlowdown: num('Largest slowdown allowed per job, e.g. 0.05') } },
    cli: i => opt(opt(opt(['fleetops', 'power', 'plan', '--budgets', i.budgets, '--store', i.store, '--out', i.out], '--from', i.from), '--to', i.to), '--max-slowdown', i.maxSlowdown).concat('--json') },
  { name: 'fix_trace_skew', title: 'Correct clock skew in traces', schema: 'fix-skew.demo', annotations: T,
    description: 'Estimates each machine\'s clock offset from OTLP/JSON traces and reports the ordering violations before and after correction (dry run: no file written).',
    input: { type: 'object', required: ['traces'], properties: { traces: str('Path to traces (JSON or JSON lines)') } },
    cli: i => ['fix-skew', i.traces, '--dry-run', '--json'] },
];

// nothing reachable from here may act on infrastructure
const FORBIDDEN = /^--(live|apply|allow-live|execute)$|^(approve|execute)$/;

function runCli(argv) {
  const [tool, ...args] = argv;
  if (args.some(a => FORBIDDEN.test(a))) return Promise.reject(new Error('refused: this server never acts on infrastructure'));
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, CLI[tool].file), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 5 * 60 * 1000);
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', reject);
  });
}

export async function callTool(name, input = {}) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  for (const r of t.input.required || []) if (input[r] === undefined || input[r] === '') return { isError: true, content: [{ type: 'text', text: `missing required argument: ${r}` }] };
  let r;
  try { r = await runCli(t.cli(input)); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  let data = null; try { data = JSON.parse(r.out); } catch { /* not JSON */ }
  if (data && data.error) return { isError: true, content: [{ type: 'text', text: String(data.error) }] };
  if (!data) return { isError: r.code !== 0, content: [{ type: 'text', text: (r.out || r.err || `exit ${r.code}`).trim() }] };
  const res = { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
  if (data && typeof data === 'object' && !Array.isArray(data)) res.structuredContent = data;
  // the sizer exits 1 when nothing meets the targets: a valid answer, not an error
  if (r.code !== 0 && !(t.name === 'size_inference' && r.code === 1)) res.isError = true;
  return res;
}

export function listTools() {
  return TOOLS.map(t => {
    const o = { name: t.name, title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations };
    const s = t.schema && !t.schemaFor && schema(t.schema); if (s) o.outputSchema = s;
    return o;
  });
}

export async function handle(msg) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result }), fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
    return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aiinfra-tools', title: 'AIInfraTools', version: VERSION },
      instructions: 'GPU fleet tools: size inference, what fits, capacity, fleet simulation, GPU health, GPU-hour ledger, root cause, power. They read, simulate and plan; any change to infrastructure is approved by a person outside this server.' });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: listTools() });
  if (method === 'tools/call') {
    try { return ok(await callTool(params.name, params.arguments || {})); } catch (e) { return fail(e.code || -32603, e.message); }
  }
  if (id === undefined) return null; // a notification (notifications/initialized, cancelled…)
  return fail(-32601, `Method not found: ${method}`);
}

export function serve(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = m => m && output.write(JSON.stringify(m) + '\n');
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (Array.isArray(msg)) { const rs = (await Promise.all(msg.map(handle))).filter(Boolean); if (rs.length) write(rs); return; }
    write(await handle(msg));
  });
  return rl;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
