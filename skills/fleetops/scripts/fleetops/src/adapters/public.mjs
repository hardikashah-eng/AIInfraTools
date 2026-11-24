// Other public traces.
//   Azure LLM inference traces (Azure/AzurePublicDataset, CC BY 4.0): TIMESTAMP, ContextTokens, GeneratedTokens → request
//   MLPerf Inference results (mlcommons/inference_results_v*): mlperf_log_summary.txt from a Server run → benchmark
//   AcmeTrace (InternLM/AcmeTrace, CC BY 4.0): Shanghai AI Lab LLM-development job traces → job
import { toEpoch } from './time.mjs';

export function azureLlm(text, { pool = 'azure', limit = Infinity } = {}) {
  const lines = String(text).split(/\r?\n/), head = lines[0].split(',').map(s => s.trim().toLowerCase());
  const it = head.indexOf('timestamp'), ii = head.indexOf('contexttokens'), io = head.indexOf('generatedtokens');
  if (it < 0 || ii < 0 || io < 0) throw new Error('expected TIMESTAMP, ContextTokens, GeneratedTokens columns');
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const c = l.split(',');
    const t = toEpoch(c[it].replace(/(\.\d{3})\d+/, '$1'));
    if (t == null) continue;
    out.push({ t, pool, isl: +c[ii], osl: +c[io], source: 'azure-llm' });
    if (out.length >= limit) break;
  }
  return out;
}

const GPU_RE = [[/MI325X/i, 'MI325X'], [/MI300X/i, 'MI300X'], [/GB200/i, 'GB200'], [/B200/i, 'B200'], [/GH200/i, 'GH200'], [/H200/i, 'H200'], [/H100/i, 'H100'], [/L40S/i, 'L40S'], [/A100/i, 'A100']];
// One summary file. `path` (results/<system>/<model>/<scenario>/…) gives the system, model and scenario; `meta` overrides.
export function mlperfSummary(text, { path = '', t = 0, meta = {} } = {}) {
  const num = re => { const m = String(text).match(re); return m ? +m[1] : NaN; };
  const ns = re => num(re) / 1e9;
  const parts = path.split('/'), ri = parts.indexOf('results');
  const system = meta.system || (ri >= 0 ? parts[ri + 1] : '');
  const submitter = meta.submitter || (ri > 0 ? parts[ri - 1] : '');
  const model = meta.model || (ri >= 0 ? parts[ri + 2] : '');
  const scenario = meta.scenario || (String(text).match(/Scenario\s*:\s*(\w+)/) || [])[1] || (ri >= 0 ? parts[ri + 3] : '');
  const gpu = meta.gpu || (GPU_RE.find(([re]) => re.test(system)) || [])[1] || '';
  const gpus = meta.gpus || +((system.match(/x(\d+)(?:_|$)/i) || system.match(/(\d+)x/i) || [])[1] || 1);
  const samples = num(/Completed samples per second\s*:\s*([\d.]+)/), tok = num(/Completed tokens per second\s*:\s*([\d.]+)/);
  return {
    t, source: 'mlperf', submitter, system, gpu, gpus, model, scenario, valid: /Result is : VALID/.test(text),
    qps: num(/target_qps\s*:\s*([\d.]+)/) || samples, samplesPerS: samples, tokPerS: tok, oslMean: samples ? tok / samples : NaN,
    ttftP50: ns(/50\.00 percentile first token latency \(ns\)\s*:\s*(\d+)/), ttftP99: ns(/99\.00 percentile first token latency \(ns\)\s*:\s*(\d+)/),
    tpotP50: ns(/50\.00 percentile time to output token \(ns\)\s*:\s*(\d+)/), tpotP99: ns(/99\.00 percentile time to output token \(ns\)\s*:\s*(\d+)/),
    ttftLimit: ns(/ttft_latency \(ns\)\s*:\s*(\d+)/), tpotLimit: ns(/tpot_latency \(ns\)\s*:\s*(\d+)/),
    islMean: meta.islMean, ...(meta.extra || {}),
  };
}

const ACME_STATUS = { COMPLETED: 'ok', FAILED: 'failed', CANCELLED: 'cancelled', TIMEOUT: 'timeout', NODE_FAIL: 'failed' };
export function acme(text, { cluster = 'acme', limit = Infinity } = {}) {
  const lines = String(text).split(/\r?\n/), h = lines[0].split(',');
  const ix = k => h.indexOf(k), out = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const c = l.split(',');
    const status = ACME_STATUS[c[ix('state')]];
    const end = toEpoch(c[ix('end_time')]);
    if (!status || end == null) continue;
    out.push({ t: end, job: `${cluster}:${c[ix('job_id')]}`, status, cause: c[ix('state')] === 'NODE_FAIL' ? 'infra' : 'unknown', start: toEpoch(c[ix('start_time')]), end,
      gpus: +c[ix('gpu_num')] || 0, nodes: +c[ix('node_num')] || 0, type: c[ix('type')], user: c[ix('user')], source: `acme-${cluster}` });
    if (out.length >= limit) break;
  }
  return out;
}
