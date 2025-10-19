import http from 'node:http';

import { env } from '@buildora/shared';

const PORT = Number(process.env.PORT ?? 4003);

const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end('wa channel ok');
});

server.listen(PORT, () => {
  console.log(`[channels-wa] listening on :${PORT} (tz: ${env.TIMEZONE})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
