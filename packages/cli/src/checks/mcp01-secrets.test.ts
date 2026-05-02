import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScan } from '../scanner.js';
import { __testables } from './mcp01-secrets.js';
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

describe('MCP01 — secrets (fixture)', () => {
    it('flags hardcoded vendor tokens in secrets-exposed fixture', async () => {
        const r = await runScan(baseOpts(path.join(fixtureRoot, 'secrets-exposed')));
        const m = r.findings.filter((f) => f.owaspId === 'MCP01');
        expect(m.length).toBeGreaterThanOrEqual(3);
        expect(m.every((f) => f.severity === 'critical')).toBe(true);
        const ids = new Set(m.map((f) => f.checkId));
        expect(ids.has('MCP01-ANTHROPIC')).toBe(true);
        expect(ids.has('MCP01-GH-CLASSIC')).toBe(true);
        expect(ids.has('MCP01-AWS-AK')).toBe(true);
    });

    it('does not fire on clean-server', async () => {
        const r = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
        expect(r.findings.filter((f) => f.owaspId === 'MCP01')).toEqual([]);
    });
});

/**
 * Parametric vendor-pattern matrix. Each row asserts that `positive` triggers
 * the named pattern AND that `negative` does NOT. The pattern set was expanded
 * from 18 → 40 in audit fix #2; this matrix is the regression net for typos
 * in those regexes. New patterns MUST add a row here.
 */
interface PatternCase {
    id: string;
    positive: string;
    negative?: string;
}

const CASES: PatternCase[] = [
    { id: 'MCP01-AWS-AK', positive: 'token = "AKIAIOSFODNN7TESTKEY";', negative: 'token = "AKIAshort";' },
    { id: 'MCP01-ANTHROPIC', positive: 'const k="sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";' },
    {
        id: 'MCP01-OPENAI',
        positive: 'const k = "sk-proj-AAAAAAAAAAAAAAAAAAA_FAKEKEY_BBBBBBBBBBBBBBBB";',
        negative: 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
    },
    { id: 'MCP01-GH-PAT', positive: 'const t="github_test_11AAAAAAA0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";' },
    { id: 'MCP01-GH-CLASSIC', positive: 'const t = "gtest_1234567890abcdefghijklmnopqrstuvwxAB";' },
    { id: 'MCP01-GOOGLE', positive: 'const k="AIzaFAKEDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI";' },
    { id: 'MCP01-GCP-OAUTH', positive: 'secret = GOTEST_Bu5Lp7HTvYCAbcDefGhIjKlMnOpQ' },
    { id: 'MCP01-SLACK', positive: 'const t="xtest-1234567890-abcdefghij";' },
    {
        id: 'MCP01-SLACK-WEBHOOK',
        positive: 'url = "https://hooks.slack.com/services/T0123ABCD/B0123ABCD/FAKETOKENNOTREALATALL0000"',
    },
    { id: 'MCP01-STRIPE', positive: 'const k="rk_faux_aaaaaaaaaaaaaaaaaaaaaaaa";' },
    { id: 'MCP01-NPM', positive: 'const t="ntest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";' },
    { id: 'MCP01-GITLAB', positive: 'const t="gltest-aBcDeFgHiJkLmNoPqRsT";' },
    {
        id: 'MCP01-JWT',
        positive: 'auth = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.FAKE_SIGNATURE_TEST_ONLY_adQssw5c"',
    },
    { id: 'MCP01-AZURE', positive: 'AccountKey=' + 'A'.repeat(80) + ';' },
    { id: 'MCP01-SENDGRID', positive: 'const k="SGTEST.AAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";' },
    { id: 'MCP01-MAILGUN', positive: 'const k="ktest-abcdef0123456789abcdef0123456789";' },
    { id: 'MCP01-TWILIO-SID', positive: 'const sid="ACFAKE_TESTONLY0000abcdef01234567";' },
    { id: 'MCP01-TWILIO-AUTH', positive: 'const t="SKFAKE_TESTONLY0000abcdef01234567";' },
    {
        id: 'MCP01-DIGITALOCEAN',
        positive: 'const t = "dop_v1_' + 'a'.repeat(64) + '";',
    },
    { id: 'MCP01-NEWRELIC', positive: 'const k="NRTEST-ABCDEFGHIJKLMNOPQRSTUVWXY12";' },
    { id: 'MCP01-POSTMAN', positive: 'const k="PMAK-' + 'a'.repeat(24) + '-' + 'b'.repeat(34) + '";' },
    { id: 'MCP01-SENTRY', positive: 'dsn = "https://abcdef0123456789abcdef0123456789@o12345.FAKE.sentry.io/12345"' },
    { id: 'MCP01-SHOPIFY', positive: 'const t="shtest_abcdef0123456789abcdef0123456789";' },
    { id: 'MCP01-MAPBOX', positive: 'const k="sk.eyJ1' + 'a'.repeat(70) + '";' },
    { id: 'MCP01-ATLASSIAN', positive: 'const t="ATATT3x' + 'A'.repeat(185) + '";' },
    { id: 'MCP01-NOTION', positive: 'const t="secret_' + 'a'.repeat(43) + '";' },
    { id: 'MCP01-LINEAR', positive: 'const t="lin_api_' + 'a'.repeat(40) + '";' },
    { id: 'MCP01-DOCKER', positive: 'const t="dckr_pat_' + 'a'.repeat(27) + '";' },
];

describe('MCP01 — vendor-pattern matrix', () => {
    for (const c of CASES) {
        it(`${c.id}: positive sample matches`, () => {
            const hits = __testables.scanText(c.positive);
            const ids = hits.map((h) => h.patternId);
            expect(ids, `expected ${c.id} in ${ids.join(',') || '<none>'}`).toContain(c.id);
        });
        if (c.negative !== undefined) {
            it(`${c.id}: negative sample does not match`, () => {
                const hits = __testables.scanText(c.negative ?? '');
                expect(hits.map((h) => h.patternId)).not.toContain(c.id);
            });
        }
    }

    it('a single modern OpenAI key produces exactly one finding (no OPENAI/OPENAI-LEGACY overlap)', () => {
        const sample = 'const k = "sk-proj-AAAAAAAAAAAAAAAAAAA_FAKEKEY_BBBBBBBBBBBBBBBB";';
        const hits = __testables.scanText(sample);
        const openai = hits.filter(
            (h) => h.patternId === 'MCP01-OPENAI' || h.patternId === 'MCP01-OPENAI-LEGACY',
        );
        expect(openai).toHaveLength(1);
        expect(openai[0]?.patternId).toBe('MCP01-OPENAI');
    });

    it('Discord regex has bounded tail (does not match arbitrary long dotted ids)', () => {
        const arbitrary = 'M' + 'a'.repeat(23) + '.aaaaaa.' + 'b'.repeat(200);
        const hits = __testables.scanText(arbitrary);
        expect(hits.map((h) => h.patternId)).not.toContain('MCP01-DISCORD');
    });
});

