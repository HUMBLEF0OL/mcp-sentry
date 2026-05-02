import path from 'node:path';
import { Command, Option } from 'commander';
import { REGISTRY } from './registry.js';
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

function buildProgram(): Command {
	const program = new Command();
	program
		.name('mcp-sentry')
		.description('Static-analysis security linter for TypeScript MCP servers')
		.version(VERSION, '-V, --version')
		.addOption(
			new Option('-f, --format <format>', 'output format')
				.choices(['text', 'json', 'sarif', 'markdown'])
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
		.option('--disable <id...>', 'OWASP check IDs to skip', [] as string[])
		.option('--ignore <glob...>', 'additional ignore globs', [] as string[])
		.action(async (rawPath: string, cmdOpts: ScanCmdOpts, cmd: Command) => {
			const global = cmd.optsWithGlobals<RootGlobalOpts & ScanCmdOpts>();
			const ownerRepo = parseOwnerRepo();
			const opts: ScanOptions = {
				path: path.resolve(rawPath),
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
			emitPhase1Report(opts, report.findings, report.skippedFiles, report.scannedFileCount);
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

function parseOwnerRepo(): { owner: string; repo: string } | undefined {
	const ghr = process.env.GITHUB_REPOSITORY;
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

function emitPhase1Report(
	opts: ScanOptions,
	findings: import('./types.js').CheckResult[],
	skipped: import('./types.js').SkippedFile[],
	scannedFileCount: number,
): void {
	if (opts.format === 'json') {
		const payload = {
			schemaVersion: '1.0',
			timestamp: new Date().toISOString(),
			scanPath: opts.path,
			scannedFileCount,
			skippedFiles: skipped,
			findings,
		};
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	// Minimal Phase 1 text output; full reporter ships in Phase 2.
	if (findings.length === 0) {
		process.stdout.write(`mcp-sentry: scanned ${scannedFileCount} file(s) — no findings.\n`);
	} else {
		for (const f of findings) {
			process.stdout.write(
				`${f.severity.toUpperCase()}  ${f.owaspId}  ${f.file}:${f.line}:${f.column}  ${f.message}\n`,
			);
		}
		process.stdout.write(
			`mcp-sentry: ${findings.length} finding(s) across ${scannedFileCount} file(s).\n`,
		);
	}
	if (skipped.length > 0) {
		process.stderr.write(
			`mcp-sentry: warning — ${skipped.length} file(s) skipped due to parse errors.\n`,
		);
	}
}

export async function main(argv: string[] = process.argv): Promise<void> {
	const program = buildProgram();
	await program.parseAsync(argv);
}
