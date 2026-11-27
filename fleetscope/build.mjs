// Builds dist/index.html: a single self-contained page with the engine and templates inlined.
// Usage: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(here, p), 'utf8');

const page = read('src/index.src.html');
const inlined = {
  '/*ACCELERATORS*/': readFileSync(join(here, '../inference-sizer/src/accelerators.js'), 'utf8'),
  // the sizer's catalog and model: FleetScope's model list comes from the catalog, its KV per token from the model
  '/*SIZERCATALOG*/': readFileSync(join(here, '../inference-sizer/src/catalog.js'), 'utf8'),
  '/*SIZERMODEL*/': readFileSync(join(here, '../inference-sizer/src/model.js'), 'utf8'),
  '/*ENGINE*/': read('src/engine.js'),
  '/*TEMPLATES*/': read('src/templates.js'),
  '/*INGEST*/': read('src/ingest.js'),
  '/*CALIBRATE*/': read('src/calibrate.js'),
  '/*FORECAST*/': read('src/forecast.js'),
  '/*SCENARIO*/': read('src/scenario.js'),
  '/*CLUSTER*/': read('src/cluster.js'),
  '/*CLUSTERUI*/': read('src/cluster-ui.js'),
  '/*TRAINING*/': read('src/training.js'),
  '/*PLAN*/': read('src/plan.js'),
  '/*OPTIMIZE*/': read('src/optimize.js'),
  '/*ASK*/': read('src/ask.js'),
  '/*TRAININGUI*/': read('src/training-ui.js'),
  '/*INFERENCEUI*/': read('src/inference-ui.js'),
};

let out = page;
for (const [marker, code] of Object.entries(inlined)) {
  if (!out.includes(marker)) throw new Error(`Marker ${marker} missing from src/index.src.html`);
  if (code.includes('</script')) throw new Error(`Inlined code for ${marker} contains a closing script tag`);
  out = out.replace(marker, () => code);
}

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/index.html'), out);
console.log(`dist/index.html written (${(out.length / 1024).toFixed(0)} KB)`);
