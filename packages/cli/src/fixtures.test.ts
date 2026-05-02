import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScan } from './scanner.js';
import type { CheckResult, ScanOptions } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', 'fixtures');

interface Manifest {
	expectedFindings: Array<{ owaspId: string; checkId: string; severity: string }>;
}

function baseOpts(p: string): ScanOptions {
	return {
		path: p,
		format: 'json',
		report: false,
		disable: [],
		ignore: [],
	};
}

/**
 * Project a finding to the (owaspId, checkId, severity) triple that the
 * fixture manifest fixes. Line/column drift in fixture sources should not
 * break the manifest, but every expected (id, severity) MUST appear at least
 * once and no UNEXPECTED checkId may appear.
 */
function projectIds(findings: CheckResult[]): Set<string> {
	return new Set(findings.map((f) => `${f.owaspId}/${f.checkId}/${f.severity}`));
}

function expectedIds(m: Manifest): Set<string> {
	return new Set(m.expectedFindings.map((e) => `${e.owaspId}/${e.checkId}/${e.severity}`));
}

async function loadManifest(fixtureName: string): Promise<Manifest> {
	const file = path.join(fixtureRoot, fixtureName, `${fixtureName}.expected.json`);
	const raw = await fs.readFile(file, 'utf8');
	return JSON.parse(raw) as Manifest;
}

describe('fixture expected.json manifests', () => {
	it('clean-server matches manifest exactly (MCP04 enabled — bare package.json must not fire)', async () => {
		const fixture = path.join(fixtureRoot, 'clean-server');
		const r = await runScan(baseOpts(fixture));
		const m = await loadManifest('clean-server');
		expect(r.findings).toEqual([]);
		expect(m.expectedFindings).toEqual([]);
	});

	it('injection-vuln contains every expected finding', async () => {
		const fixture = path.join(fixtureRoot, 'injection-vuln');
		const r = await runScan({ ...baseOpts(fixture), disable: ['MCP04'] });
		const m = await loadManifest('injection-vuln');
		const got = projectIds(r.findings);
		for (const id of expectedIds(m)) {
			expect(got, `expected ${id} on injection-vuln`).toContain(id);
		}
	});

	it('secrets-exposed contains every expected finding', async () => {
		const fixture = path.join(fixtureRoot, 'secrets-exposed');
		const r = await runScan({ ...baseOpts(fixture), disable: ['MCP04'] });
		const m = await loadManifest('secrets-exposed');
		const got = projectIds(r.findings);
		for (const id of expectedIds(m)) {
			expect(got, `expected ${id} on secrets-exposed`).toContain(id);
		}
	});

	it('full-vulns contains every expected finding', async () => {
		const fixture = path.join(fixtureRoot, 'full-vulns');
		// MCP04 enabled here; no lockfile is part of the manifest.
		const r = await runScan(baseOpts(fixture));
		const m = await loadManifest('full-vulns');
		const got = projectIds(r.findings);
		for (const id of expectedIds(m)) {
			expect(got, `expected ${id} on full-vulns`).toContain(id);
		}
	});

	it('full-vulns produces no MCP01 findings (no real secrets in fixture)', async () => {
		// Drift guard: secrets must never leak into the full-vulns fixture.
		const fixture = path.join(fixtureRoot, 'full-vulns');
		const r = await runScan(baseOpts(fixture));
		const m01 = r.findings.filter((f) => f.owaspId === 'MCP01');
		expect(m01).toEqual([]);
	});
});
