# Agents + Skills reference

This page documents the AI-agent and skill surfaces that ship with the
mcp-sentry workspace. The companion definitions live at
`.claude/skills/mcp-sentry-grader/SKILL.md` and
`.claude/agents/sentry-reviewer.md`.

<!-- coherence:section id="grader-skill" -->
## `mcp-sentry-grader` skill

A helper skill for invoking the mcp-sentry CLI from inside an agent
session. Key entry points it references:

- `main(argv)` — the CLI entry exported from `packages/cli/src/index.ts`.
- `computeGrade(results)` — aggregates per-check severities into an
  A–F grade (from `packages/cli/src/grade.ts`).
- `parseOwnerRepo(remoteUrl)` — derives the GitHub slug for badge
  integration.

Invoke as:

```
/skill mcp-sentry-grader
```
<!-- /coherence:section -->

<!-- coherence:section id="reviewer-agent" -->
## `sentry-reviewer` agent

Proactive PR-time reviewer. When a pull request modifies any check
module under `packages/cli/src/checks/`, the agent fires
automatically and runs the CLI against the diff.

It depends on three grading-surface symbols staying stable:
`computeGrade`, `compareGrades`, and `gradeBelow`. Config loading
flows through `loadConfig(rootDir)` from `packages/cli/src/config.ts`.

The fail-on threshold defaults to `B` — i.e. `gradeBelow(actual, "B")`
must be false for the PR to pass.
<!-- /coherence:section -->

<!-- coherence:section id="ci-flow" -->
## CI flow

The `packages/action/` directory wraps the CLI for GitHub Actions. The
action invokes `main()` programmatically, captures the JSON via
`renderJson`, computes the grade with `computeGrade`, and decides
whether to fail the workflow via `gradeBelow`.

For npm-audit shellouts inside the MCP04 supply-chain check, the
action reuses `buildAuditCommand(npmBin)` from
`packages/cli/src/checks/mcp04-supply-chain.ts`.
<!-- /coherence:section -->
