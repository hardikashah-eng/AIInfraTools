// fleetops CLI: help (see ../fleetops.mjs for the entry point and dispatch)

export const HELP = `fleetops — shared data layer for AIInfraTools

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
  nvsentinel       NVSentinel health events: event-exporter CloudEvents, datastore documents, kubectl get healtheventresources -o json
                   GPU faults (XIDs through gpu-health's table), what NVSentinel recommends and whether it is remediating
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
        [--duration S] [--max-isl N --max-osl N] [--max-inflight 64] [--api-key-env VAR] [--out results.jsonl] [--live]
        the same requests to both endpoints at the same moments (dry run unless --live); results go to the store
  fleetops shadow answers --baseline URL --candidate URL [--prompts FILE] [--model M] [--live] --out answers.json
        greedy decoding on both: identical tokens, first divergence, log-probability drift
  fleetops shadow compare --results FILE | --baseline SEL --candidate SEL [--from T --to T]
        [--plan plan.json] [--answers answers.json] [--baseline-gpus N --baseline-rate R --candidate-gpus N --candidate-rate R]
        [--baseline-nodes RE --candidate-nodes RE] [--gates gates.json]     matched-load verdict: promote, roll back, extend
        with --plan: a prediction off by more than 15% refits the candidate's sizer efficiencies into
        <store>/calibration/sizer.json (--calibration F; --no-recalibrate to skip), which plan, inference-sizer --calibration
        and harness-ledger economics --calibration read; a promoted change is recorded in <store>/shadow/promoted.jsonl
  fleetops shadow baseline save --name NAME --select SEL [--from T --to T]  ·  fleetops shadow baseline list
  fleetops shadow watch --name NAME --select SEL [--from T --to T]          drift of a service against its saved baseline
  fleetops shadow demo                                         a candidate that looks faster and isn't
  SEL: field=value or field~regex, comma-separated (variant=candidate, replica~vllm-new, pool=chat)
  From a canary's own metrics (vLLM in Prometheus: llm-d controlled deployments, Argo Rollouts, Flagger):
  fleetops shadow prom --prom URL --baseline 'M' --candidate 'M' [--select 'M'] [--lookback 3600 | --from T --to T]
        [--baseline-lookback S] [--step 60] [--prom-token-env VAR] [--save FILE] [--gates g.json]
        | --file saved.json | --demo      per-version windows judged at matched load (load per engine, prompt, cache)
  fleetops shadow serve --prom URL [--select 'M' --baseline 'M' --candidate 'M'] [--lookback 900] [--baseline-lookback 21600]
        [--port 9410] [--host H --tokens FILE | --no-auth]   the judge for Argo Rollouts (POST /verdict) and Flagger
        (POST /flagger/rollout, /flagger/confirm-promotion); deploy/shadow-gate/ has the manifests
  M: Prometheus label matchers, e.g. llm_isvc_name="chat-v2" or rollouts_pod_template_hash="6b9f",namespace="llm"
  An llm-d canary (two LLMInferenceServices in one routing group) stepped by the judge:
  fleetops shadow canary start --name N --namespace NS --group G --baseline ISVC --candidate ISVC [--steps 1,5,25,50,100]
        [--bake 600] [--live]                           the first weights (printed, or written with --live)
  fleetops shadow canary advance --name N --prom URL | --judge URL [--live]   rollback → weight 0 at once (with --live);
        promote → the next step is queued for a person; it is written by the next advance --live after approval
  fleetops shadow canary approve --name N --by NAME     a person approves the queued step   ·   canary status --name N

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
