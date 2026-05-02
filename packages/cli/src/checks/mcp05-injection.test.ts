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
		disable: [],
		ignore: [],
	};
}

describe('MCP05 — command injection', () => {
	it('flags exec() and fs.readFile() reached by tool input on injection-vuln fixture', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'injection-vuln')));
		const mcp05 = report.findings.filter((f) => f.owaspId === 'MCP05');
		expect(mcp05.length).toBeGreaterThanOrEqual(2);
		const exec = mcp05.find((f) => f.checkId === 'MCP05-001');
		expect(exec).toBeDefined();
		expect(exec?.severity).toBe('critical');
		expect(exec?.line).toBeGreaterThan(0);
		expect(exec?.column).toBeGreaterThan(0);
		expect(exec?.file).toMatch(/injection-vuln/);
		expect(exec?.suppressed).toBe(false);

		const fsRead = mcp05.find((f) => f.checkId === 'MCP05-002');
		expect(fsRead).toBeDefined();
	});

	it('produces zero findings on clean-server fixture', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
		expect(report.findings).toEqual([]);
		expect(report.skippedFiles).toEqual([]);
	});
});

describe('MCP06 — deferred stub', () => {
	it('emits no findings and does not throw', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
		const mcp06 = report.findings.filter((f) => f.owaspId === 'MCP06');
		expect(mcp06).toEqual([]);
	});
});
