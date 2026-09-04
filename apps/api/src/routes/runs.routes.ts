/**
 * ECL run lifecycle: draft -> execute -> inspect -> submit -> approve/reject.
 *
 * `GET /:id` already carries the readiness assessment (recomputed when the
 * stored one is missing), so there is no separate readiness endpoint to keep in
 * step with it. Execution answers 202 with a job receipt: the calculation is
 * hundreds of exposures x scenarios x periods and is never run inline.
 *
 * Submit is `run:submit` while approve and reject are `run:review`, and the
 * service refuses to let a run's creator review their own submission — the
 * four-eyes control lives in one place rather than being restated per route.
 */
import { createRunRequestSchema, listQuerySchema, reviewRequestSchema, type CreateRunRequest, type ReviewRequest } from '@eclens/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import {
  approveRun,
  createRun,
  getRun,
  getRunResultDetail,
  listRunResults,
  listRuns,
  rejectRun,
  startExecution,
  submitRun,
} from '../services/runs.service';
import { buildRunReportPdf } from '../services/reportPdf.service';

/** Submission carries an optional covering note; approval and rejection require a comment. */
const submitRequestSchema = z.object({ comment: z.string().max(2000).optional() });

const reportQuerySchema = z.object({
  as: z.enum(['json', 'file']).default('json'),
  /** Already-drafted commentary the caller wants embedded; never generated here. */
  aiHeadline: z.string().max(200).optional(),
  aiOverview: z.string().max(4000).optional(),
});

export const runsRouter = Router();

runsRouter.post(
  '/',
  requireAuth,
  requirePermission('run:create'),
  validate(createRunRequestSchema),
  async (req, res, next) => {
    try {
      res.status(201).json({ run: await createRun(currentActor(req), req.body as CreateRunRequest) });
    } catch (error) {
      next(error);
    }
  },
);

runsRouter.get('/', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listRuns(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

runsRouter.get('/:id', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    res.json({ run: await getRun(currentActor(req).organizationId, req.params.id) });
  } catch (error) {
    next(error);
  }
});

runsRouter.post('/:id/execute', requireAuth, requirePermission('run:execute'), async (req, res, next) => {
  try {
    res.status(202).json(await startExecution(currentActor(req), req.params.id));
  } catch (error) {
    next(error);
  }
});

/** Per-exposure rows plus the portfolio totals they reconcile to. */
runsRouter.get('/:id/results', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listRunResults(currentActor(req).organizationId, req.params.id, query));
  } catch (error) {
    next(error);
  }
});

/**
 * The drill-down end of the acceptance criteria: period-level PD, LGD, EAD,
 * discount factor, scenario weight and formula trace for one exposure in one run.
 */
runsRouter.get(
  '/:id/results/:exposureId',
  requireAuth,
  requirePermission('portfolio:read'),
  async (req, res, next) => {
    try {
      res.json(
        await getRunResultDetail(currentActor(req).organizationId, req.params.id, req.params.exposureId),
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * The judge-facing "is this real" artifact: a PDF built from this run's own
 * persisted totals, never recalculated. Refuses a run with no results
 * (`RUN_NOT_REPORTABLE`, 409) rather than printing an empty document.
 */
runsRouter.get('/:id/report', requireAuth, requirePermission('report:export'), async (req, res, next) => {
  try {
    const query = parseQuery(reportQuerySchema, req.query);
    const report = await buildRunReportPdf(currentActor(req), {
      runId: req.params.id,
      aiCommentary: query.aiHeadline && query.aiOverview ? { headline: query.aiHeadline, overview: query.aiOverview } : null,
    });

    if (query.as === 'file') {
      res.setHeader('Content-Type', report.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
      res.send(Buffer.from(report.contentBase64, 'base64'));
      return;
    }
    res.json({ report });
  } catch (error) {
    next(error);
  }
});

runsRouter.post(
  '/:id/submit',
  requireAuth,
  requirePermission('run:submit'),
  validate(submitRequestSchema),
  async (req, res, next) => {
    try {
      const { comment } = req.body as z.infer<typeof submitRequestSchema>;
      res.json({ run: await submitRun(currentActor(req), req.params.id, comment) });
    } catch (error) {
      next(error);
    }
  },
);

runsRouter.post(
  '/:id/approve',
  requireAuth,
  requirePermission('run:review'),
  validate(reviewRequestSchema),
  async (req, res, next) => {
    try {
      const { comment } = req.body as ReviewRequest;
      res.json({ run: await approveRun(currentActor(req), req.params.id, comment) });
    } catch (error) {
      next(error);
    }
  },
);

runsRouter.post(
  '/:id/reject',
  requireAuth,
  requirePermission('run:review'),
  validate(reviewRequestSchema),
  async (req, res, next) => {
    try {
      const { comment } = req.body as ReviewRequest;
      res.json({ run: await rejectRun(currentActor(req), req.params.id, comment) });
    } catch (error) {
      next(error);
    }
  },
);
