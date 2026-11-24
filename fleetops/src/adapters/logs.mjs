// Logs → `log` records: { t, node, gpu?, pci?, job?, rank?, code, class, severity, msg, source }.
//
// Classes: ecc, bus, link, firmware, pcie (device); network, storage, host-memory, cpu, node (the node or what it
// shares); app (the workload); info (context, e.g. versions).  Severity: hard | soft | ignore | info.
// NVIDIA XID classes and severities come from gpu-health's fault table, so the two tools never disagree on an XID.
import { VENDORS } from '../../../gpu-health/src/vendors.mjs';
import { toEpoch } from './time.mjs';

const NV = VENDORS.nvidia.faults;
export const DEVICE_CLASSES = new Set(['ecc', 'bus', 'link', 'firmware', 'pcie']);
// XIDs gpu-health doesn't list, from NVIDIA's XID catalog (fallback when the table has no entry).
const XID_EXTRA = {
  8: ['firmware', 'soft'], 32: ['pcie', 'soft'], 38: ['firmware', 'soft'], 45: ['app', 'ignore'], 61: ['firmware', 'soft'], 62: ['firmware', 'hard'],
  68: ['firmware', 'soft'], 69: ['firmware', 'soft'], 154: ['firmware', 'hard'],
};
export function xidClass(n) {
  const d = NV[`xid${n}`];
  if (d) return [d.class, d.severity];
  return XID_EXTRA[n] || ['firmware', 'soft'];
}

// Kernel-log patterns, first match wins. `pci` captures the device, when the line names it.
const KERNEL = [
  { re: /NVRM: Xid \((?:PCI:)?([0-9a-fA-F:.]+)\): (\d+)(?:, (.*))?/, f: m => { const [cls, sev] = xidClass(+m[2]); return { code: `xid${m[2]}`, class: cls, severity: sev, pci: m[1] }; } },
  { re: /NVRM: .*NVLink.*?(?:fatal|error)(?:.*\blink (\d+))?/i, f: m => ({ code: 'nvlink_error', class: 'link', severity: 'hard', link: m[1] != null ? +m[1] : undefined }) },
  { re: /NVRM: GPU at PCI:([0-9a-fA-F:.]+).*fallen off the bus/i, f: m => ({ code: 'xid79', class: 'bus', severity: 'hard', pci: m[1] }) },
  // "nvidia 0000:3b:00.0: AER: PCIe Bus Error: severity=Corrected, …" names the device itself
  { re: /\b([0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.\d): AER: PCIe Bus Error: severity=(\w+)/, f: m => (/^Corr/i.test(m[2]) ? { code: 'pcie_aer_corrected', class: 'pcie', severity: 'soft', pci: m[1] } : { code: 'pcie_aer_uncorrected', class: 'pcie', severity: 'hard', pci: m[1] }) },
  // "pcieport 0000:3a:00.0: AER: Uncorrected (Non-Fatal) error received: 0000:3b:00.0" names it after "received"
  { re: /AER: (?:Uncorrect(?:ed|able) \((?:Fatal|Non-Fatal)\)|Multiple Uncorrected)[^:]*?error(?:.*received:? (?:id=)?([0-9a-fA-F:.]+))?/i, f: m => ({ code: 'pcie_aer_uncorrected', class: 'pcie', severity: 'hard', pci: m[1] }) },
  { re: /AER: (?:Multiple )?Corrected error(?:.*received:? (?:id=)?([0-9a-fA-F:.]+))?/i, f: m => ({ code: 'pcie_aer_corrected', class: 'pcie', severity: 'soft', pci: m[1] }) },
  { re: /amdgpu ([0-9a-fA-F:.]+):.*(?:uncorrectable|UE|fatal).*(?:error|ECC|RAS)/i, f: m => ({ code: 'ras_uncorrectable', class: 'ecc', severity: 'hard', pci: m[1] }) },
  { re: /amdgpu ([0-9a-fA-F:.]+):.*(?:correctable|CE).*(?:error|ECC|RAS)/i, f: m => ({ code: 'ras_correctable', class: 'ecc', severity: 'soft', pci: m[1] }) },
  { re: /amdgpu ([0-9a-fA-F:.]+):.*GPU reset/i, f: m => ({ code: 'amd_gpu_reset', class: 'firmware', severity: 'soft', pci: m[1] }) },
  { re: /amdgpu ([0-9a-fA-F:.]+):.*page fault/i, f: m => ({ code: 'amd_page_fault', class: 'app', severity: 'ignore', pci: m[1] }) },
  { re: /mce: \[Hardware Error\]/i, f: () => ({ code: 'mce', class: 'cpu', severity: 'hard' }) },
  { re: /\b(?:mlx5_core|mlx4_core|hfi1)\s+([0-9a-fA-F]{4}:[0-9a-fA-F:.]+)?.*(?:link (?:is )?down|Port.*\bdown|state.*DOWN)/i, f: m => ({ code: 'ib_link_down', class: 'network', severity: 'hard', pci: m[1] }) },
  { re: /\b(?:mlx5_core|mlx4_core|hfi1)\s+([0-9a-fA-F]{4}:[0-9a-fA-F:.]+)?.*(?:link (?:is )?up|Port.*ACTIVE)/i, f: m => ({ code: 'ib_link_up', class: 'network', severity: 'info', pci: m[1] }) },
  { re: /nfs: server (\S+) not responding/i, f: m => ({ code: 'nfs_timeout', class: 'storage', severity: 'hard', server: m[1] }) },
  { re: /nfs: server (\S+) OK/i, f: m => ({ code: 'nfs_ok', class: 'storage', severity: 'info', server: m[1] }) },
  { re: /LustreError|lustre.*(?:timeout|evicted)/i, f: () => ({ code: 'lustre_error', class: 'storage', severity: 'hard' }) },
  { re: /Out of memory: Kill(?:ed)? process (\d+) \(([^)]+)\)/, f: m => ({ code: 'host_oom', class: 'host-memory', severity: 'soft', pid: +m[1], process: m[2] }) },
  { re: /EDAC .*(?:UE|uncorrected)/i, f: () => ({ code: 'dimm_ue', class: 'host-memory', severity: 'hard' }) },
  { re: /EDAC .*(?:CE|corrected)/i, f: () => ({ code: 'dimm_ce', class: 'host-memory', severity: 'soft' }) },
];

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// One log line's time and the rest of the line. Formats:
//   journalctl -o short-iso / RFC 3339:  2026-11-23T10:00:01+0000 host kernel: …
//   dmesg -T:                            [Mon Nov 23 10:00:01 2026] …            (host local time: utcOffset)
//   dmesg (raw):                         [ 1234.567890] …                        (seconds since boot: boot)
//   syslog:                              Nov 23 10:00:01 host kernel: …           (no year: year; local time: utcOffset)
export function lineTime(line, { boot, year, utcOffset = 0 } = {}) {
  let m;
  if ((m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(\S+)\s+(.*)$/))) return { t: toEpoch(m[1].replace(',', '.')), host: m[2], rest: m[3] };
  if ((m = line.match(/^\[\w{3} (\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\]\s?(.*)$/))) return { t: Date.UTC(+m[6], MON[m[1]], +m[2], +m[3], +m[4], +m[5]) / 1000 - utcOffset * 3600, rest: m[7] };
  if ((m = line.match(/^\[\s*(\d+\.\d+)\]\s?(.*)$/))) return { t: boot != null ? boot + +m[1] : null, rest: m[2] };
  if ((m = line.match(/^(\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\S+) (.*)$/)) && MON[m[1]] != null) return { t: Date.UTC(year ?? new Date().getUTCFullYear(), MON[m[1]], +m[2], +m[3], +m[4], +m[5]) / 1000 - utcOffset * 3600, host: m[6], rest: m[7] };
  if ((m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/))) return { t: toEpoch(m[1]), rest: m[2] }; // kubectl logs --timestamps
  return { t: null, rest: line };
}

const normPci = p => {
  if (!p) return undefined;
  const s = String(p).toLowerCase().replace(/:$/, '').replace(/\.\d$/, '');
  const parts = s.split(':');
  // 3b:00 → 0000:3b:00; 00000000:3b:00 → 0000:3b:00
  if (parts.length === 2) return `0000:${parts[0].padStart(2, '0')}:${parts[1]}`;
  return `${parts[0].slice(-4).padStart(4, '0')}:${parts[1]}:${parts[2]}`;
};
export { normPci };

// Kernel log text (any of the formats above) → log records.
//   node:     the host, when the format doesn't carry it (dmesg)
//   pciMap:   { node: { '0000:3b:00': gpuIndex } } or { '0000:3b:00': gpuIndex }, from nvidiaSmiQ(); fills `gpu`
export function kernelLog(text, { node, boot, year, utcOffset = 0, pciMap = {}, keepInfo = false } = {}) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { t, host, rest } = lineTime(line, { boot, year, utcOffset });
    for (const p of KERNEL) {
      const m = rest.match(p.re);
      if (!m) continue;
      const r = p.f(m);
      if (r.severity === 'info' && !keepInfo) break;
      const n = host || node;
      if (t == null || !n) break;
      const pci = normPci(r.pci), map = pciMap[n] && typeof pciMap[n] === 'object' ? pciMap[n] : pciMap;
      const rec = Object.assign({ t, node: n }, r, { pci, msg: rest.replace(/^kernel:\s*/, '').slice(0, 300), source: 'kernel' });
      if (pci && map[pci] != null && DEVICE_CLASSES.has(r.class)) rec.gpu = String(map[pci]); // a NIC's address is not a GPU
      for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
      out.push(rec);
      break;
    }
  }
  return out;
}

// NCCL and PyTorch distributed logs (stdout of a training job) → log records. Lines usually look like
//   host:pid:tid [rank] NCCL WARN …           or, with `kubectl logs --timestamps`, an ISO time first.
// NCCL's own lines carry no time: pass `t` (the log's start or the job end) for those.
const APP = [
  { re: /Watchdog caught collective operation timeout: WorkNCCL\(SeqNum=(\d+), OpType=(\w+).*?ran for (\d+) milliseconds/, f: m => ({ code: 'nccl_timeout', class: 'network', severity: 'hard', op: m[2], seq: +m[1], ms: +m[3] }) },
  { re: /NCCL WARN NET\/IB.*(?:Got completion|error)\D*(\d+)?/i, f: m => ({ code: 'nccl_ib_error', class: 'network', severity: 'hard', status: m[1] != null ? +m[1] : undefined }) },
  { re: /NCCL WARN .*(?:Connection (?:closed|reset|refused)|socket|remote process exited)/i, f: () => ({ code: 'nccl_peer_lost', class: 'network', severity: 'soft' }) },
  { re: /NCCL WARN Cuda failure '([^']+)'/, f: m => ({ code: 'nccl_cuda_failure', class: /ECC|uncorrectable/i.test(m[1]) ? 'ecc' : 'app', severity: 'hard', detail: m[1] }) },
  { re: /(?:NCCL error|ncclInternalError|ncclSystemError|unhandled system error)/i, f: () => ({ code: 'nccl_system_error', class: 'network', severity: 'soft' }) },
  { re: /CUDA error: uncorrectable ECC error/i, f: () => ({ code: 'cuda_ecc_uncorrectable', class: 'ecc', severity: 'hard' }) },
  { re: /CUDA error: an illegal memory access/i, f: () => ({ code: 'cuda_illegal_access', class: 'app', severity: 'soft' }) },
  { re: /(?:torch\.(?:cuda\.)?OutOfMemoryError|CUDA out of memory)/, f: () => ({ code: 'cuda_oom', class: 'app', severity: 'soft' }) },
  { re: /NCCL INFO NCCL version (\S+)/, f: m => ({ code: 'nccl_version', class: 'info', severity: 'info', version: m[1].replace(/\+.*/, '') }) },
];
export function ncclLog(text, { node, job, t: t0, keepInfo = true } = {}) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const lt = lineTime(line);
    const rest = lt.rest;
    const hm = rest.match(/^([\w.-]+):(\d+):(\d+) \[(\d+)\]/), rm = rest.match(/\[[Rr]ank (\d+)\]/);
    for (const p of APP) {
      const m = rest.match(p.re);
      if (!m) continue;
      const r = p.f(m);
      if (r.severity === 'info' && !keepInfo) break;
      const t = lt.t ?? t0;
      const n = (hm && hm[1]) || node;
      if (t == null || !n) break;
      const rec = Object.assign({ t, node: n }, r, { job, rank: rm ? +rm[1] : hm ? +hm[4] : undefined, msg: rest.slice(0, 300), source: 'app-log' });
      for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
      out.push(rec);
      break;
    }
  }
  return out;
}

// Device faults from logs, as gpu-health results: { t, kind: 'fault', node, gpu, code }.
export function toGpuHealthFaults(logs) {
  return logs.filter(l => l.gpu != null && DEVICE_CLASSES.has(l.class) && l.severity !== 'ignore' && l.severity !== 'info')
    .map(l => ({ t: l.t, kind: 'fault', node: l.node, gpu: l.gpu, code: l.code, source: 'log' }));
}
