#!/usr/bin/env node
import { main } from './index.js';

main().catch((err) => {
	process.stderr.write(
		`mcp-sentry: fatal error — ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(2);
});
