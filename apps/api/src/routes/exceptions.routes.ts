/**
 * The exception queue: data-quality issues, analyst overrides awaiting review,
 * unusually large ECL movements, and exposures sitting near a staging threshold.
 *
 * Reads are `portfolio:read` so every role can see the queue. Working an item is
 * `exposure:override` — the permission an authorized analyst already holds for
 * intervening on an exposure — because the shared permission matrix has no
 * dedicated exception-write entry, and inventing one here would leave the
 * endpoint uncallable by every role.
 */
import { exceptionListQuerySchema } from '@eclens/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import {
  acknowledgeException,
  getExceptionSummary,
  listExceptions,
  resolveException,
} from '../services/exceptions.service';

/** A free-text note is recorded with the acknowledgement or resolution. */
const noteSchema = z.object({ note: z.string().max(2000).optional() });

export const exceptionsRouter = Router();

exceptionsRouter.get('/', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(exceptionListQuerySchema, req.query);
    res.json(await listExceptions(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

exceptionsRouter.get('/summary', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    res.json(await getExceptionSummary(currentActor(req).organizationId));
  } catch (error) {
    next(error);
  }
});

exceptionsRouter.post(
  '/:id/acknowledge',
  requireAuth,
  requirePermission('exposure:override'),
  validate(noteSchema),
  async (req, res, next) => {
    try {
      const { note } = req.body as z.infer<typeof noteSchema>;
      res.json({ exception: await acknowledgeException(currentActor(req), req.params.id, note) });
    } catch (error) {
      next(error);
    }
  },
);

exceptionsRouter.post(
  '/:id/resolve',
  requireAuth,
  requirePermission('exposure:override'),
  validate(noteSchema),
  async (req, res, next) => {
    try {
      const { note } = req.body as z.infer<typeof noteSchema>;
      res.json({ exception: await resolveException(currentActor(req), req.params.id, note) });
    } catch (error) {
      next(error);
    }
  },
);
