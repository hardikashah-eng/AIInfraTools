# Workload Intelligence (first increment)

Profile application-shaped inference demand and replay representative sessions through FleetScope. This module **does not** estimate GPU capacity itself; it generates requests and measurements that existing capacity tools can consume. Requires Node.js 22+.

## Try the six synthetic presets

From the repository root:

    node fleetops/tools/workload-profile.mjs list
    node fleetops/tools/workload-profile.mjs synth --type coding-agent --sessions 100 --seed 7 --out /tmp/agent.csv --summary /tmp/agent-profile.json
    node fleetops/tools/workload-profile.mjs synth --type chat --sessions 100 --out /tmp/chat.csv
    node fleetops/tools/workload-profile.mjs synth --type report-generation --sessions 100 --out /tmp/reports.csv

Available: coding-agent, chat, report-generation, rag-search, deep-research, autocomplete.

Open FleetScope dist/index.html, select a Trace replay node, load the CSV and choose **Sessions (closed loop)**. FleetScope uses each session's recorded end-to-end time to compute its inter-turn wait. Profiles are **synthetic starting points** and are not production GPU benchmarks or measured industry averages.

## Build a profile from actual request logs

    node fleetops/tools/workload-profile.mjs inspect --input gateway.jsonl --type coding-agent --out profile.json --csv replay.csv

The tool reuses FleetScope's importer for gateway JSONL/JSON arrays (OpenAI, Anthropic, LiteLLM), vLLM OTLP, Jaeger and canonical CSV. The original trace importer reports malformed and unusable rows. An optional stored-data path uses FleetOps' existing request records:

    node fleetops/tools/workload-profile.mjs inspect --store /var/lib/fleet-data --pool chat-h200 --from 1790000000 --to 1790086400 --out profile.json --csv replay.csv

The profiler measures prompt/output token distributions, actual cache-token coverage and ratio, TTFT and end-to-end distributions, per-session turn counts, observed idle gaps and peak arrivals/minute. **Application classification is explicit** via --type; token counts alone cannot reliably classify a coding agent versus a chat request.

## Data protection and assumptions

- Never requires prompt/response contents. Canonical replay CSV carries only timing, counts and pseudonymous session identifiers; labels are generated per export, not linkable across exports.
- Cached tokens missing from source traces are **unknown**, not cache misses. Report cache metric coverage separately.
- Tool-call time, human think time and model-switch effects are not independently observable without harness spans. Observed idle gaps can contain any of these. No fabricated tool-call metrics are reported.
- For sampled traces, scale arrival rates externally using the known sampling fraction. The profile does not attempt to infer sampling.
- A profile is a workload demand fingerprint, **not a latency prediction or SLO guarantee**. Validate on actual serving stacks, and use calibrated FleetScope/Inference Sizer for predictions.
- CSV round trips through FleetScope's existing trace importer; generated arrivals contain session dependencies and deterministic seeded variation.

## Next integrations

Connect session-level tool spans and model transitions; capture true cache lifecycle and retention; add named workload mixtures to FleetScope scenarios; compare routing strategies and cost per completed task. Those features are not claimed by this increment.
