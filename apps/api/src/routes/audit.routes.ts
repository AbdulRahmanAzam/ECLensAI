/**
 * The immutable audit trail, read-only.
 *
 * There is deliberately no write, update or delete route: events are appended by
 * the services that perform the action, so the trail cannot be edited by anyone
 * who can reach the API. `audit:read` is the only gate.
 */
import { auditListQuerySchema } from '@eclens/shared';
import { Router } from 'express';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery } from '../middleware/validate';
import { listAuditEvents } from '../services/audit.service';

export const auditRouter = Router();

auditRouter.get('/', requireAuth, requirePermission('audit:read'), async (req, res, next) => {
  try {
    const query = parseQuery(auditListQuerySchema, req.query);
    res.json(await listAuditEvents(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});
