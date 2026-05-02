import chalk from 'chalk';
import { computeGrade } from './grade.js';
import type { CheckResult, Grade, ScanOptions, SkippedFile } from './types.js';

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function sevColor(s: CheckResult['severity']): (text: string) => string {
    switch (s) {
        case 'critical':
            return chalk.red.bold;
        case 'high':
            return chalk.red;
        case 'medium':
            return chalk.yellow;
        case 'low':
            return chalk.gray;
    }
}

function gradeColor(g: Grade): (text: string) => string {
    switch (g) {
        case 'A':
            return chalk.green.bold;
        case 'B':
            return chalk.green;
        case 'C':
            return chalk.yellow;
        case 'D':
            return chalk.hex('#fe7d37');
        case 'F':
            return chalk.red.bold;
    }
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

interface RenderInput {
    opts: ScanOptions;
    findings: CheckResult[];
    skippedFiles: SkippedFile[];
    scannedFileCount: number;
}

export function renderText(input: RenderInput): string {
    const { findings, scannedFileCount, skippedFiles } = input;
    const grade = computeGrade(findings);
    const lines: string[] = [];

    const visible = [...findings].sort(
        (a, b) =>
            SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
            a.file.localeCompare(b.file) ||
            a.line - b.line,
    );

    if (visible.length === 0) {
        lines.push(chalk.green(`mcp-sentry: scanned ${scannedFileCount} file(s) — no findings.`));
    } else {
        lines.push(
            chalk.bold(
                `mcp-sentry: ${visible.length} finding(s) across ${scannedFileCount} file(s).`,
            ),
        );
        lines.push('');
        for (const f of visible) {
            const sev = sevColor(f.severity)(pad(f.severity.toUpperCase(), 8));
            const id = chalk.dim(pad(f.checkId, 14));
            const loc = chalk.cyan(`${f.file}:${f.line}:${f.column}`);
            const tag = f.suppressed ? chalk.dim(' [suppressed]') : '';
            lines.push(`${sev} ${id} ${loc}${tag}`);
            lines.push(`         ${f.message}`);
            lines.push(chalk.dim(`         fix: ${f.fix}`));
        }
        lines.push('');
    }

    const box = renderGradeBox(grade.grade, grade.critical, grade.high, grade.medium, grade.low);
    lines.push(...box);
    if (grade.nextGrade) lines.push(chalk.dim(grade.nextGrade));

    if (skippedFiles.length > 0) {
        lines.push(
            chalk.yellow(
                `Warning: ${skippedFiles.length} file(s) skipped due to parse errors.`,
            ),
        );
    }

    return `${lines.join('\n')}\n`;
}

function renderGradeBox(
    grade: Grade,
    critical: number,
    high: number,
    medium: number,
    low: number,
): string[] {
    const colour = gradeColor(grade);
    const top = '┌────────────┐';
    const mid = `│   Grade ${colour(grade)}  │`;
    const bot = '└────────────┘';
    const summary = chalk.dim(
        `critical=${critical}  high=${high}  medium=${medium}  low=${low}`,
    );
    return [top, mid, bot, summary];
}

export function renderJson(input: RenderInput): string {
    const grade = computeGrade(input.findings);
    const payload = {
        schemaVersion: '1.0',
        timestamp: new Date().toISOString(),
        scanPath: input.opts.path,
        scannedFileCount: input.scannedFileCount,
        grade: {
            grade: grade.grade,
            critical: grade.critical,
            high: grade.high,
            medium: grade.medium,
            low: grade.low,
        },
        skippedFiles: input.skippedFiles,
        findings: input.findings,
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
}
