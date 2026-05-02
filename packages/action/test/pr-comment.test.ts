import { describe, expect, it } from 'vitest';
// CommonJS interop — pr-comment.js exports the function and `.buildBody`.
import prComment from '../src/pr-comment.js';

const { buildBody } = prComment as unknown as {
	buildBody: (report: Record<string, unknown>, minGrade: string) => string;
};

function makeReport(
	grade: {
		grade: string;
		critical?: number;
		high?: number;
		medium?: number;
		low?: number;
		nextGrade?: string;
	},
	findings: unknown[] = [],
): Record<string, unknown> {
	return {
		schemaVersion: '1.0',
		timestamp: '2026-05-02T10:30:00Z',
		scanPath: '/x',
		scannedFileCount: 1,
		grade: {
			grade: grade.grade,
			critical: grade.critical ?? 0,
			high: grade.high ?? 0,
			medium: grade.medium ?? 0,
			low: grade.low ?? 0,
			...(grade.nextGrade ? { nextGrade: grade.nextGrade } : {}),
		},
		skippedFiles: [],
		findings,
	};
}

describe('buildBody', () => {
	it('renders the grade table and marker', () => {
		const body = buildBody(makeReport({ grade: 'B', high: 1, medium: 2, low: 3 }), 'C');
		expect(body).toContain('<!-- mcp-sentry-action -->');
		expect(body).toContain('| **B** | 0 | 1 | 2 | 3 |');
		expect(body).toContain('passing');
	});

	it('marks failing when grade is below threshold', () => {
		const body = buildBody(
			makeReport({ grade: 'D', critical: 1 }, [
				{
					severity: 'critical',
					file: 'src/tools.ts',
					line: 42,
					message: 'Tool input flows into exec()',
					fix: 'Sanitise input via execFile',
					suppressed: false,
				},
			]),
			'C',
		);
		expect(body).toContain('failing');
		expect(body).toContain('### Critical Findings');
		expect(body).toContain('src/tools.ts');
		expect(body).toContain('Tool input flows into exec()');
	});

	it('escapes pipe characters in finding cells', () => {
		const body = buildBody(
			makeReport({ grade: 'D', critical: 1 }, [
				{
					severity: 'critical',
					file: 'a|b.ts',
					line: 1,
					message: 'msg | with | pipes',
					fix: 'fix',
					suppressed: false,
				},
			]),
			'C',
		);
		expect(body).toContain('a\\|b.ts');
		expect(body).toContain('msg \\| with \\| pipes');
	});

	it('renders nextGrade hint when present on grade object', () => {
		const body = buildBody(
			makeReport({ grade: 'C', high: 3, nextGrade: 'Fix 1 high finding to reach grade B' }),
			'C',
		);
		expect(body).toContain('> Fix 1 high finding to reach grade B');
	});
});
