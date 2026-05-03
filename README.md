# mcp-sentry

[![mcp-sentry](https://img.shields.io/endpoint?url=https://mcp-sentry.dev/api/badge/example/example)](https://mcp-sentry.dev)

Static-analysis security linter for TypeScript MCP (Model Context Protocol) servers.
Detects all eight OWASP MCP Top 10 categories covered in v1.1 (MCP01–MCP08),
grades the project A–F, and integrates with CI via SARIF, PR comments, and a
public Shields.io badge.

## Status

**v1.1 release.** All eight active OWASP MCP Top 10 checks (MCP01–MCP08),
every reporter (text / JSON / SARIF / Markdown), the Cloudflare badge worker
(now with Durable Object atomic rate limiter and optional HMAC-SHA256 request
signing), the GitHub Action, and the Astro docs site are implemented per the
[Implementation Plan](docs/Implementation%20Plan.md).

v1.1 changes layered on top of v1.0:

- **MCP06 Intent Subversion** — full implementation (read-only-named tools that
  mutate state, missing/trivial descriptions).
- **MCP05 Command Injection** — inter-procedural taint tracking through local
  helper functions in the same source file.
- **HMAC-SHA256 signing** on `POST /api/report` (soft-launch — set
  `MCP_SENTRY_SECRET` env on the CLI and `BADGE_HMAC_SECRET` Worker secret).
- **Cloudflare Durable Object** atomic rate limiter (eliminates the v1.0
  KV-timestamp TOCTOU race).

## Install / Use

```sh
npx mcp-sentry@latest scan ./path/to/mcp-server
```

From a local checkout:

```sh
pnpm install
pnpm --filter mcp-sentry build
node packages/cli/dist/bin.cjs scan ./packages/cli/fixtures/injection-vuln
node packages/cli/dist/bin.cjs checks
```

### Common flags

| Flag | Purpose |
| --- | --- |
| `-f, --format <text\|json\|sarif\|markdown>` | Output format (global). |
| `-o, --output <file>` | Write output to file instead of stdout. |
| `--fail-on <A\|B\|C\|D\|F>` | Exit `1` when grade falls below threshold. |
| `--disable <id...>` | Skip OWASP check IDs (e.g. `--disable MCP08`). |
| `--ignore <glob...>` | Additional ignore patterns. |
| `--report` | POST grade to the badge API. |
| `-V, --version` | Print version. |

## Badge

Add to your README:

```md
[![mcp-sentry](https://img.shields.io/endpoint?url=https://mcp-sentry.dev/api/badge/<owner>/<repo>)](https://mcp-sentry.dev)
```

The badge is updated by `mcp-sentry scan --report`. **Disclosure:** because the
badge reflects the *last reported scan*, a project can game it by running the
CLI on a sanitised tree before publishing. Treat the badge as a signal, not a
guarantee. To enforce signed submissions in v1.1, set `MCP_SENTRY_SECRET` in
the CLI environment and `BADGE_HMAC_SECRET` as a Worker secret — the CLI will
sign each request with HMAC-SHA256 and the Worker will verify (unsigned
submissions are still accepted during the soft-launch window).

## OWASP MCP Top 10 coverage

| ID | Title | v1.1 status |
| --- | --- | --- |
| MCP01 | Token / Secret Exposure | Active |
| MCP02 | Privilege Scope Creep | Active |
| MCP03 | Tool Poisoning | Active |
| MCP04 | Supply Chain | Active |
| MCP05 | Command Injection (intra + inter-procedural) | Active |
| MCP06 | Intent Subversion | Active (new in v1.1) |
| MCP07 | Insufficient Authentication | Active |
| MCP08 | Missing Audit Logging | Active |

## Repository layout

```
packages/cli/        # mcp-sentry CLI (npm: mcp-sentry)
packages/action/     # GitHub Action composite (PR comment + min-grade gate)
workers/badge/       # Cloudflare Worker badge API (Shields.io endpoint)
apps/web/            # Astro docs site at mcp-sentry.dev
docs/                # Technical Spec + Implementation Plan
```

### Vercel Ignore Build Step (monorepo)

`apps/web/vercel.json` uses `ignoreCommand` to skip web deploys when no
relevant monorepo paths changed. Exit-code semantics are critical: `0` means
skip build, any non-zero means run build. Use `:(top)` pathspecs so
`git diff` is anchored to repo root even if Vercel runs from a subdirectory.
Base SHA prefers `VERCEL_GIT_PREVIOUS_SHA` and falls back to `HEAD^` when the
env var is missing. If the base SHA cannot be resolved, fail open with
non-zero so Vercel performs a full safe build.

## Development

```sh
pnpm install
pnpm lint                       # biome check .
pnpm --filter mcp-sentry typecheck
pnpm -r build
pnpm -r test
```

CI runs the same gates on Linux / macOS / Windows × Node 20.

## Deferred to future releases

No longer in v1.1 — these were all shipped: MCP06 full implementation,
inter-procedural MCP05 taint, HMAC-SHA256 signing, Durable Object rate limiter.

Still deferred:

- Drive false-positive rate from <15% to <8% (corpus-driven, multi-release work)
- Python MCP server support
- Pre-commit hook distribution
- VS Code extension
- Scan-time perf optimisation to <1s for 5–15 files

## License

MIT — see [LICENSE](LICENSE).