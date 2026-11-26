/* Inference Sizer, "What fits" view: given GPUs, which models fit and how much load each carries; click a model for
   its capacity. Uses window.SizerCatalog (built-in catalog) and window.SizerFit. Separate from ui.js on purpose. */
(function () {
'use strict';
const C = window.SizerCatalog, F = window.SizerFit, KEY = 'inference-sizer:fit:v1';
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = n => (!isFinite(n) ? '–' : Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 1 : 2));
const fInt = n => (isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };

const st = Object.assign({ gpu: 'H100', nodes: 2, isl: 2000, osl: 400, rate: '', ttft: 2, tpotMs: 50, rank: 'largest', pick: null }, load() || {});
let result = null, timer = null;

function inputsHTML() {
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const num = (k, label, step, min, hint) => `<div class="field"><label for="fit-${k}">${label}</label><input type="number" id="fit-${k}" data-k="${k}" step="${step}" min="${min}" value="${esc(st[k])}"${k === 'rate' ? ' placeholder="any"' : ''}>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  return `<fieldset><legend>Hardware</legend><div class="grid2">
      <div class="field wide"><label for="fit-gpu">GPU</label><select id="fit-gpu" data-k="gpu">${C.GPUS.map(g => opt(g.id, `${g.label} (${g.domain} per node)`, st.gpu)).join('')}</select></div>
      ${num('nodes', 'Nodes', 1, 1)}
      <div class="field"><label>GPUs</label><div class="mono" style="padding:6px 0" id="fit-gpus"></div></div>
    </div></fieldset>
    <fieldset><legend>Traffic</legend><div class="grid2">
      ${num('isl', 'Prompt tokens (median)', 100, 1)}${num('osl', 'Output tokens (median)', 50, 1)}
      <div class="field wide"><label for="fit-rate">Requests per second to carry</label><input type="number" id="fit-rate" data-k="rate" step="1" min="0" placeholder="any: rank by size or throughput" value="${esc(st.rate)}"><span class="hint">Leave empty to see what each model carries at most.</span></div>
    </div></fieldset>
    <fieldset><legend>Latency targets</legend><div class="grid2">${num('ttft', 'Time to first token (s)', 0.1, 0.05)}${num('tpotMs', 'Time per output token (ms)', 5, 1)}</div></fieldset>
    <fieldset><legend>Rank</legend><div class="chips" role="radiogroup" aria-label="Rank models by">
      <button type="button" class="chip${st.rank === 'largest' ? ' on' : ''}" data-rank="largest" role="radio" aria-checked="${st.rank === 'largest'}">Largest that fits</button>
      <button type="button" class="chip${st.rank === 'throughput' ? ' on' : ''}" data-rank="throughput" role="radio" aria-checked="${st.rank === 'throughput'}">Most throughput</button>
    </div><p class="hint" style="font-size:11.5px;color:var(--muted);margin:8px 0 0">Size is a stand-in for capability, not a quality score: compare the top few on your own evals.</p></fieldset>`;
}

function run() {
  const g = C.GPUS.find(x => x.id === st.gpu) || C.GPUS[0];
  $('#fit-gpus').textContent = `${st.nodes} × ${g.domain} = ${st.nodes * g.domain}`;
  const rate = st.rate === '' || st.rate == null ? undefined : +st.rate;
  result = F.fitModels({ gpu: g.id, nodes: +st.nodes }, { isl: +st.isl, osl: +st.osl, rate }, { ttftS: +st.ttft, tpotS: +st.tpotMs / 1000 }, { rank: st.rank });
  result.g = g;
  render();
}

function lay(L) { return !L ? '' : L.mode === 'agg' ? `${L.instances} × ${esc(L.label)}` : `P ${L.prefill.instances}×${esc(L.prefill.label)} · D ${L.decode.instances}×${esc(L.decode.label)}`; }

function render() {
  const r = result, max = Math.max(1e-9, ...r.rows.map(x => x.edge.rate || 0));
  const rows = r.rows.map(x => {
    const p = x.production, fits = p.rate > 0, picked = st.pick === x.model;
    const bar = `<div class="fitbar" aria-hidden="true"><span class="p" style="width:${(100 * (p.rate || 0) / max).toFixed(1)}%"></span><span class="e" style="width:${(100 * Math.max(0, (x.edge.rate || 0) - (p.rate || 0)) / max).toFixed(1)}%"></span></div>`;
    return `<tr class="${fits ? '' : 'nofit'}${picked ? ' picked' : ''}" data-model="${esc(x.model)}" tabindex="0" aria-selected="${picked}">
      <td>${r.need ? (x.meetsRate ? '<span class="ok" title="carries the rate">✓</span> ' : '<span class="no" title="does not carry the rate">·</span> ') : ''}${esc(x.name || x.model)}</td>
      <td class="n">${f1(x.params)}B</td>
      <td class="n">${fits ? f1(p.rate) : '–'}</td><td class="barcell">${fits ? bar : `<span class="why">${esc(p.why || 'does not fit')}</span>`}</td>
      <td class="n">${fits ? fInt(p.outTokensPerS) : '–'}</td><td class="n">${p.dollarsPerMOut ? '$' + p.dollarsPerMOut.toFixed(2) : '–'}</td><td class="mono">${fits ? lay(p.layout) : ''}</td></tr>`;
  }).join('');
  const meets = r.need ? r.rows.filter(x => x.meetsRate).length : null;
  $('#fit-results').innerHTML = `
    <section class="card verdict${r.need && !meets ? ' fail' : ''}">
      <h2>${r.need ? (meets ? `${meets} model${meets > 1 ? 's' : ''} carry ${f1(r.need)} req/s on ${st.nodes} × ${esc(r.g.label)} nodes` : `Nothing in the catalog carries ${f1(r.need)} req/s on ${st.nodes} node${st.nodes > 1 ? 's' : ''}`) : `What fits on ${st.nodes} × ${esc(r.g.label)} node${st.nodes > 1 ? 's' : ''}`}</h2>
      <p class="sub">Requests per second within TTFT ${f1(+st.ttft)} s and TPOT ${fInt(+st.tpotMs)} ms at ${fInt(+st.isl)} prompt / ${fInt(+st.osl)} output tokens. <b>Production</b> keeps 15% headroom, an N+1 spare node and 10% inside the targets; the lighter bar is the flat-out figure with none of that. Spec-sheet efficiencies, built-in catalog.</p>
      <div class="tablewrap"><table class="fittable"><thead><tr><th>Model</th><th class="n">Params</th><th class="n">Req/s</th><th><span class="lg p"></span>production <span class="lg e"></span>flat out</th><th class="n">Output tok/s</th><th class="n">$ / 1M out</th><th>Layout</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    <section class="card" id="fit-detail">${detailHTML()}</section>`;
}

function detailHTML() {
  if (!st.pick) return `<h2>Capacity of one model</h2><p class="sub">Click a model for the most it carries, its concurrency and the longest prompt that still meets the target.</p>`;
  const c = F.capacity(st.pick, { gpu: st.gpu, nodes: +st.nodes }, { isl: +st.isl, osl: +st.osl }, { ttftS: +st.ttft, tpotS: +st.tpotMs / 1000 }, {});
  const p = c.production, L = p.layout;
  if (!p.rate) return `<h2>${esc(c.name)}</h2><p class="sub">Doesn't fit: ${esc(p.why)}${c.edge.rate ? ` (flat out, with no headroom or spare, it would carry ${f1(c.edge.rate)} req/s)` : ''}.</p>`;
  const cmd = `fleetops serving deploy --model ${c.model} --gpu ${st.gpu} --nodes ${st.nodes} --isl ${st.isl} --osl ${st.osl} --ttft ${st.ttft} --tpot ${(+st.tpotMs / 1000)}${L.mode === 'disagg' ? ' --mode disagg' : ''}`;
  const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  return `<h2>${esc(c.name)} on ${c.gpus} × ${esc(st.gpu)}</h2>
    <div class="kvgrid">
      ${kv('Max load (production)', `${f1(p.rate)} req/s`)}${kv('Flat out', `${f1(c.edge.rate)} req/s`)}${kv('Output tokens/s', fInt(p.outTokensPerS))}
      ${kv('Concurrency', `${fInt(L.concurrency)} sequences`)}${kv('Layout', lay(L) + (L.mode === 'agg' ? ` (${L.gpusPerInstance} GPU${L.gpusPerInstance > 1 ? 's' : ''} each)` : ''))}${kv('Nodes with the spare', p.nodes)}
      ${kv('Longest prompt', c.maxPrompt ? `${fInt(c.maxPrompt)} tokens` : 'none fits')}${kv('Model maximum', `${fInt(c.modelMaxCtx)} tokens`)}${kv('$ per 1M output tokens', p.dollarsPerMOut ? '$' + p.dollarsPerMOut.toFixed(2) : '–')}
    </div>
    <p class="sub" style="margin-top:12px">${esc(p.reason || '')}</p>
    <div class="cmdrow"><code id="fit-cmd">${esc(cmd)}</code><button type="button" id="fit-copy">Copy</button></div>
    <p class="sub">Deploy it on Kubernetes with fleetops (a dry run until <code>--apply</code>), then load-test the endpoint before production traffic: these are estimates.</p>`;
}

function schedule() { clearTimeout(timer); timer = setTimeout(() => { save(st); run(); }, 120); }
function onInput(e) { const k = e.target.dataset.k; if (!k) return; st[k] = e.target.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value; schedule(); }
function pick(m) { st.pick = st.pick === m ? null : m; save(st); render(); const d = document.getElementById('fit-detail'); if (st.pick && d) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

function show(view) {
  const fit = view === 'fit';
  $('.layout').hidden = fit; $('#fitview').hidden = !fit; $('#spec').hidden = fit;
  for (const b of document.querySelectorAll('[data-view]')) { const on = b.dataset.view === view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  try { localStorage.setItem(KEY + ':view', view); } catch (e) {}
  if (fit && !result) run();
}

function init() {
  const host = document.getElementById('fitview'); if (!host || !F) return;
  $('#fit-inputs').innerHTML = inputsHTML();
  $('#fit-inputs').addEventListener('input', onInput);
  $('#fit-inputs').addEventListener('click', e => { const b = e.target.closest('[data-rank]'); if (!b) return; st.rank = b.dataset.rank; for (const x of document.querySelectorAll('[data-rank]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); } schedule(); });
  $('#fit-results').addEventListener('click', e => {
    if (e.target.id === 'fit-copy') { navigator.clipboard && navigator.clipboard.writeText($('#fit-cmd').textContent); e.target.textContent = 'Copied'; return; }
    const tr = e.target.closest('tr[data-model]'); if (tr) pick(tr.dataset.model);
  });
  $('#fit-results').addEventListener('keydown', e => { const tr = e.target.closest('tr[data-model]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(tr.dataset.model); } });
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => show(b.dataset.view));
  let v = 'size'; try { v = localStorage.getItem(KEY + ':view') || 'size'; } catch (e) {}
  if (location.hash === '#fit') v = 'fit';
  show(v);
}
init();
})();
