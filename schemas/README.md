# Output schemas

Every tool takes `--json`. These JSON Schemas (draft 2020-12) describe that output for the commands agents, dashboards
and scripts rely on, so you can build on them and know when they change.

| Schema | Command |
| --- | --- |
| `sizer.list` · `sizer.plan` · `sizer.compare` | `aiinfra sizer --list` · `--model M --gpu G` · `--model M --compare G1,G2,…` |
| `fleetscope.templates` · `fleetscope.run` · `fleetscope.ask` | `aiinfra fleetscope templates` · `run --template T` · `ask "QUESTION" --template T` |
| `gpu-health.analyze` · `gpu-health.flakiness` | `aiinfra gpu-health analyze …` · `flakiness --state DIR` |
| `ledger.report` · `ledger.insights` | `aiinfra ledger report … --format json` · `insights …` |
| `fleetops.rca.diagnose` | `aiinfra fleetops rca diagnose --symptom S --from T --to T` |
| `fleetops.serving.fit` · `fleetops.serving.capacity` | `aiinfra fleetops serving fit …` · `serving capacity --model M …` |
| `fleetops.power.report` · `fleetops.power.plan` | `aiinfra fleetops power report …` · `power plan …` |
| `fleetops.shadow.compare` · `fleetops.shadow.prom` · `fleetops.shadow.canary` | `aiinfra fleetops shadow compare …` · `shadow prom …` · `shadow canary status --name N` |
| `aiinfra.report` | `aiinfra report --store DIR --model M --gpu G [--harness PATH]` (or `--demo`) |
| `harness-ledger.economics` | `aiinfra harness-ledger economics PATH… [--self-host-model M --gpu G \| --opencost F]` |
| `fix-skew.demo` | `aiinfra fix-skew --demo` (the same shape as for your traces) |

**The contract.** A field listed in `required` is always there, with the type shown. New fields may appear at any
time (consumers should ignore what they don't know), but a required field is never removed, renamed or retyped
without a schema change in the same pull request, called out in the CHANGELOG.

**How they're made.** `node scripts/schemas.mjs --update` runs each command on demo data
([commands.mjs](commands.mjs)) and infers the schema: a key present in every object seen is required, and arrays
carry the merged shape of their items. CI runs `node scripts/schemas.mjs` (and `tests/schemas.test.mjs`) and fails
when an output no longer matches.

**Using them.** Any JSON Schema validator works, for example with Python's `jsonschema`:

```python
import json, subprocess, jsonschema
out = json.loads(subprocess.check_output(["npx", "aiinfra-tools", "sizer", "--model", "llama33-70b", "--gpu", "H100", "--json"]))
jsonschema.validate(out, json.load(open("schemas/sizer.plan.schema.json")))
```
