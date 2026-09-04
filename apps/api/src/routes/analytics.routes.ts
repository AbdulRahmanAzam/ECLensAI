/**
 * Dashboard aggregates.
 *
 * These exist so the client never has to download a portfolio to draw a chart.
 * A KPI card, a stage-migration matrix, a concentration bar and the copilot's
 * quoted figure all resolve through `analytics.service.ts`, which is also what
 * `services/ai/tools.ts` calls — one implementation, so a number on screen and
 * the same number in an AI answer cannot drift apart.
 *
 * Two rules every handler here keeps:
 *
 *   - **Organization scope comes from the session, never from the query.** No
 *     endpoint takes an organization id, so a cross-tenant read is not
 *     expressible. The worst a caller can do is name a snapshot that belongs to
 *     someone else and get a 404.
 *   - **No endpoint returns a re-derived figure.** Money and rates leave as
 *     decimal strings produced by the same `moneyToString` / `rateToString` the
 *     run detail page uses, so `1,234.56` on a card is byte-identical to the
 *     value in the run's persisted totals.
 *
 * Filters are query parameters rather than a POST body because the dashboard
 * keeps them in the URL: a judge can be handed a link that reproduces exactly
 * the filtered view being discussed.
 */
import {
  analyticsFilterSchema,
  driversQuerySchema,
  migrationQuerySchema,
  movementQuerySchema,
  runComparisonQuerySchema,
  scenarioQuerySchema,
  trendQuerySchema,
} from '@eclens/shared';
import { Router } from 'express';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery } from '../middleware/validate';
import {
  getAnalyticsSummary,
  getConcentration,
  getDrivers,
  getMigrationForPeriods,
  getMovementBridge,
  getPortfolioFilters,
  getRunComparison,
  getScenariosForPeriod,
  getTrend,
} from '../services/analytics.service';

/** The filter-picker endpoint only needs to know which period to enumerate. */
const periodQuerySchema = analyticsFilterSchema.pick({ snapshotId: true });

export const analyticsRouter = Router();

const read = [requireAuth, requirePermission('portfolio:read')] as const;

/**
 * KPI totals for the selected period and filters, plus whether they reconcile
 * to the run's persisted totals. `reconcilesToRun` is false whenever a filter is
 * applied — a filtered view is a legitimate subset, not a disagreement, and the
 * client says so rather than showing a warning that cannot be acted on.
 */
analyticsRouter.get('/summary', ...read, async (req, res, next) => {
  try {
    const filter = parseQuery(analyticsFilterSchema, req.query);
    res.json(await getAnalyticsSummary(currentActor(req).organizationId, filter));
  } catch (error) {
    next(error);
  }
});

/**
 * Opening-to-closing allowance bridge. Rejects a `stage` filter at the schema
 * level, because measuring stage transfers while hiding the loans that left a
 * stage would contradict the component being measured.
 */
analyticsRouter.get('/movement', ...read, async (req, res, next) => {
  try {
    const query = parseQuery(movementQuerySchema, req.query);
    res.json(await getMovementBridge(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

/** Allowance, coverage and balances across every reporting period. */
analyticsRouter.get('/trend', ...read, async (req, res, next) => {
  try {
    const query = parseQuery(trendQuerySchema, req.query);
    res.json(await getTrend(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

/** Risk concentration across segment, product, region, industry and rating. */
analyticsRouter.get('/concentration', ...read, async (req, res, next) => {
  try {
    const filter = parseQuery(analyticsFilterSchema, req.query);
    res.json(await getConcentration(currentActor(req).organizationId, filter));
  } catch (error) {
    next(error);
  }
});

/** Top exposures by allowance, with the staging rule that put each one there. */
analyticsRouter.get('/drivers', ...read, async (req, res, next) => {
  try {
    const { limit, ...filter } = parseQuery(driversQuerySchema, req.query);
    res.json(await getDrivers(currentActor(req).organizationId, filter, limit));
  } catch (error) {
    next(error);
  }
});

/**
 * The values each filter can take, with counts. Served separately from the
 * aggregates so the filter bar stays populated while a chart is still loading,
 * and so changing one filter does not refetch the options for the others.
 */
analyticsRouter.get('/filters', ...read, async (req, res, next) => {
  try {
    const { snapshotId } = parseQuery(periodQuerySchema, req.query);
    res.json(await getPortfolioFilters(currentActor(req).organizationId, snapshotId));
  } catch (error) {
    next(error);
  }
});

/** Scenario contributions (base, upside, downside, weighted) for a period. */
analyticsRouter.get('/scenarios', ...read, async (req, res, next) => {
  try {
    const { snapshotId, runId } = parseQuery(scenarioQuerySchema, req.query);
    res.json(await getScenariosForPeriod(currentActor(req).organizationId, snapshotId, runId));
  } catch (error) {
    next(error);
  }
});

/** Stage migration matrix between two periods, defaulting to the two newest. */
analyticsRouter.get('/migration', ...read, async (req, res, next) => {
  try {
    const { fromSnapshotId, toSnapshotId } = parseQuery(migrationQuerySchema, req.query);
    res.json(await getMigrationForPeriods(currentActor(req).organizationId, fromSnapshotId, toSnapshotId));
  } catch (error) {
    next(error);
  }
});

/** Run-to-run diff for the run detail page: totals, movers and stage changes. */
analyticsRouter.get('/run-comparison', ...read, async (req, res, next) => {
  try {
    const query = parseQuery(runComparisonQuerySchema, req.query);
    res.json(await getRunComparison(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});
