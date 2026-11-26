// Shared by the tests that check manifests against real CRD schemas (fixtures/real/*/…schema.json.gz).
// The structural subset of OpenAPI v3 the API server enforces for CRDs: types, required (after defaults), enums,
// int-or-string, and
// unknown fields (kubectl's default --validate=strict rejects them).
export function validate(schema, v, at = '', errs = []) {
  if (v == null) return errs;
  if (schema['x-kubernetes-int-or-string']) { if (!(Number.isInteger(v) || typeof v === 'string')) errs.push(`${at}: int or string, got ${typeof v}`); return errs; }
  const t = schema.type, kind = Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  const ok = !t || t === kind || (t === 'number' && kind === 'integer') || (t === 'object' && kind === 'object');
  if (!ok) { errs.push(`${at || '/'}: ${t} expected, got ${kind}`); return errs; }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${schema.enum.join('|')}`);
  if (Number.isFinite(schema.minimum) && typeof v === 'number' && v < schema.minimum) errs.push(`${at}: ${v} < ${schema.minimum}`);
  if (kind === 'array' && schema.items) v.forEach((x, i) => validate(schema.items, x, `${at}[${i}]`, errs));
  if (kind === 'object') {
    for (const r of schema.required || []) if (!(r in v) && (schema.properties || {})[r]?.default === undefined) errs.push(`${at}: missing ${r}`); // defaults apply before validation
    const props = schema.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) validate(props[k], x, `${at}.${k}`, errs);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, x, `${at}.${k}`, errs);
      else if (schema.properties && !schema['x-kubernetes-preserve-unknown-fields'] && schema.additionalProperties !== true) errs.push(`${at}: unknown field ${k}`);
    }
  }
  return errs;
}
