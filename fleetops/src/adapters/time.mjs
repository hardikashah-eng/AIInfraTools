// Timestamps as they appear in exports, to epoch seconds.

// US Pacific local time (with DST) for traces that record wall-clock time without a zone.
function usDst(y, m, d, h) { // second Sunday of March 02:00 to first Sunday of November 02:00
  const nth = (month, n) => { const first = new Date(Date.UTC(y, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const start = nth(2, 2), end = nth(10, 1);
  if (m < 2 || m > 10) return false;
  if (m > 2 && m < 10) return true;
  if (m === 2) return d > start || (d === start && h >= 2);
  return d < end || (d === end && h < 2);
}
const ZONES = { UTC: 0, Z: 0, GMT: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4 };

// "2017-11-08 00:00:00 PST", "2017-10-07 01:12:09" (zone given by `tz`: 'pacific' | 'utc'), ISO strings, epoch s/ms.
export function toEpoch(v, { tz = 'utc' } = {}) {
  if (v == null || v === '' || v === 'None') return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = +s; return n > 1e12 ? n / 1000 : n; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*([A-Z]{1,4}|[+-]\d{2}:?\d{2})?$/);
  if (!m) { const p = Date.parse(s); return Number.isNaN(p) ? null : p / 1000; }
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000 + (frac ? +frac : 0);
  let off;
  if (zone && ZONES[zone] != null) off = ZONES[zone];
  else if (zone) { const z = zone.replace(':', ''); off = (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) + +z.slice(3, 5) / 60); }
  else if (tz === 'pacific') off = usDst(+y, +mo - 1, +d, +h) ? -7 : -8;
  else off = 0;
  return base - off * 3600;
}
