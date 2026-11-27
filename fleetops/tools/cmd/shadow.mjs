// fleetops CLI: shadow (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import * as Sec from '../../src/security.mjs';
import * as Shadow from '../../src/shadow.mjs';
import * as Replay from '../../src/shadow-replay.mjs';
import * as SProm from '../../src/shadow-prom.mjs';
import * as Gate from '../../src/shadow-gate.mjs';
import * as Canary from '../../src/shadow-canary.mjs';
import { J, OUT, say, read, time, fmt, pctS } from './common.mjs';

// ---------- shadow upgrades ----------
export function selector(sel) {
  if (!sel) return () => true;
  const parts = String(sel).split(',').map(x => x.trim()).filter(Boolean).map(x => { const m = x.match(/^([\w.]+)(=|~)(.*)$/); if (!m) throw new Error(`selector "${x}": use field=value or field~regex`); return m[2] === '=' ? r => String(r[m[1]]) === m[3] : (re => r => re.test(String(r[m[1]] ?? '')))(new RegExp(m[3])); });
  return r => parts.every(f => f(r));
}
export function shadowText(r) {
  const L = [`${r.decision.toUpperCase()}: ${r.why}`, `${r.requests.baseline} baseline and ${r.requests.candidate} candidate requests, ${r.paired ? 'paired (the same requests on both)' : 'compared at matched load'}`, ''];
  L.push('  metric   candidate vs baseline (95% CI)          verdict        naive (no load matching)');
  for (const k of ['ttft', 'tpot', 'e2e']) { const m = r.metrics[k]; if (!m || m.verdict === 'no data') { L.push(`  ${k.padEnd(8)} no data`); continue; }
    L.push(`  ${k.padEnd(8)} ${pctS(m.effect).padStart(7)} (${pctS(m.lo)} to ${pctS(m.hi)})`.padEnd(51) + ` ${m.verdict.padEnd(14)} ${pctS(m.naive)}${m.coverage != null && m.coverage < 0.8 ? `   only ${(100 * m.coverage).toFixed(0)}% of baseline requests had matching load` : ''}${m.more ? `   ~${m.more} more per arm to settle` : ''}`); }
  if (r.metrics.errorRate) L.push(`  errors   ${(100 * r.metrics.errorRate.baseline).toFixed(2)}% → ${(100 * r.metrics.errorRate.candidate).toFixed(2)}%`.padEnd(52) + r.metrics.errorRate.verdict);
  if (r.metrics.tokPerGpuS) L.push(`  tok/s per GPU ${r.metrics.tokPerGpuS.baseline.toFixed(0)} → ${r.metrics.tokPerGpuS.candidate.toFixed(0)} (${pctS(r.metrics.tokPerGpuS.effect)}; ${r.metrics.tokPerGpuS.note})`);
  if (r.metrics.costPerMTok) L.push(`  $ per M output tokens ${r.metrics.costPerMTok.baseline.toFixed(2)} → ${r.metrics.costPerMTok.candidate.toFixed(2)} (${pctS(r.metrics.costPerMTok.effect)})   ${r.metrics.costPerMTok.verdict}`);
  if (r.answers) L.push(`  answers  ${r.answers.identical}/${r.answers.prompts} identical under greedy decoding; log-prob drift ${r.answers.meanAbsLogprobDiff != null ? r.answers.meanAbsLogprobDiff.toFixed(3) : '–'}   ${r.answers.verdict}`);
  if (r.prediction) L.push('', `  prediction ${r.prediction.holds ? 'holds' : 'is off: recalibrate'}: ` + r.prediction.rows.map(x => `${x.metric} predicted ${pctS(x.predicted)}, measured ${pctS(x.measured)}`).join('; '));
  if (r.infra) L.push('', '  infra: ' + Object.entries(r.infra).map(([k, v]) => v.effect != null ? `${k} ${pctS(v.effect)}` : `${k} ${v.baseline} → ${v.candidate}`).join(', '));
  return L.join('\n');
}
export async function shadowCmd(store, cmd, rest, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const from = time(opt('from')), to = time(opt('to'));
  const requests = sel => store.query('request', { from, to, where: selector(sel) });
  const dir = path.join(store.dir, 'shadow'); fs.mkdirSync(dir, { recursive: true });
  // the sizer calibration shadow verdicts keep: read by plan, the Inference Sizer (--calibration) and harness-ledger economics
  const calFile = () => opt('calibration') || path.join(store.dir, 'calibration', 'sizer.json');
  const calProfile = () => (fs.existsSync(calFile()) ? JSON.parse(read(calFile())) : null);
  const learn = (r, planObj, label) => {
    const out = [];
    if (planObj && !o['no-recalibrate']) {
      const rc = Shadow.recalibrate(planObj, r.metrics);
      if (rc && rc.changed) {
        const f = calFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
        const t = Math.floor(Date.now() / 1000), prof = Shadow.mergeProfile(calProfile(), rc, { fitOn: `shadow ${label}`, t });
        fs.writeFileSync(f, JSON.stringify(prof, null, 1) + '\n'); store.append('calibration', [{ t, target: `sizer:${rc.key}`, tool: 'inference-sizer', eff: rc.eff, before: rc.before, rows: rc.rows, source: 'fleetops-shadow', fitOn: label }]);
        out.push(`recalibrated ${rc.key} → ${f}: ` + rc.rows.filter(x => x.changed).map(x => `${x.metric} predicted ${pctS(x.predicted)}, measured ${pctS(x.measured)}`).join('; ') + ` (${Shadow.EFF_KEYS.filter(k => rc.before[k] !== rc.eff[k]).map(k => `${k} ${rc.before[k]}→${rc.eff[k]}`).join(', ')})`);
        r.recalibrated = rc;
      } else if (rc) for (const x of rc.rows.filter(y => y.note)) out.push(`${x.metric}: ${x.note}`);
    }
    // a promoted change's measured numbers go where planning and economics read them
    if (r.decision === 'promote') {
      const rec = { t: Math.floor(Date.now() / 1000), label, candidate: planObj && planObj.configs ? planObj.configs.candidate : null, effects: Object.fromEntries(['ttft', 'tpot', 'e2e', 'tokPerGpuS', 'costPerMTok'].filter(k => r.metrics[k] && Number.isFinite(r.metrics[k].effect)).map(k => [k, r.metrics[k].effect])),
        tokPerGpuS: r.metrics.tokPerGpuS ? r.metrics.tokPerGpuS.candidate : null, calibration: r.recalibrated ? r.recalibrated.key : null };
      fs.appendFileSync(path.join(dir, 'promoted.jsonl'), JSON.stringify(rec) + '\n'); out.push(`promoted: recorded in ${path.join(dir, 'promoted.jsonl')}${rec.calibration ? `; harness-ledger economics --calibration ${calFile()} uses it` : ''}`);
    }
    return out;
  };
  const readJsonl = f => read(f).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const traceRows = async f => { if (/\.json$/.test(f)) { const j = JSON.parse(read(f)); if (j.kind === 'fleetscope.agentic-profile') { const A = (await import('module')).createRequire(import.meta.url)('../../../fleetscope/src/agentic.js'); return A.synthesize(j, { sessionsPerHour: num('sessions-per-hour') || 600, horizonS: num('duration') || 600, seed: num('seed') || 1 }); } }
    const { loadRows } = await import('../../../fleetscope/tools/agentic.mjs'); return (await loadRows(f)).rows; };
  const arm = (name, url) => ({ name, url, model: opt('model'), apiKey: opt('api-key-env') ? process.env[opt('api-key-env')] : undefined });
  if (cmd === 'demo') {
    const d = Shadow.synth(); store.append('request', [...d.baseline, ...d.candidate]);
    if (J) { OUT.demo = { baseline: d.baseline.length, candidate: d.candidate.length }; return; }
    return say(`demo in ${store.dir}: ${d.baseline.length} baseline and ${d.candidate.length} candidate requests (variant field). The candidate is 8% slower at any load but got less than half the traffic.\ntry: fleetops shadow compare --baseline variant=baseline --candidate variant=candidate --store ${store.dir}`);
  }
  if (cmd === 'plan') {
    const prof = calProfile(), b0 = json('baseline-config'), c0 = json('candidate-config'); if (!b0 || !c0) throw new Error('--baseline-config b.json --candidate-config c.json: { model, gpu, tp, gpus?, rate? } (Inference Sizer ids)');
    const b = Shadow.applyCalibration(b0, prof), c = Shadow.applyCalibration(c0, prof);
    const reqs = opt('trace') ? await traceRows(opt('trace')) : requests(opt('baseline'));
    if (!reqs.length) throw new Error('no workload: give --trace FILE, or --baseline SEL with request records in the store');
    const w = Shadow.workloadOf(reqs.map(r => Object.assign({ e2e: r.e2e ?? r.api ?? 0 }, r))), p = Shadow.plan({ baseline: b, candidate: c, workload: w, delta: num('effect') ?? 0.03, rps: num('rps') });
    if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(p, null, 1) + '\n');
    if (J) { OUT.plan = p; return; }
    if (b.calibrated || c.calibrated) say(`calibrated from ${calFile()}: ${[b, c].filter(x => x.calibrated).map(x => `${x.gpu}|${x.model}`).join(', ')}`);
    return say(`predicted (candidate vs baseline at median prompt ${Math.round(w.isl)}, output ${Math.round(w.osl)}, cache hit ${w.prefixHit.toFixed(0)}%, ${w.inflight} in flight):\n  TTFT ${pctS(p.predicted.ttft)}, TPOT ${pctS(p.predicted.tpot)}, tokens/s per GPU ${pctS(p.predicted.tokPerGpuS)}${p.predicted.costPerMTok != null ? `, $ per M tokens ${pctS(p.predicted.costPerMTok)}` : ''}\ntest: ${p.test.requestsPerArm} requests per arm to see a ${(100 * p.test.delta).toFixed(0)}% effect${p.test.paired ? ' (paired replay)' : ''}${p.test.seconds ? `, about ${Math.ceil(p.test.seconds / 60)} min at ${opt('rps')} req/s` : ''}\n${p.note}${opt('out') ? `\n→ ${opt('out')}` : ''}`);
  }
  if (cmd === 'replay') {
    if (!opt('trace') || !opt('baseline') || !opt('candidate')) throw new Error('--trace FILE|profile.json --baseline URL --candidate URL [--live]');
    const reqs = Replay.requestsFrom(await traceRows(opt('trace')), { speed: num('speed') || 1, maxRequests: num('max-requests') ?? 1000, durationS: num('duration') ?? Infinity, maxIsl: num('max-isl') ?? Infinity, maxOsl: num('max-osl') ?? Infinity });
    const arms = [arm('baseline', opt('baseline')), arm('candidate', opt('candidate'))];
    const res = await Replay.run(reqs, arms, { live: !!o.live, maxInflight: num('max-inflight') || 64, model: opt('model'), exact: !o['no-exact-output'] });
    if (res.dryRun) { if (J) { OUT.replay = res; return; } return say(`dry run: ${res.plan.requests} requests (${res.plan.sessions} sessions) over ${Math.round(res.plan.seconds)} s; ${res.plan.note}.\nAdd --live to send them.`); }
    store.append('request', res.records, { source: 'shadow-replay' });
    if (opt('out')) fs.writeFileSync(opt('out'), res.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (J) { OUT.replay = { requests: res.records.length, errors: res.records.filter(r => r.error).length }; return; }
    return say(`${res.records.length} measurements (${res.records.filter(r => r.error).length} errors) in ${store.dir}${opt('out') ? ` and ${opt('out')}` : ''}\nnext: fleetops shadow compare --baseline variant=baseline,source=shadow-replay --candidate variant=candidate,source=shadow-replay --store ${store.dir}`);
  }
  if (cmd === 'answers') {
    if (!opt('baseline') || !opt('candidate')) throw new Error('--baseline URL --candidate URL [--prompts FILE] [--live]');
    const prompts = opt('prompts') ? read(opt('prompts')).split('\n').map(l => l.trim()).filter(Boolean).map(l => (l.startsWith('{') ? JSON.parse(l).prompt : l)) : Replay.PROMPTS;
    const res = await Replay.answers([arm('baseline', opt('baseline')), arm('candidate', opt('candidate'))], { prompts, live: !!o.live, model: opt('model'), maxTokens: num('max-tokens') || 64 });
    if (opt('out') && !res.dryRun) fs.writeFileSync(opt('out'), JSON.stringify(res, null, 1) + '\n');
    if (J) { OUT.answers = res; return; }
    return say(res.dryRun ? `dry run: ${res.note}. Add --live to send them.` : `${res.identical}/${res.prompts} identical; first divergence at token ${res.meanFirstDivergence ?? '–'} on average; log-prob drift ${res.meanAbsLogprobDiff != null ? res.meanAbsLogprobDiff.toFixed(4) : '–'}${opt('out') ? ` → ${opt('out')}` : ''}`);
  }
  if (cmd === 'compare') {
    let base, cand;
    if (opt('results')) { const rs = readJsonl(opt('results')); base = rs.filter(r => r.variant === 'baseline'); cand = rs.filter(r => r.variant === 'candidate'); }
    else { if (!opt('baseline') || !opt('candidate')) throw new Error('--results FILE, or --baseline SEL --candidate SEL'); base = requests(opt('baseline')); cand = requests(opt('candidate')); }
    if (!base.length || !cand.length) throw new Error(`no requests: ${base.length} baseline, ${cand.length} candidate`);
    const plan = json('plan'), re = k => (opt(k) ? new RegExp(opt(k)) : null);
    const r = Shadow.compare(base, cand, { gates: json('gates'), predicted: plan && plan.predicted, answers: json('answers'),
      baseline: { gpus: num('baseline-gpus'), rate: num('baseline-rate') }, candidate: { gpus: num('candidate-gpus'), rate: num('candidate-rate') },
      infra: opt('baseline-nodes') ? Shadow.infraSignals(store, { baselineNodes: re('baseline-nodes'), candidateNodes: re('candidate-nodes'), from, to }) : null });
    fs.appendFileSync(path.join(dir, 'verdicts.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), baseline: opt('baseline') || opt('results'), candidate: opt('candidate') || opt('results'), decision: r.decision, why: r.why, metrics: r.metrics }) + '\n');
    const learned = learn(r, plan, `${opt('baseline') || opt('results')} → ${opt('candidate') || ''}`);
    if (J) { OUT.shadow = r; return; }
    return say(shadowText(r) + (learned.length ? '\n\n' + learned.join('\n') : ''));
  }
  if (cmd === 'baseline') {
    const bdir = path.join(dir, 'baselines'); fs.mkdirSync(bdir, { recursive: true });
    if (rest[0] === 'list' || !rest[0]) { const xs = fs.readdirSync(bdir).filter(f => f.endsWith('.jsonl')).map(f => { const ls = readJsonl(path.join(bdir, f)); const b = ls[ls.length - 1]; return { name: b.name, saved: fmt(b.t), requests: b.requests, versions: ls.length }; }); if (J) { OUT.baselines = xs; return; } return say(xs.length ? xs.map(x => `${x.name}  ${x.requests} requests, saved ${x.saved} (${x.versions} version${x.versions > 1 ? 's' : ''})`).join('\n') : 'no baselines yet: fleetops shadow baseline save --name NAME --select SEL'); }
    if (rest[0] === 'save') { if (!opt('name') || !opt('select')) throw new Error('--name NAME --select SEL'); const rs = requests(opt('select')); if (!rs.length) throw new Error('no requests match'); const b = Shadow.makeBaseline(opt('name'), rs, { meta: { select: opt('select'), from, to } }); fs.appendFileSync(path.join(bdir, opt('name').replace(/[^\w.-]/g, '_') + '.jsonl'), JSON.stringify(b) + '\n'); if (J) { OUT.baseline = { name: b.name, requests: b.requests, sample: b.sample.length }; return; } return say(`saved baseline ${b.name}: ${b.sample.length} of ${b.requests} requests`); }
    throw new Error('fleetops shadow baseline save --name NAME --select SEL | list');
  }
  if (cmd === 'watch') {
    if (!opt('name') || !opt('select')) throw new Error('--name NAME --select SEL [--from T --to T]');
    const f = path.join(dir, 'baselines', opt('name').replace(/[^\w.-]/g, '_') + '.jsonl'); if (!fs.existsSync(f)) throw new Error(`no baseline ${opt('name')}: fleetops shadow baseline save first`);
    const ls = readJsonl(f), b = ls[ls.length - 1], cur = requests(opt('select')); if (!cur.length) throw new Error('no current requests match');
    const r = Shadow.drift(b, cur), hist = path.join(dir, 'watch-' + opt('name').replace(/[^\w.-]/g, '_') + '.jsonl');
    fs.appendFileSync(hist, JSON.stringify({ t: Math.floor(Date.now() / 1000), from, to, metrics: Object.fromEntries(Object.entries(r.metrics).map(([k, v]) => [k, v.effect])), drifted: r.drifted }) + '\n');
    const past = readJsonl(hist).slice(-8);
    if (J) { OUT.watch = Object.assign(r, { history: past }); return; }
    return say(`${r.note} (${r.current} requests vs baseline ${b.name} of ${fmt(b.t)})\n` + ['ttft', 'tpot', 'e2e'].map(k => { const m = r.metrics[k]; return `  ${k.padEnd(5)} ${pctS(m.effect)} (${pctS(m.lo)} to ${pctS(m.hi)}) ${m.verdict}`; }).join('\n') + `\n  last ${past.length} checks, TPOT: ${past.map(x => pctS(x.metrics.tpot)).join('  ')}`);
  }
  if (cmd === 'prom') {
    let d, saved = null;
    const promHeaders = () => (opt('prom-token-env') ? { authorization: `Bearer ${process.env[opt('prom-token-env')] || ''}` } : undefined);
    if (o.demo) { const w = SProm.synthWindows(); d = { baseline: w.baseline, candidate: w.candidate, step: w.step }; }
    else if (opt('file')) { saved = JSON.parse(read(opt('file'))); d = Object.assign({ step: saved.step }, SProm.fromSaved(saved)); }
    else {
      if (!opt('prom') || !opt('baseline') || !opt('candidate')) throw new Error("--prom URL --baseline 'matchers' --candidate 'matchers' (or --file saved.json, or --demo)");
      const now = Math.floor(Date.now() / 1000), step = num('step') || 60, t1 = to ?? now, t0 = from ?? t1 - (num('lookback') || 3600);
      saved = await SProm.fetchArms(opt('prom'), { select: opt('select'), baseline: opt('baseline'), candidate: opt('candidate'), from: t0, to: t1, baselineFrom: num('baseline-lookback') ? t1 - num('baseline-lookback') : t0, step, headers: promHeaders() });
      d = saved;
      if (opt('save')) { const { baseline: _b, candidate: _c, ...keep } = saved; fs.writeFileSync(opt('save'), JSON.stringify(keep) + '\n'); } // the series, not the windows derived from them
    }
    if (!d.baseline.length || !d.candidate.length) throw new Error(`no windows with requests: ${d.baseline.length} baseline, ${d.candidate.length} candidate (check the selectors and the time range)`);
    const planObj = json('plan');
    const r = SProm.compareWindows(d.baseline, d.candidate, { step: d.step, gates: json('gates'), predicted: planObj && planObj.predicted, baseline: { gpus: num('baseline-gpus'), rate: num('baseline-rate') }, candidate: { gpus: num('candidate-gpus'), rate: num('candidate-rate') } });
    fs.appendFileSync(path.join(dir, 'verdicts.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), source: 'prometheus', baseline: (saved && saved.selectors && saved.selectors.baseline) || (o.demo ? 'demo' : opt('file')), candidate: (saved && saved.selectors && saved.selectors.candidate) || (o.demo ? 'demo' : opt('file')), decision: r.decision, why: r.why, metrics: r.metrics }) + '\n');
    const learned = learn(r, planObj, `prometheus ${(saved && saved.selectors && saved.selectors.candidate) || (o.demo ? 'demo' : opt('file'))}`);
    if (J) { OUT.shadow = r; return; }
    const L = r.load, ld = x => `${x.windows} windows, ${x.requests} requests, ${x.concPerEngine.toFixed(1)} in flight per engine, prompt ${Math.round(x.isl || 0)}, cache hit ${x.hit != null && Number.isFinite(x.hit) ? (100 * x.hit).toFixed(0) + '%' : '–'}${Number.isFinite(x.ttftP95) ? `, TTFT p95 ${x.ttftP95.toFixed(2)} s (median window; shown, not judged)` : ''}`;
    const text = shadowText(Object.assign({}, r, { paired: false })).split('\n');
    text[1] = `baseline: ${ld(L.baseline)}\ncandidate: ${ld(L.candidate)}\neach canary window against the baseline at the same load (median of windows shown)`;
    return say(text.join('\n').replace(/requests had matching load/g, 'canary traffic was within the baseline\'s load range').replace(/more per arm to settle/g, 'more minutes to settle') + (learned.length ? '\n\n' + learned.join('\n') : ''));
  }
  if (cmd === 'serve') {
    if (!opt('prom')) throw new Error('--prom URL (the Prometheus that scrapes both versions)');
    const port = num('port') || 9410, host = opt('host') || '127.0.0.1', tokens = opt('tokens') ? Sec.loadTokens(opt('tokens')) : null;
    if (!tokens && !['127.0.0.1', 'localhost', '::1'].includes(host) && !o['no-auth']) throw new Error(`--host ${host} needs --tokens FILE (or --no-auth on a network only the rollout controller reaches: Flagger webhooks can't send a token)`);
    const step = num('step') || 60, headers = opt('prom-token-env') ? { authorization: `Bearer ${process.env[opt('prom-token-env')] || ''}` } : undefined;
    const defaults = { select: opt('select'), baseline: opt('baseline'), candidate: opt('candidate'), lookback: num('lookback') || 900, baselineLookback: num('baseline-lookback') || 21600 };
    for (const k of Object.keys(defaults)) if (defaults[k] == null) delete defaults[k];
    const evaluate = async p => {
      const now = Math.floor(Date.now() / 1000), d = await SProm.fetchArms(opt('prom'), { select: p.select, baseline: p.baseline, candidate: p.candidate, from: now - p.lookback, to: now, baselineFrom: now - Math.max(p.lookback, p.baselineLookback), step, headers });
      return SProm.compareWindows(d.baseline, d.candidate, { step, gates: json('gates') });
    };
    const logf = path.join(dir, 'gate.jsonl'), srv = Gate.gateServer(evaluate, { tokens, defaults, log: e => fs.appendFileSync(logf, JSON.stringify(e) + '\n') });
    await new Promise(r => srv.listen(port, host, r));
    console.log(`shadow judge on http://${host}:${port}  prometheus ${opt('prom')}  ${tokens ? `${tokens.length} token(s)` : 'open (no tokens)'}\n  POST /verdict (Argo Rollouts web metric)  POST /flagger/rollout  POST /flagger/confirm-promotion  GET /verdict?baseline=…&candidate=…  GET /healthz\n  canary window ${defaults.lookback} s, baseline history ${defaults.baselineLookback} s; decisions → ${logf}`);
    const stop = () => { srv.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return new Promise(() => {});
  }
  if (cmd === 'canary') {
    const sub = rest[0], cdir = path.join(dir, 'canaries'); fs.mkdirSync(cdir, { recursive: true });
    const nm = opt('name'); if (!nm) throw new Error('--name NAME');
    const file = path.join(cdir, nm.replace(/[^\w.-]/g, '_') + '.json'), audit = e => fs.appendFileSync(file.replace(/\.json$/, '.audit.jsonl'), JSON.stringify(Object.assign({ t: Math.floor(Date.now() / 1000) }, e)) + '\n');
    const load = () => { if (!fs.existsSync(file)) throw new Error(`no canary ${nm}: fleetops shadow canary start first`); return JSON.parse(read(file)); };
    const save = st => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st, null, 1)); fs.renameSync(tmp, file); };
    const kubectl = opt('kubectl') || 'kubectl', show = r => (r.dryRun ? `dry run (add --live to write):\n${r.commands.map(c => '  ' + c.map(x => (/[\s{}"]/.test(x) ? `'${x}'` : x)).join(' ')).join('\n')}` : `written: ${r.commands.map(c => `${c[3]} → ${JSON.parse(c[9]).spec.router.route.weight}`).join(', ')}`);
    if (sub === 'start') {
      if (fs.existsSync(file) && !o.force) throw new Error(`canary ${nm} exists (status ${load().status}); --force to start over`);
      const st = Canary.start({ name: nm, namespace: opt('namespace') || 'default', group: opt('group'), baseline: opt('baseline'), candidate: opt('candidate'), steps: opt('steps') ? opt('steps').split(',').map(Number) : undefined, bakeS: num('bake') ?? 600 });
      const r = Canary.apply(st, Canary.share(st), { live: !!o.live, kubectl });
      if (!r.dryRun) { save(st); audit({ event: 'start', share: Canary.share(st) }); } // a dry run starts nothing
      if (J) { OUT.canary = { state: st, apply: r }; return; }
      return say(`canary ${nm}: ${st.candidate} at ${Canary.share(st)}% of ${st.group}, ${st.baseline} the rest; steps ${st.steps.join(', ')}%\n${show(r)}`);
    }
    if (sub === 'status') { const st = load(); if (J) { OUT.canary = st; return; } return say(`${nm}: ${st.status}, ${st.candidate} at ${Canary.share(st)}% since ${fmt(st.since)}${st.pending ? `; step to ${st.steps[st.pending.toStep]}% ${st.pending.approvedBy ? `approved by ${st.pending.approvedBy}, written by the next advance --live` : 'waits for approval'}` : ''}\n` + st.history.slice(-8).map(h => `  ${fmt(h.t)}  ${h.event}${h.to != null ? ` → ${h.to}%` : ''}${h.by || h.approvedBy ? ` (${h.by || h.approvedBy})` : ''}${h.why ? `: ${h.why}` : ''}`).join('\n')); }
    if (sub === 'approve') { const st = Canary.approve(load(), opt('by')); save(st); audit({ event: 'approved', by: opt('by'), to: st.steps[st.pending.toStep] }); if (J) { OUT.canary = st; return; } return say(`approved by ${opt('by')}: the step to ${st.steps[st.pending.toStep]}% is written by the next fleetops shadow canary advance --name ${nm} --live`); }
    if (sub === 'advance') {
      const st = load(), now = Math.floor(Date.now() / 1000), sel = Canary.selectors(st), lookback = Math.max(300, now - st.since);
      let v;
      if (st.status !== 'running') v = { verdict: 'wait', why: `canary is ${st.status}` };
      else if (opt('judge')) { const r = await fetch(opt('judge').replace(/\/$/, '') + '/verdict', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, opt('judge-token-env') ? { authorization: `Bearer ${process.env[opt('judge-token-env')] || ''}` } : {}), body: JSON.stringify(Object.assign({}, sel, { lookback, baselineLookback: num('baseline-lookback') || 21600 })) }); if (!r.ok) throw new Error(`judge: HTTP ${r.status} ${await r.text()}`); v = await r.json(); }
      else if (opt('prom')) { const step = num('step') || 60, d = await SProm.fetchArms(opt('prom'), Object.assign({}, sel, { from: now - lookback, to: now, baselineFrom: now - Math.max(lookback, num('baseline-lookback') || 21600), step, headers: opt('prom-token-env') ? { authorization: `Bearer ${process.env[opt('prom-token-env')] || ''}` } : undefined })); v = SProm.compareWindows(d.baseline, d.candidate, { step, gates: json('gates') }); }
      else throw new Error('--prom URL (Prometheus scraping both members) or --judge URL (fleetops shadow serve)');
      const { state, action } = Canary.decide(st, v.verdict, { now, why: v.why });
      const r = action.patch ? Canary.apply(state, action.share, { live: !!o.live, kubectl }) : null;
      // a step written only in a dry run hasn't happened: keep the approval for the live run
      if (r && r.dryRun && action.type === 'apply') { if (J) { OUT.canary = { verdict: v.verdict, why: v.why, action, apply: r }; return; } return say(`${v.verdict}: ${action.note}\n${show(r)}`); }
      if (r && r.dryRun && action.type === 'rollback') { audit({ event: 'rollback-dry-run', why: v.why }); if (J) { OUT.canary = { verdict: v.verdict, why: v.why, action, apply: r }; return; } return say(`ROLL BACK (${v.why})\n${show(r)}`); }
      save(state); audit({ event: action.type, verdict: v.verdict, why: v.why, live: !!o.live, share: Canary.share(state) });
      if (J) { OUT.canary = { verdict: v.verdict, why: v.why, action, apply: r, state }; return; }
      return say(`${v.verdict}${v.why ? ` (${v.why})` : ''}: ${action.note || action.type}${r ? `\n${show(r)}` : ''}`);
    }
    throw new Error('fleetops shadow canary start | advance | approve | status');
  }
  throw new Error('fleetops shadow demo | plan | replay | answers | compare | baseline save|list | watch | prom | serve | canary');
}
