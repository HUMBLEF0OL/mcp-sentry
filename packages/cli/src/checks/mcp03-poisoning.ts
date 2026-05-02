import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions, Severity } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP03';

const HIDDEN_INSTRUCTIONS = [
    /ignore (?:all |the )?previous/i,
    /disregard (?:all |the )?previous/i,
    /system prompt/i,
    /you are now/i,
    /forget (?:all |the )?(?:earlier|previous)/i,
    /jailbreak/i,
    /override .*instructions/i,
];

const SHADOW_NAMES = new Set([
    'read_file',
    'write_file',
    'execute_command',
    'bash',
    'computer',
    'shell',
    'run_command',
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection
const ANSI_ESCAPE_RE = /\x1b\[/;
const ZERO_WIDTH_RE = /[\u200B-\u200F\uFEFF\u2060\u202A-\u202E]/;

interface Hit {
    checkId: string;
    severity: Severity;
    line: number;
    column: number;
    message: string;
    fix: string;
}

/**
 * Locate `server.tool()` / `.registerTool()` / `setRequestHandler()` calls
 * and return their (name, descriptionString, descriptionNode, schemaNode)
 * tuples when discoverable. Conservative: only inspects literal arguments.
 */
interface ToolDecl {
    nameNode?: Node;
    name?: string;
    descNode?: Node;
    desc?: string;
    schemaNode?: Node;
    descIsLiteral: boolean;
    call: Node;
}

function extractStringLike(node: Node): string | undefined {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return node.getLiteralText();
    }
    return undefined;
}

function findToolDecls(file: SourceFile): ToolDecl[] {
    const out: ToolDecl[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        const method = expr.getName();
        if (method !== 'tool' && method !== 'registerTool' && method !== 'setRequestHandler') continue;
        const args = call.getArguments();
        const decl: ToolDecl = { call, descIsLiteral: false };
        if (args[0]) {
            const s = extractStringLike(args[0]);
            if (s !== undefined) {
                decl.name = s;
                decl.nameNode = args[0];
            }
        }
        // Heuristic: object-literal arg with `description` and `inputSchema` fields.
        for (const a of args) {
            if (Node.isObjectLiteralExpression(a)) {
                for (const p of a.getProperties()) {
                    if (!Node.isPropertyAssignment(p)) continue;
                    const pn = p.getName();
                    const init = p.getInitializer();
                    if (!init) continue;
                    if (pn === 'description') {
                        decl.descNode = init;
                        const s = extractStringLike(init);
                        if (s !== undefined) {
                            decl.desc = s;
                            decl.descIsLiteral = true;
                        }
                    } else if (pn === 'inputSchema' || pn === 'schema' || pn === 'parameters') {
                        decl.schemaNode = init;
                    }
                }
            } else if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) {
                // `tool(name, description, schema, handler)` shape.
                if (a !== args[0] && decl.desc === undefined) {
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

function scanFile(file: SourceFile): Hit[] {
    const hits: Hit[] = [];
    const decls = findToolDecls(file);
    for (const d of decls) {
        // Tool-name shadowing.
        if (d.name && SHADOW_NAMES.has(d.name.toLowerCase())) {
            const node = d.nameNode ?? d.call;
            const { line, column } = file.getLineAndColumnAtPos(node.getStart());
            hits.push({
                checkId: 'MCP03-001',
                severity: 'high',
                line,
                column,
                message: `Tool name "${d.name}" shadows a well-known platform tool — agent confusion / poisoning risk.`,
                fix: 'Rename the tool to an unambiguous, project-specific identifier.',
            });
        }

        if (d.desc !== undefined && d.descNode) {
            const { line, column } = file.getLineAndColumnAtPos(d.descNode.getStart());
            for (const re of HIDDEN_INSTRUCTIONS) {
                if (re.test(d.desc)) {
                    hits.push({
                        checkId: 'MCP03-002',
                        severity: 'high',
                        line,
                        column,
                        message: 'Tool description contains a prompt-injection / hidden-instruction phrase.',
                        fix: 'Strip override-style language from descriptions; keep them factual and short.',
                    });
                    break;
                }
            }
            if (ANSI_ESCAPE_RE.test(d.desc)) {
                hits.push({
                    checkId: 'MCP03-003',
                    severity: 'high',
                    line,
                    column,
                    message: 'Tool description embeds ANSI escape sequences.',
                    fix: 'Remove escape sequences; descriptions must be plain UTF-8 text.',
                });
            }
            if (ZERO_WIDTH_RE.test(d.desc)) {
                hits.push({
                    checkId: 'MCP03-004',
                    severity: 'high',
                    line,
                    column,
                    message: 'Tool description contains zero-width / bidi characters.',
                    fix: 'Strip zero-width and bidirectional control characters from the description.',
                });
            }
        }

        // Dynamic description (not a literal): medium — agent ingests text the
        // developer cannot see at review time.
        if (d.descNode && !d.descIsLiteral) {
            const { line, column } = file.getLineAndColumnAtPos(d.descNode.getStart());
            hits.push({
                checkId: 'MCP03-005',
                severity: 'medium',
                line,
                column,
                message: 'Tool description is computed at runtime — review-time visibility is lost.',
                fix: 'Use a string literal for tool descriptions so reviewers can audit what the agent sees.',
            });
        }

        // Dynamic schema assignment (not an object literal / not a z.* call) —
        // medium.
        if (d.schemaNode) {
            const isObjLit = Node.isObjectLiteralExpression(d.schemaNode);
            const isZCall =
                Node.isCallExpression(d.schemaNode) && /\bz\./.test(d.schemaNode.getText());
            if (!isObjLit && !isZCall) {
                const { line, column } = file.getLineAndColumnAtPos(d.schemaNode.getStart());
                hits.push({
                    checkId: 'MCP03-006',
                    severity: 'medium',
                    line,
                    column,
                    message: 'Tool schema is assigned dynamically rather than declared inline.',
                    fix: 'Declare the input schema as an inline literal so it is auditable.',
                });
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
                owaspId: 'MCP03',
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
