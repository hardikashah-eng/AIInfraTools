// Relative links in the top-level docs point at files that exist, and #anchors at headings that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = h => h.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');
const anchors = f => new Set(fs.readFileSync(f, 'utf8').split('\n').filter(l => /^#{1,6} /.test(l)).map(l => slug(l.replace(/^#+ /, ''))));

for (const doc of ['README.md', 'docs/RESULTS.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
  test(`links in ${doc} resolve`, () => {
    const file = path.join(ROOT, doc), text = fs.readFileSync(file, 'utf8');
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(u => !/^(https?:|mailto:|#)/.test(u));
    assert.ok(links.length > 0);
    for (const l of links) {
      const [p, a] = l.split('#'), target = path.resolve(path.dirname(file), p);
      assert.ok(fs.existsSync(target), `${doc}: ${l} does not exist`);
      if (a && target.endsWith('.md')) assert.ok(anchors(target).has(a), `${doc}: no heading #${a} in ${p}`);
    }
  });
}
