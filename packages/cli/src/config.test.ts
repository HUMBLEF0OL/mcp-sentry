import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const tmps: string[] = [];

afterEach(async () => {
    for (const t of tmps) await fs.rm(t, { recursive: true, force: true });
    tmps.length = 0;
});

async function makeTmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sentry-cfg-'));
    tmps.push(dir);
    return dir;
}

describe('loadConfig (.mcp-sentry.json)', () => {
    it('returns {} when the file is absent', async () => {
        const dir = await makeTmp();
        const cfg = await loadConfig(dir);
        expect(cfg).toEqual({});
    });

    it('parses a valid file', async () => {
        const dir = await makeTmp();
        await fs.writeFile(
            path.join(dir, '.mcp-sentry.json'),
            JSON.stringify({
                ignore: ['src/fixtures/**'],
                disable: ['MCP08'],
                failOn: 'B',
                format: 'sarif',
                report: { owner: 'acme', repo: 'my-server' },
            }),
        );
        const cfg = await loadConfig(dir);
        expect(cfg.ignore).toEqual(['src/fixtures/**']);
        expect(cfg.disable).toEqual(['MCP08']);
        expect(cfg.failOn).toBe('B');
        expect(cfg.format).toBe('sarif');
        expect(cfg.report).toEqual({ owner: 'acme', repo: 'my-server' });
    });

    it('throws on invalid JSON', async () => {
        const dir = await makeTmp();
        await fs.writeFile(path.join(dir, '.mcp-sentry.json'), '{not-json}');
        await expect(loadConfig(dir)).rejects.toThrow(/failed to parse/);
    });

    it('throws on schema-violating values', async () => {
        const dir = await makeTmp();
        await fs.writeFile(path.join(dir, '.mcp-sentry.json'), JSON.stringify({ failOn: 'Z' }));
        await expect(loadConfig(dir)).rejects.toThrow(/failOn/);
    });
});
