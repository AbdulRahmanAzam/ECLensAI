/**
 * The AI surface: one route per feature, plus the copilot's conversation history.
 *
 * Three decisions shape this file, and each is a rule rather than a preference.
 *
 * **A degraded answer is a 200.** Every feature returns `AiResponse<T>`, whose
 * `status` says whether the model actually answered. An unavailable key, a
 * timeout or a schema the model could not satisfy come back with `result: null`
 * and an honest message rather than as a 5xx, because a 503 makes the panel
 * disappear and the surrounding page look broken. Domain failures still throw:
 * a run id from another organisation is a 404, not a sad AI answer.
 *
 * **The rate limiter is mounted per model-calling route, not per router.** It
 * guards model spend, so the copilot's history reads and the feedback write —
 * which touch the database and nothing else — sit outside it, covered by the
 * global limiter in `app.ts`.
 *
 * **`GET /status` is deliberately unlimited and answers without an actor.** It
 * reads no organisation data, only deployment configuration, and it is how the
 * UI learns that AI is unavailable *before* spending a call to find out. Rate
 * limiting it would mean a user locked out of the AI budget could also be locked
 * out of the explanation.
 */
import {
  AI_DISCLAIMER,
  AI_FEATURES,
  aiImportMappingRequestSchema,
  copilotFeedbackRequestSchema,
  copilotQueryRequestSchema,
  executiveCommentaryRequestSchema,
  explainEclRequestSchema,
  investigateQualityRequestSchema,
  listQuerySchema,
  scenarioDraftRequestSchema,
  type AiStatusResponse,
  type CopilotFeedbackRequest,
} from '@eclens/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { env } from '../config/env';
import { currentActor, type AuditActor } from '../lib/audit';
import { aiRateLimit } from '../middleware/aiRateLimit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import { aiAvailability } from '../services/ai/availability';
import {
  getCopilotThread,
  listCopilotThreads,
  queryCopilot,
  recordCopilotFeedback,
} from '../services/ai/copilotService';
import {
  draftScenario,
  explainEcl,
  generateExecutiveCommentary,
  investigateQuality,
  suggestImportMapping,
} from '../services/ai/features';

export const aiRouter = Router();

aiRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

aiRouter.get('/status', requirePermission('ai:use'), (_req, res) => {
  const status: AiStatusResponse = {
    availability: aiAvailability(),
    features: [...AI_FEATURES],
    limits: {
      windowMs: env.AI_RATE_LIMIT_WINDOW_MS,
      maxRequestsPerWindow: env.AI_RATE_LIMIT_MAX,
      maxInputChars: env.AI_MAX_INPUT_CHARS,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      maxDocumentBytes: env.DOCUMENT_AI_MAX_BYTES,
    },
    streaming: false,
    disclaimer: AI_DISCLAIMER,
  };
  res.json(status);
});

// ---------------------------------------------------------------------------
// Copilot conversation
// ---------------------------------------------------------------------------

/**
 * Registers one model-calling route.
 *
 * Worth the small abstraction because it removes a mistake class: with seven
 * features written out by hand, forgetting `aiRateLimit` or `ai:use` on one of
 * them is invisible in review and unbounded in cost. Here those two cannot be
 * omitted without writing the route differently on purpose.
 *
 * The route gate asks "may this user use AI at all". It does not ask "may this
 * user see this portfolio" — each feature asserts that itself, on the records it
 * actually touches, so a caller that reaches the service another way is still
 * stopped.
 */
function aiPost<TRequest>(
  path: string,
  schema: z.ZodType<TRequest>,
  run: (actor: AuditActor, request: TRequest, requestId: string | null) => Promise<unknown>,
): void {
  aiRouter.post(path, requirePermission('ai:use'), aiRateLimit, validate(schema), async (req, res, next) => {
    try {
      res.json(await run(currentActor(req), req.body as TRequest, req.requestId ?? null));
    } catch (error) {
      next(error);
    }
  });
}

aiPost('/copilot/query', copilotQueryRequestSchema, (actor, request, requestId) =>
  queryCopilot(actor, request, { requestId }),
);

aiRouter.get('/copilot/threads', requirePermission('ai:use'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listCopilotThreads(currentActor(req), query));
  } catch (error) {
    next(error);
  }
});

aiRouter.get('/copilot/threads/:threadId', requirePermission('ai:use'), async (req, res, next) => {
  try {
    res.json(await getCopilotThread(currentActor(req), req.params.threadId));
  } catch (error) {
    next(error);
  }
});

aiRouter.post(
  '/copilot/threads/:threadId/turns/:turnId/feedback',
  requirePermission('ai:use'),
  validate(copilotFeedbackRequestSchema),
  async (req, res, next) => {
    try {
      res.json(
        await recordCopilotFeedback(
          currentActor(req),
          req.params.threadId,
          req.params.turnId,
          req.body as CopilotFeedbackRequest,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// The five context features
// ---------------------------------------------------------------------------

aiPost('/explain-ecl', explainEclRequestSchema, (actor, request, requestId) =>
  explainEcl(actor, request, { requestId }),
);

aiPost('/import-mapping', aiImportMappingRequestSchema, (actor, request, requestId) =>
  suggestImportMapping(actor, request, { requestId }),
);

aiPost('/investigate-quality', investigateQualityRequestSchema, (actor, request, requestId) =>
  investigateQuality(actor, request, { requestId }),
);

aiPost('/scenario-draft', scenarioDraftRequestSchema, (actor, request, requestId) =>
  draftScenario(actor, request, { requestId }),
);

aiPost('/executive-commentary', executiveCommentaryRequestSchema, (actor, request, requestId) =>
  generateExecutiveCommentary(actor, request, { requestId }),
);
