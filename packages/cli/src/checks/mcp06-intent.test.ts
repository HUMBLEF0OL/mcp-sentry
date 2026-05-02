import { describe, expect, it, vi } from 'vitest';
import mcp06, { __resetWarnedForTests, NotImplementedError } from './mcp06-intent.js';

describe('MCP06 — deferred-v1.1 stub', () => {
	it('returns no findings and emits the deferred-notice exactly once to stderr', async () => {
		__resetWarnedForTests();
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			return true;
		});
		try {
			// biome-ignore lint/suspicious/noExplicitAny: stub ignores its args
			const r1 = await mcp06(undefined as any, [], undefined as any);
			// biome-ignore lint/suspicious/noExplicitAny: stub ignores its args
			const r2 = await mcp06(undefined as any, [], undefined as any);
			expect(r1).toEqual([]);
			expect(r2).toEqual([]);
			const noticeCount = writes.filter((w) => w.includes('MCP06')).length;
			expect(noticeCount).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it('NotImplementedError is reserved for direct programmatic invocation', () => {
		const err = new NotImplementedError();
		expect(err.name).toBe('NotImplementedError');
		expect(err.message).toMatch(/MCP06/);
	});
});
