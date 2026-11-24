/* Inference Sizer page: inputs, catalog management, results. Uses window.SizerCatalog, SizerModel, SizerFleetScope. */
(function () {
'use strict';
const C = window.SizerCatalog, M = window.SizerModel, X = window.SizerFleetScope;
const STORE = 'inference-sizer:state:v1', CAT = 'inference-sizer:catalog:v1';
const EDITED = '__edited';
const $ = (sel, el) => (el || document).querySelector(sel);
const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// ---------- formatting ----------
const fInt = n => isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
const f1 = n => isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)) : '–';
const fMs = t => isFinite(t) ? (t * 1000 >= 100 ? Math.round(t * 1000).toLocaleString('en-US') : (t * 1000).toFixed(1)) + ' ms' : '–';
const fTok = n => !isFinite(n) ? '–' : n >= 1e12 ? (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : fInt(n);
const fGB = b => !isFinite(b) ? '–' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(0) + ' MB' : (b / 1e3).toFixed(0) + ' KB';
const fCtx = n => n >= 1048576 && n % 1048576 === 0 ? (n / 1048576) + 'M' : n >= 1024 ? Math.round(n / 1024) + 'K' : String(n);
const fUSD = n => !isFinite(n) ? '–' : n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2);
const pct = n => isFinite(n) ? Math.round(n * 100) + '%' : '–';

// ---------- catalog ----------
let userCat = load(CAT);
if (!userCat || !Array.isArray(userCat.gpus) || !Array.isArray(userCat.models)) userCat = { gpus: [], models: [] };
let gpus, models;
function refreshCatalog() { gpus = C.merge(C.GPUS, userCat.gpus); models = C.merge(C.MODELS, userCat.models); save(CAT, userCat); }
refreshCatalog();
const MODEL_KEYS = C.MODEL_FIELDS.map(f => f.k).filter(k => !['name', 'source', 'wprec'].includes(k));
const GPU_KEYS = C.GPU_FIELDS.map(f => f.k).filter(k => !['label', 'vendor', 'source', 'price'].includes(k));
function modelValues(m) { const o = {}; MODEL_KEYS.forEach(k => o[k] = m[k] != null ? m[k] : C.MODEL_DEFAULTS[k]); o.wprec = m.wprec || 'fp8'; o.modelLabel = m.name; return o; }
function gpuValues(g) { const o = {}; GPU_KEYS.forEach(k => o[k] = g[k] != null ? g[k] : (C.GPU_DEFAULTS[k] || 0)); o.price = g.price || 0; o.gpuLabel = g.label; return o; }
function defaults() {
  const m = models.find(x => x.id === 'llama33-70b') || models[0], g = gpus.find(x => x.id === 'B200') || gpus[0];
  return Object.assign({}, M.SETTINGS, modelValues(m), gpuValues(g), { model: m.id, gpu: g.id });
}
let state = defaults();
(() => {
  const saved = load(STORE);
  if (saved && typeof saved === 'object') Object.keys(state).forEach(k => { if (k in saved) state[k] = saved[k]; });
  if (state.model !== EDITED && !models.find(m => m.id === state.model)) Object.assign(state, modelValues(models[0]), { model: models[0].id });
  if (state.gpu !== EDITED && !gpus.find(g => g.id === state.gpu)) Object.assign(state, gpuValues(gpus[0]), { gpu: gpus[0].id });
})();

// ---------- input schema ----------
const PCT = new Set(['memUtil', 'effPrefill', 'effDecodeBW', 'effDecodeComp', 'kvMaxUtil', 'swaFrac']);
const archFields = C.MODEL_FIELDS.filter(f => MODEL_KEYS.includes(f.k)).map(f => Object.assign({}, f, f.k === 'swaFrac' ? { unit: '%', max: 100 } : {}, f.k === 'attn' ? { type: 'sel', opts: [['gqa', 'GQA / MHA'], ['mla', 'MLA (DeepSeek-style)']] } : {}, /^mla/.test(f.k) ? { mlaOnly: true } : {}));
const gpuFields = C.GPU_FIELDS.filter(f => GPU_KEYS.includes(f.k)).map(f => Object.assign({}, f));
const GROUPS = [
  { title: 'Model', id: 'model', fields: [
    { k: 'model', label: 'Model to serve', type: 'sel', opts: () => catOpts(models, 'name', 'Your models'), wide: true },
    { k: 'wprec', label: 'Weight precision', type: 'sel', opts: [['bf16', 'BF16'], ['fp8', 'FP8'], ['fp4', 'FP4 (NVFP4 / MXFP4)']] },
    { k: 'kvprec', label: 'KV cache precision', type: 'sel', opts: [['bf16', 'BF16'], ['fp8', 'FP8']] },
    { k: 'ctx', label: 'Context window (max tokens per request)', unit: 'tokens', step: 1024, min: 1024, wide: true, chips: [8192, 32768, 65536, 131072, 262144] },
  ], sub: { title: 'Architecture: edit, or save as a new model', fields: archFields, saver: 'model' } },
  { title: 'GPU', id: 'gpu', fields: [
    { k: 'gpu', label: 'GPU', type: 'sel', opts: () => catOpts(gpus, 'label', 'Your GPUs'), wide: true },
  ], sub: { title: 'Spec sheet: edit, or save as a new GPU', fields: gpuFields, saver: 'gpu' } },
  { title: 'Traffic', fields: [
    { k: 'conc', label: 'Concurrent sessions (peak)', step: 10, min: 0 },
    { k: 'dau', label: 'Daily active users', step: 1000, min: 0 },
    { k: 'rpu', label: 'Requests per user per day', step: 1, min: 0 },
    { k: 'peakFactor', label: 'Peak-to-average traffic', unit: '×', step: 0.5, min: 1 },
    { k: 'concSource', label: 'Size for', type: 'sel', wide: true, opts: [['max', 'Whichever is larger: sessions or DAU'], ['conc', 'Concurrent sessions only'], ['dau', 'DAU traffic only']] },
  ] },
  { title: 'Tokens per request', fields: [
    { k: 'avgIn', label: 'Avg input', unit: 'tokens', step: 100, min: 1 },
    { k: 'peakIn', label: 'Peak input', unit: 'tokens', step: 1000, min: 1 },
    { k: 'avgOut', label: 'Avg output', unit: 'tokens', step: 50, min: 1 },
    { k: 'peakOut', label: 'Peak output', unit: 'tokens', step: 500, min: 1 },
    { k: 'prefixHit', label: 'Prefix-cache hit rate', unit: '%', step: 5, min: 0, max: 95, wide: true },
  ] },
  { title: 'Latency targets', fields: [
    { k: 'ttft', label: 'TTFT', unit: 'ms', step: 50, min: 50 },
    { k: 'tpot', label: 'TPOT', unit: 'ms', step: 1, min: 2 },
  ] },
  { title: 'Serving', fields: [
    { k: 'mode', label: 'Serving architecture', type: 'sel', wide: true, opts: [['auto', 'Pick the cheaper option'], ['disagg', 'Disaggregated prefill / decode'], ['agg', 'Aggregated (chunked prefill)']] },
    { k: 'kvPolicy', label: 'KV cache allocation', type: 'sel', wide: true, opts: [['paged', 'Paged: actual tokens per request'], ['reserve', 'Reserve the full context window per session']] },
    { k: 'headroom', label: 'Capacity headroom', unit: '%', step: 5, min: 0 },
    { k: 'price', label: 'GPU price', unit: '$/hr', step: 0.25, min: 0 },
    { k: 'nPlus1', label: 'Keep room for one spare instance (N+1)', type: 'chk', wide: true },
  ], sub: { title: 'Engine assumptions', fields: [
    { k: 'memUtil', label: 'HBM usable by engine', unit: '%', step: 1, min: 50, max: 99 },
    { k: 'reserveGB', label: 'Runtime reserve / GPU', unit: 'GB', step: 1, min: 0 },
    { k: 'kvMaxUtil', label: 'KV cache fill limit', unit: '%', step: 5, min: 50, max: 100 },
    { k: 'sloMargin', label: 'Latency safety margin', unit: '%', step: 5, min: 0, max: 50 },
    { k: 'effPrefill', label: 'Prefill MFU', unit: '%', step: 5, min: 5, max: 90 },
    { k: 'effDecodeBW', label: 'Decode HBM efficiency', unit: '%', step: 5, min: 10, max: 95 },
    { k: 'effDecodeComp', label: 'Decode MFU', unit: '%', step: 5, min: 5, max: 90 },
    { k: 'stepMs', label: 'Per-step overhead', unit: 'ms', step: 0.5, min: 0 },
    { k: 'maxSeqPerGPU', label: 'Max sequences / GPU', step: 16, min: 1, wide: true },
  ] } },
];
const FIELDS = {};
GROUPS.forEach(g => { g.fields.forEach(f => FIELDS[f.k] = f); if (g.sub) g.sub.fields.forEach(f => FIELDS[f.k] = f); });

function catOpts(list, nameKey, userTitle) {
  const b = list.filter(x => !x.custom || x.overrides), u = list.filter(x => x.custom && !x.overrides);
  return { groups: [['Built in', b.map(x => [x.id, x[nameKey] + (x.overrides ? ' (your values)' : '')])]].concat(u.length ? [[userTitle, u.map(x => [x.id, x[nameKey]])]] : []), extra: [[EDITED, 'Edited (not saved)']] };
}

function fieldHTML(f) {
  const id = 'in-' + f.k, type = f.type === 'sel' || f.type === 'enum' ? 'sel' : f.type || 'num';
  let ctl;
  if (type === 'sel') ctl = `<select id="${id}" data-k="${f.k}"></select>`;
  else if (type === 'chk') return `<div class="field chk ${f.wide ? 'wide' : ''}"><input type="checkbox" id="${id}" data-k="${f.k}"><label for="${id}">${esc(f.label)}</label></div>`;
  else {
    const inp = `<input type="number" id="${id}" data-k="${f.k}" step="${f.step || (f.int ? 1 : 'any')}"${f.min != null ? ` min="${PCT.has(f.k) && f.k !== 'swaFrac' ? f.min : f.k === 'swaFrac' ? 0 : f.min}"` : ''}${f.max != null ? ` max="${f.k === 'swaFrac' ? 100 : f.max}"` : ''} inputmode="decimal">`;
    ctl = f.unit ? `<div class="unitwrap">${inp}<span class="u">${esc(f.unit)}</span></div>` : inp;
  }
  const chips = f.chips ? `<div class="chips" id="chips-${f.k}"></div>` : '';
  return `<div class="field ${f.wide ? 'wide' : ''} ${f.mlaOnly ? 'mla-only' : ''}" id="f-${f.k}"><label for="${id}">${esc(f.label)}</label>${ctl}${chips}<div class="hint" id="hint-${f.k}"></div></div>`;
}
function saverHTML(kind) {
  const what = kind === 'model' ? 'model' : 'GPU';
  return `<div class="saver"><label for="save-${kind}-name">Save these values as</label>
    <div class="saverow"><input type="text" id="save-${kind}-name" placeholder="${kind === 'model' ? 'e.g. Our fine-tuned 70B' : 'e.g. B200 (our measured)'}">
    <button type="button" data-act="save-${kind}">Save ${what}</button></div>
    <div class="saverow"><button type="button" data-act="del-${kind}" id="del-${kind}" hidden>Remove from my ${what}s</button><span class="x" id="src-${kind}"></span></div>
    <div class="msg" id="msg-${kind}" role="status"></div></div>`;
}
function buildInputs() {
  const el = $('#inputs');
  el.innerHTML = GROUPS.map((g, i) => `<fieldset><legend><span class="idx">0${i + 1}</span>${esc(g.title)}</legend>
    <div class="grid2">${g.fields.map(fieldHTML).join('')}</div>
    ${g.sub ? `<details class="sub" id="sub-${g.id || i}"><summary>${esc(g.sub.title)}</summary><div class="grid2">${g.sub.fields.map(fieldHTML).join('')}</div>${g.sub.saver ? saverHTML(g.sub.saver) : ''}</details>` : ''}
  </fieldset>`).join('') + `<fieldset><legend><span class="idx">0${GROUPS.length + 1}</span>Add models and GPUs</legend>
    <p class="note">Import a Hugging Face <code>config.json</code> to add a model, or a spec sheet (JSON) to add or update GPUs and models. Saved entries stay in this browser.</p>
    <div class="btnrow"><button type="button" data-act="import-file">Import file…</button><button type="button" data-act="paste">Paste JSON…</button>
      <input type="file" id="importFile" accept=".json,application/json" hidden></div>
    <div id="pastebox" hidden><label for="pasteText" class="lbl">Spec sheet, model or GPU entry, or config.json</label><textarea id="pasteText" rows="7" spellcheck="false"></textarea>
      <div class="btnrow"><button type="button" class="primary" data-act="import-paste">Import</button><button type="button" data-act="paste-close">Cancel</button></div></div>
    <div class="msg" id="msg-import" role="status"></div>
    <div class="btnrow" style="margin-top:8px"><button type="button" data-act="export-cat">Export my catalog</button><button type="button" data-act="template">Spec-sheet template</button></div>
    <p class="x" id="catcount"></p>
  </fieldset>
  <div class="btnrow"><button type="button" data-act="reset">Reset inputs to the example</button></div>`;
  el.addEventListener('input', onInput);
  el.addEventListener('change', onInput);
  el.addEventListener('click', onClick);
  $('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { importText(String(rd.result), f.name); e.target.value = ''; }; rd.readAsText(f); });
  for (const k of Object.keys(FIELDS)) if (FIELDS[k].type === 'sel' || FIELDS[k].type === 'enum') fillSelect(k);
}
function fillSelect(k) {
  const f = FIELDS[k], el = document.getElementById('in-' + k); if (!el) return;
  const o = typeof f.opts === 'function' ? f.opts() : f.opts.map(x => Array.isArray(x) ? x : [x, x.toUpperCase()]);
  if (Array.isArray(o)) el.innerHTML = o.map(x => `<option value="${esc(x[0])}">${esc(x[1])}</option>`).join('');
  else el.innerHTML = o.groups.map(g => `<optgroup label="${esc(g[0])}">${g[1].map(x => `<option value="${esc(x[0])}">${esc(x[1])}</option>`).join('')}</optgroup>`).join('') + (state[k] === EDITED ? o.extra.map(x => `<option value="${x[0]}">${esc(x[1])}</option>`).join('') : '');
}
function syncInputs() {
  fillSelect('model'); fillSelect('gpu');
  Object.values(FIELDS).forEach(f => {
    const el = document.getElementById('in-' + f.k); if (!el) return;
    if (f.type === 'chk') el.checked = !!state[f.k];
    else if (f.type === 'sel' || f.type === 'enum') el.value = state[f.k];
    else el.value = PCT.has(f.k) ? +(state[f.k] * 100).toFixed(2) : state[f.k];
  });
  document.querySelectorAll('.mla-only').forEach(n => n.hidden = state.attn !== 'mla');
  const mc = models.find(m => m.id === state.model), gc = gpus.find(g => g.id === state.gpu);
  $('#save-model-name').value = mc ? mc.name : (state.modelLabel || '');
  $('#save-gpu-name').value = gc ? gc.label : (state.gpuLabel || '');
  $('#del-model').hidden = !(mc && mc.custom); $('#del-gpu').hidden = !(gc && gc.custom);
  $('#src-model').innerHTML = mc && mc.source ? `<a href="${esc(mc.source)}" target="_blank" rel="noopener">Model card</a>` : '';
  $('#src-gpu').innerHTML = gc && gc.source ? `<a href="${esc(gc.source)}" target="_blank" rel="noopener">Spec sheet</a>` : '';
  $('#catcount').textContent = `${models.length} models and ${gpus.length} GPUs available` + (userCat.models.length + userCat.gpus.length ? `, ${userCat.models.length + userCat.gpus.length} of them yours.` : '.');
}
function onInput(e) {
  const el = e.target, k = el.dataset && el.dataset.k; if (!k || !FIELDS[k]) return;
  const f = FIELDS[k];
  if (f.type === 'chk') state[k] = el.checked;
  else if (f.type === 'sel' || f.type === 'enum') {
    state[k] = el.value;
    if (k === 'model' && el.value !== EDITED) { const m = models.find(x => x.id === el.value); Object.assign(state, modelValues(m)); if (state.ctx > m.maxCtx) state.ctx = m.maxCtx; }
    if (k === 'gpu' && el.value !== EDITED) Object.assign(state, gpuValues(gpus.find(x => x.id === el.value)));
    if (k === 'attn') markEdited('model');
    if (k === 'model' || k === 'gpu') { const m = document.getElementById('msg-' + k); if (m) m.textContent = ''; }
    syncInputs();
  } else {
    if (el.value === '' || !isFinite(+el.value)) return;
    let v = +el.value;
    if (PCT.has(k)) v = v / 100;
    state[k] = v;
    if (MODEL_KEYS.includes(k)) markEdited('model');
    if (GPU_KEYS.includes(k)) markEdited('gpu');
  }
  if (e.type === 'input' && f.type !== 'sel' && f.type !== 'chk') { clearTimeout(onInput.t); onInput.t = setTimeout(update, 120); }
  else update();
}
function markEdited(kind) {
  if (state[kind] === EDITED) return;
  const cur = kind === 'model' ? models.find(m => m.id === state.model) : gpus.find(g => g.id === state.gpu);
  if (kind === 'model') state.modelLabel = cur ? cur.name + ' (edited)' : state.modelLabel; else state.gpuLabel = cur ? cur.label + ' (edited)' : state.gpuLabel;
  state[kind] = EDITED; fillSelect(kind); document.getElementById('in-' + kind).value = EDITED;
}
function msg(id, text, bad) { const m = document.getElementById('msg-' + id); m.innerHTML = text; m.className = 'msg' + (bad ? ' bad' : ' good'); }

function onClick(e) {
  const chip = e.target.closest('.chip');
  if (chip) { state.ctx = +chip.dataset.v; syncInputs(); update(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'save-model' || act === 'save-gpu') return saveEntry(act.slice(5));
  if (act === 'del-model' || act === 'del-gpu') return removeEntry(act.slice(4));
  if (act === 'import-file') return $('#importFile').click();
  if (act === 'paste') { $('#pastebox').hidden = false; $('#pasteText').focus(); return; }
  if (act === 'paste-close') { $('#pastebox').hidden = true; return; }
  if (act === 'import-paste') return importText($('#pasteText').value, 'pasted JSON');
  if (act === 'export-cat') return showDialog('Your catalog', 'Spec sheet with the GPUs and models you added or changed. Import it on another machine, or commit it under inference-sizer/specs/.', JSON.stringify(C.makeSheet(userCat.gpus, userCat.models), null, 2), 'inference-sizer-catalog.json');
  if (act === 'template') return showDialog('Spec-sheet template', 'Fill in one entry per GPU or model, then import the file. An entry whose id matches a built-in one replaces it. Dense (not sparse) FLOPS, and per-direction link bandwidth.', JSON.stringify(C.makeSheet([C.GPUS[0]], [C.MODELS[2]]), null, 2), 'spec-sheet-template.json');
  if (act === 'reset') { state = defaults(); refreshCatalog(); syncInputs(); update(); }
}
function saveEntry(kind) {
  const name = $('#save-' + kind + '-name').value.trim();
  if (!name) return msg(kind, 'Give it a name first.', true);
  const cur = kind === 'model' ? models.find(m => m.id === state.model) : gpus.find(g => g.id === state.gpu);
  const sameName = cur && (kind === 'model' ? cur.name : cur.label) === name;
  const entry = kind === 'model'
    ? Object.assign({ id: sameName ? cur.id : C.slug(name), name, source: sameName ? cur.source || '' : '' }, modelValues(state), { wprec: state.wprec })
    : Object.assign({ id: sameName ? cur.id : C.slug(name), label: name, vendor: cur ? cur.vendor || '' : '', source: sameName ? cur.source || '' : '' }, gpuValues(state));
  delete entry.modelLabel; delete entry.gpuLabel;
  const r = kind === 'model' ? C.validateModel(entry) : C.validateGPU(entry);
  if (!r.ok) return msg(kind, r.errors.map(esc).join('<br>'), true);
  const list = kind === 'model' ? userCat.models : userCat.gpus;
  const i = list.findIndex(x => x.id === r.value.id);
  if (i >= 0) list[i] = r.value; else list.push(r.value);
  refreshCatalog();
  state[kind] = r.value.id;
  if (kind === 'model') state.modelLabel = name; else state.gpuLabel = name;
  syncInputs(); update();
  const builtin = (kind === 'model' ? C.MODELS : C.GPUS).some(x => x.id === r.value.id);
  msg(kind, builtin ? `Saved. ${esc(name)} now uses your values; remove it to go back to the built-in figures.` : `Saved ${esc(name)} to your ${kind === 'model' ? 'models' : 'GPUs'}.`);
}
function removeEntry(kind) {
  const id = state[kind];
  const list = kind === 'model' ? userCat.models : userCat.gpus;
  const i = list.findIndex(x => x.id === id); if (i < 0) return;
  const name = kind === 'model' ? list[i].name : list[i].label;
  list.splice(i, 1); refreshCatalog();
  const back = (kind === 'model' ? models : gpus).find(x => x.id === id) || (kind === 'model' ? models[0] : gpus[0]);
  Object.assign(state, kind === 'model' ? modelValues(back) : gpuValues(back)); state[kind] = back.id;
  syncInputs(); update();
  msg(kind, `Removed ${esc(name)}.` + (back.id === id ? ' The built-in figures are back.' : ''));
}
function importText(text, from) {
  const r = C.parseSheet(text);
  if (!r.gpus.length && !r.models.length) return msg('import', `Could not import ${esc(from)}: ${r.errors.map(esc).join('<br>')}`, true);
  for (const g of r.gpus) { const i = userCat.gpus.findIndex(x => x.id === g.id); if (i >= 0) userCat.gpus[i] = g; else userCat.gpus.push(g); }
  for (const m of r.models) { const i = userCat.models.findIndex(x => x.id === m.id); if (i >= 0) userCat.models[i] = m; else userCat.models.push(m); }
  refreshCatalog();
  if (r.models.length === 1 && !r.gpus.length) { Object.assign(state, modelValues(models.find(x => x.id === r.models[0].id))); state.model = r.models[0].id; }
  if (r.gpus.length === 1 && !r.models.length) { Object.assign(state, gpuValues(gpus.find(x => x.id === r.gpus[0].id))); state.gpu = r.gpus[0].id; }
  $('#pastebox').hidden = true; $('#pasteText').value = '';
  syncInputs(); update();
  const parts = [];
  if (r.models.length) parts.push(`${r.models.length} model${r.models.length > 1 ? 's' : ''} (${r.models.map(m => esc(m.name)).join(', ')})`);
  if (r.gpus.length) parts.push(`${r.gpus.length} GPU${r.gpus.length > 1 ? 's' : ''} (${r.gpus.map(g => esc(g.label)).join(', ')})`);
  msg('import', `Imported ${parts.join(' and ')} from ${esc(from)}.` + (r.notes && r.notes.length ? '<br>' + r.notes.map(esc).join('<br>') : '') + (r.errors.length ? '<br><span class="bad">Skipped: ' + r.errors.map(esc).join('<br>') + '</span>' : ''), false);
}

// ---------- dialog (export / copy / download) ----------
function showDialog(title, text, body, filename) {
  const d = $('#dialog');
  d.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><div class="dh"><h2 id="dlg-t">${esc(title)}</h2><button type="button" data-d="close" aria-label="Close">Close</button></div>
    <p class="sub">${text}</p><textarea readonly rows="16" spellcheck="false" id="dlg-body"></textarea>
    <div class="btnrow"><button type="button" class="primary" data-d="copy">Copy</button><button type="button" data-d="download">Download ${esc(filename)}</button><span class="msg" id="dlg-msg"></span></div></div>`;
  $('#dlg-body').value = body;
  d.hidden = false;
  d.onclick = async e => {
    const a = e.target.dataset.d;
    if (a === 'close' || e.target === d) { d.hidden = true; return; }
    if (a === 'copy') { try { await navigator.clipboard.writeText(body); $('#dlg-msg').textContent = 'Copied.'; } catch (err) { $('#dlg-body').select(); $('#dlg-msg').textContent = 'Copy is blocked here: the text is selected, press Ctrl/Cmd+C.'; } }
    if (a === 'download') {
      try { const u = URL.createObjectURL(new Blob([body], { type: 'application/json' })); const l = document.createElement('a'); l.href = u; l.download = filename; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); $('#dlg-msg').textContent = 'If nothing downloaded, this viewer blocks downloads: use Copy.'; }
      catch (err) { $('#dlg-msg').textContent = 'Downloads are blocked here: use Copy.'; }
    }
  };
  document.addEventListener('keydown', function esc_(e) { if (e.key === 'Escape') { d.hidden = true; document.removeEventListener('keydown', esc_); } });
}

// ---------- validation ----------
function sanitized() {
  const s = Object.assign({}, state);
  const pos = ['total', 'active', 'layers', 'hidden', 'qHeads', 'kvHeads', 'headDim', 'ctx', 'avgIn', 'peakIn', 'avgOut', 'peakOut', 'ttft', 'tpot', 'hbmGB', 'hbmTBs', 'tfBf16', 'scaleUpGBs', 'nicGbps', 'maxSeqPerGPU', 'domain', 'maxCtx'];
  pos.forEach(k => { s[k] = Math.max(+s[k] || 0, 1e-6); });
  ['conc', 'dau', 'rpu', 'experts', 'topk', 'swaFrac', 'swaWindow', 'prefixHit', 'headroom', 'price', 'reserveGB', 'stepMs', 'tfFp8', 'tfFp4', 'nodeKW', 'sloMargin', 'mlaRope', 'mlaNope'].forEach(k => { s[k] = Math.max(+s[k] || 0, 0); });
  s.peakFactor = Math.max(1, +s.peakFactor || 1);
  s.prefixHit = Math.min(s.prefixHit, 95); s.swaFrac = Math.min(s.swaFrac, 1); s.sloMargin = Math.min(s.sloMargin, 50);
  s.kvMaxUtil = Math.min(1, Math.max(0.3, +s.kvMaxUtil || 0.9));
  s.active = Math.min(s.active, s.total);
  ['layers', 'qHeads', 'kvHeads', 'headDim', 'hidden', 'experts', 'topk', 'ctx', 'maxSeqPerGPU', 'domain', 'mlaLatent', 'mlaV'].forEach(k => s[k] = Math.max(1, Math.round(+s[k] || 1)));
  if (!(+state.experts > 0)) s.experts = 0;
  if (!(+state.topk > 0)) s.topk = 0;
  return s;
}
function warnings(s, r) {
  const w = [];
  if (s.peakIn + s.peakOut > s.ctx) w.push(['warn', `A peak request (${fInt(s.peakIn)} in + ${fInt(s.peakOut)} out = ${fInt(s.peakIn + s.peakOut)} tokens) is larger than the ${fCtx(s.ctx)} context window. Peak prompts are capped at the window in this sizing; raise the window or lower the peak.`]);
  if (s.avgIn + s.avgOut > s.ctx) w.push(['bad', `The average request (${fInt(s.avgIn + s.avgOut)} tokens) does not fit the ${fCtx(s.ctx)} context window.`]);
  if (s.ctx > s.maxCtx) w.push(['warn', `The ${fCtx(s.ctx)} context window is above this model's maximum of ${fCtx(s.maxCtx)}.`]);
  if (s.avgIn > s.peakIn || s.avgOut > s.peakOut) w.push(['warn', 'An average token count is larger than its peak. Check the token inputs.']);
  if (r.md.computeFallback) w.push(['warn', `${s.gpuLabel} has no ${s.wprec.toUpperCase()} tensor cores. ${s.wprec.toUpperCase()} weights still save memory, but the math runs at the ${r.md.computeFallback.toUpperCase()} rate.`]);
  if (s.kvPolicy === 'reserve') w.push(['warn', `Every session reserves KV for the full ${fCtx(s.ctx)} window (${fGB(M.kvBytes(r.md, s.ctx))} each). Paged allocation (vLLM, SGLang, TRT-LLM default) usually needs far less memory.`]);
  if (s.experts > 0 && s.topk === 0) w.push(['warn', 'Experts is set but experts per token is 0, so the model is treated as dense.']);
  if (s.conc === 0 && s.dau === 0) w.push(['warn', 'Both concurrent sessions and DAU are 0, so there is no load to size for.']);
  if (!r.chosen) {
    const m = 1 - s.sloMargin / 100;
    if (r.tpotFloor > s.tpot / 1000 * m) w.push(['bad', `TPOT ${s.tpot} ms (less the ${s.sloMargin}% safety margin) is below what this model can do on ${s.gpuLabel} even at batch 1 (best layout: ${fMs(r.tpotFloor)}). Relax TPOT, use lower-precision weights, a faster GPU, or add speculative decoding (not modelled).`]);
    if (r.ttftFloor > s.ttft / 1000 * m) w.push(['bad', `TTFT ${s.ttft} ms (less the ${s.sloMargin}% margin) is not reachable for a ${fInt(Math.min(s.peakIn, s.ctx))}-token peak prompt (fastest layout: ${fMs(r.ttftFloor)}). Relax TTFT, cut the peak prompt, raise the prefix-cache hit rate, or use lower-precision weights.`]);
    if (r.tpotFloor <= s.tpot / 1000 * m && r.ttftFloor <= s.ttft / 1000 * m) w.push(['bad', 'No layout meets both targets together under the selected serving architecture. Try "Pick the cheaper option", relax a target, or reduce the context window.']);
  }
  return w;
}

// ---------- topology ----------
const unitName = D => D > 8 ? 'rack' : 'node';
function instancesFor(r) {
  const c = r.chosen, list = [];
  if (c.mode === 'disagg') {
    for (let i = 0; i < r.dis.P.N; i++) list.push({ role: 'p', g: r.dis.P.c.g, tag: 'P' + (i + 1) });
    for (let i = 0; i < r.dis.D.N; i++) list.push({ role: 'd', g: r.dis.D.c.g, tag: 'D' + (i + 1) });
  } else for (let i = 0; i < r.agg.best.N; i++) list.push({ role: 'a', g: r.agg.best.c.g, tag: 'A' + (i + 1) });
  if (c.spareNodes || r.s.nPlus1) list.push({ role: 's', g: Math.max(...list.map(x => x.g)), tag: 'spare' });
  return list;
}
function packCells(r) {
  const D = r.md.D;
  const inst = instancesFor(r).sort((a, b) => (b.g - a.g) || ((a.role === 's') - (b.role === 's')));
  const nodes = [];
  inst.forEach(it => {
    if (it.g >= D) { for (let k = 0; k < Math.ceil(it.g / D); k++) nodes.push(Array.from({ length: D }, (_, j) => ({ role: it.role, tag: it.tag, first: j === 0 }))); return; }
    let n = nodes.find(nd => nd.filter(x => !x).length >= it.g);
    if (!n) { n = Array(D).fill(null); nodes.push(n); }
    const start = n.indexOf(null);
    for (let j = 0; j < it.g; j++) n[start + j] = { role: it.role, tag: it.tag, first: j === 0 };
  });
  return nodes;
}
function topologyHTML(r) {
  const c = r.chosen, s = r.s, D = r.md.D, U = unitName(D);
  let pools = '';
  if (c.mode === 'disagg') {
    const P = r.dis.P, Dd = r.dis.D;
    pools += `<div class="pool p"><div class="t">Prefill pool</div><div class="l">${P.N} × ${esc(P.label)} = ${P.gpus} GPUs</div><ul>
      <li>${fTok(P.ps.cap)} prompt tokens/s per instance, ${pct(P.rho)} busy at peak</li>
      <li>KV handed to decode over RDMA: ${fMs(P.xferAvg)} avg, ${fMs(P.xferPeak)} for a peak prompt</li></ul></div>`;
    pools += `<div class="pool d"><div class="t">Decode pool</div><div class="l">${Dd.N} × ${esc(Dd.label)} = ${Dd.gpus} GPUs</div><ul>
      <li>${fInt(Dd.Bop)} streams per instance at peak (max ${fInt(Dd.Binst)} within TPOT)</li>
      <li>${fTok(Dd.Bop / Dd.tpotOp)} output tokens/s per instance; step is ${Dd.st.bound}-bound</li></ul></div>`;
  } else {
    const A = r.agg.best;
    pools += `<div class="pool a"><div class="t">Aggregated pool (chunked prefill)</div><div class="l">${A.N} × ${esc(A.label)} = ${A.gpus} GPUs</div><ul>
      <li>${fInt(A.Bop)} decode streams per instance, plus up to ${fInt(A.chunk)} prompt tokens per step</li>
      <li>Prefill uses ${pct(A.fp)} of instance compute at peak</li></ul></div>`;
  }
  pools += `<div class="pool s"><div class="t">Fleet</div><div class="l">${c.totalNodes} ${U}${c.totalNodes === 1 ? '' : 's'} × ${D} = ${c.provGPUs} GPUs</div><ul>
    <li>${esc(s.gpuLabel)}; ${D} GPUs per ${U} share one scale-up domain</li>
    <li>${c.gpus} GPUs serving${s.nPlus1 ? ', room for one spare instance' : ''}${c.kw ? `; ~${f1(c.kw)} kW at max power` : ''}</li></ul></div>`;
  const nodes = packCells(r), MAX = D > 8 ? 8 : 48, shown = nodes.slice(0, MAX), cols = Math.min(D, 18);
  const rack = shown.map((nd, i) => `<div class="node" aria-label="${U} ${i + 1}"><div class="nh"><span>${U} ${i + 1}</span><span>${nd.every(x => x && x.role === 's') ? 'spare' : ''}</span></div><div class="gpus" style="grid-template-columns:repeat(${cols},1fr)">${nd.map(x => x ? `<div class="gpu ${x.role}${x.first ? ' gl' : ''}" title="${esc(x.tag)}">${x.first && x.role !== 's' ? esc(x.tag) : ''}</div>` : '<div class="gpu" title="idle"></div>').join('')}</div></div>`).join('');
  const more = nodes.length > MAX ? `<p class="x">Showing ${MAX} of ${nodes.length} ${U}s.</p>` : '';
  const leg = `<div class="legend">${c.mode === 'disagg' ? '<span><i style="background:var(--prefill)"></i>prefill</span><span><i style="background:var(--decode)"></i>decode</span>' : '<span><i style="background:var(--agg)"></i>prefill + decode</span>'}<span><i class="hatch"></i>spare instance</span><span><i style="background:var(--sunk)"></i>idle</span><span class="x">Labels mark the first GPU of each model instance.</span></div>`;
  return `<div class="pools">${pools}</div><div class="rack ${D > 8 ? 'wide' : ''}">${rack}</div>${more}${leg}`;
}

// ---------- charts ----------
function niceMax(v) { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
function ticks(max) { return Array.from({ length: 5 }, (_, i) => +(max / 4 * i).toPrecision(3)); }
function stepChart(r) {
  const s = r.s, md = r.md, c = r.chosen;
  const row = c.mode === 'disagg' ? r.dis.D : r.agg.best;
  const cfg = row.c, mi = row.mi;
  const capBm = Math.max(1, M.decodeCap(s, md, cfg, mi));
  const W = 560, H = 260, L = 50, R = 16, T = 14, B = 40;
  const xs = []; for (let i = 0; i <= 60; i++) xs.push(Math.max(1, Math.round(1 + (capBm - 1) * i / 60)));
  const pts = xs.map(b => { const st = M.decodeStep(s, md, cfg, b); return { b: b * cfg.pp, t: st.t * 1000, m: (st.tm + st.comm + st.ovh) * 1000 }; });
  const target = s.tpot;
  const yMax = niceMax(Math.max(target * 1.2, ...pts.map(p => p.t))), xMax = capBm * cfg.pp;
  const X_ = v => L + (W - L - R) * v / xMax, Y = v => T + (H - T - B) * (1 - v / yMax);
  const path = key => pts.map((p, i) => (i ? 'L' : 'M') + X_(p.b).toFixed(1) + ' ' + Y(p[key]).toFixed(1)).join(' ');
  const area = path('t') + ` L ${X_(pts[pts.length - 1].b).toFixed(1)} ${Y(0)} L ${X_(pts[0].b).toFixed(1)} ${Y(0)} Z`;
  const op = row.Bop, opT = row.tpotOp * 1000, opX = X_(Math.min(op, xMax)), opY = Y(Math.min(opT, yMax)), right = opX > W * 0.62;
  const limitLabel = Math.floor(mi.Bmem / cfg.pp) <= s.maxSeqPerGPU * cfg.tpl ? 'KV fill limit' : 'sequence cap';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Decode step time versus concurrent streams for one ${esc(row.label)} instance">
    ${ticks(yMax).map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${ticks(xMax).map(v => `<text x="${X_(v)}" y="${H - B + 16}" text-anchor="middle">${fInt(v)}</text>`).join('')}
    <text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">concurrent streams per instance</text>
    <text x="12" y="${T + (H - T - B) / 2}" transform="rotate(-90 12 ${T + (H - T - B) / 2})" text-anchor="middle">ms per token</text>
    <path d="${area}" fill="var(--decode)" opacity="0.10"/>
    <path d="${path('m')}" fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="2 3"/>
    <path d="${path('t')}" fill="none" stroke="var(--decode)" stroke-width="2.2"/>
    <line x1="${L}" x2="${W - R}" y1="${Y(target)}" y2="${Y(target)}" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="${W - R}" y="${Y(target) - 6}" text-anchor="end" style="fill:var(--warn)">TPOT target ${target} ms</text>
    <text x="${W - R}" y="${T + 10}" text-anchor="end">${limitLabel} at ${fInt(xMax)} →</text>
    <circle cx="${opX}" cy="${opY}" r="5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>
    <text x="${opX + (right ? -10 : 10)}" y="${opY - 10}" text-anchor="${right ? 'end' : 'start'}" style="fill:var(--ink)">at peak: ${fInt(op)} streams · ${opT.toFixed(1)} ms</text>
  </svg>
  <div class="legend"><span><i style="background:var(--decode)"></i>decode step time</span><span><i class="dots"></i>weight + KV read, comms, overhead</span></div>`;
}
function sensChart(r) {
  const data = r.sens || [];
  const W = 560, H = 260, L = 50, R = 16, T = 14, B = 40;
  const yMax = niceMax(Math.max(8, ...data.map(d => d.gpus).filter(v => v != null)));
  const bw = (W - L - R) / data.length, Y = v => T + (H - T - B) * (1 - v / yMax);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="GPUs provisioned versus TPOT target">
    ${ticks(yMax).map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${fInt(v)}</text>`).join('')}
    ${data.map((d, i) => {
      const x = L + i * bw + bw * 0.18, w = bw * 0.64, cur = d.tpot === r.s.tpot;
      const bar = d.gpus == null ? `<text x="${x + w / 2}" y="${Y(0) - 6}" text-anchor="middle" style="fill:var(--bad)">n/a</text>`
        : `<rect x="${x}" y="${Y(d.gpus)}" width="${w}" height="${Y(0) - Y(d.gpus)}" rx="2" fill="${cur ? 'var(--accent)' : 'var(--line)'}"/><text x="${x + w / 2}" y="${Y(d.gpus) - 5}" text-anchor="middle" style="fill:${cur ? 'var(--ink)' : 'var(--muted)'}">${fInt(d.gpus)}</text>`;
      return bar + `<text x="${x + w / 2}" y="${H - B + 16}" text-anchor="middle" style="${cur ? 'fill:var(--ink);font-weight:500' : ''}">${d.tpot}</text>`;
    }).join('')}
    <text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">TPOT target (ms), same traffic and TTFT</text>
    <text x="12" y="${T + (H - T - B) / 2}" transform="rotate(-90 12 ${T + (H - T - B) / 2})" text-anchor="middle">GPUs provisioned</text>
  </svg>`;
}

// ---------- sections ----------
function verdictHTML(r, warns) {
  const s = r.s, c = r.chosen;
  const wl = warns.length ? `<div class="warns">${warns.map(w => `<div class="warnline ${w[0] === 'bad' ? 'bad' : ''}">${esc(w[1])}</div>`).join('')}</div>` : '';
  if (!c) return `<section class="card verdict fail"><div class="vhead"><div><div class="what">No ${esc(s.gpuLabel)} layout meets these targets</div><div class="why">Every layout from 1 to 64 GPUs per instance was ruled out.</div></div><span class="pill bad">infeasible</span></div>${wl}</section>`;
  const desc = c.mode === 'disagg' ? `Disaggregated: ${r.dis.P.N} × ${r.dis.P.label} prefill + ${r.dis.D.N} × ${r.dis.D.label} decode` : `Aggregated: ${r.agg.best.N} × ${r.agg.best.label}`;
  const drow = c.mode === 'disagg' ? r.dis.D : r.agg.best;
  const perGPU = Math.max(r.load.Dtok, r.load.Cs / drow.tpotOp) / c.gpus;
  const U = unitName(c.nodeGPUs);
  return `<section class="card verdict"><div class="vhead"><div><div class="eyebrow">${esc(s.modelLabel)} on ${esc(s.gpuLabel)}</div><div class="what">${esc(desc)}</div><div class="why">${esc(r.reason)}</div></div>
    <div class="btnrow"><button type="button" class="primary" data-r="copy">Copy summary</button><button type="button" data-r="fleetscope">Export to FleetScope</button></div></div>
    <div class="toast" id="toast" role="status"></div>
    <div class="kpis">
      <div class="kpi main"><div class="k">GPUs needed</div><div class="v">${fInt(c.gpus)}</div><div class="d">serving at peak load</div></div>
      <div class="kpi"><div class="k">${U === 'rack' ? 'Racks' : 'Nodes'} (${c.nodeGPUs} GPUs each)</div><div class="v">${fInt(c.totalNodes)}</div><div class="d">${c.nodes} serving${c.spareNodes ? ` + ${c.spareNodes} for the spare` : ''}</div></div>
      <div class="kpi"><div class="k">GPUs provisioned</div><div class="v">${fInt(c.provGPUs)}</div><div class="d">whole ${U}s</div></div>
      <div class="kpi"><div class="k">Output tokens/s per GPU</div><div class="v">${fTok(perGPU)}</div><div class="d">at peak</div></div>
      <div class="kpi"><div class="k">Cost per 1M output tokens</div><div class="v">${s.dau > 0 && s.price > 0 ? fUSD(r.econ.perMOut) : '–'}</div><div class="d">${s.dau > 0 ? `${fUSD(r.econ.costDay)}/day at $${(+s.price).toFixed(2)}/GPU-hr` : 'needs DAU'}</div></div>
    </div>${wl}</section>`;
}
function sloHTML(r) {
  const s = r.s, c = r.chosen, T = s.ttft / 1000, P = s.tpot / 1000;
  const pill = (v, tgt) => { const q = v / tgt; return `<span class="pill ${q <= 0.8 ? 'good' : q <= 1.0001 ? 'warn' : 'bad'}">${q <= 1.0001 ? 'meets' : 'misses'} · ${Math.round(q * 100)}% of target</span>`; };
  let rows;
  if (c.mode === 'disagg') {
    const Pp = r.dis.P, D = r.dis.D;
    rows = [['TTFT, average prompt at peak load', `${fInt(s.avgIn)} tokens, queueing + KV handoff`, Pp.ttftAvg, T],
      ['TTFT, peak prompt', `${fInt(Math.min(s.peakIn, s.ctx))} tokens on an idle prefill instance`, Pp.ttftPeak, T],
      ['TPOT at peak load', `${fInt(D.Bop)} streams on each decode instance`, D.tpotOp, P]];
  } else {
    const A = r.agg.best;
    rows = [['TTFT, average prompt at peak load', `${fInt(s.avgIn)} tokens, chunked behind decode`, A.ttftAvg, T],
      ['TTFT, peak prompt', `${fInt(Math.min(s.peakIn, s.ctx))} tokens`, A.ttftPeak, T],
      ['TPOT, typical step at peak', `${fInt(A.Bop)} streams + prefill chunks`, A.tpotOp, P],
      ['TPOT, step carrying a full prefill chunk', `${fInt(A.chunk)} prompt tokens in the step`, P * (1 - s.sloMargin / 100), P]];
  }
  const row = c.mode === 'disagg' ? r.dis.D : r.agg.best;
  return `<section class="card"><h2>Latency check</h2><p class="sub">Estimates against your targets of ${s.ttft} ms TTFT and ${s.tpot} ms TPOT (${f1(1000 / s.tpot)} tokens/s per user), sized with a ${s.sloMargin}% safety margin.</p>
  <div class="tablewrap"><table><thead><tr><th>Metric</th><th>Condition</th><th class="n">Estimate</th><th>Status</th></tr></thead><tbody>
  ${rows.map(x => `<tr><td>${esc(x[0])}</td><td class="muted">${esc(x[1])}</td><td class="n">${fMs(x[2])}</td><td>${pill(x[2], x[3])}</td></tr>`).join('')}
  <tr><td>KV cache in use</td><td class="muted">per ${esc(row.label)} instance at peak</td><td class="n">${pct(row.kvUse)}</td><td><span class="pill ${row.kvUse < 0.85 ? 'good' : row.kvUse <= 1 ? 'warn' : 'bad'}">${row.kvUse < 0.85 ? 'room to spare' : 'near the limit'}</span></td></tr>
  </tbody></table></div></section>`;
}
function memoryHTML(r) {
  const s = r.s, md = r.md, c = r.chosen;
  const row = c.mode === 'disagg' ? r.dis.D : r.agg.best, mi = row.mi;
  const hbm = s.hbmGB * 1e9, held = hbm * (1 - s.memUtil), resv = md.reserve, w = mi.wGPU;
  const kvTot = Math.max(0, mi.avail), kvUsed = Math.min(kvTot, kvTot * row.kvUse);
  const parts = [['Weights', w, 'var(--ink)'], ['KV cache in use', kvUsed, 'var(--decode)'], ['KV cache free', kvTot - kvUsed, 'color-mix(in srgb, var(--decode) 30%, transparent)'], ['Runtime reserve', resv, 'var(--warn)'], ['Held back by engine', held, 'var(--line)']];
  return `<section class="card"><h2>Memory on one decode GPU</h2><p class="sub">${esc(row.label)}, ${s.wprec.toUpperCase()} weights, ${s.kvprec.toUpperCase()} KV, ${s.kvPolicy === 'paged' ? 'paged KV' : 'full-window reservation'}, ${s.hbmGB} GB HBM.</p>
    <div class="membar">${parts.map(p => `<div style="width:${Math.max(0, 100 * p[1] / hbm).toFixed(2)}%;background:${p[2]}" title="${p[0]}"></div>`).join('')}</div>
    <div class="memlegend">${parts.map(p => `<i style="background:${p[2]}"></i><span>${p[0]}</span><span class="mono">${fGB(p[1])}</span>`).join('')}</div>
    <dl class="kv" style="margin-top:14px">
      <dt>KV per token (all layers)</dt><dd>${fGB(md.kvTokLayer * s.layers)}</dd>
      <dt>KV for one ${fCtx(s.ctx)} full-context request</dt><dd>${fGB(mi.ctxBytes)}</dd>
      <dt>KV for an average request (${fInt(s.avgIn + s.avgOut)} tokens)</dt><dd>${fGB(M.kvBytes(md, Math.min(s.ctx, s.avgIn + s.avgOut)))}</dd>
      <dt>KV capacity per instance</dt><dd>${fGB(mi.cap)}</dd>
      ${mi.rep > 1 ? `<dt>KV replicated across GPUs</dt><dd>${mi.rep}× (${md.mla ? 'MLA latent' : s.kvHeads + ' KV heads'} under TP)</dd>` : ''}
      <dt>Sequences per instance at the ${pct(s.kvMaxUtil)} fill limit</dt><dd>${fInt(mi.Bmem)}</dd>
    </dl></section>`;
}
function loadHTML(r) {
  const s = r.s, L = r.load, row = r.chosen.mode === 'disagg' ? r.dis.D : r.agg.best, hit = s.prefixHit / 100;
  return `<section class="card"><h2>Load being sized</h2><p class="sub">Peak figures include ${s.headroom}% headroom. Sized on ${L.binding === 'DAU' ? 'DAU traffic' : 'concurrent sessions'}, the larger of the two.</p>
  <dl class="kv">
    <dt>Requests/s from DAU (peak)</dt><dd>${f1(L.lamDau)}</dd>
    <dt>Requests/s implied by ${fInt(s.conc)} sessions</dt><dd>${f1(L.lamConc)}</dd>
    <dt>Peak request rate sized</dt><dd>${f1(L.lam)}</dd>
    <div class="sep"></div>
    <dt>Prompt tokens/s to prefill${hit ? ` (after ${s.prefixHit}% cache hits)` : ''}</dt><dd>${fTok(L.lam * Math.min(s.avgIn, s.ctx) * (1 - hit))}</dd>
    <dt>Output tokens/s to decode</dt><dd>${fTok(Math.max(L.Dtok, L.Cs / row.tpotOp))}</dd>
    <dt>Streams in flight at peak</dt><dd>${fInt(Math.max(L.Cs, L.Dtok * row.tpotOp))}</dd>
    <div class="sep"></div>
    <dt>Requests per day</dt><dd>${fTok(r.econ.reqDay)}</dd>
    <dt>Input / output tokens per day</dt><dd>${fTok(r.econ.inDay)} / ${fTok(r.econ.outDay)}</dd>
    <dt>Daily average vs sized peak</dt><dd>${s.dau > 0 ? pct(r.econ.avgVsPeak) : '–'}</dd>
  </dl></section>`;
}
function candidatesHTML(r) {
  const c = r.chosen;
  const rows = r.cfgs.map((cfg, i) => {
    const d = r.dis.dec[i], p = r.dis.pre[i], a = r.agg.rows[i];
    const cell = (x, f) => x.feasible ? f(x) : `<span class="x">${esc(x.why)}</span>`;
    const isChosen = c && ((c.mode === 'agg' && r.agg.best === a) || (c.mode === 'disagg' && (r.dis.D === d || r.dis.P === p)));
    return `<tr class="${isChosen ? 'chosen' : ''}"><td class="mono">${cfg.g}</td><td>${esc(d.label)}</td><td class="n">${cell(d, x => fInt(x.Binst))}</td><td class="n">${cell(d, x => fInt(x.gpus))}</td><td>${esc(p.label)}</td><td class="n">${cell(p, x => fInt(x.gpus))}</td><td class="n">${cell(a, x => fInt(x.gpus))}</td></tr>`;
  }).join('');
  return `<section class="card"><h2>Every layout considered</h2><p class="sub">GPUs per model instance, and how many GPUs each pool needs with that instance size. The cheapest feasible layout per pool is used; highlighted rows are the recommendation.</p>
  <div class="tablewrap"><table><thead><tr><th>GPUs / instance</th><th>Decode layout</th><th class="n">Max streams</th><th class="n">Decode GPUs</th><th>Prefill layout</th><th class="n">Prefill GPUs</th><th class="n">Aggregated GPUs</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function methodHTML() {
  return `<section class="card method"><h2>How the estimate works</h2>
  <ol>
    <li><b>Load.</b> Peak request rate = DAU × requests/user ÷ 86,400 × peak factor. Concurrent sessions convert to a rate with Little's law: sessions ÷ (TTFT + output × TPOT). Decode must hold the session count and deliver rate × average output tokens/s.</li>
    <li><b>Memory.</b> Weights per GPU = params × bytes ÷ GPUs (MoE experts sharded by EP; with MLA, attention runs data-parallel so dense weights are replicated). KV per token = 2 × layers × KV heads × head dim × bytes (MLA: latent + RoPE dims per layer). Sliding-window layers store only the window. KV is replicated when TP is larger than the KV-head count. The context window must fit one full request; under paged allocation each session holds its actual tokens, under reservation the whole window. KV fills to the fill limit at most.</li>
    <li><b>Decode step.</b> <code>max(HBM read time, compute time) + collectives + overhead</code>. The HBM read is weights (only the experts the batch routes to) plus each stream's KV. The largest batch that stays within TPOT less the safety margin sets streams per instance.</li>
    <li><b>Prefill.</b> FLOPs = 2 × active params × prompt tokens + causal attention, at the chosen MFU. TP inside a scale-up domain, context parallelism across domains. Queueing uses an M/D/1 model, with utilisation capped so the average prompt still meets TTFT.</li>
    <li><b>Serving architecture.</b> Disaggregated: separate prefill and decode pools, KV moved over RDMA (counted in TTFT). Aggregated: each step carries decode tokens plus a prefill chunk sized to keep the step within TPOT. Auto picks disaggregated only when it saves at least 10% of nodes.</li>
    <li><b>Fleet.</b> Instances up to the scale-up domain size pack first-fit into nodes (or racks); larger ones span whole domains. N+1 keeps room for one more instance of the largest layout.</li>
    <li><b>GPUs without a precision.</b> FP4 weights on a GPU without FP4 tensor cores keep the memory saving but compute at the FP8 (or BF16) rate.</li>
  </ol>
  <p class="muted" style="max-width:90ch">First-order model. It leaves out speculative decoding / MTP, CUDA-graph padding, request-length variance beyond the peak checks and framework-specific kernels. Calibrate the engine assumptions against a vLLM, SGLang or TensorRT-LLM benchmark at your own sequence lengths, then use Export to FleetScope to replay the result over time.</p></section>`;
}
function summaryText(r) {
  const s = r.s, c = r.chosen, L = r.load;
  const lines = [`Sizing: ${s.modelLabel} on ${s.gpuLabel}, ${s.wprec.toUpperCase()} weights, ${s.kvprec.toUpperCase()} KV, ${fCtx(s.ctx)} context`,
    `Load: ${fInt(s.conc)} concurrent sessions; ${fInt(s.dau)} DAU × ${s.rpu} req/day, ${s.peakFactor}× peak → ${f1(L.lam)} req/s sized (incl. ${s.headroom}% headroom)`,
    `Tokens: in avg ${fInt(s.avgIn)} / peak ${fInt(s.peakIn)}, out avg ${fInt(s.avgOut)} / peak ${fInt(s.peakOut)}`,
    `Targets: TTFT ${s.ttft} ms, TPOT ${s.tpot} ms (sized with a ${s.sloMargin}% margin)`];
  if (!c) { lines.push(`Result: no ${s.gpuLabel} layout meets these targets.`); return lines.join('\n'); }
  if (c.mode === 'disagg') lines.push(`Recommendation: disaggregated. Prefill ${r.dis.P.N} × ${r.dis.P.label} (${r.dis.P.gpus} GPUs), decode ${r.dis.D.N} × ${r.dis.D.label} (${r.dis.D.gpus} GPUs)`, `Estimates: TTFT ${fMs(r.dis.P.ttftAvg)} avg / ${fMs(r.dis.P.ttftPeak)} peak prompt; TPOT ${fMs(r.dis.D.tpotOp)}`);
  else lines.push(`Recommendation: aggregated with chunked prefill. ${r.agg.best.N} × ${r.agg.best.label} (${r.agg.best.gpus} GPUs)`, `Estimates: TTFT ${fMs(r.agg.best.ttftAvg)} avg / ${fMs(r.agg.best.ttftPeak)} peak prompt; TPOT ${fMs(r.agg.best.tpotOp)} typical`);
  lines.push(`Fleet: ${c.gpus} GPUs serving → ${c.totalNodes} × ${c.nodeGPUs}-GPU ${unitName(c.nodeGPUs)}s = ${c.provGPUs} GPUs${c.kw ? `, ~${f1(c.kw)} kW max` : ''}`);
  if (s.dau > 0 && s.price > 0) lines.push(`Cost: ${fUSD(r.econ.costDay)}/day, ${fUSD(r.econ.perMOut)} per 1M output tokens at $${(+s.price).toFixed(2)}/GPU-hr`);
  return lines.join('\n');
}

// ---------- update ----------
let last = null;
function setHint(k, text, warn) { const h = document.getElementById('hint-' + k); if (h) { h.textContent = text || ''; h.classList.toggle('warn', !!warn); } }
function update() {
  save(STORE, state);
  const s = sanitized(), r = M.plan(s);
  last = r;
  const warns = warnings(s, r);
  setHint('ctx', `Model max ${fCtx(s.maxCtx)}. Peak request uses ${fInt(s.peakIn + s.peakOut)} tokens.`, s.peakIn + s.peakOut > s.ctx || s.ctx > s.maxCtx);
  const chips = $('#chips-ctx');
  chips.innerHTML = FIELDS.ctx.chips.filter(v => v <= Math.max(s.maxCtx, 8192)).concat(s.maxCtx > 262144 ? [s.maxCtx] : []).map(v => `<button type="button" class="chip ${v === s.ctx ? 'on' : ''}" data-v="${v}">${fCtx(v)}</button>`).join('');
  setHint('tpot', `${f1(1000 / s.tpot)} tokens/s per user`);
  setHint('model', `${s.experts ? `MoE, ${s.active}B of ${s.total}B active` : `Dense, ${s.total}B`} · ${s.attn === 'mla' ? 'MLA' : s.kvHeads + ' KV heads'} · weights ${fGB(r.md.Wd + r.md.We)}`);
  setHint('gpu', `${s.hbmGB} GB @ ${s.hbmTBs} TB/s · ${fInt(s.tfFp8 || s.tfBf16)} TFLOPS ${s.tfFp8 ? 'FP8' : 'BF16'}${s.tfFp4 ? ` · ${fInt(s.tfFp4)} FP4` : ''} · ${s.domain} per domain`);
  setHint('conc', `Implies ${f1(r.load.lamConc)} req/s`);
  setHint('dau', s.dau > 0 ? `${f1(r.load.lamDau)} req/s at peak` : '');
  $('#spec').textContent = `${s.gpuLabel} · ${s.hbmGB} GB @ ${s.hbmTBs} TB/s · ${s.scaleUpGBs} GB/s scale-up per direction · ${s.domain} GPUs per domain · ${s.nicGbps}G NIC per GPU`;
  const el = $('#results');
  if (!r.chosen) { el.innerHTML = verdictHTML(r, warns) + methodHTML(); return; }
  const lbl = (r.chosen.mode === 'disagg' ? r.dis.D : r.agg.best).label;
  el.innerHTML = verdictHTML(r, warns)
    + `<section class="card"><h2>GPU topology</h2><p class="sub">How the ${r.chosen.provGPUs} GPUs split into model instances and sit on ${r.chosen.nodeGPUs}-GPU ${unitName(r.chosen.nodeGPUs)}s.</p>${topologyHTML(r)}</section>`
    + sloHTML(r)
    + `<div class="two"><section class="card"><h2>Decode step time vs batch</h2><p class="sub">One ${esc(lbl)} instance. Where the curve crosses the target sets streams per instance.</p>${stepChart(r)}</section>
       <section class="card"><h2>GPUs vs TPOT target</h2><p class="sub">Provisioned GPUs as the TPOT target moves; your current target is highlighted.</p>${sensChart(r)}</section></div>`
    + `<div class="two">${memoryHTML(r)}${loadHTML(r)}</div>` + candidatesHTML(r) + methodHTML();
}
$('#results').addEventListener('click', async e => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  if (b.dataset.r === 'copy') {
    const t = $('#toast');
    try { await navigator.clipboard.writeText(summaryText(last)); t.textContent = 'Summary copied.'; }
    catch (err) { showDialog('Summary', 'Copy is blocked here; select the text below.', summaryText(last), 'sizing-summary.txt'); }
  }
  if (b.dataset.r === 'fleetscope') {
    const x = X.toGraph(last);
    if (!x.ok) { $('#toast').textContent = x.errors.join(' '); $('#toast').className = 'toast bad'; return; }
    showDialog('Export to FleetScope', `A FleetScope graph with this model, your targets, ${fInt(x.users)} chat users arriving at the sized peak rate, and the recommended pools (GPUs per instance set). In FleetScope, press <b>Load graph JSON</b> and Play, or save it as <code>fleetscope/scenarios/&lt;name&gt;/graph.json</code> for the CI plan.<br>${x.notes.map(esc).join('<br>')}`, JSON.stringify(x.graph, null, 1), 'graph.json');
  }
});

buildInputs();
syncInputs();
update();
})();
