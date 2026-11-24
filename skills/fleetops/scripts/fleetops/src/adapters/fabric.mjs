// Switch and NIC port counters → `port` records { switch, port, peer?, …counters } (totals, as the hardware counts).
// Root-cause analysis looks at how much each counter grew in a window, so totals from any source compare.
//
//   symbolErrors  linkRecovery  linkDowned  rcvErrors  xmitDiscards  fecUncorrected   → a bad cable, transceiver or port
//   xmitWait      pfcPause      ecnMarked   cnpSent    outOfBuffer                    → congestion
//   rxBytes       txBytes                                                             → load
//
// Sources: `perfquery` (InfiniBand, one block per port), `ibqueryerrors`, `ethtool -S` on a node (RoCE NIC counters),
// Prometheus query_range of whatever exports switch counters (UFM telemetry, SONiC, SNMP), and JSON lines.
const FIELD = [
  [/^SymbolErrorCounter/i, 'symbolErrors'], [/^LinkErrorRecoveryCounter/i, 'linkRecovery'], [/^LinkDownedCounter/i, 'linkDowned'],
  [/^PortRcvErrors/i, 'rcvErrors'], [/^PortXmitDiscards/i, 'xmitDiscards'], [/^PortXmitWait/i, 'xmitWait'], [/^PortRcvRemotePhysicalErrors/i, 'rcvErrors'],
  [/^LocalLinkIntegrityErrors/i, 'linkRecovery'], [/^ExcessiveBufferOverrunErrors/i, 'rcvErrors'], [/^PortXmitData/i, 'txBytes', 4], [/^PortRcvData/i, 'rxBytes', 4],
];
const fieldOf = name => { for (const [re, f, scale] of FIELD) if (re.test(name)) return [f, scale || 1]; return null; };
const add = (r, f, v, scale = 1) => { if (Number.isFinite(v)) r[f] = (r[f] || 0) + v * scale; };

// `perfquery [-x] LID PORT` (or `perfquery -a`), one or more blocks. switch: the name of the LID's switch (ibswitches).
export function perfquery(text, { switch: sw, t = Math.floor(Date.now() / 1000), names = {} } = {}) {
  const out = []; let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^#\s*Port (?:extended )?counters:\s*Lid\s+(\d+)\s+port\s+(\d+)/i);
    if (h) { cur = { t, switch: names[h[1]] || sw || `lid:${h[1]}`, port: +h[2], source: 'perfquery' }; out.push(cur); continue; }
    const m = line.match(/^(\w+):\.*\s*(\d+)/); if (!m || !cur) continue;
    if (m[1] === 'PortSelect') { cur.port = +m[2]; continue; }
    const f = fieldOf(m[1]); if (f) add(cur, f[0], +m[2], f[1]);
  }
  return out.map(r => Object.assign(r, { switch: String(r.switch).replace(/^switch:/, '') }));
}

// `ibqueryerrors`: 'Errors for 0x… "leaf-03"' then '   GUID 0x… port 17: [SymbolErrorCounter == 12] [LinkDownedCounter == 1]'
export function ibqueryerrors(text, { t = Math.floor(Date.now() / 1000) } = {}) {
  const out = []; let sw = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^Errors for\s+(0x[0-9a-f]+)\s+"([^"]+)"/i); if (h) { sw = h[2].trim().split(/\s+/)[0]; continue; }
    const p = line.match(/port\s+(\d+):\s*(.*)$/i); if (!p || !sw) continue;
    const r = { t, switch: sw, port: +p[1], source: 'ibqueryerrors' };
    for (const m of p[2].matchAll(/\[(\w+)\s*==\s*(\d+)\]/g)) { const f = fieldOf(m[1]); if (f) add(r, f[0], +m[2], f[1]); }
    out.push(r);
  }
  return out;
}

// `ethtool -S IFACE` on a node: the NIC side of a RoCE link. switch = the node, port = the interface.
export function ethtool(text, { node, iface = 'eth0', t = Math.floor(Date.now() / 1000) } = {}) {
  if (!node) throw new Error('ethtool needs --node');
  const r = { t, switch: node, port: iface, nic: true, source: 'ethtool' };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.\-]+):\s*(\d+)\s*$/); if (!m) continue;
    const k = m[1], v = +m[2];
    if (/^(rx|tx)_prio\d+_pause$|^(rx|tx)_pause_ctrl_phy$|^(rx|tx)_global_pause$/.test(k)) add(r, 'pfcPause', v);
    else if (/^rx_discards_phy$|^tx_discards_phy$/.test(k)) add(r, 'xmitDiscards', v);
    else if (/^rx_out_of_buffer$|out_of_buffer$/.test(k)) add(r, 'outOfBuffer', v);
    else if (/^np_cnp_sent$/.test(k)) add(r, 'cnpSent', v);
    else if (/^rp_cnp_handled$|^np_ecn_marked_roce_packets$/.test(k)) add(r, 'ecnMarked', v);
    else if (/^rx_crc_errors_phy$|^rx_symbol_err_phy$|^rx_corrected_bits_phy$/.test(k) && !/corrected/.test(k)) add(r, 'symbolErrors', v);
    else if (/^rx_pcs_symbol_err_phy$/.test(k)) add(r, 'symbolErrors', v);
    else if (/^link_down_events_phy$/.test(k)) add(r, 'linkDowned', v);
    else if (/^rx_bytes_phy$|^rx_vport_rdma_unicast_bytes$/.test(k)) add(r, 'rxBytes', v);
    else if (/^tx_bytes_phy$|^tx_vport_rdma_unicast_bytes$/.test(k)) add(r, 'txBytes', v);
  }
  return [r];
}

// The host side of an InfiniBand or RoCE port from sysfs: `grep -H . /sys/class/infiniband/*/ports/*/{counters,hw_counters}/*`,
// one "PATH:VALUE" per line. counters/ are the standard IB port counters (data in 4-byte words, like perfquery);
// hw_counters/ hold the RoCE congestion counters (CNPs, ECN marks) that ethtool -S does not show.
const IBSYS = { symbol_error: 'symbolErrors', link_error_recovery: 'linkRecovery', link_downed: 'linkDowned', port_rcv_errors: 'rcvErrors', port_xmit_discards: 'xmitDiscards',
  port_xmit_wait: 'xmitWait', port_rcv_data: 'rxBytes', port_xmit_data: 'txBytes', np_cnp_sent: 'cnpSent', np_ecn_marked_roce_packets: 'ecnMarked', rp_cnp_handled: 'cnpHandled',
  out_of_buffer: 'outOfBuffer', local_ack_timeout_err: 'ackTimeouts', out_of_sequence: 'outOfSequence', packet_seq_err: 'packetSeqErrors' };
export function ibSysfs(text, { node, t = Math.floor(Date.now() / 1000) } = {}) {
  if (!node) throw new Error('ib-sysfs needs --node');
  const by = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/\/class\/infiniband\/([\w.-]+)\/ports\/(\d+)\/(?:hw_)?counters\/(\w+):\s*(\d+)\s*$/); if (!m) continue;
    const f = IBSYS[m[3]]; if (!f) continue;
    const k = `${m[1]}/${m[2]}`; if (!by.has(k)) by.set(k, { t, switch: node, port: k, nic: true, source: 'ib-sysfs' });
    by.get(k)[f] = /^port_(rcv|xmit)_data$/.test(m[3]) ? +m[4] * 4 : +m[4];
  }
  return [...by.values()];
}

// Prometheus query_range JSON from any switch exporter. Metric names map by pattern (override with `map`), the
// switch and port from common label names.
const PROM = [
  [/xmit_?wait/i, 'xmitWait'], [/symbol_?err/i, 'symbolErrors'], [/link_?(error_)?recovery/i, 'linkRecovery'], [/link_?down/i, 'linkDowned'],
  [/rcv_?err|rx_?err|ifInErrors/i, 'rcvErrors'], [/xmit_?discard|tx_?discard|ifOutDiscards|ifInDiscards/i, 'xmitDiscards'], [/pfc|pause/i, 'pfcPause'], [/ecn/i, 'ecnMarked'],
  [/fec.*uncorrect/i, 'fecUncorrected'], [/ifHCInOctets|rx_?bytes|rcv_?data/i, 'rxBytes'], [/ifHCOutOctets|tx_?bytes|xmit_?data/i, 'txBytes'],
];
export function fabricProm(json, { map = {} } = {}) {
  const out = new Map();
  for (const s of ((json.data || json).result || [])) {
    const m = s.metric || {}, name = m.__name__ || '';
    const f = map[name] || (PROM.find(([re]) => re.test(name)) || [])[1]; if (!f) continue;
    const sw = m.switch || m.node_desc || m.device || m.hostname || m.instance || m.sysName, port = m.port || m.port_num || m.ifName || m.interface || m.ifDescr;
    if (!sw || port == null) continue;
    for (const [ts, v] of s.values || (s.value ? [s.value] : [])) {
      const k = `${sw}|${port}|${ts}`; if (!out.has(k)) out.set(k, { t: +ts, switch: String(sw).replace(/:\d+$/, ''), port: /^\d+$/.test(port) ? +port : port, source: 'prometheus' });
      add(out.get(k), f, +v);
    }
  }
  return [...out.values()];
}

// How much each counter grew over [from, to] for one port, from its records (counters can reset: a drop restarts).
export const COUNTERS = ['symbolErrors', 'linkRecovery', 'linkDowned', 'rcvErrors', 'xmitDiscards', 'fecUncorrected', 'xmitWait', 'pfcPause', 'ecnMarked', 'cnpSent', 'outOfBuffer', 'rxBytes', 'txBytes'];
export const ERROR_COUNTERS = ['symbolErrors', 'linkRecovery', 'linkDowned', 'rcvErrors', 'xmitDiscards', 'fecUncorrected'];
export const CONGESTION_COUNTERS = ['xmitWait', 'pfcPause', 'ecnMarked', 'cnpSent', 'outOfBuffer'];
export function growth(records, from, to) {
  const rs = records.filter(r => r.t >= from && r.t <= to).sort((a, b) => a.t - b.t), out = { seconds: rs.length > 1 ? rs[rs.length - 1].t - rs[0].t : 0, samples: rs.length };
  for (const c of COUNTERS) {
    let g = 0, prev = null, seen = false;
    for (const r of rs) { const v = r[c]; if (!Number.isFinite(v)) continue; seen = true; if (prev != null) g += v >= prev ? v - prev : v; prev = v; }
    if (seen) out[c] = g;
  }
  return out;
}
