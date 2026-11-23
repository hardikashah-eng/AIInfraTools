// Flakiness: which GPUs keep coming back broken, whether repairs hold, and where failures cluster.
//
// A dead GPU is quarantined once and replaced. A flaky one passes its diag, goes back to work and fails again days
// later, often mid-job. The live analysis looks at where each GPU stands now; this looks back over a window
// (default 60 days) at its history:
//   events   STATE/events.jsonl   every state change the analysis made: { t, key, node, gpu, sku, site, vendor?, from, to, why, faultClass }
//   audit    STATE/audit.jsonl    executed repairs (gpu-reset, node-reboot, …)
//   results  STATE/results.jsonl  diag results and job ends: { t, kind: "job-end", job, status: "failed", cause: "device"|"app"|"infra", node, gpu | rank, lostGpuHours? }
//
// Per GPU:
//   exits         times it left service (serving → suspect / quarantined / rma)
//   bounces       exits within `bounceDays` of coming back to service
//   diagThenFail  diag passes followed by an exit within `bounceDays`
//   jobFailures   jobs that failed with cause "device" on it
//   score         exits + 2 × bounces + 3 × jobFailures + diagThenFail (for ranking; the counts are what to read)
//   verdict       rma-candidate: 2+ bounces, or 3+ hard failures in the window
//                 flaky:         2+ exits, with a bounce or a device-caused job failure
//                 watch:         2+ exits
// Repairs hold when the GPU doesn't leave service again within 7 and 30 days (`holdDays`). Cohorts compare the exit
// rate of each SKU, site, node, slot and vendor against the fleet's, to separate bad parts from systemic causes. A group
// is flagged at `cohortRatio` × the fleet rate with failures on at least `cohortMinDevices` GPUs (one bad GPU is not a cohort).
import fs from 'node:fs';
import path from 'node:path';
import { priceFor } from './config.mjs';

const DAY = 86400;
const OUT = new Set(['suspect', 'quarantined', 'rma']);
const HARD = new Set(['quarantined', 'rma']);
export const REPAIRS = new Set(['gpu-reset', 'node-reboot', 'config-reset', 'reseat', 'firmware-align', 'fabric-restart']);
const isExit = e => (e.from == null || e.from === 'serving') && OUT.has(e.to);
const isNewHard = e => HARD.has(e.to) && (e.from == null || e.from === 'serving' || e.from === 'suspect');

// Which GPU a result is about: node + gpu, or job + rank through the jobs file.
function keyOfResult(r, jobs) {
  if (r.node != null && r.gpu != null) return r.node + '/' + r.gpu;
  const j = (jobs || []).find(x => x.id === r.job), g = j && r.rank != null && j.gpus[r.rank];
  return g ? g.node + '/' + g.gpu : null;
}

export function flakiness({ events = [], audit = [], results = [], fleet = [], jobs = [], cfg, now, days }) {
  const F = cfg.flakiness;
  days = days || F.windowDays;
  const from = now - days * DAY, bounce = F.bounceDays * DAY;
  const ev = events.filter(e => e.t <= now).sort((a, b) => a.t - b.t);
  const byKey = new Map();
  for (const e of ev) { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); }

  // devices: the fleet as last analyzed, plus any GPU that only appears in history
  const devices = new Map();
  for (const g of fleet) devices.set(g.key, { key: g.key, node: g.node, gpu: String(g.gpu), sku: g.sku || '', site: g.site || '', vendor: g.vendor || '', firmware: g.firmware || '', state: g.state });
  for (const e of ev) if (!devices.has(e.key)) devices.set(e.key, { key: e.key, node: e.node, gpu: String(e.gpu), sku: e.sku || '', site: e.site || '', vendor: e.vendor || '', firmware: '', state: e.to });

  // device-caused job failures and diag passes, per GPU
  const jobFails = new Map(), diagPass = new Map();
  for (const r of results) {
    if (r.t <= from || r.t > now) continue;
    const k = keyOfResult(r, jobs);
    if (!k) continue;
    if (r.kind === 'job-end' && r.status === 'failed' && r.cause === 'device') { if (!jobFails.has(k)) jobFails.set(k, []); jobFails.get(k).push(r); }
    if (r.kind === 'diag' && r.pass) { if (!diagPass.has(k)) diagPass.set(k, []); diagPass.get(k).push(r); }
  }

  const rows = [];
  for (const d of devices.values()) {
    const list = byKey.get(d.key) || [];
    const win = list.filter(e => e.t > from);
    const exits = win.filter(isExit), hard = win.filter(isNewHard);
    const returns = list.filter(e => e.to === 'serving' && e.from && e.from !== 'serving');
    const bounces = exits.filter(x => returns.some(r => r.t < x.t && x.t - r.t <= bounce));
    const diagThenFail = (diagPass.get(d.key) || []).filter(p => exits.some(x => x.t > p.t && x.t - p.t <= bounce)).length;
    const jf = jobFails.get(d.key) || [];
    const score = exits.length + 2 * bounces.length + 3 * jf.length + diagThenFail;
    const verdict = bounces.length >= 2 || hard.length >= F.rmaHardFailures ? 'rma-candidate'
      : exits.length >= 2 && (bounces.length || jf.length) ? 'flaky' : exits.length >= 2 ? 'watch' : 'ok';
    // state timeline across the window
    const before = list.filter(e => e.t <= from).pop();
    let state = before ? before.to : 'serving', t0 = from;
    const segments = [];
    for (const e of win) { if (e.t > t0) segments.push({ from: t0, to: e.t, state }); state = e.to; t0 = e.t; }
    segments.push({ from: t0, to: now, state });
    rows.push(Object.assign({}, d, {
      exits: exits.length, hardFailures: hard.length, bounces: bounces.length, diagThenFail, jobFailures: jf.length, score, verdict,
      faultClasses: [...new Set(win.map(e => e.faultClass).filter(c => c && c !== 'default'))],
      lastWhy: (win.filter(e => OUT.has(e.to)).pop() || {}).why || '',
      events: win.map(e => ({ t: e.t, from: e.from, to: e.to, why: e.why })), segments, next: NEXT[verdict],
    }));
  }
  rows.sort((a, b) => b.score - a.score || b.exits - a.exits || a.key.localeCompare(b.key));

  // repairs: does the GPU stay in service afterwards?
  const repairs = audit.filter(a => a.event === 'executed' && REPAIRS.has(a.kind) && a.t > from && a.t <= now).map(a => {
    const k = String(a.target || '').split(':')[0], list = byKey.get(k) || [];
    const cls = (list.filter(e => e.t <= a.t && e.faultClass).pop() || {}).faultClass || 'default';
    const fail = list.find(e => e.t > a.t && OUT.has(e.to));
    const hold = Object.fromEntries(F.holdDays.map(h => {
      const failedIn = fail && fail.t - a.t <= h * DAY;
      return [h, failedIn ? false : now - a.t >= h * DAY ? true : null]; // null: too recent to tell
    }));
    return { t: a.t, key: k, kind: a.kind, faultClass: cls, failedAfterDays: fail ? +((fail.t - a.t) / DAY).toFixed(1) : null, hold };
  });
  const repairGroups = new Map();
  for (const r of repairs) {
    const g = repairGroups.get(r.kind + '|' + r.faultClass) || { kind: r.kind, faultClass: r.faultClass, n: 0, hold: Object.fromEntries(F.holdDays.map(h => [h, { eligible: 0, held: 0 }])) };
    g.n++;
    for (const h of F.holdDays) if (r.hold[h] != null) { g.hold[h].eligible++; if (r.hold[h]) g.hold[h].held++; }
    repairGroups.set(r.kind + '|' + r.faultClass, g);
  }
  const h0 = F.holdDays[0];
  const repairTable = [...repairGroups.values()].map(g => {
    for (const h of F.holdDays) g.hold[h].rate = g.hold[h].eligible ? g.hold[h].held / g.hold[h].eligible : null;
    const r = g.hold[h0];
    g.verdict = r.eligible >= F.minRepairs && r.rate < 0.5 ? `rarely holds: for ${g.faultClass}, go straight to the next step` : r.eligible >= F.minRepairs && r.rate >= 0.8 ? 'holds' : r.eligible < F.minRepairs ? 'too few to judge' : 'mixed';
    return g;
  }).sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));

  // interruptions per day, split by how bad
  const perDay = Array.from({ length: days }, (_, i) => ({ day: from + i * DAY, suspect: 0, out: 0 }));
  for (const e of ev) if (e.t > from && isExit(e)) { const i = Math.min(days - 1, Math.floor((e.t - from) / DAY)); perDay[i][e.to === 'suspect' ? 'suspect' : 'out']++; }

  // cohorts: exit rate of each group vs the fleet
  const nDev = devices.size, totalExits = rows.reduce((t, r) => t + r.exits, 0), fleetRate = nDev ? totalExits / nDev : 0;
  const dims = [['sku', 'SKU'], ['site', 'Site'], ['node', 'Node'], ['gpu', 'Slot'], ['vendor', 'Vendor'], ['firmware', 'Firmware']]
    .filter(([f]) => new Set(rows.map(r => r[f]).filter(Boolean)).size > 1);
  const cohorts = dims.map(([field, label]) => {
    const g = new Map();
    for (const r of rows) { const v = r[field] || '–'; const c = g.get(v) || { value: v, devices: 0, devicesWithExits: 0, exits: 0 }; c.devices++; c.exits += r.exits; if (r.exits) c.devicesWithExits++; g.set(v, c); }
    const groups = [...g.values()].map(c => Object.assign(c, { rate: c.exits / c.devices, ratio: fleetRate ? c.exits / c.devices / fleetRate : 0 }))
      .map(c => Object.assign(c, { hot: c.ratio >= F.cohortRatio && c.devicesWithExits >= F.cohortMinDevices }))
      .sort((a, b) => b.ratio - a.ratio || a.value.localeCompare(b.value, undefined, { numeric: true }));
    return { field, label, groups };
  });

  // cost of device-caused job failures
  const badJobs = new Map();
  for (const [k, list] of jobFails) for (const r of list) {
    const j = jobs.find(x => x.id === r.job), size = j ? j.gpus.length : 1, dev = devices.get(k) || {};
    const lost = r.lostGpuHours != null ? r.lostGpuHours : size * F.lostHoursPerFailure;
    const b = badJobs.get(r.job || k) || { job: r.job || '(unknown job)', failures: 0, lostGpuHours: 0, cost: 0, devices: new Set(), estimated: false };
    b.failures++; b.lostGpuHours += lost; b.cost += lost * priceFor(cfg, dev.sku || ''); b.devices.add(k); if (r.lostGpuHours == null) b.estimated = true;
    badJobs.set(r.job || k, b);
  }
  const badput = [...badJobs.values()].map(b => Object.assign(b, { devices: [...b.devices] })).sort((a, b) => b.cost - a.cost);

  // early warning: share of new hard failures that were suspect first
  const hardAll = ev.filter(e => e.t > from && isNewHard(e));
  const warned = hardAll.filter(e => e.from === 'suspect' || (byKey.get(e.key) || []).some(x => x.to === 'suspect' && x.t < e.t && e.t - x.t <= F.warnHours * 3600));

  const deviceHours = nDev * days * 24;
  const exitsAll = rows.reduce((t, r) => t + r.exits, 0), bouncesAll = rows.reduce((t, r) => t + r.bounces, 0);
  const elig = repairs.filter(r => r.hold[h0] != null);
  return {
    generatedAt: now, window: { from, to: now, days }, settings: { bounceDays: F.bounceDays, holdDays: F.holdDays, lostHoursPerFailure: F.lostHoursPerFailure, cohortRatio: F.cohortRatio, cohortMinDevices: F.cohortMinDevices },
    totals: {
      devices: nDev, exits: exitsAll, exitsPer1kDeviceHours: deviceHours ? exitsAll / deviceHours * 1000 : 0,
      flaky: rows.filter(r => r.verdict === 'flaky').length, rmaCandidates: rows.filter(r => r.verdict === 'rma-candidate').length, watch: rows.filter(r => r.verdict === 'watch').length,
      bounceRate: exitsAll ? bouncesAll / exitsAll : null,
      repairs: repairs.length, repairHoldRate: elig.length ? elig.filter(r => r.hold[h0]).length / elig.length : null,
      hardFailures: hardAll.length, warnedRate: hardAll.length ? warned.length / hardAll.length : null,
      deviceJobFailures: [...jobFails.values()].reduce((t, l) => t + l.length, 0),
      lostGpuHours: badput.reduce((t, b) => t + b.lostGpuHours, 0), lostCost: badput.reduce((t, b) => t + b.cost, 0),
    },
    devices: rows.filter(r => r.exits || r.jobFailures), perDay, repairs, repairTable, cohorts, hotCohorts: cohorts.flatMap(c => c.groups.filter(g => g.hot).map(g => Object.assign({ dimension: c.label }, g))), badput,
  };
}

const NEXT = {
  'rma-candidate': 'Keep it out of service and open an RMA: repairs are not holding.',
  'flaky': 'Keep it off large synchronous jobs; run the deep diag at the next boundary and skip to the next ladder step if it fails again.',
  'watch': 'Leave in service; checkpoint jobs on it more often.',
  'ok': '',
};

// ---------- rendering ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n) > n * 0.6 ? s.lastIndexOf(' ', n) : n) + '…'; };
const pc = v => (v == null ? '–' : Math.round(v * 100) + '%');
const $ = v => '$' + Math.round(v || 0).toLocaleString('en-US');
const date = t => new Date(t * 1000).toISOString().slice(0, 10);
const VERDICT_TEXT = { 'rma-candidate': 'RMA candidate', flaky: 'flaky', watch: 'watch', ok: 'ok' };
const STATE_GROUP = s => (s === 'suspect' ? 'suspect' : ['quarantined', 'remediate', 'diagnose', 'rma'].includes(s) ? 'out' : ['burnin', 'ready'].includes(s) ? 'repair' : 'serving');
const GROUP_TEXT = { suspect: 'Suspect', out: 'Out of service (quarantined, repair, RMA)', repair: 'Burn-in / ready', serving: 'Serving' };

export function flakinessMarkdown(f) {
  const T = f.totals, L = [];
  L.push('# GPU flakiness', '', `${date(f.window.from)} → ${date(f.window.to)} (${f.window.days} days) · ${T.devices} GPUs`, '');
  L.push('| Left service | per 1k GPU-hours | Flaky | RMA candidates | Failed again within ' + f.settings.bounceDays + ' days | Repairs holding ' + f.settings.holdDays[0] + ' days | Warned before failing | Lost to device failures |', '|---|---|---|---|---|---|---|---|');
  L.push(`| ${T.exits} | ${T.exitsPer1kDeviceHours.toFixed(2)} | ${T.flaky} | ${T.rmaCandidates} | ${pc(T.bounceRate)} | ${pc(T.repairHoldRate)} | ${pc(T.warnedRate)} | ${Math.round(T.lostGpuHours)} GPU-h (${$(T.lostCost)}) |`, '');
  L.push('## Flakiest GPUs', '', '| GPU | SKU | Verdict | Exits | Back and failed again | Diag passed, then failed | Device-caused job failures | Fault classes | Next step |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of f.devices.slice(0, 15)) L.push(`| ${r.key} | ${r.sku} | ${VERDICT_TEXT[r.verdict]} | ${r.exits} | ${r.bounces} | ${r.diagThenFail} | ${r.jobFailures} | ${r.faultClasses.join(', ') || '–'} | ${r.next || '–'} |`);
  if (!f.devices.length) L.push('| – | | | | | | | | nothing left service in the window |');
  L.push('', '## Do repairs hold?', '', `| Repair | Fault class | Done | Held ${f.settings.holdDays.join(' / ')} days | Verdict |`, '|---|---|---|---|---|');
  for (const g of f.repairTable) L.push(`| ${g.kind} | ${g.faultClass} | ${g.n} | ${f.settings.holdDays.map(h => `${pc(g.hold[h].rate)} (${g.hold[h].held}/${g.hold[h].eligible})`).join(' / ')} | ${g.verdict} |`);
  if (!f.repairTable.length) L.push('| – | | | | no repairs executed in the window |');
  L.push('', '## Where failures cluster', '');
  if (f.hotCohorts.length) for (const c of f.hotCohorts) L.push(`- **${c.dimension} ${c.value}**: ${c.exits} exits on ${c.devicesWithExits} of ${c.devices} GPUs, ${c.ratio.toFixed(1)}× the fleet rate`);
  else L.push('No group fails at twice the fleet rate or more: failures look like individual parts, not a shared cause.');
  if (f.badput.length) {
    L.push('', '## Cost of device-caused job failures', '', '| Job | Failures | Lost GPU-hours | Cost | GPUs |', '|---|---|---|---|---|');
    for (const b of f.badput) L.push(`| ${b.job} | ${b.failures} | ${Math.round(b.lostGpuHours)}${b.estimated ? '*' : ''} | ${$(b.cost)} | ${b.devices.join(', ')} |`);
    if (f.badput.some(b => b.estimated)) L.push('', `\\* estimated as job size × ${f.settings.lostHoursPerFailure} h per failure (work since the last checkpoint plus restart); send \`lostGpuHours\` in the job-end result for the real figure.`);
  }
  return L.join('\n') + '\n';
}

// Colors: status warning / critical for suspect / out of service, series blue for burn-in, neutral for serving.
// Checked with the dataviz validator (all pairs, light and dark): CVD ΔE ≥ 23; warning is sub-3:1 on the light
// surface by design, so every state also has a text label (legend, tooltip, table).
const CSS = `.fz{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--mut:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--suspect:#fab219;--out:#d03b3b;--repair:#2a78d6;--serving:#e1e0d9;--bar:#2a78d6;--h1:#cde2fb;--h2:#9ec5f4;--h3:#6da7ec;--h4:#3987e5;--h5:#256abf;--h6:#184f95}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .fz{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--repair:#3987e5;--serving:#383835;--bar:#3987e5;--h1:#104281;--h2:#184f95;--h3:#1c5cab;--h4:#256abf;--h5:#3987e5;--h6:#6da7ec}}
:root[data-theme="dark"] .fz{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--repair:#3987e5;--serving:#383835;--bar:#3987e5;--h1:#104281;--h2:#184f95;--h3:#1c5cab;--h4:#256abf;--h5:#3987e5;--h6:#6da7ec}
*{box-sizing:border-box}body{margin:0}.fz{background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
.fz main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}.fz h1{font-size:22px;margin:0 0 4px}.fz h2{font-size:16px;margin:36px 0 4px}.fz .lede{color:var(--ink2);margin:0 0 12px;max-width:760px}
.sub,.mut{color:var(--ink2)}.small{font-size:12px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}.tile b{display:block;font-size:26px;font-weight:600;line-height:1.2}.tile span{color:var(--ink2);font-size:12px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--grid);vertical-align:top}th{font-size:12px;color:var(--ink2);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin:4px 0 10px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-2px}
.v{display:inline-block;font-size:12px;border-radius:99px;padding:0 8px;border:1px solid var(--ring);white-space:nowrap}.v.rma-candidate{border-color:var(--out)}.v.flaky{border-color:var(--suspect)}
.v::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--mut)}.v.rma-candidate::before{background:var(--out)}.v.flaky::before{background:var(--suspect)}
svg{display:block;width:100%;height:auto;overflow:visible}svg text{fill:var(--mut);font:11px system-ui,sans-serif}
[data-tip]{cursor:default}[data-tip]:hover,[data-tip]:focus{opacity:.8;outline:none}[data-tip]:focus-visible{outline:2px solid var(--ink)}
.tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;padding:6px 10px;font-size:12px;max-width:340px;z-index:9;display:none}
.tip b{font-size:13px}.bar{height:6px;background:var(--grid);border-radius:3px;width:110px;display:inline-block;vertical-align:middle;margin-right:8px}.bar i{display:block;height:100%;background:var(--bar);border-radius:3px}
.heat td.c{text-align:right;font-variant-numeric:tabular-nums}.hot{font-weight:600}details{margin-top:10px}summary{cursor:pointer;color:var(--ink2);font-size:12px}
.callout{border-left:3px solid var(--out);padding:6px 12px;margin:8px 0;background:var(--surface);border-radius:0 8px 8px 0}`;

// Rounded top corners only: the data end is rounded, the baseline end is square.
const barPath = (x, y, w, h, r = 4) => { if (h <= 0) return ''; r = Math.min(r, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

function dayChart(f) {
  const W = 1100, H = 220, padL = 32, padB = 26, padT = 10, n = f.perDay.length;
  const max = Math.max(1, ...f.perDay.map(d => d.suspect + d.out)), top = Math.max(2, Math.ceil(max / 2) * 2);
  const cw = (W - padL) / n, bw = Math.max(2, cw - 2), y = v => padT + (H - padT - padB) * (1 - v / top);
  const grid = [0, top / 2, top].map(v => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const bars = f.perDay.map((d, i) => {
    const x = padL + i * cw + 1, tot = d.suspect + d.out;
    const tip = `<b>${tot}</b> left service · ${date(d.day)}<br>${d.out} quarantined or RMA · ${d.suspect} suspect`;
    if (!tot) return `<rect x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent" data-tip="${esc(tip)}"/>`;
    // stacked: out of service on the baseline, suspect on top, 2px surface gap between them
    const hOut = y(0) - y(d.out), hSus = y(0) - y(d.suspect);
    const out = d.out ? (d.suspect ? `<rect x="${x}" y="${y(d.out)}" width="${bw}" height="${hOut}" fill="var(--out)"/>` : `<path d="${barPath(x, y(d.out), bw, hOut)}" fill="var(--out)"/>`) : '';
    const sus = d.suspect ? `<path d="${barPath(x, y(tot), bw, hSus - (d.out ? 2 : 0))}" fill="var(--suspect)"/>` : '';
    return `<g tabindex="0" data-tip="${esc(tip)}"><rect x="${x - 1}" y="${padT}" width="${cw}" height="${H - padT - padB}" fill="transparent"/>${out}${sus}</g>`;
  }).join('');
  const ticks = f.perDay.map((d, i) => (i % 7 === 0 ? `<text x="${padL + i * cw + cw / 2}" y="${H - 8}" text-anchor="middle">${date(d.day).slice(5)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="GPUs leaving service per day">${grid}<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/>${bars}${ticks}</svg>`;
}

function timeline(r, f) {
  const W = 360, H = 16, span = f.window.to - f.window.from;
  const x = t => ((t - f.window.from) / span) * W;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="state history of ${esc(r.key)}">` + r.segments.map(s => {
    const g = STATE_GROUP(s.state), x0 = x(s.from), w = Math.max(3, x(s.to) - x0 - (s.to < f.window.to ? 1 : 0));
    return `<rect x="${x0}" y="0" width="${w}" height="${H}" rx="2" fill="var(--${g})" tabindex="${g === 'serving' ? -1 : 0}" data-tip="${esc(`<b>${esc(s.state)}</b> · ${GROUP_TEXT[g]}<br>${date(s.from)} → ${date(s.to)} (${((s.to - s.from) / 86400).toFixed(1)} days)`)}"/>`;
  }).join('') + '</svg>';
}

const heatVar = ratio => (ratio <= 0 ? 'transparent' : `var(--h${Math.max(1, Math.min(6, Math.ceil(ratio * 1.5)))})`);
const heatInk = ratio => (ratio * 1.5 > 4 ? '#ffffff' : 'var(--ink)');

export function flakinessHtml(f) {
  const T = f.totals, tile = (v, l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  const top = f.devices.filter(r => r.verdict !== 'ok').slice(0, 25), once = f.devices.filter(r => r.verdict === 'ok');
  const row = r => `<tr><td><b>${esc(r.key)}</b><div class="mut small">${esc([r.sku, r.vendor, ...r.faultClasses].filter(Boolean).join(' · '))}</div></td><td><span class="v ${r.verdict}">${VERDICT_TEXT[r.verdict]}</span></td><td style="min-width:240px">${timeline(r, f)}<div class="mut small">${esc(clip(r.lastWhy, 120))}</div></td><td class="n">${r.exits}</td><td class="n">${r.bounces}</td><td class="n">${r.diagThenFail}</td><td class="n">${r.jobFailures}</td><td class="mut small">${esc(r.next)}</td></tr>`;
  const legend = ['suspect', 'out', 'repair', 'serving'].map(g => `<span><i style="background:var(--${g})"></i>${GROUP_TEXT[g]}</span>`).join('');
  const cohortCards = f.cohorts.map(c => {
    const shown = c.groups.slice(0, 10);
    return `<div class="card"><b>${esc(c.label)}</b>${c.groups.length > shown.length ? ` <span class="mut small">top ${shown.length} of ${c.groups.length}</span>` : ''}
<table class="heat"><tr><th>${esc(c.label)}</th><th class="n">GPUs</th><th class="n">GPUs that left</th><th class="n">Exits</th><th class="n">vs fleet</th></tr>
${shown.map(g => `<tr${g.hot ? ' class="hot"' : ''}><td>${esc(g.value)}${g.hot ? ' ⚑' : ''}</td><td class="c">${g.devices}</td><td class="c">${g.devicesWithExits}</td><td class="c">${g.exits}</td><td class="c" style="background:${heatVar(g.ratio)};color:${heatInk(g.ratio)}" tabindex="0" data-tip="${esc(`<b>${g.ratio.toFixed(1)}×</b> the fleet's exit rate<br>${esc(c.label)} ${esc(g.value)}: ${g.exits} exits on ${g.devices} GPUs`)}">${g.ratio.toFixed(1)}×</td></tr>`).join('')}</table></div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU flakiness</title><style>${CSS}</style></head><body class="fz"><main>
<h1>GPU flakiness</h1><div class="sub">${date(f.window.from)} → ${date(f.window.to)} · last ${f.window.days} days · ${T.devices} GPUs</div>
<div class="tiles">${tile(T.exits, `times a GPU left service · ${T.exitsPer1kDeviceHours.toFixed(2)} per 1k GPU-hours`)}${tile(T.flaky + T.rmaCandidates, `flaky GPUs · ${T.rmaCandidates} RMA candidate(s)`)}${tile(pc(T.bounceRate), `of exits came within ${f.settings.bounceDays} days of returning to service`)}${tile(pc(T.repairHoldRate), `of repairs held ${f.settings.holdDays[0]} days`)}${tile(pc(T.warnedRate), 'of hard failures were suspect first')}${tile(Math.round(T.lostGpuHours) + ' GPU-h', `lost to ${T.deviceJobFailures} device-caused job failure(s) · ${$(T.lostCost)}`)}</div>
${f.hotCohorts.length ? f.hotCohorts.map(c => `<div class="callout"><b>${esc(c.dimension)} ${esc(c.value)}</b> fails at ${c.ratio.toFixed(1)}× the fleet rate: ${c.exits} exits on ${c.devicesWithExits} of ${c.devices} GPUs. Look for a shared cause (cooling, power, firmware, a bad batch) before replacing parts one by one.</div>`).join('') : ''}
<h2>GPUs leaving service per day</h2><p class="lede">Each bar is the number of GPUs that went from serving to suspect, quarantined or RMA that day.</p>
<div class="card"><div class="legend"><span><i style="background:var(--out)"></i>Quarantined or RMA</span><span><i style="background:var(--suspect)"></i>Suspect</span></div>${dayChart(f)}
<details><summary>Table view</summary><table><tr><th>Day</th><th class="n">Quarantined or RMA</th><th class="n">Suspect</th></tr>${f.perDay.filter(d => d.out + d.suspect).map(d => `<tr><td>${date(d.day)}</td><td class="n">${d.out}</td><td class="n">${d.suspect}</td></tr>`).join('') || '<tr><td colspan="3">None.</td></tr>'}</table></details></div>
<h2>Flakiest GPUs</h2><p class="lede">GPUs that keep leaving service, ranked. A bounce is failing again within ${f.settings.bounceDays} days of coming back. Each strip is the GPU's state across the window.</p>
<div class="card"><div class="legend">${legend}</div><table><tr><th>GPU</th><th>Verdict</th><th>State history</th><th class="n">Exits</th><th class="n">Bounces</th><th class="n">Diag passed, then failed</th><th class="n">Job failures</th><th>Next step</th></tr>
${top.map(r => row(r)).join('') || '<tr><td colspan="8">No GPU left service more than once in the window.</td></tr>'}</table>
${once.length ? `<details><summary>${once.length} more GPU(s) left service once</summary><table>${once.map(r => row(r)).join('')}</table></details>` : ''}</div>
<h2>Do repairs hold?</h2><p class="lede">A repair holds when the GPU doesn't leave service again within ${f.settings.holdDays.join(' or ')} days. Repairs too recent to judge are left out of the rate.</p>
<div class="card"><table><tr><th>Repair</th><th>Fault class</th><th class="n">Done</th>${f.settings.holdDays.map(h => `<th>Held ${h} days</th>`).join('')}<th>Verdict</th></tr>
${f.repairTable.map(g => `<tr><td>${esc(g.kind)}</td><td>${esc(g.faultClass)}</td><td class="n">${g.n}</td>${f.settings.holdDays.map(h => `<td>${g.hold[h].eligible ? `<span class="bar"><i style="width:${Math.round(g.hold[h].rate * 100)}%"></i></span>${pc(g.hold[h].rate)} <span class="mut small">${g.hold[h].held} of ${g.hold[h].eligible}</span>` : '<span class="mut small">too recent</span>'}</td>`).join('')}<td class="mut small">${esc(g.verdict)}</td></tr>`).join('') || '<tr><td colspan="6">No repairs were executed in the window.</td></tr>'}</table></div>
<h2>Where failures cluster</h2><p class="lede">Exit rate of each group against the fleet's. Darker means more failures than the fleet average; ⚑ marks groups at ${f.settings.cohortRatio}× or more with failures on at least ${f.settings.cohortMinDevices} GPUs.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px">${cohortCards || '<p class="mut">The fleet has one value for every dimension.</p>'}</div>
${f.badput.length ? `<h2>Cost of device-caused job failures</h2><div class="card"><table><tr><th>Job</th><th class="n">Failures</th><th class="n">Lost GPU-hours</th><th class="n">Cost</th><th>GPUs</th></tr>${f.badput.map(b => `<tr><td>${esc(b.job)}</td><td class="n">${b.failures}</td><td class="n">${Math.round(b.lostGpuHours)}${b.estimated ? '*' : ''}</td><td class="n">${$(b.cost)}</td><td class="mut">${esc(b.devices.join(', '))}</td></tr>`).join('')}</table>${f.badput.some(b => b.estimated) ? `<p class="mut small">* estimated as job size × ${f.settings.lostHoursPerFailure} h per failure (work since the last checkpoint plus restart). Send <code>lostGpuHours</code> in the job-end result for the real figure.</p>` : ''}</div>` : ''}
<div class="tip" id="tip" role="tooltip"></div></main>
<script>(function(){var tip=document.getElementById('tip');function show(el,x,y){tip.innerHTML=el.getAttribute('data-tip');tip.style.display='block';var r=tip.getBoundingClientRect();tip.style.left=Math.min(window.innerWidth-r.width-8,x+12)+'px';tip.style.top=Math.max(8,y-r.height-12)+'px'}
function hide(){tip.style.display='none'}document.addEventListener('pointermove',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el,e.clientX,e.clientY);else hide()});
document.addEventListener('focusin',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(!el)return hide();var b=el.getBoundingClientRect();show(el,b.left+b.width/2,b.top)});document.addEventListener('focusout',hide)})();</script>
</body></html>`;
}

// ---------- state files ----------

const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)) : []);
const RESULT_KINDS = new Set(['diag', 'burnin', 'release', 'job-end', 'fault', 'sdc']);

// After each analysis: one event per GPU whose state changed. A GPU seen for the first time counts as coming from serving.
export function recordTransitions(dir, prev, health) {
  const lines = [];
  for (const g of Object.values(health.gpus)) {
    const was = ((prev && prev.gpus) || {})[g.key];
    const from = was ? was.state : null;
    if (from === g.state || (!was && g.state === 'serving')) continue;
    lines.push(JSON.stringify({ t: health.now, key: g.key, node: g.node, gpu: String(g.gpu), sku: g.sku || '', site: g.site || '', vendor: g.vendor || (g.evidence || {}).vendor || '', from, to: g.state, why: g.why || '', faultClass: g.faultClass || '' }));
  }
  if (lines.length) fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  return lines.length;
}

// Keep the results the flakiness view needs (diags, job ends, faults, SDC), without duplicates.
export function recordResults(dir, results) {
  const f = path.join(dir, 'results.jsonl');
  const seen = new Set(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  const add = (results || []).filter(r => RESULT_KINDS.has(r.kind)).map(r => JSON.stringify(r)).filter(l => !seen.has(l) && seen.add(l));
  if (add.length) fs.appendFileSync(f, add.join('\n') + '\n');
  return add.length;
}

// Flakiness from a state directory (events, audit, results and the last analysis).
export function flakinessFromState(dir, cfg, { days, now, results = [], jobs } = {}) {
  const af = path.join(dir, 'analysis.json'), an = fs.existsSync(af) ? JSON.parse(fs.readFileSync(af, 'utf8')) : null;
  const fleet = an ? Object.values(an.health.gpus).map(g => ({ key: g.key, node: g.node, gpu: g.gpu, sku: g.sku, site: g.site, vendor: g.vendor || (g.evidence || {}).vendor || '', state: g.state })) : [];
  return flakiness({
    events: readJsonl(path.join(dir, 'events.jsonl')), audit: readJsonl(path.join(dir, 'audit.jsonl')),
    results: [...readJsonl(path.join(dir, 'results.jsonl')), ...results], fleet, jobs: jobs || (an ? an.jobs : []), cfg,
    now: now ?? (an ? an.generatedAt : Math.floor(Date.now() / 1000)), days,
  });
}

// What a script or an agent needs: totals, the top GPUs (without the drawing data), repairs, hot cohorts, cost.
export const flakinessDigest = (f, top = 20) => ({
  window: f.window, settings: f.settings, totals: f.totals,
  devices: f.devices.slice(0, top).map(({ segments, ...r }) => r),
  repairs: f.repairTable, hotCohorts: f.hotCohorts, badput: f.badput,
});
