import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions } from '../types.js';

const SHELL_SINKS = new Set(['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync']);

const FS_PATH_SINKS = new Set([
	'readFile',
	'readFileSync',
	'writeFile',
	'writeFileSync',
	'unlink',
	'unlinkSync',
	'appendFile',
	'appendFileSync',
	'createReadStream',
	'createWriteStream',
]);

const SANITISER_NAMES = new Set([
	'shellEscape',
	'shellQuote',
	'escapeShellArg',
	'sanitize',
	'sanitise',
	'validate',
	'allowlist',
]);

interface SinkHit {
	severity: 'critical';
	owaspId: 'MCP05';
	checkId: 'MCP05-001' | 'MCP05-002';
	message: string;
	fix: string;
}

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP05';

/**
 * Identify tool handler functions by looking for `server.tool(...)` /
 * `.registerTool(...)` / `setRequestHandler(...)` call expressions and
 * returning the function-like argument that contains the handler body.
 */
function findToolHandlers(file: SourceFile): {
	handler: Node;
	paramNames: string[];
}[] {
	const out: { handler: Node; paramNames: string[] }[] = [];
	for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const expr = call.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) continue;
		const name = expr.getName();
		if (name !== 'tool' && name !== 'registerTool' && name !== 'setRequestHandler') continue;
		const args = call.getArguments();
		// The handler is the last function-like argument.
		for (let i = args.length - 1; i >= 0; i--) {
			const arg = args[i];
			if (!arg) continue;
			if (
				Node.isArrowFunction(arg) ||
				Node.isFunctionExpression(arg) ||
				Node.isFunctionDeclaration(arg)
			) {
				const params = arg.getParameters();
				const paramNames: string[] = [];
				for (const p of params) {
					const nameNode = p.getNameNode();
					collectBindingNames(nameNode, paramNames);
				}
				out.push({ handler: arg, paramNames });
				break;
			}
		}
	}
	return out;
}

function collectBindingNames(node: Node, acc: string[]): void {
	if (Node.isIdentifier(node)) {
		acc.push(node.getText());
		return;
	}
	if (Node.isObjectBindingPattern(node) || Node.isArrayBindingPattern(node)) {
		for (const el of node.getElements()) {
			if (Node.isBindingElement(el)) {
				collectBindingNames(el.getNameNode(), acc);
			}
		}
	}
}

/**
 * Identify named imports from `node:fs` / `fs` / `node:fs/promises` /
 * `fs/promises` that match an FS path-sink name. Used so we can detect
 * bare-identifier sink calls (e.g. `readFile(target)`).
 */
function collectFsBareImports(file: SourceFile): Set<string> {
	const out = new Set<string>();
	for (const decl of file.getImportDeclarations()) {
		const mod = decl.getModuleSpecifierValue();
		const isFsModule =
			mod === 'fs' || mod === 'node:fs' || mod === 'fs/promises' || mod === 'node:fs/promises';
		if (!isFsModule) continue;
		for (const named of decl.getNamedImports()) {
			const local = named.getAliasNode()?.getText() ?? named.getName();
			if (FS_PATH_SINKS.has(named.getName())) out.add(local);
		}
	}
	return out;
}

/**
 * Build the set of variable names tainted by tool input within `handler`.
 * Tracks: direct params, destructured properties of params, and simple
 * assignments `const x = <tainted-expr>` / `let x = <tainted-expr>`.
 */
function collectTaintedNames(handler: Node, seeds: string[]): Set<string> {
	const tainted = new Set<string>(seeds);
	if (!('getDescendantsOfKind' in handler)) return tainted;
	// Walk variable declarations inside the handler; if RHS references a
	// tainted name, mark the declared name(s) as tainted too.
	const vars = (handler as SourceFile).getDescendantsOfKind(SyntaxKind.VariableDeclaration);
	// Iterate to fixpoint (handlers are small; bounded loop count).
	let changed = true;
	let iterations = 0;
	while (changed && iterations < 10) {
		changed = false;
		iterations += 1;
		for (const v of vars) {
			const init = v.getInitializer();
			if (!init) continue;
			if (!expressionReferencesTainted(init, tainted)) continue;
			const nameNode = v.getNameNode();
			const before = tainted.size;
			const newNames: string[] = [];
			collectBindingNames(nameNode, newNames);
			for (const n of newNames) tainted.add(n);
			if (tainted.size > before) changed = true;
		}
	}
	return tainted;
}

function expressionReferencesTainted(node: Node, tainted: Set<string>): boolean {
	// Treat any sanitiser call as breaking the taint chain. Detection is
	// conservative: only the call expression itself is short-circuited; a
	// sanitiser nested inside a template literal (e.g.
	// `cat ${sanitize(input.path)}`) still flags. Documented limitation —
	// see docs/rules/MCP05.md (Phase 4).
	if (Node.isCallExpression(node)) {
		const callee = node.getExpression();
		const calleeName = Node.isIdentifier(callee)
			? callee.getText()
			: Node.isPropertyAccessExpression(callee)
				? callee.getName()
				: '';
		if (SANITISER_NAMES.has(calleeName)) return false;
	}
	if (Node.isIdentifier(node) && tainted.has(node.getText())) return true;
	for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
		if (!tainted.has(id.getText())) continue;
		if (isNonReferenceIdentifier(id)) continue;
		return true;
	}
	return false;
}

/**
 * Filter out identifier occurrences that are NOT value references — i.e.
 * the property name in `obj.foo`, the key in `{ foo: 1 }`, the parameter
 * name being declared, or the imported binding name. These positions
 * shadow real value references and would otherwise yield false positives
 * when a tainted variable shares a name with a property accessor.
 */
function isNonReferenceIdentifier(id: Node): boolean {
	const parent = id.getParent();
	if (!parent) return false;
	// `obj.foo` — `foo` is the property name, not a reference.
	if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return true;
	// `obj?.foo` covered by PropertyAccessExpression above (ts-morph models
	// optional chains as PropertyAccessExpression with a question-dot token).
	// `{ foo: x }` — `foo` is a property assignment name.
	if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return true;
	if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === id) return false; // shorthand IS a reference
	// Parameter / variable declaration names are bindings, not references.
	if (Node.isParameterDeclaration(parent) && parent.getNameNode() === id) return true;
	if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) return true;
	if (Node.isBindingElement(parent) && parent.getNameNode() === id) return true;
	// Import / export specifiers.
	if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) return true;
	return false;
}

function detectSinks(
	handler: Node,
	tainted: Set<string>,
	file: SourceFile,
	fsBareImports: Set<string>,
): CheckResult[] {
	const results: CheckResult[] = [];
	if (!('getDescendantsOfKind' in handler)) return results;
	const calls = (handler as SourceFile).getDescendantsOfKind(SyntaxKind.CallExpression);
	for (const call of calls) {
		const callee = call.getExpression();
		let calleeName = '';
		let isFs = false;
		if (Node.isPropertyAccessExpression(callee)) {
			calleeName = callee.getName();
			const obj = callee.getExpression().getText();
			isFs = obj === 'fs' || obj === 'fsp' || obj.endsWith('.promises');
		} else if (Node.isIdentifier(callee)) {
			calleeName = callee.getText();
			if (fsBareImports.has(calleeName)) isFs = true;
		}

		const args = call.getArguments();
		if (args.length === 0) continue;

		let hit: SinkHit | undefined;
		if (SHELL_SINKS.has(calleeName)) {
			const firstArg = args[0];
			if (firstArg && expressionReferencesTainted(firstArg, tainted)) {
				hit = {
					severity: 'critical',
					owaspId: 'MCP05',
					checkId: 'MCP05-001',
					message: `Tool input flows unsanitised into ${calleeName}() — command injection risk.`,
					fix: 'Validate input against an allowlist or use execFile with a fixed binary and array args (never shell strings).',
				};
			}
		} else if (isFs && FS_PATH_SINKS.has(calleeName)) {
			const firstArg = args[0];
			if (firstArg && expressionReferencesTainted(firstArg, tainted)) {
				hit = {
					severity: 'critical',
					owaspId: 'MCP05',
					checkId: 'MCP05-002',
					message: `Tool input flows unsanitised into fs.${calleeName}() — path traversal risk.`,
					fix: 'Resolve with path.resolve() and verify the result is within an allowlisted directory before any fs call.',
				};
			}
		}

		if (!hit) continue;
		const { line, column } = file.getLineAndColumnAtPos(call.getStart());
		results.push({
			checkId: hit.checkId,
			owaspId: hit.owaspId,
			severity: hit.severity,
			file: file.getFilePath(),
			line,
			column,
			message: hit.message,
			fix: hit.fix,
			ruleUrl: RULE_URL,
			suppressed: false,
		});
	}
	return results;
}

/**
 * Local-function index for inter-procedural taint tracking (v1.1).
 * Maps the identifier name → the function-like node (FunctionDeclaration,
 * FunctionExpression, or ArrowFunction) and its positional parameter names.
 * Only same-file functions are considered; project-wide resolution would
 * require full ts-morph type analysis and is out of scope.
 */
interface LocalFunction {
	key: string;
	name: string;
	declaration: Node;
	node: Node;
	params: string[];
	scope: Node;
	isHoisted: boolean;
}

interface LocalFunctionIndex {
	localsByName: Map<string, LocalFunction[]>;
	locals: Map<string, LocalFunction>;
}

function localFunctionKey(node: Node): string {
	const sourceFile = node.getSourceFile().getFilePath();
	return `${sourceFile}:${node.getStart()}`;
}

function getLexicalScope(node: Node): Node {
	return (
		node.getFirstAncestor((ancestor) => Node.isBlock(ancestor) || Node.isSourceFile(ancestor)) ??
		node.getSourceFile()
	);
}

function collectLocalFunctions(file: SourceFile): LocalFunctionIndex {
	const locals = new Map<string, LocalFunction>();
	const localsByName = new Map<string, LocalFunction[]>();
	const addLocal = (
		name: string,
		declaration: Node,
		fnNode: Node,
		params: string[],
		isHoisted: boolean,
	): void => {
		const local: LocalFunction = {
			key: localFunctionKey(declaration),
			name,
			declaration,
			node: fnNode,
			params,
			scope: getLexicalScope(declaration),
			isHoisted,
		};
		locals.set(local.key, local);
		const existing = localsByName.get(name);
		if (existing) existing.push(local);
		else localsByName.set(name, [local]);
	};

	// Top-level + nested function declarations.
	for (const fn of file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
		const name = fn.getName();
		if (!name) continue;
		const params: string[] = [];
		for (const p of fn.getParameters()) collectBindingNames(p.getNameNode(), params);
		addLocal(name, fn, fn, params, true);
	}
	// `const foo = (...) => …` / `const foo = function (…) {}`.
	for (const v of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
		const init = v.getInitializer();
		if (!init) continue;
		if (!(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) continue;
		const nameNode = v.getNameNode();
		if (!Node.isIdentifier(nameNode)) continue;
		const name = nameNode.getText();
		const params: string[] = [];
		for (const p of init.getParameters()) collectBindingNames(p.getNameNode(), params);
		addLocal(name, v, init, params, false);
	}
	return { localsByName, locals };
}

function resolveLexicallyVisibleLocalFunction(
	localsByName: Map<string, LocalFunction[]>,
	callee: Node,
): LocalFunction | undefined {
	if (!Node.isIdentifier(callee)) return undefined;
	const candidates = localsByName.get(callee.getText());
	if (!candidates || candidates.length === 0) return undefined;
	const callStart = callee.getStart();
	const visible = candidates.filter((candidate) => {
		const scopeStart = candidate.scope.getStart();
		const scopeEnd = candidate.scope.getEnd();
		if (callStart < scopeStart || callStart > scopeEnd) return false;
		if (candidate.isHoisted) return true;
		return candidate.declaration.getStart() <= callStart;
	});
	if (visible.length === 0) return undefined;
	visible.sort((left, right) => {
		const scopeDelta = right.scope.getStart() - left.scope.getStart();
		if (scopeDelta !== 0) return scopeDelta;
		return right.declaration.getStart() - left.declaration.getStart();
	});
	const best = visible[0];
	if (!best) return undefined;
	const sameScopeMatches = visible.filter(
		(candidate) =>
			candidate.scope.getStart() === best.scope.getStart() &&
			candidate.scope.getEnd() === best.scope.getEnd(),
	);
	if (sameScopeMatches.length > 1) return undefined;
	return best;
}

function resolveLocalFunction(
	locals: Map<string, LocalFunction>,
	localsByName: Map<string, LocalFunction[]>,
	callee: Node,
): LocalFunction | undefined {
	if (!Node.isIdentifier(callee)) return undefined;
	const symbol = callee.getSymbol();
	if (symbol) {
		for (const decl of symbol.getDeclarations()) {
			const local = locals.get(localFunctionKey(decl));
			if (local) return local;
		}
	}
	for (const def of callee.getDefinitions()) {
		const decl = def.getDeclarationNode();
		if (!decl) continue;
		const local = locals.get(localFunctionKey(decl));
		if (local) return local;
	}
	return resolveLexicallyVisibleLocalFunction(localsByName, callee);
}

/**
 * Walk a (callee, taintedParams) work item: compute the callee's tainted
 * variable set, detect direct sinks, and enqueue any further calls to
 * local helpers whose arguments include tainted expressions.
 */
function analyseCallee(
	calleeFn: LocalFunction,
	seedParamNames: string[],
	file: SourceFile,
	fsBareImports: Set<string>,
	locals: Map<string, LocalFunction>,
	localsByName: Map<string, LocalFunction[]>,
	visited: Set<string>,
	depth: number,
	maxDepth: number,
	onDepthLimit: () => void,
): CheckResult[] {
	if (depth > maxDepth) {
		onDepthLimit();
		return [];
	}
	const tainted = collectTaintedNames(calleeFn.node, seedParamNames);
	const out: CheckResult[] = detectSinks(calleeFn.node, tainted, file, fsBareImports);

	if (!('getDescendantsOfKind' in calleeFn.node)) return out;
	const calls = (calleeFn.node as SourceFile).getDescendantsOfKind(SyntaxKind.CallExpression);
	for (const call of calls) {
		const callee = call.getExpression();
		if (!Node.isIdentifier(callee)) continue;
		const local = resolveLocalFunction(locals, localsByName, callee);
		if (!local) continue;
		if (local.key === calleeFn.key) continue; // self-recursion: skip
		const args = call.getArguments();
		const seeds: string[] = [];
		for (let i = 0; i < args.length && i < local.params.length; i++) {
			const arg = args[i];
			const param = local.params[i];
			if (!arg || !param) continue;
			if (expressionReferencesTainted(arg, tainted)) seeds.push(param);
		}
		if (seeds.length === 0) continue;
		const key = `${local.key}#${seeds.slice().sort().join(',')}`;
		if (visited.has(key)) continue;
		visited.add(key);
		out.push(
			...analyseCallee(
				local,
				seeds,
				file,
				fsBareImports,
				locals,
				localsByName,
				visited,
				depth + 1,
				maxDepth,
				onDepthLimit,
			),
		);
	}
	return out;
}

const MAX_INTERPROC_DEPTH = 5;

const run: CheckFn = async (
	_project: Project,
	files: SourceFile[],
	_opts: ScanOptions,
): Promise<CheckResult[]> => {
	const all: CheckResult[] = [];
	let depthWarned = false;
	const warnDepthLimit = (): void => {
		if (depthWarned) return;
		depthWarned = true;
		process.stderr.write(
			`mcp-sentry: MCP05 inter-procedural analysis hit depth limit (${MAX_INTERPROC_DEPTH}); deeper call chains may be partially analyzed\n`,
		);
	};
	for (const file of files) {
		const fsBareImports = collectFsBareImports(file);
		const handlers = findToolHandlers(file);
		const { locals, localsByName } = collectLocalFunctions(file);
		for (const { handler, paramNames } of handlers) {
			if (paramNames.length === 0) continue;
			const handlerFindings: CheckResult[] = [];
			const tainted = collectTaintedNames(handler, paramNames);
			handlerFindings.push(...detectSinks(handler, tainted, file, fsBareImports));

			// Inter-procedural pass: walk calls to local helpers from the
			// handler and follow taint into them. Visited keyed by
			// (functionName, sortedSeedParams) so we never analyse the same
			// (callee, taint-shape) twice within one handler.
			const visited = new Set<string>();
			if (!('getDescendantsOfKind' in handler)) continue;
			const calls = (handler as SourceFile).getDescendantsOfKind(SyntaxKind.CallExpression);
			for (const call of calls) {
				const callee = call.getExpression();
				if (!Node.isIdentifier(callee)) continue;
				const local = resolveLocalFunction(locals, localsByName, callee);
				if (!local) continue;
				const args = call.getArguments();
				const seeds: string[] = [];
				for (let i = 0; i < args.length && i < local.params.length; i++) {
					const arg = args[i];
					const param = local.params[i];
					if (!arg || !param) continue;
					if (expressionReferencesTainted(arg, tainted)) seeds.push(param);
				}
				if (seeds.length === 0) continue;
				const key = `${local.key}#${seeds.slice().sort().join(',')}`;
				if (visited.has(key)) continue;
				visited.add(key);
				handlerFindings.push(
					...analyseCallee(
						local,
						seeds,
						file,
						fsBareImports,
						locals,
						localsByName,
						visited,
						1,
						MAX_INTERPROC_DEPTH,
						warnDepthLimit,
					),
				);
			}
			// Deduplicate only within one handler to preserve context when
			// multiple handlers reach the same sink line.
			const seenInHandler = new Set<string>();
			for (const f of handlerFindings) {
				const k = `${f.checkId}@${f.file}:${f.line}:${f.column}`;
				if (seenInHandler.has(k)) continue;
				seenInHandler.add(k);
				all.push(f);
			}
		}
	}
	return all;
};

export default run;
