import http from 'node:http';

import { env } from '@buildora/shared';

const PORT = Number(process.env.PORT ?? 4002);

const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end('mcp ok');
});

server.listen(PORT, () => {
  console.log(`[mcp] listening on :${PORT} (tz: ${env.TIMEZONE})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
