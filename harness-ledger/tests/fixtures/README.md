# Test fixtures

Small usage logs in real harness formats, used to check token accounting against another tool's results. They hold
token counts and identifiers only: no conversation content.

| File | From | What it checks |
|---|---|---|
| `codex-ccusage-issue_1970.jsonl` | [ccusage](https://github.com/ryoppippi/ccusage) `rust/crates/ccusage/tests/fixtures/codex/issue_1970.jsonl` at commit 5a60e73 | a Codex subagent rollout whose parent is missing; ccusage reports 1,010 tokens |
| `codex-ccusage-issue_2046.jsonl` | ccusage `…/codex/issue_2046.jsonl` | a fork that copies 990,000 tokens of its parent's history; ccusage counts only its own two responses (16,000 non-cached input, 4,000 cached, 200 output) |
| `otel-ccusage-copilot.jsonl` | ccusage `rust/adapters/copilot/tests/fixtures/otel/trace.jsonl` | GitHub Copilot's OpenTelemetry GenAI spans, one per line |

These three files are from ccusage, MIT License, Copyright (c) 2025 ryoppippi:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The other tests build their inputs in code (`tests/harness.test.mjs`) or from the synthetic demo (`src/demo.mjs`).
