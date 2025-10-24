import { setTimeout as sleep } from 'node:timers/promises';

import { env } from './env.js';
import { AppError } from './errors.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpRequestOptions = {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  retry?: {
    attempts?: number;
    backoffMs?: number;
    factor?: number;
  };
};

export async function httpRequest<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = Number(process.env.HTTP_TIMEOUT_MS ?? 10_000),
    retry = {}
  } = options;

  const maxAttempts = Math.max(1, retry.attempts ?? Number(process.env.HTTP_RETRY_ATTEMPTS ?? 3));
  const baseBackoff = retry.backoffMs ?? Number(process.env.HTTP_RETRY_BACKOFF_MS ?? 500);
  const factor = retry.factor ?? Number(process.env.HTTP_RETRY_FACTOR ?? 2);

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });

      const payloadText = await response.text();
      const payload = payloadText ? (JSON.parse(payloadText) as T) : ({} as T);

      if (!response.ok) {
        throw new AppError('HTTP_REQUEST_FAILED', `HTTP ${response.status}: ${response.statusText}`, {
          status: response.status,
          details: payload
        });
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetriableError(error)) {
        break;
      }

      const backoff = baseBackoff * factor ** (attempt - 1);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof AppError) {
    throw lastError;
  }
  if (lastError instanceof Error) {
    throw new AppError('HTTP_REQUEST_FAILED', lastError.message, { cause: lastError });
  }
  throw new AppError('HTTP_REQUEST_FAILED', String(lastError));
}

function isRetriableError(error: unknown): boolean {
  if (error instanceof AppError) {
    return typeof error.status === 'number' && error.status >= 500;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return true;
}
