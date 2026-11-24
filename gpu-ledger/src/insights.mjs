// Insights: where the money goes that doesn't buy work, and what would change it. Each one names an owner, gives the
// evidence, the change, the monthly saving and how that saving was worked out (measured, estimate, modelled, upper
// bound), ranked by saving. Thresholds are in OPTS so a team can tune them.
import { GPU_SPECS, priceOf, gpuKey } from './core.mjs';

export const OPTS = {
  minMonthlyGpuH: 20,            // ignore anything smaller than this many GPU-hours a month
  idleTimeoutS: 1800,            // stretches idle this long count towards an idle timeout
  lowBusy: 0.2,                  // a batch allocation busy less than this is "held, not used"
  failStorm: 3,                  // this many failed attempts of the same thing is a pattern
  shareMem: 0.4, shareSm: 0.3,   // single-GPU work under both can share a GPU (MIG, time-slicing)
  servingHeadroom: 1.25,         // capacity kept above the busiest hour when right-sizing serving
  smallOutputTokens: 32, bigModelB: 60,
  commitmentSlack: 0.9,          // commitments used under 90% are oversized
};
const H = 3600, MONTH = 30 * 86400;
const PCIE = new Set(['L40S', 'L4', 'A10', 'T4']);
const fmt = n => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1));

export function insights(L, { opts = {}, sizer = null, models = {} } = {}) {
  const o = Object.assign({}, OPTS, opts), out = [], scale = MONTH / Math.max(H, L.to - L.from);
  const add = x => { x.savings = x.savings || {}; if (!L.totals.priced && x.savings.usd === 0) x.savings.usd = null; if (x.savings.gpuH != null) x.savings.gpuHMonth = x.savings.gpuH * scale; x.savings.usdMonth = x.savings.usd != null ? x.savings.usd * scale : null; delete x.savings.gpuH; delete x.savings.usd; out.push(x); };
  const by = (rows, f) => { const m = new Map(); for (const x of rows) { const k = f(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const s = (rows, f) => rows.reduce((a, x) => a + (f(x) || 0), 0);
  const big = gpuS => gpuS / H * scale >= o.minMonthlyGpuH;
  const who = x => (x.r.user !== '(unattributed)' ? x.r.user : x.r.team);

  // 1. idle interactive sessions: an idle timeout returns the long idle stretches
  for (const [u, rows] of by(L.rows.filter(x => x.r.useCase === 'interactive' && x.idleLong > 0), who)) {
    const gs = s(rows, x => x.idleLong), usd = s(rows, x => (x.rate || 0) * x.idleLong / H);
    if (!big(gs)) continue;
    add({ id: `idle-timeout:${u}`, kind: 'idle-timeout', owner: { user: u, team: rows[0].r.team, org: rows[0].r.org },
      title: `${u}: interactive sessions idle in long stretches`, evidence: `${fmt(gs / H)} GPU-h idle in stretches of ${o.idleTimeoutS / 60}+ min across ${rows.length} session(s) (${fmt(s(rows, x => x.alloc) / H)} GPU-h allocated)`,
      action: `Idle timeout of ${o.idleTimeoutS / 60} min on notebooks (culling), or release GPUs between experiments`, savings: { gpuH: gs / H, usd }, basis: 'measured', confidence: 'high' });
  }
  // 2. batch allocations that held GPUs with little work on them
  for (const [k, rows] of by(L.rows.filter(x => x.measured && !x.r.shared && x.r.useCase !== 'interactive' && x.r.useCase !== 'inference' && x.r.util.busy < o.lowBusy && x.alloc >= 2 * H), x => `${who(x)}|${x.r.name || x.r.group || x.r.id}`)) {
    const gs = s(rows, x => x.idle); if (!big(gs)) continue;
    const r = rows[0].r;
    add({ id: `held:${k}`, kind: 'held-idle', owner: { user: r.user, team: r.team, org: r.org }, title: `${r.name || r.id} held GPUs it barely used`,
      evidence: `${rows.length} allocation(s), busy ${Math.round(100 * s(rows, x => x.alloc - x.idle) / s(rows, x => x.alloc))}% of the time; ${fmt(gs / H)} GPU-h idle`,
      action: 'Find what it waits on (data, a dependency, a hung rank) or request fewer GPUs; a utilization guard can stop allocations idle for hours', savings: { gpuH: gs / H, usd: s(rows, x => x.wasted || 0) * gs / Math.max(1, s(rows, x => x.idle + x.lost)) }, basis: 'measured', confidence: 'medium' });
  }
  // 3. failures that repeat: the same job failing again and again
  for (const [k, rows] of by(L.rows.filter(x => x.lost > 0), x => `${who(x)}|${x.r.group || x.r.name || x.r.id}`)) {
    if (rows.length < o.failStorm) continue;
    const gs = s(rows, x => x.lost); if (!big(gs)) continue;
    const r = rows[0].r, all = L.rows.filter(x => (x.r.group || x.r.name || x.r.id) === (r.group || r.name || r.id) && who(x) === who(rows[0]));
    const ok = all.some(x => x.r.status === 'succeeded');
    add({ id: `failing:${k}`, kind: 'repeated-failure', owner: { user: r.user, team: r.team, org: r.org }, title: `${r.group || r.name || r.id} failed ${rows.length} times${ok ? '' : ' and never succeeded'}`,
      evidence: `${rows.length} failed or preempted attempt(s), ${fmt(gs / H)} GPU-h of work lost (${[...new Set(rows.map(x => x.lostBasis))].join('; ')})`,
      action: ok ? 'Check the failures are not one bad node (fleetops rca) and checkpoint more often' : 'Stop automatic resubmission until a small run passes; cap retries', savings: { gpuH: gs / H, usd: s(rows, x => (x.rate || 0) * x.lost / H) }, basis: 'estimate', confidence: ok ? 'medium' : 'high' });
  }
  // 4. the GPU type: work whose memory and compute would fit on a cheaper GPU that the price book has
  const types = Object.keys(L.card).filter(t => GPU_SPECS[t]);
  const sizedRows = L.rows.filter(x => x.measured && x.r.util.memPeak != null && x.smBusy != null && x.r.gpuType && GPU_SPECS[x.r.gpuType] && !x.r.serving && x.r.useCase !== 'interactive');
  for (const [k, rows] of by(sizedRows, x => `${who(x)}|${x.r.name || x.r.group || x.r.id}|${x.r.gpuType}`)) {
    const r = rows[0].r, g = GPU_SPECS[r.gpuType], mem = Math.max(...rows.map(x => x.r.util.memPeak)), sm = s(rows, x => x.smBusy * (x.alloc - x.idle)) / Math.max(1, s(rows, x => x.alloc - x.idle));
    const rate = rows[0].rate; if (rate == null) continue;
    const needGB = mem * g.hbmGB * 1.15, needTF = sm * g.tflops * 1.25, multi = Math.max(...rows.map(x => x.r.gpus)) > 1;
    const cands = types.filter(t => t !== r.gpuType && GPU_SPECS[t].hbmGB >= needGB && GPU_SPECS[t].tflops >= needTF && !(multi && PCIE.has(t)))
      .map(t => ({ t, p: priceOf(L.card, L.prices, t, r.provider) })).filter(c => c.p && c.p.rate < rate * 0.85).sort((a, b) => a.p.rate - b.p.rate);
    if (!cands.length) continue;
    const gs = s(rows, x => x.alloc); if (!big(gs)) continue;
    const c = cands[0];
    add({ id: `gpu-type:${k}`, kind: 'gpu-type', owner: { user: r.user, team: r.team, org: r.org }, title: `${r.name || r.id} fits on ${c.t} instead of ${r.gpuType}`,
      evidence: `peak memory ${Math.round(mem * 100)}% of ${g.hbmGB} GB (${Math.round(mem * g.hbmGB)} GB), SM active ${Math.round(sm * 100)}% while busy, over ${fmt(gs / H)} GPU-h; ${c.t} has ${GPU_SPECS[c.t].hbmGB} GB and ${GPU_SPECS[c.t].tflops} TFLOPS at $${c.p.rate.toFixed(2)}/GPU-h against $${rate.toFixed(2)}`,
      action: `Trial run on ${c.t} and compare step time; move if it holds`, savings: { gpuH: 0, usd: gs / H * (rate - c.p.rate) }, basis: 'estimate', confidence: 'medium',
      caveat: 'From peak memory and mean SM activity; memory bandwidth and interconnect can make it slower. Confirm with a trial run.' });
  }
  // 5. single-GPU work light enough to share a GPU
  for (const [k, rows] of by(L.rows.filter(x => x.r.gpus === 1 && x.measured && x.r.util.memPeak != null && x.smBusy != null && !x.r.serving), x => `${who(x)}|${x.r.useCase}`)) {
    const light = rows.filter(x => x.r.util.memPeak <= o.shareMem && x.smBusy <= o.shareSm); const gs = s(light, x => x.alloc);
    if (!big(gs) || light.length < 3) continue;
    const mem = Math.max(...light.map(x => x.r.util.memPeak)), sm = Math.max(...light.map(x => x.smBusy));
    const kk = Math.max(2, Math.min(7, Math.floor(1 / Math.max(mem * 1.2, sm * 1.3)))), r = light[0].r;
    add({ id: `share:${k}`, kind: 'share-gpu', owner: { user: r.user, team: r.team, org: r.org }, title: `${who(light[0])}: ${r.useCase} jobs could share GPUs (${kk} per GPU)`,
      evidence: `${light.length} single-GPU allocation(s), ${fmt(gs / H)} GPU-h, each under ${Math.round(mem * 100)}% memory and ${Math.round(sm * 100)}% SM active`,
      action: `MIG slices or time-slicing (${kk} per GPU) for this work`, savings: { gpuH: gs / H * (1 - 1 / kk), usd: s(light, x => x.cost || 0) * (1 - 1 / kk) }, basis: 'estimate', confidence: 'medium' });
  }
  // 6. serving: allocation-based cost per million output tokens, and what would lower it
  const serving = L.rows.filter(x => x.r.serving && x.r.serving.model);
  for (const [model, rows] of by(serving, x => x.r.serving.model)) {
    const perType = [...by(rows, x => x.r.gpuType || '?')].map(([t, rs]) => ({ t, rows: rs, cost: s(rs, x => x.cost), tok: s(rs, x => x.tokensOut), gs: s(rs, x => x.alloc) }))
      .map(p => Object.assign(p, { per1M: p.tok ? p.cost / p.tok * 1e6 : null }));
    const owner = { team: rows[0].r.team, org: rows[0].r.org, user: rows[0].r.user };
    // 6a. the same model is cheaper per token on another GPU type the fleet already runs
    const priced = perType.filter(p => p.per1M != null && p.tok > 0), best = priced.slice().sort((a, b) => a.per1M - b.per1M)[0];
    for (const p of priced) if (best && p !== best && best.per1M < p.per1M * 0.85 && best.tok >= 0.1 * (p.tok + best.tok)) {
      add({ id: `serve-gpu:${model}:${p.t}`, kind: 'serving-gpu', owner, title: `${model}: $${best.per1M.toFixed(2)}/1M tokens on ${best.t}, $${p.per1M.toFixed(2)} on ${p.t}`,
        evidence: `measured on this fleet: ${fmt(p.tok / 1e6)}M output tokens on ${p.t} (${fmt(p.gs / H)} GPU-h), ${fmt(best.tok / 1e6)}M on ${best.t}`, action: `Move ${model} replicas from ${p.t} to ${best.t}`,
        savings: { gpuH: 0, usd: p.tok / 1e6 * (p.per1M - best.per1M) }, basis: 'measured', confidence: 'medium', caveat: 'Both at their own utilization: compare at similar load before moving.' });
    }
    // 6b. over-provisioned: more GPU-hours than the busiest hour needs at the throughput it has shown it reaches
    const hours = [...by(rows, x => Math.floor(Math.max(x.r.start, L.from) / H))].map(([h, rs]) => ({ h, gs: s(rs, x => x.alloc), tok: s(rs, x => x.tokensOut), gpus: Math.max(...rs.map(x => x.r.gpus)) }));
    if (hours.length >= 6) {
      const tput = hours.filter(h => h.gs > 0 && h.tok > 0).map(h => h.tok / h.gs).sort((a, b) => a - b), cap = tput[Math.floor(0.95 * (tput.length - 1))];
      const step = Math.min(...rows.map(x => x.r.gpus));
      if (cap > 0) {
        let save = 0; for (const h of hours) { const need = Math.max(step, Math.ceil(h.tok / cap * o.servingHeadroom / H / step) * step) * H; save += Math.max(0, h.gs - need); }
        const all = s(rows, x => x.alloc), rate = s(rows, x => x.cost) / Math.max(1, all) * H;
        if (save > 0.15 * all && big(save)) add({ id: `serve-scale:${model}`, kind: 'serving-scale', owner, title: `${model}: more replicas than the traffic needs`,
          evidence: `${fmt(all / H)} GPU-h for ${fmt(s(rows, x => x.tokensOut) / 1e6)}M output tokens; at its own best hourly throughput (${fmt(cap)} tokens/GPU-s, p95) plus ${Math.round((o.servingHeadroom - 1) * 100)}% headroom, ${fmt((all - save) / H)} GPU-h would have served every hour`,
          action: 'Autoscale on queue depth with a lower minimum (fleetops serving deploy --autoscale), or remove replicas', savings: { gpuH: save / H, usd: save / H * rate }, basis: 'measured', confidence: 'medium' });
      }
    }
    // 6c. the Inference Sizer's view: the same traffic on each GPU type in the price book
    const cat = models[model] || model, reqs = s(rows, x => (x.r.serving.requests || 0) * (x.alloc / Math.max(1, x.r.gpus * ((x.r.end ?? L.to) - x.r.start))));
    if (sizer && reqs > 0 && hours.length) {
      const isl = s(rows, x => x.tokensIn) / reqs, osl = s(rows, x => x.tokensOut) / reqs, peak = Math.max(...hours.map(h => h.tok)) / H / Math.max(1, osl);
      const curCost = s(rows, x => x.cost), opts2 = [];
      for (const t of Object.keys(L.card)) {
        let c; try { c = sizer.need(cat, t, { isl, osl, rate: peak }); } catch { continue; }
        const p = priceOf(L.card, L.prices, t); if (!c || !p) continue;
        opts2.push({ t, gpus: c.gpus, usd: c.gpus * p.rate * (L.to - L.from) / H });
      }
      opts2.sort((a, b) => a.usd - b.usd);
      if (opts2[0] && opts2[0].usd < curCost * 0.8) add({ id: `serve-model:${model}`, kind: 'serving-sizing', owner, title: `${model}: ${opts2[0].gpus} × ${opts2[0].t} would carry the busiest hour`,
        evidence: `peak ${peak.toFixed(2)} req/s at ${Math.round(isl)} in / ${Math.round(osl)} out tokens; spend now $${fmt(curCost)} in the window, ${opts2.slice(0, 3).map(x => `${x.gpus} × ${x.t} $${fmt(x.usd)}`).join(', ')}`,
        action: `Size ${model} with the Inference Sizer and load-test the new layout`, savings: { gpuH: 0, usd: curCost - opts2[0].usd }, basis: 'modelled', confidence: 'low', caveat: 'Inference Sizer on spec-sheet numbers unless calibrated; holds the busiest hour all window (no autoscaling).' });
    }
    // 6d. short answers from a big model: a smaller one may do (quality decides)
    const reqAll = s(rows, x => x.r.serving.requests || 0), outPerReq = reqAll ? s(rows, x => x.tokensOut) / reqAll : null, sizeB = (sizer && sizer.params && sizer.params(cat)) || +((String(model).match(/(\d+(?:\.\d+)?)b\b/i) || [])[1] || 0);
    if (outPerReq != null && outPerReq < o.smallOutputTokens && sizeB >= o.bigModelB && big(s(rows, x => x.alloc)))
      add({ id: `serve-smaller:${model}`, kind: 'serving-model-size', owner, title: `${model} (${sizeB}B) mostly writes short answers (${outPerReq.toFixed(0)} tokens)`,
        evidence: `${fmt(reqAll)} requests, ${outPerReq.toFixed(1)} output tokens each; $${fmt(s(rows, x => x.cost))} in the window`, action: 'Evaluate a smaller model on this traffic (classification, extraction and routing often hold up); route the requests it handles',
        savings: { gpuH: 0, usd: null }, basis: 'investigate', confidence: 'low', caveat: 'Says nothing about quality: needs an evaluation on real requests.' });
  }
  // 7. commitments: reserved GPUs used less than paid for
  for (const c of L.prices.commitments || []) {
    const t = gpuKey(c.gpuType), s0 = Math.max(L.from, c.from ?? L.from), e0 = Math.min(L.to, c.to ?? L.to); if (!(e0 > s0)) continue;
    const committed = c.gpus * (e0 - s0), used = Math.min(committed, s(L.rows.filter(x => x.r.gpuType === t && (x.r.provider || 'onprem') === c.provider), x => x.alloc));
    if (used < committed * o.commitmentSlack) add({ id: `commitment:${c.provider}:${t}`, kind: 'commitment', owner: { org: '(fleet)' }, title: `${c.provider} ${t} commitment ${Math.round(100 * used / committed)}% used`,
      evidence: `${c.gpus} GPUs committed at $${c.rate}/GPU-h; ${fmt(used / H)} of ${fmt(committed / H)} GPU-h used`, action: 'Move on-demand or on-prem overflow onto the commitment, or shrink it at renewal',
      savings: { gpuH: (committed - used) / H, usd: (committed - used) / H * c.rate }, basis: 'measured', confidence: 'high' });
  }
  // 8. capacity nobody allocated: for on-prem the avoidable part is power (the hardware is paid for)
  for (const u of L.unallocated) if (u.share > 0.2 && big(u.unallocated)) {
    const onprem = u.rateBasis === 'amortized';
    add({ id: `unallocated:${u.cluster || 'fleet'}:${u.gpuType}`, kind: 'unallocated', owner: { org: '(fleet)' }, title: `${Math.round(u.share * 100)}% of ${u.cluster ? u.cluster + ' ' : ''}${u.gpuType} capacity unallocated`,
      evidence: `${fmt(u.unallocated / H)} of ${fmt(u.capacity / H)} GPU-h allocated to nobody`, action: onprem ? 'Power down or lend idle nodes (spot/neocloud resale), or move cloud work here' : 'Release the instances',
      savings: { gpuH: u.unallocated / H, usd: onprem ? u.powerCost : u.cost }, basis: onprem ? 'measured (power only; capex is sunk)' : 'measured', confidence: 'medium' });
  }
  // 9. long training busy but slow: an upper bound until the step logs say where the time goes
  for (const [k, rows] of by(L.rows.filter(x => x.smBusy != null && x.smBusy < 0.35 && (x.r.useCase === 'training' || x.r.useCase === 'fine-tuning') && x.r.gpus >= 8), x => `${who(x)}|${x.r.group || x.r.name}`)) {
    const busy = s(rows, x => x.alloc - x.idle); if (!big(busy)) continue;
    const r = rows[0].r, sm = s(rows, x => x.smBusy * (x.alloc - x.idle)) / busy;
    add({ id: `slow-train:${k}`, kind: 'training-efficiency', owner: { user: r.user, team: r.team, org: r.org }, title: `${r.group || r.name}: GPUs busy but SM active only ${Math.round(sm * 100)}%`,
      evidence: `${fmt(busy / H)} GPU-h busy at ${Math.round(sm * 100)}% SM activity on ${r.gpus} GPUs`, action: 'Look at input pipeline, communication and kernel efficiency (fleetops goodput / tracing)',
      savings: { gpuH: busy / H * Math.max(0, 1 - sm / 0.5), usd: s(rows, x => (x.rate || 0) * (x.alloc - x.idle) / H) * Math.max(0, 1 - sm / 0.5) }, basis: 'upper bound (to 50% SM active)', confidence: 'low' });
  }
  return out.sort((a, b) => (b.savings.usdMonth ?? -1) - (a.savings.usdMonth ?? -1));
}

// The Inference Sizer as a sizer for 6c: GPUs needed for a model at a rate, and its size. Optional.
export function sizerFrom(FIT, SC, SM) {
  return {
    need(model, gpu, { isl, osl, rate }) {
      const m = SC.MODELS.find(x => x.id === model), g = SC.GPUS.find(x => x.id === gpu || x.id === gpuKey(gpu));
      if (!m || !g) return null;
      const p = SM.plan(FIT.settings(m, { gpu: g.id }, { isl, osl, rate }, { ttftS: 2, tpotS: 0.05 }), { noSens: true });
      return p.chosen ? { gpus: p.chosen.provGPUs || p.chosen.gpus, nodes: p.chosen.totalNodes } : null;
    },
    params: model => { const m = SC.MODELS.find(x => x.id === model); return m ? m.total : null; },
  };
}
