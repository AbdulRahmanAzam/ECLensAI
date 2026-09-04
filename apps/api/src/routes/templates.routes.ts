/**
 * Downloadable portfolio templates.
 *
 * Two response shapes from one endpoint, because the two consumers want
 * different things:
 *
 *   default        the `TemplateDownloadRecord` as JSON — the base64 payload plus
 *                  the field guide, so the web client can render the column
 *                  documentation next to the download button and trigger the
 *                  save without a second round trip.
 *   `?as=file`     the raw bytes with Content-Disposition, which is what a plain
 *                  browser link or a curl one-liner needs.
 *
 * The generator is deterministic, so `kind=sample` at a given reporting date is
 * byte-identical every time and a demo figure quoted from it still reproduces.
 * Every download is audited by the service.
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { parseQuery } from '../middleware/validate';
import { buildTemplateDownload } from '../services/templates.service';

const templateQuerySchema = z.object({
  kind: z.enum(['blank', 'sample']).default('blank'),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  reportingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'reportingDate must be an ISO date (YYYY-MM-DD)').optional(),
  count: z.coerce.number().int().min(50).max(5000).optional(),
  as: z.enum(['json', 'file']).default('json'),
});

export const templatesRouter = Router();

templatesRouter.get('/portfolio', requireAuth, requirePermission('portfolio:read'), async (req, res, next) => {
  try {
    const query = parseQuery(templateQuerySchema, req.query);
    const template = await buildTemplateDownload(currentActor(req), query);

    if (query.as === 'file') {
      res.setHeader('Content-Type', template.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${template.fileName}"`);
      res.send(Buffer.from(template.contentBase64, 'base64'));
      return;
    }
    res.json({ template });
  } catch (error) {
    next(error);
  }
});
