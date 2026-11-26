/* global FleetScenario */ // set by scenario.js, loaded first on the page
/* FleetScope Inference view: serving deployments as pods — replicas wanted vs ready, start-up time,
   and contention with training and batch work for GPUs. Browser only. */
(function () {
  'use strict';
  const C = window.FleetCluster, E = window.FleetEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fInt = v => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
  const fPct = v => (isFinite(v) ? Math.round(v * 100) + '%' : '–');
  const fS = v => (!isFinite(v) ? '–' : v >= 3600 ? (v / 3600).toFixed(1) + ' h' : v >= 90 ? (v / 60).toFixed(1) + ' min' : Math.round(v) + ' s');
  const hm = s => { const m = Math.floor(s / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const SOURCES = { nvme: ['Local NVMe cache', 5], pfs: ['Parallel file system', 2], object: ['Object store', 0.5], hub: ['Model hub over the internet', 0.15] };
  const IS = { scenario: 'cluster', imageGB: 12, registryGBs: 2, source: 'object', warmupS: 90, models: {}, k: 0, playing: false, speed: 4, run: null, ready: [] };
  let col = {};
  function readColors() {
    const st = getComputedStyle(document.documentElement), g = v => st.getPropertyValue(v).trim();
    col = { inference: g('--onprem'), training: g('--train'), batch: g('--n-route'), free: g('--line'), faulted: g('--crit'), crit: g('--crit'), warn: g('--warn'), ink: g('--ink'), muted: g('--muted'), panel: g('--panel'), good: g('--good'), running: g('--neo') };
  }

  const root = $('#inferenceApp');
  root.innerHTML = `
  <header class="toolbar">
    <div class="tb"><select id="iScen" aria-label="Scenario"><option value="cluster">Cluster as in the Cluster tab</option><option value="below">Pre-training outranks serving</option><option value="binpack">Cluster tab, with bin-pack placement</option></select></div>
    <div class="tb"><button type="button" id="iPlay" class="play">&#9654; Play</button>
      <select id="iSpeed" aria-label="Playback speed"><option value="1">1 tick</option><option value="4" selected>4 ticks</option><option value="16">16 ticks</option></select>
      <span class="clock" id="iClock">0:00 / 8:00</span></div>
    <div class="status" id="iStatus"></div>
  </header>
  <aside class="palette cfg" id="iCfg"></aside>
  <section class="center">
    <div class="chead" id="iHead"></div>
    <div class="kpis" id="iKpis"></div>
    <div class="gridWrap"><div class="sec2">GPUs by workload kind <span class="sub">who holds the cluster's GPUs over time</span></div><canvas id="iMix"></canvas><div class="glegend" id="iMixLegend"></div></div>
    <div id="iDeps"></div>
    <div class="timeline"><input type="range" id="iScrub" min="0" max="2879" step="1" value="0" aria-label="Playhead"></div>
  </section>
  <aside class="details" id="iSide" aria-live="polite"></aside>`;

  function deps() { return IS.run ? IS.run.spec.workloads.map((w, i) => ({ w, i })).filter(x => x.w.kind === 'inference') : []; }
  function weightsGB(name) { const m = E.MODELS[IS.models[name] || guessModel(name)]; return m ? m.params : 70; }
  function guessModel(name) { return /coder|agent|code/i.test(name) ? 'coder-32b' : /405/.test(name) ? 'llama-405b' : /8b|small|embed/i.test(name) ? 'llama-8b' : 'llama-70b'; }
  function startup(name) {
    const img = IS.imageGB / IS.registryGBs, wt = weightsGB(name) / SOURCES[IS.source][1];
    return { img, wt, warm: IS.warmupS, total: img + wt + IS.warmupS };
  }

  function renderCfg() {
    const D = deps();
    const num = (id, v, lo, hi, st) => '<input type="number" data-k="' + id + '" value="' + v + '" min="' + lo + '" max="' + hi + '" step="' + st + '">';
    $('#iCfg').innerHTML = '<h3>Replica start-up</h3>' +
      '<label class="frow"><span>Image size (GB)</span>' + num('imageGB', IS.imageGB, 0.1, 200, 0.5) + '</label>' +
      '<label class="frow"><span>Registry GB/s</span>' + num('registryGBs', IS.registryGBs, 0.05, 100, 0.05) + '</label>' +
      '<label class="frow"><span>Weights from</span><select data-k="source">' + Object.entries(SOURCES).map(([k, [l, b]]) => '<option value="' + k + '"' + (k === IS.source ? ' selected' : '') + '>' + l + ' (' + b + ' GB/s)</option>').join('') + '</select></label>' +
      '<label class="frow" title="CUDA graph capture, compile, health checks before the replica takes traffic"><span>Warm-up (s)</span>' + num('warmupS', IS.warmupS, 0, 3600, 5) + '</label>' +
      '<h3>Models served</h3>' + D.map(({ w }) => '<label class="frow"><span>' + esc(w.name) + '</span><select data-model="' + esc(w.name) + '">' + Object.keys(E.MODELS).map(k => '<option value="' + k + '"' + (k === (IS.models[w.name] || guessModel(w.name)) ? ' selected' : '') + '>' + esc(E.MODELS[k].label) + '</option>').join('') + '</select></label>').join('') +
      '<div class="note">Weights are assumed FP8 (1 byte per parameter). Replica counts, priorities and GPUs per pod come from the cluster; edit them in the Cluster tab.</div>';
  }
  $('#iCfg').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.model) IS.models[t.dataset.model] = t.value;
    else if (t.dataset.k) IS[t.dataset.k] = t.tagName === 'SELECT' ? t.value : +t.value;
    analyse();
  });
  $('#iScen').addEventListener('change', e => { IS.scenario = e.target.value; run(); });

  function clusterSpec() {
    const cv = window.FleetClusterView && window.FleetClusterView.state;
    const sp = JSON.parse(JSON.stringify(cv && cv.spec ? cv.spec : C.sampleCluster()));
    if (IS.scenario === 'binpack') sp.policy = Object.assign({}, sp.policy, { placement: 'binpack' });
    if (IS.scenario === 'below') {
      const infQ = new Set(sp.workloads.filter(w => w.kind === 'inference').map(w => w.queue));
      const trQ = new Set(sp.workloads.filter(w => w.kind === 'training').map(w => w.queue));
      const top = Math.max(0, ...sp.queues.filter(q => trQ.has(q.id)).map(q => q.priority || 0));
      for (const q of sp.queues) if (infQ.has(q.id) && !trQ.has(q.id)) q.priority = top - 5;
      for (const w of sp.workloads) if (w.kind === 'inference') w.priority = null;
    }
    return sp;
  }
  function run() {
    const t0 = performance.now();
    IS.run = C.simulateCluster(clusterSpec());
    IS.k = clamp(IS.k, 0, IS.run.T - 1);
    $('#iScrub').max = IS.run.T - 1;
    $('#iStatus').innerHTML = '<b>' + deps().length + '</b> serving deployments on <b>' + fInt(IS.run.G) + '</b> GPUs · ' + IS.run.spec.horizonH + ' h in ' + Math.round(performance.now() - t0) + ' ms';
    renderCfg(); analyse();
  }
  function analyse() {
    const R = IS.run;
    IS.ready = deps().map(({ w, i }) => { const su = startup(w.name); return { w, i, su, x: C.inferenceReadiness(R, i, su.total) }; });
    renderKpis(); renderHead(); drawMix(); renderDeps(); draw();
  }

  function renderKpis() {
    const A = IS.ready, R = IS.run;
    const tile = (k, v, cls) => '<div class="kpi ' + (cls || '') + '"><div class="k" title="' + k + '">' + k + '</div><div class="v">' + v + '</div><div class="d"></div></div>';
    const def = A.reduce((a, d) => a + d.x.deficitReplicaH, 0), full = A.length ? Math.min(...A.map(d => d.x.fullShare)) : NaN;
    const worst = A.slice().sort((a, b) => b.x.worstShare - a.x.worstShare)[0];
    const pre = A.reduce((a, d) => a + R.workloads[d.i].preempts, 0);
    const peakTrain = Math.max(...R.gpusByKind.training), peakInf = Math.max(...R.gpusByKind.inference);
    $('#iKpis').innerHTML = [
      tile('Replica-hours short', def.toFixed(1), def > 2 ? 'crit' : def > 0.5 ? 'warn' : 'good'),
      tile('Time at full strength (worst)', fPct(full), full < 0.95 ? 'crit' : 'good'),
      tile('Deepest shortfall', worst ? fPct(worst.x.worstShare) : '–', worst && worst.x.worstShare > 0.25 ? 'crit' : ''),
      tile('Replica start-up', A.length ? fS(A[0].su.total) : '–', A.length && A[0].su.total > 300 ? 'warn' : ''),
      tile('Scheduling wait p90', A.length ? fS(Math.max(...A.map(d => d.x.schedWaitP90))) : '–', ''),
      tile('Serving pods preempted', fInt(pre), pre ? 'crit' : 'good'),
      tile('Peak GPUs: serving / training', fInt(peakInf) + ' / ' + fInt(peakTrain), '')
    ].join('');
  }
  function renderHead() {
    const A = IS.ready, R = IS.run;
    if (!A.length) { $('#iHead').innerHTML = 'No inference deployments in this cluster. Add one in the Cluster tab.'; return; }
    const worst = A.slice().sort((a, b) => b.x.deficitReplicaH - a.x.deficitReplicaH)[0], w = R.workloads[worst.i];
    const parts = [];
    if (w.preempts) {
      const ev = R.events.find(e => e.wl === worst.i && e.kind === 'preempt');
      const by = ev ? ev.detail.replace('pod preempted by ', '') : 'higher-priority work';
      parts.push('<b>' + esc(worst.w.name) + '</b> lost ' + w.preempts + ' replicas to <b>' + esc(by) + '</b>' + (ev ? ' at ' + hm(ev.t) : '') + ' and ran ' + fPct(worst.x.worstShare) + ' short at worst');
    } else if (worst.x.deficitReplicaH > 0.05) parts.push('<b>' + esc(worst.w.name) + '</b> ran short by ' + worst.x.deficitReplicaH.toFixed(1) + ' replica-hours, mostly while new replicas started');
    else parts.push('Every deployment kept up with its replica target');
    const su = worst.su;
    const big = [['loading weights from ' + SOURCES[IS.source][0].toLowerCase(), su.wt], ['pulling the image', su.img], ['warming up', su.warm]].sort((a, b) => b[1] - a[1])[0];
    parts.push('a new replica takes <b>' + fS(su.total) + '</b> to serve, most of it ' + big[0] + ' (' + fS(big[1]) + ')' + (worst.x.schedWaitP90 > 30 ? ', after waiting up to ' + fS(worst.x.schedWaitP90) + ' to be scheduled' : ''));
    $('#iHead').innerHTML = parts.join('; ') + '.' + (IS.source !== 'nvme' && su.wt > 60 ? ' Caching weights on local NVMe would cut start-up to ' + fS(su.img + weightsGB(worst.w.name) / SOURCES.nvme[1] + su.warm) + '.' : '');
  }

  // ---------- charts ----------
  function sizeCanvas(cv, h) { const W = cv.parentNode.clientWidth - 18, dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = h * dpr; cv.style.width = W + 'px'; cv.style.height = h + 'px'; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, W }; }
  const imgs = {};
  function axis(ctx, R, X, H) { ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily; for (let h = 0; h <= R.spec.horizonH; h += Math.max(1, Math.round(R.spec.horizonH / 8))) ctx.fillText(h + 'h', X(h * 3600 / R.step) - 6, H - 2); }
  function drawMix() {
    const R = IS.run, cv = $('#iMix'), H = 120, { ctx, W } = sizeCanvas(cv, H), L = 40, X = k => L + (W - L - 6) * k / (R.T - 1), Y = v => 4 + (H - 18) * (1 - v / R.G);
    ctx.clearRect(0, 0, W, H);
    const S = R.gpusByKind, layers = [['inference', S.inference], ['training', S.training], ['batch', S.batch], ['faulted', R.series.faulted]];
    const base = new Float32Array(R.T);
    for (const [k, a] of layers) {
      ctx.beginPath();
      for (let i = 0; i < R.T; i++) ctx.lineTo(X(i), Y(base[i] + a[i]));
      for (let i = R.T - 1; i >= 0; i--) ctx.lineTo(X(i), Y(base[i]));
      ctx.closePath(); ctx.fillStyle = col[k]; ctx.globalAlpha = 0.8; ctx.fill(); ctx.globalAlpha = 1;
      for (let i = 0; i < R.T; i++) base[i] += a[i];
    }
    ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily; ctx.fillText(R.G + ' GPUs', 0, 12);
    axis(ctx, R, X, H);
    imgs.iMix = { img: ctx.getImageData(0, 0, cv.width, cv.height), X };
    $('#iMixLegend').innerHTML = ['inference', 'training', 'batch', 'faulted'].map(k => '<span><i style="background:' + col[k] + '"></i>' + k + '</span>').join('') + '<span><i class="empty"></i>free</span>';
  }
  function renderDeps() {
    $('#iDeps').innerHTML = IS.ready.map((d, j) => {
      const su = d.su, tot = su.total || 1, R = IS.run, w = R.workloads[d.i];
      return '<div class="gridWrap"><div class="sec2">' + esc(d.w.name) + ' <span class="sub">' + d.w.gpusPerPod + ' GPUs per replica · ' + esc((E.MODELS[IS.models[d.w.name] || guessModel(d.w.name)] || {}).label || '') + ' · short ' + d.x.deficitReplicaH.toFixed(1) + ' replica-hours · at full strength ' + fPct(d.x.fullShare) + ' of the time' + (w.preempts ? ' · ' + w.preempts + ' preempted' : '') + '</span></div>' +
        '<canvas id="iDep' + j + '"></canvas><div class="glegend"><span><i style="background:' + col.ink + ';height:2px"></i>target replicas</span><span><i style="background:' + col.good + '"></i>ready</span><span><i style="background:' + col.running + '"></i>starting (scheduled, loading)</span><span><i style="background:' + col.crit + '"></i>short of target</span></div>' +
        '<div class="sec2" style="margin-top:6px">New replica: ' + fS(su.total + (d.x.schedWaitP50 || 0)) + ' to serve</div><div class="wbar">' +
        [['scheduling wait (p50)', d.x.schedWaitP50 || 0, col.warn], ['image pull', su.img, col.batch], ['weight load', su.wt, col.inference], ['warm-up', su.warm, col.training]].filter(x => x[1] > 0).map(([l, v, c]) => '<i style="width:' + (100 * v / (tot + (d.x.schedWaitP50 || 0))).toFixed(1) + '%;background:' + c + '" title="' + l + ' ' + fS(v) + '"></i>').join('') + '</div>' +
        '<div class="glegend">' + [['scheduling wait (p50)', d.x.schedWaitP50 || 0, col.warn], ['image pull', su.img, col.batch], ['weight load', su.wt, col.inference], ['warm-up', su.warm, col.training]].map(([l, v, c]) => '<span><i style="background:' + c + '"></i>' + l + ' ' + fS(v) + '</span>').join('') + '</div></div>';
    }).join('');
    IS.ready.forEach((d, j) => drawDep(d, j));
  }
  function drawDep(d, j) {
    const R = IS.run, cv = $('#iDep' + j), H = 110, { ctx, W } = sizeCanvas(cv, H), L = 40, X = k => L + (W - L - 6) * k / (R.T - 1);
    const mx = Math.max(1, ...d.x.target, ...d.x.running) * 1.1, Y = v => 4 + (H - 18) * (1 - v / mx), dx = (W - L - 6) / (R.T - 1) + 0.6;
    ctx.clearRect(0, 0, W, H);
    for (let k = 0; k < R.T; k++) {
      const t = d.x.target[k], r = d.x.ready[k], run = d.x.running[k];
      if (!t && !run) continue;
      ctx.fillStyle = col.good; ctx.fillRect(X(k), Y(r), dx, Y(0) - Y(r));
      if (run > r) { ctx.fillStyle = col.running; ctx.fillRect(X(k), Y(run), dx, Y(r) - Y(run)); }
      if (t > Math.max(r, run)) { ctx.fillStyle = col.crit; ctx.globalAlpha = 0.6; ctx.fillRect(X(k), Y(t), dx, Y(Math.max(r, run)) - Y(t)); ctx.globalAlpha = 1; }
    }
    ctx.beginPath(); for (let k = 0; k < R.T; k++) ctx.lineTo(X(k), Y(d.x.target[k])); ctx.strokeStyle = col.ink; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = col.muted; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily; ctx.fillText(Math.round(mx / 1.1) + '', 0, 12); ctx.fillText('0', 0, H - 14);
    axis(ctx, R, X, H);
    imgs['iDep' + j] = { img: ctx.getImageData(0, 0, cv.width, cv.height), X };
  }
  function draw() {
    const R = IS.run; if (!R) return;
    $('#iClock').textContent = hm(IS.k * R.step) + ' / ' + hm(R.T * R.step);
    const sc = $('#iScrub'); if (document.activeElement !== sc) sc.value = IS.k;
    for (const id in imgs) {
      const cv = $('#' + id), o = imgs[id]; if (!cv || o.img.width !== cv.width) continue;
      const ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1; ctx.putImageData(o.img, 0, 0);
      const x = o.X(IS.k); ctx.strokeStyle = col.ink; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height / dpr); ctx.stroke();
    }
    renderSide();
  }
  function renderSide() {
    const R = IS.run, k = IS.k, fr = R.frames[k];
    let h = '<h2>At ' + hm(k * R.step) + '</h2><div class="sub">' + fInt(R.gpusByKind.inference[k]) + ' GPUs serving · ' + fInt(R.gpusByKind.training[k]) + ' training · ' + fInt(R.gpusByKind.batch[k]) + ' batch · ' + fInt(R.series.free[k]) + ' free</div>';
    for (const d of IS.ready) {
      const t = d.x.target[k], r = d.x.ready[k], run = d.x.running[k], why = fr.reasons[d.i];
      h += '<h3 class="sec">' + esc(d.w.name) + '</h3>' + [['Target replicas', t], ['Running', run], ['Ready to serve', r]].map(([a, b]) => '<div class="row"><span>' + a + '</span><span>' + fInt(b) + '</span></div>').join('') +
        (t > r ? '<div class="sub" style="color:var(--crit)">' + (t - r) + ' short' + (why ? ': ' + esc(C.REASON[why] || why) : run > r ? ': replicas still starting' : '') + '</div>' : '<div class="sub">At full strength.</div>');
    }
    const near = [];
    for (const e of R.events) {
      if (Math.abs(e.t / R.step - k) > 90 || !IS.ready.some(d => d.i === e.wl) || e.kind === 'scale') continue;
      const l = near[near.length - 1];
      if (l && l.t === e.t && l.wl === e.wl && l.detail === e.detail) l.n++; else near.push(Object.assign({ n: 1 }, e));
    }
    if (near.length) h += '<h3 class="sec">Events around now</h3>' + near.slice(-5).map(e => '<div class="row"><span>' + hm(e.t) + ' ' + esc(R.spec.workloads[e.wl].name) + '</span><span>' + esc(e.detail) + (e.n > 1 ? ' ×' + e.n : '') + '</span></div>').join('');
    $('#iSide').innerHTML = h;
  }
  $('#iScrub').addEventListener('input', e => { IS.k = +e.target.value; draw(); if (window.FleetScenario) FleetScenario.setClock(IS.k * IS.run.step, 'inference'); });
  root.addEventListener('click', e => {
    const cv = e.target.closest('canvas'); if (!cv || !IS.run) return;
    const b = cv.getBoundingClientRect(); IS.k = clamp(Math.round((e.clientX - b.left - 40) / (b.width - 46) * (IS.run.T - 1)), 0, IS.run.T - 1); draw();
  });
  let raf = 0, last = 0;
  function tick(ts) { if (!IS.playing) return; if (ts - last > 33) { last = ts; IS.k += IS.speed; if (IS.k >= IS.run.T - 1) { IS.k = IS.run.T - 1; setPlaying(false); } draw(); } raf = requestAnimationFrame(tick); }
  function setPlaying(on) { IS.playing = on; $('#iPlay').innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Play'; if (on) { if (IS.k >= IS.run.T - 1) IS.k = 0; raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf); }
  $('#iPlay').addEventListener('click', () => setPlaying(!IS.playing));
  $('#iSpeed').addEventListener('change', e => { IS.speed = +e.target.value; });
  window.addEventListener('resize', () => { if (IS.run && !root.hidden) { drawMix(); renderDeps(); draw(); } });

  window.FleetInferenceView = {
    show() { root.hidden = false; readColors(); if (window.FleetScenario) IS.k = Math.round(FleetScenario.clock / C.STEP); run(); },
    startupFor: name => startup(name).total,
    snapshot: () => ({ scenario: IS.scenario, imageGB: IS.imageGB, registryGBs: IS.registryGBs, source: IS.source, warmupS: IS.warmupS, models: IS.models }),
    restore: o => { Object.assign(IS, o); $('#iScen').value = IS.scenario; if (IS.run) run(); },
    hide() { root.hidden = true; setPlaying(false); },
    state: IS
  };
  if (window.FleetScenario) FleetScenario.register('inference', window.FleetInferenceView);
})();
