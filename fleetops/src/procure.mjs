// Procurement lookups: a GPU need (type, count, days) → the cloud's own read-only command that lists what can be
// bought, so a capacity plan ends in something to check rather than a number. Nothing here buys anything: purchases
// stay with a person, in the cloud's console or CLI.
//
// AWS EC2 Capacity Blocks for ML (docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-blocks-purchase.html):
// `aws ec2 describe-capacity-block-offerings` with an instance type and count, a duration in 1-day steps up to
// 14 days and 7-day steps up to 182 days, and a date range to start in.
// GCP Dynamic Workload Scheduler calendar mode (future reservations of GPUs or TPUs, up to 90 days):
// `gcloud compute advice calendar-mode` recommends a start time and zone (docs.cloud.google.com/sdk/gcloud/reference/compute/advice/calendar-mode).
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

// GCP calendar mode: the read-only `gcloud compute advice calendar-mode` for `gpus` GPUs (machine type and VM count)
// or TPU chips (TPU version and chip count) for `days`, starting within [from, from + windowDays]
const TPU_VERSION = { 'TPU-v5e': 'V5E', 'TPU-v5p': 'V5P', 'TPU-v6e': 'V6E' };
export function gcpCalendarMode({ chip, machineType, gpus, days, region, from = Math.floor(Date.now() / 1000), windowDays = 14, workload = 'BATCH' }) {
  if (!(gpus > 0) || !(days > 0)) throw new Error('need --gpus N and --days N');
  if (!region) throw new Error('need --region (e.g. us-central1)');
  const notes = [], d = Math.min(Math.ceil(days), 90), day = s => iso(s).slice(0, 10);
  if (days > 90) notes.push('Calendar mode reserves at most 90 days: asking for 90.');
  const a = REG.match(chip || '') || {}, common = [`--region=${region}`, `--duration-range=min=${d}d,max=${d}d`, `--start-time-range=from=${day(from)},to=${day(from + windowDays * DAY)}`];
  let argv;
  if (a.kind === 'tpu') {
    const v = TPU_VERSION[a.id];
    if (!v) notes.push(`Check \`gcloud compute advice calendar-mode --help\` for the --tpu-version value of ${a.id}.`);
    argv = ['gcloud', 'compute', 'advice', 'calendar-mode', `--tpu-version=${v || a.id.toUpperCase()}`, `--chip-count=${gpus}`, `--workload-type=${workload}`, ...common];
    return { cloud: 'gcp', chip: a.id, chips: gpus, days: d, argv, notes: notes.concat(['Read-only: it recommends when and where the capacity is available. Creating the future reservation is a separate step a person takes.']) };
  }
  const options = machineType ? [{ type: machineType, gpus: (REG.instanceOf(machineType) || {}).gpus }] : instancesFor(chip, 'gcp');
  const pick = options.find(o => o.gpus >= 8) || options[0];
  if (!pick || !pick.gpus) throw new Error(`no GCP machine type known for ${machineType || chip}`);
  const vms = Math.ceil(gpus / pick.gpus);
  if (vms * pick.gpus > gpus) notes.push(`${vms} × ${pick.type} is ${vms * pick.gpus} GPUs (asked for ${gpus}).`);
  argv = ['gcloud', 'compute', 'advice', 'calendar-mode', `--machine-type=${pick.type}`, `--vm-count=${vms}`, ...common];
  notes.push('Read-only: it recommends when and where the capacity is available. Creating the future reservation is a separate step a person takes.');
  return { cloud: 'gcp', machineType: pick.type, gpusPerVm: pick.gpus, vms, days: d, argv, notes };
}
