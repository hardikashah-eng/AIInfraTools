// What a model call cost: list prices for hosted APIs, or GPU time for self-hosted models (see gpu.mjs).
//
// A price file: { asOf, currency, models: { "<model id or prefix>": { input, cacheRead, cacheWrite, output  ($ per
// million tokens), tier?: 'large'|'medium'|'small', downshift?: "<cheaper model to try for small routing calls>" } } }
// Keys match a model id exactly, or as a prefix ("claude-sonnet-4-5" matches "claude-sonnet-4-5-20250929").
//
// The defaults below are examples to make the report readable out of the box, not a price list to rely on. Prices
// change and new models appear; pass --prices with yours. Calls whose model isn't priced are reported as unpriced,
// and a cost the harness recorded itself (Claude Code's costUSD, OpenInference llm.cost.total, Langfuse cost) wins.
export const DEFAULT_PRICES = {
  asOf: '2026-11-25', currency: 'USD',
  note: 'Examples only. OpenAI rows from developers.openai.com/api/docs/pricing; Anthropic rows from the Claude pricing page as of late 2025 (5-minute cache writes). Check both before relying on them.',
  models: {
    'claude-opus-4-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25, tier: 'large', downshift: 'claude-sonnet-4-5' },
    'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15, tier: 'medium', downshift: 'claude-haiku-4-5' },
    'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5, tier: 'small' },
    'gpt-5-nano': { input: 0.05, cacheRead: 0.005, cacheWrite: 0.05, output: 0.4, tier: 'small' },
    'gpt-5-mini': { input: 0.25, cacheRead: 0.025, cacheWrite: 0.25, output: 2, tier: 'medium', downshift: 'gpt-5-nano' },
    'gpt-5.4': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15, tier: 'large' },
    'gpt-5': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10, tier: 'large', downshift: 'gpt-5-mini' },
  },
};

// Relative units, when real prices aren't known or don't matter (comparing harnesses on the same footing): every model at
// 1 per million fresh input tokens, cache reads 0.1, cache writes 1.25, output 5 — the usual shape of API price lists.
export const RELATIVE = { relative: true, source: 'relative units (1 = a million fresh input tokens)', models: {} };
const RELATIVE_ENTRY = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

export function priceTable(prices = DEFAULT_PRICES) {
  if (prices === 'relative' || (prices && prices.relative)) return { find: m => (m ? { key: '*', ...RELATIVE_ENTRY } : null), source: RELATIVE.source, asOf: null, currency: 'units', relative: true };
  const models = (prices && prices.models) || {};
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  const find = model => {
    if (!model) return null;
    const m = String(model).toLowerCase().replace(/^(anthropic|openai|us\.anthropic|global\.anthropic|bedrock|vertex_ai)[./:]/, '');
    // exact, or a prefix that ends where the id's next part starts ("gpt-5" prices "gpt-5-codex", not "gpt-5.5")
    const k = keys.find(x => m === x.toLowerCase()) || keys.find(x => m.startsWith(x.toLowerCase()) && /^[-@:_]/.test(m.slice(x.length)));
    return k ? { key: k, ...models[k] } : null;
  };
  return { find, source: prices === DEFAULT_PRICES ? 'example prices (pass --prices)' : (prices.source || 'price file'), asOf: prices.asOf, currency: prices.currency || 'USD' };
}

// $ per token for one call: { in, read, write, out, source } or null when unpriced.
const PER_M = 1e6;
export function perToken(entry, source) {
  if (!entry || entry.input == null) return null;
  const inP = entry.input / PER_M;
  return { in: inP, read: (entry.cacheRead ?? entry.input) / PER_M, write: (entry.cacheWrite ?? entry.input) / PER_M, out: (entry.output ?? entry.input) / PER_M, source };
}
export const costWith = (c, p) => (p ? Math.max(0, (c.input || 0) - (c.cacheRead || 0) - (c.cacheWrite || 0)) * p.in + (c.cacheRead || 0) * p.read + (c.cacheWrite || 0) * p.write + (c.output || 0) * p.out : null);

// A cost the harness recorded but no price list: spread it over the call's tokens with typical ratios
// (cache read 0.1×, cache write 1.25×, output 5× input) so the waste checks can still price their parts.
export function fromRecordedCost(c) {
  const units = Math.max(0, (c.input || 0) - (c.cacheRead || 0) - (c.cacheWrite || 0)) + 0.1 * (c.cacheRead || 0) + 1.25 * (c.cacheWrite || 0) + 5 * (c.output || 0);
  if (!(units > 0) || !(c.costUSD >= 0)) return null;
  const u = c.costUSD / units;
  return { in: u, read: 0.1 * u, write: 1.25 * u, out: 5 * u, source: 'harness-recorded cost' };
}

export function priceCalls(calls, table, gpuPrices = new Map()) {
  for (const c of calls) {
    const g = gpuPrices.get(c);
    const listed = table.find(c.model);
    let p = g || null;
    if (!p && c.costUSD != null) { const lp = perToken(listed, table.source); const lc = costWith(c, lp); p = lp && lc > 0 ? scale(lp, c.costUSD / lc, 'harness-recorded cost') : fromRecordedCost(c); }
    if (!p) p = perToken(listed, table.source);
    c.price = p; c.cost = p ? (g && g.total != null ? g.total : c.costUSD ?? costWith(c, p)) : null;
    c.tier = listed && listed.tier; c.downshift = listed && listed.downshift;
    // the cheaper model's prices, for the model-tier check (not written out)
    if (c.downshift) Object.defineProperty(c, 'cheaper', { value: perToken(table.find(c.downshift), table.source), enumerable: false, configurable: true });
  }
  return calls;
}
const scale = (p, k, source) => ({ in: p.in * k, read: p.read * k, write: p.write * k, out: p.out * k, source });
