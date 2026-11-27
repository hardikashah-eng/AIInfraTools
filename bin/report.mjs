#!/usr/bin/env node
// aiinfra report: plan → verify → account on one page, from what the tools already keep.
//
//   aiinfra report --store DIR --model M --gpu G [--harness PATH|demo] [--gpu-rate 3] [--days 30] [--outcomes F]
//                  [--tasks-per-day N] [--set k=v]… [--format text|md] [--json]
//   aiinfra report --demo [--format md]      the loop on demo data: a shadow test that corrects the sizer, then economics
//
//   Plan       the Inference Sizer's GPU count for the model on the GPU, before and after the store's calibration
//   Verify     the last shadow verdict (decision, metric effects, prediction vs measurement), the last promotion,
//              and each canary's share and anything waiting for a person's approval
//   Calibrate  the efficiencies measured so far (<store>/calibration/sizer.json), and how far the sizer was off
//   Account    harness-ledger economics on an agent trace: cost per resolved task, self-hosting GPUs (calibrated),
//              the break-even GPU-hour price, tokens per MW
//
// The report only reads. It runs each tool's --json command and the files fleetops writes under the store.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = { sizer: 'inference-sizer/tools/size.mjs', fleetops: 'fleetops/tools/fleetops.mjs', 'harness-ledger': 'harness-ledger/tools/harness-ledger.mjs' };

function args(argv) {
  const o = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue;
    const k = a.slice(2), n = argv[i + 1], v = n === undefined || n.startsWith('--') ? true : (i++, n);
    if (k === 'set') o.set.push(v); else o[k] = v;
  }
  return o;
}
function run(tool, a) {
  const r = spawnSync(process.execPath, [path.join(ROOT, BIN[tool]), ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* not JSON: reported below */ }
  if (j && j.error) return { error: j.error };
  if (!j) return { error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop() };
  return j;
}
const readJson = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []);

// ---- gather ---------------------------------------------------------------------------------------------------------
export function gather(o) {
  const store = path.resolve(o.store && o.store !== true ? o.store : 'fleet-data');
  const calFile = path.join(store, 'calibration', 'sizer.json'), cal = readJson(calFile);
  const keys = cal && cal.sizer ? Object.keys(cal.sizer) : [];
  // the model and GPU: given, or the only one the store has calibrated
  let model = o.model && o.model !== true ? o.model : null, gpu = o.gpu && o.gpu !== true ? o.gpu : null;
  if ((!model || !gpu) && keys.length === 1) { const [g, m] = keys[0].split('|'); gpu = gpu || g; model = model || m; }
  const out = { store, model, gpu, plan: null, verify: null, calibration: null, account: null, next: [] };

  // Plan
  if (model && gpu) {
    const base = ['--model', model, '--gpu', gpu, ...o.set.flatMap(s => ['--set', s]), '--json'];
    const sz = run('sizer', base), key = `${gpu}|${model}`, calibrated = cal && cal.sizer && cal.sizer[key] ? run('sizer', [...base, '--calibration', calFile]) : null;
    const pick = r => (r && !r.error ? { found: r.found, mode: r.mode || null, gpus: r.gpus ?? null, provisionedGpus: r.provisionedGpus ?? null, nodes: r.nodes ?? null, costPerMOutputTokens: r.costPerMOutputTokens ?? null, targets: r.targets || null } : r ? { error: r.error } : null);
    out.plan = { sizer: pick(sz), calibrated: pick(calibrated) };
  } else out.next.push('give --model M --gpu G (Inference Sizer ids) to size the model');

  // Verify
  const sdir = path.join(store, 'shadow'), verdicts = readJsonl(path.join(sdir, 'verdicts.jsonl')), promoted = readJsonl(path.join(sdir, 'promoted.jsonl'));
  const cdir = path.join(sdir, 'canaries');
  const canaries = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter(f => /\.json$/.test(f)).sort().map(f => readJson(path.join(cdir, f))).filter(s => s && s.kind === 'fleetops.llmd-canary')
    .map(s => ({ name: s.name, status: s.status, share: s.status === 'rolled back' ? 0 : s.steps[s.step], steps: s.steps, baseline: s.baseline, candidate: s.candidate, awaitingApproval: s.pending && !s.pending.approvedBy ? { id: s.pending.id, toShare: s.steps[s.pending.toStep] } : null })) : [];
  const last = verdicts.at(-1) || null;
  out.verify = {
    verdicts: verdicts.length,
    last: last && { t: last.t, source: last.source || 'requests', baseline: last.baseline, candidate: last.candidate, decision: last.decision, why: last.why,
      metrics: Object.fromEntries(Object.entries(last.metrics || {}).filter(([, m]) => m && m.verdict).map(([k, m]) => [k, { verdict: m.verdict, effect: Number.isFinite(m.effect) ? m.effect : null }])),
      ...(last.prediction ? { prediction: last.prediction } : {}) },
    ...(promoted.length ? { promoted: promoted.at(-1) } : {}), canaries };
  if (!last) out.next.push(`no shadow verdict yet: fleetops shadow compare … --plan plan.json --store ${store} (or shadow prom)`);
  for (const c of canaries) if (c.awaitingApproval) out.next.push(`canary ${c.name}: the step to ${c.awaitingApproval.toShare}% waits for a person: fleetops shadow canary approve --name ${c.name} --by NAME`);

  // Calibration
  out.calibration = { file: fs.existsSync(calFile) ? calFile : null,
    entries: keys.map(k => { const e = cal.sizer[k]; return { key: k, effPrefill: e.effPrefill ?? null, effDecodeBW: e.effDecodeBW ?? null, effDecodeComp: e.effDecodeComp ?? null, source: e.source || null, fitOn: e.fitOn || null, t: e.t ?? null }; }) };
  if (!keys.length) out.next.push('no calibration yet: a shadow test whose prediction is off by more than 15% writes one');

  // Account
  const h = o.harness && o.harness !== true ? o.harness : null;
  if (h) {
    const ea = [...(h === 'demo' ? ['--demo'] : [h]), '--days', String(o.days && o.days !== true ? o.days : 30), '--json'];
    if (model && gpu) ea.push('--self-host-model', model, '--gpu', gpu);
    if (cal && model && gpu && cal.sizer[`${gpu}|${model}`]) ea.push('--calibration', calFile);
    for (const k of ['gpu-rate', 'outcomes', 'tasks-per-day']) if (o[k] && o[k] !== true) ea.push('--' + k, String(o[k]));
    const e = run('harness-ledger', ['economics', ...ea]);
    if (e.error) out.account = { error: e.error };
    else {
      const S = e.selfHost || null;
      out.account = { harness: h, perResolvedTask: e.perResolved ? e.perResolved.costPerResolved ?? null : null, successRate: e.perResolved ? e.perResolved.successRate ?? null : null, monthly: e.volume ? e.volume.apiMonthly ?? null : null,
        selfHost: S && { model: S.model, gpu: S.gpu, gpus: S.gpus ?? null, bound: S.bound || null, calibrated: S.calibrated || null, breakEvenGpuRate: S.breakEvenGpuRate ?? null, cheaper: S.cheaper || null,
          kvOffload: S.offload ? { usable: !!S.offload.usable, gpus: S.offload.gpus ?? null, reloadMs: S.offload.reloadMs } : null,
          tokensPerSecPerMW: S.power ? S.power.tokensPerSecPerMW ?? null : null, powerKW: S.power ? S.power.kw : null } };
    }
  } else out.next.push('add --harness PATH (an agent trace harness-ledger reads) for cost per resolved task and self-hosting');
  return out;
}

// ---- render ---------------------------------------------------------------------------------------------------------
const pct = x => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
const money = x => (x == null || !Number.isFinite(x) ? '–' : x > 0 && x < 0.005 ? 'under $0.01' : x >= 100 ? '$' + Math.round(x).toLocaleString('en-US') : '$' + x.toFixed(2));
const when = t => (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');

export function render(r, { md = false } = {}) {
  const L = [], H = s => L.push(md ? `\n## ${s}\n` : `\n${s.toUpperCase()}`), li = s => L.push(md ? `- ${s}` : `  ${s}`);
  L.push(md ? `# AI infrastructure report${r.model ? `: ${r.model} on ${r.gpu}` : ''}` : `AI infrastructure report${r.model ? `: ${r.model} on ${r.gpu}` : ''}`);
  L.push(md ? `\nStore \`${r.store}\`` : `store ${r.store}`);
  H('Plan');
  const P = r.plan;
  if (!P) li('not sized (no model and GPU)');
  else {
    const s = P.sizer, c = P.calibrated;
    if (s && s.error) li(`sizer: ${s.error}`);
    else if (s) li(s.found ? `Inference Sizer: ${s.gpus} GPUs serving (${s.mode}), ${s.provisionedGpus} provisioned in ${s.nodes} nodes; ${money(s.costPerMOutputTokens)} per M output tokens at TTFT ${s.targets.ttftMs} ms / TPOT ${s.targets.tpotMs} ms` : 'Inference Sizer: no layout meets the targets');
    if (c && !c.error) li(c.found ? `with measured efficiencies: ${c.gpus} GPUs serving, ${c.provisionedGpus} provisioned (${c.provisionedGpus === s.provisionedGpus ? 'no change' : `${c.provisionedGpus > s.provisionedGpus ? '+' : ''}${c.provisionedGpus - s.provisionedGpus}`}); ${money(c.costPerMOutputTokens)} per M output tokens` : 'with measured efficiencies: no layout meets the targets');
    else if (c && c.error) li(`calibrated sizing: ${c.error}`);
    else li('no calibration for this model and GPU yet: uncalibrated estimate');
  }
  H('Verify');
  const V = r.verify;
  if (!V.last) li('no shadow verdict yet');
  else {
    const v = V.last;
    li(`last of ${V.verdicts} shadow verdict${V.verdicts > 1 ? 's' : ''} (${when(v.t)}, ${v.source}): **${v.decision}**: ${v.why}`.replace(/\*\*/g, md ? '**' : ''));
    li(`${v.baseline} → ${v.candidate}: ` + (Object.entries(v.metrics).map(([k, m]) => `${k} ${pct(m.effect)} ${m.verdict}`).join(', ') || 'no metric judged'));
    if (v.prediction) li(`prediction ${v.prediction.holds ? 'held' : 'was off'}: ` + v.prediction.rows.map(x => `${x.metric} predicted ${pct(x.predicted)}, measured ${pct(x.measured)}`).join('; '));
  }
  if (V.promoted) li(`last promotion ${when(V.promoted.t)}: ${V.promoted.label}${V.promoted.calibration ? ` (recalibrated ${V.promoted.calibration})` : ''}`);
  for (const c of V.canaries) li(`canary ${c.name} (${c.baseline} → ${c.candidate}): ${c.status}, candidate at ${c.share}%${c.awaitingApproval ? `; step to ${c.awaitingApproval.toShare}% awaiting a person's approval` : ''}`);
  H('Calibration');
  const C = r.calibration;
  if (!C.entries.length) li('none yet');
  for (const e of C.entries) li(`${e.key}: prefill ${e.effPrefill}, decode bandwidth ${e.effDecodeBW}, decode compute ${e.effDecodeComp}${e.fitOn ? ` (${e.fitOn}${e.t ? ', ' + when(e.t) : ''})` : ''}`);
  H('Account');
  const A = r.account;
  if (!A) li('no agent trace given (--harness)');
  else if (A.error) li(`economics: ${A.error}`);
  else {
    li(`${money(A.perResolvedTask)} per resolved task at the API${A.successRate != null ? ` (${(100 * A.successRate).toFixed(0)}% resolved)` : ''}${A.monthly != null ? `, ${money(A.monthly)} a month` : ''}`);
    const S = A.selfHost;
    if (S) {
      li(`self-hosting ${S.model} on ${S.gpu}: ${S.gpus ?? '–'} GPUs (bound by ${S.bound})${S.calibrated ? ', sized with the measured efficiencies' : ''}; cheaper per resolved task below ${money(S.breakEvenGpuRate)} a GPU-hour${S.cheaper ? ` (at the given rate: ${S.cheaper})` : ''}`);
      if (S.kvOffload && S.kvOffload.usable && S.kvOffload.gpus != null && S.gpus != null && S.kvOffload.gpus < S.gpus) li(`KV offload to host memory would bring it to ${S.kvOffload.gpus} GPUs (reload ${S.kvOffload.reloadMs.toFixed(0)} ms)`);
      if (S.tokensPerSecPerMW != null) li(`${Math.round(S.tokensPerSecPerMW).toLocaleString('en-US')} output tokens/s per MW at the peak minute (${S.powerKW.toFixed(0)} kW)`);
    }
  }
  if (r.next.length) { H('Next'); for (const n of r.next) li(n); }
  return L.join('\n').replace(/^\n/, '') + '\n';
}

// the loop on demo data, in a temporary store: shadow demo → plan (H100 → H200) → compare --plan (writes the calibration)
function demoStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiinfra-report-')), store = path.join(dir, 'store'), f = n => path.join(dir, n);
  fs.writeFileSync(f('b.json'), JSON.stringify({ model: 'llama33-70b', gpu: 'H100', tp: 4 })); fs.writeFileSync(f('c.json'), JSON.stringify({ model: 'llama33-70b', gpu: 'H200', tp: 4 }));
  for (const a of [['shadow', 'demo'], ['shadow', 'plan', '--baseline-config', f('b.json'), '--candidate-config', f('c.json'), '--baseline', 'variant=baseline', '--out', f('plan.json')],
    ['shadow', 'compare', '--baseline', 'variant=baseline', '--candidate', 'variant=candidate', '--plan', f('plan.json')]]) {
    const r = run('fleetops', [...a, '--store', store, '--json']); if (r.error) throw new Error(`demo: fleetops ${a.slice(0, 2).join(' ')}: ${r.error}`);
  }
  return store;
}

export function main(argv) {
  const o = args(argv);
  if (o.help) { process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n').split('\n\nThe report')[0] + '\n'); return 0; }
  if (o.demo) { o.store = demoStore(); if (!o.harness) o.harness = 'demo'; if (!o['gpu-rate']) o['gpu-rate'] = '3'; }
  const r = gather(o);
  if (o.demo) { fs.rmSync(path.dirname(o.store), { recursive: true, force: true }); r.store = '(demo, removed)'; }
  process.stdout.write(o.json ? JSON.stringify(r, null, 1) + '\n' : render(r, { md: o.format === 'md' }));
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { process.stderr.write('aiinfra report: ' + e.message + '\n'); process.exit(1); }
}
