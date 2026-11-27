// Adapters: what a cluster already has → usage records. Each one is a pure function of file contents (or a stream,
// for traces too big to load), so it runs anywhere and is easy to test.
import fs from 'node:fs';
import readline from 'node:readline';
import { gpuKey } from './core.mjs';

// a time that doesn't parse is no time (null), not NaN: the record is dropped or the time left open
const t = s => { if (s == null || s === '' || s === 'Unknown' || s === 'None') return null; if (typeof s === 'number') return s; const v = Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') / 1000); return Number.isFinite(v) ? v : null; };
const splitCsv = line => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
export const parseCsv = text => { const lines = text.split(/\r?\n/).filter(l => l.trim()); const head = splitCsv(lines[0]).map(h => h.trim()); return lines.slice(1).map(l => { const v = splitCsv(l); return Object.fromEntries(head.map((h, i) => [h, v[i]])); }); };

// ---------- utilization from samples ----------
// samples: [[t, util 0–1]] for one GPU at a fixed step. busy = share of samples above the idle threshold;
// idleLong = GPU-seconds in idle runs at least `longS` long (what an idle timeout would return).
export function utilAcc({ step = 60, idle = 0.05, longS = 1800 } = {}) {
  let n = 0, busy = 0, smSum = 0, run = 0, idleLong = 0;
  return {
    add(u) { if (u == null || Number.isNaN(u)) return; n++; if (u > idle) { busy++; smSum += u; if (run * step >= longS) idleLong += run * step; run = 0; } else run++; },
    done() { if (run * step >= longS) { idleLong += run * step; run = 0; } return n ? { n, busy: busy / n, sm: busy ? smSum / busy : 0, idleLong } : null; },
  };
}
export function utilStats(samples, o = {}) { const a = utilAcc(o); for (const [, u] of samples) a.add(u); return a.done(); }
// merge per-GPU stats into one allocation's util (means weighted by samples; idle stretches add up)
export function mergeUtil(per, memPeak) {
  const xs = per.filter(Boolean); if (!xs.length) return memPeak != null ? { memPeak } : null;
  const n = xs.reduce((a, x) => a + x.n, 0), busyN = xs.reduce((a, x) => a + x.busy * x.n, 0);
  return { busy: busyN / n, sm: busyN ? xs.reduce((a, x) => a + x.sm * x.busy * x.n, 0) / busyN : 0, idleLong: xs.reduce((a, x) => a + x.idleLong, 0), samples: n, ...(memPeak != null ? { memPeak } : {}) };
}

// ---------- Kubernetes ----------
// pods: `kubectl get pods -A -o json`; nodes: `kubectl get nodes -o json` (GPU product labels);
// prom: Prometheus query_range responses for DCGM_FI_PROF_SM_ACTIVE or DCGM_FI_DEV_GPU_UTIL, DCGM_FI_DEV_FB_USED and
// DCGM_FI_DEV_FB_FREE (labels pod/namespace, or exported_pod/exported_namespace), and vllm:generation_tokens_total,
// vllm:prompt_tokens_total, vllm:request_success_total (labels pod, model_name). One record per pod, or per pod-hour
// for serving pods with vLLM counters.
const GPU_RES = ['nvidia.com/gpu', 'amd.com/gpu', 'habana.ai/gaudi', 'gpu.intel.com/i915'];
export function k8s({ pods, nodes, prom = [], cluster = null, now = Math.floor(Date.now() / 1000), provider } = {}) {
  const items = (pods && pods.items) || [], nodeGpu = {};
  for (const n of (nodes && nodes.items) || []) { const l = n.metadata.labels || {}; nodeGpu[n.metadata.name] = l['nvidia.com/gpu.product'] || l['amd.com/gpu.product-name'] || l['node.kubernetes.io/instance-type'] || null; }
  // series by namespace/pod
  const series = new Map(), key = (ns, p) => `${ns}/${p}`;
  for (const resp of prom) for (const s of ((resp.data || resp).result || [])) {
    const m = s.metric || {}, name = m.__name__ || resp.metric || '', pod = m.pod || m.exported_pod || m.kubernetes_pod_name, ns = m.namespace || m.exported_namespace || m.kubernetes_namespace;
    if (!pod) continue;
    const k = key(ns, pod); if (!series.has(k)) series.set(k, []);
    series.get(k).push({ name, gpu: m.gpu || m.UUID || m.device || '0', model: m.model_name, values: (s.values || []).map(([ts, v]) => [+ts, +v]) });
  }
  const out = [];
  for (const p of items) {
    const md = p.metadata || {}, spec = p.spec || {}, st = p.status || {};
    let gpus = 0;
    for (const c of spec.containers || []) { const lim = Object.assign({}, (c.resources || {}).requests, (c.resources || {}).limits); for (const r of GPU_RES) if (lim[r]) gpus += +lim[r]; }
    if (!gpus) continue;
    const start = t(st.startTime) ?? t(md.creationTimestamp); if (start == null) continue;
    const term = (st.containerStatuses || []).map(c => (c.state || {}).terminated).filter(Boolean);
    const end = term.length ? Math.max(...term.map(x => t(x.finishedAt))) : (st.phase === 'Running' || st.phase === 'Pending' ? null : now);
    const status = st.phase === 'Succeeded' ? 'succeeded' : st.phase === 'Failed' ? (term.some(x => /OOMKilled|Error/.test(x.reason || '')) || !/Evicted|Preempt/i.test(st.reason || '') ? 'failed' : 'preempted') : st.phase === 'Running' ? 'running' : st.reason === 'Evicted' ? 'preempted' : 'succeeded';
    const owner = (md.ownerReferences || [])[0] || {}, labels = md.labels || {};
    const kind = labels['notebook-name'] || /jupyter|notebook/.test(md.name) ? 'notebook' : owner.kind === 'ReplicaSet' || owner.kind === 'StatefulSet' && !/train/.test(md.name) ? 'deployment' : 'job';
    const name = labels['job-name'] || labels['training.kubeflow.org/job-name'] || labels['jobset.sigs.k8s.io/jobset-name'] || labels.app || labels['app.kubernetes.io/name'] || (owner.kind === 'ReplicaSet' ? owner.name.replace(/-[a-z0-9]{8,10}$/, '') : owner.name) || md.name;
    const ser = series.get(key(md.namespace, md.name)) || [];
    const util = ser.filter(s => /SM_ACTIVE|GPU_UTIL/.test(s.name)), useSm = util.some(s => /SM_ACTIVE/.test(s.name));
    const per = util.filter(s => /SM_ACTIVE/.test(s.name) === useSm).map(s => { const step = s.values.length > 1 ? s.values[1][0] - s.values[0][0] : 60; return utilStats(s.values.map(([ts, v]) => [ts, /GPU_UTIL/.test(s.name) ? v / 100 : v]), { step }); });
    const used = ser.filter(s => /FB_USED/.test(s.name)), free = ser.filter(s => /FB_FREE/.test(s.name));
    let memPeak = null;
    for (const u of used) { const f = free.find(x => x.gpu === u.gpu); if (!f) continue; const fm = new Map(f.values); for (const [ts, v] of u.values) if (fm.has(ts)) memPeak = Math.max(memPeak || 0, v / (v + fm.get(ts))); }
    const base = { id: md.uid || `${md.namespace}/${md.name}`, start, end, gpus, gpuType: gpuKey(nodeGpu[spec.nodeName]), node: spec.nodeName, cluster, provider, kind, name, namespace: md.namespace, labels, group: name, status, util: mergeUtil(per, memPeak) };
    if (base.util && !useSm) base.util.smSource = 'gpu_util';
    const tok = ser.filter(s => /generation_tokens_total/.test(s.name)), pin = ser.filter(s => /prompt_tokens_total/.test(s.name)), rq = ser.filter(s => /request_success_total/.test(s.name));
    if (!tok.length) { out.push(base); continue; }
    // serving pods: one record per hour with the counters' increase in that hour
    const model = tok[0].model, inc = (ss, a, b) => ss.reduce((acc, s) => { let first = null, prev = null, sum = 0; for (const [ts, v] of s.values) { if (ts < a || ts > b) continue; if (prev != null) sum += v >= prev ? v - prev : v; prev = v; first ??= v; } return acc + sum; }, 0);
    const e = end ?? now;
    for (let h = Math.floor(start / 3600) * 3600; h < e; h += 3600) {
      const a = Math.max(start, h), b = Math.min(e, h + 3600);
      out.push(Object.assign({}, base, { id: `${base.id}@${h}`, start: a, end: b, status: b === end ? status : 'running', serving: { model, tokensOut: inc(tok, a, b), tokensIn: inc(pin, a, b), requests: inc(rq, a, b) } }));
    }
  }
  return out;
}

// ---------- Slurm ----------
// sacct -a -P -X --format=JobID,JobName,User,Account,Partition,State,Start,End,NodeList,AllocTRES[,Comment]
const SLURM_STATE = { COMPLETED: 'succeeded', FAILED: 'failed', NODE_FAIL: 'failed', OUT_OF_MEMORY: 'failed', TIMEOUT: 'failed', BOOT_FAIL: 'failed', DEADLINE: 'failed', CANCELLED: 'cancelled', PREEMPTED: 'preempted', REQUEUED: 'preempted', RUNNING: 'running' };
export function slurm(text, { cluster = null, gpuType = null, now = Math.floor(Date.now() / 1000), provider } = {}) {
  const lines = text.split(/\r?\n/).filter(Boolean), head = lines[0].split('|'), out = [];
  for (const l of lines.slice(1)) {
    const r = Object.fromEntries(head.map((h, i) => [h, l.split('|')[i]]));
    if (/\./.test(r.JobID || '')) continue;                      // job steps: the allocation is the job
    const tres = r.AllocTRES || '', m = tres.match(/gres\/gpu(?::([\w.-]+))?=(\d+)/g);
    if (!m) continue;
    let gpus = 0, type = gpuType;
    for (const x of m) { const mm = x.match(/gres\/gpu(?::([\w.-]+))?=(\d+)/); if (mm[1]) { type = type || mm[1]; gpus = Math.max(gpus, +mm[2]); } else gpus = Math.max(gpus, +mm[2]); }
    const start = t(r.Start); if (start == null || !gpus) continue;
    const state = (r.State || '').split(' ')[0];
    out.push({ id: `${cluster || 'slurm'}:${r.JobID}`, start, end: state === 'RUNNING' ? null : t(r.End) ?? now, gpus, gpuType: gpuKey(type), cluster, provider, kind: 'job', name: r.JobName, group: r.JobName,
      user: r.User || undefined, team: r.Account || undefined, labels: { partition: r.Partition, account: r.Account, ...(r.Comment ? { comment: r.Comment } : {}) }, node: r.NodeList, status: SLURM_STATE[state] || 'succeeded' });
  }
  return out;
}

// ---------- OpenCost / Kubecost allocation API ----------
// GET /allocation?window=7d&aggregate=pod&step=1h → { data: [ { name: { properties, window, gpuCount, gpuHours, ... } } ] }
export function opencost(json, { cluster = null, provider } = {}) {
  const out = [];
  for (const set of json.data || []) for (const [name, a] of Object.entries(set || {})) {
    if (!a || !(a.gpuHours > 0) || name.startsWith('__')) continue;
    const pr = a.properties || {}, s = t(a.start || (a.window || {}).start), e = t(a.end || (a.window || {}).end);
    if (s == null || e == null || e <= s) continue;
    const gpus = a.gpuHours / ((e - s) / 3600);
    out.push({ id: `${pr.cluster || cluster || ''}/${pr.namespace || ''}/${pr.pod || name}@${s}`, start: s, end: e, gpus, cluster: pr.cluster || cluster, provider, node: pr.node, namespace: pr.namespace,
      name: pr.controller || pr.pod || name, kind: /replicaset|deployment|statefulset/i.test(pr.controllerKind || '') ? 'deployment' : 'job', labels: pr.labels || {}, group: pr.controller || pr.pod,
      gpuType: gpuKey((a.gpuAllocation || {}).gpuModel || (pr.labels || {}).nvidia_com_gpu_product), status: 'running',
      opencost: { gpuCost: a.gpuCost, gpuCostAdjustment: a.gpuCostAdjustment } });
  }
  return out;
}

// ---------- generic CSV ----------
// map: { start: 'Start', end: 'End', gpus: 'GPUs', user: 'Owner', … } (fields of the usage record → column names)
export function csv(text, { map = {}, cluster = null, provider } = {}) {
  const rows = parseCsv(text), col = (r, f) => r[map[f] || f];
  return rows.map((r, i) => ({ id: col(r, 'id') || `csv:${i}`, start: t(col(r, 'start')), end: t(col(r, 'end')), gpus: +col(r, 'gpus'), gpuType: gpuKey(col(r, 'gpuType')), cluster: col(r, 'cluster') || cluster, provider: col(r, 'provider') || provider,
    name: col(r, 'name'), namespace: col(r, 'namespace'), user: col(r, 'user'), team: col(r, 'team'), org: col(r, 'org'), project: col(r, 'project'), useCase: col(r, 'useCase'), status: col(r, 'status'), group: col(r, 'group') || col(r, 'name'),
    util: col(r, 'busy') != null && col(r, 'busy') !== '' ? { busy: +col(r, 'busy'), sm: col(r, 'sm') ? +col(r, 'sm') : undefined, memPeak: col(r, 'memPeak') ? +col(r, 'memPeak') : undefined } : undefined }))
    .filter(r => r.start != null && r.gpus > 0);
}

// ---------- public traces (for validation on real data) ----------
// Acme (Shanghai AI Lab, Kalos cluster, 2023): user, workload type, state, GPUs, start/end. No utilization.
const ACME_USE = { Pretrain: 'training', SFT: 'fine-tuning', Eval: 'evaluation', Debug: 'interactive', Other: 'other', MLLM: 'training' };
const ACME_STATE = { COMPLETED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled', RUNNING: 'running', TIMEOUT: 'failed', NODE_FAIL: 'failed' };
export function acme(text, { cluster = 'kalos', gpuType = 'A100' } = {}) {
  return parseCsv(text).filter(r => +r.gpu_num > 0).map(r => ({ id: r.job_id, start: t(r.start_time), end: t(r.end_time), gpus: +r.gpu_num, gpuType, cluster, kind: 'job', user: r.user, useCase: ACME_USE[r.type] || 'other',
    status: ACME_STATE[r.state] || 'succeeded', name: r.type, group: r.job_id })).filter(r => r.start != null && (r.end == null || r.end >= r.start));
}

// Philly (Microsoft, 2017): job attempts with machines and GPUs, a per-GPU utilization log, machine list. Streams the
// utilization log (gigabytes) once. Earlier attempts of a job failed (Philly retries failures); the last carries the
// job's status. Utilization is nvidia-smi GPU util, not SM activity.
const PHILLY_STATE = { Pass: 'succeeded', Failed: 'failed', Killed: 'cancelled' };
// US Pacific wall time → epoch s (DST from the second Sunday of March to the first Sunday of November, 2 a.m.)
export function pacific(s) {
  if (s == null || s === 'None' || s === '') return null;
  const m = String(s).match(/(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/); if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number), wall = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
  const sunday = (month, nth) => { const first = new Date(Date.UTC(y, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (nth - 1); };
  const dstStart = Date.UTC(y, 2, sunday(2, 2), 2) / 1000, dstEnd = Date.UTC(y, 10, sunday(10, 1), 2) / 1000;
  const zone = / PDT/.test(s) ? 7 : / PST/.test(s) ? 8 : (wall >= dstStart && wall < dstEnd ? 7 : 8);
  return wall + zone * 3600;
}
export async function philly({ jobs, utilPath, machines, from = -Infinity, to = Infinity, cluster = 'philly', step = 60 }) {
  const memOf = {}; for (const m of machines || []) memOf[m.machineId] = m.mem;
  const typeOf = ip => (memOf[ip] ? `philly-${memOf[ip]}` : 'philly');
  const recs = [], byMachine = new Map();
  for (const j of jobs) {
    const atts = j.attempts || [];
    atts.forEach((a, i) => {
      const s = pacific(a.start_time), e = pacific(a.end_time); if (s == null || e == null || e <= s || e < from || s > to) return;
      const gpus = (a.detail || []).reduce((n, d) => n + (d.gpus || []).length, 0); if (!gpus) return;
      const last = i === atts.length - 1;
      const r = { id: `${j.jobid}#${i}`, start: s, end: e, gpus, gpuType: typeOf((a.detail[0] || {}).ip), cluster, kind: 'job', user: j.user, team: j.vc, group: j.jobid, name: j.jobid,
        status: last ? PHILLY_STATE[j.status] || 'succeeded' : 'failed', node: (a.detail || []).map(d => d.ip).join(','), _acc: {} };
      recs.push(r);
      for (const d of a.detail || []) for (const g of d.gpus || []) { const k = `${d.ip}|${g}`; if (!byMachine.has(d.ip)) byMachine.set(d.ip, []); byMachine.get(d.ip).push({ r, g, k }); }
    });
  }
  const seen = new Set();
  if (utilPath) {
    const rl = readline.createInterface({ input: fs.createReadStream(utilPath), crlfDelay: Infinity });
    let head = null;
    for await (const line of rl) {
      if (!head) { head = line.split(','); continue; }
      const f = line.split(','), ts = pacific(f[0]);
      if (ts < from || ts > to) continue;
      for (let i = 2; i < 10; i++) if (f[i] && f[i] !== 'NA') seen.add(`${f[1]}|${i - 2}`);
      const list = byMachine.get(f[1]); if (!list) continue;
      for (const x of list) {
        if (ts < x.r.start || ts >= x.r.end) continue;
        const v = f[2 + +x.g.replace('gpu', '')]; if (v == null || v === '' || v === 'NA') continue;
        (x.r._acc[x.g] || (x.r._acc[x.g] = utilAcc({ step }))).add(+v / 100);
      }
    }
    for (const r of recs) { const per = Object.values(r._acc).map(a => a.done()); r.util = mergeUtil(per); if (r.util) r.util.smSource = 'gpu_util'; }
  }
  for (const r of recs) delete r._acc;
  // the GPUs that exist are the ones that report utilization (the machine list's GPU counts are not reliable)
  const inv = new Map(); for (const k of seen) { const ty = typeOf(k.split('|')[0]); inv.set(ty, (inv.get(ty) || 0) + 1); }
  recs.inventory = [...inv].map(([gpuType, gpus]) => ({ cluster, gpuType, gpus }));
  return recs;
}
export function phillyMachines(text) {
  return text.split(/\r?\n/).slice(1).filter(Boolean).map(l => { const [id, n, mem] = l.split(',').map(x => x.trim()); return { machineId: id, gpus: +n, mem }; });
}
