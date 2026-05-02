// A minimal MCP server tool handler with no security findings.
// Tool input is validated and never reaches a shell or fs sink.

import { execFile } from 'node:child_process';
import path from 'node:path';

const ALLOWED_BINARIES = new Set(['ls']);

function validate(name) {
    if (!ALLOWED_BINARIES.has(name)) throw new Error('binary not allowed');
    return name;
}

const server = {
    tool(_name, _schema, handler) {
        return handler;
    },
};

server.tool('list', {}, async (input) => {
    const safe = validate(input.binary);
    return new Promise((resolve, reject) => {
        execFile(safe, [], { timeout: 1000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
});
