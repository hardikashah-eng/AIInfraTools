// Outcome-labelled task runs: what an agent spent per task and whether the task succeeded. From these: cost per
// successful task, the share of spend that went to tasks that failed, and what a step or spend cap would have saved
// against the successes it would have cost.
//
// A task: { task, run, model, cost, calls, outcome: 'success'|'failure' }.
// Inputs: SWE-bench per_instance_details.json ({ instance: { cost, api_calls, resolved } }, as in the SWE-bench
// experiments repository), or a JSON array / CSV of tasks.

export function tasksFromSwebench(json, { run = 'run', model = null } = {}) {
  return Object.entries(json || {}).filter(([, v]) => v && typeof v === 'object').map(([task, v]) => ({
    task, run, model, cost: Number(v.cost ?? v.instance_cost ?? 0) || 0, calls: Number(v.api_calls ?? v.calls ?? 0) || 0, outcome: v.resolved ? 'success' : 'failure' }));
}
export function tasksFromRows(rows, { run = 'run' } = {}) {
  return rows.map(r => ({ task: String(r.task ?? r.session ?? r.instance ?? r.id), run: r.run || run, model: r.model || null, cost: Number(r.cost ?? r.costUSD ?? 0) || 0,
    calls: Number(r.calls ?? r.api_calls ?? r.steps ?? 0) || 0, outcome: /^(1|true|success|resolved|pass(ed)?)$/i.test(String(r.outcome ?? r.resolved)) ? 'success' : 'failure' }));
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const mean = (xs, f) => (xs.length ? sum(xs, f) / xs.length : null);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null; };

// Stop every task at `cap` calls. Assumes each call costs the task's average (a task's later calls carry more context,
// so real savings are larger: this is the conservative estimate) and that a success needing more calls is lost.
export function capAt(tasks, cap) {
  let cost = 0, succ = 0;
  for (const t of tasks) { const f = t.calls > 0 ? Math.min(1, cap / t.calls) : 1; cost += t.cost * f; if (t.outcome === 'success' && t.calls <= cap) succ++; }
  return { cap, cost, successes: succ };
}
export function capCurve(tasks, caps) {
  const base = { cost: sum(tasks, t => t.cost), successes: tasks.filter(t => t.outcome === 'success').length };
  return caps.map(c => { const r = capAt(tasks, c); return { cap: c, saved: base.cost ? 1 - r.cost / base.cost : 0, successesLost: base.successes - r.successes,
    rateLossPts: tasks.length ? 100 * (base.successes - r.successes) / tasks.length : 0, costPerSuccess: r.successes ? r.cost / r.successes : null }; });
}
// The cap that saves the most while losing at most `maxLossPts` points of success rate.
export function bestCap(curve, maxLossPts = 1) { return curve.filter(c => c.rateLossPts <= maxLossPts).sort((a, b) => b.saved - a.saved)[0] || null; }

export function runSummary(tasks, { caps } = {}) {
  const succ = tasks.filter(t => t.outcome === 'success'), fail = tasks.filter(t => t.outcome === 'failure'), cost = sum(tasks, t => t.cost);
  const maxCalls = Math.max(1, ...tasks.map(t => t.calls));
  const cs = caps || [10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250].filter(c => c < maxCalls);
  const curve = capCurve(tasks, cs);
  return { run: tasks[0] && tasks[0].run, model: tasks[0] && tasks[0].model, tasks: tasks.length, successes: succ.length, rate: tasks.length ? succ.length / tasks.length : 0,
    cost, costPerTask: cost / Math.max(1, tasks.length), costPerSuccess: succ.length ? cost / succ.length : null, failShare: cost ? sum(fail, t => t.cost) / cost : 0,
    calls: { success: { mean: mean(succ, t => t.calls), p90: q(succ.map(t => t.calls), 0.9) }, failure: { mean: mean(fail, t => t.calls), p90: q(fail.map(t => t.calls), 0.9) } },
    costPerTaskBy: { success: mean(succ, t => t.cost), failure: mean(fail, t => t.cost) }, curve, best1pt: bestCap(curve, 1), best05pt: bestCap(curve, 0.5) };
}

export function outcomeReport(tasks, opt = {}) {
  const runs = new Map(); for (const t of tasks) { if (!runs.has(t.run)) runs.set(t.run, []); runs.get(t.run).push(t); }
  const usable = [...runs.values()].filter(ts => ts.some(t => t.outcome === 'success') && sum(ts, t => t.cost) > 0);
  const skipped = [...runs.keys()].filter(k => !usable.some(ts => ts[0].run === k));
  const per = usable.map(ts => runSummary(ts, opt)).sort((a, b) => (a.costPerSuccess ?? Infinity) - (b.costPerSuccess ?? Infinity));
  const all = usable.flat();
  return { runs: per, skipped, pooled: per.length ? { tasks: all.length, failShare: sum(all.filter(t => t.outcome === 'failure'), t => t.cost) / Math.max(1e-12, sum(all, t => t.cost)),
    medianFailShare: q(per.map(r => r.failShare), 0.5), callsRatio: q(per.map(r => (r.calls.failure.mean || 0) / Math.max(1, r.calls.success.mean || 1)), 0.5),
    medianBest1ptSaved: q(per.map(r => (r.best1pt ? r.best1pt.saved : 0)), 0.5) } : null };
}

const $ = x => (x == null ? '–' : x >= 100 ? '$' + x.toFixed(0) : x >= 1 ? '$' + x.toFixed(2) : '$' + x.toFixed(3));
const P = x => (x == null ? '–' : (100 * x).toFixed(0) + '%');
export function outcomeText(R) {
  const L = [`${R.runs.length} runs, ${R.pooled ? R.pooled.tasks : 0} tasks${R.skipped.length ? ` (skipped, no successes or no cost: ${R.skipped.join(', ')})` : ''}`, '',
    '  run                                        success  cost/task  cost/success  spent on failures  calls ok/failed  cap (≤1 pt lost)'];
  for (const r of R.runs) L.push(`  ${String(r.model || r.run).slice(0, 42).padEnd(42)} ${P(r.rate).padStart(7)}  ${$(r.costPerTask).padStart(9)}  ${$(r.costPerSuccess).padStart(12)}  ${P(r.failShare).padStart(17)}  ${String(Math.round(r.calls.success.mean || 0)).padStart(6)}/${String(Math.round(r.calls.failure.mean || 0)).padEnd(8)}  ${r.best1pt ? `${r.best1pt.cap} calls: −${P(r.best1pt.saved)} cost, −${r.best1pt.rateLossPts.toFixed(1)} pts` : '–'}`);
  if (R.pooled) L.push('', `  median run: ${P(R.pooled.medianFailShare)} of spend on tasks that failed; failed tasks take ${R.pooled.callsRatio.toFixed(2)}× the calls of successful ones; a call cap losing ≤1 point of success saves ${P(R.pooled.medianBest1ptSaved)}`);
  return L.join('\n') + '\n';
}
