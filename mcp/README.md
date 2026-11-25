# AIInfraTools as an MCP server

Every tool as [Model Context Protocol](https://modelcontextprotocol.io) tools, for any MCP client: Claude Code,
Claude Desktop, Cursor, VS Code, your own agents. Node.js 22+, no dependencies, stdio transport.

## Add it

**Claude Code**

```bash
claude mcp add aiinfra -- npx -y aiinfra-tools mcp
```

**Claude Desktop, Cursor and others** (the client's MCP config file):

```json
{
  "mcpServers": {
    "aiinfra": { "command": "npx", "args": ["-y", "aiinfra-tools", "mcp"] }
  }
}
```

From a clone instead of npm: `"command": "node", "args": ["/path/to/AIInfraTools/mcp/server.mjs"]`.

## Tools

| Tool | What it answers | Output schema |
| --- | --- | --- |
| `list_catalog` | GPU and model ids the sizer knows | `sizer.list` |
| `size_inference` | GPUs and layout to serve a model at TTFT/TPOT targets; or several GPUs ranked | `sizer.plan` / `sizer.compare` |
| `what_fits` | every model that fits on given GPUs, and the load each carries | `fleetops.serving.fit` |
| `model_capacity` | the most load one model carries on given GPUs | `fleetops.serving.capacity` |
| `fleetscope_templates` · `fleetscope_run` · `fleetscope_ask` | simulate a hybrid fleet; plain-English what-ifs | `fleetscope.*` |
| `gpu_health_analyze` | health problems, idle and underused GPUs, savings; proposals into the approval queue | `gpu-health.analyze` |
| `ledger_report` · `ledger_insights` | GPU-hours and cost by owner (useful, idle, lost); ranked savings | `ledger.*` |
| `harness_waste` | where agent harnesses (Claude Code, Codex, OTel, Langfuse) waste tokens and money, by cause, tool and session | – |
| `rca_detect` · `rca_diagnose` | incidents in a window; ranked root causes with evidence | `fleetops.rca.diagnose` |
| `power_report` · `power_plan` | power against budget; a plan of GPU power caps | `fleetops.power.*` |
| `fix_trace_skew` | clock offsets and ordering violations in OTLP traces | `fix-skew.demo` |

Where a tool has an output schema ([../schemas](../schemas/README.md)), it declares it as `outputSchema` and returns
the result as `structuredContent` too.

## What it won't do

This server reads, simulates and plans. Nothing it exposes changes a cluster, pages anyone or approves an action:
no tool takes `--live`, `--apply`, `approve` or `execute`, and the server refuses any argument that would smuggle one
in. Proposals (gpu-health actions, power plans) wait for a person to approve and apply them outside the model's reach,
as described in [SECURITY.md](../SECURITY.md).
