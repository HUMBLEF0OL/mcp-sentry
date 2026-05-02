import type { CheckFn, CheckResult } from '../types.js';

let warned = false;

/**
 * MCP06 — Intent Subversion (deferred to v1.1).
 *
 * Registered in the check registry so `mcp-sentry checks` lists it with
 * status `deferred-v1.1`. When invoked at scan time, it returns no findings
 * and emits a one-time stderr notice. It MUST NOT throw — throwing would
 * abort the scan.
 *
 * `NotImplementedError` is reserved for direct programmatic invocation
 * outside the registry path.
 */
export class NotImplementedError extends Error {
    constructor(message = 'MCP06 intent-subversion check is deferred to v1.1') {
        super(message);
        this.name = 'NotImplementedError';
    }
}

const run: CheckFn = async (): Promise<CheckResult[]> => {
    if (!warned) {
        warned = true;
        process.stderr.write('mcp-sentry: MCP06 intent-subversion check is deferred to v1.1\n');
    }
    return [];
};

/** Test-only: reset the one-time warning flag. */
export function __resetWarnedForTests(): void {
    warned = false;
}

export default run;
