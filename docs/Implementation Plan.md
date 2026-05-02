# mcp-sentry Implementation Plan

| Field | Value |
| --- | --- |
| Title | mcp-sentry — Implementation Plan |
| Version | v1.0 |
| Derived From | Technical Specification Document v1.2 |
| Status | Draft |
| Date | May 2, 2026 |
| Owner | Solo Developer |

---

## Table of Contents

- [1. Overview & Goals](#1-overview--goals)
- [2. Assumptions & Prerequisites](#2-assumptions--prerequisites)
- [3. Monorepo Bootstrapping](#3-monorepo-bootstrapping)
- [4. Phased Breakdown](#4-phased-breakdown)
  - [Phase 1 — Foundation](#phase-1--foundation-week-1)
  - [Phase 2 — Core Checks](#phase-2--core-checks-week-2)
  - [Phase 3 — Completion](#phase-3--completion-week-3)
  - [Phase 4 — Ecosystem](#phase-4--ecosystem-week-4)
  - [Phase 5+ — v1.1 Roadmap](#phase-5--v11-roadmap-post-launch)
- [5. Per-Check Work Breakdown (MCP01–MCP08)](#5-per-check-work-breakdown-mcp01mcp08)
- [6. Cross-Cutting Workstreams](#6-cross-cutting-workstreams)
- [7. Testing Plan](#7-testing-plan)
- [8. Build & Release Pipeline](#8-build--release-pipeline)
- [9. Security Hardening Checklist](#9-security-hardening-checklist)
- [10. Open Items / Deferred to v1.1](#10-open-items--deferred-to-v11)
  - [Tracked assumptions / monitoring](#tracked-assumptions--monitoring)
- [11. Milestones & Exit Gates](#11-milestones--exit-gates)
- [12. Definition of Done — v1.0 Launch](#12-definition-of-done--v10-launch)

---

## 1. Overview & Goals

mcp-sentry is a static-analysis security linter for TypeScript MCP servers, distributed as an `npx`-runnable CLI plus a Cloudflare-hosted badge API, a GitHub Action, and an Astro docs site (TSD §1, §2). The goal of v1.0 is to ship a fast (<2s for 5–15 files), low-FP (<15%), cross-platform CLI that detects the OWASP MCP Top 10 categories MCP01–MCP05, MCP07, MCP08 (MCP06 deferred), grades the project A–F, and integrates with CI via SARIF, PR comments, and a public Shields.io badge.

## 2. Assumptions & Prerequisites

- Node.js 20 LTS installed locally and on CI runners (TSD §12).
- `pnpm` 9.x installed; pnpm workspaces will be the only supported package manager (TSD §9).
- Cloudflare account with Workers + KV enabled, plus a registered API token for `wrangler deploy` (TSD §6, §10.3).
- GitHub organisation owning the `mcp-sentry` repo and a separate `mcp-sentry-action` repo for Marketplace publication (TSD §7).
- npm publish rights for the `mcp-sentry` package name (TSD §10.3).
- Vercel Hobby account linked to the `apps/web` Astro project (TSD §10.3, §14 item 6).
- Repository secrets configured: `NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VERCEL_TOKEN`.

## 3. Monorepo Bootstrapping

- [ ] Initialise repo with `pnpm init`; add root `package.json` with `"private": true` and `"packageManager": "pnpm@9.x"` (TSD §9).
- [ ] Create `pnpm-workspace.yaml` covering `packages/*`, `apps/*`, `workers/*` (TSD §9).
- [ ] Add `biome.json` with formatter + linter enabled, tab width 2, single quotes (TSD §9, §10.2).
- [ ] Add root `tsconfig.base.json` targeting `ES2022`, `module: NodeNext`, `strict: true`, `skipLibCheck: true`.
- [ ] Add `.editorconfig`, `.gitignore` (Node, dist, coverage), `.nvmrc` pinned to `20`.
- [ ] Add MIT `LICENSE` file at repo root and SPDX identifier in every `package.json` (TSD §12).
- [ ] Create skeleton directories per TSD §9 tree (packages/cli, packages/action, apps/web, workers/badge).
- [ ] Create minimal `package.json` in each workspace package so `pnpm --filter` resolves: `packages/cli` (`{ "name": "mcp-sentry", "version": "0.0.0", "private": true }`), `packages/action` (`{ "name": "@mcp-sentry/action", "private": true }`), `workers/badge` (`{ "name": "@mcp-sentry/badge", "private": true }`), `apps/web` (`{ "name": "@mcp-sentry/web", "private": true }`) (TSD §9).
- [ ] Add `.github/workflows/ci.yml` skeleton: install → biome check → vitest → tsup build (TSD §10.2).
- [ ] Add `.github/workflows/release.yml` skeleton triggered on `v*.*.*` tags (TSD §10.3).
- [ ] Configure `commitlint` + conventional commits to enable auto-changelog in §10.3.
- [ ] Install CLI prod deps: `pnpm --filter mcp-sentry add commander@^13 ts-morph@^23 chalk@^5 ora@^8 ignore@^5 which@^4` (TSD §16.1).
- [ ] Install CLI dev deps: `pnpm --filter mcp-sentry add -D vitest tsup @biomejs/biome typescript @types/node @types/which` (TSD §16.2).
- [ ] Install Worker dev deps: `pnpm --filter @mcp-sentry/badge add -D wrangler miniflare vitest` (TSD §16.3).
- [ ] Commit the generated `pnpm-lock.yaml` to lock dependency resolution across CI matrix (TSD §10.2).
- [ ] Author root `README.md`: install (`npx mcp-sentry`), usage, badge example, OWASP MCP Top 10 coverage, badge-poisoning disclosure per TSD §6.6, link to deferred v1.1 items in this plan §10.

## 4. Phased Breakdown

### Phase 1 — Foundation (Week 1)

**Goals:** Stand up the CLI scaffolding, file discovery, ts-morph project, the priority MCP05 check, and a stub for MCP06 so downstream registry code can iterate.

**Tasks:**

- [ ] Amend the existing `packages/cli/package.json` skeleton (created in §3) with `"bin": { "mcp-sentry": "dist/index.cjs" }`, `"main": "dist/index.cjs"`, `"module": "dist/index.mjs"`, `"types": "dist/index.d.ts"`, and a `build` script invoking `tsup` (TSD §9, §10.1).
- [ ] Add `tsup.config.ts` outputting `dist/index.cjs`, `dist/index.mjs`, `dist/index.d.ts`, target `node20`, `shebang: true` (TSD §10.1).
- [ ] Implement `src/index.ts` with Commander.js entry point; register `scan` and `checks` commands; use `.version()` for `-V` (TSD §2.2, §8.0).
- [ ] Implement `checks` subcommand: print check registry (id, owaspId, severity range, description, status [`active`|`deferred-v1.1`]) to stdout. Inherits the global `--format text|json` option (declared on the root program, not on `scan`); default is `text` (TSD §2.2).
- [ ] Implement `src/types.ts` with `ScanOptions`, `CheckResult`, `CheckFn`, `GradeResult` (TSD §3.3, §4.2).
- [ ] Implement `src/scanner.ts` `discoverFiles()` honoring excludes and `.mcp-sentry.ignore` via `ignore` package (TSD §3.1).
- [ ] Initialise ts-morph `Project` with `skipAddingFilesFromTsConfig: true`, `allowJs`, `noEmit`; wrap `addSourceFileAtPath` in try/catch and emit warnings to stderr (TSD §3.2).
- [ ] Track skipped files; surface count in all reporters (TSD §3.2).
- [ ] Implement `src/checks/mcp05-injection.ts` — intra-function taint trace from tool input parameters to `child_process.exec/spawn/...` and unsanitised `fs.*` paths (TSD §3.4 MCP05).
- [ ] Implement `src/checks/mcp06-intent.ts` stub: registered in the default check registry so the `checks` subcommand lists it with status `deferred-v1.1`; when invoked by `scanner.ts`, the stub returns an empty `CheckResult[]` AND emits a one-time stderr notice ("MCP06 intent-subversion check is deferred to v1.1"). It must NOT throw at scan time — throwing would abort the scan. Reserve `NotImplementedError` only for direct programmatic invocation outside the registry path. (Resolves TSD §2.2 vs. §15 ambiguity in favour of non-aborting behaviour.)
- [ ] Build a `clean-server` and `injection-vuln` fixture under `packages/cli/fixtures/` (TSD §9).
- [ ] Wire vitest with one test per fixture asserting the MCP05 finding shape on `injection-vuln`, AND asserting `clean-server` produces grade A with zero findings (TSD §11.4 test C).

**Deliverables:** runnable `npx mcp-sentry scan ./fixtures/injection-vuln` returning a critical MCP05 finding; passing CI on Linux/macOS/Windows.

**Exit criteria:** MCP05 detects exec() injection in fixture; MCP06 stub present and throws; no parse failures abort scans.

**Risks:** ts-morph performance on first run; intra-function taint tracing complexity. Mitigate via small fixture and conservative matching.

**Dependencies:** §3 bootstrapping complete.

### Phase 2 — Core Checks (Week 2)

**Goals:** Implement remaining critical/high-impact checks (MCP01–MCP04) and ship default text output with grading.

**Tasks:**

- [ ] Implement `src/checks/mcp01-secrets.ts` — 30–40 secret regexes, scan source text + AST-extracted tool description string literals, suppress placeholder patterns and test/fixture paths (TSD §3.4 MCP01).
- [ ] Implement `src/checks/mcp02-scope.ts` — flag `z.any()` (High), unrefined `z.string/number` (Medium), broad `fs.readdir`/`glob` patterns (High), unvalidated path inputs (High) (TSD §3.4 MCP02).
- [ ] Implement `src/checks/mcp03-poisoning.ts` — hidden instruction phrases, ANSI escapes, zero-width chars, name shadowing (`read_file`, `write_file`, `bash`, `computer`), dynamic schema assignments (TSD §3.4 MCP03).
- [ ] Implement `src/checks/mcp04-supply-chain.ts` — `package.json` semver-range scan, lockfile presence, spawn `npm audit --json` via `child_process.spawn(npmBinary, ..., { shell: false, timeout: 10000 })`, hardcoded malicious package list (TSD §3.4 MCP04, §13.1).
- [ ] MCP04 lockfile gating: when `package-lock.json`/`pnpm-lock.yaml` is absent, emit the High lockfile-missing finding AND skip the `npm audit` subprocess (audit cannot run without a lockfile and would error) (TSD §3.4 MCP04).
- [ ] MCP04 npm-audit JSON parser: validate against known top-level keys (`vulnerabilities`, `metadata`); log unexpected fields to stderr without failing the scan; pin a known-good npm version in CI (TSD §14 item 3).
- [ ] Implement `src/grade.ts` per matrix (TSD §4.1) and `nextGrade` suggestion string (TSD §4.2).
- [ ] Implement `src/reporter.ts` text format using `chalk` v5 + `ora` spinner; respect `NO_COLOR` (TSD §5.1).
- [ ] Implement inline suppression parsing: `// mcp-sentry-ignore: MCPxx` (TSD §8.2).
- [ ] Add fixtures: `secrets-exposed`, `full-vulns`; create `*.expected.json` manifests for exact-match assertions (TSD §11.1).
- [ ] Configure check registry skipping any check listed in `--disable` or `.mcp-sentry.json` `disable` (TSD §8.0, §8.1).
- [ ] MCP04 known-malicious package list: create `packages/cli/src/checks/mcp04-malicious-packages.json` seeded with confirmed-malicious MCP package names (initial seed may be `[]` if none confirmed at build time — commit explicitly so the file exists). Document the update process in `packages/cli/src/checks/mcp04-supply-chain.md`: add to JSON → minor or patch release → npm publish (TSD §3.4 MCP04).
- [ ] Deliver `scripts/measure-fp.ts` (full implementation per §7.3) so the Phase 2 exit criteria (FP rate <15% on corpus subset) is measurable.
- [ ] Curate and commit initial `packages/cli/fixtures/corpus.txt` — 20 entries `owner/repo@commitSHA` covering: 5 official Anthropic MCP examples, top-10 most-downloaded MCP npm packages, 5 community MCP servers from awesome-mcp. Critical-path artefact for DoD §12 (TSD §11.2).

**Deliverables:** All five primary checks (MCP01–MCP05) green against fixtures with expected manifests; text output with grade box.

**Exit criteria:** MCP01–MCP05 fire correctly on fixtures; FP rate measured against starter corpus subset is <15% (TSD §11.2).

**Risks:** Secret regex false positives. Mitigate via test/fixture skip rules and `process.env.*` placeholder filter.

**Dependencies:** Phase 1.

### Phase 3 — Completion (Week 3)

**Goals:** Implement the remaining checks, add machine-readable outputs, complete CLI flag surface, and publish to npm.

**Tasks:**

- [ ] Implement `src/checks/mcp07-auth.ts` — detect `StreamableHTTPServerTransport`/express/fastify usage; flag missing bearer token / auth middleware as High; exempt stdio-only servers (TSD §3.4 MCP07).
- [ ] Build `fixtures/stdio-only/` negative-case fixture (stdio-only MCP server) and add `*.expected.json` asserting MCP07 produces zero findings (TSD §3.4 MCP07).
- [ ] Implement `src/checks/mcp08-logging.ts` — missing tool-invocation logging (Medium), unsafe error propagation (Low), missing global `uncaughtException` handler (Low) (TSD §3.4 MCP08).
- [ ] Add JSON reporter — emit literal `schemaVersion: "1.0"`, ISO8601 `timestamp`, absolute `scanPath`, `skippedFiles[]` from §3.2 handler, full `findings[]` with `suppressed` and optional `ruleUrl` (TSD §5.2).
- [ ] Add SARIF 2.1.0 reporter — `$schema` + `version: "2.1.0"`, `tool.driver.name = 'mcp-sentry'`, `tool.driver.version` from `package.json`, `rules[]` from check registry (one per unique `checkId`), `results[].locations[].physicalLocation.artifactLocation.uri` (relative path) + `region.startLine/startColumn`, severity map critical/high→error, medium→warning, low→note, `suppressions: [{ kind: 'inSource' }]` for suppressed findings (TSD §5.3, §8.2).
- [ ] Add Markdown reporter — Shields.io badge image at top, finding table (Severity│File│Line│Message│Fix), OWASP MCP Top 10 coverage table (TSD §5.4).
- [ ] Wire `--format/-f`, `--output/-o`, `--fail-on`, `--disable`, `--ignore`, `--report`, `-V` flags exactly per TSD §8.0; ensure `-v` remains unassigned.
- [ ] Implement `.mcp-sentry.json` config loader merging with CLI flags (CLI wins) (TSD §8.1).
- [ ] Implement exit code logic: `1` if grade below `--fail-on` threshold using order A>B>C>D>F (TSD §2.3, §7.2).
- [ ] `--report` POST payload includes `version` field read from `packages/cli/package.json` (required by TSD §6.2 schema).
- [ ] Validate `--report` payload <1KB before POST (TSD §13.1).
- [ ] Set up npm publish dry-run in CI; tag and publish `1.0.0`.
- [ ] Implement `scripts/check-bundle-size.mjs` per §6.8 spec (`npm pack --dry-run --json`, assert `unpackedSize < 5_000_000`); wire into `ci.yml` after `tsup build` step.
- [ ] Implement `scripts/gen-perf-fixture.mjs` generating the synthetic 50-file MCP server under `packages/cli/fixtures/perf-50/`; commit the generated output (TSD §11.3).
- [ ] Add SARIF 2.1.0 schema to `packages/cli/src/schemas/sarif-2.1.0.json` (committed copy from `https://json.schemastore.org/sarif-2.1.0.json`); install `ajv` + `ajv-formats` as dev deps; wire validation into reporter test (§7.1).
- [ ] Configure commitlint: add `.commitlintrc.json` extending `@commitlint/config-conventional`; install `@commitlint/cli` + `@commitlint/config-conventional` as root dev deps; add a `commitlint` step to `ci.yml` validating PR commits (`commitlint --from origin/main --to HEAD`).

**Deliverables:** v1.0.0 published to npm; all reporters working; `npx mcp-sentry@latest` runnable globally.

**Exit criteria:** E2E tests A/B/C pass (TSD §11.4); npm package installs and runs cross-platform.

**Risks:** SARIF schema drift; npm bin shebang on Windows. Mitigate via `tsup` `shebang: true` and Windows CI matrix (TSD §10.1, §10.2).

**Dependencies:** Phases 1–2.

### Phase 4 — Ecosystem (Week 4)

**Goals:** Ship the badge Worker, GitHub Action, and Astro docs site, completing the full E2E loop.

**Tasks:**

- [ ] Scaffold `workers/badge` with `wrangler.toml` matching TSD §6.7 verbatim (`name`, `main`, `compatibility_date = "2026-05-01"`, `compatibility_flags = ["nodejs_compat"]`, `[[kv_namespaces]]` with `binding = "MCP_SENTRY_BADGES"` and `[FILL]` IDs, `[dev] port = 8787`).
- [ ] Implement `POST /api/report` with strict schema validation, owner/repo regex, integer clamp [0,9999], KV write, KV-timestamp rate limit (10/hour) (TSD §6.2, §6.5, §13.2).
- [ ] Implement `GET /api/badge/{owner}/{repo}` returning Shields.io endpoint JSON with literal fields: `schemaVersion: 1`, `label: "mcp-sentry"`, `message: <grade>`, `color: <hex without #>`, `namedLogo: "shield"`, `cacheSeconds: 3600`; set `Cache-Control: max-age=3600` header (TSD §6.3, §6.1).
- [ ] Implement `GET /health` returning `{ status, version }` (TSD §6.1).
- [ ] Add CSP `default-src 'none'`, CORS `*` only on GET badge route (TSD §6.6).
- [ ] Add Worker tests using `unstable_dev` / Miniflare covering POST validation, rate limit, GET response (TSD §11.4).
- [ ] Implement `packages/action/action.yml` with inputs per TSD §7.1 and steps per TSD §7.2.
- [ ] Implement PR comment formatter (Markdown table per TSD §7.3) using `actions/github-script`.
- [ ] Add SARIF upload step gated by `upload-sarif` input via `github/codeql-action/upload-sarif` (TSD §7.2).
- [ ] Document Marketplace publishing flow (copy `action.yml` to dedicated repo) in `packages/action/README.md` (TSD §7).
- [ ] Execute Marketplace publish: create `mcp-sentry-action` repo, copy `packages/action/action.yml` plus any referenced files in `packages/action/src/` (composite-action JS step scripts, `package.json` if present) to repo root — NO bundling step required (composite actions execute `npx mcp-sentry@latest` directly; only JavaScript actions need `@vercel/ncc` bundling). Tag `v1`, submit to GitHub Marketplace, verify listing renders inputs from §7.1 (TSD §7).
- [ ] Scaffold `apps/web` with Astro; pages: landing, docs (rules, config, install), each linking to `https://mcp-sentry.dev/rules/MCPxx` URLs used in `ruleUrl` (TSD §3.3, §5.2).
- [ ] Add Vercel project config; verify build on PR previews.
- [ ] Verify all `https://mcp-sentry.dev/rules/MCPxx` URLs (one per active check ID) return 200 OK in production before declaring Phase 4 complete — these URLs are emitted in every JSON/SARIF `ruleUrl` and broken links would ship on day one (TSD §3.3, §5.2).
- [ ] Run `wrangler kv:namespace create MCP_SENTRY_BADGES` (prod) and `wrangler kv:namespace create MCP_SENTRY_BADGES --preview` (preview); paste returned IDs into `[FILL]` placeholders in `wrangler.toml` (TSD §6.7).
- [ ] Worker test KV setup: configure Miniflare in `workers/badge/vitest.config.ts` with an in-memory KV namespace bound to `MCP_SENTRY_BADGES`; no real Cloudflare KV namespace required for CI — Miniflare emulates KV locally so tests run hermetically.
- [ ] (Release pipeline tasks consolidated in §8 below.)

**Deliverables:** Worker live at production URL; GitHub Action installable; docs site deployed; full loop scan → badge → README → Action PR comment verified.

**Exit criteria:** Action smoke test against `injection-vuln` fixture posts grade D/F PR comment; badge GET returns expected color/message after POST; all `/rules/MCPxx` doc URLs resolve 200 OK.

**Risks:** KV TOCTOU race under concurrent POSTs (accepted limitation, TSD §6.5, §14 item 7); Marketplace verification delays.

**Dependencies:** Phase 3 (CLI must be on npm before Action can `npx mcp-sentry@latest`).

### Phase 5+ — v1.1 Roadmap (Post-launch)

**Goals:** Address known gaps and respond to community demand.

**Tasks:**

- [ ] Implement full MCP06 intent-subversion check (TSD §2.2, §15).
- [ ] Add cross-function / inter-procedural taint tracking for MCP05 (TSD §14 item 2).
- [ ] Add HMAC-SHA256 signing on `POST /api/report` using GitHub-Secret-stored repo secret; Worker verifies (TSD §6.6).
- [ ] Replace KV timestamp rate limit with Cloudflare Durable Objects atomic counter (TSD §6.5, §14 item 7).
- [ ] Drive FP rate to <8% via corpus measurement (TSD §11.2).
- [ ] Add Python MCP server support, pre-commit hook, VS Code extension (TSD §15).
- [ ] Optimise scan to <1s for 5–15 files (TSD §12).

**Exit criteria:** Community demand prioritised list; v1.1 release cut.

**Dependencies:** v1.0 launched and adopted.

## 5. Per-Check Work Breakdown (MCP01–MCP08)

| Check | Module Path | Approach | Severity Outputs | Fixture | Test File | Complexity | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MCP01 | `packages/cli/src/checks/mcp01-secrets.ts` | Regex over file text + AST-extracted description string literals | Critical | `fixtures/secrets-exposed/` | `mcp01-secrets.test.ts` | M | 2 |
| MCP02 | `packages/cli/src/checks/mcp02-scope.ts` | AST (ts-morph) | High, Medium | `fixtures/full-vulns/` | `mcp02-scope.test.ts` | M | 2 |
| MCP03 | `packages/cli/src/checks/mcp03-poisoning.ts` | AST + regex on description literals | High, Medium | `fixtures/full-vulns/` | `mcp03-poisoning.test.ts` | M | 2 |
| MCP04 | `packages/cli/src/checks/mcp04-supply-chain.ts` | `package.json` parse + lockfile check + `child_process.spawn('npm audit --json')` | High, Medium | `fixtures/full-vulns/` | `mcp04-supply-chain.test.ts` | L | 2 |
| MCP05 | `packages/cli/src/checks/mcp05-injection.ts` | AST taint trace (intra-function) | Critical | `fixtures/injection-vuln/` | `mcp05-injection.test.ts` | L | 1 |
| MCP06 | `packages/cli/src/checks/mcp06-intent.ts` | Registry stub returning `[]` + stderr deferred-notice; full impl v1.1 | n/a (v1.0) | n/a | `mcp06-intent.test.ts` (asserts no findings, no throw, registry status `deferred-v1.1`) | S | 1 |
| MCP07 | `packages/cli/src/checks/mcp07-auth.ts` | AST pattern match for HTTP transport + missing auth | High | `fixtures/full-vulns/` + `fixtures/stdio-only/` (negative case) | `mcp07-auth.test.ts` | M | 3 |
| MCP08 | `packages/cli/src/checks/mcp08-logging.ts` | AST structural inspection of tool handlers + catch blocks | Medium, Low | `fixtures/full-vulns/` | `mcp08-logging.test.ts` | M | 3 |

## 6. Cross-Cutting Workstreams

### 6.1 Grading Engine (`grade.ts`)
- [ ] Implement `computeGrade(results)` per matrix in TSD §4.1 (ignore suppressed findings).
- [ ] Compute `nextGrade` hint string ("Fix 1 critical to reach D", etc.).
- [ ] Map grade → `badgeColor` hex (TSD §4.1).
- [ ] Unit tests for every boundary (A/B/C/D/F transitions) (TSD §11.1).

### 6.2 Reporter (`reporter.ts`)
- [ ] Text formatter (chalk + ora + box-drawing chars; honour NO_COLOR) (TSD §5.1).
- [ ] JSON formatter matching schema in TSD §5.2 including `skippedFiles` and `suppressed`.
- [ ] SARIF 2.1.0 formatter with `rules[]` registry and severity map (TSD §5.3).
- [ ] Markdown formatter with badge URL + OWASP coverage table (TSD §5.4).
- [ ] `--output/-o` writes to file in selected format; `--report` always POSTs JSON regardless of `--format` (TSD §8.0).

### 6.3 Config & Ignore Mechanism
- [ ] `.mcp-sentry.json` loader merged with CLI args; `--output` is CLI-only (TSD §8.1).
- [ ] `.mcp-sentry.ignore` parser using `ignore` package (TSD §3.1).
- [ ] Inline `// mcp-sentry-ignore: MCPxx` line-scoped suppressions reflected in JSON `suppressed: true` and SARIF `suppressions[].kind = 'inSource'` (TSD §8.2, §5.3).

### 6.4 CLI Flag Wiring
- [ ] All flags from TSD §8.0 wired through Commander; `-V` reserved for `--version`, `-v` left unassigned.
- [ ] Repeatable `--disable` and `--ignore` collect into arrays.
- [ ] Resolve `owner`/`repo` from config or `GITHUB_REPOSITORY` env (TSD §3.3).
- [ ] Unit test asserts `GITHUB_REPOSITORY=acme/my-server` env var is parsed into `owner="acme"`, `repo="my-server"` when neither is set in `.mcp-sentry.json` (critical path for GitHub Action `--report` invocation).
- [ ] Implement grade comparator using order `A>B>C>D>F`; `--fail-on` (CLI) and Action `min-grade` both consume it; unit-tested for every threshold (TSD §7.2, §8.0).

### 6.5 Badge Worker (`workers/badge`)
- [ ] Routes POST/GET/health per TSD §6.1.
- [ ] Strict schema validation, regex on owner/repo, integer clamp, rate limit (TSD §6.2, §6.5, §13.2).
- [ ] CORS + CSP headers per TSD §6.6.

### 6.6 GitHub Action (`packages/action`)
- [ ] `action.yml` inputs/outputs per TSD §7.1.
- [ ] Composite steps per TSD §7.2.
- [ ] PR comment writer per TSD §7.3.
- [ ] Action exits `1` when computed grade is below `min-grade` per `A>B>C>D>F` comparator (TSD §7.2).
- [ ] Token scopes documented (TSD §13.3).

### 6.7 Astro Docs Site (`apps/web`)
- [ ] Landing page, install/usage docs, rule pages at `/rules/MCPxx` matching `ruleUrl` from findings.
- [ ] Vercel project config and PR previews.

### 6.8 Release Pipeline
- [ ] `release.yml` orchestrates CI matrix → `tsup` build → `npm publish` → `wrangler deploy` → Vercel auto-deploy → `gh release create` (TSD §10.3).
- [ ] Bundle size check < 5 MB enforced in CI via `scripts/check-bundle-size.mjs` running `npm pack --dry-run --json` and asserting `unpackedSize < 5_000_000` (cross-platform; matches what users actually download via `npx`) (TSD §10.1, §12).

## 7. Testing Plan

### 7.1 Unit Tests (Vitest)
- [ ] One test file per check module under `packages/cli/src/checks/*.test.ts` asserting against `*.expected.json` manifests (TSD §11.1).
- [ ] `grade.ts` boundary tests for every grade transition (TSD §4.1, §11.1).
- [ ] `reporter.ts` snapshot tests for text/json/sarif/markdown.
- [ ] Suppression-comment tests verifying findings flagged `suppressed: true` and excluded from grade.
- [ ] Suppressed-critical test: a critical MCP05 finding with `mcp-sentry-ignore` does not lower grade below A (TSD §4.1, §8.2).
- [ ] MCP04 npm-binary resolution test: mock `process.env.npm_execpath` set vs. unset; assert fallback to `which.sync('npm')`; cover Windows `npm.cmd` path (TSD §13.1).
- [ ] Grade comparator unit tests covering every `--fail-on` threshold (TSD §7.2, §8.0).
- [ ] MCP04 unit test mocks `child_process.spawn`, feeds `fixtures/npm-audit-output.json`, asserts parser maps `severity >= high` to High findings without network access (TSD §3.4 MCP04).
- [ ] Commander wiring test asserts no option is registered for short flag `-v` (reserved per TSD §8.0).
- [ ] SARIF reporter output validated against the published SARIF 2.1.0 JSON schema via `ajv` in test (TSD §5.3).

### 7.2 Fixtures
- [ ] `fixtures/clean-server/` — produces grade A, zero findings (TSD §11.4 test C).
- [ ] `fixtures/injection-vuln/` — at least one Critical MCP05 finding (TSD §11.4 test A/B).
- [ ] `fixtures/secrets-exposed/` — Critical MCP01 findings.
- [ ] `fixtures/full-vulns/` — every check fires at least once.
- [ ] `fixtures/stdio-only/` — stdio-only MCP server; MCP07 must NOT fire (negative-case fixture).
- [ ] Each fixture ships an `*.expected.json` manifest.

### 7.3 Corpus FP Measurement
- [ ] Commit `packages/cli/fixtures/corpus.txt` listing 20 real-world MCP repos as `owner/repo@commitSHA` (TSD §11.2). See Phase 2 task for curation breakdown (5 official + 10 top-downloaded + 5 community).
- [ ] Implement `scripts/measure-fp.ts` per the following spec:
  - **CLI:** `tsx scripts/measure-fp.ts [--limit N] [--out reports/fp-<date>.json] [--non-interactive]`.
  - **Inputs:** reads `packages/cli/fixtures/corpus.txt`; honours `--limit N` for sampling.
  - **Steps:** for each entry: `git clone --depth 1` into `.tmp/corpus/<owner>__<repo>`, `git checkout <sha>`, run `node packages/cli/dist/index.cjs scan <path> --format json --output <tmp>.json`, load findings, prompt human reviewer per finding (`y` = true positive, `n` = false positive, `s` = skip) unless `--non-interactive` (defaults all to true positive for smoke runs).
  - **Output:** writes JSON report `{ total, truePositive, falsePositive, fpRate, perRepo: [...] }`; prints summary; exits `1` if `fpRate > 0.15`.
  - **Cleanup:** `rm -rf .tmp/corpus` at end (or on `SIGINT`).
- [ ] Update corpus only on minor/major releases.

### 7.4 Performance Benchmark
- [ ] Generate synthetic 50-file MCP server fixture under `packages/cli/fixtures/perf-50/` via `scripts/gen-perf-fixture.mjs` (committed output) (TSD §11.3).
- [ ] Benchmark via Vitest bench; assert <2s on `ubuntu-latest` 2-core (TSD §11.3, §12).

### 7.5 E2E Tests
- [ ] Test A — JSON output includes MCP05 critical finding for `injection-vuln`, exit 0 (TSD §11.4).
- [ ] Test B — `--fail-on C` against `injection-vuln` exits 1 (TSD §11.4).
- [ ] Test C — `clean-server` exits 0, grade A, zero findings (TSD §11.4).

### 7.6 Worker Test
- [ ] POST `/api/report` with grade=B, then GET `/api/badge/{owner}/{repo}` asserts `message=B`, `color=97CA00`, plus literal `schemaVersion: 1`, `label: "mcp-sentry"`, `namedLogo: "shield"`, `cacheSeconds: 3600` (TSD §6.3, §11.4).
- [ ] Rate-limit test asserts 11th POST in window returns 429.

### 7.7 Action Smoke Test
- [ ] Workflow runs Action against `injection-vuln`; asserts PR comment posted with grade D or F (TSD §11.4).

## 8. Build & Release Pipeline

- [ ] `packages/cli/tsup.config.ts` — `entry: ['src/index.ts']`, formats `cjs`+`esm`+`dts`, target `node20`, `bundle: true`, `shebang: true` (or banner `#!/usr/bin/env node`) (TSD §10.1).
- [ ] tsup emits POSIX exec mode (0o755) for `dist/index.cjs`; `npm publish` preserves the mode in the tarball; on Windows, npm generates `.cmd` and PowerShell shims for the `bin` entry, so no `chmod` is required there.
- [ ] `ci.yml` matrix: `{ os: [ubuntu-latest, macos-latest, windows-latest], node: [20] }`; steps: pnpm install → biome check → vitest → tsup build → bundle-size assert (TSD §10.2).
- [ ] Windows-specific test ensuring `path.sep` normalization in reporter and discovery output.
- [ ] `release.yml` triggered on `v*.*.*` tag — runs CI, `npm publish --access public`, `wrangler deploy` for `workers/badge`, triggers Vercel deploy via push, `gh release create` with auto-changelog (TSD §10.3).
- [ ] Required repo secrets validated by a CI preflight job: `NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VERCEL_TOKEN`.

## 9. Security Hardening Checklist

Mapped to TSD §13 and §6.6:

- [ ] No `child_process.exec` and no `shell: true` anywhere in CLI (TSD §13.1).
- [ ] `npm` binary resolution: `process.env.npm_execpath` first, fallback to `which.sync('npm')`; never `path.join(process.execPath, 'npm')` (TSD §13.1).
- [ ] All subprocess calls have `timeout: 10000` and `shell: false` (TSD §3.4 MCP04, §13.1).
- [ ] CLI is read-only — never executes scanned code (TSD §13.1).
- [ ] `--report` payload size validated `< 1 KB` before POST (TSD §13.1).
- [ ] No source content transmitted by `--report` — only `{ grade, counts, owner, repo }` (TSD §13.1).
- [ ] Worker input validation: strict schema, reject unknown fields, owner/repo regex `^[a-zA-Z0-9_.-]+$` max 100, integer counts clamped `[0,9999]` (TSD §6.2, §13.2).
- [ ] Worker secrets only via `wrangler secret`; no plaintext in repo (TSD §6.6, §13.2).
- [ ] Worker CSP `default-src 'none'`; CORS `*` only on GET badge endpoint (TSD §6.6).
- [ ] GitHub Action `GITHUB_TOKEN` scoped to `contents: read`, `pull-requests: write`, optional `security-events: write` only when `upload-sarif` enabled (TSD §13.3).
- [ ] No third-party Actions with write permissions (TSD §13.3).
- [ ] README badge documentation explicitly notes badge reflects last `--report` scan (TSD §6.6).

## 10. Open Items / Deferred to v1.1

- [ ] Full MCP06 intent-subversion implementation (TSD §2.2, §15).
- [ ] Cross-function / inter-procedural taint analysis for MCP05 (TSD §14 item 2).
- [ ] HMAC-SHA256 signing on `POST /api/report` with GitHub-Secret-stored repo key (TSD §6.6).
- [ ] Cloudflare Durable Objects to replace KV TOCTOU rate limiter (TSD §6.5, §14 item 7).
- [ ] Drive FP rate from <15% to <8% via expanded corpus (TSD §11.2).
- [ ] Python MCP server support, pre-commit hook, VS Code extension (TSD §15).

### Tracked assumptions / monitoring

- [ ] Monitor Cloudflare KV write volume post-launch; revisit if it approaches 1K/day (TSD §14 item 4).
- [ ] Monitor Vercel Hobby bandwidth (100 GB/month cap) on `apps/web`; alert at 70% utilisation (TSD §14 item 6).
- [ ] Pin npm CLI version in CI and watch for `npm audit --json` schema drift (TSD §14 item 3).

## 11. Milestones & Exit Gates

| Milestone | Target | Exit Gate |
| --- | --- | --- |
| M1 — Foundation | End of Week 1 | `npx mcp-sentry scan ./fixtures/injection-vuln` flags MCP05 critical; MCP06 stub throws; CI green on 3 OSes (TSD §15) |
| M2 — Core Checks | End of Week 2 | MCP01–MCP05 pass fixture suite; FP rate <15% on corpus subset (TSD §11.2, §15) |
| M3 — Completion | End of Week 3 | All 7 active checks shipped; JSON/SARIF/Markdown reporters validated; v1.0.0 published to npm; E2E tests A/B/C green (TSD §11.4, §15) |
| M4 — Ecosystem | End of Week 4 | Worker live; GitHub Action installable from Marketplace; docs site deployed; Action smoke test posts PR comment for injection-vuln (TSD §11.4, §15) |
| M5 — v1.1 Planning | Post-launch | Open items prioritised, MCP06 design ratified, HMAC + Durable Objects spec written (TSD §15) |

## 12. Definition of Done — v1.0 Launch

- [ ] `mcp-sentry@1.0.0` published to npm, runnable via `npx mcp-sentry@latest`.
- [ ] CI green on Linux, macOS, Windows × Node 20 (TSD §10.2).
- [ ] Bundle <5 MB installed (TSD §10.1, §12).
- [ ] All 7 v1.0 checks (MCP01–MCP05, MCP07, MCP08) implemented; MCP06 stub present (TSD §15).
- [ ] Text, JSON, SARIF, Markdown reporters working (TSD §5).
- [ ] `--fail-on`, `--disable`, `--ignore`, `--report`, `--output/-o`, `--format/-f`, `-V` flags wired exactly per TSD §8.0.
- [ ] `.mcp-sentry.json` and inline suppressions honored (TSD §8.1, §8.2).
- [ ] Badge Worker deployed; `POST /api/report` + `GET /api/badge/{owner}/{repo}` + `/health` live (TSD §6).
- [ ] GitHub Action published to Marketplace via dedicated `mcp-sentry-action` repo (TSD §7).
- [ ] Astro docs site deployed on Vercel with `/rules/MCPxx` pages reachable (TSD §3.3, §5.2).
- [ ] Security hardening checklist (§9) fully checked off.
- [ ] FP rate measured <15% on 20-repo corpus (TSD §11.2). Initial `corpus.txt` (20 entries) MUST be committed before the v1.0.0 tag is cut, since §7.3 only updates the corpus on minor/major releases.
- [ ] Scan completes <2s on 5–15 file fixture in CI (TSD §11.3, §12).
- [ ] README documents badge limitations and v1.1 deferred items (TSD §6.6, §10 of this plan).
- [ ] GitHub Release created with auto-generated changelog (TSD §10.3).
