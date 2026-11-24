import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rateCard, gpuKey, classify, lostSpan, attribute, POLICY } from '../src/core.mjs';
import { ledger, groupBy, budgets, loaded, periods } from '../src/ledger.mjs';
import { insights, sizerFrom } from '../src/insights.mjs';
import { focusRows, focusCsv, showbackCsv, reportText, FOCUS_COLUMNS } from '../src/export.mjs';
import { html } from '../src/html.mjs';
import * as A from '../src/adapters.mjs';
import { demo } from '../src/demo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), FX = path.join(here, 'fixtures'), cli = path.join(here, '..', 'tools', 'ledger.mjs'), run = promisify(execFile);
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8'), fj = f => JSON.parse(fx(f));
const H = 3600, T0 = Date.UTC(2026, 10, 10) / 1000, close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

test('rates: on-prem is capex over its life + power × PUE + opex, per GPU-hour; list prices pass through', () => {
  const c = rateCard({ gpus: { H100: { onprem: { capex: 35040, years: 4, watts: 1000, pue: 1.5, kwh: 0.1, opexYear: 876 }, cloud: 2.5 } } });
  close(c.H100.onprem.parts.capex, 1); close(c.H100.onprem.parts.power, 0.15); close(c.H100.onprem.parts.opex, 0.1); close(c.H100.onprem.rate, 1.25);
  assert.deepEqual(c.H100.cloud, { rate: 2.5, basis: 'list' });
  assert.equal(gpuKey('NVIDIA-H100-80GB-HBM3'), 'H100'); assert.equal(gpuKey('NVIDIA-A100-SXM4-40GB'), 'A100-40GB'); assert.equal(gpuKey('NVIDIA-A100-SXM4-80GB'), 'A100');
  assert.equal(gpuKey('h200'), 'H200'); assert.equal(gpuKey('AMD Instinct MI300X'), 'MI300X'); assert.equal(gpuKey('Tesla V100-SXM2-32GB'), 'V100'); assert.equal(gpuKey('mystery'), 'mystery');
});

test('classes add up to the allocation; a failure loses the tail, by the best evidence available', () => {
  const base = { start: T0, end: T0 + 10 * H, gpus: 8, status: 'failed' };
  assert.deepEqual(lostSpan(Object.assign({ checkpoint: { lastAt: T0 + 9 * H } }, base), 10 * H), { s: H, basis: 'since last checkpoint' });
  assert.equal(lostSpan(Object.assign({ checkpoint: { intervalS: 2 * H } }, base), 10 * H).s, H);
  assert.equal(lostSpan(Object.assign({}, base, { end: T0 + 1800 }), 1800).basis, 'short run: all of it');
  assert.equal(lostSpan(base, 10 * H).s, POLICY.assumedTailS);
  assert.equal(lostSpan(Object.assign({}, base, { status: 'cancelled' }), 10 * H).s, 0, 'cancelled counts as useful by default');
  assert.equal(lostSpan(Object.assign({}, base, { status: 'cancelled' }), 10 * H, Object.assign({}, POLICY, { cancelled: 'lost-tail' })).s, POLICY.assumedTailS);
  const c = classify(Object.assign({ util: { busy: 0.75 } }, base));
  close(c.useful + c.idle + c.lost, c.alloc); close(c.idle, 0.25 * 80 * H); close(c.lost, 8 * 1800 * 0.75);
  // windows: the lost tail falls in the window holding the end, not spread over the run
  const early = classify(base, { from: T0, to: T0 + 5 * H }), late = classify(base, { from: T0 + 5 * H, to: T0 + 10 * H });
  assert.equal(early.lost, 0); close(late.lost, 8 * 1800);
});

test('a job that failed every attempt lost all of it; retries that later succeed lose only tails', () => {
  const recs = [0, 1, 2].map(i => ({ id: `a${i}`, group: 'sweep', start: T0 + i * 3 * H, end: T0 + i * 3 * H + 2 * H, gpus: 8, status: 'failed' }));
  const L = ledger(recs, {}); close(L.totals.lost, L.totals.alloc);
  const L2 = ledger(recs.concat([{ id: 'ok', group: 'sweep', start: T0 + 9 * H, end: T0 + 11 * H, gpus: 8, status: 'succeeded' }]), {});
  close(L2.totals.lost, 3 * 8 * 1800);
});

test('attribution: fields, directory, rules, team→org, use case from names, shared', () => {
  const cfg = { directory: { alice: { team: 'nlp', org: 'research' } }, rules: [{ match: { namespace: '^prod-' }, set: { org: 'product' } }], teams: { infra: 'platform' }, shared: [{ match: { namespace: '^kube-system$' } }] };
  const a = attribute({ labels: { owner: 'alice' }, namespace: 'scratch', name: 'jupyter-1' }, cfg);
  assert.equal(a.user, 'alice'); assert.equal(a.team, 'nlp'); assert.equal(a.org, 'research'); assert.equal(a.useCase, 'interactive');
  assert.equal(attribute({ namespace: 'prod-chat', name: 'vllm-70b', kind: 'deployment' }, cfg).org, 'product');
  assert.equal(attribute({ labels: { team: 'infra' }, name: 'llama-sft-run' }, cfg).org, 'platform');
  assert.equal(attribute({ name: 'llama-sft-run' }, cfg).useCase, 'fine-tuning');
  assert.ok(attribute({ namespace: 'kube-system', name: 'dcgm' }, cfg).shared);
});

test('ledger: totals, unallocated capacity, coverage, periods that add up, budgets, loaded cost', () => {
  const d = demo(), L = ledger(d.records, d);
  close(L.totals.useful + L.totals.idle + L.totals.lost, L.totals.alloc);
  assert.equal(L.coverage.utilization, 1); assert.ok(L.coverage.attributedUser > 0.95);
  const h100 = L.unallocated.find(u => u.gpuType === 'H100');
  close(h100.allocated + h100.unallocated, h100.capacity); assert.ok(h100.powerCost < h100.cost, 'on-prem: only power is avoidable');
  const byDay = groupBy(L, ['org'], 'day'), byAll = groupBy(L, ['org']);
  close(byDay.reduce((a, g) => a + g.alloc, 0), L.totals.alloc); close(byAll.reduce((a, g) => a + g.cost, 0), L.totals.cost);
  assert.equal(new Set(byDay.map(g => g.period)).size, 7);
  assert.equal(periods(T0, T0 + 40 * 86400, 'month').length, 2);
  const b = budgets(L, d.budgets); assert.ok(b.find(x => x.key === 'team:serving').over); assert.ok(!b.find(x => x.key === 'org:research').over);
  const lo = loaded(L, byAll); assert.ok(lo.reduce((a, g) => a + g.loadedCost, 0) > L.totals.cost, 'shared and unallocated costs are spread');
});

test('insights on the demo org: every planted waste found, with the right owner, ranked by monthly saving', () => {
  const d = demo(), L = ledger(d.records, d), ins = insights(L);
  const kinds = new Set(ins.map(i => i.kind));
  for (const k of d.answers.kinds) assert.ok(kinds.has(k), `finds ${k}`);
  for (const [k, who] of Object.entries(d.answers.owners)) assert.equal(ins.find(i => i.kind === k).owner.user, who, `${k} belongs to ${who}`);
  const usd = ins.map(i => i.savings.usdMonth ?? -1);
  for (let i = 1; i < usd.length; i++) assert.ok(usd[i - 1] >= usd[i], 'ranked by saving');
  for (const i of ins) { assert.ok(i.evidence && i.action && i.basis && i.confidence, i.id); }
  assert.match(ins.find(i => i.kind === 'gpu-type').title, /A100/, 'a 4-GPU job is not moved to PCIe L40S');
  assert.equal(ins.find(i => i.kind === 'serving-model-size').savings.usdMonth, null, 'a smaller model is an investigation, not a number');
  assert.ok(!ins.some(i => i.kind === 'held-idle' && i.owner.team === 'monitoring'), 'shared services are not blamed on anyone');
  const unpriced = insights(ledger(d.records, { attribution: d.attribution }));
  assert.ok(unpriced.filter(i => i.kind === 'repeated-failure').every(i => i.savings.usdMonth == null && i.savings.gpuHMonth > 0), 'no prices: GPU-hours, not $0');
});

test('insights: serving sizing through the Inference Sizer when it is available', () => {
  const req = createRequire(import.meta.url), p = path.join(here, '..', '..', 'inference-sizer', 'src');
  let S; try { S = sizerFrom(req(path.join(p, 'fit.js')), req(path.join(p, 'catalog.js')), req(path.join(p, 'model.js'))); } catch { return; }
  const recs = []; for (let h = 0; h < 48; h++) recs.push({ id: `s${h}`, start: T0 + h * H, end: T0 + (h + 1) * H, gpus: 16, gpuType: 'H100', team: 'serving', name: 'chat', kind: 'deployment', serving: { model: 'llama33-70b', tokensOut: 300 * 3600 * 1, tokensIn: 1200 * 3600, requests: 3600 }, util: { busy: 0.3, sm: 0.2 } });
  const L = ledger(recs, { prices: { gpus: { H100: { onprem: 2 }, H200: { onprem: 2.6 } } } });
  const x = insights(L, { sizer: S }).find(i => i.kind === 'serving-sizing');
  assert.ok(x, 'a 1 req/s chat model on 16 H100s is oversized'); assert.equal(x.basis, 'modelled'); assert.ok(x.savings.usdMonth > 0);
});

test('k8s: GPU pods only; DCGM joined per pod (busy, SM, idle stretches, peak memory); vLLM counters → hourly serving records', () => {
  const recs = A.k8s({ pods: fj('k8s_pods.json'), nodes: fj('k8s_nodes.json'), prom: ['dcgm_sm.json', 'dcgm_fb_used.json', 'dcgm_fb_free.json', 'vllm_tokens.json'].map(fj), cluster: 'prod', now: T0 + 4 * H });
  const nb = recs.find(r => r.name === 'jupyter-alice'), tr = recs.find(r => r.name === 'train-x'), sv = recs.filter(r => r.serving);
  assert.ok(!recs.some(r => r.namespace === 'x'), 'no GPU, no record');
  assert.equal(nb.kind, 'notebook'); assert.equal(nb.gpuType, 'H100'); assert.equal(nb.end, null); close(nb.util.busy, 0.25); close(nb.util.idleLong, 3 * H, 0.01);
  assert.equal(tr.gpus, 4); assert.equal(tr.status, 'failed'); assert.equal(tr.end, T0 + 2 * H); assert.equal(tr.gpuType, 'A100'); close(tr.util.memPeak, 0.25); close(tr.util.sm, 0.3);
  assert.equal(sv.length, 4); assert.equal(sv[0].name, 'chat'); assert.equal(sv[0].serving.model, 'llama33-70b');
  close(sv[0].serving.tokensOut, 60000, 0.001); close(sv.reduce((a, r) => a + r.serving.tokensOut, 0), 1000 * 149 + 1000 * 89, 0.01);
  const L = ledger(recs, { attribution: { directory: { alice: { team: 'nlp' } } }, from: T0, to: T0 + 4 * H });
  assert.equal(L.rows.find(x => x.r.name === 'jupyter-alice').r.team, 'nlp');
});

test('slurm, opencost, csv, acme and philly adapters', async () => {
  const s = A.slurm(fx('sacct.txt'), { cluster: 'hpc', now: T0 + 5 * H });
  assert.deepEqual(s.map(r => [r.name, r.gpus, r.gpuType, r.status]), [['pretrain', 16, 'H100', 'failed'], ['eval', 1, null, 'succeeded'], ['sweep', 2, 'A100', 'cancelled'], ['serve', 8, null, 'running']]);
  assert.equal(s[0].user, 'gina'); assert.equal(s[0].team, 'pretrain'); assert.equal(s[3].end, null);
  const oc = A.opencost(fj('opencost.json'));
  assert.equal(oc.length, 1); assert.equal(oc[0].gpus, 2); assert.equal(oc[0].name, 'chat'); assert.equal(oc[0].kind, 'deployment'); assert.equal(oc[0].cluster, 'prod');
  const c = A.csv('Start,End,GPUs,Owner,Busy\n2026-11-10T00:00:00Z,2026-11-10T02:00:00Z,4,zoe,0.5\n', { map: { start: 'Start', end: 'End', gpus: 'GPUs', user: 'Owner', busy: 'Busy' } });
  assert.deepEqual([c[0].gpus, c[0].user, c[0].util.busy, c[0].end - c[0].start], [4, 'zoe', 0.5, 2 * H]);
  const ac = A.acme(fx('acme.csv'));
  assert.equal(ac.length, 2, 'CPU jobs dropped'); assert.deepEqual([ac[0].useCase, ac[0].status, ac[0].gpus], ['training', 'failed', 64]);
  const ph = await A.philly({ jobs: fj('philly_job_log.json'), utilPath: path.join(FX, 'philly_gpu_util.csv'), machines: A.phillyMachines(fx('philly_machine_list.csv')) });
  assert.deepEqual(ph.map(r => [r.id, r.status, r.gpus]), [['app_1#0', 'failed', 2], ['app_1#1', 'failed', 2]], 'an attempt with no end is left out; earlier attempts failed');
  assert.equal(ph[0].team, 'vc1'); assert.equal(ph[0].gpuType, 'philly-24GB');
  assert.ok(ph.inventory.length >= 1, 'inventory from the GPUs that report utilization');
  assert.equal(A.pacific('2017-11-08 00:00:00 PST'), Date.UTC(2017, 10, 8, 8) / 1000); assert.equal(A.pacific('2017-10-09 07:00:00'), Date.UTC(2017, 9, 9, 14) / 1000, 'October is PDT');
});

test('FOCUS rows: mandatory columns filled, costs add up to the ledger plus unallocated, classes in x_ columns', () => {
  const d = demo(), L = ledger(d.records, d), rows = focusRows(L);
  const mandatory = ['BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingCurrency', 'BillingPeriodStart', 'BillingPeriodEnd', 'ChargeCategory', 'ChargeDescription', 'ChargePeriodStart', 'ChargePeriodEnd',
    'ContractedCost', 'EffectiveCost', 'HostProviderName', 'InvoiceIssuerName', 'ListCost', 'PricingQuantity', 'PricingUnit', 'ServiceCategory', 'ServiceName', 'ServiceProviderName'];
  for (const r of rows) for (const c of mandatory) assert.ok(r[c] != null && r[c] !== '', `${c} set`);
  for (const r of rows) assert.equal(r.ChargeCategory, 'Usage');
  const usage = rows.filter(r => !r.Tags.unallocated);
  close(usage.reduce((a, r) => a + r.EffectiveCost, 0), L.totals.cost, 1e-3);
  close(usage.reduce((a, r) => a + r.x_UsefulGpuHours + r.x_IdleGpuHours + r.x_LostGpuHours, 0), L.totals.alloc / H, 1e-3);
  assert.ok(rows.some(r => r.Tags.unallocated));
  const csv = focusCsv(L); assert.equal(csv.split('\n')[0], FOCUS_COLUMNS.join(','));
  assert.equal(A.parseCsv(csv).length, rows.length, 'the CSV parses back to the same rows');
  const sb = A.parseCsv(showbackCsv(L, { period: 'week' })); close(sb.reduce((a, r) => a + +r.gpu_hours, 0), L.totals.alloc / H, 1e-3);
});

test('report text and HTML carry coverage and the caveats', () => {
  const recs = A.acme(fx('acme.csv')), L = ledger(recs, {});
  const t = reportText(L, { by: ['useCase'] });
  assert.match(t, /utilization measured for 0%/); assert.match(t, /upper bound/);
  const d = demo(), L2 = ledger(d.records, d), h = html(L2, { ins: insights(L2), budgets: budgets(L2, d.budgets) });
  assert.match(h, /^<!DOCTYPE html>/); assert.match(h, /Where to save/); assert.match(h, /prefers-color-scheme:dark/); assert.ok(!/undefined|NaN/.test(h));
});

test('CLI: demo → report, insights, focus, html; import slurm; rates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), d = path.join(dir, 'demo');
  const dm = JSON.parse((await run(process.execPath, [cli, 'demo', '--out', d, '--json'])).stdout);
  assert.ok(dm.records > 100);
  const base = ['--usage', path.join(d, 'usage.jsonl'), '--config', path.join(d, 'ledger.json')];
  const rep = JSON.parse((await run(process.execPath, [cli, 'report', ...base, '--json'])).stdout);
  assert.ok(rep.totals.alloc > 0 && rep.insights.length >= 10 && rep.groups[0].loadedCost >= rep.groups[0].cost);
  assert.match((await run(process.execPath, [cli, 'insights', ...base])).stdout, /never succeeded/);
  await run(process.execPath, [cli, 'focus', ...base, '--out', path.join(dir, 'f.csv')]);
  assert.ok(fs.readFileSync(path.join(dir, 'f.csv'), 'utf8').startsWith('BilledCost,'));
  await run(process.execPath, [cli, 'report', ...base, '--format', 'html', '--out', path.join(dir, 'l.html')]);
  assert.ok(fs.statSync(path.join(dir, 'l.html')).size > 5000);
  const u = path.join(dir, 'u.jsonl'); await run(process.execPath, [cli, 'import', 'slurm', path.join(FX, 'sacct.txt'), '--cluster', 'hpc', '--out', u]);
  assert.equal(fs.readFileSync(u, 'utf8').trim().split('\n').length, 4);
  assert.match((await run(process.execPath, [cli, 'rates', '--config', path.join(d, 'ledger.json')])).stdout, /H100 +onprem +\$1\.170\/GPU-h/);
});
