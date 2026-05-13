---
name: mcp-sentry-grader
description: Helper for invoking the mcp-sentry CLI and interpreting its A–F grade output. Use when the user asks about MCP security posture, OWASP MCP Top 10 scan results, or wants to fail a CI gate on a minimum grade threshold.
---

<!-- coherence:section id="overview" -->
## Overview

`mcp-sentry` is a static-analysis security linter for TypeScript MCP (Model
Context Protocol) servers. It runs eight OWASP MCP Top 10 checks
(MCP01–MCP08), computes a per-check status, and grades the project A–F.
The CLI entry is `packages/cli/src/index.ts`; the grading logic is in
`packages/cli/src/grade.ts`.
<!-- /coherence:section -->

<!-- coherence:section id="invocation" -->
## Invocation

The canonical CLI entry is exposed via `main(argv)` in
`packages/cli/src/index.ts`. Programmatic callers should invoke
`computeGrade(results)` from `packages/cli/src/grade.ts` against a
`CheckResult[]` collected by running the eight `checks/mcp0X-*.ts`
modules.

```bash
mcp-sentry scan ./path/to/project
mcp-sentry scan --fail-on B    # fails the process if grade is worse than B
mcp-sentry scan --json         # machine-readable output
```

The owner/repo derivation used by the badge integration calls
`parseOwnerRepo(remoteUrl)` and tolerates both `https://github.com/o/r`
and `git@github.com:o/r.git` shapes.
<!-- /coherence:section -->

<!-- coherence:section id="grading-rules" -->
## Grading rules

- `computeGrade(results)` aggregates per-check severities into a single
  letter grade.
- `compareGrades(a, b)` returns a negative number when `a` is worse
  than `b` (used by the `--fail-on` flag to decide whether the process
  should exit non-zero).
- `gradeBelow(actual, threshold)` is a convenience wrapper used by the
  CI integration in `packages/action/`.

Project configuration is loaded via `loadConfig(rootDir)` in
`packages/cli/src/config.ts`. The configuration shape is captured by
the exported `FileConfig` interface.
<!-- /coherence:section -->

<!-- coherence:section id="ci-integration" -->
## CI integration

The `packages/action/` directory contains the GitHub Action wrapper.
It shells out to the CLI's `main()` entry, captures the JSON output,
and emits a SARIF report. The npm-audit command surface
(`buildAuditCommand(npmBin)`) is reused by the MCP04 supply-chain
check at `packages/cli/src/checks/mcp04-supply-chain.ts`.
<!-- /coherence:section -->
