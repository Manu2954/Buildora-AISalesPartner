import type { Server } from 'node:http';
import { env } from '@buildora/shared';

import { shutdownQueue } from './queue.js';
import { startServer } from './server.js';

const PORT = Number(process.env.PORT ?? 4003);

let server: Server;

try {
  server = await startServer(PORT);
} catch (error) {
  console.error('[channels-wa] Failed to start server', error);
  process.exit(1);
  throw error;
}

console.log(`[channels-wa] listening on :${PORT} (tz: ${env.TIMEZONE})`);

const shutdown = async () => {
  console.log('[channels-wa] shutting down');
  try {
    await shutdownQueue();
  } catch (error) {
    console.error('[channels-wa] Failed to close queue', error);
  }
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
