// One analysis pass: health, efficiency, savings, risk, fragmentation, then suggested actions.
import { assessHealth } from './health.mjs';
import { analyzeJobs, stragglersFromSteps, stragglersFromUtil, effective, CLASS_TEXT } from './efficiency.mjs';
import { recommend } from './savings.mjs';
import { rankRisk } from './risk.mjs';
import { fragmentation, partitionPlan } from './fragmentation.mjs';
import { suggest } from './actions.mjs';
import { priceFor } from './config.mjs';
import { coverage } from './vendors.mjs';

export function analyze({ samples, jobs = [], steps = [], probes = [], results = [], cluster = null, prev = { gpus: {} }, cfg, now, windowDays = 7 }) {
  if (!samples.length) throw new Error('no samples');
  now = now ?? Math.max(...samples.map(s => s.t));
  const window = { from: now - windowDays * 86400, to: now };
  const health = assessHealth({ samples, probes, results, jobs, prev, cfg, now });
  const jobStats = analyzeJobs(samples, jobs, cfg, window);
  const stragglers = [...stragglersFromSteps(steps, jobs)];
  for (const s of stragglersFromUtil(jobStats)) if (!stragglers.some(x => x.job === s.job)) stragglers.push(s);
  const recommendations = recommend(jobStats, stragglers, cfg, window);
  const risk = rankRisk(health, cfg);
  const frag = fragmentation(cluster, health);
  const pplan = partitionPlan(recommendations.filter(r => r.lever === 'partition'), cfg.partitions);

  // fleet summary (allocated GPUs only for utilization)
  const allocated = new Set(jobs.flatMap(j => j.gpus.map(g => g.node + '/' + g.gpu)));
  const inWin = samples.filter(s => s.t >= window.from && allocated.has(s.node + '/' + s.gpu));
  const states = {};
  for (const g of Object.values(health.gpus)) states[g.state] = (states[g.state] || 0) + 1;
  const outOfService = Object.values(health.gpus).filter(g => !g.schedulable);
  const summary = {
    window, gpus: health.fleet, allocatedGpus: allocated.size,
    effectiveUtil: inWin.length ? inWin.reduce((t, s) => t + effective(s), 0) / inWin.length : null,
    idleGpuHours: jobStats.reduce((t, j) => t + j.st.idleGpuHours, 0),
    weeklySavings: recommendations.reduce((t, r) => t + (r.weekly || 0), 0),
    gpusFreeable: recommendations.reduce((t, r) => t + (r.gpusFreed || 0), 0),
    outOfServiceCostPerWeek: outOfService.reduce((t, g) => t + priceFor(cfg, g.sku) * 168, 0),
    states, stragglers: stragglers.length, highRisk: risk.filter(r => r.tier === 'high').length,
  };
  const analysis = {
    generatedAt: now, summary, health, stragglers, recommendations, risk, fragmentation: frag, partitionPlan: pplan, jobs,
    coverage: coverage(samples.filter(s => s.t >= window.from), cfg),
    jobUsage: jobStats.map(js => ({ job: js.job.id, class: js.job.class, owner: js.job.owner || '', gpus: js.gpus.length, sku: js.sku, usage: js.cls, usageText: CLASS_TEXT[js.cls],
      tensorP50: js.st.tensorP50, smP50: js.st.smP50, dramP50: js.st.dramP50, effP50: js.st.effP50, effP95: js.st.effP95, memPeakGB: js.st.memPeakGB, memTotalGB: js.st.memTotalGB, memSource: js.st.memSource, hours: js.st.hours })),
  };
  // nodes (or GPUs) another system is remediating now: { 'node' | 'node/gpu': { by, action, check, t } }
  analysis.external = Object.fromEntries(results.filter(r => r.kind === 'external-remediation' && r.t <= now && now - r.t <= 24 * 3600).sort((a, b) => a.t - b.t)
    .map(r => [r.gpu != null ? `${r.node}/${r.gpu}` : r.node, { by: r.by, action: r.action, check: r.check, t: r.t }]));
  analysis.suggestions = suggest(analysis, cfg);
  return analysis;
}
