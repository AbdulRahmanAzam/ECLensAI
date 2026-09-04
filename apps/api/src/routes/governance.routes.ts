/**
 * Model governance: scenario sets and model configurations.
 *
 * Both are versioned and append-only — a POST creates a new version, it never
 * edits one in place, which is what keeps a completed run reproducible. Reads
 * use `*:read`, writes `*:write`, so a REVIEWER or AUDITOR can see the
 * assumptions behind a number without being able to change them.
 */
import {
  createModelConfigurationRequestSchema,
  createScenarioSetRequestSchema,
  listQuerySchema,
  type CreateModelConfigurationRequest,
  type CreateScenarioSetRequest,
} from '@eclens/shared';
import { Router } from 'express';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import {
  approveScenarioSet,
  createModelConfiguration,
  createScenarioSet,
  getModelConfiguration,
  getScenarioSet,
  listModelConfigurations,
  listScenarioSets,
} from '../services/governance.service';

/** Mounted at `/api/v1/scenario-sets`. */
export const scenarioSetsRouter = Router();

scenarioSetsRouter.get('/', requireAuth, requirePermission('scenario:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listScenarioSets(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

scenarioSetsRouter.post(
  '/',
  requireAuth,
  requirePermission('scenario:write'),
  validate(createScenarioSetRequestSchema),
  async (req, res, next) => {
    try {
      const record = await createScenarioSet(currentActor(req), req.body as CreateScenarioSetRequest);
      res.status(201).json({ scenarioSet: record });
    } catch (error) {
      next(error);
    }
  },
);

scenarioSetsRouter.get('/:id', requireAuth, requirePermission('scenario:read'), async (req, res, next) => {
  try {
    res.json({ scenarioSet: await getScenarioSet(currentActor(req).organizationId, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** Deliberately separate from creation — see `approveScenarioSet`. */
scenarioSetsRouter.post('/:id/approve', requireAuth, requirePermission('scenario:approve'), async (req, res, next) => {
  try {
    res.json({ scenarioSet: await approveScenarioSet(currentActor(req), req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** Mounted at `/api/v1/model-configurations`. */
export const modelConfigurationsRouter = Router();

modelConfigurationsRouter.get('/', requireAuth, requirePermission('model:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listModelConfigurations(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

modelConfigurationsRouter.post(
  '/',
  requireAuth,
  requirePermission('model:write'),
  validate(createModelConfigurationRequestSchema),
  async (req, res, next) => {
    try {
      const record = await createModelConfiguration(currentActor(req), req.body as CreateModelConfigurationRequest);
      res.status(201).json({ modelConfiguration: record });
    } catch (error) {
      next(error);
    }
  },
);

modelConfigurationsRouter.get('/:id', requireAuth, requirePermission('model:read'), async (req, res, next) => {
  try {
    res.json({ modelConfiguration: await getModelConfiguration(currentActor(req).organizationId, req.params.id) });
  } catch (error) {
    next(error);
  }
});
