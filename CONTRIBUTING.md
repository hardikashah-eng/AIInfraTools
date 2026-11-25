# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Ground rules

- **No run-time dependencies.** Every tool runs on Node.js 20+ alone. Tests use `node:test`. (`yaml` is an optional
  test helper in fleetops.)
- **Safe by default.** Anything that changes infrastructure is a dry run unless `--live` and the config both allow
  it, and goes through the approval queue. See [SECURITY.md](SECURITY.md).
- **Every number needs a source.** A new GPU spec, efficiency or default cites where it came from. Validation on real
  data goes in `fleetops/tests/fixtures/real/` with its source and license in that folder's README.
- **Say what is and isn't validated.** Docs state what was tested on synthetic data, on real data, and on a real
  cluster.

## Working on a tool

Each tool has its own folder, README and tests:

```bash
cd fleetops && npm test            # or gpu-health, fleetscope, inference-sizer, hybrid-tracing, gpu-ledger
```

The browser tools (FleetScope, Inference Sizer) build a single HTML file: `node build.mjs` in their folder.

## Skills

`skills/` packages each tool as an Agent Skill. Each `SKILL.md` is hand-written; everything else in a skill folder is
generated from the tool by `node scripts/build-skills.mjs`. After changing a tool or its docs, run it, then
`node scripts/build-skills.mjs --check` and `node --test scripts/test-skills.mjs`.

## Pull requests

One change per PR, with tests. Say what you checked and what you couldn't. By contributing you agree that your
contribution is licensed under the Apache License 2.0, as the rest of the repository is.
