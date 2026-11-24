// Fault injection for a test cluster: known faults with ground-truth labels, so detection and diagnosis can be
// measured against faults that really happened, through the real collectors and real log formats.
//
// Safety, in order:
//   1. Dry-run unless --live. A dry run prints the commands and writes nothing.
//   2. Every target (node, host, release, server, interface) must be listed in an allowlist file you keep for the test
//      cluster. A target not on it stops the run before any command runs. Never list production hosts.
//   3. Values are checked: names and numbers only, so nothing a target string contains can become a command.
//   4. Faults with an undo revert after --for seconds, also on Ctrl-C. The injection record says whether undo ran.
//   5. Every live injection is written to the store as an `injection` record: the label `rca bench --injections` scores.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,252}$/, NUM = /^\d{1,10}$/, PCI = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}(\.\d)?$/, SET = /^[A-Za-z0-9._\/-]+=[A-Za-z0-9._:\/@,-]*$/;

// fault → what it needs, what it runs, how to undo it, and the rule a correct diagnosis ranks first (null: measured
// for detection only until the rule exists). DCGM field IDs: 230 XID, 311 DBE volatile total, 313 DBE aggregate total.
export const FAULTS = {
  'xid': {
    what: 'An XID on one GPU, seen by DCGM (exporter, gpu-health) and, with --kmsg, in the kernel log',
    params: { node: NAME, gpu: NUM, xid: NUM }, defaults: { xid: '79' }, targets: ['node'], expect: 'hardware',
    apply: p => [['ssh', p.node, 'sudo', 'dcgmi', 'test', '--inject', '--gpuid', p.gpu, '--field', '230', '--value', p.xid],
      ...(p.kmsg ? [['ssh', p.node, `printf '<3>NVRM: Xid (PCI:%s): %s, pid=0, name=fleetops-inject, injected by fleetops\\n' ${p.pci} ${p.xid} | sudo tee /dev/kmsg >/dev/null`]] : [])],
    revert: null, note: 'DCGM keeps the injected value until a new sample replaces it; restart nv-hostengine to clear it early. --kmsg needs --pci (the GPU\'s bus id).',
  },
  'ecc-dbe': {
    what: 'Uncorrectable (double-bit) ECC errors on one GPU, seen by DCGM',
    params: { node: NAME, gpu: NUM, count: NUM }, defaults: { count: '2' }, targets: ['node'], expect: 'hardware',
    apply: p => [['ssh', p.node, 'sudo', 'dcgmi', 'test', '--inject', '--gpuid', p.gpu, '--field', '311', '--value', p.count],
      ['ssh', p.node, 'sudo', 'dcgmi', 'test', '--inject', '--gpuid', p.gpu, '--field', '313', '--value', p.count]],
    revert: null, note: 'Injected values age out like any DCGM sample.',
  },
  'nccl-stall': {
    what: 'One rank of a running NCCL job stops (SIGSTOP) for --for seconds: the collective hangs, the watchdog fires',
    params: { node: NAME, pid: NUM }, targets: ['node'], expect: null,
    apply: p => [['ssh', p.node, 'sudo', 'kill', '-STOP', p.pid]], revert: p => [['ssh', p.node, 'sudo', 'kill', '-CONT', p.pid]],
    note: 'Set the job\'s NCCL/PyTorch timeout below --for to see the watchdog. Diagnosis (straggler, collective hang) arrives with milestone 8.',
  },
  'nic-down': {
    what: 'One node\'s RDMA network interface down (RoCE/Ethernet netdev) for --for seconds',
    params: { node: NAME, iface: NAME }, targets: ['node', 'iface'], expect: 'hardware',
    apply: p => [['ssh', p.node, 'sudo', 'ip', 'link', 'set', 'dev', p.iface, 'down']], revert: p => [['ssh', p.node, 'sudo', 'ip', 'link', 'set', 'dev', p.iface, 'up']],
    note: 'For InfiniBand use ib-port-down from a host with fabric management access.',
  },
  'ib-port-down': {
    what: 'An InfiniBand switch or HCA port disabled with ibportstate, from a fabric management host',
    params: { host: NAME, lid: NUM, port: NUM, nodes: NAME }, targets: ['host', 'nodes'], expect: 'hardware',
    apply: p => [['ssh', p.host, 'sudo', 'ibportstate', p.lid, p.port, 'disable']], revert: p => [['ssh', p.host, 'sudo', 'ibportstate', p.lid, p.port, 'enable']],
    note: '--nodes lists the hosts behind the port (comma-separated), for the label. A leaf\'s uplinks give a shared-component fault: pass --expect shared-component.',
  },
  'nfs-block': {
    what: 'NFS traffic from some nodes to one server dropped with iptables for --for seconds',
    params: { nodes: NAME, server: NAME }, targets: ['nodes', 'server'], expect: 'infrastructure', perNode: true,
    apply: p => [['ssh', p.node, 'sudo', 'iptables', '-I', 'OUTPUT', '-d', p.server, '-p', 'tcp', '--dport', '2049', '-j', 'DROP']],
    revert: p => [['ssh', p.node, 'sudo', 'iptables', '-D', 'OUTPUT', '-d', p.server, '-p', 'tcp', '--dport', '2049', '-j', 'DROP']],
    note: 'Jobs fail when they next touch the mount (checkpoints, data loading).',
  },
  'bad-deploy': {
    what: 'A Helm upgrade with one bad value, rolled back after --for seconds',
    params: { release: NAME, chart: NAME, namespace: NAME, set: SET, pool: NAME }, targets: ['release', 'namespace'], expect: 'change',
    apply: p => [['helm', 'upgrade', p.release, p.chart, '-n', p.namespace, '--reuse-values', '--set', p.set]], revert: p => [['helm', 'rollback', p.release, '-n', p.namespace]],
    note: 'Import `helm history` afterwards so the change is in the store. --pool names the serving pool for the label.',
  },
  'cordon': {
    what: 'Cordon a node (harmless): checks that changes reach the store end to end',
    params: { node: NAME }, targets: ['node'], expect: null,
    apply: p => [['kubectl', 'cordon', p.node]], revert: p => [['kubectl', 'uncordon', p.node]], note: '',
  },
};

// Parse and check the parameters of one injection. Throws on anything missing, malformed or not allowed.
export function prepare(fault, params, { allow = [] } = {}) {
  const F = FAULTS[fault];
  if (!F) throw new Error(`unknown fault "${fault}" (one of ${Object.keys(FAULTS).join(', ')})`);
  const p = Object.assign({}, F.defaults || {}, params);
  for (const [k, re] of Object.entries(F.params)) {
    if (p[k] == null || p[k] === true) throw new Error(`${fault} needs --${k}`);
    for (const v of String(p[k]).split(k === 'nodes' ? ',' : /^$/)) if (!re.test(v)) throw new Error(`--${k} "${v}" is not a plain name or number`);
  }
  if (p.kmsg && !PCI.test(String(p.pci || ''))) throw new Error('--kmsg needs --pci with the GPU\'s bus id (0000:3b:00.0)');
  const allowed = new Set(allow);
  const targets = F.targets.flatMap(k => String(p[k]).split(','));
  const off = targets.filter(t => !allowed.has(t));
  if (off.length) throw new Error(`not in the allowlist: ${off.join(', ')}. List test-cluster targets in the --allow file; never production.`);
  const nodes = p.nodes ? String(p.nodes).split(',') : p.node ? [p.node] : [];
  const apply = F.perNode ? nodes.flatMap(n => F.apply(Object.assign({}, p, { node: n }))) : F.apply(p);
  const revert = F.revert ? (F.perNode ? nodes.flatMap(n => F.revert(Object.assign({}, p, { node: n }))) : F.revert(p)) : null;
  return { fault, params: p, nodes, apply, revert, expect: p.expect && p.expect !== true ? p.expect : F.expect, pool: p.pool };
}

export const loadAllow = file => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean) : []);
const sh = argv => argv.map(a => (/^[\w.\/:@=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

// Run one prepared injection. runner(argv) → { status, stdout, stderr }; sleep(s) waits (both injectable for tests).
export async function run(prep, { live = false, forS = 300, store, now = () => Date.now() / 1000, runner, sleep, log = console.log } = {}) {
  const exec = runner || (argv => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000 }));
  const wait = sleep || (s => new Promise(r => setTimeout(r, s * 1000)));
  if (!live) {
    log(`dry run: ${prep.fault} on ${prep.nodes.join(', ') || prep.params.release || prep.params.host} (expect ${prep.expect || 'detection only'})`);
    for (const a of prep.apply) log(`  apply   ${sh(a)}`);
    if (prep.revert) { log(`  wait    ${forS} s`); for (const a of prep.revert) log(`  revert  ${sh(a)}`); }
    return { dryRun: true };
  }
  const rec = { t: now(), id: `inj-${prep.fault}-${Math.floor(now())}`, fault: prep.fault, expect: prep.expect, nodes: prep.nodes, pool: prep.pool, from: now(), forS, params: prep.params, source: 'fleetops-inject' };
  const runAll = list => list.map(a => { const r = exec(a); log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'} ${sh(a)}${r.status === 0 ? '' : `: ${(r.stderr || '').trim().slice(0, 200)}`}`); return r.status === 0; });
  let reverted = false;
  const undo = () => { if (prep.revert && !reverted) { reverted = true; rec.reverted = runAll(prep.revert).every(Boolean); rec.to = now(); } };
  const onSig = () => { undo(); if (store) store.append('injection', [Object.assign(rec, { interrupted: true, to: rec.to || now() })]); process.exit(130); };
  process.once('SIGINT', onSig);
  try {
    rec.applied = runAll(prep.apply).every(Boolean);
    if (!rec.applied) { undo(); rec.to = now(); return finish(); }
    if (prep.revert) { await wait(forS); undo(); } else rec.to = rec.from + forS; // no undo: the label covers --for seconds
  } finally { process.removeListener('SIGINT', onSig); }
  return finish();
  function finish() { if (store) store.append('injection', [rec]); return rec; }
}
