import { describe, expect, it } from 'vitest';
import { compareGrades, computeGrade, gradeBelow } from './grade.js';
import type { CheckResult, Severity } from './types.js';

function f(severity: Severity, suppressed = false, line = 1): CheckResult {
	return {
		checkId: 'X',
		owaspId: 'MCP01',
		severity,
		file: '/x',
		line,
		column: 1,
		message: '',
		fix: '',
		suppressed,
	};
}

describe('computeGrade', () => {
	it('returns A for zero findings', () => {
		const g = computeGrade([]);
		expect(g.grade).toBe('A');
		expect(g.badgeColor).toBe('4c1');
		expect(g.total).toBe(0);
	});

	it('B for 1–2 high', () => {
		expect(computeGrade([f('high'), f('high')]).grade).toBe('B');
	});

	it('C for 3+ high', () => {
		expect(computeGrade([f('high'), f('high'), f('high')]).grade).toBe('C');
	});

	it('D for 1 critical', () => {
		expect(computeGrade([f('critical')]).grade).toBe('D');
	});

	it('F for 2+ critical', () => {
		expect(computeGrade([f('critical'), f('critical')]).grade).toBe('F');
	});

	it('excludes suppressed findings from grade', () => {
		// Two critical but both suppressed → grade A.
		expect(computeGrade([f('critical', true), f('critical', true)]).grade).toBe('A');
	});

	it('does not lower grade below A for a suppressed critical', () => {
		expect(computeGrade([f('critical', true)]).grade).toBe('A');
	});
});

describe('grade comparator', () => {
	it('orders A > B > C > D > F', () => {
		expect(compareGrades('A', 'B')).toBe(1);
		expect(compareGrades('F', 'A')).toBe(-1);
		expect(compareGrades('C', 'C')).toBe(0);
	});

	it('gradeBelow respects the threshold per TSD §7.2', () => {
		expect(gradeBelow('D', 'C')).toBe(true);
		expect(gradeBelow('C', 'C')).toBe(false);
		expect(gradeBelow('B', 'C')).toBe(false);
	});
});
