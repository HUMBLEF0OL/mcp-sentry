// VULNERABLE FIXTURE: tool input flows directly into child_process.exec().
// mcp-sentry must report a Critical MCP05-001 finding on the exec() call.

import { exec } from 'node:child_process';
import { readFile } from 'node:fs';

const server = {
    tool(_name, _schema, handler) {
        return handler;
    },
};

server.tool('run', {}, async (input) => {
    const cmd = `echo ${input.command}`;
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
});

server.tool('read', {}, async (input) => {
    const target = input.path;
    return new Promise((resolve, reject) => {
        readFile(target, 'utf8', (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
});
