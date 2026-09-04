/**
 * Analyst stage overrides, and the reviewer queue that approves them.
 *
 * Two routers because the two sides of an override have different permissions:
 * `exposure:override` raises one, `override:review` disposes of it. The service
 * layer additionally refuses self-review, so a raised override always reaches a
 * second pair of eyes before it changes a stage.
 */
import { stageOverrideRequestSchema, overrideReviewRequestSchema, listQuerySchema, type OverrideReviewRequest, type StageOverrideRequest } from '@eclens/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import {
  listStageOverrides,
  overrideHistory,
  requestStageOverride,
  reviewStageOverride,
} from '../services/overrides.service';

/** Mounted at `/api/v1/exposures`. */
export const exposuresRouter = Router();

exposuresRouter.post(
  '/:id/stage-override',
  requireAuth,
  requirePermission('exposure:override'),
  validate(stageOverrideRequestSchema),
  async (req, res, next) => {
    try {
      const override = await requestStageOverride(
        currentActor(req),
        req.params.id,
        req.body as StageOverrideRequest,
      );
      // 201: the override exists but is not yet in force — it awaits review.
      res.status(201).json({ override });
    } catch (error) {
      next(error);
    }
  },
);

exposuresRouter.get('/:id/override-history', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    res.json({ items: await overrideHistory(currentActor(req).organizationId, req.params.id) });
  } catch (error) {
    next(error);
  }
});

const overrideListQuerySchema = listQuerySchema.extend({
  status: z.enum(['PENDING_REVIEW', 'REVIEWED', 'REJECTED']).optional(),
});

/** Mounted at `/api/v1/stage-overrides`. */
export const overridesRouter = Router();

overridesRouter.get('/', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(overrideListQuerySchema, req.query);
    res.json(await listStageOverrides(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

overridesRouter.post(
  '/:id/review',
  requireAuth,
  requirePermission('override:review'),
  validate(overrideReviewRequestSchema),
  async (req, res, next) => {
    try {
      const override = await reviewStageOverride(
        currentActor(req),
        req.params.id,
        req.body as OverrideReviewRequest,
      );
      res.json({ override });
    } catch (error) {
      next(error);
    }
  },
);
