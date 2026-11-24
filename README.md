# AIInfraTools

Tools that help capacity building in AIInfra. Each tool lives in its own folder with its own README.

| Tool | What it is |
| --- | --- |
| [fleetscope](fleetscope/) | Node editor for replaying LLM traffic on a modelled hybrid (on-prem + neocloud) GPU fleet |
| [inference-sizer](inference-sizer/) | How many GPUs, in what layout, serve a model at TTFT/TPOT targets; exports to FleetScope |
| [gpu-health](gpu-health/) | Health checks, utilization and savings for GPU fleets, with suggested fixes that run once approved |
| [hybrid-tracing](hybrid-tracing/) | One trace view across on-prem and neocloud: shared clock reference (PTP/chrony), collector tiers, and clock-skew correction for traces |
| [fleetops](fleetops/) | The shared data layer under the tools: one store of device telemetry, inventory, jobs, serving metrics and changes, with adapters for exporters, Kubernetes, Slurm, change feeds and public traces. On top of it: root-cause analysis, incidents, and a live agent and dashboard that mitigate training and inference issues in real time within approval guardrails |

Where this is going, from four utilities to one Observe → Diagnose → Simulate → Approve → Optimize → Verify loop: [ROADMAP.md](ROADMAP.md).

## Use with LLMs (skills)

Each tool is also packaged as an [Agent Skill](https://agentskills.io/specification) in [skills/](skills/). A skill tells a model when to use the tool, what to ask the user, which command to run and how to read the JSON it returns. A model can then answer questions like "how many H200s for Llama 70B at 25 ms TPOT?", "what if the cloud link drops to 25 Gbps?", "why do our cross-site traces look out of order?" "which GPUs should we pull before they fail?" or "why did half the training jobs fail last night?" by running the tools itself.

| Skill | Wraps |
| --- | --- |
| [inference-sizer](skills/inference-sizer/SKILL.md) | GPU count, layout and cost for TTFT/TPOT targets; compares GPUs |
| [fleetscope](skills/fleetscope/SKILL.md) | Stress suite, plain-English what-ifs and scenario diffs on a hybrid fleet |
| [hybrid-tracing](skills/hybrid-tracing/SKILL.md) | Clock-skew correction for traces, clock checks, and collector, chrony and PTP configs |
| [gpu-health](skills/gpu-health/SKILL.md) | Health, efficiency and savings analysis, with an approval queue the model may not approve on its own |
| [fleetops](skills/fleetops/SKILL.md) | Root-cause analysis of job failures, latency and training slowdowns; a live agent that mitigates within approval guardrails, with a live dashboard; incidents, postmortems, accuracy backtests and game days; installers |

**Claude Code.** The repo is a plugin marketplace:

```
/plugin marketplace add hardikashah-eng/AIInfraTools
/plugin install aiinfra-tools@aiinfra-tools
```

On Claude Code 2.1.275 or later, this one step does both: `/plugin install aiinfra-tools --marketplace hardikashah-eng/AIInfraTools`.

**Claude apps.** Run `node scripts/build-skills.mjs --zip dist/skills`, or download the `skills` artifact from the Skills CI run. Then upload a zip as a custom skill in Claude's settings. Each zip is self-contained.

**Other agents.** Any agent that reads Agent Skills can use the skill folders as they are: copy them into its skills directory. For an agent without skill support, every command the skills use takes `--json` and returns one JSON object, so you can wrap each one as a function tool.

All skills need Node.js 20+ and nothing else.

**Changing a tool.** The skill folders carry copies of the tools' code (`scripts/`), docs (`references/`) and examples (`assets/`), so each folder works on its own. After editing a tool, run `node scripts/build-skills.mjs`. CI fails while the copies are out of date. `node --test scripts/test-skills.mjs` runs each skill's documented commands from an isolated copy.

## Workload Intelligence

FleetOps now includes a [workload profiler](fleetops/docs/WORKLOADS.md) with six synthetic application profiles (coding agents, chat, report generation, RAG search, deep research and autocomplete). It can inspect existing request logs or FleetOps request records, report workload fingerprints and export privacy-conscious session replay CSVs compatible with FleetScope.

```bash
node fleetops/tools/workload-profile.mjs list
node fleetops/tools/workload-profile.mjs synth --type coding-agent --sessions 100 --out agent.csv
node fleetops/tools/workload-profile.mjs inspect --input gateway.jsonl --type coding-agent --out profile.json --csv replay.csv
```
