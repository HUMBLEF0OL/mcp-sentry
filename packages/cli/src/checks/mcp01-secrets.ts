import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project, SourceFile } from 'ts-morph';
import type { CheckFn, CheckResult, ScanOptions } from '../types.js';

const RULE_URL = 'https://mcp-sentry.dev/rules/MCP01';

interface Pattern {
    id: string;
    label: string;
    re: RegExp;
}

/**
 * Curated secret patterns. Each regex is anchored with a leading word boundary
 * (or a literal prefix unique to the secret class) so we do not slice into
 * larger identifiers. The trailing portion is bounded to avoid runaway matches
 * across lines. See TSD §3.4 MCP01.
 *
 * Order matters: more specific prefixes must come before more general ones
 * (Anthropic before OpenAI; the OpenAI regex uses a negative lookahead for
 * `ant-` so that a single character offset cannot match both classes).
 */
const PATTERNS: Pattern[] = [
    { id: 'MCP01-AWS-AK', label: 'AWS access key', re: /\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g },
    { id: 'MCP01-AWS-SK', label: 'AWS secret access key', re: /aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/gi },
    { id: 'MCP01-ANTHROPIC', label: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{0,3}-[A-Za-z0-9_-]{32,}/g },
    { id: 'MCP01-OPENAI', label: 'OpenAI API key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20,}/g },
    { id: 'MCP01-OPENAI-LEGACY', label: 'OpenAI legacy API key', re: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9]{48}\b/g },
    { id: 'MCP01-GH-PAT', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{36,}/g },
    { id: 'MCP01-GH-CLASSIC', label: 'GitHub classic token', re: /\b(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{36}\b/g },
    { id: 'MCP01-GOOGLE', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { id: 'MCP01-GCP-OAUTH', label: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g },
    { id: 'MCP01-GCP-SVC', label: 'Google service-account JSON', re: /"type"\s*:\s*"service_account"[\s\S]{0,200}?"private_key"/g },
    { id: 'MCP01-SLACK', label: 'Slack token', re: /\bxox[baprso]-[A-Za-z0-9-]{10,}/g },
    { id: 'MCP01-SLACK-WEBHOOK', label: 'Slack webhook', re: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
    { id: 'MCP01-STRIPE', label: 'Stripe key', re: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{24,}/g },
    { id: 'MCP01-NPM', label: 'npm publish token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { id: 'MCP01-GITLAB', label: 'GitLab PAT', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
    { id: 'MCP01-JWT', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { id: 'MCP01-PEM', label: 'private key (PEM)', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP |)PRIVATE KEY-----/g },
    { id: 'MCP01-AZURE', label: 'Azure storage key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{60,}/g },
    { id: 'MCP01-DISCORD', label: 'Discord bot token', re: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,40}\b/g },
    { id: 'MCP01-SENDGRID', label: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}/g },
    { id: 'MCP01-MAILGUN', label: 'Mailgun API key', re: /\bkey-[a-f0-9]{32}\b/g },
    { id: 'MCP01-TWILIO-SID', label: 'Twilio account SID', re: /\bAC[a-f0-9]{32}\b/g },
    { id: 'MCP01-TWILIO-AUTH', label: 'Twilio auth token', re: /\bSK[a-f0-9]{32}\b/g },
    { id: 'MCP01-HEROKU', label: 'Heroku API key', re: /heroku[_-]?(?:api[_-]?key|token)\s*[:=]\s*['"][a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}['"]/gi },
    { id: 'MCP01-DIGITALOCEAN', label: 'DigitalOcean PAT', re: /\bdop_v1_[a-f0-9]{64}\b/g },
    { id: 'MCP01-SQUARE', label: 'Square access token', re: /\b(?:sq0atp-|EAAA)[A-Za-z0-9_-]{22,}/g },
    { id: 'MCP01-DATADOG', label: 'Datadog API key', re: /\b(?:dd[_-]?api[_-]?key|datadog[_-]?api[_-]?key)\s*[:=]\s*['"][a-f0-9]{32}['"]/gi },
    { id: 'MCP01-NEWRELIC', label: 'New Relic license key', re: /\bNRAK-[A-Z0-9]{27}\b/g },
    { id: 'MCP01-PAGERDUTY', label: 'PagerDuty token', re: /\b(?:pdus|pdat)\+[A-Za-z0-9_-]{20,}/g },
    { id: 'MCP01-CLOUDFLARE', label: 'Cloudflare API token', re: /\bcloudflare[_-]?(?:api[_-]?token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_-]{40,}['"]/gi },
    { id: 'MCP01-POSTMAN', label: 'Postman API key', re: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g },
    { id: 'MCP01-ALGOLIA', label: 'Algolia admin key', re: /algolia[_-]?(?:admin[_-]?key|api[_-]?key)\s*[:=]\s*['"][a-f0-9]{32}['"]/gi },
    { id: 'MCP01-SENTRY', label: 'Sentry DSN', re: /\bhttps:\/\/[a-f0-9]{32}@[a-z0-9.-]+\.ingest\.sentry\.io\/\d+/g },
    { id: 'MCP01-SHOPIFY', label: 'Shopify access token', re: /\bshp(?:ss|at|ca|pa)_[a-f0-9]{32}\b/g },
    { id: 'MCP01-MAPBOX', label: 'Mapbox secret token', re: /\bsk\.eyJ1[A-Za-z0-9_-]{60,}/g },
    { id: 'MCP01-FIREBASE', label: 'Firebase Cloud Messaging key', re: /\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140,}/g },
    { id: 'MCP01-ATLASSIAN', label: 'Atlassian API token', re: /\bATATT3x[A-Za-z0-9_=-]{180,}/g },
    { id: 'MCP01-ASANA', label: 'Asana PAT', re: /\b1\/\d{16}:[a-f0-9]{32}\b/g },
    { id: 'MCP01-NOTION', label: 'Notion integration token', re: /\b(?:secret_|ntn_)[A-Za-z0-9]{43,}/g },
    { id: 'MCP01-LINEAR', label: 'Linear API key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{40,}/g },
    { id: 'MCP01-DOCKER', label: 'Docker Hub access token', re: /\bdckr_pat_[A-Za-z0-9_-]{27,}/g },
];

/**
 * `key = "...long-string..."` — fires only when the identifier on the LHS
 * looks like a secret. Helps cover bespoke / rotated tokens that do not match
 * any vendor-specific pattern.
 */
const GENERIC_ASSIGN_RE =
    /\b(?:[A-Za-z_][\w]*?_)?(?:api[_-]?key|secret|token|password|passwd|auth|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"`]([A-Za-z0-9+/=_.-]{32,})['"`]/gi;

const PLACEHOLDER_TOKENS = [
    'YOUR_',
    'YOUR-',
    '<API',
    '<TOKEN',
    '<SECRET',
    '<PASSWORD',
    '<KEY',
    'PLACEHOLDER',
    'EXAMPLE',
    'CHANGEME',
    'CHANGE_ME',
    'CHANGE-ME',
    'REPLACE_ME',
    'REPLACE-ME',
    'XXXXXXXX',
    '********',
    'REDACTED',
    'process.env.',
    'PROCESS.ENV.',
];

const SKIP_FILE_RE = /(?:[\\/])(?:test|tests|__tests__|fixtures?|examples?)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function isPlaceholder(matchText: string, lineText: string, patternId: string): boolean {
    const upper = matchText.toUpperCase();
    const upLine = lineText.toUpperCase();
    for (const tok of PLACEHOLDER_TOKENS) {
        if (upper.includes(tok)) return true;
    }
    // Line context placeholder hints — but NOT for vendor-specific patterns,
    // since e.g. an AKIA-prefixed match always contains uppercase letters.
    if (patternId === 'MCP01-GENERIC') {
        for (const tok of PLACEHOLDER_TOKENS) {
            if (upLine.includes(tok.toUpperCase())) return true;
        }
        // All-uppercase ALL_CAPS_TOKEN style placeholder.
        if (/^[A-Z0-9_]{16,}$/.test(matchText) && !/[a-z]/.test(matchText)) return true;
    }
    if (/process\.env/i.test(lineText)) return true;
    return false;
}

interface Hit {
    patternId: string;
    label: string;
    line: number; // 1-indexed
    column: number; // 1-indexed
    matchText: string;
    lineText: string;
}

function scanText(text: string): Hit[] {
    const lines = text.split(/\r?\n/);
    const out: Hit[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        let vendorMatchedThisLine = false;
        // Character spans on this line already claimed by a vendor pattern.
        // PATTERNS is ordered most-specific-first, so a later pattern whose
        // match overlaps an earlier hit is dropped — this is what stops a
        // modern OpenAI key (matching MCP01-OPENAI) from also firing
        // MCP01-OPENAI-LEGACY against the same 48-char window.
        const occupied: Array<[number, number]> = [];
        const overlaps = (start: number, end: number): boolean => {
            for (const [s, e] of occupied) {
                if (start < e && end > s) return true;
            }
            return false;
        };
        for (const p of PATTERNS) {
            p.re.lastIndex = 0;
            let m: RegExpExecArray | null;
            // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
            while ((m = p.re.exec(line))) {
                const start = m.index;
                const end = m.index + m[0].length;
                if (overlaps(start, end)) {
                    if (m.index === p.re.lastIndex) p.re.lastIndex++;
                    continue;
                }
                const key = `${i}|${start}|${m[0]}`;
                if (seen.has(key)) continue;
                seen.add(key);
                occupied.push([start, end]);
                vendorMatchedThisLine = true;
                out.push({
                    patternId: p.id,
                    label: p.label,
                    line: i + 1,
                    column: start + 1,
                    matchText: m[0],
                    lineText: line,
                });
                if (m.index === p.re.lastIndex) p.re.lastIndex++;
            }
        }
        if (vendorMatchedThisLine) continue;
        GENERIC_ASSIGN_RE.lastIndex = 0;
        let g: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
        while ((g = GENERIC_ASSIGN_RE.exec(line))) {
            const captured = g[1] ?? '';
            const key = `${i}|${g.index}|${captured}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                patternId: 'MCP01-GENERIC',
                label: 'hardcoded secret',
                line: i + 1,
                column: g.index + 1,
                matchText: captured,
                lineText: line,
            });
        }
    }
    return out;
}

function shouldSkipFile(scanRoot: string, filePath: string): boolean {
    const rel = path.relative(scanRoot, filePath);
    return SKIP_FILE_RE.test(rel);
}

const run: CheckFn = async (
    _project: Project,
    files: SourceFile[],
    opts: ScanOptions,
): Promise<CheckResult[]> => {
    const out: CheckResult[] = [];
    for (const file of files) {
        const filePath = file.getFilePath();
        if (shouldSkipFile(opts.path, filePath)) continue;
        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf8');
        } catch {
            text = file.getFullText();
        }
        const hits = scanText(text);
        for (const h of hits) {
            if (isPlaceholder(h.matchText, h.lineText, h.patternId)) continue;
            out.push({
                checkId: h.patternId,
                owaspId: 'MCP01',
                severity: 'critical',
                file: filePath,
                line: h.line,
                column: h.column,
                message: `Hardcoded ${h.label} detected in source.`,
                fix: 'Move the secret to an environment variable or a secret manager and rotate the leaked credential.',
                ruleUrl: RULE_URL,
                suppressed: false,
            });
        }
    }
    return out;
};

export default run;

/** Test-only surface: lets unit tests exercise the pattern matrix without
 *  going through the file-system + ts-morph plumbing. */
export const __testables = { scanText, PATTERNS };
