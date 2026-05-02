import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { renderJson, renderMarkdown, renderSarif } from './reporter.js';
import sarifSchema from './schemas/sarif-2.1.0.json';
import type { CheckResult, ScanOptions, SkippedFile } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function opts(scanPath: string, owner?: string, repo?: string): ScanOptions {
    return {
        path: scanPath,
        format: 'sarif',
        report: false,
        disable: [],
        ignore: [],
        owner,
        repo,
    };
}

const SAMPLE: CheckResult[] = [
    {
        checkId: 'MCP05-001',
        owaspId: 'MCP05',
        severity: 'critical',
        file: path.join(here, '..', 'fixtures', 'injection-vuln', 'src', 'server.js'),
        line: 42,
        column: 12,
        message: 'Tool input flows unsanitised into exec().',
        fix: 'Validate input.',
        ruleUrl: 'https://mcp-sentry.dev/rules/MCP05',
        suppressed: false,
    },
    {
        checkId: 'MCP08-001',
        owaspId: 'MCP08',
        severity: 'medium',
        file: path.join(here, '..', 'fixtures', 'injection-vuln', 'src', 'server.js'),
        line: 10,
        column: 1,
        message: 'No logging in tool handler.',
        fix: 'Add logger.info(...).',
        suppressed: true,
    },
];

const SKIPPED: SkippedFile[] = [];

describe('SARIF reporter', () => {
    it('produces a SARIF 2.1.0 document that validates against the published schema', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);
        const validate = ajv.compile(sarifSchema as object);
        const sarif = JSON.parse(
            renderSarif({
                opts: opts(path.join(here, '..', 'fixtures', 'injection-vuln')),
                findings: SAMPLE,
                skippedFiles: SKIPPED,
                scannedFileCount: 1,
            }),
        );
        const ok = validate(sarif);
        if (!ok) {
            console.error(validate.errors);
        }
        expect(ok).toBe(true);
        expect(sarif.runs[0].tool.driver.name).toBe('mcp-sentry');
        expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toMatch(
            /^src\/server\.js$/,
        );
        expect(sarif.runs[0].results[1].suppressions).toEqual([{ kind: 'inSource' }]);
    });

    it('maps severities critical/high → error, medium → warning, low → note', () => {
        const sarif = JSON.parse(
            renderSarif({
                opts: opts(path.join(here, '..', 'fixtures', 'injection-vuln')),
                findings: SAMPLE,
                skippedFiles: SKIPPED,
                scannedFileCount: 1,
            }),
        );
        expect(sarif.runs[0].results[0].level).toBe('error');
        expect(sarif.runs[0].results[1].level).toBe('warning');
    });

    it('emits exactly one rule per unique checkId', () => {
        const seed = SAMPLE[0];
        if (!seed) throw new Error('SAMPLE must not be empty');
        const sarif = JSON.parse(
            renderSarif({
                opts: opts(path.join(here, '..', 'fixtures', 'injection-vuln')),
                findings: [...SAMPLE, { ...seed }],
                skippedFiles: SKIPPED,
                scannedFileCount: 1,
            }),
        );
        const rules = sarif.runs[0].tool.driver.rules;
        const ids = rules.map((r: { id: string }) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain('MCP05-001');
        expect(ids).toContain('MCP08-001');
    });
});

describe('Markdown reporter', () => {
    it('emits Shields endpoint badge URL when owner/repo set', () => {
        const md = renderMarkdown({
            opts: opts(path.join(here, '..'), 'acme', 'my-server'),
            findings: SAMPLE,
            skippedFiles: SKIPPED,
            scannedFileCount: 1,
        });
        expect(md).toMatch(
            /img\.shields\.io\/endpoint\?url=https%3A%2F%2Fmcp-sentry\.dev%2Fapi%2Fbadge%2Facme%2Fmy-server/,
        );
        expect(md).toMatch(/## mcp-sentry Security Scan/);
        expect(md).toMatch(/OWASP MCP Top 10 Coverage/);
        expect(md).toMatch(/MCP05/);
    });

    it('falls back to a static badge when owner/repo unknown', () => {
        const md = renderMarkdown({
            opts: opts(path.join(here, '..')),
            findings: [],
            skippedFiles: SKIPPED,
            scannedFileCount: 0,
        });
        expect(md).toMatch(/img\.shields\.io\/badge\/mcp--sentry-A-blue/);
        expect(md).toMatch(/no findings/);
    });
});

describe('JSON reporter', () => {
    it('includes schemaVersion 1.0, ISO timestamp, scanPath, skippedFiles, findings', () => {
        const j = JSON.parse(
            renderJson({
                opts: opts('/tmp/scan'),
                findings: SAMPLE,
                skippedFiles: [{ file: '/tmp/scan/bad.ts', reason: 'parse' }],
                scannedFileCount: 1,
            }),
        );
        expect(j.schemaVersion).toBe('1.0');
        expect(j.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(j.scanPath).toBe('/tmp/scan');
        expect(j.skippedFiles).toHaveLength(1);
        expect(j.findings).toHaveLength(2);
        expect(j.findings[1].suppressed).toBe(true);
    });
});
