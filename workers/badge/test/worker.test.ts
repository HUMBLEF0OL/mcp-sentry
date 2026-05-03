import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';

const SCRIPT = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

let worker: Unstable_DevWorker;

let testOwner: string;
let counter = 0;

async function startWorker(opts: { hmacSecret?: string } = {}): Promise<Unstable_DevWorker> {
	return unstable_dev(SCRIPT, {
		config: CONFIG,
		experimental: { disableExperimentalWarning: true },
		local: true,
		// Override the [FILL] KV id from wrangler.toml so tests are hermetic
		// and never touch a real Cloudflare account.
		kv: [{ binding: 'MCP_SENTRY_BADGES', id: 'test-badges' }],
		// v1.1 DO binding: Miniflare auto-instantiates from wrangler.toml.
		vars: opts.hmacSecret ? { BADGE_HMAC_SECRET: opts.hmacSecret } : undefined,
	});
}

async function withWorker<T>(
	opts: { hmacSecret?: string },
	run: (w: Unstable_DevWorker) => Promise<T>,
): Promise<T> {
	const w = await startWorker(opts);
	try {
		return await run(w);
	} finally {
		await w.stop();
	}
}

beforeAll(async () => {
	worker = await startWorker();
});

afterAll(async () => {
	await worker.stop();
});

beforeEach(() => {
	counter++;
	testOwner = `acme-${process.pid}-${counter}`;
});

const BASE_VALID = {
	repo: 'my-mcp-server',
	grade: 'B',
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	version: '1.0.0',
};

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { owner: testOwner, ...BASE_VALID, ...overrides };
}

const VALID = BASE_VALID; // legacy alias for tests that override owner explicitly

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return worker.fetch('/api/report', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	}) as unknown as Promise<Response>;
}

async function get(path: string): Promise<Response> {
	return worker.fetch(path) as unknown as Promise<Response>;
}

describe('GET /health', () => {
	it('returns ok + version', async () => {
		const res = await get('/health');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; version: string };
		expect(body.status).toBe('ok');
		const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { version: string };
		expect(body.version).toBe(pkg.version);
		expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
	});
});

describe('POST /api/report', () => {
	it('rejects non-JSON content-type', async () => {
		const res = (await worker.fetch('/api/report', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{}',
		})) as unknown as Response;
		expect(res.status).toBe(415);
	});

	it('rejects malformed JSON', async () => {
		const res = await post('{not json');
		expect(res.status).toBe(400);
	});

	it('rejects unknown fields', async () => {
		const res = await post(valid({ extra: 'nope' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/unknown field/);
	});

	it('rejects invalid owner/repo characters', async () => {
		const res = await post(valid({ owner: 'bad owner!' }));
		expect(res.status).toBe(400);
	});

	it('rejects invalid grade', async () => {
		const res = await post(valid({ grade: 'Z' }));
		expect(res.status).toBe(400);
	});

	it('rejects negative counts', async () => {
		const res = await post(valid({ high: -1 }));
		expect(res.status).toBe(400);
	});

	it('clamps counts above 9999', async () => {
		const res = await post(valid({ low: 1_000_000 }));
		expect(res.status).toBe(200);
	});

	it('accepts a valid payload and writes to KV', async () => {
		const res = await post(valid());
		expect(res.status).toBe(200);
	});
});

describe('GET /api/badge/{owner}/{repo}', () => {
	it('returns shields.io endpoint JSON after a successful report', async () => {
		const payload = valid();
		await post(payload);
		const res = await get(`/api/badge/${payload.owner}/${payload.repo}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('max-age=3600');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			schemaVersion: 1,
			label: 'mcp-sentry',
			message: 'B',
			color: '97CA00',
			namedLogo: 'shield',
			cacheSeconds: 3600,
		});
	});

	it('returns "unknown" badge for missing repo', async () => {
		const res = await get('/api/badge/never/seen');
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.message).toBe('unknown');
		expect(body.schemaVersion).toBe(1);
	});

	it('rejects invalid owner/repo path segments', async () => {
		const res = await get('/api/badge/bad%20owner/repo');
		expect(res.status).toBe(400);
	});
});

describe('rate limiting', () => {
	it('returns 429 on the 11th POST within the window', async () => {
		// Use a unique owner so this test is independent of any other writes
		// from the suite (Miniflare's local KV persists across worker
		// instances within the same vitest process).
		const payload = valid({ owner: `rl-${process.pid}-${Date.now()}` });
		for (let i = 0; i < 10; i++) {
			const res = await post(payload);
			expect(res.status).toBe(200);
		}
		const res = await post(payload);
		expect(res.status).toBe(429);
		const retry = Number(res.headers.get('retry-after'));
		expect(Number.isFinite(retry)).toBe(true);
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(3600);
	});

	it('isolates counters per owner/repo key', async () => {
		const ownerA = `rl-a-${process.pid}-${Date.now()}`;
		const ownerB = `rl-b-${process.pid}-${Date.now()}`;
		for (let i = 0; i < 10; i++) {
			expect((await post(valid({ owner: ownerA }))).status).toBe(200);
		}
		expect((await post(valid({ owner: ownerA }))).status).toBe(429);
		// Different owner should still be allowed because it maps to a
		// different Durable Object idFromName key.
		expect((await post(valid({ owner: ownerB }))).status).toBe(200);
	});
});

describe('routing', () => {
	it('returns 404 for unknown paths', async () => {
		const res = await get('/unknown');
		expect(res.status).toBe(404);
	});
});

describe('HMAC signing (v1.1 soft-launch)', () => {
	const SECRET = 'topsecret';

	async function hmacHex(secret: string, body: string): Promise<string> {
		const { createHmac } = await import('node:crypto');
		return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
	}

	it('accepts unsigned requests when secret is configured (soft-launch)', async () => {
		await withWorker({ hmacSecret: SECRET }, async (secretWorker) => {
			const owner = `hmac-soft-${process.pid}-${Date.now()}-${counter}`;
			const res = (await secretWorker.fetch('/api/report', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(valid({ owner })),
			})) as unknown as Response;
			expect(res.status).toBe(200);
		});
	});

	it('accepts a correctly-signed request', async () => {
		await withWorker({ hmacSecret: SECRET }, async (secretWorker) => {
			const payload = valid({ owner: `hmac-ok-${process.pid}-${Date.now()}-${counter}` });
			const body = JSON.stringify(payload);
			const sig = `sha256=${await hmacHex(SECRET, body)}`;
			const res = (await secretWorker.fetch('/api/report', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-mcp-sentry-signature': sig },
				body,
			})) as unknown as Response;
			expect(res.status).toBe(200);
		});
	});

	it('rejects a tampered signature with 401', async () => {
		await withWorker({ hmacSecret: SECRET }, async (secretWorker) => {
			const payload = valid({ owner: `hmac-bad-${process.pid}-${Date.now()}-${counter}` });
			const body = JSON.stringify(payload);
			const res = (await secretWorker.fetch('/api/report', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-mcp-sentry-signature': `sha256=${'0'.repeat(64)}`,
				},
				body,
			})) as unknown as Response;
			expect(res.status).toBe(401);
		});
	});

	it('ignores signature header entirely when no secret is configured', async () => {
		// `worker` was started without a secret in beforeAll.
		const payload = valid({ owner: `hmac-none-${process.pid}-${Date.now()}-${counter}` });
		const body = JSON.stringify(payload);
		const res = (await worker.fetch('/api/report', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-mcp-sentry-signature': `sha256=${'f'.repeat(64)}`,
			},
			body,
		})) as unknown as Response;
		expect(res.status).toBe(200);
	});
});
