// Health: per-GPU lifecycle state, fail-closed.
//
//   serving ──soft signal──▶ suspect ──diag fail──▶ quarantined ──▶ remediate (ladder) ──diag pass──▶ burnin ──pass──▶ ready ──release approved──▶ serving
//      └────────hard fault / stale──────────────────────▶ quarantined                    second failure within N days ──▶ rma
//
// Only `serving` GPUs take new jobs. A suspect GPU finishes its current job, then gets a deep diag before anything else.
// If too much of the fleet goes stale at once, the monitoring is the likelier fault: GPUs keep their state and one
// exporter check is raised instead of quarantining the fleet (circuit breaker).
import { gpuKey } from './ingest.mjs';
import { indexByGpu, pct, speedIndex } from './efficiency.mjs';

const med = a => pct(a, 0.5);
const n = v => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
const rate = (w, field) => { // counter increase per hour over the window (counter resets ignored)
  const pts = w.filter(s => n(s[field]) != null);
  if (pts.length < 2) return 0;
  let inc = 0; for (let i = 1; i < pts.length; i++) inc += Math.max(0, pts[i][field] - pts[i - 1][field]);
  const h = (pts[pts.length - 1].t - pts[0].t) / 3600;
  return h > 0 ? inc / h : 0;
};
const delta = (w, field) => { const pts = w.filter(s => n(s[field]) != null); return pts.length < 2 ? 0 : Math.max(0, pts[pts.length - 1][field] - pts[0][field]); };

// Evidence per GPU over the recent lookback.
export function evidence(samples, probes, cfg, now, lookbackH = 24) {
  const byGpu = indexByGpu(samples);
  const speed = speedIndex(probes);
  const recent = new Map();
  for (const [k, arr] of byGpu) recent.set(k, arr.filter(s => s.t > now - lookbackH * 3600 && s.t <= now));
  // peer temperature by SKU at similar power
  const peer = new Map();
  for (const [k, w] of recent) { const sku = (w[0] || {}).sku || ''; if (!peer.has(sku)) peer.set(sku, []); peer.get(sku).push({ k, temp: med(w.map(s => n(s.tempC)).filter(v => v != null)), power: med(w.map(s => n(s.powerW)).filter(v => v != null)) }); }
  const out = new Map();
  for (const [k, arr] of byGpu) {
    const w = recent.get(k);
    const last = arr[arr.length - 1];
    const busy = w.filter(s => (n(s.sm) ?? 0) > 0.2);
    const pcieBad = busy.filter(s => (n(s.pcieWidthMax) && n(s.pcieWidth) != null && s.pcieWidth < s.pcieWidthMax) || (n(s.pcieGenMax) && n(s.pcieGen) != null && s.pcieGen < s.pcieGenMax));
    const me = (peer.get(last.sku || '') || []).find(p => p.k === k) || {};
    const peers = (peer.get(last.sku || '') || []).filter(p => p.k !== k && me.power != null && p.power != null && Math.abs(p.power - me.power) <= 0.2 * Math.max(me.power, 1));
    const peerTemp = peers.length >= 2 ? med(peers.map(p => p.temp)) : null;
    out.set(k, {
      key: k, node: last.node, gpu: String(last.gpu), site: last.site || '', sku: last.sku || '', vendor: last.vendor || '',
      lastT: last.t, faults: [...new Set(w.flatMap(s => s.faults || []))],
      dbe: delta(w, 'eccDbeTotal'), sbeRate: rate(w, 'eccSbeTotal'), linkErrRate: rate(w, 'linkErrTotal'),
      remapPending: n(last.remapPending) || 0, remapFailed: n(last.remapFailed) || 0,
      remapUsedFrac: n(last.remapUsed) != null && n(last.remapSpare) ? last.remapUsed / (last.remapUsed + last.remapSpare) : null,
      throttleBusy: busy.length ? busy.reduce((t, s) => t + (n(s.throttle) || 0), 0) / busy.length : 0,
      tempOverPeers: peerTemp != null && me.temp != null ? me.temp - peerTemp : 0,
      pcieDowntrained: busy.length >= 3 && pcieBad.length / busy.length > 0.5,
      pcieNow: last.pcieWidth != null ? `x${last.pcieWidth}/x${last.pcieWidthMax} gen${last.pcieGen}/${last.pcieGenMax}` : null,
      speed: speed.get(k) || null,
    });
  }
  return out;
}

// Signals from evidence: [{ class, severity: hard|soft, why }]
export function signals(ev, cfg) {
  const h = cfg.health, out = [];
  for (const f of ev.faults) {
    const d = cfg.faults[f] || { class: 'default', severity: 'soft' };
    if (d.severity === 'ignore') continue;
    out.push({ class: d.class, severity: d.severity, why: `fault ${f}` });
  }
  if (ev.dbe > 0) out.push({ class: 'ecc', severity: 'hard', why: `${ev.dbe} uncorrectable ECC error(s)` });
  if (ev.remapFailed > 0) out.push({ class: 'ecc', severity: 'hard', why: 'row remapping failed (no spare rows)' });
  if (ev.remapPending > 0) out.push({ class: 'ecc', severity: 'soft', why: 'row remap pending: needs a GPU reset' });
  if (ev.sbeRate > h.sbeRatePerHour) out.push({ class: 'ecc', severity: 'soft', why: `corrected ECC errors rising: ${ev.sbeRate.toFixed(0)}/h` });
  if (ev.throttleBusy > h.throttleBusy) out.push({ class: 'thermal', severity: 'soft', why: `clock-limited ${(ev.throttleBusy * 100).toFixed(0)}% of busy time` });
  if (ev.tempOverPeers > h.tempOverPeersC) out.push({ class: 'thermal', severity: 'soft', why: `${ev.tempOverPeers.toFixed(0)}°C hotter than peers at similar power` });
  if (ev.pcieDowntrained) out.push({ class: 'pcie', severity: 'soft', why: `PCIe link below max under load (${ev.pcieNow})` });
  if (ev.linkErrRate > h.linkErrPerHour) out.push({ class: 'link', severity: 'soft', why: `link errors ${ev.linkErrRate.toFixed(0)}/h` });
  if (ev.speed && ev.speed.index < h.speedIndexMin) out.push({ class: 'slow', severity: 'soft', why: `${ev.speed.metric} at ${(ev.speed.index * 100).toFixed(0)}% of cohort median (n=${ev.speed.cohortSize})` });
  return out;
}

const latestResult = (results, k, after, kinds) => (results || []).filter(r => r.node + '/' + r.gpu === k && r.t > after && kinds.includes(r.kind)).sort((a, b) => b.t - a.t)[0];
export const SCHEDULABLE = new Set(['serving']);

// prev: { lastRun, gpus: { key: { state, since, faultClass, why, ladderStep, remediatedAt, history: [{t,state}] } } }
export function assessHealth({ samples, probes = [], results = [], prev = { gpus: {} }, cfg, now }) {
  const ev = evidence(samples, probes, cfg, now);
  const keys = new Set([...ev.keys(), ...Object.keys(prev.gpus || {})]);
  const staleKeys = [...keys].filter(k => !ev.has(k) || now - ev.get(k).lastT > cfg.health.staleSec);
  const breaker = keys.size > 0 && staleKeys.length / keys.size > cfg.health.staleCircuitBreaker;
  const gpus = {};
  for (const k of keys) {
    const p = (prev.gpus || {})[k] || { state: 'serving', since: 0, ladderStep: 0, history: [] };
    const e = ev.get(k) || { key: k, node: k.split('/')[0], gpu: k.split('/')[1], faults: [] };
    const sig = ev.has(k) ? signals(e, cfg) : [];
    const hard = sig.filter(s => s.severity === 'hard'), soft = sig.filter(s => s.severity === 'soft');
    const stale = staleKeys.includes(k);
    const r = Object.assign({}, p, { key: k, node: e.node, gpu: String(e.gpu), sku: e.sku || p.sku || '', site: e.site || p.site || '', signals: sig, stale, evidence: e });
    const go = (state, cls, why) => {
      if (state === 'quarantined' && p.remediatedAt && now - p.remediatedAt < cfg.health.strikeWindowDays * 86400) { state = 'rma'; why = `${why}; second failure within ${cfg.health.strikeWindowDays} days of a fix`; }
      if (state !== p.state) { r.since = now; r.history = [...(p.history || []), { t: now, state, why }].slice(-20); if (state === 'quarantined') r.ladderStep = 0; }
      r.state = state; if (cls) r.faultClass = cls; r.why = why;
    };
    const inRepair = ['quarantined', 'remediate', 'diagnose'].includes(p.state);
    if (stale && breaker) { r.why = 'no data, but much of the fleet is stale: monitoring suspected, state held'; r.held = true; }
    else if (hard.length) go(p.state === 'rma' ? 'rma' : 'quarantined', hard[0].class, hard.map(s => s.why).join('; '));
    else if (p.state === 'rma') r.why = p.why;
    else if (inRepair) {
      const d = latestResult(results, k, p.since, ['diag']);
      if (d && d.pass) go('burnin', p.faultClass, `diag level ${d.level || '?'} passed; burn-in next`);
      else if (d && !d.pass) {
        const ladder = cfg.ladder[p.faultClass] || cfg.ladder.default;
        r.ladderStep = Math.min((p.ladderStep || 0) + 1, ladder.length - 1);
        r.state = ladder[r.ladderStep] === 'rma' ? 'rma' : 'remediate'; r.since = now; r.why = `diag failed${d.detail ? ': ' + d.detail : ''}; next step ${ladder[r.ladderStep]}`;
        r.history = [...(p.history || []), { t: now, state: r.state, why: r.why }].slice(-20);
      } else if (stale) r.why = p.why || 'no data (fail-closed)';
    } else if (p.state === 'burnin') {
      const b = latestResult(results, k, p.since, ['burnin', 'diag']);
      if (b && b.pass) { go('ready', p.faultClass, 'burn-in passed; waiting for release approval'); r.remediatedAt = now; }
      else if (b && !b.pass) go('quarantined', p.faultClass, `burn-in failed${b.detail ? ': ' + b.detail : ''}`);
    } else if (p.state === 'ready') {
      const rel = latestResult(results, k, p.since, ['release']);
      if (rel) go('serving', null, `released${rel.by ? ' by ' + rel.by : ''}`);
    } else if (stale) go('quarantined', 'stale', `no samples for ${Math.round((now - (e.lastT || 0)) / 60)} min (fail-closed)`);
    else if (p.state === 'suspect') {
      const d = latestResult(results, k, p.since, ['diag']);
      if (d && !d.pass) go('quarantined', p.faultClass, `deep diag failed${d.detail ? ': ' + d.detail : ''}`);
      else if (d && d.pass) { go('serving', null, 'deep diag passed; watching'); r.watch = soft.map(s => s.why); }
      else if (!soft.length) go('serving', null, 'signal cleared');
      else r.why = soft.map(s => s.why).join('; ');
    } else if (soft.length && !(p.watch && soft.every(s => p.watch.includes(s.why)))) go('suspect', soft[0].class, soft.map(s => s.why).join('; '));
    else { r.state = 'serving'; r.why = r.why && p.state === 'serving' ? r.why : 'ok'; }
    r.schedulable = SCHEDULABLE.has(r.state) && !(stale && !breaker);
    gpus[k] = r;
  }
  return { now, breaker, staleCount: staleKeys.length, fleet: keys.size, gpus };
}

// Strip bulky fields before saving state.
export const persistable = h => ({ lastRun: h.now, gpus: Object.fromEntries(Object.entries(h.gpus).map(([k, g]) => [k, { state: g.state, since: g.since, faultClass: g.faultClass, why: g.why, ladderStep: g.ladderStep || 0, remediatedAt: g.remediatedAt, watch: g.watch, history: g.history || [], sku: g.sku, site: g.site }])) });
