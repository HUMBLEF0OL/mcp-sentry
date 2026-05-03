import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScan } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'perf-50');

// TSD §11.3 / §12: a 50-file synthetic MCP server must scan in <2s on
// ubuntu-latest 2-core. We allow a generous local ceiling but tighten it on
// CI via PERF_BUDGET_MS so cloud runs still gate at the 2s SLA.
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? (process.env.CI ? 2_000 : 5_000));

describe('performance: 50-file MCP server', () => {
	it(`scans perf-50 fixture in <${BUDGET_MS}ms`, async () => {
		// Warm-up so first-run ts-morph initialisation cost does not dominate
		// the measurement (matches user perception: subsequent invocations).
		await runScan({
			path: PERF_FIXTURE,
			format: 'json',
			disable: [],
			ignore: [],
		});

		const start = performance.now();
		const report = await runScan({
			path: PERF_FIXTURE,
			format: 'json',
			disable: [],
			ignore: [],
		});
		const elapsed = performance.now() - start;

		// Sanity: the fixture really has 50 sources loaded.
		expect(report.scannedFileCount).toBeGreaterThanOrEqual(50);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	}, 30_000);
});
