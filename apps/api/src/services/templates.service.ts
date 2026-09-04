/**
 * Downloadable portfolio templates.
 *
 * Two artifacts, both produced from the same canonical row shape so what you
 * download is byte-for-byte what the importer expects to read back:
 *
 *   - `blank`  the template header plus three hand-written example rows, one per
 *              stage (Stage 1 consumer auto loan, Stage 2 SME working capital
 *              with an undrawn commitment and CCF, Stage 3 agri crop loan in
 *              default). Small enough to inspect, valid enough to commit as-is.
 *   - `sample` the deterministic synthetic portfolio — 780 fictional PKR
 *              exposures seeded from a fixed PRNG, covering consumer, SME,
 *              agriculture, microfinance and corporate segments and all three
 *              stages. The same seed always yields the same file, so a demo
 *              number quoted today still reproduces next month.
 *
 * Every money and rate cell is written as *text*, never as a spreadsheet number.
 * Excel would store `0.011500` as a binary double and hand back `0.01149999...`,
 * which defeats the whole point of the decimal engine downstream.
 */
import ExcelJS from 'exceljs';
import {
  DEFAULT_GENERATOR_OPTIONS,
  PORTFOLIO_FIELDS,
  TEMPLATE_FIELD_GUIDE,
  TEMPLATE_HEADERS,
  buildTemplateExampleRows,
  generatePortfolioRows,
  rowsToCsv,
  type PortfolioField,
  type TemplateDownloadRecord,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../utils/httpError';

export type TemplateKind = 'blank' | 'sample';
export type TemplateFormat = 'csv' | 'xlsx';

export interface TemplateRequest {
  kind: TemplateKind;
  format: TemplateFormat;
  /** ISO `YYYY-MM-DD`. Defaults to the generator's fixed reporting date. */
  reportingDate?: string;
  /** Only meaningful for `sample`. Clamped to a sane range. */
  count?: number;
}

const TEMPLATE_KINDS: TemplateKind[] = ['blank', 'sample'];
const TEMPLATE_FORMATS: TemplateFormat[] = ['csv', 'xlsx'];

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Upper bound so a stray `count=999999` cannot turn a download into an outage. */
const MAX_SAMPLE_ROWS = 5000;
const MIN_SAMPLE_ROWS = 50;

const fieldGuide = TEMPLATE_FIELD_GUIDE.map((entry) => ({
  key: entry.field,
  label: entry.header,
  kind: entry.kind,
  required: entry.required,
  description: entry.description,
}));

function buildRows(request: TemplateRequest): Record<PortfolioField, string>[] {
  const reportingDate = request.reportingDate ?? DEFAULT_GENERATOR_OPTIONS.reportingDate;
  if (request.kind === 'blank') return buildTemplateExampleRows(reportingDate);

  const count = Math.min(
    MAX_SAMPLE_ROWS,
    Math.max(MIN_SAMPLE_ROWS, request.count ?? DEFAULT_GENERATOR_OPTIONS.count),
  );
  return generatePortfolioRows({ count, reportingDate }).map((row) => row.values);
}

/** One worksheet of text cells, plus a second sheet carrying the column guide. */
async function toXlsxBuffer(rows: Record<PortfolioField, string>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ECLens AI';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Portfolio');
  sheet.columns = PORTFOLIO_FIELDS.map((field, index) => ({
    header: TEMPLATE_HEADERS[index],
    key: field,
    width: Math.max(14, TEMPLATE_HEADERS[index].length + 4),
  }));
  sheet.getRow(1).font = { bold: true };
  // Text format on every column keeps Excel from reinterpreting decimals and dates.
  sheet.columns.forEach((column) => {
    column.style = { numFmt: '@' };
  });
  for (const row of rows) {
    sheet.addRow(PORTFOLIO_FIELDS.map((field) => row[field] ?? ''));
  }

  const guide = workbook.addWorksheet('Field Guide');
  guide.columns = [
    { header: 'Field', key: 'key', width: 28 },
    { header: 'Column Header', key: 'label', width: 34 },
    { header: 'Type', key: 'kind', width: 14 },
    { header: 'Required', key: 'required', width: 12 },
    { header: 'Description', key: 'description', width: 90 },
  ];
  guide.getRow(1).font = { bold: true };
  for (const entry of fieldGuide) {
    guide.addRow({ ...entry, required: entry.required ? 'yes' : 'no' });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Builds the requested file and records the download. The audit entry names the
 * kind, format and row count, so a report figure can be traced back to the
 * exact sample file it was produced from.
 */
export async function buildTemplateDownload(
  actor: AuditActor,
  request: TemplateRequest,
): Promise<TemplateDownloadRecord> {
  if (!TEMPLATE_KINDS.includes(request.kind)) {
    throw new HttpError(400, 'UNKNOWN_TEMPLATE_KIND', `Unknown template kind '${request.kind}'.`);
  }
  if (!TEMPLATE_FORMATS.includes(request.format)) {
    throw new HttpError(400, 'UNKNOWN_TEMPLATE_FORMAT', `Unknown template format '${request.format}'.`);
  }

  const rows = buildRows(request);
  const reportingDate = request.reportingDate ?? DEFAULT_GENERATOR_OPTIONS.reportingDate;
  const stem = request.kind === 'blank' ? 'eclens-portfolio-template' : 'eclens-sample-portfolio';
  const extension = request.format === 'csv' ? 'csv' : 'xlsx';

  const buffer =
    request.format === 'csv'
      ? Buffer.from(rowsToCsv(rows), 'utf8')
      : await toXlsxBuffer(rows);

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'TEMPLATE.DOWNLOADED',
    entityType: 'Template',
    entityId: `${request.kind}:${request.format}`,
    detail: `Downloaded ${request.kind} portfolio template as ${request.format.toUpperCase()} (${rows.length} rows, reporting date ${reportingDate}).`,
  });

  return {
    fileName: `${stem}-${reportingDate}.${extension}`,
    contentType: request.format === 'csv' ? CSV_CONTENT_TYPE : XLSX_CONTENT_TYPE,
    contentBase64: buffer.toString('base64'),
    rowCount: rows.length,
    fieldGuide,
  };
}
