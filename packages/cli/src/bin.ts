#!/usr/bin/env node
// The relative import is rewritten by tsup at build time so each format
// resolves to its sibling library bundle (./index.cjs for CJS,
// ./index.mjs for ESM). See tsup.config.ts (`replaceNodeEnv` block).
import { main } from './index.js';

main().catch((err) => {
	process.stderr.write(
		`mcp-sentry: fatal error — ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(2);
});
