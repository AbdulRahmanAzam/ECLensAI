/**
 * Portfolio ingestion: upload -> preview -> map -> validate -> commit -> issues.
 *
 * Read paths are gated on `portfolio:read` rather than an `import:read`
 * permission: the matrix in `@eclens/shared` has no such entry, and anyone who
 * may read the portfolio should be able to read the batch it was loaded from.
 * Mutations use the specific `import:*` permissions.
 *
 * Upload and commit both answer immediately with the batch in a transitional
 * state plus a job receipt; the client polls the batch for the outcome. That
 * holds under both job drivers, so a large file never sits on the request path.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  commitRequestSchema,
  listQuerySchema,
  mappingRequestSchema,
  type CommitRequest,
  type MappingRequest,
} from '@eclens/shared';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import { exportIssuesCsv } from '../services/exceptions.service';
import {
  applyImportMapping,
  commitImportBatch,
  getImportIssues,
  getImportPreview,
  listImportBatches,
  uploadPortfolioBatch,
} from '../services/imports.service';
import { HttpError } from '../utils/httpError';

// Created at load rather than per request: the API cannot accept uploads without
// it, so a bad UPLOAD_DIR should fail loudly at startup, not on an analyst's
// first file.
mkdirSync(env.UPLOAD_DIR, { recursive: true });

/** The client-supplied filename is untrusted, so only a short alphanumeric extension survives. */
const safeExtension = (originalName: string): string =>
  (/\.[a-z0-9]{1,8}$/i.exec(path.basename(originalName))?.[0] ?? '').toLowerCase();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, env.UPLOAD_DIR),
    // The client's name is never reused on disk. The service decides CSV versus
    // XLSX from the original extension itself, so nothing downstream needs it.
    filename: (_req, file, callback) =>
      callback(null, `${Date.now()}-${randomBytes(8).toString('hex')}${safeExtension(file.originalname)}`),
  }),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
});

/** Multer reports its own error type; this puts it on the standard JSON envelope. */
const uploadSingleFile = (req: Request, res: Response, next: NextFunction): void => {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(new HttpError(413, 'UPLOAD_TOO_LARGE', `File exceeds the ${env.MAX_UPLOAD_BYTES}-byte upload limit`));
      return;
    }
    next(error instanceof multer.MulterError ? new HttpError(400, 'UPLOAD_REJECTED', error.message) : error);
  });
};

export const importsRouter = Router();

importsRouter.post(
  '/portfolio',
  requireAuth,
  requirePermission('import:upload'),
  uploadSingleFile,
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new HttpError(
          400,
          'MISSING_FILE',
          "Send the portfolio file in the 'file' field of a multipart/form-data request",
        );
      }
      res.status(201).json(await uploadPortfolioBatch(currentActor(req), req.file));
    } catch (error) {
      next(error);
    }
  },
);

importsRouter.get('/', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(listQuerySchema, req.query);
    res.json(await listImportBatches(currentActor(req).organizationId, query));
  } catch (error) {
    next(error);
  }
});

importsRouter.get('/:id/preview', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const actor = currentActor(req);
    res.json(await getImportPreview(actor.organizationId, req.params.id, actor));
  } catch (error) {
    next(error);
  }
});

importsRouter.post(
  '/:id/mapping',
  requireAuth,
  requirePermission('import:map'),
  validate(mappingRequestSchema),
  async (req, res, next) => {
    try {
      const batch = await applyImportMapping(currentActor(req), req.params.id, req.body as MappingRequest);
      res.json({ batch });
    } catch (error) {
      next(error);
    }
  },
);

importsRouter.post(
  '/:id/commit',
  requireAuth,
  requirePermission('import:commit'),
  validate(commitRequestSchema),
  async (req, res, next) => {
    try {
      // 202: the batch is COMMITTED but the ledger write is still in flight.
      res.status(202).json(await commitImportBatch(currentActor(req), req.params.id, req.body as CommitRequest));
    } catch (error) {
      next(error);
    }
  },
);

importsRouter.get('/:id/issues', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    res.json(await getImportIssues(currentActor(req).organizationId, req.params.id));
  } catch (error) {
    next(error);
  }
});

importsRouter.get('/:id/issues/export', requireAuth, requirePermission('report:export'), async (req, res, next) => {
  try {
    const csv = await exportIssuesCsv(currentActor(req), req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.id}-issues.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});
