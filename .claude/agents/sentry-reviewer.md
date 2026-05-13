---
name: sentry-reviewer
description: PR-time reviewer that runs mcp-sentry against the diff and surfaces failing OWASP MCP Top 10 checks. Use proactively when a pull request touches `packages/cli/`, any `mcp0X-*.ts` check module, or the grading logic.
---

<!-- coherence:section id="responsibilities" -->
## Responsibilities

The `sentry-reviewer` agent reads the PR diff, identifies which check
modules under `packages/cli/src/checks/` are affected, invokes the
mcp-sentry CLI via `main()` in `packages/cli/src/index.ts`, and posts a
graded summary to the PR. It exits non-zero when `gradeBelow(actual,
threshold)` returns true for the configured threshold (default `B`).
<!-- /coherence:section -->

<!-- coherence:section id="grading-calls" -->
## Grading calls

This agent depends on the public grading surface of the CLI:

- `computeGrade(results)` — aggregates per-check severities into a
  letter grade.
- `compareGrades(a, b)` — orders two grades; called by the CI gate.
- `gradeBelow(actual, threshold)` — convenience boolean used to
  decide whether to fail the PR check.

A regression in any of these symbols (rename, signature change, or
return-type change) will break the agent. The companion
`mcp-sentry-grader` skill captures the same surface.
<!-- /coherence:section -->

<!-- coherence:section id="config-loading" -->
## Config loading

The agent reads the project's mcp-sentry config via `loadConfig(rootDir)`
from `packages/cli/src/config.ts`, which returns a `FileConfig` shape
with the `failOn` threshold + per-check overrides.

If the config file is missing, the agent falls back to defaults defined
in `packages/cli/src/config.ts`.
<!-- /coherence:section -->

<!-- coherence:section id="repo-detection" -->
## Repository detection

For badge + PR comment rendering, the agent derives the GitHub `owner/repo`
slug by calling `parseOwnerRepo(remoteUrl)` from
`packages/cli/src/index.ts`. The helper tolerates HTTPS and SSH remote
URLs.
<!-- /coherence:section -->
