/**
 * The AI response envelope.
 *
 * Every feature answers with `AiResponse<T>`, so the client branches on
 * `status` once instead of once per feature. Three rules make the envelope
 * trustworthy rather than decorative:
 *
 *   - **A failure is carried, not thrown.** `AI_UNAVAILABLE`, `AI_TIMEOUT` and
 *     `AI_SCHEMA_INVALID` come back as HTTP 200 with `result: null`, an honest
 *     message and the real availability record. A 503 that unmounts the panel
 *     is how a working product ends up looking broken; the surrounding page
 *     keeps rendering and the AI panel says plainly what happened.
 *   - **A domain failure still throws.** A run id that does not exist in this
 *     organization is a 404, not a degraded AI answer. Only `AiError` is
 *     converted; anything else propagates to the shared error handler.
 *   - **Aliases are restored here and nowhere else.** Results leave the model
 *     pseudonymized. The reader is the authenticated user whose organization
 *     owns those records, so this is the single place names come back.
 */
import { env } from '../../config/env';
import { aiAvailability } from './availability';
import { AiError } from './aiErrors';
import type { GeminiClient } from './geminiClient';
import type { AiRunResult } from './runner';
import type { AiErrorCode, AiFeature, AiRequestStatus, AiResponse } from '@eclens/shared';

const SUCCESS_MESSAGE =
  'Grounded in this organisation’s stored records. Figures are copied from the cited sources at their stored precision; AI can still make mistakes, so verify before relying on them.';

const REPAIRED_MESSAGE =
  'The first response did not match the required structure and was corrected on a second attempt. The answer below is grounded in stored records; AI can still make mistakes.';

/**
 * `AiRequestStatus` is what the client renders, `AiErrorCode` is what failed.
 * They are not one-to-one: four distinct transport and policy failures all
 * present as a failed request, and only a schema rejection earns its own state.
 */
const STATUS_BY_AI_CODE: Record<AiErrorCode, AiRequestStatus> = {
  AI_UNAVAILABLE: 'UNAVAILABLE',
  AI_TIMEOUT: 'FAILED',
  AI_RATE_LIMITED: 'FAILED',
  AI_SCHEMA_INVALID: 'SCHEMA_INVALID',
  AI_GROUNDING_REJECTED: 'FAILED',
  AI_INPUT_TOO_LARGE: 'FAILED',
  AI_EVIDENCE_MISSING: 'FAILED',
  DOCUMENT_UNSUPPORTED_TYPE: 'FAILED',
  DOCUMENT_PARSE_FAILED: 'FAILED',
  DOCUMENT_SIGNAL_ALREADY_DECIDED: 'FAILED',
};

export function aiRequestStatusFor(error: AiError): AiRequestStatus {
  return STATUS_BY_AI_CODE[error.aiCode];
}

export interface AiEnvelopeContext {
  feature: AiFeature;
  startedAt: number;
  requestId?: string | null;
  client?: GeminiClient;
}

export function successEnvelope<T>(
  context: AiEnvelopeContext,
  run: AiRunResult<T>,
  message = SUCCESS_MESSAGE,
): AiResponse<T> {
  return {
    status: run.status,
    feature: context.feature,
    model: run.model,
    latencyMs: run.latencyMs,
    message: run.status === 'SCHEMA_REPAIRED' ? REPAIRED_MESSAGE : message,
    result: run.redactor.restoreDeep(run.result),
    availability: aiAvailability(context.client),
    requestId: context.requestId ?? null,
    aiRequestId: run.aiRequestId,
    toolActivity: run.toolActivity,
  };
}

export function failureEnvelope<T>(
  context: AiEnvelopeContext,
  error: AiError,
): AiResponse<T> {
  return {
    status: aiRequestStatusFor(error),
    feature: context.feature,
    model: env.GEMINI_MODEL,
    latencyMs: Date.now() - context.startedAt,
    message: error.message,
    result: null,
    availability: aiAvailability(context.client),
    requestId: context.requestId ?? null,
    aiRequestId: null,
    toolActivity: [],
  };
}

/**
 * Runs one feature and wraps whatever comes back in the envelope.
 *
 * This is the whole of a route handler's error handling for an AI call, which
 * is the point: seven features cannot each get the degraded path slightly
 * wrong.
 */
export async function withAiEnvelope<T>(
  context: AiEnvelopeContext,
  produce: () => Promise<AiRunResult<T>>,
  message?: string,
): Promise<AiResponse<T>> {
  try {
    return successEnvelope(context, await produce(), message);
  } catch (error) {
    if (error instanceof AiError) return failureEnvelope<T>(context, error);
    throw error;
  }
}
