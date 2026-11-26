#!/usr/bin/env node
// fleetops: the shared data layer for AIInfraTools, with calibration, root-cause analysis and optimization on top.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStore, whereFrom, openStore, SCHEMA } from '../src/store.mjs';
import * as Retention from '../src/retention.mjs';
import { migrate } from '../src/migrate.mjs';
import * as Ingest from '../src/ingest.mjs';
import * as Traces from '../src/traces.mjs';
import * as Inc from '../src/incidents.mjs';
import * as Sec from '../src/security.mjs';
import * as Pull from '../src/pull.mjs';
import { postWebhook, run as runAction } from '../../gpu-health/src/executors.mjs';
import { Store as GhStore } from '../../gpu-health/src/actions.mjs';
import { readLines } from '../src/lines.mjs';
import * as Philly from '../src/adapters/philly.mjs';
import * as Pub from '../src/adapters/public.mjs';
import * as Live from '../src/adapters/live.mjs';
import { toEpoch } from '../src/adapters/time.mjs';
import * as Logs from '../src/adapters/logs.mjs';
import * as Topo from '../src/adapters/topology.mjs';
import * as Procure from '../src/procure.mjs';
import { writeGpuHealth, toFleetScopeTrace, toGpuLedger } from '../src/export.mjs';
import * as Calib from '../src/calibrate.mjs';
import * as RCA from '../src/rca.mjs';
import * as Opt from '../src/optimize.mjs';
import * as Detect from '../src/detect.mjs';
import * as Bench from '../src/bench.mjs';
import * as Agent from '../src/agent.mjs';
import * as Goodput from '../src/goodput.mjs';
import * as Sdc from '../src/sdc.mjs';
import * as Bundle from '../src/bundle.mjs';
import * as Tune from '../src/tune.mjs';
import * as Serving from '../src/serving.mjs';
import * as Fabric from '../src/adapters/fabric.mjs';
import * as Storage from '../src/adapters/storage.mjs';
import * as Power from '../src/power.mjs';
import * as Adm from '../src/admission.mjs';
import * as RO from '../src/rollout.mjs';
import * as Shadow from '../src/shadow.mjs';
import * as Replay from '../src/shadow-replay.mjs';
import { goodputMarkdown, goodputHtml } from '../src/goodput-report.mjs';
import * as LiveView from '../src/live.mjs';
import * as Inject from '../src/inject.mjs';
import { loadConfig as ghConfig } from '../../gpu-health/src/config.mjs';
import { createRequire } from 'node:module';
const FSIN = createRequire(import.meta.url)('../../fleetscope/src/ingest.js');

const HELP = `fleetops — shared data layer for AIInfraTools

  fleetops data import SOURCE FILE... [--store DIR] [options]     load records into the store
  fleetops data import bundle FILE.tar.gz|DIR                     a trace bundle (tools/collect.sh): every file, by its
                                                                 manifest entry or by content
  fleetops send FILE.tar.gz|DIR --to URL [--token T]              upload a bundle to a fleetops server (POST /v1/bundle)
  fleetops procure aws-blocks --gpu H100 --gpus 64 --days 7       the read-only AWS command listing Capacity Blocks on offer
  fleetops procure gcp-calendar --gpu H200 --gpus 64 --days 7 --region us-central1   the read-only GCP calendar-mode advice
  fleetops data summary [--store DIR]                             records per kind, time range and sources
  fleetops data query KIND [--from T] [--to T] [--where k=v]... [--limit N]
  fleetops data node NODE [--from T] [--to T]                    versions, shared switch/rack/PDU, log faults, changes
  fleetops data requests [--from T] [--to T]                     per-request records (stages, replica) from stored spans
  fleetops data rollup [--steps 60,3600]                         minute and hour device rollups (rollup-60/, rollup-3600/)
  fleetops data compact [--raw-days 7] [--apply]                 drop old raw device/request/span days after rolling up,
                                                                 keeping incident windows at full resolution (keep/)
  fleetops data migrate [--apply]                                bring the store to the current schema version
  fleetops serve [--port 9400] [--host 127.0.0.1] [--tokens FILE] [--on-prem [HOSTS]] [--site S] [--max-queue 200000]
        ingest (remote_write, OTLP over HTTP: protobuf or JSON) and serve the read API (/api/…); tokens scope reads to a tenant; every API read
        is audited in <store>/audit/api.jsonl; request content is redacted at ingest; --on-prem refuses outbound calls
        to hosts not listed (also FLEETOPS_EGRESS_ALLOW)
  fleetops token create --tokens FILE --name N [--roles read,ingest,admin] [--namespaces a,b] [--pools p] [--clusters c] [--infra]
  fleetops token list --tokens FILE
  fleetops data export gpu-health --out DIR [--from T] [--to T]   samples.jsonl, jobs.json, results.jsonl for gpu-health
  fleetops data export fleetscope-trace --out FILE [--pool P]     CSV for FleetScope's Trace replay node
  fleetops data export gpu-ledger --out usage.jsonl [--capacity cap.json] [--cluster C]   usage records for gpu-ledger (billing, waste)
  fleetops demo --training [--days 7] [--tuned-at D]              training jobs with planted badput (for goodput and tune);
                                                                 --tuned-at applies two recommendations on day D
  fleetops demo [--scenario NAME] [--seed N] [--list] [--now]      a store with one planted cause (a benchmark scenario) to
                                                                 try detect, diagnose and incidents without a fleet;
                                                                 --now moves it so the incident ends now (for the agent)

Sources (SOURCE):
  exporter         DCGM / AMD / SambaNova exporter text      [--vendor V] [--t EPOCH] [--site S]
  vllm             vLLM /metrics snapshot                   --pool P [--before FILE | --window S] [--model M] [--gpu G] [--t EPOCH]
  prom-range       Prometheus query_range JSON              --field ttftP99|tpotP99|rate|kvUsage|… [--pool P]
  k8s-nodes        kubectl get nodes -o json                 inventory with versions; rack and zone edges
  k8s-pods         kubectl get pods -A -o json
  slurm-nodes      scontrol show node -o                     (kernel version from OS=)
  nvidia-smi-q     nvidia-smi -q                             [--node N] (default: file name)  versions, serials, PCI → GPU map
  nvidia-topo      nvidia-smi topo -m                        [--node N]  NVLink and NIC affinity
  amd-smi-static   amd-smi static --json                     [--node N] [--rocm V]  versions, IFWI, PCI → GPU map
  amd-smi-topology amd-smi topology --json                   [--node N]  XGMI and PCIe peer links
  cloud-monitoring Google Cloud Monitoring timeSeries JSON    [--site S]  GKE node / TPU VM accelerator metrics → device samples
  ibnetdiscover    ibnetdiscover                             host → leaf → spine (with switch port numbers)
  perfquery        perfquery [-x] LID PORT output             [--switch NAME]  switch port counters (errors, xmit wait, data)
  ibqueryerrors    ibqueryerrors                              switch ports with error counters, fabric-wide
  ethtool          ethtool -S IFACE                           --node N --iface I  RoCE NIC counters: pause frames, discards, link errors
  ib-sysfs         grep -H . /sys/class/infiniband/*/ports/*/{counters,hw_counters}/*   --node N  host IB/RoCE port counters, CNPs, ECN marks
  fabric-prom      Prometheus query_range of switch counters  [--map metric=field,…]  UFM telemetry, SONiC, SNMP (ifInErrors, …)
  ports            JSON lines {t, switch, port, symbolErrors?, xmitWait?, pfcPause?, …}
  lustre-jobstats  lctl get_param obdfilter.*.job_stats (on an OSS) [--before FILE] [--fs NAME] [--target OST0003]  per-OST I/O per job
  mountstats       /proc/self/mountstats                      --node N [--before FILE --window S]  NFS latency per export
  storage          JSON lines {t, target, op, node?, job?, ops?, bytes?, latMs?}   anything else (S3 clients, loaders)
  racks            CSV: node,rack,row,pdu,site
  kernel-log       journalctl -k -o short-iso | dmesg -T | dmesg | syslog   [--node N] [--boot T] [--year Y] [--utc-offset H]
                   XID, NVLink, PCIe AER, AMD RAS, MCE, IB link, NFS/Lustre, OOM (GPU index from nvidia-smi-q / amd-smi-static imports)
  app-log          NCCL / PyTorch job output                 [--node N] [--job J] [--t T]
  k8s-events       kubectl get events -A -o json             cordon/reboot/scale changes; NotReady/OOM/mount/evict logs
  helm-history     helm history REL -n NS -o json            [--release R] [--namespace NS]
  otlp-traces      OTLP/JSON traces (resourceSpans)          [--derive] (also write per-request records)
  kineto           PyTorch profiler trace JSON (one rank)    [--job J] [--node N] [--rank R] [--t0 T]   per-rank steps
  nccl-inspector   NCCL Inspector profiler-plugin JSON       [--job J] (default: from the nccl-inspector-<jobid> directory)
  step-log         JSON lines {t, rank, node, step, durS, commS?, dataS?, ckptS?, mfu?, loss?, gradNorm?, n?}   [--job J]
  requests         gateway or proxy request logs (LiteLLM, OpenAI-style usage, OTLP gen_ai spans, CSV with t, isl,
                   osl, ttft?, e2e?): token counts and latencies, never prompts   [--pool P] [--start T]
  auto             recognize each file by its content (exporter scrapes, vLLM metrics, nvidia-smi, kubectl JSON,
                   sacct, kernel and NCCL logs, step logs, Kineto, OTLP, NCCL Inspector, request logs, …)
  admission        tools/admit-node.sh output: versions, topology, DCGM diag, NCCL bandwidth, burn-in and SDC canary of a node
  sdc-checks       JSON lines of silent-data-corruption checks: tools/sdc-canary.py output, or your trainer's
                   {t, check: param-checksum|replay|nan, node, gpu, job, step, rank, group, value, ok}
  sacct            sacct -P -X --format=JobID,JobName,State,ExitCode,Start,End,NodeList,AllocTRES
  changes          JSON lines of change events
  git-log          git log --date=unix --pretty=format:'@@%H|%ad|%an|%s' --name-only   [--repo NAME]
  gpu-health       a gpu-health state directory (events.jsonl, results.jsonl)
  philly-machines  Philly cluster_machine_list
  philly-gpu       Philly cluster_gpu_util                  [--from T] [--to T] [--step MIN] [--machines N|m1,m2]
  philly-jobs      Philly cluster_job_log                   [--from T] [--to T]
  azure-llm        Azure LLM inference trace CSV            [--pool P] [--limit N]
  mlperf           MLPerf mlperf_log_summary.txt files      [--isl N] (the path names the system, model and scenario)
  acme             AcmeTrace job trace CSV                  [--cluster NAME]

Calibration (fits are stored as calibration records; profiles are JSON files the tools read):
  fleetops calibrate benchmarks [--isl N] [--no-fleetscope] [--profile OUT]
        fit the Inference Sizer (and FleetScope) to benchmark records; runs named *interactive* are held out and checked
  fleetops calibrate serving --graph G [--from T] [--to T] [--holdout 0.25] [--profile OUT] [--graph-out G2] [--every SECONDS]
        fit each FleetScope pool of a graph to its serving records; --every re-fits on a schedule
  fleetops calibrate drift --graph G --profile P [--from T] [--to T] [--fail-on-drift]
        simulate the latest window with the stored multipliers; outside the 10%/20% bar → a drift record
  fleetops calibrate apply --graph G --profile P --out G2      write the multipliers into a FleetScope graph

Root-cause analysis (diagnoses are stored as incident records):
  fleetops rca detect [--from T] [--to T] [--min-failures 20] [--targets targets.json] [--diagnose] [--format md]
        find job-failure and latency incidents (seasonal baseline + CUSUM, grouped); --diagnose ranks causes for each
  fleetops rca diagnose --symptom job-failures|latency|device --from T --to T [--pool P] [--nodes n1,n2] [--format md]
  fleetops rca eval --labels FILE      top-1 / top-3 accuracy on labeled incidents (JSON lines: { incident, cause })
  fleetops rca bench [--per-cause 10] [--seed 1] [--only PREFIX] [--injections] [--labels FILE] [--weights W] [--fit OUT]
        [--min-top1 0.8] [--min-top3 0.95]
        accuracy per cause on synthetic scenarios (default), injected faults and/or postmortem labels; --fit writes rule
        weights fitted on the labels (held-out accuracy reported); exit 5 below the bar
  detect/diagnose/bench take --weights W. detect: --method cusum (default) | threshold, --bin S, --group-gap S, --where k=v

Incidents (lifecycle as incident_event records; paging is a dry run unless --live):
  fleetops incidents open [--from T] [--to T]        detect, diagnose, open the new ones (severity from the symptom's size)
  fleetops incidents list [--status open|acknowledged|mitigated|resolved]
  fleetops incidents ack|mitigate|resolve|reopen|assign|severity|note ID --by NAME [--note TEXT] [--owner O]
        [--severity sev1..sev4] [--cause RULE --component X]   (resolve --cause stores the confirmed cause as a label)
  fleetops incidents show ID | timeline ID [--out FILE.html] | postmortem ID [--out FILE.md]
  fleetops incidents page ID --to pagerduty|opsgenie|webhook --action trigger|ack|resolve [--key K] [--url U] [--live]
  rca bench --from-incidents    score root-cause analysis on resolved incidents' confirmed causes

Real labels from a real fleet:
  fleetops pull --from T [--to T] --prom URL [--loki URL] [--loki-query Q]… [--step 60] [--header 'Authorization: Bearer X']
        a window of DCGM/AMD/vLLM/NCCL-Inspector series and kernel/NCCL logs from the fleet's own monitoring
  fleetops backtest --labels postmortems.jsonl --prom URL [--loki URL] [--lookback 26h] [--weights W]
        pull each confirmed incident's window and score root-cause analysis on it (misses name the incident)
  fleetops gameday PLAN.json --allow FILE [--live] [--cooldown 900] [--prom URL --loki URL]
        run injections one after another on a TEST cluster (dry run unless --live), then score detection and diagnosis

Goodput (where training GPU-hours went; checkpoint interval advice):
  fleetops goodput [--from T] [--to T | --days 7] [--job J] [--targets targets.json] [--format md|html] [--out FILE]
        allocated GPU-hours per job, team and day split into productive, slow steps, data stalls, checkpoint saves,
        lost work, restarts, startup and idle; the fleet's interruption rate; the best checkpoint interval per job

Tuning (what to change, the expected effect, and afterwards whether it worked):
  fleetops tune [--from T] [--to T | --days 7] [--targets targets.json] [--pools pools.json] [--format md|json] [--out F]
        ranked changes for training (checkpoint interval, input pipeline, slow nodes, restarts, communication),
        inference (KV cache, pool size and autoscaling with the Inference Sizer) and the fleet (flaky nodes, idle GPUs),
        each with its evidence, knobs, expected effect and its basis (measured, model, upper bound)
        pools.json: { "chat": { "model": "llama33-70b", "gpu": "H100", "gpus": 32 } }  (fleetops tune models lists ids)
  fleetops tune apply ID --by NAME [--at T] [--note TEXT]     record that a recommendation was applied
  fleetops tune verify [ID] [--before 7d] [--after 7d]         the metric before and after, a 95% interval, a verdict
  fleetops tune list                                           applied recommendations and their verdicts
  fleetops tune holdout --from T --split T --to T              recommend on [from, split), check on [split, to) that
                                                               the problem each names is still there (before changing anything)

Power (budgets per rack, PDU and site; which jobs a cap slows; caps planned and applied through approval):
  fleetops power report --budgets b.json [--from T --to T]     IT kW (p99, peak) per rack/PDU/row/site vs budget, headroom in nodes
  fleetops power jobs                                           each job's draw, how compute-bound it is, time at the limit, steps per kWh
  fleetops power predict --cap 70% | --cap 500W [--job J]       predicted slowdown and kW saved per job under a cap
  fleetops power fit                                            measure how clocks follow the power limit on your GPUs (α)
  fleetops power plan --budgets b.json [--save-kw N] [--max-slowdown 0.05] [--protect training] --out plan.json
        the caps that bring each group under budget at the least slowdown, queued for approval; then
        fleetops optimize advance --plan plan.json (applies, bakes, rolls back on a guard breach)
  fleetops power verify --plan plan.json                        measured kW saved and step slowdown against the prediction
  fleetops power demo                                           two racks, one over budget

Node admission and safe rollouts (a bad node or version stopped before it reaches a production job):
  tools/admit-node.sh [--burn-in 6h] --out admit.jsonl          on the node: versions, topology, DCGM diag, NCCL, SDC canary
  fleetops data import admission admit.jsonl
  fleetops admit pending                                         new nodes, nodes back from quarantine or repair
  fleetops admit check NODE [--policy p.json] [--record]         pass / fail / missing per check → admit, reject or incomplete
  fleetops admit apply NODE [--live]                             admit-node (needs approval) or reject-node (automatic), dry run unless --live
  fleetops rollout plan --field driver --version V [--canary 2] [--waves 25%,100%] [--bake 6h] [--nodes REGEX] [--sku S]
        [--apply "ansible-playbook driver.yml -l {node} -e v={version}"] [--rollback "…"] --out rollout.json
        canary across racks, then waves, each queued for approval
  fleetops rollout advance --plan rollout.json [--live]           after each bake: new version vs old on failures, hard faults,
        NCCL bandwidth, step compute in the same jobs, TTFT; a regression rolls the wave back and halts
  fleetops rollout check --field driver --version V [--from T --to T]    the same comparison, ad hoc
  fleetops rollout status --plan rollout.json  ·  fleetops rollout demo [--good]

Shadow upgrades (an infra change measured against the baseline at matched load before it ships; docs/SHADOW.md):
  fleetops shadow plan --baseline-config b.json --candidate-config c.json [--trace FILE | --baseline SEL --from T --to T]
        [--effect 0.03] [--rps R] --out plan.json          predicted effect (Inference Sizer) and requests needed to see it
  fleetops shadow replay --trace FILE|profile.json --baseline URL --candidate URL [--model M] [--speed 1] [--max-requests N]
        [--duration S] [--max-inflight 64] [--api-key-env VAR] [--out results.jsonl] [--live]
        the same requests to both endpoints at the same moments (dry run unless --live); results go to the store
  fleetops shadow answers --baseline URL --candidate URL [--prompts FILE] [--model M] [--live] --out answers.json
        greedy decoding on both: identical tokens, first divergence, log-probability drift
  fleetops shadow compare --results FILE | --baseline SEL --candidate SEL [--from T --to T]
        [--plan plan.json] [--answers answers.json] [--baseline-gpus N --baseline-rate R --candidate-gpus N --candidate-rate R]
        [--baseline-nodes RE --candidate-nodes RE] [--gates gates.json]     matched-load verdict: promote, roll back, extend
  fleetops shadow baseline save --name NAME --select SEL [--from T --to T]  ·  fleetops shadow baseline list
  fleetops shadow watch --name NAME --select SEL [--from T --to T]          drift of a service against its saved baseline
  fleetops shadow demo                                         a candidate that looks faster and isn't
  SEL: field=value or field~regex, comma-separated (variant=candidate, replica~vllm-new, pool=chat)

Serving (Inference Sizer both ways, and a one-command vLLM deployment on Kubernetes):
  fleetops serving models | gpus                               the catalog (ids, sizes, Hugging Face repos; GPU types)
  fleetops serving fit --gpu H100 --nodes 2 [--rate R] [--isl 2000 --osl 400] [--ttft 2 --tpot 0.05] [--rank largest|throughput]
        which models fit on that hardware, and how much load each carries within the targets
  fleetops serving capacity --model M --gpu G --nodes N | --gpus N [workload, targets]
        the most a model carries on given hardware: req/s (production and edge), concurrency, longest prompt, layout
  fleetops serving deploy --model M --gpu G (--nodes N | --gpus N | --rate R) [--name N] [--namespace serving]
        [--hf-secret SECRET] [--cache-pvc PVC] [--image IMG] [--autoscale [--prometheus URL]] [--create-namespace]
        [--from-pool P] [--out FILE] [--apply [--endpoint URL] [--wait 2400]] [--mode agg|disagg|auto]
        --mode disagg (or auto, when the sizer finds it smaller): prefill and decode pools on llm-d (DisaggregatedSet,
        NIXL KV transfer, the llm-d router chart); needs LeaderWorkerSet ≥ 0.11.1 and the InferencePool CRDs
        plan → Deployment or LeaderWorkerSet + Service (+ KEDA) → preflight; with --apply: apply, wait, smoke test, and
        register the pool for tune and the agent (<store>/serving/pools.json, targets.json). Without --apply: a dry run.
  fleetops serving delete NAME [--namespace serving] [--apply]

Silent data corruption (GPUs that compute wrong answers without an error):
  fleetops sdc [--from T] [--to T | --days 7] [--format md]
        replicas that disagree, failed canaries and replays, the first rank to go non-finite, gradient outliers →
        suspect GPUs, and for each job the checkpoint to resume from; run tools/sdc-canary.py on nodes to confirm

Live agent and dashboard (actions are dry runs unless --live AND the gpu-health policy has dryRun: false):
  fleetops agent [--interval 30] [--window 3600] [--state DIR] [--config gpu-health.json] [--agent-config agent.json]
        [--targets targets.json] [--prom URL [--loki URL]] [--page-to pagerduty|opsgenie|webhook --page-key K --page-url U]
        [--live] [--once]
        watch training and inference, diagnose what goes wrong, mitigate within the policy, verify, page when it can't
  fleetops agent status | log [--limit 50] | pause --by NAME | resume --by NAME | approve ID --by NAME | reject ID --by NAME
  fleetops serve --agent [agent options]   ingest, run the agent in-process, and serve the dashboard at /live
        (state defaults to <store>/agent; approving from the page needs a token with the approve role)

Fault injection on a TEST cluster (dry-run unless --live; every target must be in the --allow file):
  fleetops inject list
  fleetops inject FAULT --allow FILE [--for S] [--live] [--expect RULE] --param value …   writes an injection label

Optimization with safe execution (rollback is automatic; applying a stage always needs approval):
  fleetops optimize candidates [--from T] [--to T] [--price 4] [--max-attempts 2] [--graph G [--trace-pool P [--trace-from T --trace-to T]] [--target 0.99]] [--out cands.json]
        candidate changes from gpu-health (right-size, scale-in, reclaim), rca (retry storms) and FleetScope (pool sizes)
  fleetops optimize plan --candidates cands.json --out plan.json [--save-pct 20] [--baseline-weekly $] [--max-risk medium]
        [--guards guards.json] [--deployments deploy.json] [--bake 1800] [--state DIR]
        pick a set that meets the goal, stage it, and queue every stage for approval in gpu-health's queue
  fleetops optimize advance --plan plan.json [--state DIR] [--config gpu-health.json] [--live]
        check the last stage's SLO guard (regression → roll back, no approval needed), then run the next approved stage
  fleetops optimize verify --plan plan.json [--days 7]     before/after GPU-hours and guard breaches → an optimization record
  Approve a stage with: gpu-health actions approve ID --by NAME --state DIR   (DIR defaults to <store>/rollouts/state)

Times (T) are ISO dates or epoch seconds. Common: --store DIR (default ./fleet-data), --backend jsonl|parquet (new stores;
parquet needs \`npm install --no-save @duckdb/node-api@2.0.1-r.1\` in fleetops/), --json.`;

function args(argv) {
  const o = { _: [], where: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), nx = argv[i + 1], v = nx === undefined || nx.startsWith('--') ? true : (i++, nx); if (k === 'where') o.where.push(v); else o[k] = v; }
    else o._.push(a);
  }
  return o;
}
let J = false; const OUT = {};
const say = (...a) => { if (!J) console.log(...a); };
const read = f => fs.readFileSync(f, 'utf8');
const time = v => (v == null || v === true ? undefined : toEpoch(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v));
const fmt = t => (Number.isFinite(t) ? new Date(t * 1000).toISOString().replace('.000', '') : '–');

// PCI address → GPU index per node, from the latest nvidia-smi -q or amd-smi static inventory in the store (for kernel logs).
function pciMap(store) {
  const m = {};
  for (const r of store.scan('inventory', { where: r => Array.isArray(r.gpus) })) { m[r.node] = m[r.node] || {}; for (const g of r.gpus) if (g.pci) m[r.node][g.pci] = g.gpu; }
  return m;
}
function importSource(store, src, files, o) {
  const from = time(o.from), to = time(o.to), res = [];
  const put = (kind, recs) => { const r = store.append(kind, recs, { dedupe: true }); res.push(r); return r; };
  const tOf = f => (o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000));
  const nodeOf = f => (o.node && o.node !== true ? o.node : path.basename(f).replace(/\.(txt|log|out)$/, ''));
  // inventory with versions: a version that differs from the node's previous snapshot becomes a change record
  let lastByNode = null;
  const putInventory = recs => {
    if (!lastByNode) { lastByNode = new Map(); for (const r of store.scan('inventory', { where: r => r.versions })) { const p = lastByNode.get(r.node); if (!p || p.t < r.t) lastByNode.set(r.node, r); } }
    const changes = [];
    for (const r of recs.slice().sort((a, b) => a.t - b.t)) { if (r.versions) { changes.push(...Topo.versionChanges(lastByNode.get(r.node), r)); const p = lastByNode.get(r.node); if (!p || p.t < r.t) lastByNode.set(r.node, r); } }
    put('inventory', recs);
    if (changes.length) put('change', changes);
  };
  const each = f => (fs.statSync(f).isDirectory() ? [f] : [f]);
  for (const f of files.flatMap(each)) {
    switch (src) {
      case 'exporter': put('device', Live.exporterScrape(read(f), { vendor: o.vendor !== true ? o.vendor : undefined, t: o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000), site: o.site })); break;
      case 'vllm': put('serving', [Live.vllmSnapshot(read(f), { before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: o.t ? time(o.t) : Math.floor(fs.statSync(f).mtimeMs / 1000), pool: o.pool || 'default', model: o.model, gpu: o.gpu })]); break;
      case 'prom-range': if (!o.field) throw new Error('prom-range needs --field'); put('serving', Live.promRange(read(f), { field: o.field, pool: o.pool })); break;
      case 'k8s-nodes': putInventory(Live.k8sNodes(read(f), { t: tOf(f) })); put('topology', Live.k8sNodeTopology(read(f), { t: tOf(f) })); put('log', Live.k8sNodeConditions(read(f), { t: tOf(f) })); break;
      case 'k8s-pods': put('placement', Live.k8sPods(read(f))); break;
      case 'slurm-nodes': putInventory(Live.slurmNodes(read(f), { t: tOf(f) })); break;
      case 'nvidia-smi-q': putInventory([Topo.nvidiaSmiQ(read(f), { node: nodeOf(f), t: tOf(f) }).inventory]); break;
      case 'nvidia-topo': put('topology', Topo.nvidiaTopo(read(f), { node: nodeOf(f), t: tOf(f) })); break;
      case 'amd-smi-static': putInventory([Topo.amdSmiStatic(read(f), { node: nodeOf(f), t: tOf(f), rocm: o.rocm }).inventory]); break;
      case 'amd-smi-topology': put('topology', Topo.amdSmiTopology(read(f), { node: nodeOf(f), t: tOf(f) })); break;
      case 'cloud-monitoring': put('device', Live.cloudMonitoring(read(f), { site: o.site })); break;
      case 'ibnetdiscover': put('topology', Topo.ibnetdiscover(read(f), { t: tOf(f) })); break;
      case 'perfquery': put('port', Fabric.perfquery(read(f), { switch: o.switch, t: tOf(f) })); break;
      case 'ibqueryerrors': put('port', Fabric.ibqueryerrors(read(f), { t: tOf(f) })); break;
      case 'ib-sysfs': put('port', Fabric.ibSysfs(read(f), { node: o.node || nodeOf(f), t: tOf(f) })); break;
      case 'ethtool': put('port', Fabric.ethtool(read(f), { node: o.node || nodeOf(f), iface: o.iface || 'eth0', t: tOf(f) })); break;
      case 'fabric-prom': put('port', Fabric.fabricProm(JSON.parse(read(f)), { map: o.map ? Object.fromEntries(String(o.map).split(',').map(x => x.split('='))) : {} })); break;
      case 'ports': put('port', read(f).split(/\r?\n/).filter(l => l.trim()).map(l => Object.assign({ source: 'ports' }, JSON.parse(l)))); break;
      case 'lustre-jobstats': put('storage', Storage.lustreJobstats(read(f), { before: o.before ? read(o.before) : undefined, fs: o.fs || 'lustre', target: o.target || Storage.lustreTargetOf(f), t: tOf(f) })); break;
      case 'mountstats': put('storage', Storage.nfsMountstats(read(f), { node: o.node || nodeOf(f), before: o.before ? read(o.before) : undefined, windowS: o.window ? +o.window : undefined, t: tOf(f) })); break;
      case 'storage': put('storage', Storage.storageLines(read(f))); break;
      case 'racks': put('topology', Topo.racks(read(f), { t: tOf(f) })); break;
      case 'kernel-log': put('log', Logs.kernelLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, boot: time(o.boot), year: o.year ? +o.year : undefined, utcOffset: o['utc-offset'] ? +o['utc-offset'] : 0, pciMap: pciMap(store) })); break;
      case 'app-log': put('log', Logs.ncclLog(read(f), { node: o.node && o.node !== true ? o.node : undefined, job: o.job && o.job !== true ? o.job : undefined, t: o.t ? time(o.t) : tOf(f) })); break;
      case 'k8s-events': { const e = Live.k8sEvents(read(f)); put('change', e.changes); put('log', e.logs); break; }
      case 'kineto': put('step', Traces.kineto(read(f), { job: o.job && o.job !== true ? o.job : path.basename(f).split(/[._]/)[0], node: o.node && o.node !== true ? o.node : undefined, rank: o.rank != null && o.rank !== true ? +o.rank : undefined, t0: o.t0 ? time(o.t0) : undefined })); break;
      case 'nccl-inspector': put('collective', Traces.ncclInspector(read(f), { job: o.job && o.job !== true ? o.job : (path.basename(path.dirname(path.resolve(f))).match(/nccl-inspector-(\S+)/) || [])[1], node: o.node && o.node !== true ? o.node : undefined })); break;
      case 'step-log': put('step', Traces.stepLog(read(f), { job: o.job && o.job !== true ? o.job : undefined })); break;
      case 'admission': {
        // tools/admit-node.sh output: { record: inventory|check|topology|sdc_check, … }
        const by = {};
        for (const l of read(f).split(/\r?\n/).filter(x => x.trim())) { const { record, ...r } = JSON.parse(l); if (!['inventory', 'check', 'topology', 'sdc_check'].includes(record)) throw new Error(`admission file: unexpected record ${record}`); (by[record] = by[record] || []).push(Object.assign({ source: 'admit-node' }, r, r.gpu != null ? { gpu: String(r.gpu) } : {})); }
        for (const [k, rs] of Object.entries(by)) put(k, rs);
        break;
      }
      case 'sdc-checks': put('sdc_check', read(f).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(c => Object.assign({ source: 'sdc-canary' }, c, { gpu: c.gpu != null ? String(c.gpu) : undefined }))); break;
      case 'otlp-traces': { const spans = Ingest.otlpTracesToSpans(JSON.parse(read(f))); put('span', spans); if (o.derive) put('request', Traces.requestsFromSpans(spans)); break; }
      case 'helm-history': put('change', Live.helmHistory(read(f), { release: o.release && o.release !== true ? o.release : path.basename(f, '.json'), namespace: o.namespace && o.namespace !== true ? o.namespace : 'default' })); break;
      case 'sacct': put('job', Live.slurmSacct(read(f))); break;
      case 'changes': put('change', Live.changesJsonl(read(f))); break;
      case 'git-log': put('change', Live.gitLog(read(f), { repo: o.repo || path.basename(f) })); break;
      case 'gpu-health': {
        const ev = path.join(f, 'events.jsonl'), rs = path.join(f, 'results.jsonl');
        if (fs.existsSync(ev)) put('health', Live.gpuHealthEvents(read(ev)));
        if (fs.existsSync(rs)) put('job', Live.gpuHealthResults(read(rs)));
        break;
      }
      case 'philly-machines': put('inventory', Philly.machines(read(f), { t: from ?? 0 })); break;
      case 'philly-gpu': {
        let keep = null;
        if (o.machines && o.machines !== true) keep = /^\d+$/.test(o.machines) ? null : new Set(String(o.machines).split(','));
        const limit = /^\d+$/.test(String(o.machines || '')) ? +o.machines : 0;
        const inv = store.query('inventory', { where: r => r.source === 'philly' }), skus = Object.fromEntries(inv.map(r => [r.node, r.sku]));
        // the first N machines (by number) with 8 GPUs: a fixed, repeatable subset of the cluster
        if (limit) keep = new Set(inv.filter(r => r.devices === 8).map(r => r.node).sort((a, b) => +a.slice(1) - +b.slice(1)).slice(0, limit));
        let batch = [], n = 0;
        for (const s of Philly.gpuUtil(readLines(f), { from, to, stepMin: +(o.step || 10), machines: keep, skus })) { batch.push(s); if (batch.length >= 50000) { n += put('device', batch).written; batch = []; } }
        if (batch.length) put('device', batch);
        break;
      }
      case 'philly-jobs': { const x = Philly.jobLog(JSON.parse(read(f)), { from, to }); put('placement', x.placements); put('job', x.outcomes); break; }
      case 'azure-llm': put('request', Pub.azureLlm(read(f), { pool: o.pool || path.basename(f, '.csv'), limit: o.limit ? +o.limit : Infinity })); break;
      case 'mlperf': put('benchmark', [Pub.mlperfSummary(read(f), { path: o.path || f, t: o.t ? time(o.t) : 0, meta: { islMean: o.isl ? +o.isl : undefined } })]); break;
      case 'acme': put('job', Pub.acme(read(f), { cluster: o.cluster || 'acme', limit: o.limit ? +o.limit : Infinity })); break;
      // gateway or proxy request logs (LiteLLM, OpenAI-style usage, OTLP gen_ai spans, CSV), through FleetScope's parser;
      // token counts and latencies only, never prompts or completions
      case 'requests': {
        const parsed = FSIN.parseTrace(read(f), { maxRows: 5000000, maxSeconds: Number.MAX_SAFE_INTEGER });
        const pool = o.pool && o.pool !== true ? o.pool : path.basename(f).replace(/\.(jsonl?|csv|txt)$/, '');
        const t0 = time(o.start) ?? tOf(f) - Math.max(0, ...parsed.trace.map(r => +r.t || 0));
        put('request', parsed.trace.filter(r => +r.isl > 0 && +r.osl > 0).map(r => ({ t: r.abs != null ? r.abs : t0 + +r.t, pool, isl: +r.isl, osl: +r.osl, cached: r.cached != null ? +r.cached : undefined, ttft: r.ttft != null ? +r.ttft : undefined, e2e: r.e2e != null ? +r.e2e : undefined, source: 'requests' })));
        break;
      }
      case 'auto': {
        const s = Bundle.sniffFile(f, f);
        if (!s) { res.push({ kind: 'unrecognized', written: 0, skipped: 0, invalid: 0, errors: [`${f}: not recognized; name its source (fleetops data import SOURCE FILE)`] }); break; }
        const by = importSource(store, s, [f], o);
        for (const [kind, b] of Object.entries(by)) res.push(Object.assign({ kind }, b));
        break;
      }
      default: throw new Error(`unknown source "${src}"\n\n${HELP}`);
    }
  }
  // merge per kind
  const by = {};
  for (const r of res) { const b = by[r.kind] || (by[r.kind] = { written: 0, skipped: 0, invalid: 0, errors: [] }); b.written += r.written; b.skipped += r.skipped; b.invalid += r.invalid; b.errors.push(...r.errors); }
  return by;
}

// A bundle (tar, tar.gz or a directory): manifest entries, then anything recognized by content. One bad file doesn't
// stop the rest; each file's result is reported.
async function importBundle(store, target, o = {}) {
  if (!target) throw new Error('fleetops data import bundle FILE.tar.gz|DIR');
  let dir = target, tmp = null;
  if (!fs.statSync(target).isDirectory()) { const u = Bundle.unpack(fs.readFileSync(target)); dir = tmp = u.dir; }
  try {
    const p = Bundle.plan(dir), files = [], totals = {};
    // files another entry reads (a vLLM scrape's earlier snapshot) are not imported on their own
    const used = new Set(p.entries.map(e => e.opts && e.opts.before).filter(Boolean).map(Bundle.safeName));
    for (const e of p.entries) {
      if (used.has(e.path)) continue;
      if (e.opts && e.opts.before) e.opts = Object.assign({}, e.opts, { before: path.join(dir, Bundle.safeName(e.opts.before)) });
      if (e.missing) { files.push({ path: e.path, source: e.source, error: 'listed in the manifest but not in the bundle' }); continue; }
      if (!e.source) { files.push({ path: e.path, source: null, skipped: 'not recognized' }); continue; }
      try {
        const opts = Object.assign({}, e.opts);
        if (['kernel-log', 'nvidia-smi-q', 'nvidia-topo', 'amd-smi-static', 'amd-smi-topology', 'app-log'].includes(e.source) && !opts.node && p.manifest && p.manifest.host) opts.node = p.manifest.host;
        if (opts.t != null) opts.t = String(opts.t);
        const by = importSource(store, e.source, [e.abs], opts);
        for (const [k, b] of Object.entries(by)) totals[k] = (totals[k] || 0) + b.written;
        files.push({ path: e.path, source: e.source, from: e.from, imported: by });
      } catch (err) { files.push({ path: e.path, source: e.source, error: err.message.split('\n')[0] }); }
    }
    if (store.flush) store.flush();
    return { manifest: p.manifest, files, totals };
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

// fleetops send: a bundle (or a directory, tarred here) to a fleetops server's POST /v1/bundle.
async function sendCmd(o) {
  const target = o._[1], url = o.to && o.to !== true ? o.to : null, token = o.token && o.token !== true ? o.token : process.env.FLEETOPS_TOKEN;
  if (!target || !url) throw new Error('fleetops send BUNDLE|DIR --to http://fleetops:9400 [--token T | FLEETOPS_TOKEN]');
  let body;
  if (fs.statSync(target).isDirectory()) {
    const walk = (d, b = '') => fs.readdirSync(path.join(d, b), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d, b ? `${b}/${e.name}` : e.name) : e.isFile() ? [b ? `${b}/${e.name}` : e.name] : []);
    body = (await import('node:zlib')).gzipSync(Bundle.writeTar(walk(target).map(n => ({ name: n, data: fs.readFileSync(path.join(target, n)) }))));
  } else body = fs.readFileSync(target);
  const r = await fetch(url.replace(/\/$/, '') + '/v1/bundle', { method: 'POST', headers: Object.assign({ 'content-type': 'application/gzip' }, token ? { authorization: `Bearer ${token}` } : {}), body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.trim()}`);
  const j = JSON.parse(text);
  if (J) { OUT.sent = j; return; }
  say(`sent ${(body.length / 1e6).toFixed(1)} MB: ${Object.entries(j.totals).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing new'}${j.files.some(f => f.error) ? `\n  errors: ${j.files.filter(f => f.error).map(f => `${f.path}: ${f.error}`).join('; ')}` : ''}`);
}

// A demo store: one benchmark scenario (a fleet with one planted cause and distractors) written to --store, so the
// detect → diagnose → incident flow can be tried without a fleet. The answer is printed so the result can be checked.
function demo(store, o) {
  if (o.training) {
    const days = o.days ? +o.days : 7, t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - days * 86400;
    const at = o['tuned-at'] && o['tuned-at'] !== true ? t0 + +o['tuned-at'] * 86400 : null;
    // the two changes `tune` recommends for the first period: a faster input pipeline, more frequent checkpoints
    const tuned = at ? { at, 'sft-8b': { data: 0.12 }, 'pretrain-70b': { ckptEvery: 40 * 60 } } : null;
    const recs = Goodput.synthTraining({ t0, days, seed: o.seed ? +o.seed : 7, tuned }), written = {};
    for (const [k, r] of Object.entries(recs)) if (r.length) written[k] = store.append(k, r, { dedupe: true }).written;
    if (store.flush) store.flush();
    if (at) {
      const t = Tune.tune(store, { from: t0, to: at, now: at });
      for (const id of ['data-pipeline:sft-8b', 'checkpoint:pretrain-70b']) { const r = t.recommendations.find(x => x.id === id); if (r) Tune.applyTune(store, r, { by: 'demo', at }); }
    }
    const res = { store: store.dir, written, from: t0, to: t0 + days * 86400, planted: { 'pretrain-70b': 'checkpoints every 3 h on a fleet that interrupts it every ~6 h: lost work', 'sft-8b': 'a slow input pipeline: data stalls', 'rl-policy': 'one slow node for two days: slow steps' } };
    if (J) { OUT.demo = res; return; }
    say(`demo store ${store.dir}: ${days} days of training (${Object.entries(written).map(([k, n]) => `${k} ${n}`).join(', ')})`);
    for (const [j, w] of Object.entries(res.planted)) say(`  ${j}: ${w}`);
    say(at ? `applied on day ${o['tuned-at']}: data-pipeline:sft-8b, checkpoint:pretrain-70b\ntry:\n  fleetops tune --from ${new Date(t0 * 1000).toISOString()} --to ${new Date(at * 1000).toISOString()} --store ${store.dir}\n  fleetops tune verify --store ${store.dir}` : `try:\n  fleetops goodput --days ${days} --store ${store.dir}\n  fleetops tune --days ${days} --store ${store.dir}\n  fleetops goodput --days ${days} --format html --out goodput.html --store ${store.dir}`);
    return;
  }
  const names = Bench.SCENARIO_NAMES;
  if (o.list) { if (J) { OUT.scenarios = names; return; } names.forEach(n => say(n)); return; }
  const want = o.scenario && o.scenario !== true ? String(o.scenario) : 'hardware: GPU fault seen in dmesg';
  const name = names.find(n => n === want) || names.find(n => n.startsWith(want));
  if (!name) throw new Error(`no demo scenario starts with "${want}"; see fleetops demo --list`);
  const [lab] = Bench.generate({ perCause: 1, seed: o.seed ? +o.seed : 1, only: [name] });
  // --now: shift every time so the incident ends a minute ago, for the live agent and dashboard
  const shift = o.now ? Math.floor(Date.now() / 1000) - 60 - lab.incident.to : 0;
  const mv = r => { if (!shift) return r; const x = Object.assign({}, r); for (const k of ['t', 'start', 'end', 'since', 'from', 'to', 'alarmAt']) if (typeof x[k] === 'number' && x[k] > 1e9) x[k] += shift; return x; };
  if (shift) { lab.incident = mv(lab.incident); }
  const written = {};
  for (const [kind, recs] of Object.entries(lab.store.data)) if (recs.length) written[kind] = store.append(kind, recs.map(mv), { dedupe: true }).written;
  if (store.flush) store.flush();
  const inc = lab.incident, iso = t => new Date(t * 1000).toISOString();
  const scope = [inc.pool && `--pool ${inc.pool}`, inc.job && `--job ${inc.job}`, inc.nodes && `--nodes ${[].concat(inc.nodes).join(',')}`].filter(Boolean).join(' ');
  // demo fleets are small (12-24 nodes), so job-failure detection needs a lower floor than the default 20
  const mf = inc.symptom === 'job-failures' ? ' --min-failures 5' : '';
  const next = [`fleetops rca detect --from ${iso(inc.from - 6 * 3600)} --to ${iso(inc.to + 3600)}${mf} --diagnose --store ${store.dir}`,
    `fleetops rca diagnose --symptom ${inc.symptom} --from ${iso(inc.from)} --to ${iso(inc.to)}${scope ? ' ' + scope : ''} --store ${store.dir}`,
    `fleetops incidents open --from ${iso(inc.from - 6 * 3600)} --to ${iso(inc.to + 3600)}${mf} --store ${store.dir}`];
  const res = { scenario: name, store: store.dir, written, incident: Object.assign({}, inc, { fromIso: iso(inc.from), toIso: iso(inc.to) }), planted: { cause: lab.cause, component: lab.component || null }, next };
  if (J) { OUT.demo = res; return; }
  say(`demo store ${store.dir}: ${name}`);
  say(`  ${Object.entries(written).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  say(`  incident: ${inc.symptom}, ${iso(inc.from)} → ${iso(inc.to)}${scope ? ' (' + scope + ')' : ''}`);
  say(`  planted cause: ${lab.cause}${lab.component ? ` (${lab.component})` : ''}`);
  say('try:'); next.forEach(c => say('  ' + c));
}

// read-only procurement lookups: the cloud's own command listing what can be bought (src/procure.mjs)
async function procureCmd(cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const from = opt('from') ? time(opt('from')) : undefined;
  let r;
  if (cmd === 'aws-blocks') r = Procure.awsCapacityBlocks({ chip: opt('gpu'), instanceType: opt('instance-type'), gpus: num('gpus'), days: num('days'), from, windowDays: num('window-days') });
  else if (cmd === 'gcp-calendar') r = Procure.gcpCalendarMode({ chip: opt('gpu'), machineType: opt('machine-type'), gpus: num('gpus') ?? num('chips'), days: num('days'), region: opt('region'), from, windowDays: num('window-days'), workload: opt('workload') });
  else throw new Error('fleetops procure aws-blocks --gpu H100|--instance-type T --gpus N --days N [--from DATE] [--window-days 14]\n       fleetops procure gcp-calendar --gpu H200|TPU-v6e|--machine-type T --gpus N|--chips N --days N --region R [--from DATE]');
  if (J) { OUT.procure = r; return; }
  const what = r.instanceType ? `${r.instances} × ${r.instanceType} (${r.gpusPerInstance} GPUs each)` : r.machineType ? `${r.vms} × ${r.machineType} (${r.gpusPerVm} GPUs each)` : `${r.chips} ${r.chip} chips`;
  say(`${what} for ${r.days} day(s). To see what is on offer:\n\n  ${r.argv.join(' ')}\n\n${r.notes.map(n => `- ${n}`).join('\n')}`);
}
async function main() {
  const o = args(process.argv.slice(2));
  J = !!o.json;
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
  if (cmd === 'import' && rest[0] === 'bundle') {
    const r = await importBundle(store, rest[1], o);
    if (J) { OUT.bundle = r; return; }
    say(`bundle ${rest[1]}${r.manifest ? ` (${r.manifest.host || '?'}, collected ${r.manifest.collectedAt || '?'})` : ''}`);
    for (const e of r.files) say(`  ${e.path.padEnd(40)} ${(e.source || '–').padEnd(15)} ${e.error ? `error: ${e.error}` : e.skipped ? e.skipped : Object.entries(e.imported || {}).map(([k, b]) => `${k} ${b.written}${b.invalid ? ` (${b.invalid} invalid: ${b.errors[0] || ''})` : ''}`).join(', ') || 'nothing new'}`);
    say(`  total: ${Object.entries(r.totals).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing imported'}`);
    return;
  }
  if (cmd === 'import') {
    const [src, ...files] = rest;
    if (!src || !files.length) throw new Error('give a SOURCE and at least one FILE');
    const by = importSource(store, src, files, o);
    if (J) { OUT.imported = by; return; }
    for (const [k, b] of Object.entries(by)) say(`${k}: ${b.written} written, ${b.skipped} already there, ${b.invalid} invalid${b.errors.length ? `\n  ${b.errors.slice(0, 5).join('\n  ')}` : ''}`);
    return;
  }
  if (cmd === 'summary') {
    const s = store.summary();
    if (J) { OUT.summary = s; OUT.store = store.dir; return; }
    say(`store ${store.dir}`);
    for (const [k, v] of Object.entries(s)) say(`  ${k.padEnd(10)} ${String(v.records).padStart(9)}  ${fmt(v.from)} → ${fmt(v.to)}  ${Object.entries(v.sources).map(([a, b]) => `${a}:${b}`).join(' ')}`);
    if (!Object.keys(s).length) say('  (empty)');
    return;
  }
  if (cmd === 'query') {
    const kind = rest[0];
    const rows = store.query(kind, { from: time(o.from), to: time(o.to), where: whereFrom(o.where), limit: o.limit ? +o.limit : 1000 });
    if (J) { OUT.records = rows; return; }
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'rollup') {
    const r = await Retention.rollup(store, { steps: o.steps && o.steps !== true ? String(o.steps).split(',').map(Number) : undefined });
    if (J) { OUT.rollup = r; return; }
    for (const x of r) say(`  ${x.day}  ${x.step} s: ${x.raw != null ? `${x.raw} samples → ` : ''}${x.rolled} records`);
    if (!r.length) say('  nothing new to roll up');
    return;
  }
  if (cmd === 'compact') {
    const r = await Retention.compact(store, { rawDays: o['raw-days'] ? +o['raw-days'] : 7, apply: !!o.apply });
    if (J) { OUT.compact = r; return; }
    say(`raw high-volume days before ${r.cutoff}: ${r.plan.length}${r.applied ? '' : ' (dry run: --apply to roll up, keep incident windows and drop them)'}`);
    for (const p of r.plan) say(`  ${p.kind.padEnd(7)} ${p.day}${p.keepWindows ? `  ${p.keepWindows} incident window(s)${p.kept != null ? `: ${p.kept} records kept` : ''}` : ''}${p.dropped ? '  dropped' : ''}`);
    return;
  }
  if (cmd === 'migrate') {
    const r = migrate(store, { apply: !!o.apply });
    if (J) { OUT.migrate = r; return; }
    if (r.from >= r.to) return say(`store is at schema ${r.to}: nothing to do`);
    const changed = r.steps.filter(x => x.changed);
    say(`schema ${r.from} → ${r.to}: ${changed.length} day file(s) with ${changed.reduce((t, x) => t + x.changed, 0)} records to change${r.applied ? ' — done' : ' (dry run: --apply to rewrite)'}`);
    for (const x of changed.slice(0, 20)) say(`  v${x.to} ${x.kind} ${x.day}: ${x.changed} of ${x.records}  (${x.what})`);
    return;
  }
  if (cmd === 'requests') {
    // per-request records (stages, replica, tokens) from the spans in the store
    const from = time(o.from), to = time(o.to), spans = store.query('span', { from, to });
    const reqs = Traces.requestsFromSpans(spans);
    const r = store.append('request', reqs, { dedupe: true });
    if (J) { OUT.requests = { spans: spans.length, requests: reqs.length, written: r.written }; return; }
    say(`${spans.length} spans → ${reqs.length} requests (${r.written} new)`);
    return;
  }
  if (cmd === 'node') {
    // one node, everything the store knows: versions, what it shares, recent log faults and changes
    const node = rest[0]; if (!node) throw new Error('data node NODE [--from T] [--to T]');
    const to = time(o.to), from = time(o.from) ?? (to ?? Math.floor(Date.now() / 1000)) - 7 * 86400;
    const inv = store.query('inventory', { to, where: r => r.node === node }).sort((a, b) => a.t - b.t);
    const g = Topo.groups(store.query('topology', { to })).byNode[node] || {};
    const nvl = store.query('topology', { to, where: e => e.kind === 'nvlink' && e.node === node });
    const logs = store.query('log', { from, to, where: l => l.node === node && l.severity !== 'info' });
    const changes = store.query('change', { from, to, where: c => c.target === node });
    const out = { node, inventory: inv.at(-1) || null, versions: Object.assign({}, ...inv.map(r => r.versions || {})), shares: g, nvlinkPairs: nvl.length, logs, changes };
    if (J) { OUT.node = out; return; }
    const last = inv.at(-1);
    say(`${node}${last ? `  ${last.devices}× ${last.sku || last.vendor}` : '  (not in the inventory)'}`);
    say(`  versions  ${Object.entries(out.versions).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}${last && last.mixedVersions ? `  (mixed across GPUs: ${last.mixedVersions.join(', ')})` : ''}`);
    say(`  shares    ${[...(g.leaf || []), g.rack, g.pdu, g.row, g.site].filter(Boolean).join(', ') || '–'}${nvl.length ? `; ${nvl.length} NVLink pairs` : ''}`);
    say(`  changes   ${changes.length ? `(${changes.length})` : '–'}`); for (const c of changes) say(`    ${fmt(c.t)}  ${c.kind}: ${c.summary || c.id}${c.since != null ? ` (between ${fmt(c.since)} and then)` : ''}`);
    say(`  log faults ${logs.length ? `(${logs.length})` : '–'}`);
    for (const l of logs.slice(-15)) say(`    ${fmt(l.t)}  ${l.gpu != null ? 'gpu' + l.gpu + ' ' : ''}${l.code} [${l.class}/${l.severity}] ${l.msg.slice(0, 90)}`);
    return;
  }
  if (cmd === 'export') {
    const what = rest[0];
    if (what === 'gpu-health') { if (!o.out) throw new Error('--out DIR'); const r = writeGpuHealth(store, o.out, { from: time(o.from), to: time(o.to) }); if (J) OUT.exported = r; else say(`wrote ${r.samples} samples, ${r.jobs} jobs, ${r.results} results to ${r.dir}`); return; }
    if (what === 'fleetscope-trace') { if (!o.out) throw new Error('--out FILE'); const csv = toFleetScopeTrace(store, { from: time(o.from), to: time(o.to), pool: o.pool }); fs.writeFileSync(o.out, csv); const n = csv.split('\n').length - 2; if (J) OUT.exported = { file: o.out, requests: n }; else say(`wrote ${n} requests to ${o.out}`); return; }
    if (what === 'gpu-ledger') { if (!o.out) throw new Error('--out usage.jsonl'); const r = toGpuLedger(store, { from: time(o.from), to: time(o.to), cluster: o.cluster && o.cluster !== true ? o.cluster : null }); fs.writeFileSync(o.out, r.usage.map(x => JSON.stringify(x)).join('\n') + (r.usage.length ? '\n' : '')); if (o.capacity && o.capacity !== true) fs.writeFileSync(o.capacity, JSON.stringify(r.capacity, null, 1)); if (J) OUT.exported = { file: o.out, usage: r.usage.length, capacity: r.capacity }; else say(`wrote ${r.usage.length} usage records to ${o.out}${o.capacity && o.capacity !== true ? ` and capacity to ${o.capacity}` : ''} (gpu-ledger report --usage ${o.out})`); return; }
    throw new Error('export gpu-health | fleetscope-trace | gpu-ledger');
  }
  throw new Error(`unknown: data ${cmd}\n\n${HELP}`);
}

const pc = v => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : '') + Math.round(v * 100) + '%');
const errs = rows => (rows || []).map(r => `${r.metric} ${pc(r.err)}`).join(', ');
async function calibrate(store, cmd, o) {
  const now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const writeProfile = p => { if (o.profile && o.profile !== true) { fs.writeFileSync(o.profile, JSON.stringify(p, null, 1)); say(`profile written to ${o.profile}`); } };
  if (cmd === 'benchmarks') {
    const r = Calib.calibrateBenchmarks(store, { islMean: o.isl ? +o.isl : 300, fleetscope: !o['no-fleetscope'], now });
    store.append('calibration', r.records);
    writeProfile(r.profile);
    if (J) { Object.assign(OUT, r); return; }
    say(`Inference Sizer: GPUs predicted for each benchmark's measured load, before and after calibration (mean input ${r.profile.assumptions.islMean} tokens assumed)`);
    for (const x of r.runs) say(x.sizer.error ? `  ${x.system}: ${x.sizer.error}` : `  ${x.system}: used ${x.sizer.measuredGpus}; spec-sheet model ${x.sizer.before} (${pc(x.sizer.errBefore)}) → calibrated ${x.sizer.after} (${pc(x.sizer.errAfter)})${x.sizer.capped.length ? `; at the ceiling: ${x.sizer.capped.join(', ')}` : ''}`);
    if (!o['no-fleetscope']) {
      say('FleetScope: one pool at the benchmark\'s load');
      for (const x of r.runs) if (x.fleetscope) say(x.fleetscope.error ? `  ${x.system}: ${x.fleetscope.error}` : `  ${x.system}: before ${errs(x.fleetscope.before)}\n    fitted prefill ×${x.fleetscope.calib.prefill}, decode ×${x.fleetscope.calib.decode}: ${x.fleetscope.pass ? 'within the bar' : `not within the bar (${x.fleetscope.diagnosis})`}; after ${errs(x.fleetscope.after)}`);
    }
    if (r.heldOut.length) say('Held out (low-latency runs, checked against the profile fitted on the same system):');
    for (const h of r.heldOut) {
      if (h.sizerCalibrated) say(`  ${h.system} ${h.model}: sizer spec-sheet ${h.sizerSpecSheet.predicted} GPUs (${pc(h.sizerSpecSheet.err)}), calibrated ${h.sizerCalibrated.predicted} (${pc(h.sizerCalibrated.err)}) vs ${h.sizerCalibrated.measuredGpus} used`);
      if (h.fleetscopeCalibrated) say(`    FleetScope spec-sheet ${errs(h.fleetscopeSpecSheet.rows)}\n    FleetScope calibrated ${errs(h.fleetscopeCalibrated.rows)}`);
    }
    return;
  }
  const graphFile = o.graph && o.graph !== true ? o.graph : null;
  if (!graphFile) throw new Error('--graph FILE (a FleetScope graph: "Copy graph JSON" in the editor)');
  const graph = JSON.parse(read(graphFile));
  if (cmd === 'serving') {
    const run = () => {
      const t = Math.floor(Date.now() / 1000), to = time(o.to) ?? (o.every ? t : undefined), from = time(o.from) ?? (o.every ? t - 86400 : undefined);
      const r = Calib.calibrateServing(store, graph, { from, to, holdout: o.holdout ? +o.holdout : 0, now: o.now ? +o.now : t });
      store.append('calibration', r.records);
      writeProfile(r.profile);
      if (o['graph-out'] && o['graph-out'] !== true) fs.writeFileSync(o['graph-out'], JSON.stringify(Calib.applyToGraph(graph, r.profile).graph, null, 1));
      if (J) { Object.assign(OUT, r); return; }
      for (const p of r.pools) say(p.skipped ? `  ${p.name}: ${p.skipped}` : `  ${p.name}: prefill ×${p.calib.prefill}, decode ×${p.calib.decode} — ${p.pass ? 'within the bar' : `not within the bar (${p.diagnosis})`}\n    fit: ${errs(p.after)}${p.heldOut ? `\n    held out: ${errs(p.heldOut.rows)} — ${p.heldOut.pass ? 'pass' : 'fail'}` : ''}`);
    };
    run();
    if (o.every) { const every = +o.every * 1000; say(`re-fitting every ${o.every} s`); setInterval(() => { try { run(); } catch (e) { console.error(e.message); } }, every); }
    return;
  }
  if (cmd === 'drift') {
    if (!o.profile || o.profile === true) throw new Error('--profile FILE');
    const d = Calib.driftCheck(store, graph, JSON.parse(read(o.profile)), { from: time(o.from), to: time(o.to), now });
    store.append('drift', d);
    if (J) OUT.drift = d; else for (const x of d) say(`  ${x.pool}: ${x.drifted ? 'DRIFT' : 'ok'} — ${x.why}`);
    if (o['fail-on-drift'] && d.some(x => x.drifted)) process.exitCode = 3;
    return;
  }
  if (cmd === 'apply') {
    if (!o.profile || !o.out) throw new Error('--profile FILE --out FILE');
    const r = Calib.applyToGraph(graph, JSON.parse(read(o.profile)));
    fs.writeFileSync(o.out, JSON.stringify(r.graph, null, 1));
    if (J) OUT.applied = r.applied; else say(`multipliers written for ${r.applied.join(', ') || 'no pools (no profile entries match the graph)'} → ${o.out}`);
    return;
  }
  throw new Error(`unknown: calibrate ${cmd}\n\n${HELP}`);
}

async function rca(store, cmd, o) {
  const show = list => {
    if (J) { OUT.incidents = list; return; }
    if (o.format === 'md') { console.log(list.map(d => RCA.markdown(d)).join('\n')); return; }
    for (const d of list) {
      say(`${d.id}  [${d.confidence}]`);
      d.hypotheses.slice(0, 3).forEach((h, i) => say(`  ${i + 1}. ${h.title}  (${h.rule}, ${h.score.toFixed(2)})`));
      say(`     ${d.narrative}`);
    }
  };
  const weights = o.weights && o.weights !== true ? JSON.parse(read(o.weights)) : undefined;
  if (cmd === 'detect') {
    const from = time(o.from), to = time(o.to), targets = o.targets && o.targets !== true ? JSON.parse(read(o.targets)) : {};
    const where = whereFrom(o.where);
    let incs;
    if (o.method === 'threshold') incs = [...RCA.detectJobFailureSpikes(store, { from, to, minFailures: o['min-failures'] ? +o['min-failures'] : 50, ratio: o.ratio ? +o.ratio : 4 }), ...RCA.detectServingRegressions(store, { from, to, targets })];
    else incs = Detect.groupIncidents([...Detect.detectJobFailures(store, { from, to, binS: o.bin ? +o.bin : 600, minFailures: o['min-failures'] ? +o['min-failures'] : 20, where }), ...Detect.detectServing(store, { from, to, targets }), ...Detect.detectTraining(store, { from, to })], { gapS: o['group-gap'] ? +o['group-gap'] : 1800 });
    if (!o.diagnose) {
      if (J) { OUT.incidents = incs; return; }
      for (const i of incs) say(`${i.id}  ${i.symptom.startsWith('training') ? `${i.job || i.nodes.join(',')}${i.peak != null ? ` step ${i.peak.toFixed(3)} s vs ${i.baseline.toFixed(3)} s` : ''}` : i.failures != null ? `${i.failures} failures` : `${i.metric} peak ${i.peak.toFixed(3)}${i.limit ? ` > ${i.limit.toFixed(3)}` : i.baseline != null ? ` vs ${i.baseline.toFixed(3)}` : ''}`}${i.alarmAt ? `, alarm ${Math.round((i.alarmAt - i.from) / 60)} min after onset` : ''}, ${((i.to - i.from) / 3600).toFixed(1)} h${i.merged ? `, ${i.merged.length + 1} merged` : ''}${i.related ? `; related: ${i.related.join(', ')}` : ''}`);
      return;
    }
    const ds = incs.map(i => RCA.diagnose(store, i, { weights }));
    store.append('incident', ds);
    return show(ds);
  }
  if (cmd === 'diagnose') {
    if (!o.symptom || !o.from || !o.to) throw new Error('--symptom job-failures|latency|device --from T --to T');
    const inc = { symptom: o.symptom, from: time(o.from), to: time(o.to), pool: o.pool !== true ? o.pool : undefined, nodes: o.nodes && o.nodes !== true ? String(o.nodes).split(',') : undefined, metric: o.metric };
    const d = RCA.diagnose(store, inc, { weights });
    store.append('incident', [d]);
    return show([d]);
  }
  if (cmd === 'eval') {
    if (!o.labels || o.labels === true) throw new Error('--labels FILE');
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    const r = RCA.evaluate(store, labeled);
    if (J) { OUT.evaluation = r; return; }
    say(`${r.incidents} labeled incidents: top-1 ${(r.top1 * 100).toFixed(0)}%, top-3 ${(r.top3 * 100).toFixed(0)}%`);
    for (const x of r.rows) say(`  ${x.id}: labeled ${x.cause}, ranked ${x.rank ?? 'not found'} (${x.got.join(', ')})`);
    return;
  }
  if (cmd === 'bench') return bench(store, o, weights);
  throw new Error(`unknown: rca ${cmd}\n\n${HELP}`);
}

// The root-cause benchmark: synthetic scenarios (default), injected faults (--injections), postmortem labels (--labels).
async function bench(store, o, weights) {
  const pct = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  const rows = [], parts = [];
  const useSynth = !o.injections && !o.labels && !o['from-incidents'] || o.synthetic;
  if (useSynth) { const r = Bench.run(Bench.generate({ perCause: o['per-cause'] ? +o['per-cause'] : 10, seed: o.seed ? +o.seed : 1, only: o.only && o.only !== true ? String(o.only).split(',') : undefined }), { weights }); rows.push(...r.rows); parts.push('synthetic'); }
  let inj = null;
  if (o.injections) { inj = Bench.evalInjections(store, { weights, from: time(o.from), to: time(o.to) }); rows.push(...inj.rows.filter(r => r.cause)); parts.push('injected'); }
  if (o['from-incidents']) { rows.push(...Bench.evalLabels(store, Inc.labelsFromIncidents(store), { weights }).map(r => Object.assign(r, { source: 'incident', scenario: `confirmed: ${r.cause}` }))); parts.push('confirmed incidents'); }
  if (o.labels && o.labels !== true) {
    const labeled = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
    rows.push(...Bench.evalLabels(store, labeled, { weights })); parts.push('postmortem');
  }
  let sum = Bench.summarize(rows), fitted = null;
  if (o.fit && o.fit !== true) {
    // fit on half, report the other half; then fit on all for the file
    const train = rows.filter((_, i) => i % 2 === 0), test = rows.filter((_, i) => i % 2 === 1);
    const wHalf = Bench.fitWeights(train), testBefore = Bench.summarize(test), testAfter = Bench.applyWeights(test, wHalf);
    const w = Bench.fitWeights(rows), perCause = {};
    for (const r of rows) perCause[r.cause] = (perCause[r.cause] || 0) + 1;
    const thin = Object.entries(perCause).filter(([, n]) => n < 5).map(([c]) => c);
    fitted = { rules: w, fittedOn: { sources: parts, incidents: rows.length, perCause }, heldOut: { top1Before: testBefore.top1, top1After: testAfter.top1 },
      warnings: [...(parts.every(p => p === 'synthetic') ? ['fitted on synthetic scenarios only: these weights learn the generator, not your fleet; fit on injected or postmortem labels before using them'] : []), ...(thin.length ? [`fewer than 5 labeled incidents for: ${thin.join(', ')}`] : [])] };
    fs.writeFileSync(o.fit, JSON.stringify(fitted, null, 1));
  }
  if (J) { Object.assign(OUT, { benchmark: { sources: parts, top1: sum.top1, top3: sum.top3, lenientTop1: sum.lenientTop1, componentTop1: sum.componentTop1, byScenario: sum.byScenario, misses: sum.misses.map(m => ({ id: m.id, cause: m.cause, top: m.top, rank: m.rank })) }, injections: inj && { injections: inj.injections, detected: inj.detected, delayP50: inj.delayP50, delayP90: inj.delayP90, rows: inj.rows.map(({ hyps, ...r }) => r) }, fitted }); }
  else {
    say(`${sum.incidents} labeled incidents (${parts.join(' + ')}): top-1 ${pct(sum.top1)}, top-3 ${pct(sum.top3)}${sum.lenientTop1 !== sum.top1 ? `, top-1 counting equivalent causes ${pct(sum.lenientTop1)}` : ''}${sum.componentTop1 != null ? `, component named ${pct(sum.componentTop1)}` : ''}`);
    for (const [k, b] of Object.entries(sum.byScenario)) say(`  ${(b.top1 + '/' + b.n).padStart(7)}  ${k}${b.top1 < b.n ? `   ranked first: ${Object.entries(b.tops).map(([r, n]) => `${r} ${n}`).join(', ')}` : ''}`);
    if (inj) say(`injected faults: ${inj.injections}, detected ${pct(inj.detected)}, alarm after ${inj.delayP50 != null ? Math.round(inj.delayP50 / 60) : '–'} min (p50) / ${inj.delayP90 != null ? Math.round(inj.delayP90 / 60) : '–'} min (p90)`);
    if (inj) for (const r of inj.rows) say(`  ${r.id}: ${r.detected ? `detected after ${Math.round(r.delayS / 60)} min` : 'not detected'}; ${r.cause ? `expected ${r.cause}, ranked ${r.rank ?? 'not found'} (top: ${r.top || 'none'})` : `top: ${r.top || 'none'} (detection only)`}`);
    if (fitted) { say(`weights written to ${o.fit}: ${Object.entries(fitted.rules).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ×${v}`).join(', ') || 'all 1'}; held-out top-1 ${pct(fitted.heldOut.top1Before)} → ${pct(fitted.heldOut.top1After)}`); for (const w of fitted.warnings) say(`  warning: ${w}`); }
  }
  const minT1 = o['min-top1'] ? +o['min-top1'] : null, minT3 = o['min-top3'] ? +o['min-top3'] : null;
  if ((minT1 != null && sum.top1 < minT1) || (minT3 != null && sum.top3 < minT3)) { console.error(`below the bar: top-1 ${pct(sum.top1)} (min ${pct(minT1)}), top-3 ${pct(sum.top3)} (min ${pct(minT3)})`); process.exitCode = 5; }
}

const hdrs = o => Object.fromEntries([].concat(o.header || []).filter(h => h !== true).map(h => { const i = String(h).indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));
const lokiQueries = o => [].concat(o['loki-query'] || ['{job=~".*kernel.*|.*syslog.*"}', '{container=~".+"} |~ "NCCL WARN|Watchdog caught|CUDA error|OutOfMemoryError"']).filter(q => q !== true);
const dur = v => { const m = String(v || '').match(/^(\d+(?:\.\d+)?)([smhd]?)$/); return m ? +m[1] * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : undefined; };

// Pull a window from Prometheus and/or Loki into the store.
async function pull(store, cmd, o) {
  const from = time(o.from), to = time(o.to) ?? Math.floor(Date.now() / 1000);
  if (from == null) throw new Error('pull needs --from (and --to, default now)');
  const out = {};
  if (o.prom && o.prom !== true) out.prometheus = await Pull.pullPrometheus(store, o.prom, { from, to, step: o.step ? +o.step : 60, headers: hdrs(o) });
  if (o.loki && o.loki !== true) out.loki = await Pull.pullLoki(store, o.loki, lokiQueries(o), { from, to, headers: hdrs(o) });
  if (!out.prometheus && !out.loki) throw new Error('pull --prom URL and/or --loki URL');
  if (J) { OUT.pulled = out; return; }
  if (out.prometheus) say(`Prometheus: ${out.prometheus.device} device samples, ${out.prometheus.serving} serving rows, ${out.prometheus.collective} NCCL collective rows (${out.prometheus.unmapped} unmapped series samples)`);
  if (out.loki) say(`Loki: ${out.loki.lines} lines → ${out.loki.logs} classified log records (${out.loki.unmatched} not matched)`);
}

// Backtest: pull each labeled incident's window from the fleet's own monitoring and score root-cause analysis on it.
async function backtest(store, o) {
  if (!o.labels || o.labels === true) throw new Error('backtest --labels postmortems.jsonl --prom URL [--loki URL]');
  const labels = read(o.labels).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)).map(l => Object.assign(l, { incident: Object.assign({}, l.incident, { from: time(l.incident.from), to: time(l.incident.to) }) }));
  const lookback = dur(o.lookback) ?? 26 * 3600, pulled = [];
  for (const l of labels) {
    const w = { from: l.incident.from - lookback, to: l.incident.to + 3600 }, got = { id: l.incident.id || `${l.cause}@${l.incident.from}` };
    if (o.prom && o.prom !== true) got.prometheus = await Pull.pullPrometheus(store, o.prom, Object.assign({ step: o.step ? +o.step : 60, headers: hdrs(o) }, w));
    if (o.loki && o.loki !== true) got.loki = await Pull.pullLoki(store, o.loki, lokiQueries(o), Object.assign({ headers: hdrs(o) }, w));
    pulled.push(got);
    if (!J) say(`  pulled ${got.id}: ${got.prometheus ? `${got.prometheus.device} device, ${got.prometheus.serving} serving` : ''}${got.loki ? `, ${got.loki.logs} log records` : ''}`);
  }
  const weights = o.weights && o.weights !== true ? JSON.parse(read(o.weights)) : undefined;
  const rows = Bench.evalLabels(store, labels, { weights }), sum = Bench.summarize(rows);
  if (J) { Object.assign(OUT, { backtest: { incidents: rows.length, top1: sum.top1, top3: sum.top3, componentTop1: sum.componentTop1, rows: rows.map(({ hyps, ...r }) => Object.assign(r, { ranked: hyps.slice(0, 3) })) }, pulled }); return; }
  const pc = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  say(`backtest on ${rows.length} confirmed incidents: top-1 ${pc(sum.top1)}, top-3 ${pc(sum.top3)}${sum.componentTop1 != null ? `, component ${pc(sum.componentTop1)}` : ''}`);
  for (const r of rows) say(`  ${r.rank === 1 ? 'ok  ' : 'MISS'} ${r.id}: confirmed ${r.cause}${r.component ? ` (${r.component})` : ''}; ranked ${r.rank ?? 'not found'}${r.rank !== 1 ? `, top: ${r.top || 'none'} ${r.hyps[0] ? r.hyps[0].score.toFixed(2) : ''}` : ''}`);
  if (sum.misses.length) say('A miss usually means a signal the store didn\'t get (no logs for that window, no topology) or a rule gap: check `fleetops data node` for the component and the window.');
}

// Game day: run a plan of injections on a test cluster one after another, then score them.
async function gameday(store, cmd, o) {
  const planFile = cmd && cmd !== true ? cmd : o.plan;
  if (!planFile) throw new Error('gameday PLAN.json --allow FILE [--live] [--cooldown 900] [--prom URL --loki URL]');
  const plan = JSON.parse(read(planFile)), allow = Inject.loadAllow(o.allow && o.allow !== true ? o.allow : process.env.FLEETOPS_INJECT_ALLOW);
  const steps = plan.steps || plan, cool = o.cooldown ? +o.cooldown : plan.cooldownS ?? 900, live = !!o.live;
  const preps = steps.map(st => { const { fault, forS, ...params } = st; return { st, prep: Inject.prepare(fault, params, { allow }) }; }); // check every step before running any
  const done = [];
  for (const [i, { st, prep }] of preps.entries()) {
    if (!J) say(`step ${i + 1}/${preps.length}: ${prep.fault} on ${prep.nodes.join(', ') || prep.params.release || prep.params.host} for ${st.forS || 300} s (expect ${prep.expect || 'detection only'})`);
    const r = await Inject.run(prep, { live, forS: st.forS || 300, store, log: J ? () => {} : l => say('  ' + l.trim()) });
    done.push(r);
    if (live && i < preps.length - 1) { if (!J) say(`  cooling down ${cool} s`); await new Promise(res => setTimeout(res, cool * 1000)); }
  }
  if (!live) { if (!J) say('dry run: nothing was run. Add --live on a test cluster.'); else OUT.gameday = { dryRun: true, steps: preps.length }; return; }
  if (o.prom || o.loki) { const lo = Math.min(...done.map(d => d.from)) - 26 * 3600, hi = Math.max(...done.map(d => d.to || d.from)) + 3600; if (o.prom && o.prom !== true) await Pull.pullPrometheus(store, o.prom, { from: lo, to: hi, headers: hdrs(o) }); if (o.loki && o.loki !== true) await Pull.pullLoki(store, o.loki, lokiQueries(o), { from: lo, to: hi, headers: hdrs(o) }); }
  const r = Bench.evalInjections(store, { from: Math.min(...done.map(d => d.from)) - 1, to: Math.max(...done.map(d => d.to || d.from)) + 1 });
  if (J) { OUT.gameday = { injections: r.injections, detected: r.detected, delayP50: r.delayP50, delayP90: r.delayP90, top1: r.diagnosis.top1, rows: r.rows.map(({ hyps, ...x }) => x) }; return; }
  say(`game day: ${r.injections} injections, detected ${(r.detected * 100).toFixed(0)}%, alarm after ${r.delayP50 != null ? Math.round(r.delayP50 / 60) : '–'} min (p50); diagnosis top-1 ${r.diagnosis.incidents ? (r.diagnosis.top1 * 100).toFixed(0) + '%' : '–'}`);
  for (const x of r.rows) say(`  ${x.id}: ${x.detected ? `detected after ${Math.round(x.delayS / 60)} min` : 'not detected'}; ${x.cause ? `expected ${x.cause}, ranked ${x.rank ?? 'not found'}` : `top ${x.top}`}`);
}

// The incident workflow: open from detection, lifecycle, paging, timeline, postmortem.
async function incidents(store, cmd, rest, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), id = rest[0];
  if (!cmd || cmd === 'list') {
    const all = Inc.state(store).filter(s => !opt('status') || s.status === o.status);
    if (J) { OUT.incidents = all.map(({ events, diagnosis, ...s }) => Object.assign(s, { top: diagnosis && diagnosis.hypotheses[0] && diagnosis.hypotheses[0].title })); return; }
    for (const s of all) say(`${s.severity}  ${s.status.padEnd(12)} ${s.id}${s.owner ? `  @${s.owner}` : ''}${s.cause ? `  cause: ${s.cause}` : s.diagnosis && s.diagnosis.hypotheses[0] ? `  likely: ${s.diagnosis.hypotheses[0].rule}` : ''}`);
    if (!all.length) say('no incidents');
    return;
  }
  if (cmd === 'open') {
    // detect in the window, diagnose each, open the new ones
    const from = time(o.from), to = time(o.to), weights = opt('weights') ? JSON.parse(read(o.weights)) : undefined;
    const incs = Detect.groupIncidents([...Detect.detectJobFailures(store, { from, to, binS: o.bin ? +o.bin : 600, minFailures: o['min-failures'] ? +o['min-failures'] : 20, where: whereFrom(o.where) }), ...Detect.detectServing(store, { from, to }), ...Detect.detectTraining(store, { from, to })]);
    const opened = [];
    for (const i of incs) { const d = RCA.diagnose(store, i, { weights }); if (!store.query('incident', { where: x => x.id === d.id }).length) store.append('incident', [d]); const e = Inc.open(store, d, { by: opt('by') || 'fleetops' }); if (e) opened.push(e); }
    if (J) { OUT.opened = opened; return; }
    say(`${incs.length} incident(s) detected, ${opened.length} new`); for (const e of opened) say(`  ${e.severity}  ${e.id}  ${e.summary}`);
    return;
  }
  if (!id) throw new Error(`incidents ${cmd} ID`);
  if (['acknowledge', 'ack', 'mitigate', 'resolve', 'reopen', 'assign', 'severity', 'note'].includes(cmd)) {
    const e = Inc.transition(store, id, cmd === 'ack' ? 'acknowledge' : cmd, { by: opt('by'), note: opt('note'), owner: opt('owner'), severity: opt('severity'), cause: opt('cause'), component: opt('component') });
    if (J) { OUT.event = e; return; }
    say(`${id}: ${e.event}${e.cause ? ` (confirmed cause ${e.cause}${e.component ? `, ${e.component}` : ''}: stored as a label for rca bench --from-incidents)` : ''}`);
    return;
  }
  if (cmd === 'show') {
    const s = Inc.state(store, id); if (!s) throw new Error(`no incident ${id}`);
    if (J) { OUT.incident = s; return; }
    say(`${s.id}  ${s.severity} · ${s.status}${s.owner ? ` · @${s.owner}` : ''}${s.cause ? ` · cause ${s.cause}` : ''}`);
    for (const e of s.events) say(`  ${fmt(e.t)}  ${e.event} by ${e.by}${e.note ? `: ${e.note}` : ''}`);
    if (s.diagnosis) { say('  ranked causes:'); s.diagnosis.hypotheses.slice(0, 3).forEach((h, i) => say(`    ${i + 1}. ${h.title} (${h.rule}, ${h.score.toFixed(2)})`)); }
    return;
  }
  if (cmd === 'timeline' || cmd === 'postmortem') {
    const out = cmd === 'timeline' ? Inc.timelineHtml(store, id) : Inc.postmortem(store, id);
    if (opt('out')) { fs.writeFileSync(o.out, out); say(`written to ${o.out}`); } else console.log(out);
    return;
  }
  if (cmd === 'page') {
    const provider = opt('to') || 'pagerduty', key = opt('key') || process.env[provider === 'opsgenie' ? 'OPSGENIE_API_KEY' : 'PAGERDUTY_ROUTING_KEY'];
    const r = await Inc.page(store, id, provider, opt('action') || 'trigger', { live: !!o.live, key, url: opt('url'), by: opt('by') || 'fleetops' });
    if (J) { OUT.page = r; return; }
    if (r.dryRun) { say(`dry run (--live to send): POST ${r.request.url}`); say(JSON.stringify(Object.assign({}, r.request.body, r.request.body.routing_key ? { routing_key: '…' } : {}), null, 1)); }
    else say(`${provider} ${o.action || 'trigger'}: HTTP ${r.status}${r.ok ? '' : ' (failed)'}`);
    return;
  }
  throw new Error(`unknown: incidents ${cmd}`);
}

// Fault injection on a test cluster (dry-run unless --live; targets must be in the --allow file).
async function inject(store, cmd, o) {
  if (!cmd || cmd === 'list') {
    if (J) { OUT.faults = Object.fromEntries(Object.entries(Inject.FAULTS).map(([k, f]) => [k, { what: f.what, params: Object.keys(f.params), expect: f.expect, undo: !!f.revert, note: f.note }])); return; }
    for (const [k, f] of Object.entries(Inject.FAULTS)) say(`  ${k.padEnd(13)} ${f.what}\n                --${Object.keys(f.params).join(' --')}${f.revert ? ' [--for S]' : ''}   expect: ${f.expect || 'detection only'}${f.note ? `\n                ${f.note}` : ''}`);
    return;
  }
  const allowFile = o.allow && o.allow !== true ? o.allow : process.env.FLEETOPS_INJECT_ALLOW;
  if (!allowFile) throw new Error('--allow FILE (or FLEETOPS_INJECT_ALLOW): the test-cluster targets injection may touch, one per line');
  const params = Object.fromEntries(Object.entries(o).filter(([k]) => !['_', 'where', 'store', 'allow', 'live', 'for', 'json'].includes(k)));
  const prep = Inject.prepare(cmd, params, { allow: Inject.loadAllow(allowFile) });
  const r = await Inject.run(prep, { live: !!o.live, forS: o.for ? +o.for : 300, store, log: J ? () => {} : console.log });
  if (J) OUT.injection = r; else if (!r.dryRun) say(`${r.id}: ${r.applied ? 'applied' : 'FAILED to apply'}${r.reverted != null ? `, reverted ${r.reverted ? 'ok' : 'with errors'}` : ''}; label written to the store (expect ${r.expect || 'detection only'})`);
}

const money = v => '$' + Math.round(v).toLocaleString('en-US');
// What the fleet costs per week now: GPUs in the inventory (or, without one, distinct GPUs seen) × 168 h × price.
function baselineWeekly(store, from, to, price) {
  const nodes = new Map(); for (const r of store.scan('inventory', { to })) if (r.kind !== 'cpu') nodes.set(r.node, r.devices || 0);
  let n = [...nodes.values()].reduce((a, b) => a + b, 0);
  if (!n) { const g = new Set(); for (const r of store.scan('device', { from, to })) g.add(`${r.node}:${r.gpu}`); n = g.size; }
  return n * 168 * price;
}
async function powerCmd(store, cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const to = time(opt('to')) ?? now, from = time(opt('from')) ?? to - (opt('hours') ? +opt('hours') * 3600 : 24 * 3600);
  const opts = Object.assign({}, json('options'), opt('fit-alpha') ? { alphaCompute: +opt('fit-alpha') } : {}, opt('max-slowdown') ? { maxSlowdown: +opt('max-slowdown') } : {}, opt('gpu-share') ? { gpuShare: +opt('gpu-share') } : {});
  const kw = v => (v == null || !Number.isFinite(v) ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  if (cmd === 'demo') {
    const d = Power.synth(); for (const [k, rs] of Object.entries(d.records)) store.append(k, rs);
    const bf = path.join(store.dir, 'power-budgets.json'); fs.writeFileSync(bf, JSON.stringify(d.budgets, null, 1));
    if (J) { OUT.demo = { from: d.from, to: d.to, budgets: bf }; return; }
    return say(`demo in ${store.dir}: two racks of four 8×H100 nodes, rack r1 over its 24 kW budget; budgets in ${bf}\ntry: fleetops power report --budgets ${bf} --from ${d.from} --to ${d.to} --store ${store.dir}\n     fleetops power plan --budgets ${bf} --from ${d.from} --to ${d.to} --out plan.json --store ${store.dir}`);
  }
  if (cmd === 'report') {
    const r = Power.report(store, { from, to, budgets: json('budgets') || {}, opts });
    if (J) { OUT.power = r; return; }
    if (!r.groups.length) return say(r.note);
    say(`${r.nodes} node(s), ${r.bins} × ${r.binS / 60}-min bins; ${r.note}\n`);
    say(`${'group'.padEnd(18)} ${'nodes'.padStart(5)} ${'avg kW'.padStart(8)} ${'p99 kW'.padStart(8)} ${'budget'.padStart(8)} ${'headroom'.padStart(9)}  more nodes`);
    for (const g of r.groups) say(`${g.group.padEnd(18)} ${String(g.nodes).padStart(5)} ${kw(g.avgKw).padStart(8)} ${kw(g.p99Kw).padStart(8)} ${kw(g.budgetKw).padStart(8)} ${(g.headroomKw == null ? '–' : (g.headroomKw < 0 ? 'OVER ' : '') + kw(g.headroomKw)).padStart(9)}  ${g.moreNodes == null ? '' : `${g.moreNodes} × ${g.sku} at ${kw(g.nodeKwP95)} kW (p95)`}${g.overBudgetShare ? `  over ${Math.round(g.overBudgetShare * 100)}% of the time` : ''}`);
    return;
  }
  if (cmd === 'jobs' || cmd === 'predict') {
    let js = Power.jobs(store, { from, to, opts }); if (opt('job')) js = js.filter(j => j.job === opt('job'));
    const cap = opt('cap'), capW = j => (!cap ? null : /%$/.test(cap) ? parseFloat(cap) / 100 * j.limitW : parseFloat(cap));
    if (cmd === 'predict' && !cap) throw new Error('--cap 70% or --cap 500W');
    const rows = js.map(j => Object.assign({}, j, { draws: undefined, devices: undefined }, cap ? { prediction: Power.predict(j, capW(j), opts) } : {}));
    if (cmd === 'predict') rows.sort((a, b) => a.prediction.slowdown - b.prediction.slowdown);
    if (J) { OUT.jobs = rows; return; }
    for (const j of rows) say(`${j.job.padEnd(22)} ${String(j.gpus).padStart(4)} GPU  draw ${kw(j.drawP50)}/${kw(j.drawP95)} W (p50/p95) of ${kw(j.limitW)}  compute-bound ${Math.round(j.computeBound * 100)}%  at limit ${Math.round(j.atLimitShare * 100)}%${j.stepsPerKWh ? `  ${kw(j.stepsPerKWh)} steps/kWh` : ''}${j.prediction ? `\n${''.padEnd(24)}cap ${Math.round(j.prediction.capW)} W → ${(j.prediction.slowdown * 100).toFixed(1)}% slower, −${kw(j.prediction.savedKw)} kW IT${j.prediction.note ? ` (${j.prediction.note})` : ''}` : ''}`);
    return;
  }
  if (cmd === 'fit') { const f = Power.fit(store, { from: time(opt('from')), to }); if (J) { OUT.fit = f; return; } return say(f.alphaCompute == null ? f.note : `${f.note}\nuse it: --fit-alpha ${f.alphaCompute.toFixed(2)} (or options.alphaCompute)`); }
  if (cmd === 'plan') {
    if (!opt('out')) throw new Error('--out plan.json');
    const cfg = ghConfig(json('config')), state = opt('state') || path.join(store.dir, 'rollouts', 'state');
    const p = Power.plan(store, { from, to, budgets: json('budgets') || {}, saveKw: opt('save-kw') ? +opt('save-kw') : null, opts, protect: (opt('protect') || '').split(',').filter(Boolean), cfg, id: opt('id') });
    const guards = json('guards') || {}; for (const s of p.stages) s.guard = guards[s.candidate] || guards.default || null;
    p.state = state; const ids = Opt.enqueue(p, state, now); Opt.savePlan(opt('out'), p);
    if (J) { OUT.plan = p; OUT.queued = ids; return; }
    if (!p.groups.length) return say('every group with a budget is under it: nothing to cap');
    for (const g of p.groups) say(`${g.group}: p99 ${kw(g.p99Kw)} kW against ${kw(g.budgetKw)} → ${g.met ? 'under budget' : 'STILL OVER'} with caps saving ${kw(g.savedKw)} of ${kw(g.needKw)} kW needed`);
    for (const c of p.caps) say(`  ${c.job.padEnd(22)} ${c.class || ''} ${c.capW} W (${Math.round(c.capPct * 100)}% of ${Math.round(c.limitW)}) on ${c.gpus} GPU(s): ${(c.predictedSlowdown * 100).toFixed(1)}% slower, −${kw(c.savedKw)} kW (draws ${kw(c.drawP95)} W p95, ${Math.round(c.computeBound * 100)}% compute-bound)`);
    say(`${p.stages.length} stage(s) queued for approval in ${state}; then: fleetops optimize advance --plan ${opt('out')}`);
    say(`model: slowdown = (draw/cap)^α, α ${p.assumptions.alphaCompute} compute-bound … ${p.assumptions.alphaMemory} memory-bound${opt('fit-alpha') ? ' (fitted)' : ' (defaults: run fleetops power fit to measure)'}`);
    return;
  }
  if (cmd === 'verify') {
    const p = JSON.parse(read(opt('plan') || '')), v = Power.verify(store, p, { now, opts });
    if (J) { OUT.verification = v; return; }
    if (!v.groups) return say(v.note);
    for (const g of v.groups) say(`${g.group}: p99 ${kw(g.p99Before)} → ${kw(g.p99After)} kW (saved ${kw(g.measuredSavedKw)}, predicted ${kw(g.predictedSavedKw)})`);
    for (const j of v.jobs) say(`  ${j.job}: ${j.measuredSlowdown == null ? 'no step records' : `${(j.measuredSlowdown * 100).toFixed(1)}% slower`} (predicted ${(j.predictedSlowdown * 100).toFixed(1)}%)`);
    return;
  }
  throw new Error('fleetops power report | jobs | predict | fit | plan | verify | demo');
}

async function admitCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000);
  const policy = opt('policy') ? JSON.parse(read(opt('policy'))) : {}, state = opt('state') || path.join(store.dir, 'rollouts', 'state'), cfg = ghConfig(opt('config') ? JSON.parse(read(opt('config'))) : undefined);
  if (cmd === 'pending') {
    const p = Adm.pending(store, { now, policy }); if (J) { OUT.pending = p; return; }
    if (!p.length) return say('no nodes waiting for admission');
    for (const x of p) say(`${x.node}${x.sku ? ` (${x.sku})` : ''}: ${x.reasons.join('; ')}${x.last ? ` — last verdict ${x.last.verdict}` : ''}`);
    return say(`\nfleetops admit check NODE   (run tools/admit-node.sh on the node and import its output first)`);
  }
  const node = o._[2]; if (!node) throw new Error('fleetops admit check|apply NODE');
  const v = Adm.evaluate(store, node, { now, policy });
  if (cmd === 'check') {
    if (o.record) store.append('admission', [{ t: now, node, verdict: v.verdict, failed: v.failed, missing: v.missing, sku: v.sku, source: 'fleetops-admit' }]);
    if (v.verdict === 'reject') process.exitCode = 3; else if (v.verdict === 'incomplete') process.exitCode = 2;
    if (J) { OUT.admission = v; return; }
    say(`${node}${v.sku ? ` (${v.sku})` : ''}: ${v.verdict.toUpperCase()}`);
    for (const c of v.checks) say(`  ${c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'FAIL' : 'miss'}  ${c.name.padEnd(11)} ${c.evidence}${c.fix ? `\n        → ${c.fix}` : ''}`);
    return;
  }
  if (cmd === 'apply') {
    // admitting releases the node and needs a person's approval in gpu-health's queue; rejecting keeps it out
    const a = Adm.gateAction(v, now); if (!a) { if (J) { OUT.admission = v; return; } return say(`${node}: incomplete (${v.missing.join(', ')}); nothing to apply`); }
    a.mode = (cfg.policy.actions || {})[a.kind] || (a.kind === 'admit-node' ? 'approve' : 'auto');
    const st = new GhStore(state), prior = st.data.actions.find(x => x.kind === a.kind && x.node === node && ['proposed', 'approved'].includes(x.status));
    const act = prior || Object.assign(a, { status: a.mode === 'auto' ? 'approved' : 'proposed' });
    if (!prior) { st.data.actions.push(act); st.audit(act, 'created', { status: act.status, mode: act.mode, reason: act.reason }); }
    store.append('admission', [{ t: now, node, verdict: v.verdict, failed: v.failed, missing: v.missing, sku: v.sku, source: 'fleetops-admit' }]);
    let r = null;
    if (act.status === 'approved') {
      r = await runAction(act, cfg, { dryRun: !(o.live && cfg.policy.dryRun === false) });
      Object.assign(act, { status: r.dryRun ? 'approved' : r.ok ? 'executed' : 'failed', updatedAt: now }); st.audit(act, r.dryRun ? 'dry-run' : r.ok ? 'executed' : 'failed', { commands: r.commands, text: r.text });
    }
    st.save();
    if (J) { OUT.admission = v; OUT.action = act; OUT.result = r; return; }
    say(`${node}: ${v.verdict}`);
    if (!r) return say(`  ${act.kind} waits for approval: gpu-health actions approve ${act.id} --by NAME --state ${state}, then run this again`);
    say(`  ${act.kind} ${r.dryRun ? 'dry run' : r.ok ? 'done' : 'failed'}: ${(r.commands || []).map(c => c.join(' ')).join(' && ') || r.text}`);
    if (r.dryRun) say('  (add --live, with policy.dryRun false in the gpu-health config, to run it)');
    return;
  }
  throw new Error('fleetops admit pending | check NODE [--record] | apply NODE [--live]');
}

// ---------- shadow upgrades ----------
function selector(sel) {
  if (!sel) return () => true;
  const parts = String(sel).split(',').map(x => x.trim()).filter(Boolean).map(x => { const m = x.match(/^([\w.]+)(=|~)(.*)$/); if (!m) throw new Error(`selector "${x}": use field=value or field~regex`); return m[2] === '=' ? r => String(r[m[1]]) === m[3] : (re => r => re.test(String(r[m[1]] ?? '')))(new RegExp(m[3])); });
  return r => parts.every(f => f(r));
}
const pctS = x => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
function shadowText(r) {
  const L = [`${r.decision.toUpperCase()}: ${r.why}`, `${r.requests.baseline} baseline and ${r.requests.candidate} candidate requests, ${r.paired ? 'paired (the same requests on both)' : 'compared at matched load'}`, ''];
  L.push('  metric   candidate vs baseline (95% CI)          verdict        naive (no load matching)');
  for (const k of ['ttft', 'tpot', 'e2e']) { const m = r.metrics[k]; if (!m || m.verdict === 'no data') { L.push(`  ${k.padEnd(8)} no data`); continue; }
    L.push(`  ${k.padEnd(8)} ${pctS(m.effect).padStart(7)} (${pctS(m.lo)} to ${pctS(m.hi)})`.padEnd(51) + ` ${m.verdict.padEnd(14)} ${pctS(m.naive)}${m.coverage != null && m.coverage < 0.8 ? `   only ${(100 * m.coverage).toFixed(0)}% of baseline requests had matching load` : ''}${m.more ? `   ~${m.more} more per arm to settle` : ''}`); }
  if (r.metrics.errorRate) L.push(`  errors   ${(100 * r.metrics.errorRate.baseline).toFixed(2)}% → ${(100 * r.metrics.errorRate.candidate).toFixed(2)}%`.padEnd(52) + r.metrics.errorRate.verdict);
  if (r.metrics.tokPerGpuS) L.push(`  tok/s per GPU ${r.metrics.tokPerGpuS.baseline.toFixed(0)} → ${r.metrics.tokPerGpuS.candidate.toFixed(0)} (${pctS(r.metrics.tokPerGpuS.effect)}; ${r.metrics.tokPerGpuS.note})`);
  if (r.metrics.costPerMTok) L.push(`  $ per M output tokens ${r.metrics.costPerMTok.baseline.toFixed(2)} → ${r.metrics.costPerMTok.candidate.toFixed(2)} (${pctS(r.metrics.costPerMTok.effect)})   ${r.metrics.costPerMTok.verdict}`);
  if (r.answers) L.push(`  answers  ${r.answers.identical}/${r.answers.prompts} identical under greedy decoding; log-prob drift ${r.answers.meanAbsLogprobDiff != null ? r.answers.meanAbsLogprobDiff.toFixed(3) : '–'}   ${r.answers.verdict}`);
  if (r.prediction) L.push('', `  prediction ${r.prediction.holds ? 'holds' : 'is off: recalibrate'}: ` + r.prediction.rows.map(x => `${x.metric} predicted ${pctS(x.predicted)}, measured ${pctS(x.measured)}`).join('; '));
  if (r.infra) L.push('', '  infra: ' + Object.entries(r.infra).map(([k, v]) => v.effect != null ? `${k} ${pctS(v.effect)}` : `${k} ${v.baseline} → ${v.candidate}`).join(', '));
  return L.join('\n');
}
async function shadowCmd(store, cmd, rest, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const from = time(opt('from')), to = time(opt('to'));
  const requests = sel => store.query('request', { from, to, where: selector(sel) });
  const dir = path.join(store.dir, 'shadow'); fs.mkdirSync(dir, { recursive: true });
  const readJsonl = f => read(f).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const traceRows = async f => { if (/\.json$/.test(f)) { const j = JSON.parse(read(f)); if (j.kind === 'fleetscope.agentic-profile') { const A = (await import('module')).createRequire(import.meta.url)('../../fleetscope/src/agentic.js'); return A.synthesize(j, { sessionsPerHour: num('sessions-per-hour') || 600, horizonS: num('duration') || 600, seed: num('seed') || 1 }); } }
    const { loadRows } = await import('../../fleetscope/tools/agentic.mjs'); return (await loadRows(f)).rows; };
  const arm = (name, url) => ({ name, url, model: opt('model'), apiKey: opt('api-key-env') ? process.env[opt('api-key-env')] : undefined });
  if (cmd === 'demo') {
    const d = Shadow.synth(); store.append('request', [...d.baseline, ...d.candidate]);
    if (J) { OUT.demo = { baseline: d.baseline.length, candidate: d.candidate.length }; return; }
    return say(`demo in ${store.dir}: ${d.baseline.length} baseline and ${d.candidate.length} candidate requests (variant field). The candidate is 8% slower at any load but got less than half the traffic.\ntry: fleetops shadow compare --baseline variant=baseline --candidate variant=candidate --store ${store.dir}`);
  }
  if (cmd === 'plan') {
    const b = json('baseline-config'), c = json('candidate-config'); if (!b || !c) throw new Error('--baseline-config b.json --candidate-config c.json: { model, gpu, tp, gpus?, rate? } (Inference Sizer ids)');
    const reqs = opt('trace') ? await traceRows(opt('trace')) : requests(opt('baseline'));
    if (!reqs.length) throw new Error('no workload: give --trace FILE, or --baseline SEL with request records in the store');
    const w = Shadow.workloadOf(reqs.map(r => Object.assign({ e2e: r.e2e ?? r.api ?? 0 }, r))), p = Shadow.plan({ baseline: b, candidate: c, workload: w, delta: num('effect') ?? 0.03, rps: num('rps') });
    if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(p, null, 1) + '\n');
    if (J) { OUT.plan = p; return; }
    return say(`predicted (candidate vs baseline at median prompt ${Math.round(w.isl)}, output ${Math.round(w.osl)}, cache hit ${w.prefixHit.toFixed(0)}%, ${w.inflight} in flight):\n  TTFT ${pctS(p.predicted.ttft)}, TPOT ${pctS(p.predicted.tpot)}, tokens/s per GPU ${pctS(p.predicted.tokPerGpuS)}${p.predicted.costPerMTok != null ? `, $ per M tokens ${pctS(p.predicted.costPerMTok)}` : ''}\ntest: ${p.test.requestsPerArm} requests per arm to see a ${(100 * p.test.delta).toFixed(0)}% effect${p.test.paired ? ' (paired replay)' : ''}${p.test.seconds ? `, about ${Math.ceil(p.test.seconds / 60)} min at ${opt('rps')} req/s` : ''}\n${p.note}${opt('out') ? `\n→ ${opt('out')}` : ''}`);
  }
  if (cmd === 'replay') {
    if (!opt('trace') || !opt('baseline') || !opt('candidate')) throw new Error('--trace FILE|profile.json --baseline URL --candidate URL [--live]');
    const reqs = Replay.requestsFrom(await traceRows(opt('trace')), { speed: num('speed') || 1, maxRequests: num('max-requests') ?? 1000, durationS: num('duration') ?? Infinity });
    const arms = [arm('baseline', opt('baseline')), arm('candidate', opt('candidate'))];
    const res = await Replay.run(reqs, arms, { live: !!o.live, maxInflight: num('max-inflight') || 64, model: opt('model'), exact: !o['no-exact-output'] });
    if (res.dryRun) { if (J) { OUT.replay = res; return; } return say(`dry run: ${res.plan.requests} requests (${res.plan.sessions} sessions) over ${Math.round(res.plan.seconds)} s; ${res.plan.note}.\nAdd --live to send them.`); }
    store.append('request', res.records, { source: 'shadow-replay' });
    if (opt('out')) fs.writeFileSync(opt('out'), res.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (J) { OUT.replay = { requests: res.records.length, errors: res.records.filter(r => r.error).length }; return; }
    return say(`${res.records.length} measurements (${res.records.filter(r => r.error).length} errors) in ${store.dir}${opt('out') ? ` and ${opt('out')}` : ''}\nnext: fleetops shadow compare --baseline variant=baseline,source=shadow-replay --candidate variant=candidate,source=shadow-replay --store ${store.dir}`);
  }
  if (cmd === 'answers') {
    if (!opt('baseline') || !opt('candidate')) throw new Error('--baseline URL --candidate URL [--prompts FILE] [--live]');
    const prompts = opt('prompts') ? read(opt('prompts')).split('\n').map(l => l.trim()).filter(Boolean).map(l => (l.startsWith('{') ? JSON.parse(l).prompt : l)) : Replay.PROMPTS;
    const res = await Replay.answers([arm('baseline', opt('baseline')), arm('candidate', opt('candidate'))], { prompts, live: !!o.live, model: opt('model'), maxTokens: num('max-tokens') || 64 });
    if (opt('out') && !res.dryRun) fs.writeFileSync(opt('out'), JSON.stringify(res, null, 1) + '\n');
    if (J) { OUT.answers = res; return; }
    return say(res.dryRun ? `dry run: ${res.note}. Add --live to send them.` : `${res.identical}/${res.prompts} identical; first divergence at token ${res.meanFirstDivergence ?? '–'} on average; log-prob drift ${res.meanAbsLogprobDiff != null ? res.meanAbsLogprobDiff.toFixed(4) : '–'}${opt('out') ? ` → ${opt('out')}` : ''}`);
  }
  if (cmd === 'compare') {
    let base, cand;
    if (opt('results')) { const rs = readJsonl(opt('results')); base = rs.filter(r => r.variant === 'baseline'); cand = rs.filter(r => r.variant === 'candidate'); }
    else { if (!opt('baseline') || !opt('candidate')) throw new Error('--results FILE, or --baseline SEL --candidate SEL'); base = requests(opt('baseline')); cand = requests(opt('candidate')); }
    if (!base.length || !cand.length) throw new Error(`no requests: ${base.length} baseline, ${cand.length} candidate`);
    const plan = json('plan'), re = k => (opt(k) ? new RegExp(opt(k)) : null);
    const r = Shadow.compare(base, cand, { gates: json('gates'), predicted: plan && plan.predicted, answers: json('answers'),
      baseline: { gpus: num('baseline-gpus'), rate: num('baseline-rate') }, candidate: { gpus: num('candidate-gpus'), rate: num('candidate-rate') },
      infra: opt('baseline-nodes') ? Shadow.infraSignals(store, { baselineNodes: re('baseline-nodes'), candidateNodes: re('candidate-nodes'), from, to }) : null });
    fs.appendFileSync(path.join(dir, 'verdicts.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), baseline: opt('baseline') || opt('results'), candidate: opt('candidate') || opt('results'), decision: r.decision, why: r.why, metrics: r.metrics }) + '\n');
    if (J) { OUT.shadow = r; return; }
    return say(shadowText(r));
  }
  if (cmd === 'baseline') {
    const bdir = path.join(dir, 'baselines'); fs.mkdirSync(bdir, { recursive: true });
    if (rest[0] === 'list' || !rest[0]) { const xs = fs.readdirSync(bdir).filter(f => f.endsWith('.jsonl')).map(f => { const ls = readJsonl(path.join(bdir, f)); const b = ls[ls.length - 1]; return { name: b.name, saved: fmt(b.t), requests: b.requests, versions: ls.length }; }); if (J) { OUT.baselines = xs; return; } return say(xs.length ? xs.map(x => `${x.name}  ${x.requests} requests, saved ${x.saved} (${x.versions} version${x.versions > 1 ? 's' : ''})`).join('\n') : 'no baselines yet: fleetops shadow baseline save --name NAME --select SEL'); }
    if (rest[0] === 'save') { if (!opt('name') || !opt('select')) throw new Error('--name NAME --select SEL'); const rs = requests(opt('select')); if (!rs.length) throw new Error('no requests match'); const b = Shadow.makeBaseline(opt('name'), rs, { meta: { select: opt('select'), from, to } }); fs.appendFileSync(path.join(bdir, opt('name').replace(/[^\w.-]/g, '_') + '.jsonl'), JSON.stringify(b) + '\n'); if (J) { OUT.baseline = { name: b.name, requests: b.requests, sample: b.sample.length }; return; } return say(`saved baseline ${b.name}: ${b.sample.length} of ${b.requests} requests`); }
    throw new Error('fleetops shadow baseline save --name NAME --select SEL | list');
  }
  if (cmd === 'watch') {
    if (!opt('name') || !opt('select')) throw new Error('--name NAME --select SEL [--from T --to T]');
    const f = path.join(dir, 'baselines', opt('name').replace(/[^\w.-]/g, '_') + '.jsonl'); if (!fs.existsSync(f)) throw new Error(`no baseline ${opt('name')}: fleetops shadow baseline save first`);
    const ls = readJsonl(f), b = ls[ls.length - 1], cur = requests(opt('select')); if (!cur.length) throw new Error('no current requests match');
    const r = Shadow.drift(b, cur), hist = path.join(dir, 'watch-' + opt('name').replace(/[^\w.-]/g, '_') + '.jsonl');
    fs.appendFileSync(hist, JSON.stringify({ t: Math.floor(Date.now() / 1000), from, to, metrics: Object.fromEntries(Object.entries(r.metrics).map(([k, v]) => [k, v.effect])), drifted: r.drifted }) + '\n');
    const past = readJsonl(hist).slice(-8);
    if (J) { OUT.watch = Object.assign(r, { history: past }); return; }
    return say(`${r.note} (${r.current} requests vs baseline ${b.name} of ${fmt(b.t)})\n` + ['ttft', 'tpot', 'e2e'].map(k => { const m = r.metrics[k]; return `  ${k.padEnd(5)} ${pctS(m.effect)} (${pctS(m.lo)} to ${pctS(m.hi)}) ${m.verdict}`; }).join('\n') + `\n  last ${past.length} checks, TPOT: ${past.map(x => pctS(x.metrics.tpot)).join('  ')}`);
  }
  throw new Error('fleetops shadow demo | plan | replay | answers | compare | baseline save|list | watch');
}

async function rolloutCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), now = o.now ? +o.now : Math.floor(Date.now() / 1000), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined);
  const state = opt('state') || path.join(store.dir, 'rollouts', 'state'), cfg = ghConfig(json('config'));
  const hours = s => (s == null ? undefined : /h$/.test(s) ? parseFloat(s) * 3600 : /m$/.test(s) ? parseFloat(s) * 60 : +s);
  if (cmd === 'demo') {
    const d = RO.synth({ bad: !o.good }); for (const [k, rs] of Object.entries(d.records)) store.append(k, rs);
    if (J) { OUT.demo = { canary: d.canary, canaryAt: d.canaryAt, end: d.end, old: d.old, new: d.neu, bad: !o.good }; return; }
    return say(`demo fleet in ${store.dir}: 24 H100 nodes on driver ${d.old}; ${d.canary.join(' and ')} moved to ${d.neu} on ${new Date(d.canaryAt * 1000).toISOString().slice(0, 16)}${o.good ? '' : ' (a bad driver)'}\ntry: fleetops rollout check --field driver --version ${d.neu} --from ${d.canaryAt} --to ${d.end} --store ${store.dir}`);
  }
  if (cmd === 'check') {
    if (!opt('field') || !opt('version')) throw new Error('--field driver --version V [--from T] [--to T]');
    const to = time(opt('to')) ?? now, g = RO.compare(store, { field: opt('field'), version: opt('version'), since: time(opt('from')) ?? to - 7 * 86400, now: to, policy: json('policy') });
    if (J) { OUT.comparison = g; if (g.ok === false) process.exitCode = 4; return; }
    say(`${opt('field')} ${opt('version')} on ${(g.treated || []).length} node(s) vs ${g.control ?? 0} on other versions: ${g.ok === false ? 'REGRESSION' : g.ok ? 'no regression' : 'not enough data yet'}`);
    for (const m of g.metrics) say(`  ${m.regression ? 'WORSE' : 'ok   '} ${m.name}: ×${m.ratio.toFixed(2)}${m.p != null ? ` (p ${m.p < 1e-4 ? '<1e-4' : m.p.toFixed(4)})` : ''}  ${m.detail}`);
    if (g.ok == null) say(`  ${g.note}`);
    if (g.ok === false) process.exitCode = 4;
    return;
  }
  if (cmd === 'plan') {
    if (!opt('out')) throw new Error('--out rollout.json');
    const tmpl = k => (opt(k) ? [opt(k).split(' ').filter(Boolean)] : undefined);   // "ansible-playbook driver.yml -l {node} -e v={version}"
    const p = RO.plan(store, { field: opt('field'), version: opt('version'), nodes: opt('nodes'), sku: opt('sku'), canary: opt('canary') ?? 2, waves: opt('waves') ? opt('waves').split(',') : undefined, bakeS: hours(opt('bake')), apply: tmpl('apply'), rollback: tmpl('rollback'), id: opt('id'), now, policy: json('policy') });
    p.state = state; const ids = RO.enqueue(p, state, now); fs.writeFileSync(opt('out'), JSON.stringify(p, null, 1));
    if (J) { OUT.plan = p; OUT.queued = ids; return; }
    say(`${p.id}: ${p.field} ${p.from} → ${p.version} on ${p.stages.reduce((a, s) => a + s.nodes.length, 0)} node(s), ${p.stages.length} wave(s), each queued for approval in ${state}:`);
    for (const s of p.stages) say(`  ${s.n}. ${s.title}: ${s.nodes.slice(0, 6).join(', ')}${s.nodes.length > 6 ? ` … +${s.nodes.length - 6}` : ''}  (bake ${(s.bakeS / 3600).toFixed(1)} h)`);
    return say(`then: gpu-health actions approve ${ids[0]} --by NAME --state ${state}; fleetops rollout advance --plan ${opt('out')}`);
  }
  const planFile = opt('plan'); if (!planFile) throw new Error('fleetops rollout demo | check | plan | advance --plan FILE | status --plan FILE');
  const p = JSON.parse(read(planFile));
  if (cmd === 'advance') {
    const poster = (url, text) => { Sec.checkEgress(url); return postWebhook(url, text); };
    const r = await RO.advance(p, { store, stateDir: opt('state') || p.state || state, cfg, live: !!o.live, now, poster });
    fs.writeFileSync(planFile, JSON.stringify(p, null, 1));
    if (J) { OUT.plan = p; OUT.log = r.log; return; }
    for (const l of r.log) say(l); say(`${p.id}: ${p.status}`);
    if (p.status === 'halted') process.exitCode = 4;
    return;
  }
  if (cmd === 'status') { if (J) { OUT.plan = p; return; } say(`${p.id}: ${p.status}${p.haltReason ? ` — ${p.haltReason}` : ''}`); for (const s of p.stages) say(`  ${s.n}. ${s.status.padEnd(11)} ${s.title}${s.guardResult ? `  [${s.guardResult.note}]` : ''}`); return; }
  throw new Error(`unknown: rollout ${cmd}`);
}

async function optimize(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = k => (opt(k) ? JSON.parse(read(opt(k))) : undefined);
  const now = o.now ? +o.now : Math.floor(Date.now() / 1000), price = o.price ? +o.price : 4;
  const state = opt('state') || path.join(store.dir, 'rollouts', 'state');
  const cfg = ghConfig(json('config'));
  if (cmd === 'candidates') {
    const from = time(o.from), to = time(o.to);
    const cands = [...Opt.fromGpuHealth(store, { from, to, cfg }), ...Opt.fromRetryStorms(store, { from, to, price, maxAttempts: o['max-attempts'] ? +o['max-attempts'] : 2 })];
    if (opt('graph')) {
      // the store's requests go through the same CSV and parser as FleetScope's own --trace option
      const rows = opt('trace-pool') ? FSIN.parseTrace(toFleetScopeTrace(store, { pool: o['trace-pool'], from: time(o['trace-from']), to: time(o['trace-to']) })).trace : null;
      if (rows && !rows.length) throw new Error(`no request records for pool ${o['trace-pool']}`);
      if (rows) say(`replaying ${rows.length} requests of ${o['trace-pool']} through the graph`);
      cands.push(...Opt.fromFleetScope(json('graph'), { target: o.target ? +o.target : 0.99, traceRows: rows }));
    }
    const out = { from, to, price, baselineWeekly: baselineWeekly(store, from, to, price), candidates: cands.map(c => Object.assign({}, c, { graph: undefined })) };
    if (opt('out')) fs.writeFileSync(o.out, JSON.stringify(out, null, 1));
    if (J) { Object.assign(OUT, out); return; }
    say(`${cands.length} candidates (fleet ≈ ${money(out.baselineWeekly)}/week at $${price}/GPU-hour)`);
    say('  savings/week  risk    SLO                       candidate');
    for (const c of cands.slice().sort((a, b) => b.savingsWeekly - a.savingsWeekly)) say(`  ${money(c.savingsWeekly).padStart(11)}  ${c.risk.padEnd(6)}  ${(c.protected ? 'PROTECTED' : c.slo.impact).padEnd(24)}  ${c.title}${c.realized ? ` (${c.realized})` : ''}`);
    if (opt('out')) say(`written to ${o.out}`);
    return;
  }
  if (cmd === 'plan') {
    const c = json('candidates'); if (!c || !opt('out')) throw new Error('--candidates FILE --out plan.json');
    const sel = Opt.select(c.candidates, { savePct: o['save-pct'] ? +o['save-pct'] : undefined, baselineWeekly: o['baseline-weekly'] ? +o['baseline-weekly'] : c.baselineWeekly, maxRisk: opt('max-risk') || 'medium' });
    const plan = Opt.planRollout(sel, { guards: json('guards') || {}, deployments: json('deployments') || {}, bakeS: o.bake ? +o.bake : 1800, cfg });
    plan.goal = { savePct: o['save-pct'] ? +o['save-pct'] : null, baselineWeekly: sel.baselineWeekly, savedPct: sel.savedPct, meetsGoal: sel.meetsGoal }; plan.skipped = sel.skipped; plan.state = state;
    const ids = Opt.enqueue(plan, state, now);
    Opt.savePlan(o.out, plan);
    if (J) { OUT.plan = plan; OUT.queued = ids; return; }
    say(`plan ${plan.id}: ${money(plan.totalWeekly)}/week${plan.potentialWeekly > plan.totalWeekly ? ` firm, up to ${money(plan.potentialWeekly)} if notified owners act` : ''}${sel.savedPct != null ? ` (${(sel.savedPct * 100).toFixed(1)}% of ${money(sel.baselineWeekly)})` : ''}${plan.goal.savePct ? ` — goal ${plan.goal.savePct}% ${sel.meetsGoal ? 'met' : 'NOT met'}` : ''}`);
    const many = plan.candidates.length > 8;
    for (const x of many ? plan.candidates.slice(0, 6) : plan.candidates) say(`  + ${x.title}  ${money(x.savingsWeekly)}/week, risk ${x.risk}`);
    if (many) say(`  + … ${plan.candidates.length - 6} more`);
    for (const x of sel.skipped.slice(0, 8)) say(`  - ${x.id}: ${x.why}`);
    if (sel.skipped.length > 8) say(`  - … ${sel.skipped.length - 8} more skipped`);
    say(`${plan.stages.length} stages queued for approval in ${state}:`);
    plan.stages.forEach((st, i) => say(`  ${st.n}. ${st.title}${st.guard ? `  [guard: pool ${st.guard.pool} ${st.guard.metric} ≤ ${st.guard.limit ?? `+${Math.round((st.guard.maxRegression ?? 0.1) * 100)}%`}, bake ${st.bakeS}s]` : ''}\n     approve: gpu-health actions approve ${ids[i]} --by NAME --state ${state}`));
    say(`then: fleetops optimize advance --plan ${o.out}`);
    return;
  }
  const planFile = opt('plan'); if (!planFile) throw new Error('--plan plan.json');
  const plan = JSON.parse(read(planFile));
  if (cmd === 'advance') {
    const poster = (url, text) => { Sec.checkEgress(url); return postWebhook(url, text); }; // gpu-health's webhook (Lark-aware), behind the egress allowlist
    const r = await Opt.advance(plan, { store, stateDir: opt('state') || plan.state || state, cfg, live: !!o.live, now, poster });
    Opt.savePlan(planFile, plan);
    if (J) { OUT.plan = plan; OUT.log = r.log; return; }
    for (const l of r.log) say(l);
    say(`plan ${plan.id}: ${plan.status}`);
    if (plan.status === 'rolled-back') process.exitCode = 4;
    return;
  }
  if (cmd === 'verify') {
    const v = Opt.verify(plan, store, { days: o.days ? +o.days : 7, now });
    store.append('optimization', [Object.assign({ t: now, id: plan.id, status: plan.status, expectedWeekly: plan.totalWeekly }, v)]);
    if (J) { OUT.verification = v; return; }
    if (!v.window) return say(v.note);
    say(`${plan.id}: allocated GPU-hours ${v.before.gpuHours.toFixed(0)} → ${v.after.gpuHours.toFixed(0)} (${pc(v.gpuHoursChange)}) over ${(v.window / 86400).toFixed(1)} days; guard breaches ${v.before.breaches} → ${v.after.breaches}: ${v.verified ? 'verified' : 'NOT verified'}`);
    return;
  }
  throw new Error(`unknown: optimize ${cmd}\n\n${HELP}`);
}

function tokenCmd(cmd, o) {
  const file = o.tokens && o.tokens !== true ? o.tokens : null;
  if (!file) throw new Error('--tokens FILE');
  if (cmd === 'create') {
    if (!o.name || o.name === true) throw new Error('--name NAME');
    const roles = String(o.roles && o.roles !== true ? o.roles : 'read').split(',');
    const list = k => (o[k] && o[k] !== true ? String(o[k]).split(',') : undefined);
    const scoped = ['namespaces', 'owners', 'pools', 'clusters'].some(k => list(k)) || o.infra;
    const tenant = scoped ? Object.fromEntries([...['namespaces', 'owners', 'pools', 'clusters'].map(k => [k, list(k)]).filter(([, v]) => v), ...(o.infra ? [['infra', true]] : [])]) : '*';
    const { token, entry } = Sec.addToken(file, { name: o.name, roles, tenant });
    console.log(`token for ${entry.name} (${roles.join(', ')}; ${tenant === '*' ? 'all tenants' : JSON.stringify(tenant)}):\n${token}\nOnly its SHA-256 is stored in ${file}; this is the only time it is shown.`);
    return;
  }
  if (cmd === 'list') { for (const t of Sec.loadTokens(file)) console.log(`${t.name.padEnd(20)} ${t.roles.join(',').padEnd(18)} ${t.tenant === '*' ? '*' : JSON.stringify(t.tenant)}`); return; }
  throw new Error('token create|list --tokens FILE');
}

// Streaming ingestion: remote_write and OTLP/HTTP (JSON) into the store.
// ---------- goodput ----------
function goodputCmd(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  const g = Goodput.goodput(store, { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)), job: opt('job'), targets: opt('targets') ? JSON.parse(read(opt('targets'))) : {} });
  const fmt = opt('format');
  if (fmt === 'html' || fmt === 'md') { const text = fmt === 'html' ? goodputHtml(g) : goodputMarkdown(g); if (opt('out')) { fs.writeFileSync(opt('out'), text); say(`wrote ${opt('out')}`); if (J) OUT.wrote = opt('out'); } else process.stdout.write(text); return; }
  if (J) { OUT.goodput = Object.assign({}, g, { jobs: g.jobs.map(({ attemptsList, ...j }) => j) }); return; }
  process.stdout.write(goodputMarkdown(g));
}

function tuneCmd(store, cmd, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = f => JSON.parse(read(f));
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  // pools deployed with `fleetops serving deploy` are known without --pools / --targets
  const reg = f => { const p = path.join(store.dir, 'serving', f); return fs.existsSync(p) ? JSON.parse(read(p)) : {}; };
  const args = { from, to, now: Math.min(to, Math.floor(Date.now() / 1000)), targets: Object.assign(reg('targets.json'), opt('targets') ? json(opt('targets')) : {}), pools: Object.assign(reg('pools.json'), opt('pools') ? json(opt('pools')) : {}) };
  const last = path.join(store.dir, 'tune', 'last.json');
  if (cmd === 'models') { const C = createRequire(import.meta.url)('../../inference-sizer/src/catalog.js'); if (J) { OUT.models = C.MODELS.map(m => m.id); OUT.gpus = C.GPUS.map(g => g.id); return; } say(`models: ${C.MODELS.map(m => m.id).join(' ')}\ngpus:   ${C.GPUS.map(g => g.id).join(' ')}`); return; }
  if (cmd === 'apply') {
    const id = o._[2]; if (!id) throw new Error('fleetops tune apply ID --by NAME');
    let rec = fs.existsSync(last) ? JSON.parse(read(last)).recommendations.find(r => r.id === id) : null;
    if (!rec) rec = Tune.tune(store, args).recommendations.find(r => r.id === id);
    if (!rec) throw new Error(`no recommendation ${id} (run fleetops tune first; ids are shown in its output)`);
    const c = Tune.applyTune(store, rec, { by: opt('by'), at: time(opt('at')), note: opt('note') });
    if (J) { OUT.applied = c; return; }
    say(`recorded ${id} applied at ${fmt(c.t)} by ${c.by}${rec.verify ? `\nmeasure it once there is data after the change: fleetops tune verify ${id}` : ''}`);
    return;
  }
  if (cmd === 'verify' || cmd === 'list') {
    const ids = cmd === 'verify' && o._[2] ? [o._[2]] : [...new Set(Tune.applied(store).map(c => c.tune.id))];
    const vo = { beforeS: dur(opt('before')) ?? 7 * 86400, afterS: dur(opt('after')) ?? 7 * 86400, now: Math.floor(Date.now() / 1000) };
    const res = ids.map(id => Object.assign({ title: (Tune.applied(store).filter(c => c.tune.id === id).pop() || { tune: {} }).tune.title }, Tune.verifyTune(store, id, vo)));
    if (J) { OUT.verified = res; return; }
    if (!res.length) { say('nothing applied yet: fleetops tune apply ID --by NAME after making a change'); return; }
    const f = (m, x) => (x == null ? '–' : m === 'pool.ttftP99' ? `${x.toFixed(3)} s` : m === 'fleet.interruptions' ? x.toFixed(2) : `${(x * 100).toFixed(1)}%`);
    for (const r of res) say(`${r.verdict.toUpperCase().padEnd(15)} ${r.id}${r.title ? `  ${r.title}` : ''}${r.before ? `\n                ${r.metric}${r.scope ? ` (${r.scope})` : ''}: ${f(r.metric, r.before.mean)} before (${r.before.n}) → ${f(r.metric, r.after.mean)} after (${r.after.n})${r.ci ? `, difference 95% CI ${f(r.metric, r.ci[0])} to ${f(r.metric, r.ci[1])}` : ''}` : ''}${r.note ? `\n                ${r.note}` : ''}`);
    return;
  }
  if (cmd === 'holdout') {
    const split = time(opt('split')) ?? Math.round((from + to) / 2);
    const h = Tune.holdout(store, Object.assign({}, args, { from, split, to }));
    if (J) { OUT.holdout = h; return; }
    say(`recommendations from ${fmt(from)} → ${fmt(split)}, checked on ${fmt(split)} → ${fmt(to)}:`);
    for (const r of h.rows) {
      const o2 = r.outOfSample;
      const txt = r.id === 'flaky-nodes' && o2 ? `the same nodes: ${o2.failed.toFixed(0)} failed attempts against ${o2.expected.toFixed(0)} expected (${o2.ratio ? o2.ratio.toFixed(1) : '–'}×), ${(o2.share * 100).toFixed(1)}% of failures`
        : r.id.startsWith('reclaim:') && o2 ? `${o2.still} of ${o2.of} jobs still flagged`
          : r.inSample != null && typeof r.inSample === 'number' && typeof o2 === 'number' ? `${(r.inSample * 100).toFixed(1)}% before, ${(o2 * 100).toFixed(1)}% after` : (r.note || '');
      say(`  ${r.held == null ? '–' : r.held ? 'HELD ' : 'FADED'} ${r.id}: ${txt}`);
    }
    return;
  }
  if (cmd && cmd !== 'run') throw new Error(`unknown: tune ${cmd}`);
  const t = Tune.tune(store, args);
  fs.mkdirSync(path.dirname(last), { recursive: true }); fs.writeFileSync(last, JSON.stringify(t));
  if (opt('format') === 'json' || J) { if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(t, null, 1)); OUT.tune = t; if (!J) say(JSON.stringify(t, null, 1)); return; }
  const text = Tune.tuneMarkdown(t);
  if (opt('out')) { fs.writeFileSync(opt('out'), text); say(`wrote ${opt('out')}`); } else process.stdout.write(text);
}

async function servingCmd(store, cmd, o) {
  const opt = k => (o[k] != null && o[k] !== true ? o[k] : undefined), num = k => (opt(k) != null ? +opt(k) : undefined);
  const f1 = v => (v == null ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 1 : 2));
  if (cmd === 'models') { const ms = Serving.models(); if (J) { OUT.models = ms; return; } for (const m of ms) say(`${m.id.padEnd(18)} ${String(m.params).padStart(7)}B${m.active !== m.params ? ` (${m.active}B active)` : ''}  ctx ${m.maxCtx}  ${m.hf || ''}`); return; }
  if (cmd === 'gpus') { const gs = Serving.gpus(); if (J) { OUT.gpus = gs; return; } for (const g of gs) say(`${g.id.padEnd(12)} ${g.label} · ${g.hbmGB} GB · ${g.perNode} per node${g.price ? ` · $${g.price}/GPU-h` : ''}`); return; }
  const FIT = createRequire(import.meta.url)('../../inference-sizer/src/fit.js');
  // workload: measured from a pool in the store, or given
  let wl = { isl: num('isl') || 2000, osl: num('osl') || 400, islP99: num('isl-p99'), oslP99: num('osl-p99'), rate: num('rate') };
  if (opt('from-pool')) {
    const to = Math.floor(Date.now() / 1000), m = Serving.workloadFromStore(store, opt('from-pool'), { from: time(opt('from')) ?? to - 7 * 86400, to: time(opt('to')) ?? to });
    if (!m) throw new Error(`fewer than 50 requests for pool ${opt('from-pool')} in the store (import request logs first)`);
    wl = Object.assign(m, { rate: num('rate') ?? m.rate });
    say(`workload ${m.source}: ISL ${Math.round(m.isl)} (p99 ${Math.round(m.islP99)}), OSL ${Math.round(m.osl)} (p99 ${Math.round(m.oslP99)}), p99 load ${m.rate.toFixed(2)} req/s`);
  }
  const tg = { ttftS: num('ttft') || 2, tpotS: num('tpot') || 0.05 };
  const hw = { gpu: opt('gpu'), nodes: num('nodes'), gpus: num('gpus'), gpusPerNode: num('gpus-per-node') };
  if (cmd === 'fit') {
    if (!hw.gpu || (hw.nodes == null && hw.gpus == null)) throw new Error('fleetops serving fit --gpu G --nodes N (or --gpus N)');
    if (hw.nodes == null) delete hw.nodes;
    const r = FIT.fitModels(hw, wl, tg, { rank: opt('rank'), prompt: !!o.prompt });
    if (J) { OUT.fit = r; return; }
    say(`${hw.nodes != null ? `${hw.nodes} node(s)` : `${hw.gpus} GPUs`} of ${hw.gpu}; ISL ${Math.round(wl.isl)} / OSL ${Math.round(wl.osl)} tokens; TTFT ≤ ${tg.ttftS}s, TPOT ≤ ${tg.tpotS * 1000}ms${wl.rate ? `; needs ${wl.rate} req/s` : ''}`);
    say(`ranked by ${r.rank === 'largest' ? 'size among the models that carry the load (size is a proxy for capability, not a quality score)' : 'requests per second'}\n`);
    say(`${'model'.padEnd(18)} ${'params'.padStart(8)}  ${'req/s'.padStart(8)}  ${'edge'.padStart(8)}  ${'out tok/s'.padStart(10)}  ${'$/1M out'.padStart(8)}  layout`);
    for (const x of r.rows) {
      const p = x.production, L = p.layout;
      say(`${(r.need && x.meetsRate ? '✓ ' : r.need ? '  ' : '') + x.model.padEnd(r.need ? 16 : 18)} ${(x.params + 'B').padStart(8)}  ${f1(p.rate).padStart(8)}  ${f1(x.edge.rate).padStart(8)}  ${f1(p.outTokensPerS).padStart(10)}  ${(p.dollarsPerMOut ? '$' + p.dollarsPerMOut.toFixed(2) : '–').padStart(8)}  ${L ? `${L.mode === 'agg' ? `${L.instances} × ${L.label}` : `P ${L.prefill.instances}×${L.prefill.label} / D ${L.decode.instances}×${L.decode.label}`}` : (p.why || '')}`);
    }
    say(`\nreq/s: production (15% headroom, an N+1 spare, 10% under the targets); edge: none of those. Spec-sheet efficiencies unless calibrated (fleetops calibrate).`);
    return;
  }
  if (cmd === 'capacity') {
    if (!opt('model') || !hw.gpu || (hw.nodes == null && hw.gpus == null)) throw new Error('fleetops serving capacity --model M --gpu G --nodes N (or --gpus N)');
    if (hw.nodes == null) delete hw.nodes;
    const c = FIT.capacity(opt('model'), hw, wl, tg, {});
    if (J) { OUT.capacity = Object.assign({}, c, { production: Object.assign({}, c.production, { usersAt: undefined }) }); return; }
    const p = c.production, L = p.layout;
    say(`${c.name} on ${c.gpus} ${c.gpu}; ISL ${Math.round(c.wl.isl)} / OSL ${Math.round(c.wl.osl)}; TTFT ≤ ${c.tg.ttftS}s, TPOT ≤ ${c.tg.tpotS * 1000}ms`);
    if (!p.rate) { say(`  doesn't fit: ${p.why}${c.edge.rate ? ` (without headroom and the spare it carries ${f1(c.edge.rate)} req/s)` : ''}`); return; }
    say(`  max load:        ${f1(p.rate)} req/s in production (${f1(c.edge.rate)} at the edge), ${f1(p.outTokensPerS)} output tokens/s`);
    say(`  users:           ~${f1(p.usersAt(20))} daily active users at 20 requests each, if the load were flat (peaks need more)`);
    say(`  concurrency:     ${L.concurrency} sequences in flight (${L.instances} instance(s) × ${Math.round(L.concurrency / L.instances)})`);
    say(`  layout:          ${L.mode === 'agg' ? `${L.instances} × ${L.label} (${L.gpusPerInstance} GPU(s) each)` : `prefill ${L.prefill.instances}×${L.prefill.label}, decode ${L.decode.instances}×${L.decode.label}`}, ${p.nodes} node(s) with the spare`);
    say(`  longest prompt:  ${c.maxPrompt ? `${c.maxPrompt.toLocaleString('en-US')} tokens at light load (model maximum ${c.modelMaxCtx.toLocaleString('en-US')})` : 'none fits'}`);
    if (p.dollarsPerMOut) say(`  cost:            $${p.dollarsPerMOut.toFixed(2)} per million output tokens at that load (catalog price)`);
    say(`  ${p.reason}`);
    return;
  }
  if (cmd === 'delete') {
    const name = o._[2], ns = opt('namespace') || 'serving', f = path.join(store.dir, 'serving', `${name}.yaml`);
    if (!name) throw new Error('fleetops serving delete NAME [--namespace serving] [--apply]');
    const argv = fs.existsSync(f) ? ['delete', '-f', f, '--ignore-not-found'] : ['-n', ns, 'delete', 'deployment,leaderworkerset,service,scaledobject', '-l', `app=${name}`, '--ignore-not-found'];
    const routerValues = path.join(store.dir, 'serving', `${name}.router.values.yaml`), helmArgv = fs.existsSync(routerValues) ? ['uninstall', name, '-n', ns] : null;
    if (!o.apply) { say(`would run: kubectl ${argv.join(' ')}${helmArgv ? `\n           helm ${helmArgv.join(' ')}  (the llm-d router)` : ''}\nadd --apply to delete`); return; }
    const r = Serving.kubectl(argv); if (r.code !== 0) throw new Error(r.err.trim());
    if (helmArgv) { const h = Serving.helmRun(helmArgv); if (h.code !== 0) say(`helm uninstall: ${h.err.trim()}`); else fs.rmSync(routerValues); }
    for (const reg of ['pools.json', 'targets.json']) { const p = path.join(store.dir, 'serving', reg); if (fs.existsSync(p)) { const x = JSON.parse(read(p)); delete x[name]; fs.writeFileSync(p, JSON.stringify(x, null, 1)); } }
    say(r.out.trim()); return;
  }
  if (cmd !== 'deploy') throw new Error(`unknown: serving ${cmd || ''} (models, gpus, fit, capacity, deploy, delete)`);
  const d = Serving.planDeployment({ model: opt('model'), gpu: opt('gpu'), nodes: hw.nodes, gpus: hw.gpus, gpusPerNode: hw.gpusPerNode, rate: wl.rate, isl: wl.isl, osl: wl.osl, islP99: wl.islP99, oslP99: wl.oslP99, ttftS: tg.ttftS, tpotS: tg.tpotS,
    name: opt('name'), namespace: opt('namespace'), image: opt('image'), hf: opt('hf'), hfSecret: opt('hf-secret'), cachePvc: opt('cache-pvc'), maxModelLen: num('max-model-len'), autoscale: !!o.autoscale, prometheus: opt('prometheus'),
    minReplicas: num('min-replicas'), maxReplicas: num('max-replicas'), createNamespace: !!o['create-namespace'], weights: opt('weights'), kvDtype: opt('kv-dtype'), mode: opt('mode'), routerVersion: opt('router-version'), sidecarImage: opt('sidecar-image'), gaieVersion: opt('gaie-version') });
  if (opt('out')) { fs.writeFileSync(opt('out'), d.yaml); if (d.router) fs.writeFileSync(opt('out').replace(/(\.ya?ml)?$/, '.router.values.yaml'), d.router.yaml); }
  if (!J) {
    say(`${d.name}: ${d.model} (${d.hf}) on ${d.gpu}, ${d.sized.basis}`);
    if (d.mode === 'disagg') say(`  disaggregated on llm-d: prefill ${d.layout.prefill.instances} × TP${d.layout.prefill.tp}, decode ${d.layout.decode.instances} × TP${d.layout.decode.tp} (max-num-seqs ${d.layout.decode.maxNumSeqs}) = ${d.layout.gpus} GPUs; max-model-len ${d.layout.maxModelLen}; TTFT ≤ ${d.targets.ttftS}s, TPOT ≤ ${d.targets.tpotS * 1000}ms\n  router: helm upgrade --install ${d.router.release} ${d.router.chart} --version ${d.router.version} -n ${d.namespace} -f <router values>`);
    else say(`  ${d.layout.instances} × TP${d.multiNode ? `${d.layout.gpusPerInstance / d.nodesPerInstance} × PP${d.nodesPerInstance} (LeaderWorkerSet, ${d.nodesPerInstance} nodes each)` : d.layout.tp + (d.layout.pp > 1 ? ` × PP${d.layout.pp}` : '')} = ${d.layout.gpus} GPUs; max-num-seqs ${d.layout.maxNumSeqs}, max-model-len ${d.layout.maxModelLen}; TTFT ≤ ${d.targets.ttftS}s, TPOT ≤ ${d.targets.tpotS * 1000}ms`);
    for (const n of d.notes) say(`  note: ${n}`);
    if (!o.apply && !opt('out')) say(`\n${d.yaml}${d.router ? `\n# llm-d router values (${d.router.chart})\n${d.router.yaml}` : ''}`);
    else if (opt('out')) say(`  wrote ${opt('out')}${d.router ? ` and ${opt('out').replace(/(\.ya?ml)?$/, '.router.values.yaml')}` : ''}`);
    if (d.prereqs && !o.apply) say(`  prerequisites (once per cluster; install-serving.sh --install-prereqs runs them):\n${d.prereqs.map(c => `    ${c.join(' ')}`).join('\n')}`);
  }
  const log = (s, x) => {
    if (J) return;
    if (s === 'preflight') for (const c of x.checks) say(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    else if (s === 'apply') say(`  applied${x.out ? `:\n    ${x.out.replace(/\n/g, '\n    ')}` : ''}`);
    else if (s === 'router') say(`  llm-d router ${x.code === 0 ? 'installed' : 'failed'}`);
    else if (s === 'wait') say(`  ${x.code === 0 ? 'ready' : 'not ready'}${x.out && x.out.includes('pods') ? `: ${x.out}` : ''}`);
    else if (s === 'smoke') say(x.ok ? `  smoke test: ${x.models.join(', ')} answered "${x.text}" (first response ${x.firstByteMs} ms)` : `  smoke test failed: ${x.error}`);
    else if (s === 'register') say(x.pools ? `  registered: ${x.pools} (tune and the agent see the pool)` : '');
  };
  const r = await Serving.deploy(d, { apply: !!o.apply, endpoint: opt('endpoint'), waitS: num('wait') || 2400, registerDir: path.join(store.dir, 'serving'), log });
  if (J) { OUT.deploy = Object.assign({ plan: Object.assign({}, d, { docs: undefined }) }, r); return; }
  if (r.dryRun) say(`\ndry run: nothing applied. Add --apply to deploy${r.steps[0].ready ? '' : ' (fix the failed checks first)'}.`);
  if (r.error) throw new Error(r.error);
  if (r.ok) say(`\n${d.name} is serving: kubectl -n ${d.namespace} port-forward svc/${d.service || d.name} 8000:${d.servicePort || 8000}, then the OpenAI API at http://127.0.0.1:8000/v1 (model "${d.model}")`);
}

function sdcCmd(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  const to = time(opt('to')) ?? Math.floor(Date.now() / 1000), from = time(opt('from')) ?? to - (opt('days') ? +opt('days') : 7) * 86400;
  const r = Sdc.findSdc(store, { from, to });
  if (J) { OUT.sdc = r; return; }
  process.stdout.write(Sdc.sdcMarkdown(r));
}

// ---------- live agent ----------
function agentOpts(store, o) {
  const opt = k => (o[k] && o[k] !== true ? o[k] : undefined), json = f => JSON.parse(read(f));
  const agent = Object.assign({}, opt('agent-config') ? json(opt('agent-config')) : {});
  if (opt('interval')) agent.intervalS = +opt('interval');
  if (opt('window')) agent.windowS = dur(opt('window')) ?? +opt('window');
  if (opt('targets')) agent.targets = json(opt('targets'));
  if (opt('min-failures')) agent.minFailures = +opt('min-failures');
  if (opt('page-to')) agent.page = { to: opt('page-to'), key: opt('page-key') || process.env.PAGERDUTY_ROUTING_KEY || process.env.OPSGENIE_API_KEY, url: opt('page-url'), minSeverity: opt('page-min-severity') || 'sev2' };
  const stateDir = opt('state') || path.join(store.dir, 'agent');
  const ghConfig = opt('config') ? json(opt('config')) : undefined;
  // pull from the fleet's own monitoring before each tick, from where the last pull stopped
  let pulledTo = null;
  const before = opt('prom') || opt('loki') ? async now => {
    const from = pulledTo ?? now - (agent.deviceWindowS || Agent.AGENT_DEFAULTS.deviceWindowS);
    if (opt('prom')) await Pull.pullPrometheus(store, opt('prom'), { from, to: now, step: opt('step') ? +opt('step') : 30, headers: hdrs(o) });
    if (opt('loki')) await Pull.pullLoki(store, opt('loki'), lokiQueries(o), { from, to: now, headers: hdrs(o) });
    pulledTo = now;
  } : null;
  return { stateDir, ghConfig, agent, live: !!o.live, before };
}
function agentLine(r) {
  const acts = r.executed.map(e => `${e.kind}:${e.outcome}`).join(', ');
  return `${new Date(r.t * 1000).toISOString()} agent${r.paused ? ' (paused)' : ''}${r.devices ? ` · ${Object.entries(r.devices.states).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''} · ${r.incidents.length} incident(s)${r.incidents.map(i => `\n  ${i.id}: ${i.rule || 'no cause'} (${i.confidence}) → ${i.decision}${i.actions.length ? ' [' + i.actions.map(a => `${a.kind} ${a.mode}`).join(', ') + ']' : ''}`).join('')}${acts ? `\n  ran: ${acts}` : ''}${r.verified.map(v => `\n  verified ${v.id}: ${v.outcome}`).join('')}`;
}
async function agentCmd(store, cmd, o) {
  const ao = agentOpts(store, o), opt = k => (o[k] && o[k] !== true ? o[k] : undefined);
  if (cmd === 'pause' || cmd === 'resume') { if (!opt('by')) throw new Error(`agent ${cmd} --by NAME`); Agent.setPaused(ao.stateDir, cmd === 'pause', opt('by')); if (J) OUT.paused = cmd === 'pause'; else say(`agent ${cmd === 'pause' ? 'paused' : 'resumed'} by ${opt('by')}`); return; }
  if (cmd === 'status') {
    const v = LiveView.liveView(store, ao.stateDir, { agent: ao.agent, ghConfig: ao.ghConfig });
    if (J) { OUT.status = { agent: v.agent, fleet: v.fleet.states, incidents: v.incidents, waiting: v.actions.open.filter(a => a.status === 'proposed') }; return; }
    say(`agent ${v.agent.paused ? 'PAUSED' : v.agent.lastTick ? `last ran ${new Date(v.agent.lastTick * 1000).toISOString()}` : 'has not run'}${v.agent.live ? ' (live)' : ' (dry run)'} · autonomous actions in the last hour ${v.agent.autoLastHour}/${v.agent.autoLimit}`);
    say(`GPUs: ${Object.entries(v.fleet.states).map(([k, n]) => `${k} ${n}`).join(', ') || 'no telemetry'}`);
    for (const i of v.incidents) say(`  ${i.severity} ${i.status.padEnd(12)} ${i.id}: ${i.title || 'no cause'} → ${i.decision || '–'}${i.verified ? ` (${i.verified.outcome})` : ''}`);
    for (const a of v.actions.open.filter(a => a.status === 'proposed')) say(`  waiting: ${a.id}  ${a.reason.slice(0, 140)}`);
    return;
  }
  if (cmd === 'log') { const d = Agent.decisions(ao.stateDir, o.limit ? +o.limit : 50); if (J) { OUT.log = d; return; } for (const e of d.reverse()) say(`${new Date(e.t * 1000).toISOString()} ${e.decision}${e.incident ? ' ' + e.incident : ''}${e.action ? ' ' + e.action : ''}${e.outcome ? ' → ' + e.outcome : ''}${e.title ? ': ' + e.title : ''}${e.note ? ': ' + e.note : ''}`); return; }
  if (cmd === 'approve' || cmd === 'reject') {
    const { Store: Q } = await import('../../gpu-health/src/actions.mjs');
    const id = o._[2]; if (!id || !opt('by')) throw new Error(`agent ${cmd} ID --by NAME`);
    const q = new Q(ao.stateDir), a = cmd === 'approve' ? q.approve(id, opt('by')) : q.reject(id, opt('by'), opt('reason') || '');
    fs.appendFileSync(path.join(ao.stateDir, 'agent.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), decision: cmd === 'approve' ? 'approved' : 'rejected', action: a.id, kind: a.kind, by: opt('by'), incident: a.incident }) + '\n');
    if (J) OUT[cmd + 'd'] = a; else say(`${a.id} ${a.status} by ${opt('by')}; it runs on the agent's next tick`);
    return;
  }
  if (cmd && cmd !== 'run') throw new Error(`unknown: agent ${cmd}`);
  if (o.once) {
    if (ao.before) await ao.before(Math.floor(Date.now() / 1000));
    const r = await Agent.tick(store, Object.assign({}, ao, { now: o.now && o.now !== true ? time(o.now) : undefined }));
    if (J) { OUT.tick = r; return; }
    say(agentLine(r)); return;
  }
  if (o.live) console.log('note: --live runs actions only when the gpu-health policy has dryRun: false (--config)');
  Agent.start(store, ao, { onTick: r => console.log(agentLine(r)), before: ao.before });
  const stop = () => { if (store.close) store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

async function serve(store, o) {
  const port = o.port ? +o.port : 9400, host = o.host && o.host !== true ? o.host : '127.0.0.1';
  const tokens = o.tokens && o.tokens !== true ? Sec.loadTokens(o.tokens) : null;
  // listening beyond this machine without tokens would expose every tenant's data: refuse unless asked for explicitly
  if (!tokens && !['127.0.0.1', 'localhost', '::1'].includes(host) && !o['no-auth']) throw new Error(`--host ${host} needs --tokens FILE (or --no-auth to run open on a trusted network)`);
  const pipe = new Ingest.Pipeline(store, { maxQueue: o['max-queue'] ? +o['max-queue'] : 200000, flushMs: o['flush-ms'] ? +o['flush-ms'] : 1000 }).start();
  let extra = null, page = null, agentRun = null;
  // POST /v1/bundle (role ingest): a trace bundle, imported as `data import bundle` would
  const bundleRoute = async (req, res, who, send) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/bundle') return false;
    if (!Sec.can(who, 'ingest')) { send(res, 403, 'needs the ingest role\n'); return true; }
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > Bundle.MAX_FILE) { send(res, 413, 'bundle too large: import it with fleetops data import bundle\n'); return true; } chunks.push(c); }
    const f = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'fleetops-up-')), 'bundle.tgz');
    try { fs.writeFileSync(f, Buffer.concat(chunks)); const r = await importBundle(store, f, {}); send(res, 200, JSON.stringify({ totals: r.totals, files: r.files.map(x => ({ path: x.path, source: x.source, error: x.error, skipped: x.skipped })) }), 'application/json'); }
    catch (e) { send(res, 400, `${e.message}\n`); }
    finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
    return true;
  };
  extra = bundleRoute;
  if (o.agent) {
    const ao = agentOpts(store, o);
    const live = LiveView.liveRoutes({ store, stateDir: ao.stateDir, agent: ao.agent, ghConfig: ao.ghConfig, audit: Sec.auditor(store.dir) }); page = LiveView.LIVE_HTML;
    extra = async (req, res, who, send) => (await bundleRoute(req, res, who, send)) || live(req, res, who, send);
    agentRun = Agent.start(store, ao, { onTick: r => console.log(agentLine(r)), before: ao.before });
  }
  const srv = Ingest.server(pipe, { site: o.site && o.site !== true ? o.site : undefined, tokens, audit: Sec.auditor(store.dir), extra, page });
  await new Promise(r => srv.listen(port, host, r));
  console.log(`fleetops on http://${host}:${port}  store ${store.dir}  ${tokens ? `${tokens.length} token(s)` : 'open (no tokens)'}${process.env.FLEETOPS_EGRESS_ALLOW != null ? `  egress: ${process.env.FLEETOPS_EGRESS_ALLOW || 'none'}` : ''}\n  POST /api/v1/write /v1/metrics /v1/logs /v1/traces /v1/bundle   GET /api/summary /api/query /api/series /api/incidents /api/diagnose /metrics /healthz${o.agent ? `\n  agent every ${agentOpts(store, o).agent.intervalS ?? Agent.AGENT_DEFAULTS.intervalS} s${o.live ? ' (live: still needs policy.dryRun false)' : ' (dry run)'}; dashboard http://${host}:${port}/live` : ''}`);
  const stop = () => { if (agentRun) agentRun.stop(); srv.close(); pipe.stop(); if (store.close) store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const self = fileURLToPath(import.meta.url);
// realpath: npm installs bins as symlinks, so argv[1] is the link, not this file
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(self)) {
  main().then(() => { if (J && Object.keys(OUT).length) console.log(JSON.stringify(OUT, null, 1)); })
    .catch(e => { if (J) console.log(JSON.stringify({ error: e.message })); else console.error('error: ' + e.message); process.exit(1); });
}
