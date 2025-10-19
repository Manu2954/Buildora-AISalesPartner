import type { Server } from 'node:http';

import { env } from '@buildora/shared';

import { startMcpServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3005);

let server: Server;

try {
  server = await startMcpServer(PORT);
} catch (error) {
  console.error('[mcp] Failed to start server', error);
  process.exit(1);
  throw error;
}

console.log(`[mcp] MCP server listening on :${PORT} (tz: ${env.TIMEZONE})`);

const shutdown = () => {
  console.log('[mcp] Shutting down MCP server');
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
