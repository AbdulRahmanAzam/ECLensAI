import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { HttpError } from '../utils/httpError';

const issuesToDetails = (issues: { path: (string | number)[]; message: string }[]) =>
  issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/**
 * Parses and coerces a query string.
 *
 * `req.query` arrives as `string | string[] | undefined` per key, so list
 * endpoints cannot pass it straight to a service. Parsing here — rather than in
 * each handler — is what makes `?page=abc` a 400 with the same envelope as a
 * bad JSON body, instead of a 500 from somewhere deeper.
 */
export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): S['_output'] {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Query validation failed', issuesToDetails(parsed.error.issues));
  }
  return parsed.data;
}

/** Validates the JSON body with a Zod schema before the handler runs. */
export function validate(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', issuesToDetails(parsed.error.issues)));
      return;
    }
    req.body = parsed.data;
    next();
  };
}
