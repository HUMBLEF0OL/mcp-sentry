/**
 * mcp-sentry badge API — Cloudflare Worker (v1.1).
 *
 * Endpoints (TSD §6.1):
 *   POST /api/report             — write grade to KV
 *   GET  /api/badge/{owner}/{repo} — Shields.io endpoint JSON
 *   GET  /health                 — uptime probe
 *
 * Security (TSD §6.6, §13.2):
 *   - Strict POST schema, unknown fields rejected
 *   - owner/repo regex /^[a-zA-Z0-9_.-]+$/ max 100 chars
 *   - integer counts clamped to [0, 9999]
 *   - CSP default-src 'none' on every response
 *   - CORS * only on GET /api/badge
 *   - Rate limit: 10 POSTs per owner/repo per hour via a Durable Object
 *     atomic counter (replaces the v1.0 KV-timestamp design which had a
 *     documented TOCTOU race; see TSD §6.5).
 *   - HMAC-SHA256 request signing (v1.1 soft-launch). When the
 *     `BADGE_HMAC_SECRET` Worker secret is configured AND a request
 *     carries `x-mcp-sentry-signature: sha256=<hex>`, the Worker verifies
 *     the digest and rejects mismatches with 401. Unsigned requests are
 *     still accepted during the soft-launch window so older CLIs continue
 *     to function. With no secret configured, the signature header is
 *     ignored entirely.
 */

export interface Env {
	MCP_SENTRY_BADGES: KVNamespace;
	RATE_LIMITER: DurableObjectNamespace;
	/** Optional v1.1 HMAC secret. Set via `wrangler secret put BADGE_HMAC_SECRET`. */
	BADGE_HMAC_SECRET?: string;
}

const WORKER_VERSION = '1.1.0';

const OWNER_REPO_RE = /^[a-zA-Z0-9_.-]+$/;
const OWNER_REPO_MAX = 100;
const GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
type Grade = (typeof GRADES)[number];
const GRADE_COLOR: Record<Grade, string> = {
	A: '4c1',
	B: '97CA00',
	C: 'dfb317',
	D: 'fe7d37',
	F: 'e05d44',
};

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const SIGNATURE_HEADER = 'x-mcp-sentry-signature';

const REPORT_FIELDS = new Set([
	'owner',
	'repo',
	'grade',
	'critical',
	'high',
	'medium',
	'low',
	'version',
]);

interface ReportPayload {
	owner: string;
	repo: string;
	grade: Grade;
	critical: number;
	high: number;
	medium: number;
	low: number;
	version: string;
}

interface BadgeRecord {
	grade: Grade;
	critical: number;
	high: number;
	medium: number;
	low: number;
	version: string;
	updatedAt: string;
}

const SECURITY_HEADERS: Record<string, string> = {
	'content-security-policy': "default-src 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
};

function jsonResponse(
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...SECURITY_HEADERS,
			...extraHeaders,
		},
	});
}

function clampCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
	return Math.min(value, 9999);
}

function isOwnerRepo(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= OWNER_REPO_MAX &&
		OWNER_REPO_RE.test(value)
	);
}

function isGrade(value: unknown): value is Grade {
	return typeof value === 'string' && (GRADES as readonly string[]).includes(value);
}

function validateReport(
	raw: unknown,
): { ok: true; payload: ReportPayload } | { ok: false; error: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: 'body must be a JSON object' };
	}
	const obj = raw as Record<string, unknown>;

	for (const key of Object.keys(obj)) {
		if (!REPORT_FIELDS.has(key)) {
			return { ok: false, error: `unknown field: ${key}` };
		}
	}

	if (!isOwnerRepo(obj.owner)) {
		return { ok: false, error: 'invalid owner' };
	}
	if (!isOwnerRepo(obj.repo)) {
		return { ok: false, error: 'invalid repo' };
	}
	if (!isGrade(obj.grade)) {
		return { ok: false, error: 'grade must be one of A/B/C/D/F' };
	}
	const critical = clampCount(obj.critical);
	const high = clampCount(obj.high);
	const medium = clampCount(obj.medium);
	const low = clampCount(obj.low);
	if (critical === null || high === null || medium === null || low === null) {
		return { ok: false, error: 'counts must be non-negative integers' };
	}
	if (typeof obj.version !== 'string' || obj.version.length === 0 || obj.version.length > 64) {
		return { ok: false, error: 'invalid version' };
	}

	return {
		ok: true,
		payload: {
			owner: obj.owner,
			repo: obj.repo,
			grade: obj.grade,
			critical,
			high,
			medium,
			low,
			version: obj.version,
		},
	};
}

function badgeKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

/**
 * Constant-time hex string comparison. The Workers runtime exposes
 * `crypto.subtle` but not `crypto.timingSafeEqual`; this loop runs in
 * O(n) time independent of where mismatches occur, eliminating timing
 * side channels on signature comparison.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

const HEX = '0123456789abcdef';
function bytesToHex(buf: ArrayBuffer): string {
	const view = new Uint8Array(buf);
	let out = '';
	for (let i = 0; i < view.length; i++) {
		const byte = view[i] as number;
		out += HEX[byte >>> 4];
		out += HEX[byte & 0x0f];
	}
	return out;
}

/**
 * Verify the HMAC-SHA256 signature header against the raw request body
 * using `BADGE_HMAC_SECRET`. Returns:
 *   'no-secret'    — Worker has no secret configured; skip verification.
 *   'no-signature' — request did not include the header; soft-launch accept.
 *   'valid'        — signature matches.
 *   'invalid'      — signature mismatched; caller should reject 401.
 */
async function verifySignature(
	req: Request,
	body: string,
	env: Env,
): Promise<'no-secret' | 'no-signature' | 'valid' | 'invalid'> {
	const secret = env.BADGE_HMAC_SECRET;
	if (!secret || secret.length === 0) return 'no-secret';
	const header = req.headers.get(SIGNATURE_HEADER);
	if (!header) return 'no-signature';
	const m = /^sha256=([0-9a-fA-F]+)$/.exec(header);
	if (!m || !m[1]) return 'invalid';
	const provided = m[1].toLowerCase();
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	const expected = bytesToHex(sig);
	return timingSafeEqualHex(provided, expected) ? 'valid' : 'invalid';
}

/**
 * Durable Object atomic rate limiter (v1.1, replaces v1.0 KV-timestamp
 * counter). All POSTs for a given owner/repo route through a single DO
 * instance keyed by `idFromName(owner/repo)`; per-instance fetch handlers
 * execute serially so the read-prune-decide-write sequence is atomic and
 * the v1.0 TOCTOU race no longer applies (TSD §6.5, §14 item 7).
 */
export class RateLimiter {
	private state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname !== '/check' || req.method !== 'POST') {
			return new Response('not found', { status: 404 });
		}
		const { now } = (await req.json()) as { now: number };
		const stored = (await this.state.storage.get<number[]>('timestamps')) ?? [];
		const fresh = stored.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
		if (fresh.length >= RATE_LIMIT_MAX) {
			const oldest = fresh[0] ?? now;
			const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
			return new Response(
				JSON.stringify({
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
				}),
				{ headers: { 'content-type': 'application/json' } },
			);
		}
		fresh.push(now);
		await this.state.storage.put('timestamps', fresh);
		// Schedule alarm to drop entries when the window rolls; bounds storage.
		await this.state.storage.setAlarm(now + RATE_LIMIT_WINDOW_MS + 1000);
		return new Response(JSON.stringify({ allowed: true }), {
			headers: { 'content-type': 'application/json' },
		});
	}

	async alarm(): Promise<void> {
		const stored = (await this.state.storage.get<number[]>('timestamps')) ?? [];
		const now = Date.now();
		const fresh = stored.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
		if (fresh.length === 0) {
			await this.state.storage.delete('timestamps');
		} else {
			await this.state.storage.put('timestamps', fresh);
		}
	}
}

async function checkRateLimit(
	env: Env,
	owner: string,
	repo: string,
	now: number,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
	const id = env.RATE_LIMITER.idFromName(`${owner}/${repo}`);
	const stub = env.RATE_LIMITER.get(id);
	const res = await stub.fetch('https://rate-limiter/check', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ now }),
	});
	return (await res.json()) as { allowed: boolean; retryAfterSeconds?: number };
}

async function handleReport(req: Request, env: Env): Promise<Response> {
	const ct = req.headers.get('content-type') ?? '';
	if (ct.split(';')[0]?.trim() !== 'application/json') {
		return jsonResponse(415, { error: 'content-type must be application/json' });
	}
	// Read body as text first so HMAC verification runs against the exact
	// byte sequence the client signed (JSON.stringify round-trips can
	// drift on whitespace / key order).
	const bodyText = await req.text();

	const sigStatus = await verifySignature(req, bodyText, env);
	if (sigStatus === 'invalid') {
		return jsonResponse(401, { error: 'invalid signature' });
	}

	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		return jsonResponse(400, { error: 'invalid JSON' });
	}
	const validated = validateReport(body);
	if (!validated.ok) {
		return jsonResponse(400, { error: validated.error });
	}
	const { payload } = validated;

	const now = Date.now();
	const limit = await checkRateLimit(env, payload.owner, payload.repo, now);
	if (!limit.allowed) {
		return jsonResponse(
			429,
			{ error: 'rate limit exceeded' },
			{ 'retry-after': String(limit.retryAfterSeconds ?? 60) },
		);
	}

	const record: BadgeRecord = {
		grade: payload.grade,
		critical: payload.critical,
		high: payload.high,
		medium: payload.medium,
		low: payload.low,
		version: payload.version,
		updatedAt: new Date(now).toISOString(),
	};
	await env.MCP_SENTRY_BADGES.put(badgeKey(payload.owner, payload.repo), JSON.stringify(record));

	return jsonResponse(200, { status: 'ok' });
}

async function handleBadge(env: Env, owner: string, repo: string): Promise<Response> {
	if (!isOwnerRepo(owner) || !isOwnerRepo(repo)) {
		return jsonResponse(400, { error: 'invalid owner/repo' });
	}
	const raw = await env.MCP_SENTRY_BADGES.get(badgeKey(owner, repo));
	let grade: Grade = 'F';
	let color: string = GRADE_COLOR.F;
	let message: string;
	if (!raw) {
		message = 'unknown';
		color = '9f9f9f';
	} else {
		try {
			const parsed = JSON.parse(raw) as BadgeRecord;
			if (isGrade(parsed.grade)) {
				grade = parsed.grade;
				message = grade;
				color = GRADE_COLOR[grade];
			} else {
				message = 'unknown';
				color = '9f9f9f';
			}
		} catch {
			message = 'unknown';
			color = '9f9f9f';
		}
	}

	return jsonResponse(
		200,
		{
			schemaVersion: 1,
			label: 'mcp-sentry',
			message,
			color,
			namedLogo: 'shield',
			cacheSeconds: 3600,
		},
		{
			'cache-control': 'max-age=3600',
			'access-control-allow-origin': '*',
		},
	);
}

function handleHealth(): Response {
	return jsonResponse(200, { status: 'ok', version: WORKER_VERSION });
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const { pathname } = url;

		if (req.method === 'POST' && pathname === '/api/report') {
			return handleReport(req, env);
		}

		if (req.method === 'GET' && pathname === '/health') {
			return handleHealth();
		}

		if (req.method === 'GET' && pathname.startsWith('/api/badge/')) {
			const rest = pathname.slice('/api/badge/'.length);
			const [owner, repo, ...extra] = rest.split('/');
			if (!owner || !repo || extra.length > 0) {
				return jsonResponse(400, { error: 'expected /api/badge/{owner}/{repo}' });
			}
			return handleBadge(env, decodeURIComponent(owner), decodeURIComponent(repo));
		}

		return jsonResponse(404, { error: 'not found' });
	},
};
