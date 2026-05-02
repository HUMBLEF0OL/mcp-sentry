import path from 'node:path';
import chalk from 'chalk';
import { computeGrade } from './grade.js';
import { REGISTRY } from './registry.js';
import type { CheckResult, Grade, ScanOptions, SkippedFile } from './types.js';
import { VERSION } from './version.js';

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

export interface RenderInput {
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
            chalk.bold(`mcp-sentry: ${visible.length} finding(s) across ${scannedFileCount} file(s).`),
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
            chalk.yellow(`Warning: ${skippedFiles.length} file(s) skipped due to parse errors.`),
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
    const summary = chalk.dim(`critical=${critical}  high=${high}  medium=${medium}  low=${low}`);
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

// ---------- SARIF 2.1.0 ----------

const SARIF_INFO_URI = 'https://mcp-sentry.dev';

function severityToSarifLevel(sev: CheckResult['severity']): 'error' | 'warning' | 'note' {
    switch (sev) {
        case 'critical':
        case 'high':
            return 'error';
        case 'medium':
            return 'warning';
        case 'low':
            return 'note';
    }
}

/**
 * Convert an absolute file path into a forward-slash relative URI rooted
 * at `scanPath`. SARIF requires `artifactLocation.uri` to be a valid
 * `uri-reference`, which on Windows means we MUST emit `src/server.js`,
 * not `src\server.js`.
 */
function toRelativeUri(absFile: string, scanPath: string): string {
    let rel = path.relative(scanPath, absFile);
    if (!rel) rel = path.basename(absFile);
    return rel.split(path.sep).join('/');
}

export function renderSarif(input: RenderInput): string {
    const { findings, opts } = input;
    // Build one rule per unique checkId actually fired (TSD §5.3 "rules[]
    // populated from check registry — one rule per unique checkId").
    const ruleIndex = new Map<string, number>();
    const rules: unknown[] = [];
    for (const f of findings) {
        if (ruleIndex.has(f.checkId)) continue;
        const desc = REGISTRY.find((c) => c.owaspId === f.owaspId);
        ruleIndex.set(f.checkId, rules.length);
        rules.push({
            id: f.checkId,
            name: f.checkId.replace(/[^A-Za-z0-9]/g, ''),
            shortDescription: { text: desc?.title ?? f.checkId },
            fullDescription: { text: desc?.description ?? f.message },
            helpUri: f.ruleUrl ?? `https://mcp-sentry.dev/rules/${f.owaspId}`,
            defaultConfiguration: { level: severityToSarifLevel(f.severity) },
            properties: { owaspId: f.owaspId, severity: f.severity },
        });
    }
    const results = findings.map((f) => {
        const result: Record<string, unknown> = {
            ruleId: f.checkId,
            ruleIndex: ruleIndex.get(f.checkId) ?? -1,
            level: severityToSarifLevel(f.severity),
            message: { text: f.message },
            locations: [
                {
                    physicalLocation: {
                        artifactLocation: { uri: toRelativeUri(f.file, opts.path) },
                        region: { startLine: f.line, startColumn: f.column },
                    },
                },
            ],
        };
        if (f.suppressed) {
            result.suppressions = [{ kind: 'inSource' }];
        }
        return result;
    });

    const sarif = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'mcp-sentry',
                        version: VERSION,
                        informationUri: SARIF_INFO_URI,
                        rules,
                    },
                },
                results,
            },
        ],
    };
    return `${JSON.stringify(sarif, null, 2)}\n`;
}

// ---------- Markdown ----------

function badgeUrl(owner: string | undefined, repo: string | undefined, gradeLetter: Grade): string {
    if (owner && repo) {
        return `https://img.shields.io/endpoint?url=https%3A%2F%2Fmcp-sentry.dev%2Fapi%2Fbadge%2F${encodeURIComponent(owner)}%2F${encodeURIComponent(repo)}`;
    }
    return `https://img.shields.io/badge/mcp--sentry-${gradeLetter}-blue?logo=shield`;
}

function escapeMd(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMarkdown(input: RenderInput): string {
    const { findings, opts, scannedFileCount, skippedFiles } = input;
    const grade = computeGrade(findings);
    const lines: string[] = [];

    lines.push(`![mcp-sentry](${badgeUrl(opts.owner, opts.repo, grade.grade)})`);
    lines.push('');
    lines.push('## mcp-sentry Security Scan');
    lines.push('');
    lines.push('| Grade | Critical | High | Medium | Low |');
    lines.push('|-------|----------|------|--------|-----|');
    lines.push(
        `| ${grade.grade} | ${grade.critical} | ${grade.high} | ${grade.medium} | ${grade.low} |`,
    );
    lines.push('');
    if (grade.nextGrade) {
        lines.push(`> ${grade.nextGrade}`);
        lines.push('');
    }

    if (findings.length === 0) {
        lines.push(`_Scanned ${scannedFileCount} file(s); no findings._`);
    } else {
        lines.push('### Findings');
        lines.push('');
        lines.push('| Severity | File | Line | Message | Fix |');
        lines.push('|----------|------|------|---------|-----|');
        const sorted = [...findings].sort(
            (a, b) =>
                SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
                a.file.localeCompare(b.file) ||
                a.line - b.line,
        );
        for (const f of sorted) {
            const rel = toRelativeUri(f.file, opts.path);
            const sevTag = f.suppressed ? `${f.severity} (suppressed)` : f.severity;
            lines.push(
                `| ${sevTag} | \`${escapeMd(rel)}\` | ${f.line} | ${escapeMd(f.message)} | ${escapeMd(f.fix)} |`,
            );
        }
    }
    lines.push('');
    lines.push('### OWASP MCP Top 10 Coverage');
    lines.push('');
    lines.push('| Check | Title | Status |');
    lines.push('|-------|-------|--------|');
    for (const c of REGISTRY) {
        lines.push(`| ${c.owaspId} | ${escapeMd(c.title)} | ${c.status} |`);
    }
    if (skippedFiles.length > 0) {
        lines.push('');
        lines.push(`_Warning: ${skippedFiles.length} file(s) skipped due to parse errors._`);
    }
    lines.push('');
    return lines.join('\n');
}

export function renderForFormat(input: RenderInput): string {
    switch (input.opts.format) {
        case 'json':
            return renderJson(input);
        case 'sarif':
            return renderSarif(input);
        case 'markdown':
            return renderMarkdown(input);
        default:
            return renderText(input);
    }
}
