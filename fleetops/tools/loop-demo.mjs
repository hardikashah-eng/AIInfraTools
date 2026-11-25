#!/usr/bin/env node
// The whole loop on real data, in one command: Observe → Diagnose → Simulate → Approve → Optimize → Verify, on one
// week of the Microsoft Philly GPU cluster (8–15 Nov 2017, CC BY 4.0), which ships with the repository.
//
//   aiinfra demo [--out DIR]          steps 1–4; stops where a person has to approve
//   aiinfra demo --continue DIR       after you approve: steps 5–6, and the report
//
// It prints every command it runs, so you can run them on your own data. Nothing here touches a cluster: the
// optimize step is a dry run that shows the exact action it would take.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), FLEETOPS = path.join(HERE, 'fleetops.mjs');
const REAL = path.join(HERE, '..', 'tests', 'fixtures', 'real');
const FROM = Date.UTC(2017, 10, 8, 8) / 1000, TO = FROM + 7 * 86400, SPLIT = FROM + 3.5 * 86400; // Pacific midnights
const iso = t => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const n0 = x => Math.round(x).toLocaleString('en-US'), pct = x => `${(100 * x).toFixed(0)}%`;

const args = process.argv.slice(2), flag = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const JSON_OUT = args.includes('--json'), quiet = JSON_OUT;
const say = (...s) => { if (!quiet) console.log(...s); };
const log = [];

function run(title, argv, { json = true } = {}) {
  const shown = 'fleetops ' + argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
  say(`  $ ${shown.replaceAll(process.cwd() + path.sep, '')}`);
  const r = spawnSync(process.execPath, [FLEETOPS, ...argv, ...(json ? ['--json'] : [])], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && !(json && r.stdout.trim().startsWith('{'))) throw new Error(`${shown} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  log.push({ title, command: shown });
  return json ? JSON.parse(r.stdout) : r.stdout;
}
const head = (n, name, what) => say(`\n${n}. ${name}: ${what}`);

function steps1to4(dir) {
  const S = path.join(dir, 'store'), out = {};
  fs.mkdirSync(dir, { recursive: true });
  const jobs = path.join(dir, 'philly-jobs.json');
  fs.writeFileSync(jobs, zlib.gunzipSync(fs.readFileSync(path.join(REAL, 'philly-job-log-2017-11-07-15.json.gz'))));

  head(1, 'Observe', 'load a real week of a 552-machine GPU cluster');
  run('import machines', ['data', 'import', 'philly-machines', path.join(REAL, 'philly-machine-list.csv'), '--from', String(FROM), '--store', S], { json: false });
  run('import jobs', ['data', 'import', 'philly-jobs', jobs, '--from', String(FROM), '--to', String(TO), '--store', S], { json: false });
  const tune = run('tune', ['tune', '--from', String(FROM), '--to', String(TO), '--store', S, '--format', 'json'], { json: false });
  const T = JSON.parse(tune);
  out.observe = { from: FROM, to: TO, gpuHours: T.goodput.gpuHours, goodput: T.goodput.fleet };
  say(`  → ${n0(T.goodput.gpuHours)} GPU-hours of training attempts; ${pct(1 - T.goodput.fleet)} of them in attempts that failed or were restarted.`);

  head(2, 'Diagnose', 'find the failure spikes and say why');
  const D = run('rca detect', ['rca', 'detect', '--from', String(FROM), '--to', String(TO), '--diagnose', '--store', S]);
  out.diagnose = D.incidents.map(i => ({ id: i.id, failures: i.incident.failures, confidence: i.confidence, cause: i.hypotheses[0] && i.hypotheses[0].title, kind: i.hypotheses[0] && i.hypotheses[0].cause }));
  const ns = out.diagnose.filter(i => /namespace/.test(i.cause || '')).length;
  say(`  → ${out.diagnose.length} incidents. ${ns} of them: one namespace's jobs failing in bulk (a workload problem, not the hardware). For example:`);
  for (const i of out.diagnose.slice(0, 3)) say(`     ${i.id.replace('job-failures@', '').slice(0, 16)}  ${i.cause} [${i.confidence}]`);

  head(3, 'Simulate', 'what each change should give back, before anyone makes it');
  out.simulate = T.recommendations.map(r => ({ id: r.id, title: r.title, gpuHoursPerWeek: r.impact.gpuHoursPerWeek, basis: r.impact.basis, confidence: r.confidence }));
  for (const r of out.simulate) say(`  → ${r.title}: up to ${n0(r.gpuHoursPerWeek)} GPU-hours a week (${r.basis}).`);
  const C = run('optimize candidates', ['optimize', 'candidates', '--from', String(FROM), '--to', String(TO), '--store', S, '--out', path.join(dir, 'candidates.json')]);
  const P = run('optimize plan', ['optimize', 'plan', '--candidates', path.join(dir, 'candidates.json'), '--out', path.join(dir, 'plan.json'), '--store', S]);
  const plan = P.plan || JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  out.plan = { id: plan.id, weekly: plan.totalWeekly, stages: plan.stages.map(s => s.title) };
  say(`  → a plan worth $${n0(plan.totalWeekly)} a week: ${plan.stages.map(s => s.title).join('; ')}.`);

  head(4, 'Approve', 'a person decides; the tools never approve on their own');
  const state = path.join(S, 'rollouts', 'state'), id = `rollout-stage:${plan.id}#1`;
  out.approve = { action: id, state, command: `aiinfra gpu-health actions approve '${id}' --by "Your Name" --state ${state}` };
  say(`  The plan's first stage is queued for approval. Read it, and if you agree, approve it yourself:\n\n    ${out.approve.command}\n\n  then continue:\n\n    aiinfra demo --continue ${dir}\n`);
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(Object.assign(out, { commands: log }), null, 1));
  return out;
}

function steps5and6(dir) {
  const S = path.join(dir, 'store'), out = JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8'));
  head(5, 'Optimize', 'roll out the approved stage (dry run: shows the action, touches nothing)');
  const A = run('optimize advance', ['optimize', 'advance', '--plan', path.join(dir, 'plan.json'), '--store', S, '--now', String(TO)]);
  const st = (A.plan || A).stages[0];
  out.optimize = { status: (A.plan || A).status, stage: st.status, apply: st.apply };
  if ((A.plan || A).status === 'waiting-approval') {
    say(`  → still waiting for approval. Approve it as shown in step 4 (only a person can), then run this again.`);
    return out;
  }
  say(`  → stage 1 ${st.status}. The action it would take: ${JSON.stringify(st.apply).slice(0, 160)}`);

  head(6, 'Verify', 'recommend on the first half of the week, check on the second');
  const H = run('tune holdout', ['tune', 'holdout', '--from', String(FROM), '--split', String(SPLIT), '--to', String(TO), '--store', S]).holdout;
  out.verify = H.rows.map(r => ({ id: r.id, held: r.held, outOfSample: r.outOfSample }));
  for (const r of H.rows) say(`  → ${r.id}: ${r.held ? 'HELD' : 'DID NOT HOLD'} out of sample: ${r.outOfSample.failed.toFixed(0)} failed attempts against ${r.outOfSample.expected.toFixed(0)} expected (${r.outOfSample.ratio.toFixed(1)}×) on the same nodes.`);
  out.commands = (out.commands || []).concat(log);
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(dir, 'report.md'), report(out));
  say(`\nReport: ${path.join(dir, 'report.md')}. Every command above works on your own data: see fleetops/docs/TUNE.md.`);
  return out;
}

function report(o) {
  const L = [`# The loop on a real week: Microsoft Philly, ${iso(o.observe.from)} → ${iso(o.observe.to)} UTC`, '',
    `Data: Philly cluster traces (Jeon et al., ATC '19), CC BY 4.0. Job outcomes and placements only: no device telemetry or step logs.`, '',
    '## 1. Observe', '', `${n0(o.observe.gpuHours)} GPU-hours of training attempts; ${pct(1 - o.observe.goodput)} in attempts that failed or were restarted.`, '',
    '## 2. Diagnose', '', '| Incident | Failures | Most likely cause | Confidence |', '| --- | --- | --- | --- |',
    ...o.diagnose.map(i => `| ${i.id.replace('job-failures@', '')} | ${n0(i.failures)} | ${i.cause} | ${i.confidence} |`), '',
    '## 3. Simulate', '', ...o.simulate.map(r => `- ${r.title}: up to ${n0(r.gpuHoursPerWeek)} GPU-hours a week (${r.basis}, confidence ${r.confidence}).`),
    `- Plan ${o.plan.id}: $${n0(o.plan.weekly)} a week. ${o.plan.stages.join('; ')}.`, '',
    '## 4. Approve', '', `Approved by a person: \`${o.approve.command.replace('"Your Name"', 'NAME')}\``, '',
    '## 5. Optimize', '', `Stage 1: ${o.optimize.stage} (dry run).`, '',
    '## 6. Verify', '', ...o.verify.map(r => `- ${r.id}: ${r.held ? '**held**' : '**did not hold**'} out of sample, ${r.outOfSample.failed.toFixed(0)} failed attempts against ${r.outOfSample.expected.toFixed(0)} expected (${r.outOfSample.ratio.toFixed(1)}×).`), '',
    '## Commands', '', '```', ...o.commands.map(c => c.command), '```', ''];
  return L.join('\n');
}

try {
  const cont = flag('--continue');
  const dir = path.resolve(cont || flag('--out') || 'aiinfra-demo');
  if (!cont) say(`The AIInfraTools loop on a real week of the Philly GPU cluster (${iso(FROM)} → ${iso(TO)} UTC). Working in ${dir}.`);
  const o = cont ? steps5and6(dir) : steps1to4(dir);
  if (JSON_OUT) console.log(JSON.stringify(o, null, 1));
} catch (e) { console.error('demo: ' + e.message); process.exit(1); }
