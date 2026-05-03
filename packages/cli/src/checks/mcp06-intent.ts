import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions, Severity } from '../types.js';

/**
 * MCP06 — Intent Subversion (full implementation, v1.1).
 *
 * Detects two distinct failure modes:
 *   MCP06-001 (high): tool name or description advertises a read-only /
 *     safe action (`get_*`, `read_*`, `list`, "returns", "retrieves",
 *     "read-only", …) while the handler invokes a side-effecting sink
 *     (fs write/delete, child_process exec/spawn). Behavioural mismatch
 *     between advertised intent and implementation is the canonical
 *     intent-subversion vector — the LLM (and its caller) routes calls to
 *     the tool under false expectations.
 *   MCP06-002 (medium): tool description is missing, empty, or trivially
 *     short (< 10 visible chars). Without a meaningful description an LLM
 *     has no intent contract to honour or violate.
 *
 * Distinct from MCP03 (tool poisoning): MCP03 looks for hidden
 * adversarial instructions IN the description. MCP06 looks for SEMANTIC
 * MISMATCH between description and behaviour.
 */

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP06';

/** Verbs / prefixes that advertise a read-only operation. */
const READ_ONLY_NAME_TOKENS = [
	'get',
	'read',
	'fetch',
	'list',
	'query',
	'find',
	'search',
	'view',
	'inspect',
	'show',
	'describe',
	'lookup',
];

/**
 * Phrases in description that advertise read-only behaviour. Kept
 * deliberately narrow — generic verbs like "returns" appear in honest
 * descriptions of mutating tools too ("Persists the record and returns
 * the saved id."). Only phrases that *exclusively* signal read-only
 * intent are listed here.
 */
const READ_ONLY_DESC_PHRASES = [
	/\bread[- ]only\b/i,
	/\bretrieves?\b/i,
	/\bqueries\b/i,
	/\binspects?\b/i,
	/\bis (?:purely |strictly )?read[- ]only\b/i,
];

/** Sinks that mutate filesystem or spawn processes. */
const WRITE_FS_SINKS = new Set([
	'writeFile',
	'writeFileSync',
	'appendFile',
	'appendFileSync',
	'unlink',
	'unlinkSync',
	'rm',
	'rmSync',
	'rmdir',
	'rmdirSync',
	'rename',
	'renameSync',
	'mkdir',
	'mkdirSync',
	'createWriteStream',
	'truncate',
	'truncateSync',
	'chmod',
	'chmodSync',
	'chown',
	'chownSync',
]);

const PROCESS_SINKS = new Set([
	'exec',
	'execSync',
	'execFile',
	'execFileSync',
	'spawn',
	'spawnSync',
	'fork',
]);

const MIN_DESCRIPTION_CHARS = 10;

interface ToolDecl {
	method: 'tool' | 'registerTool' | 'setRequestHandler';
	name?: string;
	desc?: string;
	descIsLiteral: boolean;
	hasDescription: boolean;
	descNode?: Node;
	nameNode?: Node;
	handler?: Node;
	call: Node;
}

function extractStringLike(node: Node): string | undefined {
	if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
		return node.getLiteralText();
	}
	return undefined;
}

/**
 * Extract `(name, description, handler)` triples from `server.tool` /
 * `.registerTool` / `setRequestHandler` invocations. Conservative: only
 * literal names / descriptions are inspected — dynamic values fall back to
 * `undefined` and are skipped by callers.
 */
function findToolDecls(file: SourceFile): ToolDecl[] {
	const out: ToolDecl[] = [];
	for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const expr = call.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) continue;
		const method = expr.getName();
		if (method !== 'tool' && method !== 'registerTool' && method !== 'setRequestHandler') continue;
		const args = call.getArguments();
		const decl: ToolDecl = { call, descIsLiteral: false, hasDescription: false, method };

		if (args[0]) {
			const s = extractStringLike(args[0]);
			if (s !== undefined) {
				decl.name = s;
				decl.nameNode = args[0];
			}
		}

		for (let i = args.length - 1; i >= 0; i--) {
			const a = args[i];
			if (!a) continue;
			if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
				decl.handler = a;
				break;
			}
		}

		for (const a of args) {
			if (a === args[0]) continue;
			if (Node.isObjectLiteralExpression(a)) {
				for (const p of a.getProperties()) {
					if (!Node.isPropertyAssignment(p)) continue;
					if (p.getName() !== 'description') continue;
					decl.hasDescription = true;
					const init = p.getInitializer();
					if (!init) continue;
					decl.descNode = init;
					const s = extractStringLike(init);
					if (s !== undefined) {
						decl.desc = s;
						decl.descIsLiteral = true;
					}
				}
			} else if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) {
				decl.hasDescription = true;
				if (decl.desc === undefined) {
					decl.desc = a.getLiteralText();
					decl.descNode = a;
					decl.descIsLiteral = true;
				}
			}
		}

		out.push(decl);
	}
	return out;
}

/**
 * Identify named imports from fs modules that correspond to mutation sinks
 * so bare identifier calls (e.g. `writeFile(...)`) are only treated as fs
 * sinks when they are actually imported from fs.
 */
interface FsImportInfo {
	bareWriteImports: Set<string>;
	namespaceImports: Set<string>;
}

function collectFsImports(file: SourceFile): FsImportInfo {
	const bareWriteImports = new Set<string>();
	const namespaceImports = new Set<string>();
	for (const decl of file.getImportDeclarations()) {
		const mod = decl.getModuleSpecifierValue();
		const isFsModule =
			mod === 'fs' || mod === 'node:fs' || mod === 'fs/promises' || mod === 'node:fs/promises';
		if (!isFsModule) continue;
		const ns = decl.getNamespaceImport();
		if (ns) namespaceImports.add(ns.getText());
		for (const named of decl.getNamedImports()) {
			const local = named.getAliasNode()?.getText() ?? named.getName();
			if (WRITE_FS_SINKS.has(named.getName())) bareWriteImports.add(local);
		}
	}
	return { bareWriteImports, namespaceImports };
}

function rootIdentifierText(node: Node): string | undefined {
	if (Node.isIdentifier(node)) return node.getText();
	if (Node.isPropertyAccessExpression(node)) return rootIdentifierText(node.getExpression());
	return undefined;
}

/**
 * Split a tool name into lowercased tokens regardless of casing
 * convention (`getUserData` → `get user data`, `read_file` →
 * `read file`, `list-tools` → `list tools`).
 */
function tokenize(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

function nameAdvertisesReadOnly(name: string): boolean {
	const tokens = tokenize(name);
	const first = tokens[0];
	if (!first) return false;
	return READ_ONLY_NAME_TOKENS.includes(first);
}

function descriptionAdvertisesReadOnly(desc: string): boolean {
	return READ_ONLY_DESC_PHRASES.some((re) => re.test(desc));
}

interface SinkHit {
	kind: 'fs-write' | 'process';
	calleeName: string;
	node: Node;
}

/**
 * Walk the handler body and report any side-effecting sinks. Detection
 * mirrors MCP05 sink classification but is intent-agnostic: we don't care
 * whether tool input reaches the sink, only that the sink exists.
 */
function findSideEffectSinks(
	handler: Node,
	fsBareImports: Set<string>,
	fsNamespaceImports: Set<string>,
): SinkHit[] {
	const hits: SinkHit[] = [];
	if (!('getDescendantsOfKind' in handler)) return hits;
	const calls = (handler as SourceFile).getDescendantsOfKind(SyntaxKind.CallExpression);
	for (const call of calls) {
		const callee = call.getExpression();
		let calleeName = '';
		let isFsLike = false;
		if (Node.isPropertyAccessExpression(callee)) {
			calleeName = callee.getName();
			const root = rootIdentifierText(callee.getExpression());
			isFsLike = root !== undefined && fsNamespaceImports.has(root);
		} else if (Node.isIdentifier(callee)) {
			calleeName = callee.getText();
			isFsLike = fsBareImports.has(calleeName);
		}
		if (PROCESS_SINKS.has(calleeName)) {
			hits.push({ kind: 'process', calleeName, node: call });
		} else if (isFsLike && WRITE_FS_SINKS.has(calleeName)) {
			hits.push({ kind: 'fs-write', calleeName, node: call });
		}
	}
	return hits;
}

const run: CheckFn = async (
	_project: Project,
	files: SourceFile[],
	_opts: ScanOptions,
): Promise<CheckResult[]> => {
	const out: CheckResult[] = [];
	for (const file of files) {
		const { bareWriteImports, namespaceImports } = collectFsImports(file);
		const decls = findToolDecls(file);
		for (const decl of decls) {
			// MCP06-002: missing / trivially short description.
			const descTrimmed = decl.desc?.trim() ?? '';
			const shouldCheckDescription = decl.name !== undefined;
			const hasMissingDescription = decl.hasDescription === false;
			const hasTooShortLiteralDescription =
				decl.descIsLiteral === true && descTrimmed.length < MIN_DESCRIPTION_CHARS;
			if (shouldCheckDescription && (hasMissingDescription || hasTooShortLiteralDescription)) {
				const anchor = decl.descNode ?? decl.nameNode ?? decl.call;
				const { line, column } = file.getLineAndColumnAtPos(anchor.getStart());
				out.push({
					checkId: 'MCP06-002',
					owaspId: 'MCP06',
					severity: 'medium' satisfies Severity,
					file: file.getFilePath(),
					line,
					column,
					message: hasMissingDescription
						? `Tool ${decl.name ?? '<unknown>'} is missing a description — provide a meaningful intent statement of at least ${MIN_DESCRIPTION_CHARS} chars.`
						: `Tool ${decl.name ?? '<unknown>'} description is too short (${descTrimmed.length} chars) — provide a meaningful intent statement of at least ${MIN_DESCRIPTION_CHARS} chars.`,
					fix: 'Provide a clear description that accurately describes what the tool does and any side effects.',
					ruleUrl: RULE_URL,
					suppressed: false,
				});
			}

			// MCP06-001: advertised intent vs. actual side effects.
			if (!decl.handler) continue;
			const advertisesReadOnly =
				(decl.name !== undefined && nameAdvertisesReadOnly(decl.name)) ||
				(decl.desc !== undefined && descriptionAdvertisesReadOnly(decl.desc));
			if (!advertisesReadOnly) continue;
			const sinks = findSideEffectSinks(decl.handler, bareWriteImports, namespaceImports);
			if (sinks.length === 0) continue;
			const first = sinks[0];
			if (!first) continue;
			const { line, column } = file.getLineAndColumnAtPos(first.node.getStart());
			const sinkLabel =
				first.kind === 'process'
					? `${first.calleeName}() (process spawn)`
					: `fs.${first.calleeName}() (filesystem mutation)`;
			out.push({
				checkId: 'MCP06-001',
				owaspId: 'MCP06',
				severity: 'high' satisfies Severity,
				file: file.getFilePath(),
				line,
				column,
				message: `Tool ${decl.name ?? '<unknown>'} advertises read-only intent but handler invokes ${sinkLabel}.`,
				fix: 'Either rename / rephrase the tool to reflect its mutating behaviour, or remove the side-effecting call. Tool name and description must match what the handler actually does.',
				ruleUrl: RULE_URL,
				suppressed: false,
			});
		}
	}
	return out;
};

export default run;
