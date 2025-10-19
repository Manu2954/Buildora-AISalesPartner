import { randomUUID } from 'node:crypto';

import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message'
});

export function createLogger(
  bindings: Record<string, unknown> = {},
  requestId: string = randomUUID()
) {
  return logger.child({
    requestId,
    ...bindings
  });
}

export type Logger = ReturnType<typeof createLogger>;
