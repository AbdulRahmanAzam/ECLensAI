/**
 * Portfolio reads: exposures, exposure detail, summary and snapshot history.
 *
 * Every handler scopes by the caller's organizationId taken from the session, so
 * a cross-tenant read is not expressible through a query parameter. `snapshotId`
 * pins a view to one input version; without it every read here resolves to the
 * newest reporting period, because the same exposure publicId exists once per
 * snapshot and an unscoped list would return each loan three times.
 */
import { listQuerySchema } from '@eclens/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery } from '../middleware/validate';
import {
  exportExposuresCsv,
  getExposureDetail,
  getPortfolioSummary,
  listExposures,
  listSnapshots,
} from '../services/portfolio.service';

const snapshotQuerySchema = z.object({ snapshotId: z.string().max(64).optional() });
const snapshotsQuerySchema = z.object({ take: z.coerce.number().int().min(1).max(200).default(50) });

export const portfolioRouter = Router();

portfolioRouter.get('/exposures', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listExposures(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

/**
 * The full filtered-and-sorted set as one CSV, not one page of it. Must be
 * registered before `/exposures/:id` — otherwise Express would read `export`
 * as an exposure id.
 */
portfolioRouter.get('/exposures/export', requireAuth, requirePermission('report:export'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    const { csv, rowCount } = await exportExposuresCsv(currentActor(req), query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="portfolio-export-${rowCount}-rows.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

/**
 * One call carries everything the exposure detail screen shows: source inputs,
 * the live staging decision with reason codes, the latest result, the EAD and PD
 * term structures behind it, override history, open exceptions, lineage and the
 * exposure's own audit trail.
 */
portfolioRouter.get('/exposures/:id', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const { snapshotId } = parseQuery(snapshotQuerySchema, req.query);
    res.json(await getExposureDetail(currentActor(req).organizationId, req.params.id, snapshotId));
  } catch (error) {
    next(error);
  }
});

portfolioRouter.get('/summary', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const { snapshotId } = parseQuery(snapshotQuerySchema, req.query);
    res.json(await getPortfolioSummary(currentActor(req).organizationId, snapshotId));
  } catch (error) {
    next(error);
  }
});

portfolioRouter.get('/snapshots', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const { take } = parseQuery(snapshotsQuerySchema, req.query);
    res.json({ items: await listSnapshots(currentActor(req).organizationId, take) });
  } catch (error) {
    next(error);
  }
});
