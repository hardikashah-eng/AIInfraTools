// Cloud bills → usage records, priced at what the bill says (rate = billed $ per GPU-hour, rateBasis 'bill').
// The GPU type and count come from the instance type, through the shared accelerator registry.
//
// AWS Cost and Usage Report: the CUR 2.0 data export (snake_case columns; product, resource_tags and tags as JSON maps
// in CSV) or the legacy CUR (lineItem/…, product/…, resourceTags/user:… columns). It needs resource IDs
// (INCLUDE_RESOURCES) to give one record per instance; without them, one per usage type and hour. Hourly granularity
// gives one record per instance-hour; daily works too (a day's usage spread over the day).
import { createRequire } from 'node:module';
import { parseCsv } from './adapters.mjs';
import { gpuKey } from './core.mjs';

const REG = createRequire(import.meta.url)('../../inference-sizer/src/accelerators.js');
const t = s => (s == null || s === '' ? null : Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z') / 1000));
const map = v => { if (!v) return {}; if (typeof v === 'object') return v; try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const num = v => (v == null || v === '' ? null : +v);

const COLS = {
  start: ['line_item_usage_start_date', 'lineItem/UsageStartDate'], end: ['line_item_usage_end_date', 'lineItem/UsageEndDate'],
  product: ['line_item_product_code', 'lineItem/ProductCode'], usageType: ['line_item_usage_type', 'lineItem/UsageType'],
  itemType: ['line_item_line_item_type', 'lineItem/LineItemType'], resource: ['line_item_resource_id', 'lineItem/ResourceId'],
  amount: ['line_item_usage_amount', 'lineItem/UsageAmount'], unblended: ['line_item_unblended_cost', 'lineItem/UnblendedCost'],
  spCost: ['savings_plan_savings_plan_effective_cost', 'savingsPlan/SavingsPlanEffectiveCost'], riCost: ['reservation_effective_cost', 'reservation/EffectiveCost'],
  instanceType: ['product_instance_type', 'product/instanceType'], region: ['product_region_code', 'product/regionCode', 'product_region', 'product/region'],
  account: ['line_item_usage_account_id', 'lineItem/UsageAccountId'],
};
const col = (r, k) => { for (const c of COLS[k]) if (r[c] != null && r[c] !== '') return r[c]; return null; };
// user-defined cost allocation tags: CUR 2.0 writes user:team as user_team in its maps; legacy CUR as resourceTags/user:team
function tagsOf(r) {
  const out = {};
  for (const m of [map(r.resource_tags), map(r.tags)]) for (const [k, v] of Object.entries(m)) if (v != null && v !== '') out[k.replace(/^(user|resource_tags_user)[_:]/, '')] = String(v);
  for (const [k, v] of Object.entries(r)) { const x = k.match(/^resourceTags\/user:(.+)$/) || k.match(/^resource_tags_user_(.+)$/); if (x && v) out[x[1]] = v; }
  return out;
}
// how the hour was bought, from the line item type and usage type
const purchaseOf = (itemType, usageType) => itemType === 'SavingsPlanCoveredUsage' ? 'savings-plan' : itemType === 'DiscountedUsage' ? 'reserved'
  : /SpotUsage/i.test(usageType || '') ? 'spot' : /CapacityBlock/i.test(usageType || '') ? 'capacity-block' : 'on-demand';

export function awsCur(text, { cluster = null } = {}) {
  const rows = typeof text === 'string' ? parseCsv(text) : text, out = [], skipped = { notEc2: 0, notGpu: 0, notUsage: 0 }, unknownTypes = new Set();
  rows.forEach((r, i) => {
    if (col(r, 'product') !== 'AmazonEC2') { skipped.notEc2++; return; }
    const itemType = col(r, 'itemType'), usageType = col(r, 'usageType') || '';
    if (!['Usage', 'DiscountedUsage', 'SavingsPlanCoveredUsage'].includes(itemType) || !/(Box|Spot|Dedicated|Host|CapacityBlock)Usage|CapacityBlock/i.test(usageType)) { skipped.notUsage++; return; }
    const itype = col(r, 'instanceType') || map(r.product).instance_type || (usageType.split(':')[1] || null), inst = REG.instanceOf(itype);
    if (!inst) { skipped.notGpu++; if (itype && /^(p|g|trn|inf|dl)\d/.test(itype)) unknownTypes.add(itype); return; }
    const start = t(col(r, 'start')), end = t(col(r, 'end')), hours = num(col(r, 'amount'));
    if (start == null || end == null || !(end > start) || !(hours > 0)) { skipped.notUsage++; return; }
    const cost = itemType === 'SavingsPlanCoveredUsage' ? num(col(r, 'spCost')) : itemType === 'DiscountedUsage' ? num(col(r, 'riCost')) : num(col(r, 'unblended'));
    const tags = tagsOf(r), resource = col(r, 'resource');
    out.push({ id: `${resource || usageType}@${start}`, start, end, gpus: inst.gpus * hours / ((end - start) / 3600), gpuType: gpuKey(inst.chip), cluster: tags.cluster || cluster, provider: 'aws',
      region: col(r, 'region') || undefined, node: resource || undefined, kind: 'instance', name: tags.Name || tags.name || resource || itype, labels: tags, group: resource || itype,
      instanceType: itype, purchase: purchaseOf(itemType, usageType), account: col(r, 'account') || undefined,
      ...(cost != null ? { rate: cost / (hours * inst.gpus), billed: cost } : {}), source: 'aws-cur' });
    for (const k of Object.keys(out[out.length - 1])) if (out[out.length - 1][k] === undefined) delete out[out.length - 1][k];
  });
  out.skipped = skipped; out.unknownTypes = [...unknownTypes];
  return out;
}

// Google Cloud Billing export to BigQuery (standard or detailed usage cost), as JSON lines or a JSON array — what
// `bq query --format=json` or an export to newline-delimited JSON gives (CSV can't hold its nested labels and credits).
// GPUs and TPUs are billed as their own SKUs ("Nvidia H100 80GB GPU running in Americas", "TpuV6e running in
// Americas"), metered in seconds of one device: so GPU-hours = usage seconds ÷ 3600, and the record covers the
// accelerator charges only (the VM's vCPU and memory are other lines). Cost is net of credits (committed-use and
// sustained-use discounts, promotions). Commitment fee lines ("Commitment v1: …") are not usage and are skipped.
const get = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o) ?? o[k];
function gcpChip(sku) {
  const s = String(sku || '');
  const tpu = s.match(/\bTpu\s?(V\w+)|\bTPU\s?(v\d\w*|7x)|Ironwood|Trillium/i);
  if (tpu) { const m = REG.match(`tpu ${(tpu[1] || tpu[2] || tpu[0]).toLowerCase()}`); return m ? { chip: m.id, kind: 'tpu' } : null; }
  const g = s.match(/\bNvidia\s+(?:Tesla\s+)?(.+?)\s+GPU\b/i);
  if (!g) return null;
  const name = g[1];
  if (/A100/i.test(name) && !/80\s?GB/i.test(name)) return { chip: 'A100-40GB', kind: 'gpu' };
  const m = REG.match(`NVIDIA ${name}`);
  return m ? { chip: m.id, kind: 'gpu' } : { chip: name, kind: 'gpu', unknown: true };
}
const gcpPurchase = (sku, credits) => /\bSpot\b|Preemptible/i.test(sku) ? 'spot' : /Calendar Mode/i.test(sku) ? 'calendar-mode' : /Flex[- ]?start|DWS/i.test(sku) ? 'flex-start'
  : (credits || []).some(c => /COMMITTED_USAGE/i.test(c.type || '')) ? 'committed' : 'on-demand';
export function gcpBilling(text, { cluster = null } = {}) {
  const rows = typeof text !== 'string' ? text : text.trim().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  const out = [], skipped = { notAccelerator: 0, commitmentFee: 0, notUsage: 0 }, unknownSkus = new Set();
  for (const r of rows) {
    const sku = get(r, 'sku.description') || '';
    if (/^Commitment/i.test(sku)) { skipped.commitmentFee++; continue; }
    const c = gcpChip(sku);
    if (!c) { skipped.notAccelerator++; continue; }
    if (c.unknown) unknownSkus.add(sku);
    const start = t(get(r, 'usage_start_time')), end = t(get(r, 'usage_end_time')), unit = String(get(r, 'usage.unit') || 'seconds'), amount = +get(r, 'usage.amount');
    const secs = /^s(ec(ond)?s?)?$|seconds/i.test(unit) ? amount : /^h(our)?s?$/i.test(unit) ? amount * 3600 : NaN;
    if (start == null || end == null || !(end > start) || !(secs > 0)) { skipped.notUsage++; continue; }
    const credits = get(r, 'credits') || [], cost = +(get(r, 'cost') || 0) + credits.reduce((a, x) => a + (+x.amount || 0), 0);
    const labels = Object.fromEntries((get(r, 'labels') || []).map(l => [l.key, String(l.value)]));
    const resource = get(r, 'resource.name') || undefined, project = get(r, 'project.id');
    const rec = { id: `${resource || `${project}/${sku}`}@${start}`, start, end, gpus: secs / (end - start), gpuType: gpuKey(c.chip), kind: c.kind === 'tpu' ? 'tpu' : 'instance',
      cluster: labels['goog-k8s-cluster-name'] || labels.cluster || cluster, provider: 'gcp', region: get(r, 'location.region') || undefined, node: resource, project,
      namespace: labels['k8s-namespace'], name: labels['k8s-workload-name'] || resource || sku, labels, group: resource || sku, purchase: gcpPurchase(sku, credits), sku,
      rate: cost / (secs / 3600), billed: cost, source: 'gcp-billing' };
    for (const k of Object.keys(rec)) if (rec[k] === undefined || rec[k] === null) delete rec[k];
    out.push(rec);
  }
  out.skipped = skipped; out.unknownSkus = [...unknownSkus];
  return out;
}
