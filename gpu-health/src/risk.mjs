// Risk: rank GPUs by how likely they are to fail next, so the riskiest get deep diags first and are kept off
// large synchronous jobs. Exact failure times are hard to predict; a ranking is useful and much easier to get right.
//
// This is a rules-first score: each signal maps to a probability-like contribution and they combine as
// 1 - prod(1 - p). Once quarantine outcomes accumulate, replace `contributions` with a learned ranker
// (learning-to-rank on the same features) and keep the interface.

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export function contributions(ev, g, cfg) {
  const out = [];
  if (ev.sbeRate > 0.5) out.push({ why: `corrected ECC ${ev.sbeRate.toFixed(1)}/h`, p: clamp(Math.log10(1 + ev.sbeRate) / 2.5) });
  if (ev.remapUsedFrac != null && ev.remapUsedFrac > 0.25) out.push({ why: `${Math.round(ev.remapUsedFrac * 100)}% of spare rows used`, p: clamp(ev.remapUsedFrac) });
  if (ev.tempOverPeers > 3) out.push({ why: `${ev.tempOverPeers.toFixed(0)}°C over peers`, p: clamp((ev.tempOverPeers - 3) / 20) });
  if (ev.throttleBusy > 0.05) out.push({ why: `throttled ${(ev.throttleBusy * 100).toFixed(0)}% of busy time`, p: clamp(ev.throttleBusy * 1.2) });
  if (ev.linkErrRate > 1) out.push({ why: `link errors ${ev.linkErrRate.toFixed(0)}/h`, p: clamp(Math.log10(ev.linkErrRate) / 4) });
  if (ev.pcieDowntrained) out.push({ why: 'PCIe downtrained', p: 0.3 });
  if (ev.speed && ev.speed.index < 0.97) out.push({ why: `speed ${(ev.speed.index * 100).toFixed(0)}% of cohort`, p: clamp((0.97 - ev.speed.index) * 5) });
  const past = (g.history || []).filter(h => h.state === 'quarantined').length;
  if (past) out.push({ why: `${past} past quarantine(s)`, p: clamp(0.25 * past) });
  return out;
}

export function rankRisk(health, cfg) {
  const rows = [];
  for (const g of Object.values(health.gpus)) {
    if (!g.evidence || ['quarantined', 'remediate', 'rma'].includes(g.state)) continue; // already out of service
    const c = contributions(g.evidence, g, cfg);
    const score = 1 - c.reduce((t, x) => t * (1 - x.p), 1);
    rows.push({ key: g.key, node: g.node, gpu: g.gpu, sku: g.sku, state: g.state, score, tier: score >= 0.5 ? 'high' : score >= 0.2 ? 'medium' : 'low', why: c.sort((a, b) => b.p - a.p).map(x => x.why) });
  }
  return rows.sort((a, b) => b.score - a.score);
}
