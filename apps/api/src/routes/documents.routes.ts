/**
 * Governance documents: upload, list, open, delete, extract, decide.
 *
 * **Memory storage, not disk.** `imports.routes.ts` writes the portfolio upload
 * to `UPLOAD_DIR` because a large CSV has to survive the request while a job
 * worker reads it. A document does not: parsing, chunking and indexing all
 * happen inline, and `uploadDocument` keeps no bytes. Holding an untrusted PDF
 * on the API host's filesystem for the duration of a request buys nothing and
 * leaves something to clean up, so it never lands there.
 *
 * **The MIME type is refused before the bytes are buffered.** That is the one
 * place this router does validation the service also does, and the reason is
 * memory: with `memoryStorage` a rejected file would otherwise already have cost
 * ten megabytes of RAM to discover it was a `.zip`. The authoritative check —
 * MIME *and* the `%PDF-` signature — still lives in `documents.service.ts`, so
 * it holds for every caller and not just this route. Both paths raise the same
 * `DOCUMENT_UNSUPPORTED_TYPE`, so the client sees one answer either way.
 *
 * **Upload is not rate limited by the AI budget; extraction is.** Chunking is
 * deterministic PostgreSQL work and succeeds with no API key configured, while
 * extraction calls a model. `POST /:id/extract` therefore carries `aiRateLimit`
 * and `POST /` does not.
 */
import {
  documentExtractRequestSchema,
  documentListQuerySchema,
  documentUploadRequestSchema,
  signalDecisionRequestSchema,
  type DocumentExtractRequest,
  type DocumentUploadRequest,
  type SignalDecisionRequest,
} from '@eclens/shared';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { currentActor } from '../lib/audit';
import { aiRateLimit } from '../middleware/aiRateLimit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery, validate } from '../middleware/validate';
import { documentUnsupportedType } from '../services/ai/aiErrors';
import { PDF_MIME_TYPE } from '../services/ai/parsing';
import {
  decideSignal,
  deleteDocument,
  extractDocument,
  getDocument,
  listDocuments,
  uploadDocument,
} from '../services/documents.service';
import { HttpError } from '../utils/httpError';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DOCUMENT_AI_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== PDF_MIME_TYPE) {
      callback(documentUnsupportedType(`'${file.originalname}' was sent as ${file.mimetype}. Only PDF documents are accepted here; spreadsheet data belongs in the portfolio import.`));
      return;
    }
    callback(null, true);
  },
});

/** Multer reports its own error type; this puts it on the standard JSON envelope. */
const uploadSingleDocument = (req: Request, res: Response, next: NextFunction): void => {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(
        new HttpError(
          413,
          'UPLOAD_TOO_LARGE',
          `Document exceeds the ${Math.round(env.DOCUMENT_AI_MAX_BYTES / (1024 * 1024))} MB limit for AI documents`,
        ),
      );
      return;
    }
    next(error instanceof multer.MulterError ? new HttpError(400, 'UPLOAD_REJECTED', error.message) : error);
  });
};

export const documentsRouter = Router();

documentsRouter.use(requireAuth);

documentsRouter.post(
  '/',
  requirePermission('document:write'),
  uploadSingleDocument,
  validate(documentUploadRequestSchema),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new HttpError(
          400,
          'MISSING_FILE',
          "Send the PDF in the 'file' field of a multipart/form-data request",
        );
      }
      // 201 whether or not the bytes were new: `duplicateOf` in the body is what
      // distinguishes them, and a duplicate is still a document the caller can
      // now cite.
      res.status(201).json(
        await uploadDocument(currentActor(req), req.file, req.body as DocumentUploadRequest),
      );
    } catch (error) {
      next(error);
    }
  },
);

documentsRouter.get('/', requirePermission('document:read'), async (req, res, next) => {
  try {
    const query = parseQuery(documentListQuerySchema, req.query);
    res.json(await listDocuments(currentActor(req), query));
  } catch (error) {
    next(error);
  }
});

documentsRouter.get('/:id', requirePermission('document:read'), async (req, res, next) => {
  try {
    res.json(await getDocument(currentActor(req), req.params.id));
  } catch (error) {
    next(error);
  }
});

documentsRouter.delete('/:id', requirePermission('document:delete'), async (req, res, next) => {
  try {
    await deleteDocument(currentActor(req), req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

documentsRouter.post(
  '/:id/extract',
  requirePermission('document:write'),
  aiRateLimit,
  validate(documentExtractRequestSchema),
  async (req, res, next) => {
    try {
      res.json(
        await extractDocument(currentActor(req), req.params.id, req.body as DocumentExtractRequest, {
          requestId: req.requestId,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

documentsRouter.post(
  '/:id/signals/:signalId/decision',
  requirePermission('document:write'),
  validate(signalDecisionRequestSchema),
  async (req, res, next) => {
    try {
      res.json(
        await decideSignal(
          currentActor(req),
          req.params.id,
          req.params.signalId,
          req.body as SignalDecisionRequest,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);
