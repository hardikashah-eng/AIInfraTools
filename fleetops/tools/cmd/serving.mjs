// fleetops CLI: serving (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import * as Serving from '../../src/serving.mjs';
import { createRequire } from 'node:module';
import { J, OUT, say, read, time } from './common.mjs';

export async function servingCmd(store, cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const f1 = v => (v == null ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 1 : 2));
  if (cmd === 'models') { const ms = Serving.models(); if (J) { OUT.models = ms; return; } for (const m of ms) say(`${m.id.padEnd(18)} ${String(m.params).padStart(7)}B${m.active !== m.params ? ` (${m.active}B active)` : ''}  ctx ${m.maxCtx}  ${m.hf || ''}`); return; }
  if (cmd === 'gpus') { const gs = Serving.gpus(); if (J) { OUT.gpus = gs; return; } for (const g of gs) say(`${g.id.padEnd(12)} ${g.label} · ${g.hbmGB} GB · ${g.perNode} per node${g.price ? ` · $${g.price}/GPU-h` : ''}`); return; }
  const FIT = createRequire(import.meta.url)('../../../inference-sizer/src/fit.js');
  // workload: measured from a pool in the store, or given
  let wl = { isl: num('isl') || 2000, osl: num('osl') || 400, islP99: num('isl-p99'), oslP99: num('osl-p99'), rate: num('rate') };
  if (opt('from-pool')) {
    const to = Math.floor(Date.now() / 1000), m = Serving.workloadFromStore(store, opt('from-pool'), { from: time(opt('from')) ?? to - 7 * 86400, to: time(opt('to')) ?? to });
    if (!m) throw new Error(`fewer than 50 requests for pool ${opt('from-pool')} in the store (import request logs first)`);
    wl = Object.assign(m, { rate: num('rate') ?? m.rate });
    say(`workload ${m.source}: ISL ${Math.round(m.isl)} (p99 ${Math.round(m.islP99)}), OSL ${Math.round(m.osl)} (p99 ${Math.round(m.oslP99)}), p99 load ${m.rate.toFixed(2)} req/s`);
  }
  const tg = { ttftS: num('ttft') || 2, tpotS: num('tpot') || 0.05 };
  const hw = { gpu: opt('gpu'), nodes: num('nodes'), gpus: num('gpus'), gpusPerNode: num('gpus-per-node') };
  if (cmd === 'fit') {
    if (!hw.gpu || (hw.nodes == null && hw.gpus == null)) throw new Error('fleetops serving fit --gpu G --nodes N (or --gpus N)');
    if (hw.nodes == null) delete hw.nodes;
    const r = FIT.fitModels(hw, wl, tg, { rank: opt('rank'), prompt: !!o.prompt });
    if (J) { OUT.fit = r; return; }
    say(`${hw.nodes != null ? `${hw.nodes} node(s)` : `${hw.gpus} GPUs`} of ${hw.gpu}; ISL ${Math.round(wl.isl)} / OSL ${Math.round(wl.osl)} tokens; TTFT ≤ ${tg.ttftS}s, TPOT ≤ ${tg.tpotS * 1000}ms${wl.rate ? `; needs ${wl.rate} req/s` : ''}`);
    say(`ranked by ${r.rank === 'largest' ? 'size among the models that carry the load (size is a proxy for capability, not a quality score)' : 'requests per second'}\n`);
    say(`${'model'.padEnd(18)} ${'params'.padStart(8)}  ${'req/s'.padStart(8)}  ${'edge'.padStart(8)}  ${'out tok/s'.padStart(10)}  ${'$/1M out'.padStart(8)}  layout`);
    for (const x of r.rows) {
      const p = x.production, L = p.layout;
      say(`${(r.need && x.meetsRate ? '✓ ' : r.need ? '  ' : '') + x.model.padEnd(r.need ? 16 : 18)} ${(x.params + 'B').padStart(8)}  ${f1(p.rate).padStart(8)}  ${f1(x.edge.rate).padStart(8)}  ${f1(p.outTokensPerS).padStart(10)}  ${(p.dollarsPerMOut ? '$' + p.dollarsPerMOut.toFixed(2) : '–').padStart(8)}  ${L ? `${L.mode === 'agg' ? `${L.instances} × ${L.label}` : `P ${L.prefill.instances}×${L.prefill.label} / D ${L.decode.instances}×${L.decode.label}`}` : (p.why || '')}`);
    }
    say(`\nreq/s: production (15% headroom, an N+1 spare, 10% under the targets); edge: none of those. Spec-sheet efficiencies unless calibrated (fleetops calibrate).`);
    return;
  }
  if (cmd === 'capacity') {
    if (!opt('model') || !hw.gpu || (hw.nodes == null && hw.gpus == null)) throw new Error('fleetops serving capacity --model M --gpu G --nodes N (or --gpus N)');
    if (hw.nodes == null) delete hw.nodes;
    const c = FIT.capacity(opt('model'), hw, wl, tg, {});
    if (J) { OUT.capacity = Object.assign({}, c, { production: Object.assign({}, c.production, { usersAt: undefined }) }); return; }
    const p = c.production, L = p.layout;
    say(`${c.name} on ${c.gpus} ${c.gpu}; ISL ${Math.round(c.wl.isl)} / OSL ${Math.round(c.wl.osl)}; TTFT ≤ ${c.tg.ttftS}s, TPOT ≤ ${c.tg.tpotS * 1000}ms`);
    if (!p.rate) { say(`  doesn't fit: ${p.why}${c.edge.rate ? ` (without headroom and the spare it carries ${f1(c.edge.rate)} req/s)` : ''}`); return; }
    say(`  max load:        ${f1(p.rate)} req/s in production (${f1(c.edge.rate)} at the edge), ${f1(p.outTokensPerS)} output tokens/s`);
    say(`  users:           ~${f1(p.usersAt(20))} daily active users at 20 requests each, if the load were flat (peaks need more)`);
    say(`  concurrency:     ${L.concurrency} sequences in flight (${L.instances} instance(s) × ${Math.round(L.concurrency / L.instances)})`);
    say(`  layout:          ${L.mode === 'agg' ? `${L.instances} × ${L.label} (${L.gpusPerInstance} GPU(s) each)` : `prefill ${L.prefill.instances}×${L.prefill.label}, decode ${L.decode.instances}×${L.decode.label}`}, ${p.nodes} node(s) with the spare`);
    say(`  longest prompt:  ${c.maxPrompt ? `${c.maxPrompt.toLocaleString('en-US')} tokens at light load (model maximum ${c.modelMaxCtx.toLocaleString('en-US')})` : 'none fits'}`);
    if (p.dollarsPerMOut) say(`  cost:            $${p.dollarsPerMOut.toFixed(2)} per million output tokens at that load (catalog price)`);
    say(`  ${p.reason}`);
    return;
  }
  if (cmd === 'delete') {
    const name = o._[2], ns = opt('namespace') || 'serving', f = path.join(store.dir, 'serving', `${name}.yaml`);
    if (!name) throw new Error('fleetops serving delete NAME [--namespace serving] [--apply]');
    const argv = fs.existsSync(f) ? ['delete', '-f', f, '--ignore-not-found'] : ['-n', ns, 'delete', 'deployment,leaderworkerset,service,scaledobject', '-l', `app=${name}`, '--ignore-not-found'];
    const routerValues = path.join(store.dir, 'serving', `${name}.router.values.yaml`), helmArgv = fs.existsSync(routerValues) ? ['uninstall', name, '-n', ns] : null;
    if (!o.apply) { say(`would run: kubectl ${argv.join(' ')}${helmArgv ? `\n           helm ${helmArgv.join(' ')}  (the llm-d router)` : ''}\nadd --apply to delete`); return; }
    const r = Serving.kubectl(argv); if (r.code !== 0) throw new Error(r.err.trim());
    if (helmArgv) { const h = Serving.helmRun(helmArgv); if (h.code !== 0) say(`helm uninstall: ${h.err.trim()}`); else fs.rmSync(routerValues); }
    for (const reg of ['pools.json', 'targets.json']) { const p = path.join(store.dir, 'serving', reg); if (fs.existsSync(p)) { const x = JSON.parse(read(p)); delete x[name]; fs.writeFileSync(p, JSON.stringify(x, null, 1)); } }
    say(r.out.trim()); return;
  }
  if (cmd !== 'deploy') throw new Error(`unknown: serving ${cmd || ''} (models, gpus, fit, capacity, deploy, delete)`);
  const d = Serving.planDeployment({ model: opt('model'), gpu: opt('gpu'), nodes: hw.nodes, gpus: hw.gpus, gpusPerNode: hw.gpusPerNode, rate: wl.rate, isl: wl.isl, osl: wl.osl, islP99: wl.islP99, oslP99: wl.oslP99, ttftS: tg.ttftS, tpotS: tg.tpotS,
    name: opt('name'), namespace: opt('namespace'), image: opt('image'), hf: opt('hf'), hfSecret: opt('hf-secret'), cachePvc: opt('cache-pvc'), maxModelLen: num('max-model-len'), autoscale: !!o.autoscale, prometheus: opt('prometheus'),
    minReplicas: num('min-replicas'), maxReplicas: num('max-replicas'), createNamespace: !!o['create-namespace'], weights: opt('weights'), kvDtype: opt('kv-dtype'), mode: opt('mode'), routerVersion: opt('router-version'), sidecarImage: opt('sidecar-image'), gaieVersion: opt('gaie-version') });
  if (opt('out')) { fs.writeFileSync(opt('out'), d.yaml); if (d.router) fs.writeFileSync(opt('out').replace(/(\.ya?ml)?$/, '.router.values.yaml'), d.router.yaml); }
  if (!J) {
    say(`${d.name}: ${d.model} (${d.hf}) on ${d.gpu}, ${d.sized.basis}`);
    if (d.mode === 'disagg') say(`  disaggregated on llm-d: prefill ${d.layout.prefill.instances} × TP${d.layout.prefill.tp}, decode ${d.layout.decode.instances} × TP${d.layout.decode.tp} (max-num-seqs ${d.layout.decode.maxNumSeqs}) = ${d.layout.gpus} GPUs; max-model-len ${d.layout.maxModelLen}; TTFT ≤ ${d.targets.ttftS}s, TPOT ≤ ${d.targets.tpotS * 1000}ms\n  router: helm upgrade --install ${d.router.release} ${d.router.chart} --version ${d.router.version} -n ${d.namespace} -f <router values>`);
    else say(`  ${d.layout.instances} × TP${d.multiNode ? `${d.layout.gpusPerInstance / d.nodesPerInstance} × PP${d.nodesPerInstance} (LeaderWorkerSet, ${d.nodesPerInstance} nodes each)` : d.layout.tp + (d.layout.pp > 1 ? ` × PP${d.layout.pp}` : '')} = ${d.layout.gpus} GPUs; max-num-seqs ${d.layout.maxNumSeqs}, max-model-len ${d.layout.maxModelLen}; TTFT ≤ ${d.targets.ttftS}s, TPOT ≤ ${d.targets.tpotS * 1000}ms`);
    for (const n of d.notes) say(`  note: ${n}`);
    if (!o.apply && !opt('out')) say(`\n${d.yaml}${d.router ? `\n# llm-d router values (${d.router.chart})\n${d.router.yaml}` : ''}`);
    else if (opt('out')) say(`  wrote ${opt('out')}${d.router ? ` and ${opt('out').replace(/(\.ya?ml)?$/, '.router.values.yaml')}` : ''}`);
    if (d.prereqs && !o.apply) say(`  prerequisites (once per cluster; install-serving.sh --install-prereqs runs them):\n${d.prereqs.map(c => `    ${c.join(' ')}`).join('\n')}`);
  }
  const log = (s, x) => {
    if (J) return;
    if (s === 'preflight') for (const c of x.checks) say(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    else if (s === 'apply') say(`  applied${x.out ? `:\n    ${x.out.replace(/\n/g, '\n    ')}` : ''}`);
    else if (s === 'router') say(`  llm-d router ${x.code === 0 ? 'installed' : 'failed'}`);
    else if (s === 'wait') say(`  ${x.code === 0 ? 'ready' : 'not ready'}${x.out && x.out.includes('pods') ? `: ${x.out}` : ''}`);
    else if (s === 'smoke') say(x.ok ? `  smoke test: ${x.models.join(', ')} answered "${x.text}" (first response ${x.firstByteMs} ms)` : `  smoke test failed: ${x.error}`);
    else if (s === 'register') say(x.pools ? `  registered: ${x.pools} (tune and the agent see the pool)` : '');
  };
  const r = await Serving.deploy(d, { apply: !!o.apply, endpoint: opt('endpoint'), waitS: num('wait') || 2400, registerDir: path.join(store.dir, 'serving'), log });
  if (J) { OUT.deploy = Object.assign({ plan: Object.assign({}, d, { docs: undefined }) }, r); return; }
  if (r.dryRun) say(`\ndry run: nothing applied. Add --apply to deploy${r.steps[0].ready ? '' : ' (fix the failed checks first)'}.`);
  if (r.error) throw new Error(r.error);
  if (r.ok) say(`\n${d.name} is serving: kubectl -n ${d.namespace} port-forward svc/${d.service || d.name} 8000:${d.servicePort || 8000}, then the OpenAI API at http://127.0.0.1:8000/v1 (model "${d.model}")`);
}
