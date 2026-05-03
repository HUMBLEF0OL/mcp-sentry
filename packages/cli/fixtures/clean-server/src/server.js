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

process.on('uncaughtException', (err) => {
    console.error('uncaught', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('rejected', err);
});

server.tool(
    'run_allowed_binary',
    { description: 'Executes one of the allow-listed binaries with no arguments and returns its stdout.' },
    async (input) => {
        console.info('tool run_allowed_binary invoked');
        const safe = validate(input.binary);
        return new Promise((resolve, reject) => {
            execFile(safe, [], { timeout: 1000 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });
    },
);
