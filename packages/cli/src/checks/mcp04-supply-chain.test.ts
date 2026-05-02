import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import mcp04, { __testables } from './mcp04-supply-chain.js';
import type { ScanOptions } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', '..', 'fixtures');

function baseOpts(p: string): ScanOptions {
	return {
		path: p,
		format: 'json',
		report: false,
		disable: [],
		ignore: [],
	};
}

describe('MCP04 — supply chain', () => {
	it('flags caret/star ranges on full-vulns fixture', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: project unused by check
		const findings = await mcp04(undefined as any, [], baseOpts(path.join(fixtureRoot, 'full-vulns')));
		const ids = new Set(findings.map((f) => f.checkId));
		expect(ids.has('MCP04-002')).toBe(true); // unbounded "*"
		expect(ids.has('MCP04-003')).toBe(true); // caret
		// NOTE: We deliberately do not assert MCP04-004 here because
		// `detectLockfile` walks to the filesystem root for monorepo
		// support (G1) and our own repo's `pnpm-lock.yaml` lives several
		// levels up. A dedicated isolated-tmp-dir test below covers the
		// missing-lockfile case.
	}, 15_000);

	it('emits MCP04-004 in an isolated tree with no lockfile (G1 negative)', async () => {
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcps-nolock-'));
		await fs.writeFile(
			path.join(root, 'package.json'),
			'{"name":"iso","dependencies":{"left-pad":"^1.0.0"}}',
		);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: project unused
			const findings = await mcp04(undefined as any, [], baseOpts(root));
			const ids = new Set(findings.map((f) => f.checkId));
			expect(ids.has('MCP04-004')).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it('parseAuditJson tolerates unknown keys without throwing', () => {
		const j = __testables.parseAuditJson(
			JSON.stringify({ vulnerabilities: {}, surprise: 1 }),
		);
		expect(j).not.toBeNull();
		expect(j?.vulnerabilities).toBeDefined();
	});

	it('locateDepLine returns the line a dependency name appears on', () => {
		const raw = '{\n  "dependencies": {\n    "left-pad": "*"\n  }\n}';
		const { line, column } = __testables.locateDepLine(raw, 'left-pad');
		expect(line).toBe(3);
		expect(column).toBeGreaterThan(0);
	});

	it('buildAuditCommand routes a .js script through node', () => {
		const r = __testables.buildAuditCommand('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
		expect(r.cmd).toBe(process.execPath);
		expect(r.args[0]).toMatch(/npm-cli\.js$/);
		expect(r.args.slice(1)).toEqual(['audit', '--json']);
	});

	it('buildAuditCommand passes through a bare POSIX npm executable', () => {
		const r = __testables.buildAuditCommand('/usr/local/bin/npm');
		expect(r.cmd).toBe('/usr/local/bin/npm');
		expect(r.args).toEqual(['audit', '--json']);
	});

	it('buildAuditCommand handles a Windows .cmd path', () => {
		// Either resolves to the sibling npm-cli.js (when present in this
		// process tree) or falls back to spawning the .cmd directly.
		const r = __testables.buildAuditCommand('C:\\fake\\path\\npm.cmd');
		// We can only assert the shape, since the sibling lookup depends on
		// the test environment.
		expect(Array.isArray(r.args)).toBe(true);
		expect(r.args).toContain('audit');
		expect(r.args).toContain('--json');
	});

	it('does not emit MCP04-004 when a parent workspace has a lockfile', async () => {
		// Synthesise a workspace tree:
		//   <tmp>/wsroot/         { package.json, pnpm-lock.yaml }
		//     packages/leaf/      { package.json with deps, no lockfile }
		// Scanning the leaf must NOT produce an MCP04-004 finding because
		// the workspace root above carries the lockfile.
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcps-ws-'));
		const leaf = path.join(wsRoot, 'packages', 'leaf');
		await fs.mkdir(leaf, { recursive: true });
		await fs.writeFile(path.join(wsRoot, 'package.json'), '{"name":"root","private":true}');
		await fs.writeFile(path.join(wsRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		await fs.writeFile(
			path.join(leaf, 'package.json'),
			'{"name":"leaf","dependencies":{"left-pad":"^1.0.0"}}',
		);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: project unused
			const findings = await mcp04(undefined as any, [], baseOpts(leaf));
			const ids = new Set(findings.map((f) => f.checkId));
			expect(ids.has('MCP04-004')).toBe(false);
		} finally {
			await fs.rm(wsRoot, { recursive: true, force: true });
		}
	}, 15_000);
});
