import type { CheckResult, Grade, GradeResult } from './types.js';

const GRADE_COLOR: Record<Grade, string> = {
	A: '4c1',
	B: '97CA00',
	C: 'dfb317',
	D: 'fe7d37',
	F: 'e05d44',
};

const GRADE_ORDER: Grade[] = ['A', 'B', 'C', 'D', 'F'];

/**
 * Compute the headline grade per TSD §4.1. Suppressed findings are excluded
 * entirely from severity counts and grading.
 */
export function computeGrade(results: CheckResult[]): GradeResult {
	let critical = 0;
	let high = 0;
	let medium = 0;
	let low = 0;
	for (const r of results) {
		if (r.suppressed) continue;
		switch (r.severity) {
			case 'critical':
				critical++;
				break;
			case 'high':
				high++;
				break;
			case 'medium':
				medium++;
				break;
			case 'low':
				low++;
				break;
		}
	}
	let grade: Grade;
	if (critical >= 2) grade = 'F';
	else if (critical === 1) grade = 'D';
	else if (high >= 3) grade = 'C';
	else if (high >= 1) grade = 'B';
	else grade = 'A';

	return {
		grade,
		critical,
		high,
		medium,
		low,
		total: critical + high + medium + low,
		nextGrade: nextGradeHint(grade, critical, high),
		badgeColor: GRADE_COLOR[grade],
	};
}

function nextGradeHint(grade: Grade, critical: number, high: number): string | undefined {
	if (grade === 'A') return undefined;
	if (grade === 'F') {
		const need = critical - 1;
		return `Fix ${need} critical finding${need === 1 ? '' : 's'} to reach grade D`;
	}
	if (grade === 'D') return 'Fix 1 critical finding to reach grade C or higher';
	if (grade === 'C') {
		const need = high - 2;
		return `Fix ${need} high finding${need === 1 ? '' : 's'} to reach grade B`;
	}
	if (grade === 'B') {
		return `Fix ${high} high finding${high === 1 ? '' : 's'} to reach grade A`;
	}
	return undefined;
}

/**
 * Return -1 / 0 / 1 comparing two grades using order A>B>C>D>F. A higher
 * (better) grade returns 1.
 */
export function compareGrades(a: Grade, b: Grade): number {
	const ai = GRADE_ORDER.indexOf(a);
	const bi = GRADE_ORDER.indexOf(b);
	// Lower index = better grade. Invert so "better" returns positive.
	if (ai < bi) return 1;
	if (ai > bi) return -1;
	return 0;
}

/** Returns true when `actual` is strictly worse than `threshold`. */
export function isBelowThreshold(actual: Grade, threshold: Grade): boolean {
	return compareGrades(actual, threshold) < 0;
}
