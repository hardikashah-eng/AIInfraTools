#!/usr/bin/env node
// aiinfra: one entry point for every AIInfraTools command. `aiinfra <tool> [args…]` runs that tool's CLI with the
// same Node.js, so `npx aiinfra-tools sizer --help` works with nothing installed but Node 22+.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS = {
  sizer: { file: 'inference-sizer/tools/size.mjs', what: 'GPU count, layout and cost for a model at TTFT/TPOT targets' },
  fleetscope: { file: 'fleetscope/tools/fleetscope.mjs', what: 'replay LLM traffic on a modelled hybrid GPU fleet; what-ifs and stress suites' },
  'fleetscope-plan': { file: 'fleetscope/tools/fleetscope-plan.mjs', what: 'capacity plans from FleetScope scenarios' },
  'live-twin': { file: 'fleetscope/tools/live-twin.mjs', what: 'forecast traffic from Prometheus and predict SLO breaches' },
  agentic: { file: 'fleetscope/tools/agentic.mjs', what: 'agentic workload profiles from real agent traces: synthesize sessions, size GPUs (compute and KV working set)' },
  'convert-trace': { file: 'fleetscope/tools/convert-trace.mjs', what: 'convert public traces to FleetScope workloads' },
  'gpu-health': { file: 'gpu-health/tools/gpu-health.mjs', what: 'health checks, utilization and savings, fixes behind an approval queue' },
  ledger: { file: 'gpu-ledger/tools/ledger.mjs', what: 'GPU-hours and cost by org, team and person: useful, idle, lost; FOCUS export' },
  'harness-ledger': { file: 'harness-ledger/tools/harness-ledger.mjs', what: 'where agent harnesses (Claude Code, Codex, OTel, Langfuse) waste tokens, dollars and GPU time' },
  fleetops: { file: 'fleetops/tools/fleetops.mjs', what: 'shared data layer, root-cause analysis, incidents, tuning, power, admission, serving' },
  'workload-profile': { file: 'fleetops/tools/workload-profile.mjs', what: 'profile and synthesize application workloads (agents, chat, RAG…)' },
  'fix-skew': { file: 'hybrid-tracing/tools/fix-skew.mjs', what: 'estimate and remove clock skew from OTLP traces' },
  'skew-corrector': { file: 'hybrid-tracing/tools/skew-corrector.mjs', what: 'run the skew-corrector service' },
  mcp: { file: 'mcp/server.mjs', what: 'run every tool as an MCP server over stdio (for Claude, Cursor and other MCP clients)' },
};
TOOLS.report = { file: 'bin/report.mjs', what: 'plan → verify → account on one page: sizer prediction, last shadow verdict, calibration, agent economics' };
TOOLS.demo = { file: 'fleetops/tools/loop-demo.mjs', what: 'the whole loop on a real week of a GPU cluster: observe → diagnose → simulate → approve → optimize → verify' };
const ALIASES = { 'inference-sizer': 'sizer', 'gpu-ledger': 'ledger', harness: 'harness-ledger', tracing: 'fix-skew', 'hybrid-tracing': 'fix-skew' };
const version = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function help() {
  const w = Math.max(...Object.keys(TOOLS).map(k => k.length));
  return `aiinfra ${version()}: AIInfraTools from one command\n\nUsage: aiinfra <tool> [args…]   (every tool takes --help; most take --json)\n\n` +
    Object.entries(TOOLS).map(([k, t]) => `  ${k.padEnd(w)}  ${t.what}`).join('\n') +
    `\n\nAlso: aiinfra version · aiinfra path <tool> (the script's path, for skills and scripts)\nDocs: https://github.com/hardikashah-eng/AIInfraTools\n`;
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(help()); return 0; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') { process.stdout.write(version() + '\n'); return 0; }
  if (cmd === 'path') { const t = TOOLS[ALIASES[rest[0]] || rest[0]]; if (!t) { process.stderr.write(`unknown tool: ${rest[0]}\n`); return 2; } process.stdout.write(path.join(ROOT, t.file) + '\n'); return 0; }
  const t = TOOLS[ALIASES[cmd] || cmd];
  if (!t) { process.stderr.write(`aiinfra: unknown tool "${cmd}"\n\n${help()}`); return 2; }
  const r = spawnSync(process.execPath, [path.join(ROOT, t.file), ...rest], { stdio: 'inherit' });
  if (r.error) { process.stderr.write(`aiinfra: ${r.error.message}\n`); return 1; }
  return r.status === null ? 1 : r.status;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
