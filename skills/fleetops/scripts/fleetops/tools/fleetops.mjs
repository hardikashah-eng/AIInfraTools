#!/usr/bin/env node
// fleetops: the shared data layer for AIInfraTools, with calibration, root-cause analysis and optimization on top.
// This file parses arguments and dispatches; each area's commands live in cmd/<area>.mjs (data, calibrate, incidents,
// capacity, shadow, rollout, training, serving, server), with shared helpers in cmd/common.mjs and the usage in cmd/help.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, SCHEMA } from '../src/store.mjs';
import * as Retention from '../src/retention.mjs';
import { args, J, OUT, setJson } from './cmd/common.mjs';
import { HELP } from './cmd/help.mjs';
import { sendCmd, demo, procureCmd, dataCmd } from './cmd/data.mjs';
import { calibrate } from './cmd/calibrate.mjs';
import { rca, pull, backtest, gameday, incidents, inject } from './cmd/incidents.mjs';
import { powerCmd, admitCmd } from './cmd/capacity.mjs';
import { shadowCmd } from './cmd/shadow.mjs';
import { rolloutCmd, optimize } from './cmd/rollout.mjs';
import { goodputCmd, tuneCmd, sdcCmd } from './cmd/training.mjs';
import { servingCmd } from './cmd/serving.mjs';
import { tokenCmd, agentCmd, serve } from './cmd/server.mjs';

async function main() {
  const o = args(process.argv.slice(2));
  setJson(!!o.json);
  const [area, cmd, ...rest] = o._;
  if (!area || o.help || area === 'help') return console.log(HELP);
  if (o['on-prem'] && process.env.FLEETOPS_EGRESS_ALLOW == null) process.env.FLEETOPS_EGRESS_ALLOW = typeof o['on-prem'] === 'string' ? o['on-prem'] : '';
  if (area === 'token') return tokenCmd(cmd, o);
  if (area === 'procure') return procureCmd(cmd, o);
  if (area === 'send') return sendCmd(o);
  const store = await openStore(o.store && o.store !== true ? o.store : 'fleet-data', { backend: o.backend && o.backend !== true ? o.backend : undefined });
  // the hourly rollup answers long lookbacks (root-cause "day before") when it exists
  if (fs.existsSync(path.join(store.dir, 'rollup-3600', 'device'))) store.coarse = await Retention.rollupStore(store, 3600);
  if (store.meta && store.meta.schema < SCHEMA && !(area === 'data' && cmd === 'migrate')) console.error(`note: store ${store.dir} is schema ${store.meta.schema}; run \`fleetops data migrate --apply\` to bring it to ${SCHEMA}`);
  if (area === 'serve') return serve(store, o);
  if (area === 'calibrate') return calibrate(store, cmd, o);
  if (area === 'rca') return rca(store, cmd, o);
  if (area === 'optimize') return optimize(store, cmd, o);
  if (area === 'admit') return admitCmd(store, cmd, o);
  if (area === 'rollout') return rolloutCmd(store, cmd, o);
  if (area === 'shadow') return shadowCmd(store, cmd, rest, o);
  if (area === 'inject') return inject(store, cmd, o);
  if (area === 'incidents') return incidents(store, cmd, rest, o);
  if (area === 'backtest') return backtest(store, o);
  if (area === 'gameday') return gameday(store, cmd, o);
  if (area === 'pull') return pull(store, cmd, o);
  if (area === 'demo') return demo(store, o);
  if (area === 'agent') return agentCmd(store, cmd, o);
  if (area === 'goodput') return goodputCmd(store, o);
  if (area === 'sdc') return sdcCmd(store, o);
  if (area === 'tune') return tuneCmd(store, cmd, o);
  if (area === 'serving') return servingCmd(store, cmd, o);
  if (area === 'power') return powerCmd(store, cmd, o);
  if (area !== 'data') throw new Error(`unknown command "${area}"\n\n${HELP}`);
  return dataCmd(store, cmd, rest, o);
}

const self = fileURLToPath(import.meta.url);
// realpath: npm installs bins as symlinks, so argv[1] is the link, not this file
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(self)) {
  main().then(() => { if (J && Object.keys(OUT).length) console.log(JSON.stringify(OUT, null, 1)); })
    .catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error('error: ' + e.message); process.exit(1); });
}
