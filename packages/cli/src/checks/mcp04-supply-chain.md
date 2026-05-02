# MCP04 — Malicious Package List

`mcp04-malicious-packages.json` is a hardcoded allowlist of npm package names
known to ship malware in MCP-server contexts.

## Update process

1. Add the offending name to `mcp04-malicious-packages.json` (alphabetical).
2. Bump the patch (or minor) version of `mcp-sentry`.
3. `npm publish` — users pick up the update on their next `npx mcp-sentry@latest`.

The list is intentionally short. Bulk vulnerability data flows through
`npm audit --json`, which is invoked at scan time when a lockfile exists.
