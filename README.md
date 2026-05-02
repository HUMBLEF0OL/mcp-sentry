# mcp-sentry

[![mcp-sentry](https://img.shields.io/endpoint?url=https://mcp-sentry.dev/api/badge/example/example)](https://mcp-sentry.dev)

Static-analysis security linter for TypeScript MCP (Model Context Protocol) servers.
Detects the OWASP MCP Top 10 categories (MCP01–MCP05, MCP07, MCP08 in v1.0;
MCP06 in v1.1), grades the project A–F, and integrates with CI via SARIF, PR
comments, and a public Shields.io badge.

## Status

**Pre-release (Phase 1 of [Implementation Plan](docs/Implementation%20Plan.md)).**
The CLI scaffolding, MCP05 command-injection check, and MCP06 deferred stub are
implemented. Remaining checks, reporters, badge worker, GitHub Action, and docs
site land in Phases 2–4.

## Install / Use

Once published to npm:

```sh
npx mcp-sentry@latest scan ./path/to/mcp-server
```

During Phase 1 development, run from a local checkout:

```sh
pnpm install
pnpm --filter mcp-sentry build
node packages/cli/dist/bin.cjs scan ./packages/cli/fixtures/injection-vuln
node packages/cli/dist/bin.cjs checks
```

### Common flags (Phase 3 surface — not all wired in Phase 1)

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
guarantee. HMAC-signed report submissions are tracked for v1.1 (see
[deferred items](docs/Implementation%20Plan.md#10-open-items--deferred-to-v11)).

## OWASP MCP Top 10 coverage

| ID | Title | v1.0 status |
| --- | --- | --- |
| MCP01 | Token / Secret Exposure | Phase 2 |
| MCP02 | Privilege Scope Creep | Phase 2 |
| MCP03 | Tool Poisoning | Phase 2 |
| MCP04 | Supply Chain | Phase 2 |
| MCP05 | Command Injection | **Active (Phase 1)** |
| MCP06 | Intent Subversion | Deferred to v1.1 (stub registered) |
| MCP07 | Insufficient Authentication | Phase 3 |
| MCP08 | Missing Audit Logging | Phase 3 |

## Repository layout

```
packages/cli/        # mcp-sentry CLI (npm: mcp-sentry)
packages/action/     # GitHub Action composite (Phase 4)
workers/badge/       # Cloudflare Worker badge API (Phase 4)
apps/web/            # Astro docs site at mcp-sentry.dev (Phase 4)
docs/                # Technical Spec + Implementation Plan
```

## Development

```sh
pnpm install
pnpm lint                       # biome check .
pnpm --filter mcp-sentry typecheck
pnpm -r build
pnpm -r test
```

CI runs the same gates on Linux / macOS / Windows × Node 20.

## Deferred to v1.1

See [Implementation Plan §10](docs/Implementation%20Plan.md#10-open-items--deferred-to-v11):

- Full MCP06 intent-subversion implementation
- Cross-function (inter-procedural) taint tracking for MCP05
- HMAC-SHA256 signing on `POST /api/report`
- Cloudflare Durable Objects rate limiter (replaces KV TOCTOU)
- Drive false-positive rate from <15% to <8%
- Python MCP server support, pre-commit hook, VS Code extension

## License

MIT — see [LICENSE](LICENSE).