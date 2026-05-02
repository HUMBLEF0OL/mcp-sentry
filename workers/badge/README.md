# mcp-sentry badge worker

Cloudflare Worker that serves Shields.io badge endpoints for mcp-sentry scan
results. See [Technical Specification Document.md](../../docs/Technical%20Specification%20Document.md) §6.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| `POST` | `/api/report` | Receive a scan result, validate, write to KV. |
| `GET`  | `/api/badge/{owner}/{repo}` | Return Shields.io endpoint JSON. |
| `GET`  | `/health` | Liveness probe. |

## Deployment

```sh
# 1. Create the production + preview KV namespaces
pnpm --filter @mcp-sentry/badge exec wrangler kv:namespace create MCP_SENTRY_BADGES
pnpm --filter @mcp-sentry/badge exec wrangler kv:namespace create MCP_SENTRY_BADGES --preview

# 2. Paste the returned IDs into wrangler.toml ([FILL] placeholders)

# 3. Deploy
pnpm --filter @mcp-sentry/badge exec wrangler deploy
```

## Local development

```sh
pnpm --filter @mcp-sentry/badge exec wrangler dev
# Worker available at http://127.0.0.1:8787
```

## Tests

Hermetic via Miniflare (in-memory KV — no Cloudflare account required).

```sh
pnpm --filter @mcp-sentry/badge test
```
