// fleetops CLI: common (see ../fleetops.mjs for the entry point and dispatch)
import fs from 'node:fs';
import { toEpoch } from '../../src/adapters/time.mjs';
import { createRequire } from 'node:module';

export const FSIN = createRequire(import.meta.url)('../../../fleetscope/src/ingest.js');

export function args(argv) {
  const o = { _: [], where: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), nx = argv[i + 1], v = nx === undefined || nx.startsWith('--') ? true : (i++, nx); if (k === 'where') o.where.push(v); else o[k] = v; }
    else o._.push(a);
  }
  return o;
}
export let J = false; export const OUT = {};
export function setJson(v) { J = v; }
export const say = (...a) => { if (!J) console.log(...a); };
export const read = f => fs.readFileSync(f, 'utf8');
export const time = v => (v == null || v === true ? undefined : toEpoch(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v));
export const fmt = t => (Number.isFinite(t) ? new Date(t * 1000).toISOString().replace('.000', '') : '–');

export const pc = v => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : '') + Math.round(v * 100) + '%');
export const errs = rows => (rows || []).map(r => `${r.metric} ${pc(r.err)}`).join(', ');

export const hdrs = o => Object.fromEntries([].concat(o.header || []).filter(h => h !== true).map(h => { const i = String(h).indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));
export const lokiQueries = o => [].concat(o['loki-query'] || ['{job=~".*kernel.*|.*syslog.*"}', '{container=~".+"} |~ "NCCL WARN|Watchdog caught|CUDA error|OutOfMemoryError"']).filter(q => q !== true);
export const dur = v => { const m = String(v || '').match(/^(\d+(?:\.\d+)?)([smhd]?)$/); return m ? +m[1] * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : undefined; };

export const money = v => '$' + Math.round(v).toLocaleString('en-US');
export const pctS = x => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
