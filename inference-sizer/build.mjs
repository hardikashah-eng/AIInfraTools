// Builds dist/index.html: one self-contained page with the catalog, model, FleetScope exporter and UI inlined.
// Usage: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(here, p), 'utf8');

const inlined = {
  '/*CATALOG*/': read('src/catalog.js'),
  '/*MODEL*/': read('src/model.js'),
  '/*FLEETSCOPE*/': read('src/fleetscope.js'),
  '/*UI*/': read('src/ui.js'),
};

let out = read('src/index.src.html');
for (const [marker, code] of Object.entries(inlined)) {
  if (!out.includes(marker)) throw new Error(`Marker ${marker} missing from src/index.src.html`);
  if (code.includes('</script')) throw new Error(`Inlined code for ${marker} contains a closing script tag`);
  out = out.replace(marker, () => code);
}

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/index.html'), out);
console.log(`dist/index.html written (${(out.length / 1024).toFixed(0)} KB)`);
