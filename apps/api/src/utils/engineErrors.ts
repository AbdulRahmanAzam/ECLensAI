/**
 * Engine errors -> HTTP errors.
 *
 * The pure domain module rejects invalid input by throwing an `EngineError`
 * carrying a stable code and the exact field/observed/expected values. Those are
 * surfaced verbatim as a 422 so the caller sees the engine's own diagnosis
 * rather than a generic 500 — and so nothing is silently repaired on the way.
 */
import { EngineError } from '@eclens/shared';
import { HttpError, type HttpErrorDetail } from './httpError';

export function toHttpError(error: unknown, fallbackMessage: string): HttpError {
  if (error instanceof EngineError) {
    const details: HttpErrorDetail[] = error.details.map((detail) => ({
      path: detail.field,
      message: [
        detail.field ? `${detail.field}:` : '',
        detail.observed !== undefined ? `observed ${detail.observed}` : '',
        detail.expected !== undefined ? `expected ${detail.expected}` : '',
      ]
        .filter(Boolean)
        .join(' ') || error.message,
    }));
    return new HttpError(422, error.code, error.message, details);
  }
  if (error instanceof HttpError) return error;
  return new HttpError(422, 'ENGINE_REJECTED_INPUT', fallbackMessage);
}
