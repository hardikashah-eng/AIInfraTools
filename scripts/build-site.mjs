#!/usr/bin/env node
// Assembles the GitHub Pages site in _site/ (or the folder given): the landing page, the two browser tools as built
// in the repository, and the screenshots the landing page shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES = {
  'index.html': 'site/index.html',
  'sizer/index.html': 'inference-sizer/dist/index.html',
  'fleetscope/index.html': 'fleetscope/dist/index.html',
  'img/sizer.png': 'inference-sizer/docs/img/overview.png',
  'img/what-fits.png': 'inference-sizer/docs/img/what-fits.png',
  'img/fleetscope.png': 'fleetscope/docs/img/editor.png',
};

export function build(out = path.join(ROOT, '_site')) {
  fs.rmSync(out, { recursive: true, force: true });
  for (const [to, from] of Object.entries(PAGES)) {
    const dst = path.join(out, to); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(ROOT, from), dst);
  }
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`site in ${path.relative(process.cwd(), build(process.argv[2] && path.resolve(process.argv[2])))}`);
