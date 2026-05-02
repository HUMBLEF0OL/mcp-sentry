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
        disable: ['MCP04'],
        ignore: [],
    };
}

describe('MCP02 — privilege scope', () => {
    it('flags z.any() and unvalidated path on full-vulns fixture', async () => {
        const r = await runScan(baseOpts(path.join(fixtureRoot, 'full-vulns')));
        const m = r.findings.filter((f) => f.owaspId === 'MCP02');
        const ids = new Set(m.map((f) => f.checkId));
        expect(ids.has('MCP02-001')).toBe(true);
        expect(ids.has('MCP02-005')).toBe(true);
    });
});

describe('MCP03 — tool poisoning', () => {
    it('flags shadowed name + hidden instructions on full-vulns fixture', async () => {
        const r = await runScan(baseOpts(path.join(fixtureRoot, 'full-vulns')));
        const m = r.findings.filter((f) => f.owaspId === 'MCP03');
        const ids = new Set(m.map((f) => f.checkId));
        expect(ids.has('MCP03-001')).toBe(true);
        expect(ids.has('MCP03-002')).toBe(true);
    });
});
