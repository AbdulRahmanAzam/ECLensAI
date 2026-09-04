export interface HttpErrorDetail {
  path?: string;
  message: string;
}

/** Application-level HTTP error with a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: HttpErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (message = 'Authentication required'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Insufficient permissions for this action'): HttpError =>
  new HttpError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found'): HttpError =>
  new HttpError(404, 'NOT_FOUND', message);
