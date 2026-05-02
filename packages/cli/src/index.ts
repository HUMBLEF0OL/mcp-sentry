import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { loadConfig } from './config.js';
import { computeGrade, gradeBelow } from './grade.js';
import { REGISTRY } from './registry.js';
import { ReportError, buildReportPayload, postReport } from './report.js';
import { renderForFormat, renderJson } from './reporter.js';
import { runScan } from './scanner.js';
import type { Format, Grade, ScanOptions } from './types.js';
import { VERSION } from './version.js';

interface RootGlobalOpts {
	format: Format;
}

interface ScanCmdOpts {
	output?: string;
	report?: boolean;
	failOn?: Grade;
	disable?: string[];
	ignore?: string[];
}

/**
 * Commander collector for repeatable string flags. Every occurrence of the
 * flag is appended to the array.
 */
function collect(value: string, prev: string[] = []): string[] {
	return prev.concat(value);
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR strip
	return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function buildProgram(): Command {
	const program = new Command();
	program
		.name('mcp-sentry')
		.description('Static-analysis security linter for TypeScript MCP servers')
		.version(VERSION, '-V, --version')
		.addOption(
			new Option('-f, --format <format>', 'output format').choices([
				'text',
				'json',
				'sarif',
				'markdown',
			]),
		);

	program
		.command('scan')
		.description('Scan an MCP server directory or file')
		.argument('[path]', 'path to scan', '.')
		.option('-o, --output <file>', 'write output to file instead of stdout')
		.option('--report', 'POST grade to badge API', false)
		.addOption(
			new Option('--fail-on <grade>', 'exit 1 if grade below threshold').choices([
				'A',
				'B',
				'C',
				'D',
				'F',
			]),
		)
		.option('--disable <id>', 'OWASP check ID to skip (repeatable)', collect, [] as string[])
		.option('--ignore <glob>', 'additional ignore glob (repeatable)', collect, [] as string[])
		.action(async (rawPath: string, cmdOpts: ScanCmdOpts, cmd: Command) => {
			const global = cmd.optsWithGlobals<RootGlobalOpts & ScanCmdOpts>();
			const resolvedPath = path.resolve(rawPath);
			// G6 guard: refuse to walk the entire home tree if the user runs
			// `mcp-sentry scan` (default `.`) from a directory that has no
			// `package.json`.
			if (rawPath === '.') {
				try {
					await fs.access(path.join(resolvedPath, 'package.json'));
				} catch {
					process.stderr.write(
						`mcp-sentry: no package.json found in ${resolvedPath}; refusing to scan an unbounded tree. Pass an explicit path to override.\n`,
					);
					process.exitCode = 2;
					return;
				}
			}

			let fileConfig: Awaited<ReturnType<typeof loadConfig>> = {};
			try {
				fileConfig = await loadConfig(resolvedPath);
			} catch (err) {
				process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
				process.exitCode = 2;
				return;
			}

			// CLI flags win over file config (TSD §8.1).
			const envOwnerRepo = parseOwnerRepo();
			const opts: ScanOptions = {
				path: resolvedPath,
				format: global.format ?? fileConfig.format ?? 'text',
				output: cmdOpts.output,
				report: cmdOpts.report ?? false,
				failOn: cmdOpts.failOn ?? fileConfig.failOn,
				disable: mergeArrays(fileConfig.disable, cmdOpts.disable),
				ignore: mergeArrays(fileConfig.ignore, cmdOpts.ignore),
				owner: fileConfig.report?.owner ?? envOwnerRepo?.owner,
				repo: fileConfig.report?.repo ?? envOwnerRepo?.repo,
			};

			const scanReport = await runScan(opts);
			const renderInput = {
				opts,
				findings: scanReport.findings,
				skippedFiles: scanReport.skippedFiles,
				scannedFileCount: scanReport.scannedFileCount,
			};

			const out = renderForFormat(renderInput);
			if (opts.output) {
				// G4: --output strips ANSI + box-drawing for text/markdown so
				// the file does not render as mojibake on Windows non-UTF-8
				// codepages.
				const body =
					opts.format === 'json' || opts.format === 'sarif'
						? out
						: stripAnsi(out).replace(/[\u2500-\u257F]/g, '-');
				await fs.mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
				await fs.writeFile(opts.output, body, 'utf8');
			} else {
				process.stdout.write(out);
			}

			const grade = computeGrade(scanReport.findings);

			if (opts.report) {
				try {
					const payload = buildReportPayload(opts, grade);
					if (!payload) {
						process.stderr.write(
							'mcp-sentry: --report skipped: owner/repo not set (use .mcp-sentry.json or GITHUB_REPOSITORY).\n',
						);
					} else {
						await postReport(payload);
					}
				} catch (err) {
					if (err instanceof ReportError) {
						process.stderr.write(`${err.message}\n`);
					} else {
						process.stderr.write(
							`mcp-sentry: --report failed: ${err instanceof Error ? err.message : String(err)}\n`,
						);
					}
					// --report failure must NOT change the exit code (TSD §6.6 —
					// the badge is a social signal, not a security gate).
				}
			}

			if (opts.failOn && gradeBelow(grade.grade, opts.failOn)) {
				process.exitCode = 1;
			}
		});

	program
		.command('checks')
		.description('List the check registry')
		.action((_args, cmd: Command) => {
			const global = cmd.optsWithGlobals<RootGlobalOpts>();
			emitChecks(global.format ?? 'text');
		});

	return program;
}

function mergeArrays(a: string[] | undefined, b: string[] | undefined): string[] {
	const out: string[] = [];
	if (a) out.push(...a);
	if (b) out.push(...b);
	return out;
}

/**
 * Parse `owner` / `repo` from the `GITHUB_REPOSITORY` environment variable
 * (set by GitHub Actions as `acme/my-server`). Returns undefined when the
 * variable is unset or malformed. Exported for unit testing.
 */
export function parseOwnerRepo(
	env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string } | undefined {
	const raw = env.GITHUB_REPOSITORY;
	if (!raw) return undefined;
	const ghr = raw.trim();
	if (!ghr) return undefined;
	const [owner, repo] = ghr.split('/', 2);
	if (!owner || !repo) return undefined;
	return { owner, repo };
}

function emitChecks(format: Format): void {
	const items = REGISTRY.map((c) => ({
		owaspId: c.owaspId,
		title: c.title,
		description: c.description,
		severities: c.severities,
		status: c.status,
	}));
	if (format === 'json') {
		process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
		return;
	}
	for (const i of items) {
		const sev = i.severities.length ? i.severities.join(',') : 'n/a';
		process.stdout.write(`${i.owaspId}  [${i.status}]  severities=${sev}  ${i.title}\n`);
		process.stdout.write(`        ${i.description}\n`);
	}
}

export async function main(argv: string[] = process.argv): Promise<void> {
	const program = buildProgram();
	await program.parseAsync(argv);
}

// Re-exported for downstream programmatic consumers and tests.
export { renderJson };
