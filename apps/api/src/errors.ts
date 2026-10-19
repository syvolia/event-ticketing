// One error shape for the whole API. Every non-2xx response body is:
//   { "error": { "code": "...", "message": "...", "details"?: ... } }
// Clients can rely on `error.code` for programmatic handling.
import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', m, details);
export const unauthenticated = (m = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', m);
export const forbidden = (m = 'Not allowed') => new AppError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', m, details);
export const unprocessable = (m: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', m, details);

export interface ErrorResponseBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function toErrorBody(err: unknown): { status: number; body: ErrorResponseBody } {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.flatten(),
        },
      },
    };
  }
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }
  // Fastify's built-in errors (404 unknown route, 415 unsupported media type,
  // 400 malformed JSON) carry a statusCode. Surface them with a generic code
  // so they do not leak stack traces.
  const maybe = err as { statusCode?: number; message?: string };
  if (typeof maybe.statusCode === 'number') {
    return {
      status: maybe.statusCode,
      body: {
        error: {
          code: maybe.statusCode < 500 ? 'VALIDATION_ERROR' : 'INTERNAL',
          message: maybe.message ?? 'Request failed',
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Internal server error' } },
  };
}