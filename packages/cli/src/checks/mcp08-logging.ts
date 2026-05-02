import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions, Severity } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP08';

const LOG_NAMES = new Set(['log', 'info', 'debug', 'trace', 'warn', 'error', 'audit', 'event']);

const LOGGER_OBJECT_NAMES = new Set(['console', 'logger', 'log', 'pino', 'winston', 'bunyan']);

interface Hit {
    checkId: string;
    severity: Severity;
    line: number;
    column: number;
    message: string;
    fix: string;
}

function isLoggingCall(node: Node): boolean {
    if (!Node.isCallExpression(node)) return false;
    const callee = node.getExpression();
    if (Node.isIdentifier(callee)) {
        const n = callee.getText();
        // Treat any direct `log(...)`, `audit(...)` style as logging.
        return LOG_NAMES.has(n) || /log/i.test(n) || /audit/i.test(n);
    }
    if (Node.isPropertyAccessExpression(callee)) {
        const obj = callee.getExpression();
        const objText = Node.isIdentifier(obj) ? obj.getText() : obj.getText();
        const method = callee.getName();
        if (LOGGER_OBJECT_NAMES.has(objText) && LOG_NAMES.has(method)) return true;
        if (/log|audit/i.test(objText) && LOG_NAMES.has(method)) return true;
    }
    return false;
}

/**
 * Locate `server.tool()` / `.registerTool()` / `setRequestHandler()` calls
 * and return the handler function-like nodes plus the call site.
 */
function findToolHandlers(file: SourceFile): { handler: Node; call: Node }[] {
    const out: { handler: Node; call: Node }[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        const name = expr.getName();
        if (name !== 'tool' && name !== 'registerTool' && name !== 'setRequestHandler') continue;
        const args = call.getArguments();
        for (let i = args.length - 1; i >= 0; i--) {
            const arg = args[i];
            if (!arg) continue;
            if (
                Node.isArrowFunction(arg) ||
                Node.isFunctionExpression(arg) ||
                Node.isFunctionDeclaration(arg)
            ) {
                out.push({ handler: arg, call });
                break;
            }
        }
    }
    return out;
}

function checkHandlerLogging(file: SourceFile): Hit[] {
    const hits: Hit[] = [];
    for (const { handler, call } of findToolHandlers(file)) {
        if (!('getDescendantsOfKind' in handler)) continue;
        const calls = (handler as SourceFile).getDescendantsOfKind(SyntaxKind.CallExpression);
        const hasLog = calls.some(isLoggingCall);
        if (hasLog) continue;
        const { line, column } = file.getLineAndColumnAtPos(call.getStart());
        hits.push({
            checkId: 'MCP08-001',
            severity: 'medium',
            line,
            column,
            message: 'Tool handler does not invoke any logging call — invocations are not auditable.',
            fix: 'Emit at least one log line per invocation (console.info / logger.info / audit) including the tool name and a redacted argument summary.',
        });
    }
    return hits;
}

/**
 * MCP08-002: a `catch` block that re-throws a raw `Error` or returns the
 * raw `error.stack` / `error.message` to the caller leaks internals.
 */
function checkUnsafeErrorPropagation(file: SourceFile): Hit[] {
    const hits: Hit[] = [];
    for (const cls of file.getDescendantsOfKind(SyntaxKind.CatchClause)) {
        const param = cls.getVariableDeclaration();
        const errName = param?.getName();
        const block = cls.getBlock();
        const text = block.getFullText();
        if (!errName) continue;
        const reExposes = new RegExp(`\\b${errName}\\.(stack|message)\\b`).test(text);
        const reReturns = new RegExp(`return[^;]*\\b${errName}\\b`).test(text);
        if (!reExposes && !reReturns) continue;
        const { line, column } = file.getLineAndColumnAtPos(cls.getStart());
        hits.push({
            checkId: 'MCP08-002',
            severity: 'low',
            line,
            column,
            message: 'catch block returns or exposes raw error internals (stack/message) to the caller.',
            fix: 'Log the full error server-side and return a sanitised message to the tool caller (no stack traces).',
        });
    }
    return hits;
}

interface GlobalHit extends Hit {
    filePath: string;
}

/**
 * MCP08-003: missing `process.on('uncaughtException', ...)` (or
 * `unhandledRejection`) handler in any file. Emitted at most once per
 * scan, attributed to the first registered tool entry point we can find.
 */
function checkGlobalErrorHandler(files: SourceFile[]): GlobalHit[] {
    let hasGlobal = false;
    let entryFile: SourceFile | undefined;
    for (const file of files) {
        const text = file.getFullText();
        if (/process\.on\s*\(\s*['"](?:uncaughtException|unhandledRejection)['"]/.test(text)) {
            hasGlobal = true;
        }
        if (
            !entryFile &&
            /server\.(tool|registerTool|setRequestHandler|connect|listen)\s*\(/.test(text)
        ) {
            entryFile = file;
        }
    }
    if (hasGlobal || !entryFile) return [];
    return [
        {
            checkId: 'MCP08-003',
            severity: 'low',
            line: 1,
            column: 1,
            message: 'No global uncaughtException / unhandledRejection handler is registered.',
            fix: "Register process.on('uncaughtException', ...) and process.on('unhandledRejection', ...) in the entry point so a tool crash does not silently kill the server.",
            filePath: entryFile.getFilePath(),
        },
    ];
}

const run: CheckFn = async (
    _project: Project,
    files: SourceFile[],
    _opts: ScanOptions,
): Promise<CheckResult[]> => {
    const out: CheckResult[] = [];
    for (const file of files) {
        for (const h of checkHandlerLogging(file)) {
            out.push({
                checkId: h.checkId,
                owaspId: 'MCP08',
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
        for (const h of checkUnsafeErrorPropagation(file)) {
            out.push({
                checkId: h.checkId,
                owaspId: 'MCP08',
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
    for (const h of checkGlobalErrorHandler(files)) {
        out.push({
            checkId: h.checkId,
            owaspId: 'MCP08',
            severity: h.severity,
            file: h.filePath,
            line: h.line,
            column: h.column,
            message: h.message,
            fix: h.fix,
            ruleUrl: RULE_URL,
            suppressed: false,
        });
    }
    return out;
};

export default run;
