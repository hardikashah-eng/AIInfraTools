# Incidents as a workflow

Milestone 9 of the [roadmap](../../ROADMAP.md). A diagnosis is the start of an incident, not the end of it.
`fleetops incidents` takes it through its life, records who did what, drafts the postmortem, and feeds the confirmed
cause back to the benchmark.

```
fleetops incidents open --from T --to T             # detect, diagnose, open the new ones (sev from the symptom's size)
fleetops incidents ack ID --by ana
fleetops incidents page ID --to pagerduty --action trigger            # dry run; --live sends
fleetops incidents mitigate ID --by ana --note "drained node-03"
fleetops incidents resolve ID --by ana --cause hardware --component node-03
fleetops incidents postmortem ID --out pm.md
fleetops incidents timeline ID --out timeline.html
fleetops rca bench --from-incidents                  # root-cause accuracy on confirmed causes
```

## Lifecycle

- **States:** open → acknowledged → mitigated → resolved. A mitigated incident can go back to acknowledged; a
  resolved one can be reopened, which clears its confirmed cause.
- **Any time:** `assign --owner`, `severity --severity sev1..sev4`, `note`.
- **Only legal transitions are accepted,** and every event names who did it (`--by`).
- **Storage:** an append-only log of `incident_event` records. An incident's state is the fold of its events, and its
  diagnosis is the `incident` record with the same id.
- **Severity at open:**
  - job failures: ≥ 500 is sev1, ≥ 100 sev2, otherwise sev3;
  - latency: ≥ 3× the target or baseline is sev1, ≥ 1.5× sev2, otherwise sev3;
  - training hangs: sev2.

## Paging and tickets

| `--to` | Request |
|---|---|
| `pagerduty` | Events API v2 (`/v2/enqueue`), `dedup_key` = incident id, severity from sev; key in `--key` or `PAGERDUTY_ROUTING_KEY` |
| `opsgenie` | Alert API: create with `alias` = incident id, then acknowledge / close by alias; `GenieKey` from `--key` or `OPSGENIE_API_KEY` |
| `webhook` | `--url`: a JSON body with the incident and its diagnosis, for a ticket system or chat bridge |

- **Without `--live`, nothing is sent.** The command prints the request it would send, with the key hidden.
- **A live page is recorded** as a `paged` event with the HTTP status.

## Timeline

`incidents timeline ID --out FILE.html` writes a self-contained page with one time axis:
- the symptom (failed jobs per 5 minutes, or the pool's latency);
- changes;
- log faults (▲ hard, ● soft);
- device health events;
- injected faults;
- the lifecycle;
- the ranked causes with their evidence.

Every mark has its details on hover. The page follows the light and dark theme of the browser.

## Postmortem

`incidents postmortem ID` drafts Markdown:
- **From the store:** severity, owner, window, duration to resolution, impact (failed jobs and GPU-hours, or peak
  latency), the cause, the evidence, the other hypotheses, a timeline (onset, changes, hard faults, lifecycle) and
  action items from the verification steps.
- **The cause section** says whether root-cause analysis ranked the confirmed cause first, or where it ranked it.
- **Summary, what went well, what went wrong and prevention** are marked _To write._ because a person has to write
  them.

## Feedback

- `resolve --cause RULE [--component X]` stores the confirmed cause.
- `rca bench --from-incidents` scores root-cause analysis on every resolved incident with a confirmed cause, the same
  way as injected and postmortem labels. `--fit` can fit rule weights on them.

## Done-when, checked

`tests/incidents.test.mjs` runs it entirely through the CLI:
1. An XID is injected on a test node (fake runner) and its failures and log line reach the store.
2. `incidents open` detects and diagnoses it, naming node-03.
3. It is acknowledged, paged (dry run), mitigated and resolved with cause `hardware` / `node-03`.
4. The postmortem says root-cause analysis ranked the confirmed cause first.
5. The timeline shows the injection.
6. `rca bench --from-incidents` scores it: top-1 100%.
