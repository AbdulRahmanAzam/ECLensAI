import { AI_SCHEMA_VERSION, type AiAvailabilityRecord } from '@eclens/shared';
import { env } from '../../config/env';
import { aiUnavailable } from './aiErrors';
import { geminiClient, type GeminiClient } from './geminiClient';

const MESSAGES = {
  READY: 'Gemini is connected. Every answer is grounded in this organisation’s stored records and carries source references.',
  NO_API_KEY:
    'AI assistance is unavailable: no Gemini API key is configured on this deployment. Calculated figures, the ECL engine and the audit ledger are unaffected and remain fully usable.',
  DISABLED: 'AI assistance has been switched off for this deployment.',
} as const;

/**
 * The honest state of the AI subsystem, returned alongside every AI response so
 * the UI can say plainly whether it is talking to a model, and if not, why.
 *
 * Deliberately excludes anything secret: the model id is safe to show, the API
 * key is never referenced here and is never read by any response mapper.
 */
export function aiAvailability(client: GeminiClient = geminiClient()): AiAvailabilityRecord {
  const base = {
    model: env.GEMINI_MODEL,
    retrievalProvider: env.GEMINI_RETRIEVAL_PROVIDER,
    schemaVersion: AI_SCHEMA_VERSION,
  };
  if (!env.AI_ENABLED) {
    return { ...base, available: false, reason: 'DISABLED', message: MESSAGES.DISABLED };
  }
  if (!client.configured) {
    return { ...base, available: false, reason: 'NO_API_KEY', message: MESSAGES.NO_API_KEY };
  }
  return { ...base, available: true, reason: 'READY', message: MESSAGES.READY };
}

/** Throws the 503 the UI renders as the "AI Unavailable" state. */
export function assertAiAvailable(client: GeminiClient = geminiClient()): AiAvailabilityRecord {
  const availability = aiAvailability(client);
  if (!availability.available) throw aiUnavailable(availability.message);
  return availability;
}
