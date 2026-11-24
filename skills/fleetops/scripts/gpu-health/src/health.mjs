// Health: per-GPU lifecycle state, fail-closed.
//
//   serving ──soft signal──▶ suspect ──diag fail──▶ quarantined ──▶ remediate (ladder) ──diag pass──▶ burnin ──pass──▶ ready ──release approved──▶ serving
//      └────────hard fault / stale──────────────────────▶ quarantined                    second failure within N days ──▶ rma
//
// Only `serving` GPUs take new jobs. A suspect GPU finishes its current job, then gets a deep diag before anything else.
// If too much of the fleet goes stale at once, the monitoring is the likelier fault: GPUs keep their state and one
// exporter check is raised instead of quarantining the fleet (circuit breaker).
//
// Early warning, the signals that most often come before a failure:
//   - HBM temperature: above peers at similar power, and rising against the GPU's own history at the same power
//   - power-brake slowdowns, thermal throttling, GPU temperature above peers
//   - corrected-ECC rate, pending row remaps, PCIe downtraining under load, link (NVLink/XGMI) error rate
//   - new faults in a vendor's own platform fault counter (SambaNova)
//   - telemetry thinning on one GPU while its node-mates report normally (detachment often shows up only this way)
//   - silent-data-corruption events from the training loop (NaN/Inf, loss or gradient spikes, replay mismatch)
// Peers are the other GPUs on the same node running the same job when there are enough of them (same load, same
// cooling), otherwise same-SKU GPUs at similar power. Windowed signals must fire in N of the last K windows
// (persistence), and a signal that cleared stays quiet for a cooldown, so one noisy hour doesn't flip a GPU.
import { indexByGpu, pct, speedIndex, intervalSec } from './efficiency.mjs';
import { faultDef, ladderFor } from './vendors.mjs';

const med = a => pct(a, 0.5);
const n = v => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
const vals = (w, f) => w.map(s => n(s[f])).filter(v => v != null);
const rate = (w, field) => { // counter increase per hour over the window (counter resets ignored)
  const pts = w.filter(s => n(s[field]) != null);
  if (pts.length < 2) return 0;
  let inc = 0; for (let i = 1; i < pts.length; i++) inc += Math.max(0, pts[i][field] - pts[i - 1][field]);
  const h = (pts[pts.length - 1].t - pts[0].t) / 3600;
  return h > 0 ? inc / h : 0;
};
const lastIncrease = (w, field) => { // { delta, t } of a counter over the window
  const pts = w.filter(s => n(s[field]) != null); let d = 0, t = null;
  for (let i = 1; i < pts.length; i++) if (pts[i][field] > pts[i - 1][field]) { d += pts[i][field] - pts[i - 1][field]; t = pts[i].t; }
  return { delta: d, t };
};

export function jobIndex(jobs) {
  const m = new Map();
  for (const j of jobs || []) j.gpus.forEach((g, rank) => m.set(g.node + '/' + g.gpu, { job: j.id, rank, class: j.class }));
  return m;
}

// Metrics that depend on the window and on peers. Computed for the whole lookback and for each persistence window.
function windowMetrics(byGpu, from, to, jobOf) {
  const per = new Map();
  for (const [k, arr] of byGpu) {
    const w = arr.filter(s => s.t > from && s.t <= to);
    if (!w.length) continue;
    const busy = w.filter(s => (n(s.sm) ?? 0) > 0.2);
    const pcieBad = busy.filter(s => (n(s.pcieWidthMax) && n(s.pcieWidth) != null && s.pcieWidth < s.pcieWidthMax) || (n(s.pcieGenMax) && n(s.pcieGen) != null && s.pcieGen < s.pcieGenMax));
    const last = w[w.length - 1];
    per.set(k, {
      node: last.node, sku: last.sku || '', site: last.site || '', job: (jobOf.get(k) || {}).job,
      temp: med(vals(w, 'tempC')), memTemp: med(vals(w, 'memTempC')), power: med(vals(w, 'powerW')),
      sbeRate: rate(w, 'eccSbeTotal'), linkErrRate: rate(w, 'linkErrTotal'),
      throttleBusy: busy.length ? busy.reduce((t, s) => t + (n(s.throttle) || 0), 0) / busy.length : 0,
      brakeBusy: busy.length ? busy.reduce((t, s) => t + (n(s.powerBrake) || 0), 0) / busy.length : 0,
      pcieDowntrained: busy.length >= 3 && pcieBad.length / busy.length > 0.5,
      pcieNow: last.pcieWidth != null ? `x${last.pcieWidth}/x${last.pcieWidthMax} gen${last.pcieGen}/${last.pcieGenMax}` : null,
    });
  }
  // peers: same node + same job when at least 2 others, else same SKU and site at similar power
  for (const [k, m] of per) {
    let peers = [...per.entries()].filter(([k2, p]) => k2 !== k && m.job && p.job === m.job && p.node === m.node).map(([, p]) => p);
    m.peerScope = 'same node and job';
    if (peers.length < 2) {
      peers = [...per.entries()].filter(([k2, p]) => k2 !== k && p.sku === m.sku && p.site === m.site && m.power != null && p.power != null && Math.abs(p.power - m.power) <= 0.2 * Math.max(m.power, 1)).map(([, p]) => p);
      m.peerScope = 'same SKU at similar power';
    }
    const pt = peers.map(p => p.temp).filter(v => v != null && !Number.isNaN(v)), pm = peers.map(p => p.memTemp).filter(v => v != null && !Number.isNaN(v));
    m.tempOverPeers = pt.length >= 2 && m.temp != null && !Number.isNaN(m.temp) ? m.temp - med(pt) : 0;
    m.memTempOverPeers = pm.length >= 2 && m.memTemp != null && !Number.isNaN(m.memTemp) ? m.memTemp - med(pm) : 0;
  }
  return per;
}

// Soft signals that come from window metrics. Each has a stable key used for persistence, cooldown and watch lists.
function windowSignals(m, cfg) {
  const h = cfg.health, out = [];
  if (!m) return out;
  if (m.sbeRate > h.sbeRatePerHour) out.push({ key: 'ecc-rate', class: 'ecc', why: `corrected ECC errors rising: ${m.sbeRate.toFixed(0)}/h` });
  if (m.throttleBusy > h.throttleBusy) out.push({ key: 'throttle', class: 'thermal', why: `clock-limited ${(m.throttleBusy * 100).toFixed(0)}% of busy time` });
  if (m.brakeBusy > h.powerBrakeBusy) out.push({ key: 'power-brake', class: 'power', why: `power-brake slowdowns ${(m.brakeBusy * 100).toFixed(0)}% of busy time` });
  if (m.tempOverPeers > h.tempOverPeersC) out.push({ key: 'temp-peers', class: 'thermal', why: `${m.tempOverPeers.toFixed(0)}°C hotter than peers (${m.peerScope})` });
  if (m.memTempOverPeers > h.memTempOverPeersC) out.push({ key: 'hbm-temp-peers', class: 'thermal', why: `HBM ${m.memTempOverPeers.toFixed(0)}°C hotter than peers (${m.peerScope})` });
  if (m.pcieDowntrained) out.push({ key: 'pcie', class: 'pcie', why: `PCIe link below max under load (${m.pcieNow})` });
  if (m.linkErrRate > h.linkErrPerHour) out.push({ key: 'link-rate', class: 'link', why: `link errors ${m.linkErrRate.toFixed(0)}/h` });
  return out;
}

// Results of one kind ('sdc', 'fault') attributed to a device directly or through job + rank.
function resultsByGpu(results, jobs, kind) {
  const m = new Map();
  for (const r of results || []) {
    if (r.kind !== kind) continue;
    let k = r.node != null && r.gpu != null ? r.node + '/' + r.gpu : null;
    if (!k && r.job != null && r.rank != null) { const j = (jobs || []).find(x => x.id === r.job); const g = j && j.gpus[r.rank]; if (g) k = g.node + '/' + g.gpu; }
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Evidence per GPU.
export function evidence(samples, probes, cfg, now, { jobs = [], results = [], lookbackH = 24 } = {}) {
  const h = cfg.health;
  const byGpu = indexByGpu(samples);
  const jobOf = jobIndex(jobs);
  const speed = speedIndex(probes);
  const sdc = resultsByGpu(results, jobs, 'sdc');
  // Fault events from logs or a vendor's fault manager (TPU, SambaNova SNFM, XIDs from dmesg): { t, kind: 'fault', node, gpu, code }
  const faultEvents = resultsByGpu(results, jobs, 'fault');
  const full = windowMetrics(byGpu, now - lookbackH * 3600, now, jobOf);
  // persistence windows, newest first
  const winSec = h.persistWindowMin * 60;
  const wins = Array.from({ length: h.persistK }, (_, i) => windowMetrics(byGpu, now - (i + 1) * winSec, now - i * winSec, jobOf));
  // telemetry thinning per GPU over the last hour, and per node
  const thin = new Map();
  for (const [k, arr] of byGpu) {
    const dt = intervalSec(arr), recent = arr.filter(s => s.t > now - 3600 && s.t <= now), older = arr.filter(s => s.t <= now - 3600);
    const expected = Math.max(1, Math.round(3600 / Math.max(dt, 1)));
    const missing = older.length >= expected ? Math.max(0, 1 - recent.length / expected) : 0; // only judge GPUs with history
    const usual = older.length >= 10 ? Object.keys(older[older.length - 1]).filter(f => typeof older[older.length - 1][f] === 'number' && older.slice(-10).every(s => n(s[f]) != null)) : [];
    const vanished = recent.length ? usual.filter(f => !['t'].includes(f) && recent.every(s => n(s[f]) == null)) : [];
    thin.set(k, { missing, vanished });
  }
  const nodeThin = new Map();
  for (const [k, t] of thin) { const node = k.split('/')[0]; if (!nodeThin.has(node)) nodeThin.set(node, []); nodeThin.get(node).push(t.missing >= h.telemetryGapFrac || t.vanished.length > 0); }

  const out = new Map();
  for (const [k, arr] of byGpu) {
    const w = arr.filter(s => s.t > now - lookbackH * 3600 && s.t <= now);
    const last = arr[arr.length - 1];
    const m = full.get(k) || {};
    // HBM temperature trend: last 24 h vs the GPU's own earlier days, at similar power
    let memTempRise = 0;
    const pRecent = m.power;
    if (pRecent != null && !Number.isNaN(pRecent)) {
      const similar = s => n(s.powerW) != null && Math.abs(s.powerW - pRecent) <= 0.15 * Math.max(pRecent, 1);
      const before = vals(arr.filter(s => s.t <= now - lookbackH * 3600 && similar(s)), 'memTempC');
      const recent = vals(w.filter(similar), 'memTempC');
      if (before.length >= 10 && recent.length >= 5) memTempRise = med(recent) - med(before);
    }
    const faultT = {};
    for (const s of w) for (const f of s.faults || []) faultT[f] = Math.max(faultT[f] || 0, s.t);
    for (const r of faultEvents.get(k) || []) if (r.code && r.t > now - lookbackH * 3600 && r.t <= now) faultT[r.code] = Math.max(faultT[r.code] || 0, r.t);
    const dbe = lastIncrease(w, 'eccDbeTotal'), linkUe = lastIncrease(w, 'linkUeTotal'), vendorFaults = lastIncrease(w, 'faultCountTotal');
    const t = thin.get(k) || { missing: 0, vanished: [] };
    const nt = nodeThin.get(last.node) || [];
    const sdcEvents = (sdc.get(k) || []).filter(r => r.t > now - h.sdcWindowDays * 86400 && r.t <= now);
    out.set(k, {
      key: k, node: last.node, gpu: String(last.gpu), site: last.site || '', sku: last.sku || '', vendor: last.vendor || '', kind: last.kind || '', job: (jobOf.get(k) || {}).job,
      lastT: last.t, intervalSec: intervalSec(arr), faults: Object.keys(faultT), faultT,
      dbe: dbe.delta, dbeT: dbe.t, linkUe: linkUe.delta, linkUeT: linkUe.t, vendorFaults: vendorFaults.delta, vendorFaultsT: vendorFaults.t,
      sbeRate: m.sbeRate || 0, linkErrRate: m.linkErrRate || 0, throttleBusy: m.throttleBusy || 0, brakeBusy: m.brakeBusy || 0,
      tempOverPeers: m.tempOverPeers || 0, memTempOverPeers: m.memTempOverPeers || 0, memTempRise, peerScope: m.peerScope,
      pcieDowntrained: !!m.pcieDowntrained, pcieNow: m.pcieNow,
      remapPending: n(last.remapPending) || 0, remapFailed: n(last.remapFailed) || 0,
      remapUsedFrac: n(last.remapUsed) != null && n(last.remapSpare) ? last.remapUsed / (last.remapUsed + last.remapSpare) : null,
      telemetryMissing: t.missing, telemetryVanished: t.vanished, nodeTelemetryThin: nt.length >= 2 && nt.every(Boolean),
      sdcEvents, speed: speed.get(k) || null,
      windows: wins.map(wm => windowSignals(wm.get(k), cfg).map(s => s.key)).filter((_, i) => wins[i].has(k)),
      full: windowSignals(m, cfg),
    });
  }
  return out;
}

// Signals from evidence: [{ key, class, severity: hard|soft, why, t? }]
export function signals(ev, cfg) {
  const h = cfg.health, out = [];
  for (const f of ev.faults) {
    const d = faultDef(cfg, ev.vendor, f);
    if (d.severity === 'ignore') continue;
    out.push({ key: 'fault-' + f, class: d.class, severity: d.severity, why: `fault ${f}`, t: ev.faultT[f] });
  }
  if (ev.dbe > 0) out.push({ key: 'dbe', class: 'ecc', severity: 'hard', why: `${ev.dbe} uncorrectable ECC error(s)`, t: ev.dbeT });
  if (ev.linkUe > 0) out.push({ key: 'link-ue', class: 'link', severity: 'hard', why: `${ev.linkUe} uncorrectable link error(s) (NVLink/XGMI)`, t: ev.linkUeT });
  if (ev.vendorFaults > 0) out.push({ key: 'vendor-faults', class: 'platform', severity: 'soft', why: `${ev.vendorFaults} new fault(s) in the vendor's platform fault count on ${ev.node}: check its fault log for the device`, t: ev.vendorFaultsT });
  if (ev.remapFailed > 0) out.push({ key: 'remap-failed', class: 'ecc', severity: 'hard', why: 'row remapping failed (no spare rows)', t: ev.lastT });
  if (ev.remapPending > 0) out.push({ key: 'remap-pending', class: 'ecc', severity: 'soft', why: 'row remap pending: needs a GPU reset' });
  // windowed signals: must fire in N of the K windows that have data (all of them when fewer than N have data)
  const K = ev.windows.length, N = Math.min(h.persistN, K);
  for (const s of ev.full) {
    const hits = ev.windows.filter(w => w.includes(s.key)).length;
    if (K && hits >= N) out.push(Object.assign({ severity: 'soft', persist: `${hits}/${K}` }, s));
  }
  if (ev.memTempRise > h.memTempRiseC) out.push({ key: 'hbm-temp-rise', class: 'thermal', severity: 'soft', why: `HBM ${ev.memTempRise.toFixed(0)}°C warmer than its own earlier days at the same power` });
  if (!ev.nodeTelemetryThin && (ev.telemetryMissing >= h.telemetryGapFrac || ev.telemetryVanished.length))
    out.push({ key: 'telemetry', class: 'telemetry', severity: 'soft', why: ev.telemetryVanished.length ? `metrics stopped reporting: ${ev.telemetryVanished.slice(0, 4).join(', ')}` : `${Math.round(ev.telemetryMissing * 100)}% of samples missing in the last hour while node-mates report normally` });
  if (ev.speed && ev.speed.index < h.speedIndexMin) out.push({ key: 'speed', class: 'slow', severity: 'soft', why: `${ev.speed.metric} at ${(ev.speed.index * 100).toFixed(0)}% of cohort median (n=${ev.speed.cohortSize})` });
  const sdc = ev.sdcEvents || [];
  if (sdc.length) {
    const confirmed = sdc.some(e => e.type === 'replay-mismatch');
    const hard = confirmed || sdc.length >= h.sdcHard;
    const kinds = [...new Set(sdc.map(e => e.type || 'event'))].join(', ');
    if (hard || sdc.length >= h.sdcSoft) out.push({ key: 'sdc', class: 'sdc', severity: hard ? 'hard' : 'soft', why: `${sdc.length} silent-data-corruption event(s) in ${h.sdcWindowDays} days (${kinds})${confirmed ? ', confirmed by replay' : ''}`, t: Math.max(...sdc.map(e => e.t)) });
  }
  return out;
}

const latestResult = (results, k, after, kinds) => (results || []).filter(r => r.node + '/' + r.gpu === k && r.t > after && kinds.includes(r.kind)).sort((a, b) => b.t - a.t)[0];
export const SCHEDULABLE = new Set(['serving']);

// prev: { lastRun, gpus: { key: { state, since, faultClass, why, ladderStep, remediatedAt, watch, cooldown, history } } }
export function assessHealth({ samples, probes = [], results = [], jobs = [], prev = { gpus: {} }, cfg, now }) {
  const ev = evidence(samples, probes, cfg, now, { jobs, results });
  const keys = new Set([...ev.keys(), ...Object.keys(prev.gpus || {})]);
  // stale: nothing for staleSec, or for 2.5 scrape intervals when scraping is slower than that
  const staleKeys = [...keys].filter(k => !ev.has(k) || now - ev.get(k).lastT > Math.max(cfg.health.staleSec, 2.5 * ev.get(k).intervalSec));
  const breaker = keys.size > 0 && staleKeys.length / keys.size > cfg.health.staleCircuitBreaker;
  const nodesThin = [...new Set([...ev.values()].filter(e => e.nodeTelemetryThin).map(e => e.node))];
  const gpus = {};
  for (const k of keys) {
    const p = (prev.gpus || {})[k] || { state: 'serving', since: 0, ladderStep: 0, history: [] };
    const e = ev.get(k) || { key: k, node: k.split('/')[0], gpu: k.split('/')[1], faults: [] };
    const sig = ev.has(k) ? signals(e, cfg) : [];
    const repairing = ['quarantined', 'remediate', 'diagnose', 'burnin', 'ready'].includes(p.state);
    // while in repair, only hard events newer than the current state count (old ones are what's being repaired)
    const hard = sig.filter(s => s.severity === 'hard' && (!repairing || (s.t != null && s.t > p.since)));
    // cooldown: a soft signal that cleared stays quiet for a while, so a GPU doesn't flap between serving and suspect
    const cooldown = Object.fromEntries(Object.entries(p.cooldown || {}).filter(([, until]) => until > now));
    const watch = new Set(p.watch || []);
    const soft = sig.filter(s => s.severity === 'soft' && !(cooldown[s.key] > now) && !watch.has(s.key));
    const stale = staleKeys.includes(k);
    const r = Object.assign({}, p, { key: k, node: e.node, gpu: String(e.gpu), sku: e.sku || p.sku || '', site: e.site || p.site || '', vendor: e.vendor || p.vendor || '', kind: e.kind || p.kind || '', signals: sig, stale, evidence: e, cooldown, watch: [...watch].filter(w => sig.some(s => s.key === w)) });
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
        const ladder = ladderFor(cfg, r.vendor, p.faultClass);
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
      const was = p.signalKeys || [];
      if (d && !d.pass) go('quarantined', p.faultClass, `deep diag failed${d.detail ? ': ' + d.detail : ''}`);
      else if (d && d.pass) { go('serving', null, 'deep diag passed; watching'); r.watch = [...new Set([...watch, ...sig.filter(s => s.severity === 'soft').map(s => s.key)])]; }
      else if (!sig.some(s => s.severity === 'soft' && was.includes(s.key)) && !soft.length) {
        go('serving', null, 'signal cleared');
        for (const key of was) r.cooldown[key] = now + cfg.health.signalCooldownMin * 60;
      } else { const cur = sig.filter(s => s.severity === 'soft'); r.why = cur.map(s => s.why).join('; ') || p.why; r.signalKeys = [...new Set([...was, ...cur.map(s => s.key)])]; }
    } else if (soft.length) { go('suspect', soft[0].class, soft.map(s => s.why).join('; ')); r.signalKeys = soft.map(s => s.key); }
    else { r.state = 'serving'; r.why = p.state === 'serving' ? p.why || 'ok' : 'ok'; }
    r.schedulable = SCHEDULABLE.has(r.state) && !(stale && !breaker);
    gpus[k] = r;
  }
  return { now, breaker, staleCount: staleKeys.length, fleet: keys.size, nodesThin, gpus };
}

// Strip bulky fields before saving state.
export const persistable = h => ({ lastRun: h.now, gpus: Object.fromEntries(Object.entries(h.gpus).map(([k, g]) => [k, { state: g.state, since: g.since, faultClass: g.faultClass, why: g.why, ladderStep: g.ladderStep || 0, remediatedAt: g.remediatedAt, watch: g.watch, cooldown: g.cooldown, signalKeys: g.signalKeys, history: g.history || [], sku: g.sku, site: g.site, vendor: g.vendor, kind: g.kind }])) });
