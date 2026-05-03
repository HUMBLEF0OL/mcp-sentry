import mcp01 from './checks/mcp01-secrets.js';
import mcp02 from './checks/mcp02-scope.js';
import mcp03 from './checks/mcp03-poisoning.js';
import mcp04 from './checks/mcp04-supply-chain.js';
import mcp05 from './checks/mcp05-injection.js';
import mcp06 from './checks/mcp06-intent.js';
import mcp07 from './checks/mcp07-auth.js';
import mcp08 from './checks/mcp08-logging.js';
import type { CheckDescriptor } from './types.js';

/**
 * Check registry — single source of truth for the `checks` subcommand and
 * the scanner.
 */
export const REGISTRY: CheckDescriptor[] = [
	{
		owaspId: 'MCP01',
		title: 'Token / Secret Exposure',
		description: 'Detects hardcoded API keys, tokens, and other secrets in source.',
		severities: ['critical'],
		status: 'active',
		run: mcp01,
	},
	{
		owaspId: 'MCP02',
		title: 'Privilege Scope Creep',
		description: 'Flags overly-broad Zod schemas and unbounded fs / glob access patterns.',
		severities: ['high', 'medium'],
		status: 'active',
		run: mcp02,
	},
	{
		owaspId: 'MCP03',
		title: 'Tool Poisoning',
		description: 'Detects hidden instructions, ANSI escapes, and shadowed tool names.',
		severities: ['high', 'medium'],
		status: 'active',
		run: mcp03,
	},
	{
		owaspId: 'MCP04',
		title: 'Supply Chain',
		description: 'Audits dependencies, version ranges, lockfile presence, and known-bad packages.',
		severities: ['critical', 'high', 'medium'],
		status: 'active',
		run: mcp04,
	},
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
		description:
			'Detects mismatch between advertised tool intent (name/description) and side-effecting handler behaviour, plus missing or trivially short descriptions.',
		severities: ['high', 'medium'],
		status: 'active',
		run: mcp06,
	},
	{
		owaspId: 'MCP07',
		title: 'Insufficient Authentication',
		description:
			'Flags HTTP transports without bearer/JWT/API-key/middleware. Stdio servers are exempt.',
		severities: ['high'],
		status: 'active',
		run: mcp07,
	},
	{
		owaspId: 'MCP08',
		title: 'Missing Audit Logging',
		description:
			'Detects tool handlers without log calls, raw error propagation, and missing global error handler.',
		severities: ['medium', 'low'],
		status: 'active',
		run: mcp08,
	},
];

export function getActiveChecks(disabled: string[]): CheckDescriptor[] {
	const set = new Set(disabled.map((d) => d.toUpperCase()));
	return REGISTRY.filter((c) => !set.has(c.owaspId.toUpperCase()));
}
