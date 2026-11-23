# Root-cause analysis

`fleetops rca` turns a symptom into ranked hypotheses. Each hypothesis carries the records it rests on, what argues against it, and the steps that would confirm it.

```bash
node tools/fleetops.mjs rca detect --from 2026-11-20 --diagnose --format md      # find incidents and diagnose each
node tools/fleetops.mjs rca diagnose --symptom latency --pool chat-h200 --from 2026-11-23T14:00Z --to 2026-11-23T16:00Z
node tools/fleetops.mjs rca eval --labels incidents.jsonl                          # top-1 / top-3 on labeled incidents
```

## How it works

**Detection.**
- **Job failures:** an hour is flagged when its failed-job count is at least `--min-failures` (default 50) and `--ratio` (default 4) times the trailing day's hourly median. Adjacent flagged hours merge into one incident.
- **Serving latency:** TTFT or TPOT p99 above a target from `--targets` (`{ "chat": { "ttftP99": 1.0 } }`), or 1.5× its trailing median when there is no target.

**Rules.** Every rule looks at the same window of the store. Each one that finds support returns a hypothesis with a score from 0 to 1.

| Rule | Looks for | Typical cause |
|---|---|---|
| `workload` | one owner or namespace holds most failures while the rest of the fleet runs normally; checks the telemetry of the nodes those jobs ran on | the application |
| `hardware` | failures piled on a few nodes, plus health events, fault codes or offline minutes on those devices | a device or node |
| `change` | a change in scope up to 6 h before onset; closer and riskier kinds (driver, firmware, deploy) score higher | the change |
| `infrastructure` | many owners and many nodes failing at once while devices look healthy | storage, network, scheduler, registry |
| `kv-pressure` | KV-cache use ≥ 85% during a latency regression, with preemptions and queue growth | capacity per replica |
| `load` | request rate ≥ 1.2× its baseline, or longer prompts | capacity |
| `monitoring-gap` | far fewer devices reporting than the day before | the monitoring |

**Output.** Hypotheses are ranked by score.
- **Confidence:** high when the top score is at least 0.75 and leads the next by at least 0.15; medium from 0.5.
- **Ruled out:** the result lists the rules that found nothing, so "not the hardware" is stated, not implied.
- **Narrative:** written only from the top hypothesis' evidence. An LLM can rephrase it, but it is given only that evidence.
- **Storage:** each diagnosis is stored as an `incident` record.

**Accuracy.** `rca eval` runs the diagnosis on labeled incidents (`{ "incident": { "symptom", "from", "to", "pool"? }, "cause": "<rule>" }`) and reports top-1 and top-3. Start labeling from postmortems now; the tests use one synthetic incident per rule, and each rule ranks first on its own.

## On real data: Microsoft Philly, 8–14 November 2017

`rca detect --diagnose` on the week loaded by `fetch-public-data.sh` finds six failure spikes, each 15–75× the trailing hourly median. All six get the same diagnosis, with high confidence:

| Incident (UTC hour) | Failed or retried jobs | Top hypothesis | Nodes | Other namespaces' failure rate (window vs day before) |
|---|---|---|---|---|
| 11-09 02:00 | 473 | namespace 6214e9 owns 92% | 107 | 5% vs 9% |
| 11-10 00:00 | 639 | 6214e9 owns 97% | 97 | 5% vs 10% |
| 11-10 13:00 | 904 | 6214e9 owns 96% | 101 | 16% vs 13% |
| 11-11 05:00 | 1,683 | 6214e9 owns 98% | 117 | 17% vs 14% |
| 11-13 13:00 | 1,627 | 6214e9 owns 98% | 153 | 17% vs 25% |
| 11-14 09:00 | 651 | 6214e9 owns 94% | 106 | 35% vs 28% |

- **The jobs:** short runs (median 10–14 minutes) failing and being retried across 100–150 machines.
- **The rest of the fleet:** failing at about its usual rate.
- **The hardware:** GPU telemetry on the 20–27 of those machines in the loaded subset shows no offline GPUs, and utilization holds steady through the spikes.
- **Ruled out:** hardware, change (the trace has no change feed), infrastructure, monitoring gap.

The trace has no exit codes or logs, so the first verification step (read a few failed jobs' errors) can't be run here. The diagnosis says what the evidence supports: an application-level retry storm from one tenant, not a fleet fault.
