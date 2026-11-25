// Procurement lookups: a GPU need (type, count, days) → the cloud's own read-only command that lists what can be
// bought, so a capacity plan ends in something to check rather than a number. Nothing here buys anything: purchases
// stay with a person, in the cloud's console or CLI.
//
// AWS EC2 Capacity Blocks for ML (docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-blocks-purchase.html):
// `aws ec2 describe-capacity-block-offerings` with an instance type and count, a duration in 1-day steps up to
// 14 days and 7-day steps up to 182 days, and a date range to start in.
import { createRequire } from 'node:module';

const REG = createRequire(import.meta.url)('../../inference-sizer/src/accelerators.js');
const DAY = 86400;
const iso = s => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// instance types on a cloud that carry this chip, largest first
export function instancesFor(chip, cloud) {
  const want = (REG.match(chip) || {}).id || chip;
  return Object.entries(REG.INSTANCES).filter(([, v]) => v.cloud === cloud && ((REG.match(v.chip) || {}).id || v.chip) === want)
    .map(([type, v]) => ({ type, gpus: v.gpus })).sort((a, b) => b.gpus - a.gpus);
}

// AWS Capacity Blocks: the describe command for `gpus` of `chip` (or an --instance-type) for `days`, starting within
// [from, from + windowDays]
export function awsCapacityBlocks({ chip, instanceType, gpus, days, from = Math.floor(Date.now() / 1000), windowDays = 14 }) {
  if (!(gpus > 0) || !(days > 0)) throw new Error('need --gpus N and --days N');
  const options = instanceType ? [{ type: instanceType, gpus: (REG.instanceOf(instanceType) || {}).gpus }] : instancesFor(chip, 'aws');
  const pick = options.find(o => o.gpus >= 8) || options[0];
  if (!pick || !pick.gpus) throw new Error(`no AWS instance type known for ${instanceType || chip}; known: ${[...new Set(Object.values(REG.INSTANCES).filter(v => v.cloud === 'aws').map(v => v.chip))].join(', ')}`);
  const notes = [];
  let d = Math.ceil(days);
  if (d > 14) { const r = Math.ceil(d / 7) * 7; if (r !== d) notes.push(`Capacity Blocks longer than 14 days come in 7-day steps: asking for ${r} days instead of ${d}.`); d = r; }
  if (d > 182) { notes.push('Capacity Blocks run at most 182 days: asking for 182.'); d = 182; }
  const instances = Math.ceil(gpus / pick.gpus);
  if (instances * pick.gpus > gpus) notes.push(`${instances} × ${pick.type} is ${instances * pick.gpus} GPUs (asked for ${gpus}).`);
  if (/p6e-gb200/.test(pick.type)) notes.push('P6e-GB200 is sold as UltraServers: use --ultraserver-type u-p6e-gb200x36 or u-p6e-gb200x72 with --ultraserver-count instead.');
  const argv = ['aws', 'ec2', 'describe-capacity-block-offerings', '--instance-type', pick.type, '--instance-count', String(instances),
    '--capacity-duration-hours', String(d * 24), '--start-date-range', iso(from), '--end-date-range', iso(from + windowDays * DAY)];
  notes.push('Read-only: it lists offerings and their upfront fee. Buying one (purchase-capacity-block) cannot be cancelled: a person does that.');
  return { cloud: 'aws', instanceType: pick.type, gpusPerInstance: pick.gpus, instances, days: d, argv, notes };
}
