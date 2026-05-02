import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP02';

const REFINING_METHODS = new Set([
	'min',
	'max',
	'length',
	'regex',
	'email',
	'url',
	'uuid',
	'cuid',
	'cuid2',
	'datetime',
	'date',
	'time',
	'ip',
	'startsWith',
	'endsWith',
	'includes',
	'positive',
	'nonnegative',
	'negative',
	'nonpositive',
	'int',
	'finite',
	'safe',
	'refine',
	'superRefine',
	'pipe',
	'transform',
	'parse',
	'enum',
]);

const PATH_PARAM_HINTS = /\b(path|filepath|filename|file|dir|directory|target|location)\b/i;

interface Hit {
	checkId: string;
	severity: 'high' | 'medium';
	line: number;
	column: number;
	message: string;
	fix: string;
}

function rootIsZ(node: Node): boolean {
	let cur: Node = node;
	while (true) {
		if (Node.isCallExpression(cur)) {
			cur = cur.getExpression();
			continue;
		}
		if (Node.isPropertyAccessExpression(cur)) {
			cur = cur.getExpression();
			continue;
		}
		break;
	}
	return Node.isIdentifier(cur) && cur.getText() === 'z';
}

/**
 * Walk up from a `z.xxx()` call to find any chained refining methods
 * applied to the same expression.
 */
function chainHasRefiner(call: Node): boolean {
	let cur: Node | undefined = call.getParent();
	while (cur) {
		if (Node.isPropertyAccessExpression(cur)) {
			const name = cur.getName();
			if (REFINING_METHODS.has(name)) return true;
			cur = cur.getParent();
			continue;
		}
		if (Node.isCallExpression(cur)) {
			cur = cur.getParent();
			continue;
		}
		break;
	}
	return false;
}

function scanFile(file: SourceFile): Hit[] {
	const hits: Hit[] = [];
	// (line, col) of every z.string() call already covered by an MCP02-005
	// path-input finding. MCP02-002 (unrefined z.string()) is suppressed at
	// these positions to avoid double-reporting the same node.
	const pathStringCallSites = new Set<string>();

	// Pass 1: schema fields named `path`/`file`/`directory` typed as bare
	// z.string() without refinement — high (path traversal foothold). Run
	// this first so MCP02-002 in pass 2 can be suppressed at the same z.string().
	for (const prop of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
		const nameNode = prop.getNameNode();
		const propName = Node.isIdentifier(nameNode)
			? nameNode.getText()
			: Node.isStringLiteral(nameNode)
				? nameNode.getLiteralText()
				: '';
		if (!PATH_PARAM_HINTS.test(propName)) continue;
		const init = prop.getInitializer();
		if (!init) continue;
		const calls = [init, ...init.getDescendantsOfKind(SyntaxKind.CallExpression)];
		let zStringCall: Node | undefined;
		for (const c of calls) {
			if (!Node.isCallExpression(c)) continue;
			const callee = c.getExpression();
			if (Node.isPropertyAccessExpression(callee) && rootIsZ(callee)) {
				if (callee.getName() === 'string') {
					zStringCall = c;
					break;
				}
			}
		}
		if (!zStringCall) continue;
		if (chainHasRefiner(zStringCall)) continue;
		const callPos = file.getLineAndColumnAtPos(zStringCall.getStart());
		pathStringCallSites.add(`${callPos.line}:${callPos.column}`);
		const { line, column } = file.getLineAndColumnAtPos(prop.getStart());
		hits.push({
			checkId: 'MCP02-005',
			severity: 'high',
			line,
			column,
			message: `Tool input "${propName}" accepts an unvalidated path — traversal risk.`,
			fix: 'Validate the path with .refine() / path.resolve() + allowlist check before use.',
		});
	}

	// Pass 2: schema-shape and fs/glob calls.
	for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const callee = call.getExpression();
		// z.any() / z.unknown() — high.
		if (Node.isPropertyAccessExpression(callee) && rootIsZ(callee)) {
			const method = callee.getName();
			const { line, column } = file.getLineAndColumnAtPos(call.getStart());
			if (method === 'any' || method === 'unknown') {
				hits.push({
					checkId: 'MCP02-001',
					severity: 'high',
					line,
					column,
					message: `Tool input schema uses z.${method}() — accepts arbitrary values.`,
					fix: 'Replace z.any()/z.unknown() with a concrete schema (z.object({...}), z.string().min(1), etc.).',
				});
				continue;
			}
			if ((method === 'string' || method === 'number') && !chainHasRefiner(call)) {
				if (
					method === 'string' &&
					pathStringCallSites.has(`${line}:${column}`)
				) {
					// already reported as MCP02-005 (path traversal); skip the
					// lower-severity unrefined-string finding for the same node.
					continue;
				}
				hits.push({
					checkId: 'MCP02-002',
					severity: 'medium',
					line,
					column,
					message: `Unrefined z.${method}() — no length / range / pattern constraint.`,
					fix: `Add .min()/.max()/.regex()/.refine() to bound z.${method}() inputs.`,
				});
				continue;
			}
		}

		// fs.readdir / fs.readdirSync / glob with root-ish path — high.
		if (Node.isPropertyAccessExpression(callee)) {
			const obj = callee.getExpression().getText();
			const name = callee.getName();
			const fsLike = obj === 'fs' || obj === 'fsp' || obj.endsWith('.promises');
			if (fsLike && (name === 'readdir' || name === 'readdirSync')) {
				const arg0 = call.getArguments()[0];
				if (arg0) {
					const t = arg0.getText().replace(/^['"`]|['"`]$/g, '');
					if (t === '/' || t === '.' || t === '~' || t === '~/' || t.startsWith('/')) {
						const { line, column } = file.getLineAndColumnAtPos(call.getStart());
						hits.push({
							checkId: 'MCP02-003',
							severity: 'high',
							line,
							column,
							message: `fs.${name}() called against a broad / root path — overscoped filesystem access.`,
							fix: 'Constrain directory enumeration to a specific allowlisted directory under the project root.',
						});
					}
				}
			}
		}

		// glob('/**/*') / glob('**/*') — high when scope is unbounded.
		if (Node.isIdentifier(callee) && callee.getText() === 'glob') {
			const arg0 = call.getArguments()[0];
			if (arg0) {
				const t = arg0.getText().replace(/^['"`]|['"`]$/g, '');
				if (t.startsWith('/') || t === '**/*' || t === '**' || t.startsWith('~')) {
					const { line, column } = file.getLineAndColumnAtPos(call.getStart());
					hits.push({
						checkId: 'MCP02-004',
						severity: 'high',
						line,
						column,
						message: 'glob() pattern covers the filesystem root — overscoped access.',
						fix: 'Anchor glob patterns to a project-relative directory.',
					});
				}
			}
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
		for (const h of scanFile(file)) {
			out.push({
				checkId: h.checkId,
				owaspId: 'MCP02',
				severity: h.severity,
				file: file.getFilePath(),
				line: h.line,
				column: h.column,
				message: h.message,
				fix: h.fix,
				ruleUrl: RULE_URL,
				suppressed: false,
			});
		}
	}
	return out;
};

export default run;
