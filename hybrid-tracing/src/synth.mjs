// Synthetic hybrid traces with known clock offsets, for tests and demos.
// On-prem: gateway, router and prefill hosts (PTP-synced, offsets of a few µs).
// Neocloud: decode hosts with millisecond offsets, plus one host reached only one-way (streaming back to the gateway)
// and one host with no cross-machine spans at all. Cross-site network delay is asymmetric, as WAN paths are.

export const TRUE_OFFSETS_NS = {
  'gw-1': 0, 'router-1': 3_000, 'prefill-1': -2_000, 'prefill-2': 1_500, 'prefill-3': 800, 'prefill-4': -1_200,
  'decode-1': 2_700_000, 'decode-2': -1_400_000, 'decode-3': 350_000, 'decode-4': 5_100_000, 'decode-5': -800_000, 'decode-6': 12_000_000,
  'stream-1': 7_500_000, 'batch-1': -3_000_000,
};
const SITE = d => /^(gw|router|prefill)/.test(d) ? 'onprem' : 'neocloud';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

export function generate(opts = {}) {
  const r = rng(opts.seed || 7);
  const n = opts.requests || 400;
  const offsets = Object.assign({}, TRUE_OFFSETS_NS, opts.offsets || {});
  const fwd = opts.crossSiteForwardNs || 900_000, back = opts.crossSiteBackNs || 700_000; // asymmetric WAN path
  const jitter = () => Math.floor(r() * r() * 600_000); // mostly small, sometimes large queueing delays
  const lan = () => 40_000 + Math.floor(r() * 30_000);
  const byDomain = new Map();
  const add = (domain, span) => { if (!byDomain.has(domain)) byDomain.set(domain, []); byDomain.get(domain).push(span); };
  const T0 = 1_795_000_000_000_000_000n;
  const mk = (traceId, spanId, parent, name, kind, domain, startTrue, endTrue) => add(domain, {
    traceId, spanId, parentSpanId: parent, name, kind,
    startTimeUnixNano: String(T0 + BigInt(Math.round(startTrue + offsets[domain]))),
    endTimeUnixNano: String(T0 + BigInt(Math.round(endTrue + offsets[domain]))),
    attributes: [],
  });
  for (let i = 0; i < n; i++) {
    const tid = hex(r, 32), t = i * 25_000_000;
    const pre = 'prefill-' + (1 + (i % 4)), dec = 'decode-' + (1 + (i % 6));
    const ids = Array.from({ length: 9 }, () => hex(r, 16));
    // gateway -> router (LAN)
    const rtOut = lan(), rtBack = lan();
    const prefillDur = 80_000_000 + Math.floor(r() * 120_000_000), decodeDur = 300_000_000 + Math.floor(r() * 900_000_000);
    const routeStart = t + 200_000, routeSrvStart = routeStart + rtOut, routeSrvEnd = routeSrvStart + 500_000, routeEnd = routeSrvEnd + rtBack;
    // router -> prefill (LAN)
    const pOut = lan(), pBack = lan();
    const pfStart = routeEnd + 100_000, pfSrvStart = pfStart + pOut, pfSrvEnd = pfSrvStart + prefillDur, pfEnd = pfSrvEnd + pBack;
    // prefill -> decode KV transfer (WAN, asymmetric)
    const kvOut = fwd + jitter(), kvBack = back + jitter();
    const kvStart = pfSrvEnd - 2_000_000, kvSrvStart = kvStart + kvOut, kvSrvEnd = kvSrvStart + 30_000_000, kvEnd = kvSrvEnd + kvBack;
    // gateway -> decode (WAN), decode streams tokens back (one-way to the stream relay)
    const dOut = fwd + jitter(), dBack = back + jitter();
    const dStart = pfEnd + 50_000, dSrvStart = dStart + dOut, dSrvEnd = dSrvStart + decodeDur, dEnd = dSrvEnd + dBack;
    const end = dEnd + 100_000;
    mk(tid, ids[0], '', 'POST /v1/chat/completions', 2, 'gw-1', t, end);
    mk(tid, ids[1], ids[0], 'route', 3, 'gw-1', routeStart, routeEnd);
    mk(tid, ids[2], ids[1], 'route', 2, 'router-1', routeSrvStart, routeSrvEnd);
    mk(tid, ids[3], ids[0], 'prefill', 3, 'gw-1', pfStart, pfEnd);
    mk(tid, ids[4], ids[3], 'prefill', 2, pre, pfSrvStart, pfSrvEnd);
    mk(tid, ids[5], ids[4], 'kv.transfer', 3, pre, kvStart, kvEnd);
    mk(tid, ids[6], ids[5], 'kv.receive', 2, dec, kvSrvStart, kvSrvEnd);
    mk(tid, ids[7], ids[0], 'decode', 3, 'gw-1', dStart, dEnd);
    mk(tid, ids[8], ids[7], 'decode', 2, dec, dSrvStart, dSrvEnd);
    if (i % 3 === 0) { // one-way: decode publishes, the stream relay consumes
      const id1 = hex(r, 16), id2 = hex(r, 16), at = dSrvStart + 5_000_000;
      mk(tid, id1, ids[8], 'stream.publish', 4, dec, at, at + 100_000);
      const hopNs = lan(); mk(tid, id2, id1, 'stream.consume', 5, 'stream-1', at + hopNs, at + hopNs + 2_000_000);
    }
  }
  const tb = hex(r, 32);
  mk(tb, hex(r, 16), '', 'batch job', 1, 'batch-1', 0, 1_000_000_000); // isolated: nothing to measure against
  const resourceSpans = [...byDomain.entries()].map(([domain, spans]) => ({
    resource: { attributes: [{ key: 'host.name', value: { stringValue: domain } }, { key: 'site', value: { stringValue: SITE(domain) } }, { key: 'service.name', value: { stringValue: domain.replace(/-\d+$/, '') } }] },
    scopeSpans: [{ scope: { name: 'synth' }, spans }],
  }));
  return { request: { resourceSpans }, offsets };
}
