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

describe('MCP07 — auth', () => {
	it('flags HTTP transport without auth on full-vulns', async () => {
		const r = await runScan(baseOpts(path.join(fixtureRoot, 'full-vulns')));
		const m07 = r.findings.filter((f) => f.owaspId === 'MCP07');
		expect(m07.length).toBeGreaterThanOrEqual(1);
		expect(m07[0]?.severity).toBe('high');
	});

	it('does not fire on stdio-only fixture (negative case, TSD §3.4 MCP07)', async () => {
		const r = await runScan(baseOpts(path.join(fixtureRoot, 'stdio-only')));
		const m07 = r.findings.filter((f) => f.owaspId === 'MCP07');
		expect(m07).toEqual([]);
	});
});
