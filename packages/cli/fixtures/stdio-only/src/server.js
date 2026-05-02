// Stdio-only MCP server. MCP07 (auth) MUST NOT fire; MCP08 (logging) MUST
// NOT fire — handler logs and the entrypoint registers a global error
// handler.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = {
    tool(_name, _schema, handler) {
        return handler;
    },
    connect(_t) { },
};

process.on('uncaughtException', (err) => {
    console.error('uncaught', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('rejected', err);
});

server.tool('echo', {}, async (input) => {
    console.info('tool echo invoked', { argLen: String(input.text).length });
    return { text: input.text };
});

server.connect(new StdioServerTransport());
