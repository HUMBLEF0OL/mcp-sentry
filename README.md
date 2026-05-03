# mcp-sentry

[![mcp-sentry](https://img.shields.io/endpoint?url=https://mcp-sentry.dev/api/badge/example/example)](https://mcp-sentry.dev)

Static-analysis security linter for TypeScript MCP (Model Context Protocol) servers.
Detects the OWASP MCP Top 10 categories (MCP01–MCP05, MCP07, MCP08 in v1.0;
MCP06 in v1.1), grades the project A–F, and integrates with CI via SARIF, PR
comments, and a public Shields.io badge.

## Status

**v1.0 release-candidate.** All seven active OWASP MCP Top 10 checks
(MCP01–MCP05, MCP07, MCP08), every reporter (text / JSON / SARIF / Markdown),
the Cloudflare badge worker, the GitHub Action, and the Astro docs site are
implemented per the [Implementation Plan](docs/Implementation%20Plan.md).
MCP06 ships as a deferred-v1.1 stub.

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
guarantee. HMAC-signed report submissions are tracked for v1.1 (see
[deferred items](docs/Implementation%20Plan.md#10-open-items--deferred-to-v11)).

## OWASP MCP Top 10 coverage

| ID | Title | v1.0 status |
| --- | --- | --- |
| MCP01 | Token / Secret Exposure | Active |
| MCP02 | Privilege Scope Creep | Active |
| MCP03 | Tool Poisoning | Active |
| MCP04 | Supply Chain | Active |
| MCP05 | Command Injection | Active |
| MCP06 | Intent Subversion | Deferred to v1.1 (stub registered) |
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