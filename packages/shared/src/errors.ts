export class AppError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;
  readonly details?: unknown;

  constructor(code: string, message: string, options: { status?: number; cause?: unknown; details?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
    this.details = options.details;
    this.name = 'AppError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
