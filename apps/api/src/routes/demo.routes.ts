/**
 * Guided Demo support: reset the database to its deterministic seed state.
 *
 * Double-gated: `DEMO_MODE` (an env flag, default true, meant to be flipped
 * off for anything other than a demo deployment) and `ADMIN` only — this is
 * an unscoped, whole-database wipe-and-reseed, not a permission any ordinary
 * role should carry. The reset invalidates the caller's own session (see
 * `demoReset.service.ts`), so the response clears the session cookie the
 * same way `/auth/logout` does: the client is expected to show "reset
 * complete — log in again" rather than continue on a now-dangling token.
 */
import { Router } from 'express';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { env } from '../config/env';
import { forbidden, HttpError } from '../utils/httpError';
import { COOKIE_NAME } from '../services/auth.service';
import { resetDemoData } from '../services/demoReset.service';

export const demoRouter = Router();

demoRouter.post('/reset', requireAuth, async (req, res, next) => {
  try {
    if (!env.DEMO_MODE) {
      throw new HttpError(403, 'DEMO_MODE_DISABLED', 'This deployment does not have DEMO_MODE enabled.');
    }
    const actor = currentActor(req);
    if (actor.role !== 'ADMIN') {
      throw forbidden('Only an administrator can reset the demo data.');
    }
    const result = await resetDemoData(actor);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json(result);
  } catch (error) {
    next(error);
  }
});
