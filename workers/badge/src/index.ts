/**
 * mcp-sentry badge API — Cloudflare Worker.
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
 *   - Rate limit: 10 POSTs per owner/repo per hour via KV timestamps
 *     (TOCTOU race accepted for v1.0 — see TSD §6.5)
 */

export interface Env {
	MCP_SENTRY_BADGES: KVNamespace;
}

const WORKER_VERSION = '1.0.0';

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
	// Per TSD §6.4 — owner/repo are encoded in the KV key, not the value.
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

function rateLimitKey(owner: string, repo: string): string {
	return `rl:${owner}/${repo}`;
}

/**
 * KV-timestamp rate limiter (TSD §6.5). Stores recent POST timestamps as a
 * JSON array under `rl:{owner}/{repo}`, prunes entries older than the
 * window, and rejects when count >= RATE_LIMIT_MAX. Subject to a known
 * TOCTOU race under concurrent writers (accepted for v1.0).
 */
async function checkAndRecordRateLimit(
	env: Env,
	owner: string,
	repo: string,
	now: number,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
	const key = rateLimitKey(owner, repo);
	const raw = await env.MCP_SENTRY_BADGES.get(key);
	let timestamps: number[] = [];
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				timestamps = parsed.filter(
					(n): n is number => typeof n === 'number' && now - n < RATE_LIMIT_WINDOW_MS,
				);
			}
		} catch {
			// corrupt entry — reset
			timestamps = [];
		}
	}

	if (timestamps.length >= RATE_LIMIT_MAX) {
		const oldest = timestamps[0] ?? now;
		const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
		};
	}

	timestamps.push(now);
	// KV expirationTtl is in seconds; round up to keep entries until window rolls.
	await env.MCP_SENTRY_BADGES.put(key, JSON.stringify(timestamps), {
		expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
	});

	return { allowed: true };
}

async function handleReport(req: Request, env: Env): Promise<Response> {
	const ct = req.headers.get('content-type') ?? '';
	if (ct.split(';')[0]?.trim() !== 'application/json') {
		return jsonResponse(415, { error: 'content-type must be application/json' });
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return jsonResponse(400, { error: 'invalid JSON' });
	}
	const validated = validateReport(body);
	if (!validated.ok) {
		return jsonResponse(400, { error: validated.error });
	}
	const { payload } = validated;

	const now = Date.now();
	const limit = await checkAndRecordRateLimit(env, payload.owner, payload.repo, now);
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
