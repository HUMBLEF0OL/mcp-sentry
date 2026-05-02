import { promises as fs } from 'node:fs';
import type { CheckResult } from '../types.js';

/**
 * Inline suppression: a comment of the form `// mcp-sentry-ignore: MCPxx`
 * (or `MCPxx, MCPyy`) on the same line as a finding suppresses that
 * check ID. See TSD §8.2.
 */
const SUPPRESSION_RE = /mcp-sentry-ignore\s*:\s*([A-Za-z0-9, ]+)/;

export function lineSuppressesId(lineText: string, owaspId: string): boolean {
    const m = lineText.match(SUPPRESSION_RE);
    if (!m) return false;
    const ids = (m[1] ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    return ids.includes(owaspId.toUpperCase());
}

/**
 * Apply inline suppression markers to findings in-place. Reads each
 * referenced source file at most once.
 */
export async function applySuppressions(findings: CheckResult[]): Promise<CheckResult[]> {
    const cache = new Map<string, string[]>();
    for (const f of findings) {
        if (f.suppressed) continue;
        let lines = cache.get(f.file);
        if (!lines) {
            try {
                const text = await fs.readFile(f.file, 'utf8');
                lines = text.split(/\r?\n/);
            } catch {
                lines = [];
            }
            cache.set(f.file, lines);
        }
        const idx = f.line - 1;
        const lineText = idx >= 0 && idx < lines.length ? lines[idx] : undefined;
        if (lineText && lineSuppressesId(lineText, f.owaspId)) {
            f.suppressed = true;
        }
    }
    return findings;
}
