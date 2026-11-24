# FleetScope node types

Generated from `fleetscope/src/templates.js`. A graph is `{ "nodes": [{ "id", "type", "x", "y", "cfg": {…} }], "edges": [{ "from", "to" }] }`; the defaults below are what a new node of each type gets. Edit `cfg` fields; keep ids and edges unless adding nodes.

## `agent`: Coding agents

Group: Traffic. Inputs: none. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Coding agents"` |
| `users` | `60` |
| `turns` | `12` |
| `systemTokens` | `6000` |
| `contextTokens` | `30000` |
| `turnTokens` | `2500` |
| `outTokens` | `350` |
| `thinkS` | `4` |
| `gapS` | `30` |
| `prefixHit` | `85` |
| `durationMin` | `10` |
| `dataClass` | `"internal"` |
| `owner` | `""` |
| `oncall` | `""` |

## `chat`: Chat users

Group: Traffic. Inputs: none. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Chat users"` |
| `users` | `400` |
| `turns` | `6` |
| `systemTokens` | `800` |
| `contextTokens` | `0` |
| `turnTokens` | `300` |
| `outTokens` | `300` |
| `thinkS` | `20` |
| `gapS` | `60` |
| `prefixHit` | `50` |
| `durationMin` | `10` |
| `dataClass` | `"internal"` |
| `owner` | `""` |
| `oncall` | `""` |

## `trace`: Trace replay

Group: Traffic. Inputs: none. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Trace replay"` |
| `trace` | `"chat"` |
| `scale` | `1` |
| `prefixHit` | `0` |
| `useRecordedCache` | `true` |
| `replay` | `"timestamps"` |
| `onFail` | `"retry"` |
| `dataClass` | `"internal"` |
| `owner` | `""` |
| `oncall` | `""` |

## `router`: Router

Group: Routing. Inputs: yes. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Router"` |
| `policy` | `"primary-first"` |
| `burstWait` | `1.5` |
| `affinity` | `"ideal"` |
| `enforceResidency` | `false` |
| `owner` | `""` |
| `oncall` | `""` |

## `pool`: GPU pool

Group: Compute. Inputs: yes. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"On-prem pool"` |
| `site` | `"On-prem DC"` |
| `siteKind` | `"onprem"` |
| `role` | `"agg"` |
| `gpu` | `"H100"` |
| `tp` | `0` |
| `instances` | `4` |
| `autoscale` | `false` |
| `min` | `0` |
| `max` | `8` |
| `coldStart` | `90` |
| `upWait` | `1` |
| `downUtil` | `30` |
| `maxBatch` | `256` |
| `fabricGbps` | `400` |
| `zone` | `"auto"` |
| `owner` | `""` |
| `oncall` | `""` |
| `calibPrefill` | `1` |
| `calibDecode` | `1` |
| `clusterWorkload` | `""` |
| `clusterAtH` | `0` |
| `offloadGB` | `0` |
| `offloadGBs` | `50` |
| `loraAdapters` | `0` |
| `loraSlots` | `8` |
| `powerCapPct` | `100` |

## `link`: Cross-site link

Group: Network. Inputs: yes. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Cloud link"` |
| `gbps` | `100` |
| `rttMs` | `20` |
| `egressPerGB` | `0.05` |
| `encrypted` | `true` |
| `owner` | `""` |
| `oncall` | `""` |

## `train`: Training job

Group: Compute. Inputs: none. Outputs: yes.

| Field | Default |
|---|---|
| `name` | `"Training job"` |
| `model` | `"llama-70b"` |
| `gpus` | `256` |
| `gpu` | `"H100"` |
| `site` | `"On-prem DC"` |
| `siteKind` | `"onprem"` |
| `tokensPerStepM` | `4` |
| `mfu` | `40` |
| `overlap` | `true` |
| `horizonMin` | `10` |
| `owner` | `""` |
| `oncall` | `""` |

## `model`: Model

Group: Settings. Inputs: none. Outputs: none.

| Field | Default |
|---|---|
| `name` | `"Model"` |
| `key` | `"llama-70b"` |
| `wPrec` | `"fp8"` |
| `kvPrec` | `"fp8"` |
| `thinkTokens` | `0` |
| `thinkKeep` | `false` |
| `specK` | `0` |
| `specAccept` | `0.7` |
| `label` | `"Llama 3.3 70B"` |
| `params` | `70.6` |
| `active` | `70.6` |
| `layers` | `80` |
| `kvHeads` | `8` |
| `headDim` | `128` |
| `mla` | `0` |

## `slo`: SLO targets

Group: Settings. Inputs: none. Outputs: none.

| Field | Default |
|---|---|
| `name` | `"SLO targets"` |
| `ttft` | `2` |
| `tpotMs` | `60` |
| `thinkingStreamed` | `false` |
| `confidentialIn` | `"private"` |
| `internalIn` | `"any"` |
| `requireEncryption` | `true` |

## Templates

| id | name | what it shows |
|---|---|---|
| `burst` | Hybrid chat burst | A spike outruns a 90 s cold start |
| `agent` | Coding agent fleet | 60 agents, 30k-token contexts, 85% cache hits |
| `xpd` | Cross-site P/D split | Every KV cache crosses a 100 Gbps link |
| `train` | Training shares the link | A 256-GPU job split across sites |
| `disagg` | On-prem disaggregated | Prefill and decode pools in one site |
| `multi` | Two neoclouds | Least-wait routing over two links |
| `replay` | Replay an agent log | Recorded sessions, replayed closed loop |
| `blank` | Blank canvas | Model and SLO nodes only |
