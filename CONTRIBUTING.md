# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Ground rules

- **No run-time dependencies.** Every tool runs on Node.js 22+ alone. Tests use `node:test`. (`yaml` is an optional
  test helper in fleetops.)
- **Safe by default.** Anything that changes infrastructure is a dry run unless `--live` and the config both allow
  it, and goes through the approval queue. See [SECURITY.md](SECURITY.md).
- **New chips and vendors go in one place:** `inference-sizer/src/accelerators.js` (see
  [ACCELERATORS.md](inference-sizer/docs/ACCELERATORS.md)). Every tool reads it.
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

## Code quality

- **Lint:** `npm run lint` (after `npm install --no-save eslint@9 @eslint/js@9 globals@15`) runs ESLint's recommended
  rules: undefined names, unused imports and locals, unreachable code, needless escapes. CI runs it on every pull
  request (`.github/workflows/lint.yml`). Keep it at zero.
- **No copies of shared helpers inside a tool:** fleetops' statistics live in `fleetops/src/stats.mjs`. Tools don't
  share code with each other unless the skill bundles carry it (`scripts/build-skills.mjs`), because each tool ships on
  its own.
- **Tests come with the change.** A bug fix adds the test that would have caught it. Every tool's tests run in CI.
- **Formats stay current:** `npm run check:formats` compares each upstream format the tools read or write with its
  latest version: vLLM metrics; the Argo Rollouts, Flagger, Prometheus Operator, KServe and LWS schemas; NVSentinel
  events; OpenCost; OpenTelemetry GenAI and OpenInference attributes; TraceLab. `.github/workflows/formats.yml` runs it
  weekly and opens a "format drift" issue when anything moved. A breaking change (something read is gone, or a shipped
  manifest fails the new schema) fails the run. When you add a format, add its check there.

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
