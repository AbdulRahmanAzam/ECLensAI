import { HttpError } from '../../utils/httpError';
import type { AiErrorCode } from '@eclens/shared';

/**
 * Maps every AI failure onto the one error envelope the rest of the API uses.
 *
 * The status matters as much as the code: `503` tells the client "the AI is
 * down, the product is fine", which is a different situation from `422`
 * "the AI ran but found no evidence to answer with". The UI branches on this.
 */
const STATUS_BY_CODE: Record<AiErrorCode, number> = {
  AI_UNAVAILABLE: 503,
  AI_TIMEOUT: 504,
  AI_RATE_LIMITED: 429,
  AI_SCHEMA_INVALID: 502,
  AI_GROUNDING_REJECTED: 502,
  AI_INPUT_TOO_LARGE: 413,
  AI_EVIDENCE_MISSING: 422,
  DOCUMENT_UNSUPPORTED_TYPE: 415,
  DOCUMENT_PARSE_FAILED: 422,
  DOCUMENT_SIGNAL_ALREADY_DECIDED: 409,
};

export class AiError extends HttpError {
  constructor(
    public readonly aiCode: AiErrorCode,
    message: string,
    details: { path?: string; message: string }[] = [],
  ) {
    super(STATUS_BY_CODE[aiCode], aiCode, message, details);
    this.name = 'AiError';
  }
}

export const aiUnavailable = (reason = 'AI assistance is not configured on this deployment'): AiError =>
  new AiError('AI_UNAVAILABLE', reason);

export const aiTimeout = (timeoutMs: number): AiError =>
  new AiError('AI_TIMEOUT', `The AI request did not complete within ${Math.round(timeoutMs / 1000)}s. Try a narrower question.`);

export const aiRateLimited = (): AiError =>
  new AiError('AI_RATE_LIMITED', 'Too many AI requests. Wait a moment and try again.');

export const aiSchemaInvalid = (issues: string[]): AiError =>
  new AiError('AI_SCHEMA_INVALID', 'The model returned a response that did not match the required structure.', issues.map((message) => ({ message })));

export const aiGroundingRejected = (claims: string[]): AiError =>
  new AiError(
    'AI_GROUNDING_REJECTED',
    'The model produced figures that do not appear in any retrieved record, so the answer was withheld rather than shown.',
    claims.map((claim) => ({ message: `Ungrounded figure: ${claim}` })),
  );

export const aiInputTooLarge = (chars: number, limit: number): AiError =>
  new AiError('AI_INPUT_TOO_LARGE', `Input is ${chars} characters; the limit is ${limit}.`);

export const aiEvidenceMissing = (detail: string): AiError =>
  new AiError('AI_EVIDENCE_MISSING', detail);

export const documentUnsupportedType = (detail: string): AiError => new AiError('DOCUMENT_UNSUPPORTED_TYPE', detail);

export const documentParseFailed = (detail: string): AiError => new AiError('DOCUMENT_PARSE_FAILED', detail);

/**
 * A decided signal is a record of a human judgement, so it is immutable rather
 * than merely locked. Re-deciding one would silently rewrite an audit trail
 * that a reviewer may already have relied on.
 */
export const documentSignalAlreadyDecided = (status: string): AiError =>
  new AiError('DOCUMENT_SIGNAL_ALREADY_DECIDED', `That signal was already ${status.toLowerCase()} and cannot be decided again.`);

/** True for failures worth retrying: throttling, upstream 5xx, transport resets. */
export function isTransientAiFailure(error: unknown): boolean {
  if (error instanceof AiError) {
    return error.aiCode === 'AI_TIMEOUT' || error.aiCode === 'AI_RATE_LIMITED';
  }
  const anyErr = error as { status?: number; code?: string; message?: string };
  if (typeof anyErr?.status === 'number') return anyErr.status === 429 || anyErr.status >= 500;
  const code = String(anyErr?.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ABORT_ERR'].includes(code)) return true;
  return /timeout|timed out|temporarily|overloaded|resource exhausted|socket hang up/i.test(String(anyErr?.message ?? ''));
}
