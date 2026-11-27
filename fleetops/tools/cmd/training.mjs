// fleetops CLI: training (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import path from 'node:path';
import * as Goodput from '../../src/goodput.mjs';
import * as Sdc from '../../src/sdc.mjs';
import * as Tune from '../../src/tune.mjs';
import { goodputMarkdown, goodputHtml } from '../../src/goodput-report.mjs';
import { createRequire } from 'node:module';
import { J, OUT, say, read, time, fmt, dur } from './common.mjs';

// Streaming ingestion: remote_write and OTLP/HTTP (JSON) into the store.
// ---------- goodput ----------
export function goodputCmd(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  const g = Goodput.goodput(store, { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)), job: opt('job'), targets: opt('targets') ? JSON.parse(read(opt('targets'))) : {} });
  const fmt = opt('format');
  if (fmt === 'html' || fmt === 'md') { const text = fmt === 'html' ? goodputHtml(g) : goodputMarkdown(g); if (opt('out')) { fs.writeFileSync(opt('out'), text); say(`wrote ${opt('out')}`); if (J) OUT.wrote = opt('out'); } else process.stdout.write(text); return; }
  if (J) { OUT.goodput = Object.assign({}, g, { jobs: g.jobs.map(({ attemptsList, ...j }) => j) }); return; }
  process.stdout.write(goodputMarkdown(g));
}

export function tuneCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = f => JSON.parse(read(f));
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  // pools deployed with `fleetops serving deploy` are known without --pools / --targets
  const reg = f => { const p = path.join(store.dir, 'serving', f); return fs.existsSync(p) ? JSON.parse(read(p)) : {}; };
  const args = { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)), targets: Object.assign(reg('targets.json'), opt('targets') ? json(opt('targets')) : {}), pools: Object.assign(reg('pools.json'), opt('pools') ? json(opt('pools')) : {}) };
  const last = path.join(store.dir, 'tune', 'last.json');
  if (cmd === 'models') { const C = createRequire(import.meta.url)('../../../inference-sizer/src/catalog.js'); if (J) { OUT.models = C.MODELS.map(m => m.id); OUT.gpus = C.GPUS.map(g => g.id); return; } say(`models: ${C.MODELS.map(m => m.id).join(' ')}\ngpus:   ${C.GPUS.map(g => g.id).join(' ')}`); return; }
  if (cmd === 'apply') {
    const id = o._[2]; if (!id) throw new Error('fleetops tune apply ID --by NAME');
    let rec = fs.existsSync(last) ? JSON.parse(read(last)).recommendations.find(r => r.id === id) : null;
    if (!rec) rec = Tune.tune(store, args).recommendations.find(r => r.id === id);
    if (!rec) throw new Error(`no recommendation ${id} (run fleetops tune first; ids are shown in its output)`);
    const c = Tune.applyTune(store, rec, { by: opt('by'), at: time(opt('at')), note: opt('note') });
    if (J) { OUT.applied = c; return; }
    say(`recorded ${id} applied at ${fmt(c.t)} by ${c.by}${rec.verify ? `\nmeasure it once there is data after the change: fleetops tune verify ${id}` : ''}`);
    return;
  }
  if (cmd === 'verify' || cmd === 'list') {
    const ids = cmd === 'verify' && o._[2] ? [o._[2]] : [...new Set(Tune.applied(store).map(c => c.tune.id))];
    const vo = { beforeS: dur(opt('before')) ?? 7 * 86400, afterS: dur(opt('after')) ?? 7 * 86400, now: Math.floor(Date.now() / 1000) };
    const res = ids.map(id => Object.assign({ title: (Tune.applied(store).filter(c => c.tune.id === id).pop() || { tune: {} }).tune.title }, Tune.verifyTune(store, id, vo)));
    if (J) { OUT.verified = res; return; }
    if (!res.length) { say('nothing applied yet: fleetops tune apply ID --by NAME after making a change'); return; }
    const f = (m, x) => (x == null ? '–' : m === 'pool.ttftP99' ? `${x.toFixed(3)} s` : m === 'fleet.interruptions' ? x.toFixed(2) : `${(x * 100).toFixed(1)}%`);
    for (const r of res) say(`${r.verdict.toUpperCase().padEnd(15)} ${r.id}${r.title ? `  ${r.title}` : ''}${r.before ? `\n                ${r.metric}${r.scope ? ` (${r.scope})` : ''}: ${f(r.metric, r.before.mean)} before (${r.before.n}) → ${f(r.metric, r.after.mean)} after (${r.after.n})${r.ci ? `, difference 95% CI ${f(r.metric, r.ci[0])} to ${f(r.metric, r.ci[1])}` : ''}` : ''}${r.note ? `\n                ${r.note}` : ''}`);
    return;
  }
  if (cmd === 'holdout') {
    const split = time(opt('split')) ?? Math.round((from + to) / 2);
    const h = Tune.holdout(store, Object.assign({}, args, { from, split, to }));
    if (J) { OUT.holdout = h; return; }
    say(`recommendations from ${fmt(from)} → ${fmt(split)}, checked on ${fmt(split)} → ${fmt(to)}:`);
    for (const r of h.rows) {
      const o2 = r.outOfSample;
      const txt = r.id === 'flaky-nodes' && o2 ? `the same nodes: ${o2.failed.toFixed(0)} failed attempts against ${o2.expected.toFixed(0)} expected (${o2.ratio ? o2.ratio.toFixed(1) : '–'}×), ${(o2.share * 100).toFixed(1)}% of failures`
        : r.id.startsWith('reclaim:') && o2 ? `${o2.still} of ${o2.of} jobs still flagged`
          : r.inSample != null && typeof r.inSample === 'number' && typeof o2 === 'number' ? `${(r.inSample * 100).toFixed(1)}% before, ${(o2 * 100).toFixed(1)}% after` : (r.note || '');
      say(`  ${r.held == null ? '–' : r.held ? 'HELD ' : 'FADED'} ${r.id}: ${txt}`);
    }
    return;
  }
  if (cmd && cmd !== 'run') throw new Error(`unknown: tune ${cmd}`);
  const t = Tune.tune(store, args);
  fs.mkdirSync(path.dirname(last), { recursive: true }); fs.writeFileSync(last, JSON.stringify(t));
  if (opt('format') === 'json' || J) { if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(t, null, 1)); OUT.tune = t; if (!J) say(JSON.stringify(t, null, 1)); return; }
  const text = Tune.tuneMarkdown(t);
  if (opt('out')) { fs.writeFileSync(opt('out'), text); say(`wrote ${opt('out')}`); } else process.stdout.write(text);
}

export function sdcCmd(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  const r = Sdc.findSdc(store, { from, to });
  if (J) { OUT.sdc = r; return; }
  process.stdout.write(Sdc.sdcMarkdown(r));
}
