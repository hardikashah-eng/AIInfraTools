/* FleetScope cluster view: GPU allocation grid, scheduler policy what-ifs, workload timeline. Browser only. */
(function () {
  'use strict';
  const C = window.FleetCluster;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fInt = v => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
  const fPct = v => (isFinite(v) ? Math.round(v * 100) + '%' : '–');
  const fGh = v => (isFinite(v) ? (v >= 10 ? fInt(v) : v.toFixed(1)) + ' GPU-h' : '–');
  const fMin = v => (!isFinite(v) ? '–' : v >= 90 ? (v / 60).toFixed(1) + ' h' : Math.round(v) + ' min');
  const hm = s => { const m = Math.floor(s / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const WL_VARS = ['--onprem', '--neo', '--train', '--n-link', '--n-src', '--n-route'];
  const WL_EXTRA = ['#b8467a', '#7d8f1d', '#2f7fa8', '#a0522d'];
  const CS = { spec: C.sampleCluster(), run: null, k: 0, playing: false, speed: 4, baseline: null, sel: null, compare: null, job: null, notes: null, tpl: 'sample' };
  let colors = {};
  function readColors() {
    const st = getComputedStyle(document.documentElement), g = v => st.getPropertyValue(v).trim();
    colors = { wl: WL_VARS.map(g).concat(WL_EXTRA), free: g('--panel-2'), line: g('--line'), crit: g('--crit'), warn: g('--warn'), ink: g('--ink'), muted: g('--muted'), panel: g('--panel'), good: g('--good'), queue: g('--c-queue'), link: g('--n-link'), canvas: g('--canvas') };
  }
  const wlColor = i => colors.wl[i % colors.wl.length];
  const REASON_COLOR = () => ({ quota: colors.warn, capacity: colors.crit, fragmentation: colors.queue, topology: colors.link });

  // ---------- layout ----------
  const root = $('#clusterApp');
  root.innerHTML = `
  <header class="toolbar">
    <div class="tb"><select id="cTpl" aria-label="Cluster"><option value="sample">Sample: mixed GPU cluster (64 nodes, 512 GPUs)</option></select>
      <label class="btnlike" title="kubectl get nodes,pods,clusterqueues,localqueues -A -o json">Import kubectl JSON<input type="file" id="cFile" accept=".json" hidden></label></div>
    <div class="tb">
      <button type="button" id="cPlay" class="play">&#9654; Play</button>
      <select id="cSpeed" aria-label="Playback speed"><option value="1">1 tick</option><option value="4" selected>4 ticks</option><option value="16">16 ticks</option><option value="60">60 ticks</option></select>
      <span class="clock" id="cClock">0:00 / 8:00</span>
    </div>
    <div class="tb"><button type="button" id="cPin">Pin as baseline</button><button type="button" id="cClear" hidden>Clear baseline</button><button type="button" id="cCompare" title="Run this cluster under each scheduler policy">Compare policies</button></div>
    <div class="status" id="cStatus">Simulating…</div>
  </header>
  <aside class="palette cfg" id="cCfg"></aside>
  <section class="center">
    <div class="chead" id="cHead"></div>
    <div class="kpis" id="cKpis"></div>
    <section class="analysis" id="cAnalysis" hidden></section>
    <div class="gridWrap"><canvas id="cGrid" aria-label="GPU allocation grid: one square per GPU, grouped by node, IB domain and pool"></canvas><div class="gtip" id="cTip" hidden></div></div>
    <div class="glegend" id="cLegend"></div>
    <div class="timeline"><canvas id="cTime" aria-label="Allocation over time; click to jump"></canvas><input type="range" id="cScrub" min="0" max="2879" step="1" value="0" aria-label="Playhead"></div>
    <h3 class="sec cpad">Workloads over time <span class="sub" style="font-weight:400">running in the workload colour; pending coloured by why it waits; click to jump</span></h3>
    <canvas id="cGantt" aria-label="Workload states over time"></canvas>
  </section>
  <aside class="details" id="cSide" aria-live="polite"></aside>`;

  // ---------- config panel ----------
  const FIELDS = {
    pool: [['nodes', 'Nodes', 1, 512, 1], ['gpusPerNode', 'GPUs per node', 1, 16, 1], ['domainNodes', 'Nodes per IB domain', 1, 512, 1], ['faultPerGpuDay', 'Faults per GPU-day', 0, 1, 0.001], ['repairH', 'Repair time (h)', 0.1, 72, 0.1]],
    queue: [['quota', 'GPU quota', 0, 4096, 1], ['priority', 'Priority', -100, 1000, 1]],
    inference: [['minPods', 'Min replicas', 0, 512, 1], ['pods', 'Peak replicas', 1, 512, 1], ['gpusPerPod', 'GPUs per pod', 1, 16, 1], ['peakH', 'Peak hour of day', 0, 23, 1]],
    training: [['pods', 'Pods (gang size)', 1, 512, 1], ['gpusPerPod', 'GPUs per pod', 1, 16, 1], ['startH', 'Submitted at (h)', 0, 48, 0.25], ['durationH', 'Run time (h)', 0.1, 200, 0.1], ['ckptMin', 'Checkpoint every (min)', 0, 600, 1], ['restartMin', 'Restart / load (min)', 0, 120, 1]],
    batch: [['ratePerH', 'Jobs per hour', 0, 2000, 1], ['gpusPerPod', 'GPUs per job', 1, 16, 1], ['durationH', 'Median run time (h)', 0.05, 48, 0.05]]
  };
  function numInput(path, v, lo, hi, step) { return '<input type="number" data-path="' + path + '" value="' + (v == null ? '' : v) + '" min="' + lo + '" max="' + hi + '" step="' + step + '">'; }
  function renderCfg() {
    const s = CS.spec, P = Object.assign({}, C.POLICY_DEFAULTS, s.policy);
    const seg = (key, opts) => '<div class="seg" data-pol="' + key + '">' + opts.map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (P[key] === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
    const chk = (key, label, hint) => '<label class="chk" title="' + esc(hint) + '"><input type="checkbox" data-pol="' + key + '"' + (P[key] ? ' checked' : '') + '> ' + label + '</label>';
    let h = (CS.notes ? '<div class="note">' + CS.notes.map(esc).join('<br>') + '</div>' : '') +
      '<h3>Scheduler policy</h3><div class="ctl"><span class="lbl">Placement</span>' + seg('placement', [['binpack', 'Bin-pack'], ['spread', 'Spread']]) + '</div>' +
      chk('gang', 'Gang scheduling', 'Place all pods of a training job together, or none') + chk('topology', 'Topology-aware (one IB domain per job)', 'Training jobs that ask for it are placed within one InfiniBand domain') +
      chk('preemption', 'Preemption', 'Higher-priority work may evict lower-priority pods, and queues may reclaim borrowed quota') + chk('borrowing', 'Quota borrowing', 'A queue may use other queues’ unused quota') +
      '<div class="ctl"><span class="lbl">Queue order</span>' + seg('order', [['besteffort', 'Best-effort FIFO'], ['strict', 'Strict FIFO']]) + '</div>' +
      '<div class="ctl"><span class="lbl">Simulated hours</span>' + numInput('horizonH', s.horizonH, 1, 72, 1) + '</div>';
    h += '<h3>Node pools</h3>' + s.pools.map((p, i) => '<details class="card"><summary><b>' + esc(p.name) + '</b> <span>' + p.nodes + ' × ' + p.gpusPerNode + ' ' + esc(p.gpu) + '</span></summary>' + FIELDS.pool.map(([k, l, lo, hi, st]) => '<label class="frow"><span>' + l + '</span>' + numInput('pools.' + i + '.' + k, p[k], lo, hi, st) + '</label>').join('') + '</details>').join('');
    h += '<h3>Queues</h3>' + s.queues.map((q, i) => '<details class="card"><summary><b>' + esc(q.name) + '</b> <span>' + q.quota + ' GPUs' + (q.team ? ' · ' + esc(q.team) : '') + '</span></summary>' + FIELDS.queue.map(([k, l, lo, hi, st]) => '<label class="frow"><span>' + l + '</span>' + numInput('queues.' + i + '.' + k, q[k], lo, hi, st) + '</label>').join('') + '</details>').join('');
    h += '<h3>Workloads</h3>' + s.workloads.map((w, i) => '<details class="card"><summary><i class="sw" style="background:' + wlColor(i) + '"></i><b>' + esc(w.name) + '</b> <span>' + w.kind + ' · ' + esc(w.queue) + '</span></summary>' +
      FIELDS[w.kind].map(([k, l, lo, hi, st]) => '<label class="frow"><span>' + l + '</span>' + numInput('workloads.' + i + '.' + k, w[k], lo, hi, st) + '</label>').join('') +
      '<label class="frow"><span>Priority (blank: queue’s)</span>' + numInput('workloads.' + i + '.priority', w.priority, -1000, 1000, 1) + '</label>' +
      (w.kind === 'training' ? '<label class="frow"><span>Placement</span><select data-path="workloads.' + i + '.topology"><option value="domain"' + (w.topology === 'domain' ? ' selected' : '') + '>one IB domain</option><option value="any"' + (w.topology !== 'domain' ? ' selected' : '') + '>anywhere</option></select></label>' : '') +
      '</details>').join('');
    $('#cCfg').innerHTML = h;
  }
  function setPath(path, v) {
    const ks = path.split('.'); let o = CS.spec;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = v;
  }
  $('#cCfg').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.path) { setPath(t.dataset.path, t.tagName === 'SELECT' ? t.value : t.value === '' ? null : +t.value); schedule(); }
    else if (t.dataset.pol) { CS.spec.policy = Object.assign({}, CS.spec.policy, { [t.dataset.pol]: t.checked }); schedule(); }
  });
  $('#cCfg').addEventListener('click', e => {
    const b = e.target.closest('.seg button'); if (!b) return;
    const key = b.parentNode.dataset.pol;
    CS.spec.policy = Object.assign({}, CS.spec.policy, { [key]: b.dataset.v });
    for (const x of b.parentNode.children) x.classList.toggle('on', x === b);
    schedule();
  });
  let timer = 0;
  function schedule() { clearTimeout(timer); $('#cStatus').textContent = 'Re-simulating…'; timer = setTimeout(run, 250); }

  // ---------- run ----------
  function run() {
    const t0 = performance.now();
    try { CS.run = C.simulateCluster(CS.spec); } catch (err) { $('#cStatus').textContent = 'Simulation failed: ' + err.message; return; }
    const R = CS.run;
    CS.k = clamp(CS.k, 0, R.T - 1);
    $('#cScrub').max = R.T - 1;
    $('#cStatus').innerHTML = '<b>' + fInt(R.G) + '</b> GPUs on <b>' + R.nodes.length + '</b> nodes · <b>' + R.spec.horizonH + ' h</b> simulated in ' + Math.round(performance.now() - t0) + ' ms';
    layoutGrid(); drawTimeline(); drawGantt(); renderKpis(); renderHead(); renderLegend(); draw(); renderSide();
  }

  // ---------- KPIs and headline ----------
  function renderKpis() {
    const s = CS.run.summary, b = CS.baseline;
    const tile = (k, v, cls, cur, base, lower, fmt) => {
      let d = '', dc = '';
      if (b && isFinite(cur) && isFinite(base) && Math.abs(cur - base) > 1e-9) { d = (cur > base ? '▲ ' : '▼ ') + fmt(Math.abs(cur - base)); dc = (lower ? cur < base : cur > base) ? 'better' : 'worse'; }
      else if (b) d = '= baseline';
      return '<div class="kpi ' + (cls || '') + '"><div class="k" title="' + k + '">' + k + '</div><div class="v">' + v + '</div><div class="d ' + dc + '">' + d + '</div></div>';
    };
    const bs = b ? b.summary : {};
    $('#cKpis').innerHTML = [
      tile('GPU allocation', fPct(s.allocation), s.allocation > 0.8 ? 'good' : s.allocation > 0.5 ? 'warn' : 'crit', s.allocation, bs.allocation, false, v => Math.round(v * 100) + ' pt'),
      tile('Stranded GPU-hours', fGh(s.strandedGpuH), s.strandedGpuH > 50 ? 'crit' : '', s.strandedGpuH, bs.strandedGpuH, true, fGh),
      tile('Allocated but idle', fGh(s.idleAllocGpuH), s.idleAllocGpuH > 20 ? 'warn' : '', s.idleAllocGpuH, bs.idleAllocGpuH, true, fGh),
      tile('Training admitted', s.trainingAdmitted + ' / ' + s.trainingTotal, s.trainingAdmitted < s.trainingTotal ? 'crit' : 'good', s.trainingAdmitted, bs.trainingAdmitted, false, v => String(v)),
      tile('Mean training wait', fMin(s.trainingWaitMin), '', s.trainingWaitMin, bs.trainingWaitMin, true, fMin),
      tile('Batch job wait', fMin(s.batchWaitMin), '', s.batchWaitMin, bs.batchWaitMin, true, fMin),
      tile('Inference fully placed', fPct(s.inferenceFull), s.inferenceFull < 0.99 ? 'crit' : 'good', s.inferenceFull, bs.inferenceFull, false, v => Math.round(v * 100) + ' pt'),
      tile('Preemptions', fInt(s.preemptions), '', s.preemptions, bs.preemptions, true, fInt),
      tile('GPU faults (job restarts)', fInt(s.faults) + ' (' + fInt(s.restarts) + ')', s.faults ? 'warn' : '', s.faults, bs.faults, true, fInt),
      tile('Work lost to faults', fGh(s.lostGpuH), s.lostGpuH > 0 ? 'warn' : '', s.lostGpuH, bs.lostGpuH, true, fGh)
    ].join('');
  }
  function renderHead() {
    const R = CS.run, s = R.summary, W = R.workloads;
    const blocked = W.filter(w => w.kind === 'training' && !w.admittedOk && isFinite(w.submitted));
    const worst = W.filter(w => w.kind === 'training' && w.admittedOk).sort((a, b) => b.waitMin - a.waitMin)[0];
    let h;
    if (blocked.length) { const w = blocked[0]; h = '<b>' + esc(w.name) + '</b> (' + w.gpus + ' GPUs) never started: ' + esc(C.REASON[w.topReason] || 'it waited') + '. '; }
    else if (worst && worst.waitMin > 15) h = '<b>' + esc(worst.name) + '</b> waited <b>' + fMin(worst.waitMin) + '</b> to start, mostly because ' + esc(C.REASON[worst.topReason] || 'it waited') + '. ';
    else h = 'Every training job started within ' + fMin(worst ? worst.waitMin : 0) + '. ';
    if (s.strandedGpuH > 20) h += '<b>' + fGh(s.strandedGpuH) + '</b> sat free but stranded on part-used nodes while work waited. ';
    if (s.idleAllocGpuH > 10) h += '<b>' + fGh(s.idleAllocGpuH) + '</b> were held by training jobs that could not run (waiting for the rest of a gang, or restarting). ';
    if (s.faults) h += s.faults + ' GPU fault' + (s.faults > 1 ? 's' : '') + (s.lostGpuH > 0.5 ? ' cost ' + fGh(s.lostGpuH) + ' of training since checkpoints' : '') + '.';
    $('#cHead').innerHTML = h + (CS.baseline ? ' <span class="sub">Compared with <b>' + esc(CS.baseline.label) + '</b>.</span>' : '');
  }
  function renderLegend() {
    const R = CS.run, rc = REASON_COLOR();
    $('#cLegend').innerHTML = R.spec.workloads.map((w, i) => '<span><i style="background:' + wlColor(i) + '"></i>' + esc(w.name) + '</span>').join('') +
      '<span><i class="hatch"></i>held, not running</span><span><i style="background:' + colors.crit + '"></i>faulted</span><span><i class="empty"></i>free</span>' +
      '<span class="sep">pending:</span>' + Object.entries(rc).map(([k, c]) => '<span><i style="background:' + c + '"></i>' + k + '</span>').join('');
  }

  // ---------- GPU grid ----------
  const G = { tile: 8, gap: 1, nodeGap: 6, rows: [], pos: null, w: 0, h: 0 };
  function layoutGrid() {
    const R = CS.run, cv = $('#cGrid'), W = cv.parentNode.clientWidth - 16;
    const gpn = Math.max(...R.nodes.map(n => n.gpus));
    const cols = gpn <= 4 ? gpn : Math.ceil(gpn / 2), rowsPer = Math.ceil(gpn / cols);
    const nw = cols * (G.tile + G.gap) + G.nodeGap, nh = rowsPer * (G.tile + G.gap) + G.nodeGap;
    const perRow = Math.max(4, Math.floor((W - 110) / nw));
    const pos = new Array(R.G); let y = 6;
    G.labels = [];
    R.spec.pools.forEach((p, pi) => {
      const doms = R.domains.map((d, di) => ({ d, di })).filter(x => x.d.pool === pi);
      G.labels.push({ y: y + 10, text: p.name + ' · ' + p.gpu + ' · ' + p.site, bold: true });
      y += 18;
      for (const { d, di } of doms) {
        G.labels.push({ y: y + 10, text: 'IB domain ' + (doms.findIndex(x => x.di === di) + 1), x: 0 });
        d.nodes.forEach((ni, j) => {
          const n = R.nodes[ni], cx = 110 + (j % perRow) * nw, cy = y + Math.floor(j / perRow) * nh;
          for (let g = 0; g < n.gpus; g++) pos[n.base + g] = { x: cx + (g % cols) * (G.tile + G.gap), y: cy + Math.floor(g / cols) * (G.tile + G.gap), node: ni, idx: g };
          n.box = { x: cx - 2, y: cy - 2, w: cols * (G.tile + G.gap) + 3, h: rowsPer * (G.tile + G.gap) + 3 };
        });
        y += Math.ceil(d.nodes.length / perRow) * nh + 6;
      }
      y += 8;
    });
    G.pos = pos; G.w = W; G.h = y;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = y * dpr; cv.style.width = W + 'px'; cv.style.height = y + 'px';
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function draw() {
    const R = CS.run; if (!R) return;
    const k = CS.k, fr = R.frames[k], cv = $('#cGrid'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, G.w, G.h);
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    for (const L of G.labels) { ctx.fillStyle = L.bold ? colors.ink : colors.muted; ctx.font = (L.bold ? '600 ' : '') + '11px ' + getComputedStyle(document.body).fontFamily; ctx.fillText(L.text, 0, L.y); }
    for (const n of R.nodes) { if (!n.box) continue; ctx.strokeStyle = CS.sel && CS.sel.node === R.nodes.indexOf(n) ? colors.ink : colors.line; ctx.lineWidth = 1; ctx.strokeRect(n.box.x + 0.5, n.box.y + 0.5, n.box.w, n.box.h); }
    for (let g = 0; g < R.G; g++) {
      const p = G.pos[g]; if (!p) continue;
      const o = fr.own[g], st = fr.st[g];
      if (st === 3) { ctx.fillStyle = colors.crit; ctx.fillRect(p.x, p.y, G.tile, G.tile); ctx.strokeStyle = colors.panel; ctx.beginPath(); ctx.moveTo(p.x + 1, p.y + 1); ctx.lineTo(p.x + G.tile - 1, p.y + G.tile - 1); ctx.stroke(); continue; }
      if (o < 0) { ctx.strokeStyle = colors.line; ctx.strokeRect(p.x + 0.5, p.y + 0.5, G.tile - 1, G.tile - 1); continue; }
      ctx.fillStyle = wlColor(o);
      ctx.globalAlpha = st === 2 ? 0.35 : 1;
      ctx.fillRect(p.x, p.y, G.tile, G.tile);
      ctx.globalAlpha = 1;
      if (st === 2) { ctx.strokeStyle = wlColor(o); ctx.beginPath(); ctx.moveTo(p.x, p.y + G.tile); ctx.lineTo(p.x + G.tile, p.y); ctx.stroke(); }
    }
    $('#cClock').textContent = hm(k * R.step) + ' / ' + hm(R.T * R.step);
    const sc = $('#cScrub'); if (document.activeElement !== sc) sc.value = k;
    drawPlayheads();
  }
  $('#cGrid').addEventListener('mousemove', e => {
    const R = CS.run; if (!R) return;
    const b = e.target.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let hit = -1;
    for (let g = 0; g < R.G; g++) { const p = G.pos[g]; if (p && x >= p.x && x < p.x + G.tile + 1 && y >= p.y && y < p.y + G.tile + 1) { hit = g; break; } }
    const tip = $('#cTip');
    if (hit < 0) { tip.hidden = true; return; }
    const p = G.pos[hit], n = R.nodes[p.node], fr = R.frames[CS.k], o = fr.own[hit], st = fr.st[hit];
    const fx = R.gpuFaults.find(x => x.gpu === hit);
    tip.innerHTML = '<b>' + esc(n.name) + '</b> GPU ' + p.idx + '<br>' + (st === 3 ? '<span style="color:var(--crit)">faulted, under repair</span>' : o < 0 ? 'free' : esc(R.spec.workloads[o].name) + (st === 2 ? ' (held, not running)' : '')) + (fx ? '<br>' + fx.faults + ' fault' + (fx.faults > 1 ? 's' : '') + ' this run' : '');
    tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 10) + 'px'; tip.hidden = false;
  });
  $('#cGrid').addEventListener('mouseleave', () => { $('#cTip').hidden = true; });
  $('#cGrid').addEventListener('click', e => {
    const R = CS.run; if (!R) return;
    const b = e.target.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    const ni = R.nodes.findIndex(n => n.box && x >= n.box.x && x <= n.box.x + n.box.w && y >= n.box.y && y <= n.box.y + n.box.h);
    CS.sel = ni >= 0 ? { node: ni } : null; draw(); renderSide();
  });

  // ---------- timeline and Gantt ----------
  const TL = { h: 120, l: 44, r: 8 };
  function sizeCanvas(cv, h) { const W = cv.parentNode.clientWidth - 16, dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = h * dpr; cv.style.width = W + 'px'; cv.style.height = h + 'px'; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, W }; }
  let tlImg = null, gtImg = null;
  function drawTimeline() {
    const R = CS.run, S = R.series, cv = $('#cTime'), { ctx, W } = sizeCanvas(cv, TL.h), H = TL.h - 16;
    const X = k => TL.l + (W - TL.l - TL.r) * k / (R.T - 1), Y = v => 4 + H * (1 - v / R.G);
    ctx.clearRect(0, 0, W, TL.h);
    const band = (lo, hi, col, alpha) => { ctx.beginPath(); for (let k = 0; k < R.T; k++) ctx.lineTo(X(k), Y(hi(k))); for (let k = R.T - 1; k >= 0; k--) ctx.lineTo(X(k), Y(lo(k))); ctx.closePath(); ctx.globalAlpha = alpha; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; };
    const busy = k => S.alloc[k] - S.idleAlloc[k];
    band(() => 0, busy, colors.wl[0], 0.75);
    band(busy, k => S.alloc[k], colors.warn, 0.6);
    band(k => S.alloc[k], k => S.alloc[k] + S.stranded[k], colors.queue, 0.6);
    band(k => R.G - S.faulted[k], () => R.G, colors.crit, 0.8);
    // pending demand line
    ctx.beginPath(); for (let k = 0; k < R.T; k++) { const v = S.pendQuota[k] + S.pendCapacity[k] + S.pendFragmentation[k] + S.pendTopology[k]; ctx.lineTo(X(k), Y(Math.min(R.G, S.alloc[k] + v))); }
    ctx.strokeStyle = colors.ink; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = colors.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText(R.G + ' GPUs', 0, 12); ctx.fillText('0', 0, 4 + H);
    for (let h = 0; h <= R.spec.horizonH; h += Math.max(1, Math.round(R.spec.horizonH / 8))) ctx.fillText(h + 'h', X(h * 3600 / R.step) - 6, TL.h - 2);
    tlImg = ctx.getImageData(0, 0, cv.width, cv.height);
    $('#cTimeLegend') || cv.insertAdjacentHTML('beforebegin', '<div class="glegend" id="cTimeLegend"></div>');
    $('#cTimeLegend').innerHTML = '<span><i style="background:' + colors.wl[0] + '"></i>busy</span><span><i style="background:' + colors.warn + '"></i>allocated, idle</span><span><i style="background:' + colors.queue + '"></i>stranded free</span><span><i style="background:' + colors.crit + '"></i>faulted</span><span><i class="dash"></i>allocated + pending demand</span>';
  }
  const GT = { row: 16, l: 150 };
  function drawGantt() {
    const R = CS.run, cv = $('#cGantt'), n = R.spec.workloads.length, h = n * GT.row + 18, { ctx, W } = sizeCanvas(cv, h);
    const rc = REASON_COLOR(), X = k => GT.l + (W - GT.l - TL.r) * k / (R.T - 1), dx = (W - GT.l - TL.r) / (R.T - 1) + 0.6;
    ctx.clearRect(0, 0, W, h);
    const font = getComputedStyle(document.body).fontFamily;
    R.spec.workloads.forEach((w, i) => {
      const y = i * GT.row + 2, st = R.wlState[i];
      ctx.fillStyle = colors.ink; ctx.font = '11px ' + font; ctx.fillText(w.name.length > 22 ? w.name.slice(0, 21) + '…' : w.name, 0, y + 11);
      for (let k = 0; k < R.T; k++) {
        const s = st[k]; if (!s) continue;
        // running: full-height bar in the workload colour; pending or partly placed: a thin bar coloured by the reason
        if (s === 2) { ctx.fillStyle = wlColor(i); ctx.fillRect(X(k), y + 2, dx, GT.row - 5); }
        else if (s === 3) { ctx.fillStyle = colors.line; ctx.fillRect(X(k), y + 6, dx, GT.row - 13); }
        else { ctx.fillStyle = s === 4 ? colors.warn : rc[R.frames[k].reasons[i]] || colors.muted; ctx.fillRect(X(k), y + 5, dx, GT.row - 11); }
      }
    });
    for (const e of R.events) if (e.kind === 'fault' || e.kind === 'preempt' || e.kind === 'restart') { const y = e.wl * GT.row + 2; ctx.fillStyle = e.kind === 'preempt' ? colors.ink : colors.crit; ctx.fillRect(X(e.t / R.step) - 1, y, 2, GT.row - 2); }
    gtImg = ctx.getImageData(0, 0, cv.width, cv.height);
  }
  function drawPlayheads() {
    const R = CS.run;
    for (const [id, img, l] of [['#cTime', tlImg, TL.l], ['#cGantt', gtImg, GT.l]]) {
      if (!img) continue;
      const cv = $(id), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1, W = cv.width / dpr;
      ctx.putImageData(img, 0, 0);
      const x = l + (W - l - TL.r) * CS.k / (R.T - 1);
      ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height / dpr); ctx.stroke();
    }
  }
  for (const [id, l] of [['#cTime', TL.l], ['#cGantt', GT.l]]) $(id).addEventListener('click', e => {
    const R = CS.run, b = e.target.getBoundingClientRect(), x = e.clientX - b.left;
    seek(Math.round((x - l) / (b.width - l - TL.r) * (R.T - 1)));
  });
  $('#cScrub').addEventListener('input', e => seek(+e.target.value));
  function seek(k) { CS.k = clamp(k, 0, CS.run.T - 1); draw(); renderSideLive(); }

  // ---------- side panel ----------
  function renderSide() {
    const R = CS.run;
    let h = '<div id="cLive"></div>';
    h += '<h3 class="sec">Workloads</h3><table class="atable"><thead><tr><th>Workload</th><th>Waited</th><th>Goodput</th></tr></thead><tbody>' +
      R.workloads.map((w, i) => '<tr><td><i class="sw" style="background:' + wlColor(i) + '"></i><b>' + esc(w.name) + '</b><br><span class="sub">' +
        [w.kind + (w.kind === 'batch' ? ', ' + w.jobs.submitted + ' jobs' : ', ' + fInt(w.gpus) + ' GPUs'), w.kind === 'training' ? (w.admittedOk ? fPct(w.progress) + ' done' : 'never started') : '', w.topReason ? 'waited on ' + w.topReason : '', w.preempts ? w.preempts + ' preempted' : '', w.faults ? w.faults + ' faults' + (w.restarts ? ', ' + w.restarts + ' restarts' : '') : ''].filter(Boolean).join(' · ') +
        '</span></td><td class="num">' + fMin(w.waitMin) + '</td><td class="num">' + fPct(w.goodput) + '</td></tr>').join('') + '</tbody></table>';
    if (R.nodeFaults.length) h += '<h3 class="sec">Most-faulting nodes</h3>' + R.nodeFaults.slice(0, 5).map(n => '<div class="row"><span>' + esc(n.name) + '</span><span>' + n.faults + '</span></div>').join('') +
      '<h3 class="sec">Most-faulting GPUs</h3>' + R.gpuFaults.slice(0, 5).map(g => '<div class="row"><span>' + esc(g.node) + ' GPU ' + g.index + '</span><span>' + g.faults + '</span></div>').join('');
    $('#cSide').innerHTML = h;
    renderSideLive();
  }
  function renderSideLive() {
    const R = CS.run, k = CS.k, fr = R.frames[k], box = $('#cLive'); if (!box) return;
    const pend = R.spec.workloads.map((w, i) => ({ w, i, r: fr.reasons[i] })).filter(x => x.r);
    let h = '<h2>At ' + hm(k * R.step) + '</h2><div class="sub">' + fInt(R.series.alloc[k]) + ' of ' + R.G + ' GPUs allocated · ' + fInt(R.series.free[k]) + ' free · ' + fInt(R.series.faulted[k]) + ' faulted' + (R.series.stranded[k] ? ' · ' + fInt(R.series.stranded[k]) + ' stranded' : '') + '</div>';
    h += '<h3 class="sec">Pending</h3>' + (pend.length ? pend.map(x => '<div class="row"><span><i class="sw" style="background:' + wlColor(x.i) + '"></i>' + esc(x.w.name) + '</span><span>' + esc(C.REASON[x.r] || x.r) + '</span></div>').join('') : '<div class="sub">Nothing waiting.</div>');
    if (CS.sel && CS.sel.node != null) {
      const n = R.nodes[CS.sel.node], counts = {};
      for (let g = n.base; g < n.base + n.gpus; g++) { const o = fr.own[g], key = fr.st[g] === 3 ? 'faulted' : o < 0 ? 'free' : R.spec.workloads[o].name + (fr.st[g] === 2 ? ' (idle)' : ''); counts[key] = (counts[key] || 0) + 1; }
      h += '<h3 class="sec">Node ' + esc(n.name) + '</h3>' + Object.entries(counts).map(([k2, v]) => '<div class="row"><span>' + esc(k2) + '</span><span>' + v + ' GPU' + (v > 1 ? 's' : '') + '</span></div>').join('') + '<div class="sub">' + n.faults + ' fault' + (n.faults === 1 ? '' : 's') + ' this run · IB domain ' + (n.domain + 1) + '</div>';
    }
    const near = [];
    for (const e of R.events) {
      if (Math.abs(e.t / R.step - k) > 60) continue;
      const lastE = near[near.length - 1];
      if (lastE && lastE.t === e.t && lastE.wl === e.wl && lastE.detail === e.detail) lastE.n++; else near.push(Object.assign({ n: 1 }, e));
    }
    if (near.length) h += '<h3 class="sec">Events around now</h3>' + near.slice(-6).map(e => '<div class="row"><span>' + hm(e.t) + ' ' + esc(R.spec.workloads[e.wl].name) + '</span><span>' + esc(e.detail) + (e.n > 1 ? ' ×' + e.n : '') + '</span></div>').join('');
    box.innerHTML = h;
  }

  // ---------- compare policies ----------
  function compare() {
    if (CS.job) CS.job.cancel = true;
    const job = { cancel: false }, it = C.comparePoliciesIter(CS.spec);
    CS.job = job;
    const box = $('#cAnalysis'); box.hidden = false;
    const step = () => {
      if (job.cancel) return;
      const x = it.next();
      if (!x.done) { box.innerHTML = '<h3>Comparing scheduler policies</h3><div class="progress"><i style="width:' + (100 * x.value.done / x.value.total) + '%"></i></div><div class="sub">' + esc(x.value.text) + '</div>'; setTimeout(step, 0); return; }
      CS.compare = x.value; CS.job = null; renderCompare();
    };
    setTimeout(step, 20);
  }
  function renderCompare() {
    const rows = CS.compare, box = $('#cAnalysis'), base = rows[0];
    const best = rows.slice().sort((a, b) => (b.summary.trainingAdmitted - a.summary.trainingAdmitted) || (b.summary.allocation - a.summary.allocation))[0];
    const tw = r => r.workloads.filter(w => w.kind === 'training');
    box.innerHTML = '<h3>Scheduler policies on this cluster <button class="linkbtn" type="button" data-act="close">Close</button></h3>' +
      '<p class="lead">As configured: <b>' + fPct(base.summary.allocation) + '</b> allocation, ' + base.summary.trainingAdmitted + ' of ' + base.summary.trainingTotal + ' training jobs started. ' + (best !== base ? 'Best: <b>' + esc(best.name) + '</b>, with ' + fPct(best.summary.allocation) + ' allocation and ' + best.summary.trainingAdmitted + ' of ' + best.summary.trainingTotal + ' started.' : 'No single change does better.') + ' Click a row to apply it.</p>' +
      '<div class="ascroll"><table class="atable"><thead><tr><th>Policy</th><th>Allocation</th><th>Stranded</th><th>Allocated, idle</th><th>Training started</th><th>Mean training wait</th><th>Batch wait</th><th>Inference placed</th><th>Preemptions</th><th>Work lost</th></tr></thead><tbody>' +
      rows.map((r, i) => { const s = r.summary; return '<tr class="click' + (r === best ? ' pick' : '') + '" data-pol="' + i + '"><td><b>' + esc(r.name) + '</b></td><td class="num">' + fPct(s.allocation) + '</td><td class="num">' + fGh(s.strandedGpuH) + '</td><td class="num">' + fGh(s.idleAllocGpuH) + '</td><td class="num">' + s.trainingAdmitted + ' / ' + s.trainingTotal + '</td><td class="num">' + fMin(s.trainingWaitMin) + '</td><td class="num">' + fMin(s.batchWaitMin) + '</td><td class="num">' + fPct(s.inferenceFull) + '</td><td class="num">' + fInt(s.preemptions) + '</td><td class="num">' + fGh(s.lostGpuH) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="sub">Each row changes one thing from the configured policy. Training waits count jobs that never started up to the end of the run.</div>';
    void tw;
  }
  $('#cAnalysis').addEventListener('click', e => {
    if (e.target.closest('[data-act="close"]')) { $('#cAnalysis').hidden = true; return; }
    const tr = e.target.closest('[data-pol]'); if (!tr) return;
    const r = CS.compare[+tr.dataset.pol];
    if (!CS.baseline) CS.baseline = { label: 'policy as configured', summary: CS.run.summary };
    $('#cClear').hidden = false;
    CS.spec.policy = Object.assign({}, r.policy); renderCfg(); run();
  });

  // ---------- toolbar ----------
  let raf = 0, last = 0;
  function tick(ts) {
    if (!CS.playing) return;
    if (ts - last > 33) { last = ts; CS.k += CS.speed; if (CS.k >= CS.run.T - 1) { CS.k = CS.run.T - 1; setPlaying(false); } draw(); renderSideLive(); }
    raf = requestAnimationFrame(tick);
  }
  function setPlaying(on) { CS.playing = on; $('#cPlay').innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Play'; if (on) { if (CS.k >= CS.run.T - 1) CS.k = 0; raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf); }
  $('#cPlay').addEventListener('click', () => setPlaying(!CS.playing));
  $('#cSpeed').addEventListener('change', e => { CS.speed = +e.target.value; });
  $('#cPin').addEventListener('click', () => { CS.baseline = { label: 'pinned baseline', summary: CS.run.summary }; $('#cClear').hidden = false; renderKpis(); renderHead(); });
  $('#cClear').addEventListener('click', () => { CS.baseline = null; $('#cClear').hidden = true; renderKpis(); renderHead(); });
  $('#cCompare').addEventListener('click', compare);
  $('#cTpl').addEventListener('change', e => { if (e.target.value === 'sample') { CS.spec = C.sampleCluster(); CS.notes = null; } else if (CS.imported) { CS.spec = JSON.parse(JSON.stringify(CS.imported.spec)); CS.notes = CS.imported.notes; } CS.baseline = null; renderCfg(); run(); });
  $('#cFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => {
      try { CS.imported = C.fromKube(txt); } catch (err) { $('#cStatus').textContent = 'Could not read ' + f.name + ': ' + err.message; return; }
      const sel = $('#cTpl');
      if (!sel.querySelector('[value="imported"]')) sel.insertAdjacentHTML('beforeend', '<option value="imported"></option>');
      sel.querySelector('[value="imported"]').textContent = 'Imported: ' + f.name;
      sel.value = 'imported'; sel.dispatchEvent(new Event('change'));
    });
  });
  window.addEventListener('resize', () => { if (CS.run && !root.hidden) { layoutGrid(); drawTimeline(); drawGantt(); draw(); } });

  let started = false;
  window.FleetClusterView = {
    show() { root.hidden = false; readColors(); if (!started) { started = true; renderCfg(); run(); } else { layoutGrid(); drawTimeline(); drawGantt(); draw(); } },
    hide() { root.hidden = true; setPlaying(false); },
    state: CS
  };
})();
