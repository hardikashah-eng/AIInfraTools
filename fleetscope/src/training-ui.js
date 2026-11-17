/* FleetScope Training view: one job seen four ways (GPUs, phases, scheduling, full). Browser only. */
(function () {
  'use strict';
  const T = window.FleetTraining, C = window.FleetCluster, E = window.FleetEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fInt = v => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
  const fPct = v => (isFinite(v) ? Math.round(v * 100) + '%' : '–');
  const fS = v => (!isFinite(v) ? '–' : v >= 3600 ? (v / 3600).toFixed(1) + ' h' : v >= 90 ? (v / 60).toFixed(0) + ' min' : v >= 10 ? v.toFixed(0) + ' s' : v.toFixed(1) + ' s');
  const fH = v => (!isFinite(v) ? '–' : v >= 10 ? fInt(v) : v.toFixed(1));
  const hm = s => { const m = Math.floor(s / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const TS = { spec: T.normalizeTraining({}), run: null, t: 0, playing: false, speed: 60, baseline: null, sub: 'full', useCluster: true, sched: null, faultLog: null };
  let col = {};
  function readColors() {
    const st = getComputedStyle(document.documentElement), g = v => st.getPropertyValue(v).trim();
    col = { compute: g('--onprem'), straggler: g('--c-queue'), data: g('--warn'), sync: g('--n-link'), optimizer: g('--n-route'), checkpoint: g('--train'), restart: g('--crit'), lost: '#b8467a', queue: g('--muted'), faulted: g('--crit'), done: g('--line'), ink: g('--ink'), muted: g('--muted'), line: g('--line'), panel: g('--panel'), crit: g('--crit') };
  }
  const STATE = ['compute', 'straggler', 'data', 'sync', 'optimizer', 'checkpoint', 'restart', 'faulted', 'queue', 'done'];
  const STATE_LABEL = { compute: 'computing', straggler: 'waiting on slow GPUs', data: 'waiting on data', sync: 'gradient sync', optimizer: 'optimizer', checkpoint: 'checkpointing', restart: 'restarting (idle)', faulted: 'faulted', queue: 'queued', done: 'finished / not running', lost: 'work redone after faults' };

  const root = $('#trainingApp');
  root.innerHTML = `
  <header class="toolbar">
    <div class="tb"><span class="tname" id="tName"></span>
      <label class="btnlike" title="GPU fault log: CSV (time,node,gpu,xid), JSON lines, or syslog lines with NVRM Xid">Import fault log<input type="file" id="tFile" accept=".csv,.json,.jsonl,.log,.txt" hidden></label></div>
    <div class="tb"><button type="button" id="tPlay" class="play">&#9654; Play</button>
      <select id="tSpeed" aria-label="Playback speed"><option value="10">10×</option><option value="60" selected>60×</option><option value="300">300×</option><option value="1200">1200×</option></select>
      <span class="clock" id="tClock">0:00 / 12:00</span></div>
    <div class="tb"><button type="button" id="tPin">Pin as baseline</button><button type="button" id="tClear" hidden>Clear baseline</button></div>
    <div class="status" id="tStatus"></div>
  </header>
  <aside class="palette cfg" id="tCfg"></aside>
  <section class="center">
    <nav class="lensbar"><div class="ltabs" role="tablist" id="tSubs"></div><div class="linfo" id="tSubHint"></div></nav>
    <div class="chead" id="tHead"></div>
    <div class="kpis" id="tKpis"></div>
    <div id="tBody"></div>
    <div class="timeline"><canvas id="tTime" aria-label="Job timeline; click to jump"></canvas><input type="range" id="tScrub" min="0" max="43200" step="1" value="0" aria-label="Playhead"></div>
  </section>
  <aside class="details" id="tSide" aria-live="polite"></aside>`;

  const SUBS = [
    { id: 'full', label: 'Full view', hint: 'Everything at once, with the one bottleneck that matters most' },
    { id: 'gpu', label: 'GPUs', hint: 'Every GPU: what it is doing, which ones are slow, which ones fault' },
    { id: 'phase', label: 'Phases', hint: 'Every step split into data, compute, sync and optimizer; checkpoints and restarts between' },
    { id: 'sched', label: 'Scheduling', hint: 'Constraints, admission, and what the cluster scheduler did to this job' }
  ];
  function renderSubs() {
    $('#tSubs').innerHTML = SUBS.map(x => '<button type="button" role="tab" data-sub="' + x.id + '" aria-selected="' + (TS.sub === x.id) + '">' + x.label + '</button>').join('');
    $('#tSubHint').textContent = SUBS.find(x => x.id === TS.sub).hint;
  }
  $('#tSubs').addEventListener('click', e => { const b = e.target.closest('[data-sub]'); if (b) { TS.sub = b.dataset.sub; renderSubs(); renderBody(); } });

  // ---------- config ----------
  const num = (path, v, lo, hi, st) => '<input type="number" data-path="' + path + '" value="' + v + '" min="' + lo + '" max="' + hi + '" step="' + st + '">';
  const row = (label, path, v, lo, hi, st, hint) => '<label class="frow"' + (hint ? ' title="' + esc(hint) + '"' : '') + '><span>' + label + '</span>' + num(path, v, lo, hi, st) + '</label>';
  const chk = (label, path, v, hint) => '<label class="chk"' + (hint ? ' title="' + esc(hint) + '"' : '') + '><input type="checkbox" data-path="' + path + '"' + (v ? ' checked' : '') + '> ' + label + '</label>';
  function renderCfg() {
    const s = TS.spec;
    const sel = (path, v, opts) => '<select data-path="' + path + '">' + opts.map(([k, l]) => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
    let h = (TS.faultLog ? '<div class="note">Fault log: ' + TS.faultLog.events.length + ' faults on ' + TS.faultLog.byNode.length + ' nodes' + (Object.keys(TS.faultLog.xids).length ? ' (Xid ' + Object.entries(TS.faultLog.xids).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => k + '×' + n).join(', ') + ')' : '') + '. Faults are weighted toward the GPUs that fail most in it.</div>' : '');
    h += '<h3>Job</h3><label class="frow"><span>Model</span>' + sel('model', s.model, Object.keys(E.MODELS).map(k => [k, E.MODELS[k].label])) + '</label>' +
      '<label class="frow"><span>GPU</span>' + sel('gpu', s.gpu, Object.keys(E.GPUS).map(k => [k, E.GPUS[k].label])) + '</label>' +
      row('GPUs', 'gpus', s.gpus, 8, 16384, 8) + row('Tensor parallel', 'tp', s.tp, 1, 8, 1) + row('Pipeline stages', 'pp', s.pp, 1, 64, 1) + row('Batch (M tokens/step)', 'batchMTokens', s.batchMTokens, 0.25, 64, 0.25) +
      row('Kernel efficiency', 'kernelEff', s.kernelEff, 0.1, 0.9, 0.05, 'Fraction of peak BF16 throughput the matmuls reach') + row('Comm overlapped', 'overlap', s.overlap, 0, 1, 0.05, 'Share of gradient sync hidden behind compute') +
      row('IB Gb/s per GPU', 'ibGbpsPerGpu', s.ibGbpsPerGpu, 25, 3200, 25) + row('Simulated hours', 'horizonH', s.horizonH, 1, 168, 1);
    h += '<h3>Data</h3>' + row('Parallel FS GB/s', 'storageGBs', s.storageGBs, 0.1, 2000, 0.1) + row('Cloud bucket GB/s', 'remoteGBs', s.remoteGBs, 0.05, 500, 0.05) + row('Cache hit', 'cacheHit', s.cacheHit, 0, 1, 0.05) +
      row('Loader workers / GPU', 'workersPerGpu', s.workersPerGpu, 1, 64, 1) + chk('Prefetch (overlap loading with compute)', 'prefetch', s.prefetch) +
      s.mixes.map((m, i) => '<details class="card"' + (i ? ' open' : '') + '><summary><b>' + (i ? 'Then: ' : 'Mix: ') + esc(m.name) + '</b></summary>' +
        row('Tokens per sample', 'mixes.' + i + '.tokensPerSample', m.tokensPerSample, 1, 1e6, 1) + row('Bytes per token', 'mixes.' + i + '.bytesPerToken', m.bytesPerToken, 0.5, 100000, 0.5, 'Pre-tokenized text is 2-4; images and video far more') +
        row('Share from cloud bucket', 'mixes.' + i + '.remoteShare', m.remoteShare, 0, 1, 0.05) + row('Samples/s per worker', 'mixes.' + i + '.samplesPerWorkerS', m.samplesPerWorkerS, 0.001, 100000, 0.01, 'Decode + tokenize + augment rate of one dataloader worker') + '</details>').join('') +
      (s.mixes.length > 1 ? row('Switch mix at hour', 'switchMixAtH', s.switchMixAtH, 0, 168, 0.5) : '');
    h += '<h3>Checkpoints and faults</h3>' + row('Checkpoint every (min)', 'ckptMin', s.ckptMin, 0, 600, 1) + row('Checkpoint write GB/s', 'ckptGBs', s.ckptGBs, 0.5, 1000, 0.5) + chk('Asynchronous checkpoints', 'asyncCkpt', s.asyncCkpt) +
      row('Faults per GPU-day', 'faultPerGpuDay', s.faultPerGpuDay, 0, 2, 0.005) + row('Restart + reload (min)', 'restartMin', s.restartMin, 0, 240, 1) + row('Node repair (h)', 'repairH', s.repairH, 0, 72, 0.5) + row('Hot spare nodes', 'spares', s.spares, 0, 64, 1) +
      row('Slow-GPU share', 'stragglerShare', s.stragglerShare, 0, 0.5, 0.005, 'Share of GPUs running slow (thermal throttling, ECC retries, a weak link)') + row('Slowdown of slow GPUs', 'stragglerSlow', s.stragglerSlow, 0, 1, 0.01) + row('Seed', 'seed', s.seed, 1, 9999, 1);
    h += '<h3>Scheduling</h3>' + '<label class="chk"><input type="checkbox" id="tUseCluster"' + (TS.useCluster ? ' checked' : '') + '> Start when the Cluster view’s scheduler admits it</label><div class="note">Runs this job through the cluster from the Cluster tab, as its pre-training workload, to get the admission wait.</div>';
    $('#tCfg').innerHTML = h;
  }
  function setPath(path, v) { const ks = path.split('.'); let o = TS.spec; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; }
  $('#tCfg').addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'tUseCluster') { TS.useCluster = t.checked; schedule(); return; }
    if (!t.dataset.path) return;
    setPath(t.dataset.path, t.type === 'checkbox' ? t.checked : t.tagName === 'SELECT' ? t.value : +t.value);
    schedule();
  });
  let timer = 0;
  function schedule() { clearTimeout(timer); $('#tStatus').textContent = 'Re-simulating…'; timer = setTimeout(run, 250); }

  // ---------- scheduling: run the job through the cluster model ----------
  function clusterSpec() {
    // The Cluster tab's cluster once it has been opened; before that, the sample cluster with bin-pack placement.
    const cv = window.FleetClusterView && window.FleetClusterView.state;
    if (cv && cv.run) return JSON.parse(JSON.stringify(cv.spec));
    const sc = C.sampleCluster(); sc.policy.placement = 'binpack'; return sc;
  }
  function schedRun() {
    const s = TS.spec, cs = clusterSpec(), gpn = 8;
    let w = cs.workloads.find(x => x.kind === 'training' && x.pods * x.gpusPerPod >= 64) || cs.workloads.find(x => x.kind === 'training');
    if (!w) { w = { id: 'job', kind: 'training', queue: (cs.queues[0] || {}).id, topology: 'domain', startH: 0.5 }; cs.workloads.push(w); }
    Object.assign(w, { name: 'this job', pods: Math.ceil(s.gpus / gpn), gpusPerPod: gpn, durationH: Math.max(1, s.horizonH), ckptMin: s.ckptMin, restartMin: s.restartMin });
    cs.horizonH = Math.max(cs.horizonH || 8, s.horizonH);
    const r = C.simulateCluster(cs), wi = cs.workloads.indexOf(w), ws = r.workloads[wi];
    const q = cs.queues.find(x => x.id === w.queue) || {};
    const fitPools = cs.pools.filter(p => !w.pool || p.id === w.pool);
    const maxDomain = Math.max(0, ...fitPools.map(p => Math.min(p.nodes, p.domainNodes) * p.gpusPerNode));
    return { r, wi, w, ws, cs, queue: q, maxDomain, totalGpus: fitPools.reduce((a, p) => a + p.nodes * p.gpusPerNode, 0), startS: (w.startH || 0) * 3600 };
  }

  // ---------- run ----------
  function run() {
    const t0 = performance.now();
    TS.sched = null;
    const spec = Object.assign({}, TS.spec, { faultLog: TS.faultLog });
    if (TS.useCluster) {
      try { TS.sched = schedRun(); } catch (err) { TS.sched = { error: err.message }; }
      if (TS.sched && TS.sched.ws) spec.queueWaitS = TS.sched.ws.admittedOk ? (TS.sched.ws.admitted - TS.sched.ws.submitted) : spec.horizonH * 3600;
    }
    TS.run = T.simulateTraining(spec);
    const R = TS.run;
    TS.t = clamp(TS.t, 0, R.spec.horizonH * 3600);
    $('#tScrub').max = R.spec.horizonH * 3600;
    $('#tName').innerHTML = '<b>' + esc((E.MODELS[R.spec.model] || {}).label || R.spec.model) + '</b> on ' + fInt(R.N) + ' ' + esc(R.spec.gpu) + ' (' + R.nodes + ' nodes, TP ' + R.spec.tp + (R.spec.pp > 1 ? ' · PP ' + R.spec.pp : '') + ' · DP ' + R.summary.dp + ')';
    $('#tStatus').innerHTML = '<b>' + fInt(R.summary.steps) + '</b> steps · ' + R.spec.horizonH + ' h simulated in ' + Math.round(performance.now() - t0) + ' ms';
    renderKpis(); renderHead(); renderBody(); drawTime(); renderSide(); draw();
  }

  // ---------- KPIs and headline ----------
  function renderKpis() {
    const s = TS.run.summary, b = TS.baseline ? TS.baseline.summary : null, mx = TS.run.byMix;
    const tile = (k, v, cls, cur, base, lower, fmt) => {
      let d = '', dc = '';
      if (b && isFinite(cur) && isFinite(base) && Math.abs(cur - base) > 1e-9) { d = (cur > base ? '▲ ' : '▼ ') + fmt(Math.abs(cur - base)); dc = (lower ? cur < base : cur > base) ? 'better' : 'worse'; } else if (b) d = '= baseline';
      return '<div class="kpi ' + (cls || '') + '"><div class="k" title="' + k + '">' + k + '</div><div class="v">' + v + '</div><div class="d ' + dc + '">' + d + '</div></div>';
    };
    const bb = b || {};
    const last = mx[mx.length - 1];
    $('#tKpis').innerHTML = [
      tile('Goodput (time computing)', fPct(s.goodput), s.goodput >= 0.85 ? 'good' : s.goodput >= 0.65 ? 'warn' : 'crit', s.goodput, bb.goodput, false, v => Math.round(v * 100) + ' pt'),
      tile('Effective MFU', fPct(s.mfu), '', s.mfu, bb.mfu, false, v => Math.round(v * 100) + ' pt'),
      tile('Tokens / s (kept)', fInt(s.tokensPerS / 1000) + 'k', '', s.tokensPerS, bb.tokensPerS, false, v => fInt(v / 1000) + 'k'),
      tile('Tokens trained', s.tokensB.toFixed(1) + ' B', '', s.tokensB, bb.tokensB, false, v => v.toFixed(1) + ' B'),
      tile('Step time' + (mx.length > 1 ? ' (' + mx.map((m, i) => i ? 'after' : 'before').join(' / ') + ' switch)' : ''), mx.map(m => fS(m.stepS)).join(' / '), '', last.stepS, b && TS.baseline.byMix ? TS.baseline.byMix[TS.baseline.byMix.length - 1].stepS : NaN, true, fS),
      tile('Data load / step (exposed)', mx.map(m => fS(m.dataS)).join(' / '), last.dataS > 0.05 * last.stepS ? 'warn' : '', last.dataS, b && TS.baseline.byMix ? TS.baseline.byMix[TS.baseline.byMix.length - 1].dataS : NaN, true, fS),
      tile('Data throughput', s.dataGBs.toFixed(2) + ' GB/s', '', s.dataGBs, bb.dataGBs, false, v => v.toFixed(2) + ' GB/s'),
      tile('GPU faults (restarts)', fInt(s.faults), s.faults ? 'warn' : '', s.faults, bb.faults, true, fInt),
      tile('Work lost + restart', fS((s.lostH + s.restartH) * 3600), s.lostH + s.restartH > 0.5 ? 'crit' : '', s.lostH + s.restartH, b ? bb.lostH + bb.restartH : NaN, true, v => fS(v * 3600)),
      tile('Waited to start', fS(TS.run.spec.queueWaitS), TS.run.spec.queueWaitS > 1800 ? 'crit' : '', TS.run.spec.queueWaitS, b ? TS.baseline.queueWaitS : NaN, true, fS)
    ].join('');
  }
  function bottleneckText() {
    const R = TS.run, s = R.summary, L = s.losses.filter(x => x[1] > 0.01), mx = R.byMix, m1 = mx[mx.length - 1];
    if (!L.length) return 'No bottleneck: the job spends ' + fPct(s.goodput) + ' of its time computing.';
    const [p, v] = L[0];
    const why = {
      queue: () => 'the job waits ' + fS(R.spec.queueWaitS) + ' to be scheduled' + (TS.sched && TS.sched.ws && TS.sched.ws.topReason ? ', because ' + (C.REASON[TS.sched.ws.topReason] || TS.sched.ws.topReason) : ''),
      data: () => 'data loading is not keeping up' + (mx.length > 1 && m1.dataS > mx[0].dataS ? ' after the switch to "' + m1.name + '": step time goes from ' + fS(mx[0].stepS) + ' to ' + fS(m1.stepS) : '') + ' (' + (m1.model.dataBound === 'cpu' ? 'decode and tokenize on the dataloader workers' : 'storage reads') + ' take ' + fS(m1.model.dataRaw) + ' per step against ' + fS(m1.model.busy) + ' of compute)',
      straggler: () => s.stragglers + ' slow GPU' + (s.stragglers === 1 ? '' : 's') + ' (up to ' + Math.round((s.maxSlow - 1) * 100) + '% slower) hold' + (s.stragglers === 1 ? 's' : '') + ' every step: all ' + fInt(R.N) + ' GPUs wait for ' + (s.stragglers === 1 ? 'it' : 'them'),
      sync: () => 'gradient sync is exposed for ' + fS(mx[0].syncS) + ' per step (DP ' + s.dp + ' over ' + R.spec.ibGbpsPerGpu + ' Gb/s per GPU)',
      checkpoint: () => 'blocking checkpoints of ' + fInt(mx[0].model.ckptBytes / 1e9) + ' GB take ' + fS(mx[0].model.ckptWrite) + ' each at ' + R.spec.ckptGBs + ' GB/s',
      restart: () => s.faults + ' GPU fault' + (s.faults === 1 ? '' : 's') + ' stopped the job for ' + fS(s.restartH * 3600) + (R.segs.some(x => x.waitedRepair) ? ', mostly waiting for node repair with no hot spare left' : ' of restarts'),
      lost: () => 'faults threw away ' + fS(s.lostH * 3600) + ' of training since the last checkpoint'
    };
    return 'Bottleneck: <b>' + T.PHASE_LABEL[p] + '</b>, ' + fPct(v) + ' of wall time: ' + why[p]() + '.' + (L[1] ? ' Next: ' + T.PHASE_LABEL[L[1][0]] + ' (' + fPct(L[1][1]) + ').' : '');
  }
  function renderHead() { $('#tHead').innerHTML = bottleneckText() + (TS.baseline ? ' <span class="sub">Compared with <b>' + esc(TS.baseline.label) + '</b>.</span>' : ''); }

  // ---------- body per sub-view ----------
  function breakdownBar() {
    const R = TS.run, sh = R.summary.shares, order = ['compute', 'optimizer', 'straggler', 'data', 'sync', 'checkpoint', 'restart', 'lost', 'queue'];
    return '<div class="wbar">' + order.filter(p => sh[p] > 0.002).map(p => '<i style="width:' + (100 * sh[p]).toFixed(2) + '%;background:' + col[p] + '" title="' + esc(STATE_LABEL[p] || p) + ': ' + fPct(sh[p]) + '"></i>').join('') + '</div>' +
      '<div class="glegend">' + order.filter(p => sh[p] > 0.002).map(p => '<span><i style="background:' + col[p] + '"></i>' + esc(STATE_LABEL[p] || p) + ' ' + fPct(sh[p]) + '</span>').join('') + '</div>';
  }
  function renderBody() {
    const R = TS.run; if (!R) return;
    const sub = TS.sub, box = $('#tBody');
    const gpuBlock = small => '<div class="gridWrap"><div class="sec2">GPUs at the playhead' + (small ? '' : ' <span class="sub">one square per GPU, 8 per node</span>') + '</div><canvas id="tGrid"></canvas><div class="gtip" id="tTip" hidden></div><div class="glegend">' + ['compute', 'straggler', 'data', 'sync', 'checkpoint', 'restart', 'faulted', 'queue'].map(k => '<span><i style="background:' + col[k] + '"></i>' + STATE_LABEL[k] + '</span>').join('') + '</div></div>';
    const phaseBlock = () => '<div class="gridWrap"><div class="sec2">Step time by phase <span class="sub">each column is a step; height is its duration; gaps are checkpoints, restarts and queueing</span></div><canvas id="tPhase"></canvas><div class="glegend">' + ['data', 'compute', 'straggler', 'sync', 'optimizer', 'checkpoint', 'restart', 'queue'].map(k => '<span><i style="background:' + col[k] + '"></i>' + STATE_LABEL[k] + '</span>').join('') + '<span><i class="hatch"></i>steps later lost to a fault</span></div></div>';
    const idleBlock = () => {
      const I = R.idleGpuH, keys = Object.keys(I).filter(k => I[k] > 0.05 && k !== 'optimizer').sort((a, b) => I[b] - I[a]), mx = Math.max(1e-9, ...keys.map(k => I[k]));
      return '<div class="gridWrap"><div class="sec2">Idle GPU-hours by cause</div>' + (keys.length ? keys.map(k => '<div class="hbar"><span>' + esc(STATE_LABEL[k] || k) + '</span><i style="width:' + (100 * I[k] / mx).toFixed(1) + '%;background:' + col[k] + '"></i><b>' + fH(I[k]) + '</b></div>').join('') : '<div class="sub">None.</div>') + '</div>';
    };
    const schedBlock = () => {
      const S = TS.sched, s = TS.run.spec, mg = R.summary.minGpus;
      let h = '<div class="gridWrap"><div class="sec2">Constraints</div><div class="cgrid">';
      const card = (ok, title, txt) => '<div class="ccard ' + (ok ? 'ok' : 'bad') + '"><b>' + (ok ? '✓ ' : '✗ ') + title + '</b><span>' + txt + '</span></div>';
      h += card(R.N >= mg, 'Memory: at least ' + fInt(mg) + ' GPUs', 'Weights, gradients and Adam states (~16 bytes per parameter) need ' + fInt(mg) + ' × ' + (E.GPUS[s.gpu] || {}).hbm + ' GB at 75% use; the job has ' + fInt(R.N) + '.');
      h += card(s.tp <= s.gpusPerNode, 'Tensor parallel inside a node', 'TP ' + s.tp + ' fits on ' + s.gpusPerNode + '-GPU nodes over NVLink.');
      h += card(R.N % (s.tp * s.pp) === 0, 'GPUs divide into TP × PP × DP', fInt(R.N) + ' = ' + s.tp + ' × ' + s.pp + ' × ' + R.summary.dp + (R.N % (s.tp * s.pp) ? ' (remainder unused)' : '') + '.');
      if (S && S.ws) {
        h += card(R.N <= S.maxDomain, 'Gang fits one IB domain', 'Needs ' + R.nodes + ' whole nodes; the largest domain has ' + fInt(S.maxDomain / 8) + ' nodes (' + fInt(S.maxDomain) + ' GPUs).');
        h += card(R.N <= (S.queue.quota || 0) || (S.cs.policy || {}).borrowing !== false, 'Queue quota', 'Queue "' + esc(S.queue.name || S.w.queue) + '" has ' + fInt(S.queue.quota) + ' GPUs' + (R.N > S.queue.quota ? '; the job needs to borrow ' + fInt(R.N - S.queue.quota) : '') + '.');
        h += card(R.N <= S.totalGpus, 'Cluster capacity', fInt(S.totalGpus) + ' GPUs in the allowed pools.');
      }
      h += '</div></div>';
      if (S && S.error) h += '<div class="gridWrap"><div class="sub">Cluster run failed: ' + esc(S.error) + '</div></div>';
      else if (S && S.ws) {
        const ws = S.ws, rs = S.r.spec.policy;
        h += '<div class="gridWrap"><div class="sec2">Admission on the cluster <span class="sub">' + esc(rs.placement) + ' placement' + (rs.gang ? ', gang' : '') + (rs.topology ? ', topology-aware' : '') + (rs.preemption ? ', preemption' : '') + ' · change it in the Cluster tab</span></div>' +
          '<p class="lead">' + (ws.admittedOk ? 'Submitted at ' + hm(ws.submitted) + ', all ' + R.nodes + ' nodes running at ' + hm(ws.admitted) + ': waited <b>' + fS(ws.admitted - ws.submitted) + '</b>' + (ws.topReason ? ', mostly because ' + esc(C.REASON[ws.topReason] || ws.topReason) : '') + '.' : '<b>Never admitted</b> in ' + S.r.spec.horizonH + ' h: ' + esc(C.REASON[ws.topReason] || 'it waited') + '.') +
          (ws.preempts ? ' Preempted ' + ws.preempts + ' time' + (ws.preempts > 1 ? 's' : '') + '.' : '') + '</p><canvas id="tSched"></canvas></div>';
      } else h += '<div class="gridWrap"><div class="sub">Turn on "Start when the Cluster view’s scheduler admits it" to run this job through the cluster.</div></div>';
      const fs = R.faults;
      h += '<div class="gridWrap"><div class="sec2">Faults and rescheduling</div>' + (fs.length ? fs.map(f => '<div class="row"><span>' + hm(f.t) + ' node ' + f.node + ' GPU ' + (f.gpu % s.gpusPerNode) + '</span><span>' + (f.down > s.restartMin * 60 + 1 ? 'no spare: waited ' + fS(f.down) + ' for repair' : 'moved to a spare node, ' + fS(f.down) + ' restart') + ' · lost ' + fS(f.lostS) + '</span></div>').join('') : '<div class="sub">No faults in this run.</div>') + '</div>';
      return h;
    };
    let h = '';
    if (sub === 'full') h = '<div class="gridWrap"><div class="sec2">Where the wall time went</div>' + breakdownBar() + '</div><div class="two">' + gpuBlock(true) + idleBlock() + '</div>' + phaseBlock();
    else if (sub === 'gpu') h = gpuBlock(false) + '<div class="two">' + idleBlock() + rankBlock() + '</div>';
    else if (sub === 'phase') h = phaseBlock() + '<div class="gridWrap"><div class="sec2">Where the wall time went</div>' + breakdownBar() + '</div>' + mixBlock();
    else h = schedBlock();
    box.innerHTML = h;
    if ($('#tGrid')) layoutGrid();
    if ($('#tPhase')) drawPhase();
    if ($('#tSched')) drawSched();
    draw();
  }
  function rankBlock() {
    const R = TS.run, s = R.spec, top = R.slowRank.slice(0, 6), nf = Object.entries(R.nodeFaults).sort((a, b) => b[1] - a[1]).slice(0, 5);
    let h = '<div class="gridWrap"><div class="sec2">Slowest GPUs</div>' + top.map(x => '<div class="row"><span>node ' + x.node + ' GPU ' + (x.gpu % s.gpusPerNode) + '</span><span>' + (x.slow > 1.03 ? '<b style="color:var(--crit)">' : '') + '+' + ((x.slow - 1) * 100).toFixed(1) + '%' + (x.slow > 1.03 ? '</b>' : '') + '</span></div>').join('') +
      '<div class="sub">Every step waits for the slowest GPU. Draining node ' + top[0].node + ' would save ' + fS(R.byMix[0].stragglerS) + ' per step.</div>';
    h += '<div class="sec2" style="margin-top:8px">Most-faulting nodes this run</div>' + (nf.length ? nf.map(([n, c]) => '<div class="row"><span>node ' + n + '</span><span>' + c + '</span></div>').join('') : '<div class="sub">None.</div>');
    if (TS.faultLog) h += '<div class="sec2" style="margin-top:8px">From the imported log</div>' + TS.faultLog.byGpu.slice(0, 5).map(x => '<div class="row"><span>' + esc(x.key) + '</span><span>' + x.n + '</span></div>').join('');
    return h + '</div>';
  }
  function mixBlock() {
    const R = TS.run;
    return '<div class="gridWrap"><div class="sec2">Per data mix</div><table class="atable"><thead><tr><th>Mix</th><th>Steps</th><th>Step</th><th>Data (exposed)</th><th>Data raw</th><th>Limited by</th><th>Compute</th><th>Slow GPUs</th><th>Sync</th></tr></thead><tbody>' +
      R.byMix.map(m => '<tr><td>' + esc(m.name) + '</td><td class="num">' + fInt(m.steps) + '</td><td class="num">' + fS(m.stepS) + '</td><td class="num">' + fS(m.dataS) + '</td><td class="num">' + fS(m.model.dataRaw) + '</td><td>' + (m.model.dataBound === 'cpu' ? 'decode / tokenize' : 'storage') + '</td><td class="num">' + fS(m.computeS) + '</td><td class="num">' + fS(m.stragglerS) + '</td><td class="num">' + fS(m.syncS) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  // ---------- canvases ----------
  function sizeCanvas(cv, h) { const W = cv.parentNode.clientWidth - 18, dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = h * dpr; cv.style.width = W + 'px'; cv.style.height = h + 'px'; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, W }; }
  const GR = { tile: 9, gap: 1, pos: null, h: 0 };
  function layoutGrid() {
    const R = TS.run, cv = $('#tGrid'), W = cv.parentNode.clientWidth - 18, gpn = R.spec.gpusPerNode, cols = Math.ceil(gpn / 2);
    const tile = R.N > 1024 ? 5 : R.N > 384 ? 7 : 9;
    const nw = cols * (tile + 1) + 5, nh = 2 * (tile + 1) + 5, per = Math.max(4, Math.floor(W / nw));
    GR.pos = []; GR.tile = tile;
    for (let g = 0; g < R.N; g++) { const n = Math.floor(g / gpn), j = g % gpn; GR.pos.push({ x: (n % per) * nw + (j % cols) * (tile + 1), y: Math.floor(n / per) * nh + Math.floor(j / cols) * (tile + 1) }); }
    GR.h = Math.ceil(R.nodes / per) * nh;
    const { ctx } = sizeCanvas(cv, GR.h); void ctx;
    cv.onmousemove = e => {
      const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, tip = $('#tTip');
      const g = GR.pos.findIndex(p => x >= p.x && x < p.x + GR.tile + 1 && y >= p.y && y < p.y + GR.tile + 1);
      if (g < 0) { tip.hidden = true; return; }
      const st = T.stateAt(R, TS.t).st[g];
      tip.innerHTML = '<b>node ' + Math.floor(g / gpn) + ' GPU ' + (g % gpn) + '</b><br>' + STATE_LABEL[STATE[st]] + '<br>speed ' + (R.slow[g] > 1 ? '−' : '+') + Math.abs((R.slow[g] - 1) * 100).toFixed(1) + '%' + (R.gpuFaultN[g] ? '<br>' + R.gpuFaultN[g] + ' fault(s) this run' : '');
      tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 26) + 'px'; tip.hidden = false;
    };
    cv.onmouseleave = () => { $('#tTip').hidden = true; };
  }
  let stBuf = null;
  function draw() {
    const R = TS.run; if (!R) return;
    $('#tClock').textContent = hm(TS.t) + ' / ' + hm(R.spec.horizonH * 3600);
    const sc = $('#tScrub'); if (document.activeElement !== sc) sc.value = TS.t;
    const cv = $('#tGrid');
    if (cv && GR.pos) {
      stBuf = T.stateAt(R, TS.t, stBuf && stBuf.length === R.N ? stBuf : new Uint8Array(R.N)).st;
      const ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
      for (let g = 0; g < R.N; g++) { const p = GR.pos[g]; ctx.fillStyle = col[STATE[stBuf[g]]]; ctx.fillRect(p.x, p.y, GR.tile, GR.tile); }
    }
    drawPlayheads();
    renderSideLive();
  }
  let phImg = null, tlImg = null, scImg = null;
  function drawPhase() {
    const R = TS.run, cv = $('#tPhase'), H = 170, { ctx, W } = sizeCanvas(cv, H), span = R.spec.horizonH * 3600, L = 34;
    const X = t => L + (W - L - 6) * t / span;
    const maxStep = Math.max(1, ...R.steps.map(s => s.total)) * 1.08, Y = v => (H - 14) * (1 - v / maxStep);
    ctx.clearRect(0, 0, W, H);
    for (const sg of R.segs) { ctx.fillStyle = col[sg.kind] || col.restart; ctx.globalAlpha = 0.25; ctx.fillRect(X(sg.t0), 0, Math.max(1, X(sg.t1) - X(sg.t0)), H - 14); ctx.globalAlpha = 1; }
    for (const st of R.steps) {
      const x = X(st.t), w = Math.max(0.6, X(st.t + st.total) - x);
      let y0 = 0;
      for (const p of ['compute', 'straggler', 'data', 'sync', 'optimizer']) { const v = st[p]; if (v <= 0) continue; ctx.fillStyle = col[p]; ctx.fillRect(x, Y(y0 + v), w, Y(y0) - Y(y0 + v)); y0 += v; }
      if (st.lost) { ctx.fillStyle = col.panel; ctx.globalAlpha = 0.55; ctx.fillRect(x, Y(y0), w, Y(0) - Y(y0)); ctx.globalAlpha = 1; }
    }
    ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText(fS(maxStep), 0, 10); ctx.fillText('0', 0, H - 14);
    for (let h = 0; h <= R.spec.horizonH; h += Math.max(1, Math.round(R.spec.horizonH / 12))) ctx.fillText(h + 'h', X(h * 3600) - 6, H - 2);
    if (R.byMix.length > 1) { const xs = X(R.spec.switchMixAtH * 3600); ctx.strokeStyle = col.ink; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xs, 0); ctx.lineTo(xs, H - 14); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col.ink; ctx.fillText('mix switch', xs + 4, 10); }
    phImg = { img: ctx.getImageData(0, 0, cv.width, cv.height), X, H };
  }
  function drawTime() {
    const R = TS.run, cv = $('#tTime'), H = 34, { ctx, W } = sizeCanvas(cv, H), span = R.spec.horizonH * 3600, L = 34, X = t => L + (W - L - 6) * t / span;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = col.compute; ctx.globalAlpha = 0.8;
    for (const st of R.steps) if (!st.lost) ctx.fillRect(X(st.t), 6, Math.max(0.6, X(st.t + st.total) - X(st.t)), 14);
    ctx.globalAlpha = 0.35; for (const st of R.steps) if (st.lost) ctx.fillRect(X(st.t), 6, Math.max(0.6, X(st.t + st.total) - X(st.t)), 14);
    ctx.globalAlpha = 1;
    for (const sg of R.segs) { ctx.fillStyle = col[sg.kind] || col.restart; ctx.fillRect(X(sg.t0), 6, Math.max(1.5, X(sg.t1) - X(sg.t0)), 14); }
    for (const f of R.faults) { ctx.fillStyle = col.crit; ctx.beginPath(); ctx.moveTo(X(f.t), 22); ctx.lineTo(X(f.t) - 4, 30); ctx.lineTo(X(f.t) + 4, 30); ctx.fill(); }
    ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily; ctx.fillText('job', 0, 17);
    tlImg = { img: ctx.getImageData(0, 0, cv.width, cv.height), X, H };
  }
  function drawSched() {
    const S = TS.sched, R = S.r, cv = $('#tSched'), n = R.spec.workloads.length, rowH = 15, H = n * rowH + 16, { ctx, W } = sizeCanvas(cv, H), L = 150;
    const X = k => L + (W - L - 6) * k / (R.T - 1), dx = (W - L - 6) / (R.T - 1) + 0.6;
    const st = getComputedStyle(document.documentElement), rc = { quota: st.getPropertyValue('--warn').trim(), capacity: col.crit, fragmentation: col.straggler, topology: col.sync };
    ctx.clearRect(0, 0, W, H);
    R.spec.workloads.forEach((w, i) => {
      const y = i * rowH + 2, me = i === S.wi;
      ctx.fillStyle = col.ink; ctx.font = (me ? '600 ' : '') + '11px ' + getComputedStyle(document.body).fontFamily; ctx.fillText(w.name.length > 22 ? w.name.slice(0, 21) + '…' : w.name, 0, y + 10);
      for (let k = 0; k < R.T; k++) {
        const s = R.wlState[i][k]; if (!s) continue;
        if (s === 2) { ctx.fillStyle = me ? col.compute : col.muted; ctx.globalAlpha = me ? 1 : 0.45; ctx.fillRect(X(k), y + 2, dx, rowH - 5); ctx.globalAlpha = 1; }
        else if (s === 3) { ctx.fillStyle = col.line; ctx.fillRect(X(k), y + 5, dx, rowH - 11); }
        else { ctx.fillStyle = s === 4 ? rc.quota : rc[R.frames[k].reasons[i]] || col.muted; ctx.fillRect(X(k), y + 5, dx, rowH - 11); }
      }
    });
    ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    for (let h = 0; h <= R.spec.horizonH; h += Math.max(1, Math.round(R.spec.horizonH / 12))) ctx.fillText(h + 'h', X(h * 3600 / R.step) - 6, H - 2);
    scImg = { img: ctx.getImageData(0, 0, cv.width, cv.height), X: t => X(t / R.step), H };
  }
  function drawPlayheads() {
    for (const [id, o] of [['#tPhase', phImg], ['#tTime', tlImg], ['#tSched', scImg]]) {
      const cv = $(id); if (!cv || !o) continue;
      const ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
      if (o.img.width !== cv.width) continue;
      ctx.putImageData(o.img, 0, 0);
      const x = o.X(TS.t); ctx.strokeStyle = col.ink; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height / dpr); ctx.stroke();
    }
  }
  for (const id of ['#tTime']) $(id).addEventListener('click', e => { const R = TS.run, b = e.target.getBoundingClientRect(); seek((e.clientX - b.left - 34) / (b.width - 40) * R.spec.horizonH * 3600); });
  $('#tBody').addEventListener('click', e => {
    const cv = e.target.closest('#tPhase, #tSched'); if (!cv) return;
    const R = TS.run, b = cv.getBoundingClientRect(), L = cv.id === 'tPhase' ? 34 : 150;
    seek((e.clientX - b.left - L) / (b.width - L - 6) * (cv.id === 'tPhase' ? R.spec.horizonH : TS.sched.r.spec.horizonH) * 3600);
  });
  $('#tScrub').addEventListener('input', e => seek(+e.target.value));
  function seek(t) { TS.t = clamp(t, 0, TS.run.spec.horizonH * 3600); draw(); }

  // ---------- side ----------
  function renderSide() { $('#tSide').innerHTML = '<div id="tLive"></div>'; renderSideLive(); }
  function renderSideLive() {
    const R = TS.run, box = $('#tLive'); if (!R || !box) return;
    const S = T.stateAt(R, TS.t), s = R.spec;
    const counts = {}; for (let g = 0; g < R.N; g++) { const k = STATE[S.st[g]]; counts[k] = (counts[k] || 0) + 1; }
    let h = '<h2>At ' + hm(TS.t) + '</h2><div class="sub">' + (S.phase === 'done' ? 'Not running.' : S.seg ? (S.seg.kind === 'checkpoint' ? 'Writing a checkpoint.' : S.seg.kind === 'queue' ? 'Waiting to be scheduled.' : 'Restarting after a GPU fault' + (S.seg.waitedRepair ? ', waiting for node repair (no spare)' : '') + '.') : 'Step in phase: ' + esc(S.phase) + ' · mix "' + esc(s.mixes[S.step.mix].name) + '".') + '</div>';
    h += '<h3 class="sec">GPUs now</h3>' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<div class="row"><span><i class="sw" style="background:' + col[k] + '"></i>' + esc(STATE_LABEL[k]) + '</span><span>' + fInt(v) + '</span></div>').join('');
    if (S.step) {
      const x = S.step;
      h += '<h3 class="sec">This step</h3>' + [['data', x.data], ['compute', x.compute], ['straggler', x.straggler], ['sync', x.sync], ['optimizer', x.optimizer]].map(([k, v]) => '<div class="row"><span><i class="sw" style="background:' + col[k] + '"></i>' + esc(STATE_LABEL[k]) + '</span><span>' + fS(v) + '</span></div>').join('') + '<div class="row"><span><b>Total</b></span><span><b>' + fS(x.total) + '</b></span></div>' + (x.lost ? '<div class="sub" style="color:var(--crit)">This step is lost to a later fault.</div>' : '');
    }
    const m = R.models[s.mixes.length > 1 && TS.t >= s.switchMixAtH * 3600 ? 1 : 0];
    h += '<h3 class="sec">Per step, this mix</h3>' + [['Tokens', fInt(m.tokens / 1e6) + 'M'], ['Data read', (m.bytes / 1e9).toFixed(2) + ' GB'], ['Storage time', fS(m.io)], ['Decode / tokenize time', fS(m.cpu)], ['Gradient all-reduce (before overlap)', fS(m.comm)], ['Pipeline bubble', fS(m.bubble)], ['Checkpoint size', fInt(m.ckptBytes / 1e9) + ' GB']].map(([k, v]) => '<div class="row"><span>' + k + '</span><span>' + v + '</span></div>').join('');
    box.innerHTML = h;
  }

  // ---------- toolbar ----------
  let raf = 0, last = 0;
  function tick(ts) {
    if (!TS.playing) return;
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    TS.t += dt * TS.speed;
    const end = TS.run.spec.horizonH * 3600;
    if (TS.t >= end) { TS.t = end; setPlaying(false); }
    draw();
    raf = requestAnimationFrame(tick);
  }
  function setPlaying(on) { TS.playing = on; last = 0; $('#tPlay').innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Play'; if (on) { if (TS.t >= TS.run.spec.horizonH * 3600) TS.t = 0; raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf); }
  $('#tPlay').addEventListener('click', () => setPlaying(!TS.playing));
  $('#tSpeed').addEventListener('change', e => { TS.speed = +e.target.value; });
  $('#tPin').addEventListener('click', () => { TS.baseline = { label: 'pinned baseline', summary: TS.run.summary, byMix: TS.run.byMix, queueWaitS: TS.run.spec.queueWaitS }; $('#tClear').hidden = false; renderKpis(); renderHead(); });
  $('#tClear').addEventListener('click', () => { TS.baseline = null; $('#tClear').hidden = true; renderKpis(); renderHead(); });
  $('#tFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => { TS.faultLog = T.parseFaultLog(txt); if (!TS.faultLog.events.length) { $('#tStatus').textContent = 'No GPU faults found in ' + f.name; TS.faultLog = null; return; } renderCfg(); run(); });
  });
  window.addEventListener('resize', () => { if (TS.run && !root.hidden) renderBody(); });

  let started = false;
  window.FleetTrainingView = {
    show() { root.hidden = false; readColors(); if (!started) { started = true; renderSubs(); renderCfg(); } run(); },
    hide() { root.hidden = true; setPlaying(false); },
    state: TS
  };
})();
