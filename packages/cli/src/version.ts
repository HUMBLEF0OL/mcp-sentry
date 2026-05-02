import { createRequire } from 'node:module';

// Use createRequire so the version is sourced from the published
// `packages/cli/package.json` in BOTH the CJS and ESM bundles. JSON import
// attributes (`with { type: 'json' }`) are syntactically inconsistent
// across Node 20.x patch releases; createRequire works everywhere.
const require_ = createRequire(import.meta.url);
const pkg = require_('../package.json') as { version: string };

/**
 * mcp-sentry version — the single source of truth for `--version` output,
 * the SARIF `tool.driver.version`, and the `--report` POST payload.
 */
export const VERSION: string = pkg.version;
