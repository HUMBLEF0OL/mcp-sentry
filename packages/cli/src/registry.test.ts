import { describe, expect, it } from 'vitest';
import { REGISTRY, getActiveChecks } from './registry.js';

describe('check registry', () => {
	it('lists MCP05 and MCP06 as active', () => {
		const m5 = REGISTRY.find((c) => c.owaspId === 'MCP05');
		const m6 = REGISTRY.find((c) => c.owaspId === 'MCP06');
		expect(m5?.status).toBe('active');
		expect(m6?.status).toBe('active');
	});

	it('honours --disable', () => {
		const enabled = getActiveChecks(['MCP05']);
		expect(enabled.find((c) => c.owaspId === 'MCP05')).toBeUndefined();
		expect(enabled.find((c) => c.owaspId === 'MCP06')).toBeDefined();
	});
});
