#!/usr/bin/env node
// Asserts the published `mcp-sentry` package tarball stays under 5 MB. Run
// from `packages/cli` (Plan §10.1, §12). Uses `npm pack --dry-run --json`
// because that exactly mirrors what `npx mcp-sentry` would download.
//
// Exit codes: 0 = ok, 1 = over budget, 2 = unable to measure.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5_000_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..', 'packages', 'cli');

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
	cwd: pkgDir,
	shell: process.platform === 'win32',
	encoding: 'utf8',
});

if (result.status !== 0) {
	process.stderr.write(`npm pack failed (exit ${result.status}):\n${result.stderr}\n`);
	process.exit(2);
}

let entries;
try {
	entries = JSON.parse(result.stdout);
} catch (err) {
	process.stderr.write(`Could not parse npm pack output: ${err.message}\n`);
	process.exit(2);
}

const first = Array.isArray(entries) ? entries[0] : entries;
if (!first || typeof first.unpackedSize !== 'number') {
	process.stderr.write('npm pack output missing unpackedSize.\n');
	process.exit(2);
}

const { unpackedSize, size, filename } = first;
process.stdout.write(`${filename}: tar=${size}B, unpacked=${unpackedSize}B (cap=${MAX_BYTES}B)\n`);

if (unpackedSize >= MAX_BYTES) {
	process.stderr.write(`Bundle exceeds ${MAX_BYTES}B unpacked — investigate before release.\n`);
	process.exit(1);
}
