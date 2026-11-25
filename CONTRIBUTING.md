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

## Output schemas

Agents and scripts depend on the `--json` output. If you change it on purpose, run `node scripts/schemas.mjs --update`
and say so in the pull request; CI fails otherwise. Adding a field needs nothing. See [schemas/README.md](schemas/README.md).

## Skills

`skills/` packages each tool as an Agent Skill. Each `SKILL.md` is hand-written; everything else in a skill folder is
generated from the tool by `node scripts/build-skills.mjs`. **Don't commit the generated files in a pull request**:
change the tool (and `SKILL.md` if needed), and the Skills sync workflow regenerates the copies on `main` after the
merge. To try a skill locally, run `node scripts/build-skills.mjs` and `node --test scripts/test-skills.mjs`, then
`git checkout skills` (or `git stash`) before committing.

## The npm package

The repository root is the `aiinfra-tools` package: `bin/aiinfra.mjs` runs any tool (`npx aiinfra-tools sizer …`).
`npm test` at the root packs it, installs it into an empty project and runs every bin.

## Releasing

1. Add the version's section to `CHANGELOG.md` and set `version` in `package.json` (and the tools' `package.json`).
2. After it merges: `git tag vX.Y.Z && git push origin vX.Y.Z` on `main`.

`.github/workflows/release.yml` checks the tag matches `package.json`, runs the tests, creates the GitHub release from
the changelog section and publishes `aiinfra-tools` to npm with provenance.

## Pull requests

One change per PR, with tests. Say what you checked and what you couldn't. By contributing you agree that your
contribution is licensed under the Apache License 2.0, as the rest of the repository is.
