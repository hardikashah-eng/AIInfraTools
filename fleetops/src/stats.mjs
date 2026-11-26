// Small statistics shared across fleetops. Each keeps the exact behaviour of the copies it replaced, so results don't move.

// the true median of the finite values (mean of the middle two when even); NaN when there are none
export function median(a) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
}
// the upper median of the finite values (the middle element, the higher of the two when even): what the detectors and
// root-cause rules were fitted with; `empty` when there are none
export function medianUpper(a, empty = NaN) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : empty; }
// the p-quantile by nearest rank (p in 0–1)
export function pctl(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : NaN; }
// a seeded uniform generator in [0, 1) (an LCG: fast, reproducible, not for anything secret)
export function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
