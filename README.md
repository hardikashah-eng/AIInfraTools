# AIInfraTools

Tools that help capacity building in AIInfra. Each tool lives in its own folder with its own README.

| Tool | What it is |
| --- | --- |
| [fleetscope](fleetscope/) | Node-editor prototype for replaying LLM traffic on a modelled hybrid (on-prem + neocloud) GPU fleet |
| [inference-sizer](inference-sizer/) | How many GPUs, in what layout, serve a model at TTFT/TPOT targets; exports to FleetScope |
| [hybrid-tracing](hybrid-tracing/) | One trace view across on-prem and neocloud: shared clock reference (PTP/chrony), collector tiers, and clock-skew correction for traces |
