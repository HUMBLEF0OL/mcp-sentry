import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP07';

/**
 * Substrings of named imports / identifiers that signal an HTTP transport
 * is being wired up — any one of these triggers the auth check for that
 * file. Stdio transports are explicitly NOT in this list, so a stdio-only
 * server is exempt (TSD §3.4 MCP07).
 */
const HTTP_TRANSPORT_HINTS = [
    'StreamableHTTPServerTransport',
    'SSEServerTransport',
    'HTTPServerTransport',
    'createServer', // node:http
    'express',
    'fastify',
    'koa',
    'hapi',
];

/**
 * Tokens that indicate authentication has been wired up. Detection is
 * intentionally permissive — we want to suppress the High finding even if
 * the auth implementation is custom, because false positives on auth are
 * extremely noisy. The check fires only when an HTTP transport is present
 * AND none of these tokens appear anywhere in the file.
 */
const AUTH_TOKEN_HINTS = [
    'authorization',
    'authenticate',
    'bearer',
    'jwt',
    'oauth',
    'apikey',
    'api-key',
    'x-api-key',
    'session',
    'passport',
    'verifyToken',
    'requireAuth',
    'authMiddleware',
    'getToken',
];

function fileHasHttpTransport(
    file: SourceFile,
    text: string,
): { line: number; column: number } | undefined {
    for (const decl of file.getImportDeclarations()) {
        const mod = decl.getModuleSpecifierValue();
        const isExpressLike =
            mod === 'express' ||
            mod === 'fastify' ||
            mod === 'koa' ||
            mod === '@hapi/hapi' ||
            mod === 'http' ||
            mod === 'node:http' ||
            mod === 'https' ||
            mod === 'node:https' ||
            mod.startsWith('@modelcontextprotocol/sdk');
        if (!isExpressLike) {
            // Even if not, named imports may include transport hints.
            const named = decl.getNamedImports().map((n) => n.getName());
            if (!named.some((n) => HTTP_TRANSPORT_HINTS.includes(n))) continue;
        }
        const named = decl.getNamedImports().map((n) => n.getName());
        const hasTransport =
            named.some((n) => HTTP_TRANSPORT_HINTS.includes(n)) ||
            mod === 'express' ||
            mod === 'fastify' ||
            mod === 'koa' ||
            mod === '@hapi/hapi';
        if (!hasTransport) continue;
        const { line, column } = file.getLineAndColumnAtPos(decl.getStart());
        return { line, column };
    }
    // Fall back to identifier scan: instantiation like `new StreamableHTTPServerTransport()`
    for (const newExpr of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const expr = newExpr.getExpression();
        const name = Node.isIdentifier(expr)
            ? expr.getText()
            : Node.isPropertyAccessExpression(expr)
                ? expr.getName()
                : '';
        if (HTTP_TRANSPORT_HINTS.includes(name)) {
            const { line, column } = file.getLineAndColumnAtPos(newExpr.getStart());
            return { line, column };
        }
    }
    // Default check on text — covers `app.listen(...)` patterns.
    const m = /\bapp\.listen\s*\(/.exec(text);
    if (m) {
        const { line, column } = file.getLineAndColumnAtPos(m.index);
        return { line, column };
    }
    return undefined;
}

function fileHasAuth(text: string): boolean {
    const lower = text.toLowerCase();
    return AUTH_TOKEN_HINTS.some((tok) => lower.includes(tok.toLowerCase()));
}

const run: CheckFn = async (
    _project: Project,
    files: SourceFile[],
    _opts: ScanOptions,
): Promise<CheckResult[]> => {
    const out: CheckResult[] = [];
    // If ANY file in the project shows auth wiring, exempt the whole project —
    // auth is commonly extracted into middleware/utility files separate from
    // the transport setup. This is the conservative, low-FP choice (TSD §3.4
    // MCP07).
    const projectHasAuth = files.some((f) => fileHasAuth(f.getFullText()));
    if (projectHasAuth) return out;

    for (const file of files) {
        const text = file.getFullText();
        const transport = fileHasHttpTransport(file, text);
        if (!transport) continue;
        out.push({
            checkId: 'MCP07-001',
            owaspId: 'MCP07',
            severity: 'high',
            file: file.getFilePath(),
            line: transport.line,
            column: transport.column,
            message:
                'HTTP transport is exposed without any detectable authentication (no bearer/JWT/API-key/middleware found in project).',
            fix: 'Add an auth middleware: verify Authorization: Bearer <token> headers (or equivalent) before dispatching tool requests. Stdio-only servers are exempt from this check.',
            ruleUrl: RULE_URL,
            suppressed: false,
        });
    }
    return out;
};

export default run;
