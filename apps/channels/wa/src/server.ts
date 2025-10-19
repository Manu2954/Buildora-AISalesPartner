import type { Application, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { Server } from 'node:http';

import { createLogger, metricsSnapshot } from '@buildora/shared';

import { webhookRouter } from './routes/webhook.js';

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

export function createApp(): Application {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(await metricsSnapshot());
  });

  app.use('/webhook', webhookRouter);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    createLogger({ component: 'wa-server' }).error({ error }, 'unhandled server error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  });

  return app;
}

export function startServer(port: number): Promise<Server> {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}
