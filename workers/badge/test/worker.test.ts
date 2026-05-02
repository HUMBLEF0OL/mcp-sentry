import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';

const SCRIPT = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url));

let worker: Unstable_DevWorker;

let testOwner: string;
let counter = 0;

beforeEach(async () => {
	counter++;
	testOwner = `acme-${process.pid}-${counter}`;
	worker = await unstable_dev(SCRIPT, {
		config: CONFIG,
		experimental: { disableExperimentalWarning: true },
		local: true,
		// Override the [FILL] KV id from wrangler.toml so tests are hermetic
		// and never touch a real Cloudflare account.
		kv: [{ binding: 'MCP_SENTRY_BADGES', id: 'test-badges' }],
	});
});

afterEach(async () => {
	await worker.stop();
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
		expect(typeof body.version).toBe('string');
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
		expect(res.headers.get('retry-after')).toBeTruthy();
	});
});

describe('routing', () => {
	it('returns 404 for unknown paths', async () => {
		const res = await get('/unknown');
		expect(res.status).toBe(404);
	});
});
