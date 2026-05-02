import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Project, type SourceFile } from 'ts-morph';
import { getActiveChecks } from './registry.js';
import type { CheckResult, ScanOptions, SkippedFile } from './types.js';
import { type Ignore, createIgnore } from './util/ignore.js';

const DEFAULT_EXCLUDES = ['node_modules/', 'dist/', '.git/', 'coverage/', '**/*.d.ts'];

/** Convert a Windows path to POSIX form for the `ignore` package. */
function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

async function loadIgnore(rootDir: string, extra: string[]): Promise<Ignore> {
	const ig = createIgnore().add(DEFAULT_EXCLUDES).add(extra);
	const ignoreFile = path.join(rootDir, '.mcp-sentry.ignore');
	try {
		const text = await fs.readFile(ignoreFile, 'utf8');
		ig.add(text);
	} catch {
		// no ignore file — ok
	}
	return ig;
}

/**
 * Recursively discover .ts/.js files under `rootPath`, honouring default
 * excludes, an optional `.mcp-sentry.ignore`, and additional `--ignore`
 * patterns. Returns absolute paths.
 */
export async function discoverFiles(
	rootPath: string,
	extraIgnore: string[] = [],
): Promise<string[]> {
	const abs = path.resolve(rootPath);
	const stat = await fs.stat(abs);
	if (stat.isFile()) return [abs];

	const ig = await loadIgnore(abs, extraIgnore);
	const out: string[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const rel = toPosix(path.relative(abs, full));
			if (rel === '') continue;
			const candidate = entry.isDirectory() ? `${rel}/` : rel;
			if (ig.ignores(candidate)) continue;
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
					out.push(full);
				}
			}
		}
	}

	await walk(abs);
	return out.sort();
}

export interface ScanReport {
	findings: CheckResult[];
	skippedFiles: SkippedFile[];
	scannedFileCount: number;
}

/** Initialise a ts-morph Project with safe defaults for static analysis. */
export function createProject(): Project {
	return new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: false,
		compilerOptions: {
			allowJs: true,
			checkJs: false,
			noEmit: true,
		},
	});
}

/**
 * End-to-end scan: discover files, load them into a ts-morph project (with
 * per-file parse-error isolation), then run every active check in parallel.
 */
export async function runScan(opts: ScanOptions): Promise<ScanReport> {
	const filePaths = await discoverFiles(opts.path, opts.ignore);
	const project = createProject();
	const sources: SourceFile[] = [];
	const skippedFiles: SkippedFile[] = [];

	for (const fp of filePaths) {
		try {
			sources.push(project.addSourceFileAtPath(fp));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			skippedFiles.push({ file: fp, reason });
			process.stderr.write(`mcp-sentry: skipped ${toPosix(fp)} — ${reason}\n`);
		}
	}

	const checks = getActiveChecks(opts.disable);
	const findingsArrays = await Promise.all(
		checks.map(async (c) => {
			try {
				return await c.run(project, sources, opts);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`mcp-sentry: check ${c.owaspId} failed — ${msg}\n`);
				return [] as CheckResult[];
			}
		}),
	);

	return {
		findings: findingsArrays.flat(),
		skippedFiles,
		scannedFileCount: sources.length,
	};
}
