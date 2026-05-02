import mcp05 from './checks/mcp05-injection.js';
import mcp06 from './checks/mcp06-intent.js';
import type { CheckDescriptor } from './types.js';

/**
 * Check registry — single source of truth for the `checks` subcommand and
 * the scanner. Phase 1 ships MCP05 (active) and MCP06 (deferred stub).
 * Remaining checks land in Phase 2/3.
 */
export const REGISTRY: CheckDescriptor[] = [
    {
        owaspId: 'MCP05',
        title: 'Command Injection',
        description: 'Detects tool input flowing unsanitised into child_process or fs sinks.',
        severities: ['critical'],
        status: 'active',
        run: mcp05,
    },
    {
        owaspId: 'MCP06',
        title: 'Intent Subversion',
        description: 'Deferred to v1.1. Emits a one-time stderr notice; produces no findings.',
        severities: [],
        status: 'deferred-v1.1',
        run: mcp06,
    },
];

export function getActiveChecks(disabled: string[]): CheckDescriptor[] {
    const set = new Set(disabled.map((d) => d.toUpperCase()));
    return REGISTRY.filter((c) => !set.has(c.owaspId.toUpperCase()));
}
