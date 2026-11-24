#!/usr/bin/env node
// Scale benchmark for milestone 7: sustained ingest and a 24-hour root-cause query, measured.
//
//   node tools/bench-scale.mjs [--gpus 1000] [--interval 10] [--hours 26] [--backend jsonl|parquet|both]
//                              [--min-ingest 3000] [--max-rca 10] [--dir DIR]
//
// 1. Ingest: DCGM exporter series for --gpus GPUs (15 metrics each) as Prometheus remote_write payloads (snappy +
//    protobuf, 1,000 GPUs per request) go through the same decode → map → pipeline → store path as `fleetops serve`.
//    Reported in device samples per second; 10,000 GPUs every 10 s needs 1,000/s sustained.
// 2. Root-cause query: a store holding --hours of device samples for --gpus GPUs every --interval s, a failure burst
//    on four nodes at the end; time `diagnose` on it (it reads 24 h of context), with and without the hourly rollup.
// --min-ingest / --max-rca make it a gate (exit 6).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../src/store.mjs';
import { snappyCompressLiteral, encodeWriteRequest, snappyDecompress, decodeWriteRequest } from '../src/proto.mjs';
import { seriesToDevices, Pipeline } from '../src/ingest.mjs';
import { diagnose } from '../src/rca.mjs';
import { rollup, rollupStore } from '../src/retention.mjs';

const o = {}; const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith('--')) { const nx = av[i + 1]; o[av[i].slice(2)] = nx === undefined || nx.startsWith('--') ? true : (i++, nx); }
const GPUS = +(o.gpus || 1000), IV = +(o.interval || 10), HOURS = +(o.hours || 26), PER_NODE = 8;
const backends = o.backend === 'both' ? ['jsonl', 'parquet'] : [o.backend || 'jsonl'];
const METRICS = ['DCGM_FI_DEV_GPU_TEMP', 'DCGM_FI_DEV_POWER_USAGE', 'DCGM_FI_PROF_SM_ACTIVE', 'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE', 'DCGM_FI_PROF_DRAM_ACTIVE', 'DCGM_FI_DEV_FB_USED', 'DCGM_FI_DEV_FB_TOTAL', 'DCGM_FI_DEV_SM_CLOCK', 'DCGM_FI_DEV_MAX_SM_CLOCK', 'DCGM_FI_DEV_MEMORY_TEMP', 'DCGM_FI_DEV_ECC_SBE_AGG_TOTAL', 'DCGM_FI_DEV_ECC_DBE_AGG_TOTAL', 'DCGM_FI_DEV_PCIE_LINK_WIDTH', 'DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL', 'DCGM_FI_DEV_XID_ERRORS'];
const node = g => `gpu-${String(Math.floor(g / PER_NODE)).padStart(4, '0')}`;
const val = (m, g, t) => (m === 'DCGM_FI_DEV_XID_ERRORS' ? 0 : m.includes('TEMP') ? 55 + ((g + t) % 20) : m.includes('PROF') ? ((g * 7 + t) % 100) / 100 : 1000 + (g % 500));
const open = async (b, dir) => { if (b === 'parquet') { const { ParquetStore } = await import('../src/parquet-store.mjs'); return new ParquetStore(dir); } return new DataStore(dir); };
const fmt = n => Math.round(n).toLocaleString('en-US');
const results = { gpus: GPUS, interval: IV, hours: HOURS, backends: {} };
let fail = false;

for (const b of backends) {
  const base = o.dir ? path.resolve(o.dir, b) : fs.mkdtempSync(path.join(os.tmpdir(), `fleetops-scale-${b}-`));
  const r = results.backends[b] = {};

  // ---- 1. ingest ----
  const ing = await open(b, path.join(base, 'ingest')), pipe = new Pipeline(ing, { maxQueue: 5e6, batch: 100000 });
  const t0 = Date.UTC(2026, 0, 10) / 1000, scrapes = 6; // one minute of 10 s scrapes for every GPU
  const payloads = [];
  for (let s = 0; s < scrapes; s++) for (let lo = 0; lo < GPUS; lo += 1000) {
    const series = [];
    for (let g = lo; g < Math.min(GPUS, lo + 1000); g++) for (const m of METRICS) series.push({ labels: { __name__: m, Hostname: node(g), gpu: String(g % PER_NODE), modelName: 'NVIDIA H100 80GB HBM3' }, samples: [{ v: val(m, g, s), t: t0 + s * 10 }] });
    payloads.push(snappyCompressLiteral(encodeWriteRequest(series)));
  }
  const tA = process.hrtime.bigint();
  let samples = 0;
  for (const p of payloads) { const d = seriesToDevices(decodeWriteRequest(snappyDecompress(p))); samples += d.devices.length; pipe.offer('device', d.devices); }
  pipe.flush();
  const secs = Number(process.hrtime.bigint() - tA) / 1e9;
  r.ingest = { samples, seconds: +secs.toFixed(2), perSecond: Math.round(samples / secs), needed10kAt10s: 1000, headroom: +(samples / secs / 1000).toFixed(1) };
  if (ing.close) ing.close();
  console.log(`[${b}] ingest: ${fmt(samples)} device samples (${METRICS.length} metrics each, remote_write) in ${secs.toFixed(2)} s = ${fmt(samples / secs)}/s; 10,000 GPUs at 10 s needs 1,000/s (${r.ingest.headroom}× headroom)`);
  if (o['min-ingest'] && samples / secs < +o['min-ingest']) { console.error(`  below --min-ingest ${o['min-ingest']}`); fail = true; }

  // ---- 2. 24 h root-cause query ----
  const st = await open(b, path.join(base, 'rca')), end = t0 + HOURS * 3600, nodes = Math.ceil(GPUS / PER_NODE);
  const tB = process.hrtime.bigint();
  let n = 0, batch = [];
  for (let t = t0; t < end; t += IV) {
    for (let g = 0; g < GPUS; g++) batch.push({ t, node: node(g), gpu: String(g % PER_NODE), vendor: 'nvidia', kind: 'gpu', sku: 'H100', sm: val('PROF', g, t), tempC: val('TEMP', g, t), faults: g === 13 && t > end - 1800 && t < end - 1700 ? ['xid79'] : [] });
    if (batch.length >= 200000) { n += st.append('device', batch).written; batch = []; }
  }
  if (batch.length) n += st.append('device', batch).written;
  const jobs = [], pl = [];
  for (let i = 0; i < 40; i++) { const nd = node(8 + (i % 4) * 8), t = end - 3000 + i * 60; pl.push({ t: t - 600, job: `j${i}`, owner: `team-${i % 5}`, namespace: `ns-${i % 5}`, start: t - 600, devices: [{ node: nd, gpu: '0' }] }); jobs.push({ t, job: `j${i}`, status: 'failed', cause: 'unknown', start: t - 600, end: t, devices: [{ node: nd, gpu: '0' }] }); }
  for (let i = 0; i < nodes; i++) { const t = end - 20 * 3600 + (i % 60) * 60; pl.push({ t: t - 600, job: `ok${i}`, owner: `team-${i % 5}`, namespace: `ns-${i % 5}`, start: t - 600, devices: [{ node: node(i * PER_NODE), gpu: '1' }] }); jobs.push({ t, job: `ok${i}`, status: 'ok', cause: 'unknown', start: t - 600, end: t }); }
  st.append('placement', pl); st.append('job', jobs); if (st.flush) st.flush();
  const loadS = Number(process.hrtime.bigint() - tB) / 1e9;
  const inc = { symptom: 'job-failures', from: end - 3000, to: end };
  let tC = process.hrtime.bigint(), d = diagnose(st, inc);
  const rcaS = Number(process.hrtime.bigint() - tC) / 1e9;
  await rollup(st, { steps: [3600] }); st.coarse = await rollupStore(st, 3600);
  tC = process.hrtime.bigint(); const d2 = diagnose(st, inc);
  const rcaRollupS = Number(process.hrtime.bigint() - tC) / 1e9;
  const size = dir => { let t = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) t += e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size; return t; };
  r.rca = { deviceSamples: n, hours: HOURS, loadSeconds: +loadS.toFixed(1), storeMB: Math.round(size(path.join(base, 'rca')) / 1e6), diagnoseSeconds: +rcaS.toFixed(2), diagnoseWithRollupSeconds: +rcaRollupS.toFixed(2), top: d.hypotheses[0] && d.hypotheses[0].rule, sameAnswer: (d.hypotheses[0] || {}).rule === (d2.hypotheses[0] || {}).rule };
  console.log(`[${b}] root-cause: ${fmt(n)} device samples over ${HOURS} h (${GPUS} GPUs every ${IV} s, ${r.rca.storeMB} MB, loaded in ${loadS.toFixed(1)} s); diagnose ${rcaS.toFixed(2)} s, with the hourly rollup ${rcaRollupS.toFixed(2)} s; top: ${r.rca.top}${r.rca.sameAnswer ? '' : ' (rollup changed the answer!)'}`);
  if (o['max-rca'] && Math.min(rcaS, rcaRollupS) > +o['max-rca']) { console.error(`  above --max-rca ${o['max-rca']} s`); fail = true; }
  if (st.close) st.close();
  if (!o.dir) fs.rmSync(base, { recursive: true, force: true });
}
if (o.json) console.log(JSON.stringify(results, null, 1));
if (fail) process.exitCode = 6;
