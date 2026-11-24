// Fragmentation: free GPUs that can't be used by what's waiting, and the smallest partition layout for the
// right-sized fractional workloads. Run it every analysis: shapes drift as jobs come and go.
//
// cluster snapshot: { nodes: [{ node, gpus: [{ gpu, alloc: 0..1 used by jobs, healthy?: bool }] }],
//                     pending: [{ job, gpus?: whole GPUs on one node, fraction?: part of one GPU }] }

export function fragmentation(cluster, health) {
  if (!cluster || !cluster.nodes) return null;
  const healthy = (node, g) => {
    if (g.healthy === false) return false;
    const h = health && health.gpus[node + '/' + g.gpu];
    return !h || h.schedulable;
  };
  const nodes = cluster.nodes.map(n => {
    const free = n.gpus.filter(g => (g.alloc || 0) === 0 && healthy(n.node, g)).length;
    const slivers = n.gpus.filter(g => (g.alloc || 0) > 0 && g.alloc < 1 && healthy(n.node, g)).reduce((t, g) => t + (1 - g.alloc), 0);
    const unhealthy = n.gpus.filter(g => !healthy(n.node, g)).length;
    return { node: n.node, total: n.gpus.length, free, slivers, unhealthy };
  });
  const pend = cluster.pending || [];
  const whole = pend.filter(p => p.gpus).map(p => p.gpus).sort((a, b) => a - b);
  const smallest = whole[0] || null;
  const freeTotal = nodes.reduce((t, n) => t + n.free, 0);
  const stranded = smallest ? nodes.filter(n => n.free < smallest).reduce((t, n) => t + n.free, 0) : 0;
  const largestBlock = Math.max(0, ...nodes.map(n => n.free));
  const blocked = pend.filter(p => p.gpus && p.gpus > largestBlock).map(p => ({ job: p.job, gpus: p.gpus, note: freeTotal >= p.gpus ? `${freeTotal} GPUs are free in total, but no node has ${p.gpus} together` : 'not enough free GPUs' }));
  return { nodes, freeTotal, slivers: nodes.reduce((t, n) => t + n.slivers, 0), stranded, largestBlock, smallestPending: smallest, blocked };
}

// Pack fractional shapes onto the fewest GPUs (first-fit decreasing). Each shape keeps one partition size.
export function partitionPlan(recs, sizes) {
  const items = recs.filter(r => r.rightSize && r.rightSize.target < 1).map(r => ({ job: r.job, size: r.rightSize.target, sku: r.sku, from: r.gpus }))
    .sort((a, b) => b.size - a.size);
  const bySku = new Map();
  for (const it of items) { if (!bySku.has(it.sku)) bySku.set(it.sku, []); bySku.get(it.sku).push(it); }
  const plan = [];
  for (const [sku, arr] of bySku) {
    const bins = [];
    for (const it of arr) {
      let b = bins.find(b => b.used + it.size <= 1 + 1e-9);
      if (!b) { b = { sku, used: 0, slices: [] }; bins.push(b); }
      b.used += it.size; b.slices.push({ job: it.job, size: it.size });
    }
    // fill the unused part of each GPU with the largest slices that fit, for future small jobs
    for (const b of bins) { let left = 1 - b.used; for (const s of sizes.filter(s => s < 1).sort((x, y) => y - x)) while (left + 1e-9 >= s) { b.slices.push({ job: null, size: s }); left -= s; } }
    plan.push({ sku, gpusNeeded: bins.length, gpusNow: arr.reduce((t, x) => t + x.from, 0), layout: bins.map(b => b.slices.map(s => (s.job ? `${s.size}:${s.job}` : `${s.size}:free`)).join(' + ')) });
  }
  return plan;
}
