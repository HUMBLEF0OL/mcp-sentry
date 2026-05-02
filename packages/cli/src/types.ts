import type { Project, SourceFile } from 'ts-morph';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Format = 'text' | 'json' | 'sarif' | 'markdown';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ScanOptions {
    /** Resolved absolute path to scan root. */
    path: string;
    format: Format;
    /** File path for --output / -o (stdout if absent). */
    output?: string;
    /** --report flag: POST grade to badge API. */
    report: boolean;
    /** Exit 1 if grade below this. */
    failOn?: Grade;
    /** OWASP check IDs to skip, e.g. ['MCP08']. */
    disable: string[];
    /** Glob patterns to exclude from scanning. */
    ignore: string[];
    /** GitHub owner for --report (env: GITHUB_REPOSITORY). */
    owner?: string;
    /** GitHub repo for --report. */
    repo?: string;
}

export interface CheckResult {
    checkId: string;
    owaspId: string;
    severity: Severity;
    /** Absolute path. */
    file: string;
    /** 1-indexed. */
    line: number;
    /** 1-indexed. */
    column: number;
    message: string;
    fix: string;
    ruleUrl?: string;
    /** True if a `mcp-sentry-ignore` comment is on the line. */
    suppressed: boolean;
}

export type CheckFn = (
    project: Project,
    files: SourceFile[],
    opts: ScanOptions,
) => Promise<CheckResult[]>;

export type CheckStatus = 'active' | 'deferred-v1.1';

export interface CheckDescriptor {
    owaspId: string;
    title: string;
    description: string;
    /** Severities the check may emit. */
    severities: Severity[];
    status: CheckStatus;
    run: CheckFn;
}

export interface GradeResult {
    grade: Grade;
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
    nextGrade?: string;
    badgeColor: string;
}

export interface SkippedFile {
    file: string;
    reason: string;
}
