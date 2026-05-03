import { describe, expect, it, vi } from 'vitest';
import { computeGrade } from './grade.js';
import {
	DEFAULT_BADGE_ENDPOINT,
	MAX_PAYLOAD_BYTES,
	ReportError,
	SIGNATURE_HEADER,
	buildReportPayload,
	postReport,
	signBody,
} from './report.js';
import type { CheckResult, ScanOptions } from './types.js';

function opts(owner?: string, repo?: string): ScanOptions {
	return {
		path: '/tmp/scan',
		format: 'json',
		report: true,
		disable: [],
		ignore: [],
		owner,
		repo,
	};
}

const FINDINGS: CheckResult[] = [
	{
		checkId: 'MCP05-001',
		owaspId: 'MCP05',
		severity: 'critical',
		file: '/tmp/scan/x.ts',
		line: 1,
		column: 1,
		message: 'm',
		fix: 'f',
		suppressed: false,
	},
];

describe('buildReportPayload', () => {
	it('returns undefined when owner/repo missing', () => {
		const p = buildReportPayload(opts(), computeGrade([]));
		expect(p).toBeUndefined();
	});

	it('includes version field (TSD §6.2)', () => {
		const p = buildReportPayload(opts('acme', 'srv'), computeGrade(FINDINGS));
		expect(p?.version).toMatch(/\d+\.\d+\.\d+/);
		expect(p?.grade).toBe('D');
		expect(p?.critical).toBe(1);
	});

	it('rejects owner/repo not matching ^[a-zA-Z0-9_.-]+$', () => {
		expect(() => buildReportPayload(opts('bad name', 'srv'), computeGrade([]))).toThrow(
			ReportError,
		);
		expect(() => buildReportPayload(opts('acme', 'bad/name'), computeGrade([]))).toThrow(
			ReportError,
		);
	});
});

describe('postReport', () => {
	it('rejects when payload exceeds 1KB cap', async () => {
		const big = {
			owner: 'a'.repeat(1100),
			repo: 'srv',
			grade: 'A' as const,
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
			version: '1.0.0',
		};
		await expect(postReport(big)).rejects.toThrow(/exceeds/);
	});

	it('uses a stub fetch and posts JSON', async () => {
		const stub = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		await postReport(
			{
				owner: 'acme',
				repo: 'srv',
				grade: 'A',
				critical: 0,
				high: 0,
				medium: 0,
				low: 0,
				version: '1.0.0',
			},
			DEFAULT_BADGE_ENDPOINT,
			stub as unknown as typeof fetch,
		);
		expect(stub).toHaveBeenCalledTimes(1);
		const call = stub.mock.calls[0];
		if (!call) throw new Error('expected fetch to be called');
		const init = call[1] as RequestInit;
		const body = JSON.parse(String(init.body));
		expect(body.version).toBe('1.0.0');
		expect(Buffer.byteLength(String(init.body), 'utf8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
	});

	it('throws ReportError on non-2xx', async () => {
		const stub = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
		await expect(
			postReport(
				{
					owner: 'acme',
					repo: 'srv',
					grade: 'A',
					critical: 0,
					high: 0,
					medium: 0,
					low: 0,
					version: '1.0.0',
				},
				DEFAULT_BADGE_ENDPOINT,
				stub as unknown as typeof fetch,
			),
		).rejects.toThrow(/429/);
	});
});

describe('HMAC signing (v1.1 soft-launch)', () => {
	const PAYLOAD = {
		owner: 'acme',
		repo: 'srv',
		grade: 'A' as const,
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		version: '1.1.0',
	};

	it('signBody returns sha256=<hex> when secret is provided', () => {
		const sig = signBody('hello', 'secret');
		expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('signBody returns undefined when no secret', () => {
		expect(signBody('hello', '')).toBeUndefined();
		expect(signBody('hello', undefined)).toBeUndefined();
	});

	it('postReport adds signature header when MCP_SENTRY_SECRET is set', async () => {
		const stub = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		const prev = process.env.MCP_SENTRY_SECRET;
		process.env.MCP_SENTRY_SECRET = 'topsecret';
		try {
			await postReport(PAYLOAD, DEFAULT_BADGE_ENDPOINT, stub as unknown as typeof fetch);
		} finally {
			// biome-ignore lint/performance/noDelete: must actually unset env var; assigning undefined coerces to string "undefined" in Node
			if (prev === undefined) delete process.env.MCP_SENTRY_SECRET;
			else process.env.MCP_SENTRY_SECRET = prev;
		}
		const call = stub.mock.calls[0];
		if (!call) throw new Error('expected fetch to be called');
		const init = call[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('postReport omits signature header when MCP_SENTRY_SECRET is unset', async () => {
		const stub = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		const prev = process.env.MCP_SENTRY_SECRET;
		// biome-ignore lint/performance/noDelete: must actually unset env var; assigning undefined coerces to string "undefined" in Node
		delete process.env.MCP_SENTRY_SECRET;
		try {
			await postReport(PAYLOAD, DEFAULT_BADGE_ENDPOINT, stub as unknown as typeof fetch);
		} finally {
			if (prev !== undefined) process.env.MCP_SENTRY_SECRET = prev;
		}
		const call = stub.mock.calls[0];
		if (!call) throw new Error('expected fetch to be called');
		const init = call[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers[SIGNATURE_HEADER]).toBeUndefined();
	});
});
