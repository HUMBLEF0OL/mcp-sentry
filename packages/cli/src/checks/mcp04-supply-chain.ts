import { spawn } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import which from 'which';
import type { Project, SourceFile } from 'ts-morph';
import maliciousPackages from './mcp04-malicious-packages.json' with { type: 'json' };
import type { CheckFn, CheckResult, ScanOptions, Severity } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP04';
const MAX_AUDIT_BUFFER = 4 * 1024 * 1024; // 4 MB
const AUDIT_TIMEOUT_MS = 10_000;

function loadMaliciousList(): string[] {
	return Array.isArray(maliciousPackages) ? (maliciousPackages as string[]) : [];
}

interface PkgJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

async function readPackageJson(rootDir: string): Promise<{ raw: string; parsed: PkgJson } | null> {
	const file = path.join(rootDir, 'package.json');
	try {
		const raw = await fs.readFile(file, 'utf8');
		return { raw, parsed: JSON.parse(raw) as PkgJson };
	} catch {
		return null;
	}
}

interface LockfileLocation {
	/** File name of the lockfile (e.g. `pnpm-lock.yaml`). */
	name: string;
	/** Absolute directory containing the lockfile. May be a parent of the
	 * scan root in a pnpm/yarn workspace. */
	dir: string;
}

async function detectLockfile(rootDir: string): Promise<LockfileLocation | null> {
	const candidates = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
	// Monorepo support: walk up parent directories until we find a lockfile
	// or hit the filesystem root. pnpm/yarn workspaces routinely keep the
	// lockfile at the workspace root, several levels above
	// `packages/<pkg>`. Without this loop we would emit a false-positive
	// MCP04-004 on every workspace package. We deliberately do NOT gate on
	// intermediate `package.json` files because conventional layouts
	// (`packages/<pkg>`) have no manifest at the `packages/` directory
	// itself. Hitting the filesystem root with no lockfile preserves the
	// original behaviour.
	let dir = path.resolve(rootDir);
	for (;;) {
		for (const name of candidates) {
			try {
				await fs.access(path.join(dir, name));
				return { name, dir };
			} catch {
				// continue
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Best-effort line/column finder for a dependency entry inside `package.json`
 * source text. Falls back to (1,1) if not found.
 */
function locateDepLine(raw: string, depName: string): { line: number; column: number } {
	const lines = raw.split(/\r?\n/);
	const needle = `"${depName}"`;
	for (let i = 0; i < lines.length; i++) {
		const idx = (lines[i] ?? '').indexOf(needle);
		if (idx >= 0) return { line: i + 1, column: idx + 1 };
	}
	return { line: 1, column: 1 };
}

function resolveNpmBinary(): string | null {
	const fromEnv = process.env.npm_execpath;
	if (fromEnv) return fromEnv;
	try {
		return which.sync('npm');
	} catch {
		return null;
	}
}

/**
 * Build the (command, args) tuple to invoke `npm audit --json`. Handles three
 * cross-platform realities:
 *   1. `npm_execpath` is populated by npm/npx and points at `npm-cli.js` —
 *      a JavaScript file that must be executed by `node`, not spawned directly.
 *      On Windows, `spawn('npm-cli.js', [...])` fails with ENOENT.
 *   2. On Windows, `which.sync('npm')` returns `npm.cmd` — a batch file.
 *      `spawn(..., { shell: false })` cannot launch `.cmd` files; we must
 *      switch to the underlying `npm-cli.js` (next to the `.cmd`) when present
 *      so we can keep `shell: false` per TSD §13.1.
 *   3. POSIX: `which.sync('npm')` returns the bare executable; spawn directly.
 */
export function buildAuditCommand(npmBin: string): { cmd: string; args: string[] } {
	const lower = npmBin.toLowerCase();
	if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
		return { cmd: process.execPath, args: [npmBin, 'audit', '--json'] };
	}
	if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) {
		// Try to find the sibling `node_modules/npm/bin/npm-cli.js` so we can
		// keep `shell: false`. If not found, fall back to the script (caller
		// must opt into shell:true — we don't).
		const dir = path.dirname(npmBin);
		const candidates = [
			path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
			path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
		];
		// fs.existsSync would be ideal, but keep the function pure-sync-safe by
		// using statSync via require; importing here is fine since this runs
		// only when MCP04 is actually invoked.
		for (const c of candidates) {
			try {
				if (statSync(c).isFile()) {
					return { cmd: process.execPath, args: [c, 'audit', '--json'] };
				}
			} catch {
				// next candidate
			}
		}
		// Last-ditch: keep the .cmd path but signal failure to caller via an
		// empty string. runNpmAudit treats spawn 'error' events as no-output.
		return { cmd: npmBin, args: ['audit', '--json'] };
	}
	return { cmd: npmBin, args: ['audit', '--json'] };
}

interface AuditAdvisory {
	severity?: 'info' | 'low' | 'moderate' | 'high' | 'critical';
	module_name?: string;
	name?: string;
}

interface AuditJson {
	vulnerabilities?: Record<string, { severity?: string; name?: string; via?: unknown[] }>;
	advisories?: Record<string, AuditAdvisory>;
	metadata?: unknown;
	[k: string]: unknown;
}

const KNOWN_KEYS = new Set(['vulnerabilities', 'advisories', 'metadata', 'auditReportVersion']);

function parseAuditJson(text: string): AuditJson | null {
	try {
		const j = JSON.parse(text) as AuditJson;
		const unknown = Object.keys(j).filter((k) => !KNOWN_KEYS.has(k));
		if (unknown.length) {
			process.stderr.write(
				`mcp-sentry: npm audit returned unexpected keys: ${unknown.join(', ')}\n`,
			);
		}
		return j;
	} catch {
		return null;
	}
}

function runNpmAudit(npmBin: string, cwd: string): Promise<string> {
	const { cmd, args } = buildAuditCommand(npmBin);
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd,
			shell: false,
			timeout: AUDIT_TIMEOUT_MS,
			env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
		});
		let stdout = '';
		let stderr = '';
		let buffered = 0;
		child.stdout.on('data', (chunk: Buffer) => {
			buffered += chunk.length;
			if (buffered <= MAX_AUDIT_BUFFER) stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', () => resolve(''));
		child.on('close', () => {
			if (!stdout && stderr) {
				process.stderr.write(`mcp-sentry: npm audit stderr — ${stderr.trim().slice(0, 500)}\n`);
			}
			resolve(stdout);
		});
	});
}

interface Hit {
	checkId: string;
	severity: Severity;
	line: number;
	column: number;
	message: string;
	fix: string;
}

async function scanRoot(rootDir: string): Promise<{ pkgFile: string; hits: Hit[] } | null> {
	const pkg = await readPackageJson(rootDir);
	if (!pkg) return null;
	const pkgFile = path.join(rootDir, 'package.json');
	const hits: Hit[] = [];

	const all: Record<string, string> = {
		...(pkg.parsed.dependencies ?? {}),
		...(pkg.parsed.devDependencies ?? {}),
	};

	const malicious = new Set(loadMaliciousList().map((s) => s.toLowerCase()));

	for (const [name, range] of Object.entries(all)) {
		const { line, column } = locateDepLine(pkg.raw, name);
		if (malicious.has(name.toLowerCase())) {
			hits.push({
				checkId: 'MCP04-001',
				severity: 'critical',
				line,
				column,
				message: `Dependency "${name}" is on the mcp-sentry known-malicious list.`,
				fix: 'Remove the package and audit any history that pulled it in.',
			});
			continue;
		}
		if (typeof range !== 'string') continue;
		if (range === '*' || range === 'latest' || range.includes('||')) {
			hits.push({
				checkId: 'MCP04-002',
				severity: 'medium',
				line,
				column,
				message: `Dependency "${name}" uses an unbounded version range "${range}".`,
				fix: 'Pin the dependency to a specific version or a narrow caret range.',
			});
		} else if (/^\^/.test(range)) {
			hits.push({
				checkId: 'MCP04-003',
				severity: 'medium',
				line,
				column,
				message: `Dependency "${name}" uses a caret range "${range}" — accepts unreviewed minor updates.`,
				fix: 'Pin to an exact version (or use a tilde range) and rely on lockfile verification.',
			});
		}
	}

	const lockfile = await detectLockfile(rootDir);
	if (!lockfile) {
		// No lockfile is only meaningful when there are dependencies to lock.
		// A bare package.json (e.g. typed: 'module' but no deps) needs no lockfile.
		if (Object.keys(all).length > 0) {
			hits.push({
				checkId: 'MCP04-004',
				severity: 'high',
				line: 1,
				column: 1,
				message: 'No lockfile found (package-lock.json / pnpm-lock.yaml / yarn.lock).',
				fix: 'Commit a lockfile so dependency resolution is reproducible.',
			});
		}
		return { pkgFile, hits };
	}

	// npm audit only runs when a lockfile exists — without it npm errors out.
	const npmBin = resolveNpmBinary();
	if (!npmBin) {
		process.stderr.write('mcp-sentry: npm binary not found on PATH; skipping npm audit.\n');
		return { pkgFile, hits };
	}

	// H1 fix: run `npm audit` in the directory that actually owns the
	// lockfile. In a pnpm/yarn workspace the lockfile lives at the
	// workspace root (several levels above `rootDir`) and `npm audit`
	// requires a lockfile in its CWD — running it in `rootDir` would
	// silently fail and we would never report MCP04-005 vulnerabilities
	// for workspace packages.
	const stdout = await runNpmAudit(npmBin, lockfile.dir);
	if (!stdout) return { pkgFile, hits };
	const audit = parseAuditJson(stdout);
	if (!audit) return { pkgFile, hits };

	if (audit.vulnerabilities) {
		for (const [name, info] of Object.entries(audit.vulnerabilities)) {
			const sev = (info?.severity ?? '').toLowerCase();
			if (sev === 'high' || sev === 'critical') {
				const { line, column } = locateDepLine(pkg.raw, name);
				hits.push({
					checkId: 'MCP04-005',
					severity: 'high',
					line,
					column,
					message: `npm audit reports ${sev} vulnerability in "${name}".`,
					fix: 'Run `npm audit fix` and review the resolution before committing.',
				});
			}
		}
	}

	return { pkgFile, hits };
}

const run: CheckFn = async (
	_project: Project,
	_files: SourceFile[],
	opts: ScanOptions,
): Promise<CheckResult[]> => {
	const result = await scanRoot(opts.path);
	if (!result) return [];
	return result.hits.map((h) => ({
		checkId: h.checkId,
		owaspId: 'MCP04',
		severity: h.severity,
		file: result.pkgFile,
		line: h.line,
		column: h.column,
		message: h.message,
		fix: h.fix,
		ruleUrl: RULE_URL,
		suppressed: false,
	}));
};

export default run;

export const __testables = {
	parseAuditJson,
	resolveNpmBinary,
	locateDepLine,
	buildAuditCommand,
};
