/* FleetScope cluster layer: Kubernetes-style scheduling of GPU pods onto nodes.
   A time-stepped simulation of node pools, queues with quotas, workloads (inference deployments, training gangs,
   batch jobs), a scheduler policy, preemption and GPU faults. Deterministic for a given spec and seed. */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.FleetEngine;
  const STEP = 10; // seconds per tick

  const POLICY_DEFAULTS = { placement: 'binpack', gang: true, topology: true, preemption: true, borrowing: true, order: 'besteffort' };
  const REASON = { quota: 'over its queue quota', capacity: 'not enough free GPUs', fragmentation: 'free GPUs are scattered across nodes', topology: 'no single IB domain has room', gang: 'waiting for the rest of its gang', fault: 'restarting after a GPU fault' };

  function normalize(spec) {
    const s = JSON.parse(JSON.stringify(spec));
    s.policy = Object.assign({}, POLICY_DEFAULTS, s.policy || {});
    s.horizonH = s.horizonH || 8;
    s.seed = s.seed || 11;
    for (const p of s.pools) Object.assign(p, Object.assign({ gpusPerNode: 8, nodes: 16, domainNodes: 16, faultPerGpuDay: 0.002, repairH: 4, site: 'On-prem DC' }, p));
    for (const q of s.queues) Object.assign(q, Object.assign({ quota: 64, priority: 0, team: '' }, q));
    for (const w of s.workloads) Object.assign(w, Object.assign({ kind: 'batch', gpusPerPod: 1, pods: 1, priority: null, topology: 'any', startH: 0, durationH: 1, ckptMin: 30, restartMin: 10, minPods: null, peakH: 14, ratePerH: 4, pool: null }, w));
    return s;
  }

  function simulateCluster(specIn, over) {
    const spec = normalize(specIn);
    if (over && over.policy) Object.assign(spec.policy, over.policy);
    if (over && over.edit) over.edit(spec);
    const pol = spec.policy, rng = E.makeRng(spec.seed >>> 0), T = Math.round(spec.horizonH * 3600 / STEP);

    // ----- hardware -----
    const nodes = [], gpuNode = [], domains = [];
    let G = 0;
    spec.pools.forEach((p, pi) => {
      for (let k = 0; k < p.nodes; k++) {
        const dk = Math.floor(k / Math.max(1, p.domainNodes));
        const dkey = pi + ':' + dk;
        let d = domains.findIndex(x => x.key === dkey);
        if (d < 0) { domains.push({ key: dkey, pool: pi, nodes: [] }); d = domains.length - 1; }
        const n = { i: nodes.length, pool: pi, domain: d, name: p.name + '-' + String(k).padStart(2, '0'), base: G, gpus: p.gpusPerNode, free: p.gpusPerNode, faults: 0 };
        nodes.push(n); domains[d].nodes.push(n.i);
        for (let g = 0; g < p.gpusPerNode; g++) gpuNode.push(n.i);
        G += p.gpusPerNode;
      }
    });
    const owner = new Int32Array(G).fill(-1);      // pod id holding the GPU
    const downUntil = new Float64Array(G);         // > t while faulted
    const gpuFaults = new Uint16Array(G);

    // ----- queues and workloads -----
    const queues = spec.queues.map(q => Object.assign({}, q, { used: 0 }));
    const qIdx = {}; queues.forEach((q, i) => { qIdx[q.id] = i; });
    const pods = [];
    const W = [];
    const wlState = [];
    spec.workloads.forEach((w, wi) => {
      const q = qIdx[w.queue] != null ? qIdx[w.queue] : 0;
      const prio = w.priority != null ? w.priority : (queues[q] ? queues[q].priority : 0);
      W.push({ i: wi, spec: w, q, prio, pods: [], submitted: NaN, admitted: NaN, finished: NaN, progress: 0, ckpt: 0, restartUntil: 0, work: w.durationH * 3600,
        preempts: 0, restarts: 0, faults: 0, lostGpuS: 0, allocS: 0, goodS: 0, waitS: 0, reasonS: {}, jobs: [], nextArrival: NaN, idleS: 0 });
      wlState.push(new Uint8Array(T));
    });
    const events = [];
    const ev = (t, kind, wl, detail) => events.push({ t, kind, wl, detail });

    function newPod(w, t, extra) {
      const p = Object.assign({ id: pods.length, wl: w.i, gpus: w.spec.gpusPerPod, node: -1, gpuIdx: null, state: 'pending', since: t, borrowed: false }, extra || {});
      pods.push(p); w.pods.push(p.id);
      return p;
    }
    function release(p) {
      if (p.state !== 'running') return;
      const n = nodes[p.node];
      for (const g of p.gpuIdx) { owner[g] = -1; if (downUntil[g] <= curT) n.free++; }
      queues[W[p.wl].q].used -= p.gpus;
      p.state = 'pending'; p.node = -1; p.gpuIdx = null; p.borrowed = false;
    }
    function place(p, ni, t) {
      const n = nodes[ni], idx = [];
      for (let g = n.base; g < n.base + n.gpus && idx.length < p.gpus; g++) if (owner[g] < 0 && downUntil[g] <= t) idx.push(g);
      for (const g of idx) owner[g] = p.id;
      n.free -= p.gpus;
      p.node = ni; p.gpuIdx = idx; p.state = 'running'; p.started = t;
      const Q = queues[W[p.wl].q];
      p.borrowed = Q.used + p.gpus > Q.quota;
      Q.used += p.gpus;
    }
    function removePod(p) {
      release(p);
      p.state = 'gone';
      const w = W[p.wl];
      w.pods = w.pods.filter(x => x !== p.id);
    }

    // Kill a training job's pods (fault or preemption): back to the last checkpoint, all pods pending again.
    function stopJob(w, t, why) {
      const run = w.pods.map(id => pods[id]).filter(p => p.state === 'running');
      const lost = Math.max(0, w.progress - w.ckpt);
      w.lostGpuS += lost * w.spec.pods * w.spec.gpusPerPod;
      w.progress = w.ckpt;
      for (const p of run) release(p);
      for (const id of w.pods) pods[id].since = t;
      w.wasRunning = false;
      if (why === 'fault') { w.restarts++; ev(t, 'restart', w.i, 'lost ' + Math.round(lost / 60) + ' min of training since the last checkpoint'); }
      else { w.preempts++; ev(t, 'preempt', w.i, 'preempted; lost ' + Math.round(lost / 60) + ' min since the last checkpoint'); }
    }

    // ----- placement -----
    // Returns node indices for each pod of the request, or null. free: per-node free GPU counts to plan against.
    function allowedNode(w, n) {
      const s = w.spec;
      if (s.pool != null && spec.pools[n.pool].id !== s.pool) return false;
      if (s.gpu && spec.pools[n.pool].gpu !== s.gpu) return false;
      return true;
    }
    function pickNode(cands, free, need) {
      let best = -1, bv = 0;
      for (const ni of cands) {
        const f = free[ni];
        if (f < need) continue;
        const v = pol.placement === 'spread' ? f : -f;
        if (best < 0 || v > bv) { best = ni; bv = v; }
      }
      return best;
    }
    function plan(w, podList, free) {
      const need = w.spec.gpusPerPod;
      const tryIn = cands => {
        const f = free.slice(), out = [];
        for (let k = 0; k < podList.length; k++) { const ni = pickNode(cands, f, need); if (ni < 0) return null; f[ni] -= need; out.push(ni); }
        return out;
      };
      const all = nodes.filter(n => allowedNode(w, n)).map(n => n.i);
      if (w.spec.topology === 'domain' && pol.topology && podList.length > 1) {
        // choose the IB domain by policy: bin-pack into the fullest that fits, or spread into the emptiest
        const doms = domains.map((d, di) => ({ di, nodes: d.nodes.filter(ni => all.includes(ni)) })).filter(d => d.nodes.length)
          .map(d => ({ d, free: d.nodes.reduce((a, ni) => a + free[ni], 0) }))
          .sort((a, b) => pol.placement === 'spread' ? b.free - a.free : a.free - b.free);
        for (const x of doms) { const r = tryIn(x.d.nodes); if (r) return r; }
        return null;
      }
      return tryIn(all);
    }
    function whyNot(w, podList, free) {
      const need = w.spec.gpusPerPod * podList.length;
      const all = nodes.filter(n => allowedNode(w, n));
      const tot = all.reduce((a, n) => a + free[n.i], 0);
      if (tot < need) return 'capacity';
      if (w.spec.topology === 'domain' && pol.topology && podList.length > 1) {
        const f = free.slice(); let ok = true;
        for (let k = 0; k < podList.length; k++) { const ni = pickNode(all.map(n => n.i), f, w.spec.gpusPerPod); if (ni < 0) { ok = false; break; } f[ni] -= w.spec.gpusPerPod; }
        if (ok) return 'topology';
      }
      return 'fragmentation';
    }
    function quotaOk(w, gpus) {
      const Q = queues[w.q];
      if (Q.used + gpus <= Q.quota) return true;
      if (!pol.borrowing) return false;
      let lend = 0;
      for (const o of queues) if (o !== Q) lend += Math.max(0, o.quota - o.used);
      return Q.used + gpus <= Q.quota + lend;
    }
    // Units that can be evicted for a request: whole training jobs, or single pods; lower priority first,
    // or pods borrowed beyond their quota when the requester is within its own.
    function victims(w, gpus, sameQueue) {
      const Q = queues[w.q], within = Q.used + gpus <= Q.quota, units = [];
      for (const v of W) {
        if (v === w || (sameQueue && v.q !== w.q)) continue;
        const run = v.pods.map(id => pods[id]).filter(p => p.state === 'running');
        if (!run.length) continue;
        const lower = v.prio < w.prio, reclaim = within && run.some(p => p.borrowed) && v.q !== w.q;
        if (!lower && !reclaim) continue;
        if (v.spec.kind === 'training') units.push({ w: v, pods: run, prio: v.prio, gpus: run.reduce((a, p) => a + p.gpus, 0) });
        else for (const p of run) if (lower || p.borrowed) units.push({ w: v, pods: [p], prio: v.prio, gpus: p.gpus });
      }
      return units.sort((a, b) => a.prio - b.prio || a.gpus - b.gpus);
    }

    // ----- demand -----
    function inferenceTarget(s, t) {
      const h = t / 3600, lo = s.minPods != null ? s.minPods : Math.max(1, Math.round(s.pods / 3));
      const load = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h - (s.peakH - (s.clockH || 9))) / 24);
      return Math.round(lo + (s.pods - lo) * load);
    }

    // ----- series -----
    const ser = {}; for (const k of ['alloc', 'idleAlloc', 'free', 'faulted', 'stranded', 'pendQuota', 'pendCapacity', 'pendFragmentation', 'pendTopology', 'running', 'pending']) ser[k] = new Float32Array(T);
    const frames = [];
    let curT = 0;

    for (let k = 0; k < T; k++) {
      const t = k * STEP; curT = t;
      // repairs
      for (let g = 0; g < G; g++) if (downUntil[g] > 0 && downUntil[g] <= t && downUntil[g] > t - STEP) { if (owner[g] < 0) nodes[gpuNode[g]].free++; }
      // faults
      for (const p of spec.pools) p._pf = p.faultPerGpuDay * STEP / 86400;
      for (let g = 0; g < G; g++) {
        if (downUntil[g] > t) continue;
        const n = nodes[gpuNode[g]], P = spec.pools[n.pool];
        if (rng.u() >= P._pf) continue;
        downUntil[g] = t + P.repairH * 3600 * (0.5 + rng.u());
        gpuFaults[g]++; n.faults++;
        const pid = owner[g];
        if (pid < 0) { n.free--; continue; }
        const p = pods[pid], w = W[p.wl];
        w.faults++;
        ev(t, 'fault', w.i, 'GPU ' + (g - n.base) + ' on ' + n.name + ' failed');
        if (w.spec.kind === 'training') stopJob(w, t, 'fault');
        else { if (w.spec.kind === 'batch') { const j = w.jobs.find(x => x.pod === pid); if (j) j.left = j.dur; } release(p); p.since = t; }
        // release() leaves the faulted GPU out of the free count until it is repaired
      }
      // demand
      for (const w of W) {
        const s = w.spec;
        if (s.kind === 'inference') {
          if (t < s.startH * 3600) continue;
          if (isNaN(w.submitted)) w.submitted = t;
          const want = inferenceTarget(s, t), live = w.pods.map(id => pods[id]);
          if (live.length < want) { for (let i = live.length; i < want; i++) newPod(w, t); if (k && want > live.length) ev(t, 'scale', w.i, 'scaled to ' + want + ' replicas'); }
          else if (live.length > want) {
            const order = live.slice().sort((a, b) => (a.state === 'pending' ? 0 : 1) - (b.state === 'pending' ? 0 : 1) || b.id - a.id);
            for (let i = 0; i < live.length - want; i++) removePod(order[i]);
          }
        } else if (s.kind === 'training') {
          if (t >= s.startH * 3600 && isNaN(w.submitted)) { w.submitted = t; for (let i = 0; i < s.pods; i++) newPod(w, t); ev(t, 'submit', w.i, s.pods + ' pods × ' + s.gpusPerPod + ' GPUs submitted'); }
        } else {
          if (t < s.startH * 3600) continue;
          if (isNaN(w.nextArrival)) { w.nextArrival = t; w.submitted = t; }
          while (w.nextArrival <= t) {
            const dur = Math.max(300, rng.logn(s.durationH * 3600, 0.5));
            const p = newPod(w, w.nextArrival);
            w.jobs.push({ pod: p.id, dur, left: dur, t0: w.nextArrival, start: NaN, end: NaN });
            w.nextArrival += -Math.log(1 - rng.u()) * 3600 / Math.max(0.01, s.ratePerH);
          }
        }
      }
      // progress
      for (const w of W) {
        const s = w.spec, run = w.pods.map(id => pods[id]).filter(p => p.state === 'running');
        const gpus = run.reduce((a, p) => a + p.gpus, 0);
        w.allocS += gpus * STEP;
        if (s.kind === 'training' && w.pods.length && isNaN(w.finished)) {
          const full = run.length === s.pods;
          if (full && !w.wasRunning) { w.wasRunning = true; w.restartUntil = t + s.restartMin * 60; if (isNaN(w.admitted)) { w.admitted = t; ev(t, 'admit', w.i, 'all ' + s.pods + ' pods running after ' + Math.round((t - w.submitted) / 60) + ' min'); } }
          if (full && t >= w.restartUntil) {
            w.progress += STEP; w.goodS += gpus * STEP;
            if (s.ckptMin > 0 && w.progress - w.ckpt >= s.ckptMin * 60) w.ckpt = w.progress;
            if (w.progress >= w.work) { w.finished = t; for (const p of run) removePod(p); ev(t, 'finish', w.i, 'finished'); }
          } else w.idleS += gpus * STEP;
        } else if (s.kind === 'batch') {
          for (const j of w.jobs) {
            const p = pods[j.pod];
            if (p.state !== 'running' || !isNaN(j.end)) continue;
            if (isNaN(j.start)) j.start = t;
            j.left -= STEP; w.goodS += p.gpus * STEP;
            if (j.left <= 0) { j.end = t; removePod(p); }
          }
        } else if (s.kind === 'inference') { w.goodS += gpus * STEP; if (isNaN(w.admitted) && gpus) w.admitted = t; }
      }
      // schedule
      const pend = [];
      for (const w of W) {
        const pp = w.pods.map(id => pods[id]).filter(p => p.state === 'pending');
        if (!pp.length) continue;
        if (w.spec.kind === 'training' && pol.gang) pend.push({ w, pods: pp, since: Math.min(...pp.map(p => p.since)) });
        else for (const p of pp) pend.push({ w, pods: [p], since: p.since });
      }
      pend.sort((a, b) => b.w.prio - a.w.prio || a.since - b.since || a.w.i - b.w.i);
      const blockedQ = new Set(), reasons = new Map(), noVictims = new Set();
      for (const R of pend) {
        const w = R.w, gpus = R.pods.length * w.spec.gpusPerPod;
        if (pol.order === 'strict' && blockedQ.has(w.q)) { reasons.set(R, reasons.get(R) || 'capacity'); continue; }
        // Over quota: only lower-priority work in the same queue can be preempted to make room (as Kueue does).
        const quotaShort = !quotaOk(w, gpus);
        if (quotaShort && !pol.preemption) { reasons.set(R, 'quota'); blockedQ.add(w.q); continue; }
        const free = nodes.map(n => n.free);
        let pl = quotaShort ? null : plan(w, R.pods, free);
        if (!pl && pol.preemption && !noVictims.has(w.i)) {
          const V = victims(w, gpus, quotaShort), chosen = [], f = free.slice();
          let freedQ = 0;
          for (const v of V) {
            chosen.push(v);
            for (const p of v.pods) f[p.node] += p.gpus;
            if (v.w.q === w.q) freedQ += v.gpus;
            if (quotaShort) { const Q = queues[w.q]; queues[w.q].used -= freedQ; const ok = quotaOk(w, gpus); Q.used += freedQ; if (!ok) continue; }
            const tryPl = plan(w, R.pods, f);
            if (tryPl) {
              for (const c of chosen) {
                if (c.w.spec.kind === 'training') stopJob(c.w, t, 'preempt');
                else { for (const p of c.pods) { release(p); p.since = t; if (c.w.spec.kind === 'batch') { const j = c.w.jobs.find(x => x.pod === p.id); if (j) j.left = j.dur; } } c.w.preempts++; ev(t, 'preempt', c.w.i, 'pod preempted by ' + w.spec.name); }
              }
              pl = plan(w, R.pods, nodes.map(n => n.free));
              break;
            }
            if (chosen.length > 60) break;
          }
          if (!pl) noVictims.add(w.i);
        }
        if (!pl) { reasons.set(R, quotaShort ? 'quota' : whyNot(w, R.pods, free)); blockedQ.add(w.q); continue; }
        R.pods.forEach((p, i) => place(p, pl[i], t));
      }
      // series and frame
      let alloc = 0, idleA = 0, fault = 0, freeH = 0;
      const own = new Int16Array(G), st = new Uint8Array(G);
      for (let g = 0; g < G; g++) {
        if (downUntil[g] > t) { fault++; own[g] = -2; st[g] = 3; if (owner[g] >= 0) { /* faulted GPU still held: counts as fault */ } continue; }
        const pid = owner[g];
        if (pid < 0) { freeH++; own[g] = -1; st[g] = 0; continue; }
        alloc++;
        const w = W[pods[pid].wl];
        own[g] = w.i;
        const idle = w.spec.kind === 'training' && (w.pods.some(id => pods[id].state === 'pending') || t < w.restartUntil);
        st[g] = idle ? 2 : 1;
        if (idle) idleA++;
      }
      let minNeed = Infinity;
      for (const R of pend) if (reasons.has(R)) minNeed = Math.min(minNeed, R.w.spec.gpusPerPod);
      let stranded = 0;
      if (isFinite(minNeed)) for (const n of nodes) if (n.free > 0 && n.free < minNeed) stranded += n.free;
      ser.alloc[k] = alloc; ser.idleAlloc[k] = idleA; ser.free[k] = freeH; ser.faulted[k] = fault; ser.stranded[k] = stranded;
      let pq = 0, pc = 0, pf = 0, ptp = 0, np = 0;
      for (const R of pend) {
        const r = reasons.get(R); if (!r) continue;
        const g = R.pods.length * R.w.spec.gpusPerPod; np += R.pods.length;
        if (r === 'quota') pq += g; else if (r === 'capacity') pc += g; else if (r === 'topology') ptp += g; else pf += g;
        R.w.waitS += STEP * R.pods.length; R.w.reasonS[r] = (R.w.reasonS[r] || 0) + STEP;
        R.w.reasonNow = r;
      }
      ser.pendQuota[k] = pq; ser.pendCapacity[k] = pc; ser.pendFragmentation[k] = pf; ser.pendTopology[k] = ptp; ser.pending[k] = np;
      ser.running[k] = pods.filter(p => p.state === 'running').length;
      for (const w of W) {
        const run = w.pods.some(id => pods[id].state === 'running'), pen = w.pods.some(id => pods[id].state === 'pending');
        wlState[w.i][k] = !isNaN(w.finished) && w.spec.kind === 'training' ? 3 : run && pen ? 4 : run ? 2 : pen ? 1 : 0;
        if (!pen) w.reasonNow = null;
      }
      frames.push({ own, st, reasons: W.map(w => w.reasonNow || null) });
    }

    // ----- summary -----
    const gpuH = v => v / 3600;
    let allocS = 0, healthyS = 0, idleS = 0, strandS = 0, faultS = 0;
    for (let k = 0; k < T; k++) { allocS += ser.alloc[k] * STEP; healthyS += (G - ser.faulted[k]) * STEP; idleS += ser.idleAlloc[k] * STEP; strandS += ser.stranded[k] * STEP; faultS += ser.faulted[k] * STEP; }
    const wsum = W.map(w => {
      const s = w.spec, jobs = w.jobs;
      const bw = jobs.filter(j => !isNaN(j.start)).map(j => j.start - j.t0);
      return { id: s.id, name: s.name, kind: s.kind, queue: queues[w.q] ? queues[w.q].name : '', team: queues[w.q] ? queues[w.q].team : '', prio: w.prio, gpus: s.pods * s.gpusPerPod,
        submitted: w.submitted, admitted: w.admitted, finished: w.finished, waitMin: s.kind === 'batch' ? (bw.length ? bw.reduce((a, b) => a + b, 0) / bw.length / 60 : NaN) : (isNaN(w.admitted) ? (isNaN(w.submitted) ? NaN : (T * STEP - w.submitted) / 60) : (w.admitted - w.submitted) / 60),
        admittedOk: !isNaN(w.admitted), preempts: w.preempts, restarts: w.restarts, faults: w.faults, progress: s.kind === 'training' ? w.progress / w.work : NaN,
        goodput: w.allocS ? w.goodS / w.allocS : NaN, idleGpuH: gpuH(w.idleS), lostGpuH: gpuH(w.lostGpuS), allocGpuH: gpuH(w.allocS),
        jobs: s.kind === 'batch' ? { submitted: jobs.length, done: jobs.filter(j => !isNaN(j.end)).length } : null, topReason: Object.entries(w.reasonS).sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || null };
    });
    const nodeFaults = nodes.map(n => ({ name: n.name, pool: spec.pools[n.pool].name, faults: n.faults })).filter(x => x.faults).sort((a, b) => b.faults - a.faults);
    const gpuF = []; for (let g = 0; g < G; g++) if (gpuFaults[g]) gpuF.push({ gpu: g, node: nodes[gpuNode[g]].name, index: g - nodes[gpuNode[g]].base, faults: gpuFaults[g] });
    gpuF.sort((a, b) => b.faults - a.faults);
    const summary = {
      gpus: G, hours: spec.horizonH, allocation: healthyS ? allocS / healthyS : 0, allocGpuH: gpuH(allocS), idleAllocGpuH: gpuH(idleS), strandedGpuH: gpuH(strandS), faultedGpuH: gpuH(faultS),
      freeGpuH: gpuH(healthyS - allocS), faults: gpuF.reduce((a, x) => a + x.faults, 0), preemptions: W.reduce((a, w) => a + w.preempts, 0), restarts: W.reduce((a, w) => a + w.restarts, 0),
      lostGpuH: W.reduce((a, w) => a + gpuH(w.lostGpuS), 0)
    };
    const tr = wsum.filter(w => w.kind === 'training');
    summary.trainingAdmitted = tr.filter(w => w.admittedOk).length; summary.trainingTotal = tr.length;
    summary.trainingWaitMin = tr.length ? tr.reduce((a, w) => a + (isNaN(w.waitMin) ? 0 : w.waitMin), 0) / tr.length : NaN;
    const bt = wsum.filter(w => w.kind === 'batch' && isFinite(w.waitMin));
    summary.batchWaitMin = bt.length ? bt.reduce((a, w) => a + w.waitMin, 0) / bt.length : NaN;
    const inf = W.filter(w => w.spec.kind === 'inference');
    let want = 0, got = 0;
    for (const w of inf) for (let k = 0; k < T; k++) { const s = wlState[w.i][k]; want++; if (s === 2) got++; }
    summary.inferenceFull = want ? got / want : NaN; // share of time every inference replica was running
    return {
      spec, step: STEP, T, G,
      nodes: nodes.map(n => ({ name: n.name, pool: n.pool, domain: n.domain, base: n.base, gpus: n.gpus, faults: n.faults })),
      domains: domains.map(d => ({ pool: d.pool, nodes: d.nodes })),
      workloads: wsum, wlState, frames, series: ser, events, nodeFaults, gpuFaults: gpuF, summary, REASON
    };
  }

  // Run the same cluster under several scheduler policies.
  const POLICY_VARIANTS = [
    { name: 'As configured', policy: {} },
    { name: 'Bin-pack', policy: { placement: 'binpack' } },
    { name: 'Spread', policy: { placement: 'spread' } },
    { name: 'No gang scheduling', policy: { gang: false } },
    { name: 'No preemption', policy: { preemption: false } },
    { name: 'No quota borrowing', policy: { borrowing: false } },
    { name: 'Strict FIFO queues', policy: { order: 'strict' } }
  ];
  function* comparePoliciesIter(spec, variants) {
    variants = variants || POLICY_VARIANTS;
    const rows = [];
    for (let i = 0; i < variants.length; i++) {
      yield { done: i, total: variants.length, text: variants[i].name };
      const r = simulateCluster(spec, { policy: variants[i].policy });
      rows.push({ name: variants[i].name, policy: Object.assign({}, normalize(spec).policy, variants[i].policy), summary: r.summary, workloads: r.workloads });
    }
    return rows;
  }
  const comparePolicies = (spec, v) => { const it = comparePoliciesIter(spec, v); let x; do x = it.next(); while (!x.done); return x.value; };

  // Builds a cluster spec from `kubectl get nodes,pods,clusterqueues,localqueues -o json` (a List).
  // Reads GPU capacity and product labels from nodes, GPU requests, owners, priority and queue from pods,
  // and nominal GPU quotas from Kueue ClusterQueues. Durations are not in the API, so training and batch
  // workloads get defaults to edit.
  function fromKube(json, opt) {
    opt = opt || {};
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    const items = doc.items || (Array.isArray(doc) ? doc : [doc]);
    const kind = k => items.filter(x => x && x.kind === k);
    const gpuOf = o => +(((o || {})['nvidia.com/gpu']) || ((o || {})['amd.com/gpu']) || 0);
    const label = (o, ks) => { const L = (o.metadata && o.metadata.labels) || {}; for (const k of ks) if (L[k]) return L[k]; return ''; };
    // node pools: group nodes by GPU product and pool label
    const poolMap = new Map();
    for (const n of kind('Node')) {
      const g = gpuOf(n.status && n.status.capacity);
      if (!g) continue;
      const product = label(n, ['nvidia.com/gpu.product', 'amd.com/gpu.product', 'node.kubernetes.io/instance-type']) || 'GPU';
      const poolName = label(n, ['cloud.google.com/gke-nodepool', 'eks.amazonaws.com/nodegroup', 'kubernetes.azure.com/agentpool', 'karpenter.sh/nodepool', 'node-pool', 'pool']) || product;
      const domain = label(n, ['topology.kubernetes.io/zone', 'network.topology/block', 'cloud.google.com/gce-topology-block']) || 'default';
      const key = poolName + '|' + product;
      if (!poolMap.has(key)) poolMap.set(key, { id: 'np' + poolMap.size, name: poolName, gpu: matchGpu(product), product, gpusPerNode: g, nodes: 0, domainsSeen: new Map(), nodeNames: [] });
      const P = poolMap.get(key);
      P.nodes++; P.gpusPerNode = Math.max(P.gpusPerNode, g); P.nodeNames.push(n.metadata.name);
      P.domainsSeen.set(domain, (P.domainsSeen.get(domain) || 0) + 1);
    }
    const pools = [...poolMap.values()].map(P => ({ id: P.id, name: P.name, gpu: P.gpu, gpusPerNode: P.gpusPerNode, nodes: P.nodes, domainNodes: Math.max(...P.domainsSeen.values()), site: opt.site || 'On-prem DC', product: P.product }));
    const nodePool = {}; for (const P of poolMap.values()) for (const nm of P.nodeNames) nodePool[nm] = P.id;
    // queues
    const queues = [];
    for (const cq of kind('ClusterQueue')) {
      let quota = 0;
      for (const rg of (cq.spec && cq.spec.resourceGroups) || []) for (const f of rg.flavors || []) for (const r of f.resources || []) if (/gpu/.test(r.name)) quota += +r.nominalQuota || 0;
      queues.push({ id: cq.metadata.name, name: cq.metadata.name, quota, priority: 0, team: (cq.metadata.labels && (cq.metadata.labels.team || cq.metadata.labels.owner)) || '' });
    }
    const lq = {}; for (const q of kind('LocalQueue')) lq[(q.metadata.namespace || '') + '/' + q.metadata.name] = q.spec && q.spec.clusterQueue;
    // workloads: group GPU pods by owner
    const wl = new Map();
    const prioOf = p => (p.spec && (p.spec.priority != null ? p.spec.priority : /high|critical|prod/i.test(p.spec.priorityClassName || '') ? 100 : /low|batch|preempt/i.test(p.spec.priorityClassName || '') ? -10 : 0));
    for (const p of kind('Pod')) {
      let g = 0;
      for (const c of (p.spec && p.spec.containers) || []) g += gpuOf((c.resources || {}).limits) || gpuOf((c.resources || {}).requests);
      if (!g) continue;
      const md = p.metadata || {}, L = md.labels || {}, ref = (md.ownerReferences || [])[0] || {};
      const jobName = L['jobset.sigs.k8s.io/jobset-name'] || L['training.kubeflow.org/job-name'] || L['batch.kubernetes.io/job-name'] || L['job-name'] || L['app.kubernetes.io/instance'] || L.app || (ref.name || md.name).replace(/-[a-z0-9]{8,10}(-[a-z0-9]{5})?$/, '');
      const key = (md.namespace || 'default') + '/' + jobName;
      const isTrain = !!(L['jobset.sigs.k8s.io/jobset-name'] || L['training.kubeflow.org/job-name'] || ref.kind === 'PyTorchJob' || ref.kind === 'JobSet' || /train|pretrain|finetune/i.test(jobName));
      const isInf = !isTrain && (ref.kind === 'ReplicaSet' || ref.kind === 'Deployment' || ref.kind === 'StatefulSet' || /serv|infer|vllm|triton/i.test(jobName));
      const q = L['kueue.x-k8s.io/queue-name'] ? (lq[(md.namespace || '') + '/' + L['kueue.x-k8s.io/queue-name']] || L['kueue.x-k8s.io/queue-name']) : '';
      if (!wl.has(key)) wl.set(key, { id: 'w' + wl.size, name: jobName, kind: isTrain ? 'training' : isInf ? 'inference' : 'batch', queue: q, gpusPerPod: g, pods: 0, priority: prioOf(p), pool: null, topology: isTrain ? 'domain' : 'any', durationH: isTrain ? 6 : 1, startH: 0, namespace: md.namespace || 'default', running: 0, pending: 0, created: md.creationTimestamp || '' });
      const W = wl.get(key);
      W.pods++; W.gpusPerPod = Math.max(W.gpusPerPod, g);
      if (p.status && p.status.phase === 'Running') W.running++; else if (p.status && p.status.phase === 'Pending') W.pending++;
      if (p.spec && p.spec.nodeName && nodePool[p.spec.nodeName] && !W.pool) W.poolSeen = nodePool[p.spec.nodeName];
    }
    const workloads = [...wl.values()].map(w => {
      const o = Object.assign({}, w);
      if (o.kind === 'batch') { o.ratePerH = Math.max(1, o.pods); o.pods = 1; }
      if (o.kind === 'inference') { o.minPods = Math.max(1, Math.round(o.pods / 2)); }
      delete o.poolSeen; return o;
    });
    if (!queues.length) {
      const total = pools.reduce((a, p) => a + p.nodes * p.gpusPerNode, 0);
      queues.push({ id: 'default', name: 'default', quota: total, priority: 0, team: '' });
    }
    const qset = new Set(queues.map(q => q.id));
    for (const w of workloads) if (!qset.has(w.queue)) w.queue = queues[0].id;
    const notes = [pools.length + ' GPU node pool' + (pools.length === 1 ? '' : 's') + ' (' + pools.reduce((a, p) => a + p.nodes, 0) + ' nodes, ' + pools.reduce((a, p) => a + p.nodes * p.gpusPerNode, 0) + ' GPUs)',
      workloads.length + ' GPU workloads from ' + workloads.reduce((a, w) => a + (w.kind === 'batch' ? w.ratePerH : w.pods), 0) + ' pods', queues.length + ' queue' + (queues.length === 1 ? '' : 's') + (kind('ClusterQueue').length ? ' from Kueue' : ' (none found; one queue holds everything)'),
      'Durations are not in the API: training jobs default to 6 h, batch jobs to 1 h. Edit them before trusting wait times.'];
    return { spec: { seed: 11, horizonH: 8, policy: Object.assign({}, POLICY_DEFAULTS), pools, queues, workloads }, notes };
  }
  function matchGpu(product) {
    const p = String(product).toUpperCase();
    for (const k of ['B200', 'H200', 'H100', 'MI300X', 'L40S', 'A100']) if (p.includes(k)) return k;
    return 'H100';
  }

  // A mixed cluster: on-prem H100s in two IB domains, a neocloud H200 pool, inference with a daily cycle,
  // a 256-GPU pre-training gang, fine-tunes, and a stream of one-GPU evaluation jobs.
  function sampleCluster() {
    return {
      seed: 11, horizonH: 8, policy: Object.assign({}, POLICY_DEFAULTS, { placement: 'spread' }),
      pools: [
        { id: 'h100', name: 'h100-onprem', gpu: 'H100', gpusPerNode: 8, nodes: 48, domainNodes: 24, site: 'On-prem DC', faultPerGpuDay: 0.03, repairH: 6 },
        { id: 'h200', name: 'h200-neocloud', gpu: 'H200', gpusPerNode: 8, nodes: 16, domainNodes: 16, site: 'Neocloud A', faultPerGpuDay: 0.01, repairH: 3 }
      ],
      queues: [
        { id: 'serving', name: 'serving', team: 'ML Platform', quota: 160, priority: 100 },
        { id: 'research', name: 'research', team: 'Foundation Models', quota: 288, priority: 10 },
        { id: 'eval', name: 'eval', team: 'Evaluation', quota: 64, priority: 0 }
      ],
      workloads: [
        { id: 'chat', name: 'chat-serving', kind: 'inference', queue: 'serving', gpusPerPod: 2, pods: 40, minPods: 16, peakH: 14, clockH: 9 },
        { id: 'agents', name: 'coding-agents-serving', kind: 'inference', queue: 'serving', gpusPerPod: 4, pods: 16, minPods: 8, peakH: 11, clockH: 9 },
        { id: 'pretrain', name: 'pretrain-70b', kind: 'training', queue: 'research', gpusPerPod: 8, pods: 20, topology: 'domain', startH: 0.5, durationH: 6, ckptMin: 45, restartMin: 12, pool: 'h100' },
        { id: 'ft1', name: 'finetune-coder', kind: 'training', queue: 'research', gpusPerPod: 8, pods: 4, topology: 'domain', startH: 1, durationH: 2, ckptMin: 20, restartMin: 5 },
        { id: 'ft2', name: 'finetune-safety', kind: 'training', queue: 'research', gpusPerPod: 8, pods: 2, topology: 'domain', startH: 2.5, durationH: 1.5, ckptMin: 20, restartMin: 5 },
        { id: 'evals', name: 'eval-jobs', kind: 'batch', queue: 'eval', gpusPerPod: 1, ratePerH: 40, durationH: 0.5 },
        { id: 'embed', name: 'embedding-backfill', kind: 'batch', queue: 'eval', gpusPerPod: 2, ratePerH: 6, durationH: 1.5, priority: -10 }
      ]
    };
  }

  const api = { STEP, POLICY_DEFAULTS, POLICY_VARIANTS, REASON, simulateCluster, comparePoliciesIter, comparePolicies, fromKube, sampleCluster, normalizeCluster: normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetCluster = api;
})(typeof window !== 'undefined' ? window : this);
