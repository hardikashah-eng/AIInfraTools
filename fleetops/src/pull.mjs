// Pull history from the monitoring a fleet already runs, for backtests and game days:
//   Prometheus (query_range): DCGM / AMD / SambaNova exporter series → device; vLLM histograms → serving per model;
//                             NCCL Inspector (Prometheus mode) → collective
//   Loki (query_range):       kernel and NCCL / PyTorch log lines → log (the same classifiers as the importers)
// Every call goes through the egress allowlist. `headers` carries auth (e.g. Authorization: Bearer …).
import { checkEgress } from './security.mjs';
import { seriesToDevices, seriesToCollectives } from './ingest.mjs';
import { kernelLog, ncclLog } from './adapters/logs.mjs';

const get = async (url, { fetcher, headers } = {}) => {
  checkEgress(url);
  const j = await (fetcher || (async u => { const r = await fetch(u, { headers }); if (!r.ok) throw new Error(`${new URL(u).pathname}: HTTP ${r.status}`); return r.json(); }))(url, headers);
  if (j.status && j.status !== 'success') throw new Error(`${new URL(url).pathname}: ${j.error || j.status}`);
  return j;
};

// query_range → [{ labels, samples: [{ v, t }] }]
export async function promRange(base, query, { from, to, step = 60, fetcher, headers } = {}) {
  const u = `${base.replace(/\/$/, '')}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${from}&end=${to}&step=${step}`;
  const j = await get(u, { fetcher, headers });
  return ((j.data || {}).result || []).map(r => ({ labels: r.metric || {}, samples: (r.values || []).map(([t, v]) => ({ t: +t, v: +v })) }));
}

export const DEVICE_QUERY = '{__name__=~"DCGM_FI_DEV_GPU_TEMP|DCGM_FI_DEV_POWER_USAGE|DCGM_FI_DEV_SM_CLOCK|DCGM_FI_DEV_FB_USED|DCGM_FI_PROF_SM_ACTIVE|DCGM_FI_PROF_PIPE_TENSOR_ACTIVE|DCGM_FI_PROF_DRAM_ACTIVE|DCGM_FI_DEV_XID_ERRORS|DCGM_FI_DEV_ECC_DBE_AGG_TOTAL|DCGM_FI_DEV_ECC_SBE_AGG_TOTAL|DCGM_FI_DEV_CLOCK_THROTTLE_REASONS|DCGM_FI_DEV_CLOCKS_EVENT_REASONS|DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL|DCGM_FI_DEV_PCIE_LINK_WIDTH|gpu_gfx_activity|gpu_umc_activity|gpu_used_vram|gpu_junction_temperature|gpu_power_usage|gpu_ecc_uncorrect_total"}';
export const SERVING_QUERIES = {
  ttftP99: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))',
  tpotP99: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:time_per_output_token_seconds_bucket[5m])))',
  ttftP50: 'histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))',
  rate: 'sum by (model_name) (rate(vllm:request_success_total[5m]))',
  kvUsage: 'avg by (model_name) (vllm:gpu_cache_usage_perc or vllm:kv_cache_usage_perc)',
  preemptions: 'sum by (model_name) (rate(vllm:num_preemptions_total[5m]))',
  islMean: 'sum by (model_name) (rate(vllm:prompt_tokens_total[5m])) / sum by (model_name) (rate(vllm:request_success_total[5m]))',
};
export const NCCL_QUERY = '{__name__=~"nccl_collective_exec_time_microseconds|nccl_bus_bandwidth_gbs"}';

export async function pullPrometheus(store, base, { from, to, step = 60, fetcher, headers, device = true, serving = true, nccl = true } = {}) {
  const o = { from, to, step, fetcher, headers }, got = { device: 0, serving: 0, collective: 0, unmapped: 0 };
  if (device) { const r = seriesToDevices(await promRange(base, DEVICE_QUERY, o)); got.unmapped += r.unmapped; got.device = store.append('device', r.devices, { dedupe: true }).written; }
  if (serving) {
    const rows = new Map();
    for (const [field, q] of Object.entries(SERVING_QUERIES)) for (const s of await promRange(base, q, o)) {
      const pool = s.labels.model_name || s.labels.pool || 'default';
      for (const x of s.samples) { if (!Number.isFinite(x.v)) continue; const k = `${pool}|${x.t}`; if (!rows.has(k)) rows.set(k, { t: x.t, pool, windowS: step, source: 'prometheus' }); rows.get(k)[field] = x.v; }
    }
    got.serving = store.append('serving', [...rows.values()].filter(r => r.ttftP99 != null || r.rate != null), { dedupe: true }).written;
  }
  if (nccl) got.collective = store.append('collective', seriesToCollectives(await promRange(base, NCCL_QUERY, o)), { dedupe: true }).written;
  if (store.flush) store.flush();
  return got;
}

// Loki query_range, paged forward by time → log records.
const NODE_LABELS = ['host', 'hostname', 'node', 'nodename', 'k8s_node_name', 'node_name', 'instance'];
export async function pullLoki(store, base, queries, { from, to, limit = 5000, fetcher, headers, maxPages = 200 } = {}) {
  let n = 0, lines = 0, unmatched = 0;
  for (const q of queries) {
    let start = BigInt(Math.floor(from)) * 1000000000n;
    const end = BigInt(Math.ceil(to)) * 1000000000n;
    for (let page = 0; page < maxPages && start < end; page++) {
      const u = `${base.replace(/\/$/, '')}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&limit=${limit}&direction=forward`;
      const res = ((await get(u, { fetcher, headers })).data || {}).result || [];
      let last = start, got = 0;
      const recs = [];
      for (const st of res) {
        const node = NODE_LABELS.map(k => (st.stream || {})[k]).find(Boolean), job = (st.stream || {}).job_name || (st.stream || {}).pod;
        for (const [ns, line] of st.values || []) {
          got++; lines++;
          const t = Number(BigInt(ns) / 1000000n) / 1000;
          if (BigInt(ns) > last) last = BigInt(ns);
          if (!node) { unmatched++; continue; }
          const k = kernelLog(`${new Date(t * 1000).toISOString()} ${node} ${line}`);
          const r = k.length ? k : ncclLog(line, { node, job, t });
          if (r.length) recs.push(...r.map(x => Object.assign(x, { source: `loki:${x.source}` }))); else unmatched++;
        }
      }
      n += store.append('log', recs, { dedupe: true }).written;
      if (got < limit) break;
      start = last + 1n;
    }
  }
  if (store.flush) store.flush();
  return { logs: n, lines, unmatched };
}
