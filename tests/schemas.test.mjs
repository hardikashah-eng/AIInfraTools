// Every --json command still matches its schema (the contract in schemas/), and the check catches the changes that
// break consumers: a removed field, a renamed one, a changed type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMMANDS } from '../schemas/commands.mjs';
import { outputs, schemaPath, validate } from '../scripts/schemas.mjs';

for (const cmd of COMMANDS) {
  test(`${cmd.id} matches schemas/${cmd.id}.schema.json`, { timeout: 300000 }, () => {
    const s = JSON.parse(fs.readFileSync(schemaPath(cmd.id), 'utf8'));
    assert.ok((s.required || s.items?.required || []).length > 0, 'the schema requires something');
    for (const r of outputs(cmd)) assert.deepEqual(validate(s, r), []);
  });
}

test('the check fails on a removed field, a renamed one, and a changed type; an added field is fine', () => {
  const s = JSON.parse(fs.readFileSync(schemaPath('sizer.plan'), 'utf8'));
  const [out] = outputs(COMMANDS.find(c => c.id === 'sizer.plan'));
  const key = s.required[0], other = s.required.find(k => typeof out[k] === 'number') || s.required[1];
  const removed = { ...out }; delete removed[key];
  assert.ok(validate(s, removed).some(e => e.includes(`missing "${key}"`)));
  const renamed = { ...out, [key + 'X']: out[key] }; delete renamed[key];
  assert.ok(validate(s, renamed).length > 0);
  const retyped = { ...out, [other]: typeof out[other] === 'number' ? String(out[other]) : 42 };
  assert.ok(validate(s, retyped).some(e => e.includes(other)));
  assert.deepEqual(validate(s, { ...out, brandNewField: 1 }), []);
});
