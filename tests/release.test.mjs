// Release notes come from the CHANGELOG section for the package's version, with links that work on GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { notes } from '../scripts/release-notes.mjs';

test('the package version has a CHANGELOG section, and its notes link out correctly', () => {
  const v = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const n = notes(v);
  assert.match(n, /npx aiinfra-tools/); assert.match(n, /### New/);
  assert.doesNotMatch(n, /\]\((?!https?:)/, 'no relative links left');
  // PR numbers and relative links are made absolute (checked on a small changelog, so it holds for any version)
  const fake = notes('1.2.3', '# Changelog\n\n## 1.2.3 (2026-12)\n\n### New\n\n- thing (#56), see [docs](docs/X.md)\n\n## 1.2.2\n\n- old\n');
  assert.match(fake, /\[#56\]\(https:\/\/github\.com\/hardikashah-eng\/AIInfraTools\/pull\/56\)/);
  assert.match(fake, /\]\(https:\/\/github\.com\/hardikashah-eng\/AIInfraTools\/blob\/main\/docs\/X\.md\)/); assert.doesNotMatch(fake, /old/);
  assert.throws(() => notes('9.9.9'), /no "## 9.9.9" section/);
});
