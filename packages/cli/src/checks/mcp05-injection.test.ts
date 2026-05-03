import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runScan } from '../scanner.js';
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

describe('MCP05 — command injection', () => {
	it('flags exec() and fs.readFile() reached by tool input on injection-vuln fixture', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'injection-vuln')));
		const mcp05 = report.findings.filter((f) => f.owaspId === 'MCP05');
		expect(mcp05.length).toBeGreaterThanOrEqual(2);
		const exec = mcp05.find((f) => f.checkId === 'MCP05-001');
		expect(exec).toBeDefined();
		expect(exec?.severity).toBe('critical');
		expect(exec?.line).toBeGreaterThan(0);
		expect(exec?.column).toBeGreaterThan(0);
		expect(exec?.file).toMatch(/injection-vuln/);
		expect(exec?.suppressed).toBe(false);

		const fsRead = mcp05.find((f) => f.checkId === 'MCP05-002');
		expect(fsRead).toBeDefined();
	});

	it('produces zero findings on clean-server fixture', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
		expect(report.findings).toEqual([]);
		expect(report.skippedFiles).toEqual([]);
	});
});

describe('MCP06 — active in v1.1', () => {
	it('emits no findings on the clean-server fixture (no read-only/write mismatch, no trivial descriptions)', async () => {
		const report = await runScan(baseOpts(path.join(fixtureRoot, 'clean-server')));
		const mcp06 = report.findings.filter((f) => f.owaspId === 'MCP06');
		expect(mcp06).toEqual([]);
	});
});

describe('MCP05 — inter-procedural taint (v1.1)', () => {
	it('follows tool input through a local helper and flags the sink inside the helper', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function runShell(cmd: string) {
  exec(cmd);
}

server.tool('run', {}, async (input: { command: string }) => {
  const c = 'echo ' + input.command;
  runShell(c);
});
`,
			{ overwrite: true },
		);
		const findings = await mcp05(project, project.getSourceFiles(), {
			path: '/',
			format: 'json',
			report: false,
			disable: [],
			ignore: [],
		});
		const m5 = findings.filter((f) => f.checkId === 'MCP05-001');
		expect(m5.length).toBeGreaterThanOrEqual(1);
	});

	it('does not flag a helper called with non-tainted constants', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function runShell(cmd: string) {
  exec(cmd);
}

server.tool('run', {}, async (_input: { command: string }) => {
  runShell('ls -la');
});
`,
			{ overwrite: true },
		);
		const findings = await mcp05(project, project.getSourceFiles(), {
			path: '/',
			format: 'json',
			report: false,
			disable: [],
			ignore: [],
		});
		expect(findings.filter((f) => f.checkId === 'MCP05-001')).toEqual([]);
	});

	it('keeps separate findings when two handlers reach the same helper sink', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function runShell(cmd: string) {
  exec(cmd);
}

server.tool('run_a', {}, async (input: { command: string }) => {
  runShell(input.command);
});

server.tool('run_b', {}, async (input: { command: string }) => {
  runShell(input.command);
});
`,
			{ overwrite: true },
		);
		const findings = await mcp05(project, project.getSourceFiles(), {
			path: '/',
			format: 'json',
			report: false,
			disable: [],
			ignore: [],
		});
		const m5 = findings.filter((f) => f.checkId === 'MCP05-001');
		expect(m5.length).toBe(2);
	});

	it('emits the depth-limit warning once when helper chains exceed analysis depth', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function f1(x: string) { return f2(x); }
function f2(x: string) { return f3(x); }
function f3(x: string) { return f4(x); }
function f4(x: string) { return f5(x); }
function f5(x: string) { return f6(x); }
function f6(x: string) { return f7(x); }
function f7(x: string) { exec(x); }

server.tool('run', {}, async (input: { command: string }) => {
  f1(input.command);
});
`,
			{ overwrite: true },
		);
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			return true;
		});
		try {
			await mcp05(project, project.getSourceFiles(), {
				path: '/',
				format: 'json',
				report: false,
				disable: [],
				ignore: [],
			});
		} finally {
			spy.mockRestore();
		}
		const warns = writes.filter((w) =>
			w.includes('MCP05 inter-procedural analysis hit depth limit'),
		);
		expect(warns.length).toBe(1);
	});

	it('follows the reachable top-level helper even when an unrelated nested helper reuses the same name', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function runShell(cmd: string) {
	exec(cmd);
}

if (true) {
	function runShell(_cmd: string) {
		return true;
  }
}

server.tool('run', {}, async (input: { command: string }) => {
  runShell(input.command);
});
`,
			{ overwrite: true },
		);
		const findings = await mcp05(project, project.getSourceFiles(), {
			path: '/',
			format: 'json',
			report: false,
			disable: [],
			ignore: [],
		});
		expect(findings.filter((f) => f.checkId === 'MCP05-001')).toHaveLength(1);
	});

	it('respects lexical shadowing when a safe helper is redeclared inside the handler scope', async () => {
		const { Project } = await import('ts-morph');
		const mcp05 = (await import('./mcp05-injection.js')).default;
		const project = new Project({
			useInMemoryFileSystem: true,
			skipAddingFilesFromTsConfig: true,
			compilerOptions: { allowJs: true, noEmit: true },
		});
		project.createSourceFile(
			'/srv.ts',
			`
import { exec } from 'node:child_process';
const server: any = { tool: (_n: string, _o: any, h: any) => h };

function runShell(cmd: string) {
  exec(cmd);
}

server.tool('run', {}, async (input: { command: string }) => {
  function runShell(_cmd: string) {
    return true;
  }
  runShell(input.command);
});
`,
			{ overwrite: true },
		);
		const findings = await mcp05(project, project.getSourceFiles(), {
			path: '/',
			format: 'json',
			report: false,
			disable: [],
			ignore: [],
		});
		expect(findings.filter((f) => f.checkId === 'MCP05-001')).toEqual([]);
	});
});
