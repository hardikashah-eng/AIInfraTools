import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../src/memstore.mjs';
import * as F from '../src/adapters/fabric.mjs';
import * as S from '../src/adapters/storage.mjs';
import { sniff } from '../src/bundle.mjs';
import { diagnose } from '../src/rca.mjs';
import { generate, run } from '../src/bench.mjs';

const T = 1.79e9, H = 3600;

test('perfquery, ibqueryerrors, ethtool and Prometheus switch counters → port records', () => {
  const pq = F.perfquery(`# Port counters: Lid 12 port 17 (CapMask: 0x5A00)
PortSelect:......................17
CounterSelect:...................0x0000
SymbolErrorCounter:..............1204
LinkErrorRecoveryCounter:........3
LinkDownedCounter:...............1
PortRcvErrors:...................9
PortXmitDiscards:................0
PortXmitWait:....................5550
# Port extended counters: Lid 12 port 18 (CapMask: 0x5A00)
PortSelect:......................18
PortXmitData:....................1000
PortRcvData:.....................2000
`, { switch: 'leaf-03', t: T });
  assert.equal(pq.length, 2);
  assert.deepEqual([pq[0].switch, pq[0].port, pq[0].symbolErrors, pq[0].linkRecovery, pq[0].linkDowned, pq[0].rcvErrors, pq[0].xmitWait], ['leaf-03', 17, 1204, 3, 1, 9, 5550]);
  assert.equal(pq[1].txBytes, 4000, 'data counters are in 4-byte words');
  const iq = F.ibqueryerrors(`Errors for 0xe41d2d0300a8c0f0 "leaf-03 SwitchX"\n   GUID 0xe41d2d0300a8c0f0 port 17: [SymbolErrorCounter == 12] [LinkDownedCounter == 1]\n`, { t: T });
  assert.deepEqual([iq[0].switch, iq[0].port, iq[0].symbolErrors, iq[0].linkDowned], ['leaf-03', 17, 12, 1]);
  const et = F.ethtool(`NIC statistics:\n     rx_prio3_pause: 120\n     tx_prio3_pause: 30\n     rx_discards_phy: 7\n     np_cnp_sent: 44\n     link_down_events_phy: 2\n     rx_bytes_phy: 100\n`, { node: 'gpu-a01', iface: 'ens1f0', t: T })[0];
  assert.deepEqual([et.switch, et.port, et.pfcPause, et.xmitDiscards, et.cnpSent, et.linkDowned], ['gpu-a01', 'ens1f0', 150, 7, 44, 2]);
  const pr = F.fabricProm({ data: { result: [{ metric: { __name__: 'PortXmitWaitExtended', node_desc: 'leaf-03', port_num: '33' }, values: [[T, '10'], [T + 60, '50']] }, { metric: { __name__: 'ifInErrors', sysName: 'leaf-04', ifName: 'Ethernet8' }, values: [[T, '3']] }] } });
  assert.equal(pr.length, 3); assert.equal(pr.find(r => r.t === T + 60).xmitWait, 50); assert.equal(pr.find(r => r.switch === 'leaf-04').rcvErrors, 3);
  // growth over a window, through a counter reset
  const g = F.growth([{ t: T, xmitWait: 100 }, { t: T + 60, xmitWait: 400 }, { t: T + 120, xmitWait: 50 }, { t: T + 180, xmitWait: 150 }], T, T + 180);
  assert.equal(g.xmitWait, 300 + 50 + 100); assert.equal(g.seconds, 180);
  assert.equal(sniff('x.txt', '# Port counters: Lid 12 port 17'), 'perfquery'); assert.equal(sniff('x.txt', 'Errors for 0xabc "leaf"'), 'ibqueryerrors');
});

test('Lustre job_stats and NFS mountstats → per-target latency over the interval', () => {
  const js = n => `obdfilter.lustre-OST0003.job_stats=
job_stats:
- job_id:          train-llm.1234
  snapshot_time:   ${T + n * 300}
  read_bytes:      { samples: ${1000 * (n + 1)}, unit: bytes, min: 4096, max: 1048576, sum: ${5e8 * (n + 1)} }
  write_bytes:     { samples: 0, unit: bytes, min: 0, max: 0, sum: 0 }
  read:            { samples: ${1000 * (n + 1)}, unit: usecs, min: 100, max: 90000, sum: ${(n ? 2000 + 12000 : 2000) * 1000 * (n ? 1 : 1)} }
`;
  const r = S.lustreJobstats(js(1), { before: js(0) }).find(x => x.op === 'read');
  assert.equal(r.target, 'lustre:OST0003'); assert.equal(r.job, 'train-llm'); assert.equal(r.ops, 1000); assert.equal(r.bytes, 5e8); assert.equal(r.windowS, 300);
  assert.equal(r.latMs, 12, '12,000 ms of reads over 1,000 reads in the interval');
  const ms = (rd, rtt) => `device filer1:/ckpt mounted on /ckpt with fstype nfs4 statvers=1.1\n\tper-op statistics\n\t        READ: ${rd} ${rd} 0 100 ${rd * 4096} 10 ${rtt} ${rtt + 50} 0\n\t       WRITE: 10 10 0 40960 100 5 30 40 0\ndevice tmpfs mounted on /dev/shm with fstype tmpfs\n`;
  const m = S.nfsMountstats(ms(1500, 9000), { node: 'gpu-a01', before: ms(500, 1000), windowS: 60 }).find(x => x.op === 'read');
  assert.deepEqual([m.target, m.ops, m.latMs, m.bytes], ['nfs:filer1:/ckpt', 1000, 8, 1000 * 4096]);
  assert.throws(() => S.nfsMountstats(ms(1, 1)), /--node/);
  assert.equal(sniff('m', 'device filer1:/ckpt mounted on /ckpt with fstype nfs4'), 'mountstats');
});

test('benchmark: the new fabric and storage scenarios are diagnosed with the port or target named', () => {
  const labeled = generate({ perCause: 6, seed: 11, only: ['slow-link: a bad cable', 'fabric-congestion', 'storage-stall'] });
  assert.ok(labeled.length >= 24);
  const r = run(labeled);
  assert.equal(r.top1, 1, JSON.stringify(r.misses.map(m => [m.scenario, m.top])));
  assert.equal(r.componentTop1, 1);
});

test('slow-link: a congested port is told apart from a bad cable; without counters it asks for them', () => {
  const s = new MemStore(), nodes = ['n1', 'n2', 'n3'], steps = [], coll = [];
  s.append('topology', nodes.map((n, i) => ({ t: T - 86400, kind: 'ib', from: n, to: 'switch:leaf-1', port: i + 1 })));
  for (let i = 0; i < 100; i++) { const t = T - 2 * H + i * 90; for (const [k, n] of nodes.entries()) { steps.push({ t, job: 'j', rank: k, node: n, step: i, durS: 1, commS: 0.1, computeS: 0.9 }); coll.push({ t, job: 'j', node: n, op: 'AllReduce', bytes: 1e8, busbw: 380 * (t > T && n === 'n2' ? 0.4 : 1) }); } }
  s.append('step', steps); s.append('collective', coll);
  const inc = { symptom: 'training-slow', job: 'j', from: T, to: T + 1800 };
  const none = diagnose(s, inc).hypotheses.find(h => h.rule === 'slow-link');
  assert.match(none.title, /leaf-1\/2/); assert.ok(none.verify.some(v => /Import switch port counters/.test(v)));
  // the node's NIC sees pause frames climb: congestion, not the cable
  const p = []; for (let t = T - 6 * H; t <= T + 1800; t += 300) p.push({ t, switch: 'n2', port: 'ens1', nic: true, pfcPause: t > T ? 1e4 + (t - T) * 500 : 1e4 + (t - T + 6 * H) * 0.1 });
  s.append('port', p);
  const cong = diagnose(s, inc).hypotheses.find(h => h.rule === 'slow-link');
  assert.match(cong.title, /congestion/); assert.ok(cong.evidence.some(e => /pfcPause rose/.test(e.what)));
});

test('storage-stall: data stalls with no slower target point at the loader, not storage', () => {
  const s = new MemStore(), steps = [], st = [];
  for (let i = 0; i < 100; i++) { const t = T - 2 * H + i * 90, d = t > T ? 0.5 : 0.05; steps.push({ t, job: 'j', rank: 0, node: 'n1', step: i, durS: 1 + d, dataS: d, computeS: 0.9 }); }
  for (let t = T - 6 * H; t <= T + 1800; t += 300) st.push({ t, target: 'lustre:OST0001', op: 'read', job: 'j', ops: 100, latMs: 2 });
  s.append('step', steps); s.append('storage', st);
  const h = diagnose(s, { symptom: 'training-slow', job: 'j', from: T, to: T + 1800 }).hypotheses.find(x => x.rule === 'storage-stall');
  assert.ok(h); assert.match(h.title, /waits on the input pipeline/); assert.ok(h.against.some(a => /did not slow/.test(a.what)));
});
