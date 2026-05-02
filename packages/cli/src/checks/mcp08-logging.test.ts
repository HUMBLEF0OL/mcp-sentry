import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScan } from '../scanner.js';
import type { ScanOptions } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', '..', 'fixtures');

function baseOpts(p: string): ScanOptions {
	return {
		path: p,
		format: 'json',
		report: false,
		disable: ['MCP04'],
		ignore: [],
	};
}

describe('MCP08 — logging', () => {
	it('flags missing handler logging + missing global error handler on full-vulns', async () => {
		const r = await runScan(baseOpts(path.join(fixtureRoot, 'full-vulns')));
		const m08 = r.findings.filter((f) => f.owaspId === 'MCP08');
		const ids = new Set(m08.map((f) => f.checkId));
		expect(ids.has('MCP08-001')).toBe(true);
		expect(ids.has('MCP08-003')).toBe(true);
	});

	it('does not fire on clean-server (logging + global handler present)', async () => {
		const r = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
		const m08 = r.findings.filter((f) => f.owaspId === 'MCP08');
		expect(m08).toEqual([]);
	});
});
