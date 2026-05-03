import { createHmac } from 'node:crypto';
import type { GradeResult, ScanOptions } from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BADGE_ENDPOINT = 'https://mcp-sentry.dev/api/report';
export const MAX_PAYLOAD_BYTES = 1024;

/** Owner/repo regex matches the Worker — TSD §6.2 / §13.2. */
export const OWNER_REPO_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Header carrying the HMAC-SHA256 signature of the request body
 * (v1.1 soft-launch). Format: `sha256=<hex>`. The Worker verifies when
 * it has `BADGE_HMAC_SECRET` configured AND the header is present;
 * unsigned requests are still accepted during the soft-launch window.
 */
export const SIGNATURE_HEADER = 'x-mcp-sentry-signature';
const SIGNATURE_ENV = 'MCP_SENTRY_SECRET';

export interface ReportPayload {
	owner: string;
	repo: string;
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
	critical: number;
	high: number;
	medium: number;
	low: number;
	version: string;
}

export class ReportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReportError';
	}
}

/**
 * Build the badge POST payload from a scan result. Returns `undefined`
 * when owner/repo are not resolvable — callers should warn the user
 * rather than POSTing without identification.
 */
export function buildReportPayload(
	opts: ScanOptions,
	grade: GradeResult,
): ReportPayload | undefined {
	if (!opts.owner || !opts.repo) return undefined;
	if (!OWNER_REPO_RE.test(opts.owner) || !OWNER_REPO_RE.test(opts.repo)) {
		throw new ReportError(
			`mcp-sentry: --report owner/repo must match ${OWNER_REPO_RE} (got ${opts.owner}/${opts.repo}).`,
		);
	}
	return {
		owner: opts.owner,
		repo: opts.repo,
		grade: grade.grade,
		critical: grade.critical,
		high: grade.high,
		medium: grade.medium,
		low: grade.low,
		version: VERSION,
	};
}

/**
 * Compute the v1.1 HMAC-SHA256 signature header value for a request body.
 * Returns `undefined` when no `MCP_SENTRY_SECRET` env var is set so the
 * caller can omit the header entirely (soft-launch contract).
 */
export function signBody(body: string, secret = process.env[SIGNATURE_ENV]): string | undefined {
	if (!secret || secret.length === 0) return undefined;
	const mac = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
	return `sha256=${mac}`;
}

/**
 * POST the payload to the badge endpoint. Validates payload size <
 * MAX_PAYLOAD_BYTES (TSD §13.1) before sending. Errors are wrapped in
 * `ReportError` so the CLI can degrade gracefully.
 */
export async function postReport(
	payload: ReportPayload,
	endpoint: string = DEFAULT_BADGE_ENDPOINT,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const body = JSON.stringify(payload);
	const bytes = Buffer.byteLength(body, 'utf8');
	if (bytes > MAX_PAYLOAD_BYTES) {
		throw new ReportError(
			`mcp-sentry: --report payload is ${bytes}B, exceeds ${MAX_PAYLOAD_BYTES}B cap.`,
		);
	}
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	const sig = signBody(body);
	if (sig) headers[SIGNATURE_HEADER] = sig;
	let res: Response;
	try {
		res = await fetchImpl(endpoint, {
			method: 'POST',
			headers,
			body,
		});
	} catch (err) {
		throw new ReportError(
			`mcp-sentry: --report POST failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new ReportError(`mcp-sentry: --report POST returned HTTP ${res.status}.`);
	}
}
