import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseOwnerRepo } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// G2: Commander/-fail-on/-G6 may set `process.exitCode`. vitest does not
// reset it between tests, so a single mutation would propagate and the
// runner would exit non-zero even when every assertion passed.
afterEach(() => {
    process.exitCode = 0;
});

describe('CLI flag wiring', () => {
    it('does not register a -v short flag (reserved per TSD §8.0)', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`__exit:${code ?? 0}`);
        }) as never);
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await expect(main(['node', 'mcp-sentry', '-v'])).rejects.toThrow(/__exit:1/);
            const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stderr).toMatch(/unknown option/i);
        } finally {
            exitSpy.mockRestore();
            errSpy.mockRestore();
        }
    });

    it('-V prints version and exits 0', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`__exit:${code ?? 0}`);
        }) as never);
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await expect(main(['node', 'mcp-sentry', '-V'])).rejects.toThrow(/__exit:0/);
            const stdout = outSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stdout).toMatch(/\d+\.\d+\.\d+/);
        } finally {
            exitSpy.mockRestore();
            outSpy.mockRestore();
        }
    });

    it('accepts --format sarif (Phase 3)', async () => {
        const fixture = path.resolve(here, '..', 'fixtures', 'clean-server');
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await main([
                'node',
                'mcp-sentry',
                '--format',
                'sarif',
                'scan',
                fixture,
                '--disable',
                'MCP04',
            ]);
            const stdout = outSpy.mock.calls.map((c) => String(c[0])).join('');
            const j = JSON.parse(stdout);
            expect(j.version).toBe('2.1.0');
            expect(j.runs[0].tool.driver.name).toBe('mcp-sentry');
        } finally {
            outSpy.mockRestore();
        }
    });

    it('accepts --format markdown (Phase 3)', async () => {
        const fixture = path.resolve(here, '..', 'fixtures', 'clean-server');
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await main([
                'node',
                'mcp-sentry',
                '--format',
                'markdown',
                'scan',
                fixture,
                '--disable',
                'MCP04',
            ]);
            const stdout = outSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stdout).toMatch(/## mcp-sentry Security Scan/);
            expect(stdout).toMatch(/!\[mcp-sentry\]/);
        } finally {
            outSpy.mockRestore();
        }
    });
});

describe('parseOwnerRepo', () => {
    it('parses GITHUB_REPOSITORY=acme/my-server', () => {
        const r = parseOwnerRepo({ GITHUB_REPOSITORY: 'acme/my-server' });
        expect(r).toEqual({ owner: 'acme', repo: 'my-server' });
    });

    it('returns undefined when GITHUB_REPOSITORY is unset', () => {
        expect(parseOwnerRepo({})).toBeUndefined();
    });

    it('returns undefined for malformed values (no slash)', () => {
        expect(parseOwnerRepo({ GITHUB_REPOSITORY: 'acme' })).toBeUndefined();
    });

    it('returns undefined for empty owner or repo', () => {
        expect(parseOwnerRepo({ GITHUB_REPOSITORY: '/repo' })).toBeUndefined();
        expect(parseOwnerRepo({ GITHUB_REPOSITORY: 'owner/' })).toBeUndefined();
    });

    it('trims trailing whitespace / newlines (G5)', () => {
        expect(parseOwnerRepo({ GITHUB_REPOSITORY: 'acme/my-server\n' })).toEqual({
            owner: 'acme',
            repo: 'my-server',
        });
        expect(parseOwnerRepo({ GITHUB_REPOSITORY: '  acme/my-server  ' })).toEqual({
            owner: 'acme',
            repo: 'my-server',
        });
    });
});

describe('--output writes report to file', () => {
    it('writes JSON output to the specified file (and not stdout)', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sentry-'));
        const outFile = path.join(tmpDir, 'report.json');
        const fixture = path.resolve(here, '..', 'fixtures', 'clean-server');
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await main([
                'node',
                'mcp-sentry',
                '--format',
                'json',
                'scan',
                fixture,
                '--disable',
                'MCP04',
                '-o',
                outFile,
            ]);
            const text = await fs.readFile(outFile, 'utf8');
            const j = JSON.parse(text);
            expect(j.schemaVersion).toBe('1.0');
            expect(j.findings).toEqual([]);
            // stdout did NOT receive the rendered report
            const stdout = outSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stdout).not.toContain('"schemaVersion"');
        } finally {
            outSpy.mockRestore();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('strips ANSI and box-drawing characters in -o text mode (G4)', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sentry-'));
        const outFile = path.join(tmpDir, 'report.txt');
        const fixture = path.resolve(here, '..', 'fixtures', 'clean-server');
        try {
            await main(['node', 'mcp-sentry', 'scan', fixture, '--disable', 'MCP04', '-o', outFile]);
            const text = await fs.readFile(outFile, 'utf8');
            const esc = String.fromCharCode(0x1b);
            expect(text.includes(`${esc}[`)).toBe(false);
            expect(text).not.toMatch(/[\u2500-\u257F]/);
            expect(text).toMatch(/Grade A/);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('--report (Phase 3)', () => {
    it('skips POST and warns when owner/repo is unknown', async () => {
        const prevEnv = process.env.GITHUB_REPOSITORY;
        Reflect.deleteProperty(process.env, 'GITHUB_REPOSITORY');
        const fixture = path.resolve(here, '..', 'fixtures', 'clean-server');
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await main(['node', 'mcp-sentry', 'scan', fixture, '--disable', 'MCP04', '--report']);
            const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stderr).toMatch(/owner\/repo not set/);
        } finally {
            errSpy.mockRestore();
            outSpy.mockRestore();
            if (prevEnv !== undefined) process.env.GITHUB_REPOSITORY = prevEnv;
        }
    });
});

describe('default-path footgun guard (G6)', () => {
    it('refuses to scan an unbounded tree when no package.json is at cwd', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sentry-no-pkg-'));
        const prevCwd = process.cwd();
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            process.chdir(tmpDir);
            await main(['node', 'mcp-sentry', 'scan']);
            expect(process.exitCode).toBe(2);
            const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(stderr).toMatch(/refusing to scan/);
        } finally {
            process.chdir(prevCwd);
            errSpy.mockRestore();
            outSpy.mockRestore();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
