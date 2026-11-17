/* FleetScope plan: compare a base and a head scenario (fleet graph, cluster, training job) the way
   `terraform plan` compares infrastructure: run both, diff the outcomes, name the owners, give a verdict.
   Shared by tools/fleetscope-plan.mjs (CI) and the browser's Report button. */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const E = node ? require('./engine.js') : root.FleetEngine;
  const C = node ? require('./cluster.js') : root.FleetCluster;
  const T = node ? require('./training.js') : root.FleetTraining;
  const SC = node ? require('./scenario.js') : root.FleetScenarioLib;

  const THRESHOLDS = { sloDropPts: 1, costRisePct: 10, allocationDropPts: 5, goodputDropPts: 3 };

  // ---------- a tiny YAML reader for Kubernetes manifests (maps, lists, scalars, --- documents) ----------
  function parseYaml(text) {
    const docs = [];
    for (const chunk of String(text).split(/^---\s*$/m)) {
      const lines = chunk.split(/\r?\n/).map(l => l.replace(/\s+#.*$/, '')).filter(l => l.trim() && !l.trim().startsWith('#'));
      if (!lines.length) continue;
      let i = 0;
      const indent = l => l.match(/^ */)[0].length;
      const scalar = v => { v = v.trim(); if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1); if (v === 'true') return true; if (v === 'false') return false; if (v === 'null' || v === '~' || v === '') return null; if (/^-?\d+(\.\d+)?$/.test(v)) return +v; if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(x => scalar(x)).filter(x => x !== null); return v; };
      function block(ind) {
        if (i >= lines.length) return null;
        if (lines[i].trim().startsWith('- ')) {
          const arr = [];
          while (i < lines.length && indent(lines[i]) === ind && lines[i].trim().startsWith('- ')) {
            const rest = lines[i].trim().slice(2);
            if (/^[\w.\/-]+:(\s|$)/.test(rest)) { lines[i] = ' '.repeat(ind + 2) + rest; arr.push(block(ind + 2)); }
            else { arr.push(scalar(rest)); i++; }
          }
          return arr;
        }
        const obj = {};
        while (i < lines.length && indent(lines[i]) === ind && !lines[i].trim().startsWith('- ')) {
          const m = lines[i].trim().match(/^([^:]+):\s*(.*)$/);
          if (!m) { i++; continue; }
          i++;
          if (m[2] !== '') obj[m[1].trim()] = scalar(m[2]);
          else if (i < lines.length && (indent(lines[i]) > ind || (indent(lines[i]) === ind && lines[i].trim().startsWith('- ')))) obj[m[1].trim()] = block(indent(lines[i]));
          else obj[m[1].trim()] = null;
        }
        return obj;
      }
      docs.push(block(indent(lines[0])));
    }
    return docs;
  }
  // Kueue ClusterQueues (YAML or JSON) → nominal GPU quota per queue name.
  function kueueQuotas(text) {
    let docs;
    try { const j = JSON.parse(text); docs = j.items || (Array.isArray(j) ? j : [j]); } catch (e) { docs = parseYaml(text); }
    const out = {};
    for (const d of docs) {
      if (!d || d.kind !== 'ClusterQueue') continue;
      let q = 0;
      for (const rg of (d.spec && d.spec.resourceGroups) || []) for (const f of rg.flavors || []) for (const r of f.resources || []) if (/gpu/.test(r.name)) q += +r.nominalQuota || 0;
      out[d.metadata.name] = q;
    }
    return out;
  }
  function applyKueue(cluster, quotas) {
    const c = JSON.parse(JSON.stringify(cluster));
    for (const q of c.queues) if (quotas[q.id] != null || quotas[q.name] != null) q.quota = quotas[q.id] != null ? quotas[q.id] : quotas[q.name];
    return c;
  }

  // ---------- running a scenario ----------
  const SUITE = [
    { name: 'As drawn', st: null },
    { name: 'Traffic ×1.5', st: { name: 'Traffic ×1.5', surge: { mult: 1.5, start: 0, dur: 0, target: 'all' }, outages: [] } },
    { name: 'Largest pool half down', st: 'halfDown' },
    { name: 'Contexts ×2', st: { name: 'Contexts ×2', ctx: { mult: 2, add: 0 }, outages: [] } }
  ];
  function runScenario(sc, opt) {
    opt = opt || {};
    const out = { name: sc.name || 'scenario' };
    if (sc.graph) {
      const lookup = opt.traceLookup || ((k, s) => E.scaleTrace(E.genTrace(k === 'uploaded' || k === 'live' ? 'chat' : k, 7), s || 1, 7));
      const c = E.compileGraph(sc.graph, lookup);
      if (c.errors.length) out.fleetErrors = c.errors.map(e => e.msg);
      else {
        const big = c.spec.pools.slice().sort((a, b) => b.max - a.max)[0];
        out.fleet = SUITE.map(x => {
          const st = x.st === 'halfDown' ? { name: x.name, outages: [{ target: big.id, fraction: 0.5, start: 0, dur: 1e9, recovery: 0 }] } : x.st;
          const s = E.simulate(c.spec, st).summary;
          return { name: x.name === 'Largest pool half down' ? big.name + ' half down' : x.name, slo: s.slo, ttftP99: s.ttftP99, tpotP99: s.tpotP99, costPerHr: s.costPerHr, peakGpus: s.peakGpus, rejected: s.rejected, lost: s.lost, bottleneck: s.bottleneck.first ? s.bottleneck.first.name + ': ' + s.bottleneck.first.label : null };
        });
        out.lint = E.lintSpec(c.spec).map(x => x.msg);
      }
    }
    if (sc.cluster) {
      let cs = sc.cluster;
      if (sc.kueue) cs = applyKueue(cs, kueueQuotas(sc.kueue));
      const s = C.simulateCluster(cs).summary;
      out.cluster = { allocation: s.allocation, strandedGpuH: s.strandedGpuH, idleAllocGpuH: s.idleAllocGpuH, trainingAdmitted: s.trainingAdmitted, trainingTotal: s.trainingTotal, trainingWaitMin: s.trainingWaitMin, inferenceFull: s.inferenceFull, preemptions: s.preemptions };
    }
    if (sc.training) { const s = T.simulateTraining(sc.training).summary; out.training = { goodput: s.goodput, mfu: s.mfu, tokensB: s.tokensB, bottleneck: s.bottleneck ? s.bottleneck.label : null }; }
    return out;
  }

  // ---------- comparing ----------
  function compare(base, head, opt) {
    opt = opt || {};
    const th = Object.assign({}, THRESHOLDS, opt.thresholds || {});
    const B = runScenario(base, opt), H = runScenario(head, opt), checks = [];
    const add = (name, b, h, bad, fmt, why) => checks.push({ name, base: b, head: h, fail: !!bad, fmt, why: bad ? why : '' });
    if (B.fleet && H.fleet) {
      H.fleet.forEach((r, i) => { const b = B.fleet[i]; if (!b) return; add('SLO met · ' + r.name, b.slo, r.slo, (b.slo - r.slo) * 100 > th.sloDropPts, 'pct', 'drops more than ' + th.sloDropPts + ' pt'); });
      const b0 = B.fleet[0], h0 = H.fleet[0];
      add('Serving $ / hour', b0.costPerHr, h0.costPerHr, h0.costPerHr > b0.costPerHr * (1 + th.costRisePct / 100), 'usd', 'rises more than ' + th.costRisePct + '%');
      add('TTFT p99', b0.ttftP99, h0.ttftP99, false, 's');
      add('Peak serving GPUs', b0.peakGpus, h0.peakGpus, false, 'int');
    }
    if (H.fleetErrors) checks.push({ name: 'Head graph compiles', base: 'yes', head: 'no', fail: true, fmt: 'text', why: H.fleetErrors.join('; ') });
    if (B.cluster && H.cluster) {
      add('GPU allocation', B.cluster.allocation, H.cluster.allocation, (B.cluster.allocation - H.cluster.allocation) * 100 > th.allocationDropPts, 'pct', 'drops more than ' + th.allocationDropPts + ' pt');
      add('Training jobs started', B.cluster.trainingAdmitted, H.cluster.trainingAdmitted, H.cluster.trainingAdmitted < B.cluster.trainingAdmitted, 'int', 'fewer jobs start');
      add('Inference fully placed', B.cluster.inferenceFull, H.cluster.inferenceFull, (B.cluster.inferenceFull - H.cluster.inferenceFull) * 100 > th.sloDropPts, 'pct', 'serving is short more often');
      add('Stranded GPU-hours', B.cluster.strandedGpuH, H.cluster.strandedGpuH, false, 'gh');
      add('Preemptions', B.cluster.preemptions, H.cluster.preemptions, false, 'int');
    }
    if (B.training && H.training) add('Training goodput', B.training.goodput, H.training.goodput, (B.training.goodput - H.training.goodput) * 100 > th.goodputDropPts, 'pct', 'drops more than ' + th.goodputDropPts + ' pt');
    const changes = [];
    if (base.graph && head.graph) for (const l of SC.describeGraph(base.graph, head.graph)) changes.push({ where: 'fleet', text: l });
    if (base.cluster && head.cluster) for (const l of SC.describeSpec(base.cluster, head.cluster)) changes.push({ where: 'cluster', text: l });
    if (base.kueue !== head.kueue && head.kueue) { const qb = base.kueue ? kueueQuotas(base.kueue) : {}, qh = kueueQuotas(head.kueue); for (const k in qh) if (qb[k] !== qh[k]) changes.push({ where: 'kueue', text: k + ': nominal GPU quota ' + (qb[k] == null ? '—' : qb[k]) + ' → ' + qh[k] }); }
    if (base.training && head.training) for (const l of SC.describeSpec(base.training, head.training)) changes.push({ where: 'training', text: l });
    const owners = reviewers(base, head);
    const fails = checks.filter(c => c.fail);
    return { base: B, head: H, checks, changes, owners, verdict: fails.length ? 'fail' : changes.length ? 'pass' : 'nochange', fails, thresholds: th, newLint: H.lint ? H.lint.filter(m => !(B.lint || []).includes(m)) : [] };
  }
  // Owners of the nodes a change touches, with their on-call, from the head graph.
  function reviewers(base, head) {
    if (!base.graph || !head.graph) return [];
    const A = Object.fromEntries(base.graph.nodes.map(n => [n.id, n])), out = new Map();
    for (const n of head.graph.nodes) {
      const a = A[n.id];
      const changed = !a || SC.diff(a.cfg, n.cfg).some(d => !/(^|\.)(x|y)$/.test(d.path));
      if (changed && n.cfg && n.cfg.owner) { const k = n.cfg.owner; if (!out.has(k)) out.set(k, { team: k, oncall: n.cfg.oncall || '', nodes: [] }); out.get(k).nodes.push(n.cfg.name); }
    }
    return [...out.values()];
  }

  // ---------- rendering ----------
  const F = {
    pct: v => (isFinite(v) ? (v * 100).toFixed(1) + '%' : '–'), usd: v => (isFinite(v) ? '$' + v.toFixed(2) : '–'), s: v => (isFinite(v) ? v.toFixed(2) + ' s' : '–'),
    int: v => (isFinite(v) ? String(Math.round(v)) : '–'), gh: v => (isFinite(v) ? Math.round(v) + ' GPU-h' : '–'), text: v => String(v)
  };
  function delta(c) {
    if (c.fmt === 'text' || !isFinite(c.base) || !isFinite(c.head)) return '';
    const d = c.head - c.base;
    if (Math.abs(d) < 1e-9) return '=';
    return (d > 0 ? '+' : '−') + (c.fmt === 'pct' ? (Math.abs(d) * 100).toFixed(1) + ' pt' : F[c.fmt](Math.abs(d)).replace(/^\$/, '$'));
  }
  function markdown(res, meta) {
    meta = meta || {};
    const icon = res.verdict === 'fail' ? '❌' : res.verdict === 'pass' ? '✅' : '➖';
    const L = [];
    L.push('### ' + icon + ' FleetScope plan' + (meta.scenario ? ': `' + meta.scenario + '`' : ''));
    L.push(res.verdict === 'fail' ? '**' + res.fails.length + ' check' + (res.fails.length > 1 ? 's' : '') + ' failed.** ' + res.fails.map(f => f.name + ' ' + f.why).join('; ') + '.' : res.verdict === 'pass' ? 'All checks pass.' : 'No changes to the scenario.');
    if (res.changes.length) { L.push('', '**What changed**', ''); for (const c of res.changes) L.push('- ' + c.where + ': ' + c.text.replace(/\|/g, '\\|')); }
    if (res.checks.length) {
      L.push('', '| Check | Base | Head | Change | |', '| --- | ---: | ---: | ---: | --- |');
      for (const c of res.checks) L.push('| ' + c.name + ' | ' + F[c.fmt](c.base) + ' | ' + F[c.fmt](c.head) + ' | ' + delta(c) + ' | ' + (c.fail ? '❌ ' + c.why : '') + ' |');
    }
    const b0 = res.head.fleet && res.head.fleet[0];
    if (b0 && b0.bottleneck) L.push('', 'First bottleneck (head, as drawn): ' + b0.bottleneck + '.');
    if (res.newLint.length) { L.push('', '**New potential issues**', ''); for (const m of res.newLint) L.push('- ' + m); }
    if (res.owners.length) { L.push('', '**Owners of what changed**', ''); for (const o of res.owners) L.push('- ' + o.team + (o.oncall ? ' (' + o.oncall + ')' : '') + ': ' + o.nodes.join(', ')); }
    L.push('', '<sub>Thresholds: SLO −' + res.thresholds.sloDropPts + ' pt, serving cost +' + res.thresholds.costRisePct + '%, allocation −' + res.thresholds.allocationDropPts + ' pt, training goodput −' + res.thresholds.goodputDropPts + ' pt. Simulated, ' + (meta.calibrated ? 'calibrated' : 'uncalibrated unless pools carry fitted multipliers') + '.</sub>');
    return L.join('\n');
  }

  const api = { THRESHOLDS, SUITE, parseYaml, kueueQuotas, applyKueue, runScenario, compare, reviewers, markdown };
  if (node) module.exports = api; else root.FleetPlan = api;
})(typeof window !== 'undefined' ? window : this);
