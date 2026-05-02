#!/usr/bin/env node

const RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };

const grade = (process.env.MCP_SENTRY_GRADE || '').trim().toUpperCase();
const min = (process.env.MCP_SENTRY_MIN_GRADE || 'C').trim().toUpperCase();

if (!(grade in RANK)) {
	console.error(`mcp-sentry: invalid grade '${grade}' from scan output.`);
	process.exit(1);
}
if (!(min in RANK)) {
	console.error(`mcp-sentry: invalid min-grade '${min}'.`);
	process.exit(1);
}

if (RANK[grade] > RANK[min]) {
	console.error(`mcp-sentry: grade ${grade} is below threshold ${min}.`);
	process.exit(1);
}
console.log(`mcp-sentry: grade ${grade} meets threshold ${min}.`);
