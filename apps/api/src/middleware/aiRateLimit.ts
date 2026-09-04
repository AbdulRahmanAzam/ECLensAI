/**
 * The AI budget.
 *
 * Separate from the global limiter in `app.ts` because the two protect different
 * things: that one keeps the API responsive, this one keeps a deployment's model
 * bill bounded. A user who scripts a hundred copilot questions a minute should
 * exhaust their AI allowance without taking the rest of the product down with
 * them, and the reverse — a busy page load burning the AI allowance — should not
 * happen either.
 *
 * One instance is shared by every model-calling route across both AI routers, so
 * the budget is one bucket per user rather than one per endpoint. Twenty
 * questions and twenty document extractions is not forty requests' worth of
 * cost; it is forty.
 */
import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

const WINDOW_SECONDS = Math.max(1, Math.round(env.AI_RATE_LIMIT_WINDOW_MS / 1000));

/**
 * Must be mounted *after* `requireAuth`: the key is the user id, which only
 * exists once the session cookie has been resolved.
 *
 * Keyed by user rather than by IP on purpose. Analysts at one institution share
 * an egress address, so an IP bucket would throttle a whole floor for one
 * person's script, and a determined user on a rotating address would never be
 * throttled at all. The request id and the audit trail already answer "who did
 * this"; the limiter should ask the same question.
 */
export const aiRateLimit = rateLimit({
  windowMs: env.AI_RATE_LIMIT_WINDOW_MS,
  limit: env.AI_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'unattributed',
  message: {
    error: {
      code: 'AI_RATE_LIMITED',
      message: `Too many AI requests: the limit is ${env.AI_RATE_LIMIT_MAX} per ${WINDOW_SECONDS}s. Wait a moment and try again — calculated figures and the audit trail are unaffected.`,
    },
  },
});
