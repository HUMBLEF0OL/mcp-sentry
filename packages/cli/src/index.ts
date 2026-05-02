import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { computeGrade, gradeBelow } from './grade.js';
import { REGISTRY } from './registry.js';
import { renderJson, renderText } from './reporter.js';
import { runScan } from './scanner.js';
import type { Format, Grade, ScanOptions } from './types.js';

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

const VERSION = '0.0.0';

/**
 * Commander collector for repeatable string flags. Every occurrence of the
 * flag is appended to the array; this avoids the surprise where a single
 * `--disable MCP05 MCP04` and two separate `--disable` flags behave
 * differently across Commander minor versions.
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
			// SARIF + Markdown reporters land in Phase 3. The choices list is
			// intentionally narrow until then so users get an actionable error
			// from Commander instead of silent fallback to text output.
			new Option('-f, --format <format>', 'output format')
				.choices(['text', 'json'])
				.default('text'),
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
			const ownerRepo = parseOwnerRepo();
			const resolvedPath = path.resolve(rawPath);
			// G6 guard: refuse to walk the entire home tree if the user runs
			// `mcp-sentry scan` (default `.`) from a directory that has no
			// `package.json`. This catches the dominant footgun of running the
			// CLI inside `$HOME` by accident.
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
			// G3: --report lands in Phase 3. Tell the user instead of silently
			// dropping the flag, otherwise an early adopter will assume their
			// badge has been updated.
			if (cmdOpts.report) {
				process.stderr.write(
					'mcp-sentry: --report is not yet wired (Phase 3); proceeding without POST.\n',
				);
			}
			const opts: ScanOptions = {
				path: resolvedPath,
				format: global.format,
				output: cmdOpts.output,
				report: cmdOpts.report ?? false,
				failOn: cmdOpts.failOn,
				disable: cmdOpts.disable ?? [],
				ignore: cmdOpts.ignore ?? [],
				owner: ownerRepo?.owner,
				repo: ownerRepo?.repo,
			};
			const report = await runScan(opts);
			const input = {
				opts,
				findings: report.findings,
				skippedFiles: report.skippedFiles,
				scannedFileCount: report.scannedFileCount,
			};
			const out = opts.format === 'json' ? renderJson(input) : renderText(input);
			if (opts.output) {
				// G4: --output writes a plain-text artefact. Strip ANSI SGR plus
				// the box-drawing chars in the grade box so the file does not
				// render as mojibake on Windows non-UTF-8 codepages.
				const body =
					opts.format === 'json'
						? out
						: stripAnsi(out).replace(/[\u2500-\u257F]/g, '-');
				await fs.mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
				await fs.writeFile(opts.output, body, 'utf8');
			} else {
				process.stdout.write(out);
			}
			if (opts.failOn) {
				const g = computeGrade(report.findings);
				if (gradeBelow(g.grade, opts.failOn)) {
					process.exitCode = 1;
				}
			}
		});

	program
		.command('checks')
		.description('List the check registry')
		.action((_args, cmd: Command) => {
			const global = cmd.optsWithGlobals<RootGlobalOpts>();
			emitChecks(global.format);
		});

	return program;
}

/**
 * Parse `owner` / `repo` from the `GITHUB_REPOSITORY` environment variable
 * (set by GitHub Actions as `acme/my-server`). Returns undefined when the
 * variable is unset or malformed. Exported for unit testing — see
 * Plan §6.4: critical path for the GitHub Action `--report` invocation.
 */
export function parseOwnerRepo(
	env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string } | undefined {
	const raw = env.GITHUB_REPOSITORY;
	if (!raw) return undefined;
	// `actions/github-script` interpolation occasionally yields a trailing
	// newline; trim before splitting so the worker `^[a-zA-Z0-9_.-]+$` regex
	// (TSD §6.2) does not reject the resulting repo segment.
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
