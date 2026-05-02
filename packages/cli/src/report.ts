import type { GradeResult, ScanOptions } from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BADGE_ENDPOINT = 'https://mcp-sentry.dev/api/report';
export const MAX_PAYLOAD_BYTES = 1024;

/** Owner/repo regex matches the Worker — TSD §6.2 / §13.2. */
export const OWNER_REPO_RE = /^[a-zA-Z0-9_.-]+$/;

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
	let res: Response;
	try {
		res = await fetchImpl(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
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
