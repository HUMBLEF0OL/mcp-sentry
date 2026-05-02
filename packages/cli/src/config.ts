import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Format, Grade } from './types.js';

/**
 * Shape of `.mcp-sentry.json` (TSD §8.1). All fields optional. The
 * `output` flag is intentionally NOT settable here — output paths are
 * per-invocation, not persistent config.
 */
export interface FileConfig {
	ignore?: string[];
	disable?: string[];
	failOn?: Grade;
	format?: Format;
	report?: {
		owner?: string;
		repo?: string;
	};
}

/**
 * Load `.mcp-sentry.json` from the given directory. Returns an empty
 * object if the file is absent. Throws on malformed JSON or
 * schema-violating values so the user sees the bad config immediately
 * instead of silently scanning everything.
 */
export async function loadConfig(rootDir: string): Promise<FileConfig> {
	const file = path.join(rootDir, '.mcp-sentry.json');
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		return {};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`mcp-sentry: failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return validateConfig(raw, file);
}

function validateConfig(raw: unknown, file: string): FileConfig {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`mcp-sentry: ${file} must contain a JSON object`);
	}
	const r = raw as Record<string, unknown>;
	const out: FileConfig = {};
	if (r.ignore !== undefined) {
		if (!Array.isArray(r.ignore) || !r.ignore.every((v) => typeof v === 'string')) {
			throw new Error(`mcp-sentry: ${file} "ignore" must be string[]`);
		}
		out.ignore = r.ignore as string[];
	}
	if (r.disable !== undefined) {
		if (!Array.isArray(r.disable) || !r.disable.every((v) => typeof v === 'string')) {
			throw new Error(`mcp-sentry: ${file} "disable" must be string[]`);
		}
		out.disable = r.disable as string[];
	}
	if (r.failOn !== undefined) {
		if (typeof r.failOn !== 'string' || !/^[ABCDF]$/.test(r.failOn)) {
			throw new Error(`mcp-sentry: ${file} "failOn" must be one of A/B/C/D/F`);
		}
		out.failOn = r.failOn as Grade;
	}
	if (r.format !== undefined) {
		if (typeof r.format !== 'string' || !['text', 'json', 'sarif', 'markdown'].includes(r.format)) {
			throw new Error(`mcp-sentry: ${file} "format" must be one of text/json/sarif/markdown`);
		}
		out.format = r.format as Format;
	}
	if (r.report !== undefined) {
		if (r.report === null || typeof r.report !== 'object' || Array.isArray(r.report)) {
			throw new Error(`mcp-sentry: ${file} "report" must be an object`);
		}
		const rr = r.report as Record<string, unknown>;
		out.report = {};
		if (rr.owner !== undefined) {
			if (typeof rr.owner !== 'string') {
				throw new Error(`mcp-sentry: ${file} "report.owner" must be a string`);
			}
			out.report.owner = rr.owner;
		}
		if (rr.repo !== undefined) {
			if (typeof rr.repo !== 'string') {
				throw new Error(`mcp-sentry: ${file} "report.repo" must be a string`);
			}
			out.report.repo = rr.repo;
		}
	}
	return out;
}
