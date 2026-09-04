import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';
import { HttpError } from '../utils/httpError';

function statusCode(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ZodError) return 400;
  const anyErr = err as { status?: number; type?: string };
  if (anyErr?.type === 'entity.parse.failed') return 400;
  return typeof anyErr?.status === 'number' ? anyErr.status : 500;
}

/** Central error handler: one consistent JSON envelope for every failure. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = statusCode(err);

  if (status >= 500) {
    logger.error({ err, requestId: req.requestId }, 'Unhandled error');
  } else {
    logger.warn({ err: (err as Error)?.message, requestId: req.requestId, status }, 'Request error');
  }

  const body: Record<string, unknown> = {
    error: {
      code:
        err instanceof HttpError
          ? err.code
          : err instanceof ZodError
            ? 'VALIDATION_ERROR'
            : status >= 500
              ? 'INTERNAL_ERROR'
              : 'BAD_REQUEST',
      message:
        err instanceof HttpError
          ? err.message
          : err instanceof ZodError
            ? 'Request validation failed'
            : status >= 500
              ? 'An unexpected error occurred'
              : 'Bad request',
      requestId: req.requestId,
    },
  };

  if (err instanceof HttpError && err.details.length > 0) {
    body.error = { ...(body.error as object), details: err.details };
  }
  if (err instanceof ZodError) {
    body.error = {
      ...(body.error as object),
      details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }

  res.status(status).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} was not found`,
      requestId: req.requestId,
    },
  });
}
