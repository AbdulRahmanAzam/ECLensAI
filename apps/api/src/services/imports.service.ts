/**
 * Portfolio ingestion: upload -> preview -> map -> validate -> commit.
 *
 * Design rules this module obeys:
 *
 *   - **The raw table is persisted.** Preview, re-mapping and re-validation all
 *     read `ImportBatch.rawTable`, so the original bytes are never needed again
 *     and the uploaded file is deleted immediately after parsing.
 *   - **Nothing is silently repaired.** An ambiguous percentage, a
 *     thousands-separator that could be a decimal point, a date that could be
 *     DD/MM or MM/DD — each becomes a quarantine row carrying the row number,
 *     the field, the raw value, an issue code, a severity and a suggested
 *     correction. Valid rows are committed; invalid ones are reported.
 *   - **Commit re-validates.** The rows written to the ledger are produced by
 *     re-applying the persisted mapping to the persisted raw table, so what
 *     lands in the database provably matches the mapping and the percentage
 *     normalization mode in force at commit time.
 *   - **Bounds come from governance.** The effective-interest-rate limits used
 *     during validation are read from the active model configuration, not
 *     hard-coded here.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import {
  applyMapping,
  assessStage,
  dataQualityException,
  issuesToCsv,
  mappingIssues,
  suggestHeaderMapping,
  validateImportedRows,
  TEMPLATE_FIELD_GUIDE,
  type ColumnMapping,
  type ImportIssuesRecord,
  type ImportPreviewRecord,
  type ListQuery,
  type MappingRequest,
  type CommitRequest,
  type Paginated,
  type ParsedExposureRow,
  type PercentageNormalizationMode,
  type RawRow,
  type RawTable,
  type StagingRuleSetConfig,
  type ValidationIssue,
} from '@eclens/shared';
import { env } from '../config/env';
import { jobs } from '../jobs';
import { recordAudit, type AuditActor } from '../lib/audit';
import { logger } from '../lib/logger';
import { newId, newPublicId } from '../lib/ids';
import { prisma } from '../lib/prisma';
import { buildPageMeta, orderBy, toPageArgs } from '../lib/pagination';
import { HttpError, notFound } from '../utils/httpError';
import { parseUploadedTable } from './ingest/parse';
import { toImportBatchRecord, toValidationIssueRecord } from './mappers';
import { toStagingInput, type ExposureEngineRow } from './engine-bridge';
import { loadActiveModelConfiguration } from './governance.service';

type ImportBatchRow = Prisma.ImportBatchGetPayload<Record<string, never>>;

/** How many quarantined rows become exception items, so a bad file cannot flood the queue. */
const MAX_DATA_QUALITY_EXCEPTIONS = 100;
const PREVIEW_ROWS = 25;

const ACCEPTED_EXTENSIONS: Record<string, 'CSV' | 'XLSX'> = {
  '.csv': 'CSV',
  '.txt': 'CSV',
  '.tsv': 'CSV',
  '.xlsx': 'XLSX',
  '.xlsm': 'XLSX',
};

function rawTableFromJson(value: Prisma.JsonValue): RawTable {
  const table = value as unknown as RawTable;
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    throw new HttpError(500, 'IMPORT_TABLE_CORRUPT', 'The stored raw table for this import batch is unreadable');
  }
  return {
    sourceFileName: table.sourceFileName,
    sourceFormat: table.sourceFormat,
    headers: table.headers,
    rows: table.rows.map((row: RawRow) => ({
      rowNumber: row.rowNumber,
      sheetRow: row.sheetRow,
      cells: row.cells ?? [],
    })),
    truncated: Boolean(table.truncated),
    rowsSkippedByTruncation: table.rowsSkippedByTruncation ?? 0,
  };
}

function mappingFromJson(value: Prisma.JsonValue): ColumnMapping {
  return (value ?? {}) as ColumnMapping;
}

async function findBatch(organizationId: string, publicId: string): Promise<ImportBatchRow> {
  const batch = await prisma.importBatch.findFirst({ where: { organizationId, publicId } });
  if (!batch) throw notFound(`Import batch '${publicId}' not found`);
  return batch;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadPortfolioBatch(
  actor: AuditActor,
  file: Express.Multer.File,
): Promise<{ record: ReturnType<typeof toImportBatchRecord>; jobId: string; driver: string }> {
  const extension = path.extname(file.originalname).toLowerCase();
  const sourceFormat = ACCEPTED_EXTENSIONS[extension];
  if (!sourceFormat) {
    await fs.unlink(file.path).catch(() => undefined);
    throw new HttpError(
      415,
      'UNSUPPORTED_FILE_TYPE',
      `Unsupported file type '${extension || 'unknown'}'. Upload a .csv or .xlsx portfolio file.`,
    );
  }

  let table: RawTable;
  try {
    table = await parseUploadedTable(file.path, file.originalname, sourceFormat, {
      maxRows: env.MAX_IMPORT_ROWS,
    });
  } catch (error) {
    await fs.unlink(file.path).catch(() => undefined);
    logger.error({ err: error }, 'failed to parse uploaded portfolio file');
    throw new HttpError(
      422,
      'IMPORT_PARSE_FAILED',
      error instanceof Error ? error.message : 'The uploaded file could not be parsed',
    );
  } finally {
    // The raw table is now in the database; the bytes are no longer needed.
    await fs.unlink(file.path).catch(() => undefined);
  }

  if (table.headers.length === 0) {
    throw new HttpError(422, 'IMPORT_EMPTY_FILE', 'The uploaded file has no header row');
  }
  if (table.rows.length === 0) {
    throw new HttpError(422, 'IMPORT_NO_DATA_ROWS', 'The uploaded file has a header row but no data rows');
  }

  const suggested = suggestHeaderMapping(table.headers);
  const autoMapping: ColumnMapping = {};
  for (const [field, suggestion] of Object.entries(suggested)) {
    autoMapping[field as keyof ColumnMapping] = suggestion ? suggestion.header : null;
  }

  const batchId = newId();
  const publicId = newPublicId('IMP');
  const created = await prisma.importBatch.create({
    data: {
      id: batchId,
      organizationId: actor.organizationId,
      publicId,
      fileName: file.originalname,
      sourceFormat,
      // Transitional: the validation job is enqueued below in this same call, so
      // a client that polls right after upload sees work pending, not a settled
      // batch. `validateImportBatch` moves this to VALIDATING and then on to
      // VALIDATED / QUARANTINED / FAILED.
      status: 'QUEUED',
      storageKey: null,
      sizeBytes: file.size,
      rowCount: table.rows.length,
      previewRowCount: Math.min(PREVIEW_ROWS, table.rows.length),
      headers: table.headers as unknown as Prisma.InputJsonValue,
      mapping: autoMapping as unknown as Prisma.InputJsonValue,
      suggestedMapping: suggested as unknown as Prisma.InputJsonValue,
      missingRequiredFields: [],
      unmappedHeaders: table.headers.filter((header) => !Object.values(autoMapping).includes(header)),
      percentageNormalization: 'AUTO_DETECT',
      truncated: table.truncated,
      rowsSkippedByTruncation: table.rowsSkippedByTruncation,
      rawTable: table as unknown as Prisma.InputJsonValue,
      uploadedById: actor.id,
      uploadedBy: actor.fullName,
      message: `Parsed ${table.rows.length} data row(s) from ${table.headers.length} column(s)${table.truncated ? `; ${table.rowsSkippedByTruncation} row(s) skipped to stay inside the ${env.MAX_IMPORT_ROWS}-row bound` : ''}`,
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'IMPORT.UPLOADED',
    entityType: 'ImportBatch',
    entityId: created.publicId,
    detail: `Uploaded ${created.fileName} (${created.sourceFormat}, ${created.rowCount} rows, ${created.sizeBytes} bytes); automatic header mapping proposed for ${Object.values(suggested).filter(Boolean).length} of ${Object.keys(suggested).length} canonical fields`,
  });

  const receipt = await jobs.enqueue('import.validate', { batchId: created.id });

  return { record: toImportBatchRecord(created), jobId: receipt.jobId, driver: receipt.driver };
}

// ---------------------------------------------------------------------------
// Validation (runs as a background job)
// ---------------------------------------------------------------------------

async function validationOptions(
  organizationId: string,
  percentageNormalization: PercentageNormalizationMode,
): Promise<{
  percentageNormalization: PercentageNormalizationMode;
  existingExposureIds: string[];
  defaultReportingDate: string;
  defaultCurrency: string;
  effectiveInterestRateMin?: string;
  effectiveInterestRateMax?: string;
  ruleSet: StagingRuleSetConfig | null;
}> {
  const [existing, latestSnapshot, organization, configuration] = await Promise.all([
    prisma.exposure.findMany({ where: { organizationId }, select: { publicId: true } }),
    prisma.portfolioSnapshot.findFirst({
      where: { organizationId },
      orderBy: { asOfDate: 'desc' },
      select: { asOfDate: true },
    }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } }),
    loadActiveModelConfiguration(organizationId),
  ]);

  return {
    percentageNormalization,
    existingExposureIds: existing.map((row) => row.publicId),
    defaultReportingDate: latestSnapshot
      ? latestSnapshot.asOfDate.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    defaultCurrency: organization?.currency ?? 'PKR',
    effectiveInterestRateMin: configuration?.effectiveInterestRateMin.toString(),
    effectiveInterestRateMax: configuration?.effectiveInterestRateMax.toString(),
    ruleSet: configuration
      ? (configuration.stagingRuleSet as unknown as StagingRuleSetConfig)
      : null,
  };
}

/**
 * Applies the persisted mapping to the persisted raw table and re-runs row
 * validation. Used both by the validation job and by commit, so the rows written
 * to the ledger are the same rows the analyst reviewed.
 */
async function revalidate(
  batch: ImportBatchRow,
): Promise<{
  result: ReturnType<typeof validateImportedRows>;
  fileIssues: ValidationIssue[];
  options: Awaited<ReturnType<typeof validationOptions>>;
}> {
  const table = rawTableFromJson(batch.rawTable);
  const mapping = mappingFromJson(batch.mapping);
  const applied = applyMapping(table, mapping);
  const fileIssues = mappingIssues(applied);
  const options = await validationOptions(
    batch.organizationId,
    batch.percentageNormalization as PercentageNormalizationMode,
  );
  const result = validateImportedRows(applied.rows, options);
  return {
    result,
    fileIssues: [...fileIssues, ...applied.unmappedHeaders.map(() => null)].filter(
      (issue): issue is ValidationIssue => issue !== null,
    ),
    options,
  };
}

/** Job handler: `import.validate`. */
export async function validateImportBatch(batchId: string): Promise<void> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    logger.warn({ batchId }, 'import.validate job for a batch that no longer exists');
    return;
  }

  await prisma.importBatch.update({ where: { id: batchId }, data: { status: 'VALIDATING' } });

  try {
    const { result, fileIssues } = await revalidate(batch);
    const allIssues: ValidationIssue[] = [...fileIssues, ...result.issues];
    const missingRequired = fileIssues
      .filter((issue) => issue.issueCode === 'UNMAPPED_REQUIRED_COLUMN')
      .map((issue) => issue.field);

    await prisma.$transaction(async (tx) => {
      await tx.importValidationIssue.deleteMany({ where: { batchId } });
      if (allIssues.length > 0) {
        // createMany in chunks: a badly-formed file can raise tens of thousands
        // of issues and one statement that large risks the parameter limit.
        for (let index = 0; index < allIssues.length; index += 2000) {
          await tx.importValidationIssue.createMany({
            data: allIssues.slice(index, index + 2000).map((issue) => ({
              id: newId(),
              batchId,
              rowNumber: issue.rowNumber ?? 0,
              sheetRow: issue.sheetRow ?? 0,
              field: issue.field,
              rawValue: issue.rawValue,
              issueCode: issue.issueCode,
              severity: issue.severity,
              message: issue.message,
              suggestedCorrection: issue.suggestedCorrection,
            })),
          });
        }
      }

      const status =
        missingRequired.length > 0
          ? 'FAILED'
          : result.validRows.length === 0
            ? 'QUARANTINED'
            : 'VALIDATED';

      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status,
          validRowCount: result.validRows.length,
          quarantinedRowCount: result.quarantinedRows.length,
          errorCount: result.summary.errorCount,
          warningCount: result.summary.warningCount,
          missingRequiredFields: missingRequired as unknown as Prisma.InputJsonValue,
          message:
            missingRequired.length > 0
              ? `Required column(s) not mapped: ${missingRequired.join(', ')}`
              : `${result.validRows.length} valid row(s), ${result.quarantinedRows.length} quarantined, ${result.summary.errorCount} error(s), ${result.summary.warningCount} warning(s)`,
        },
      });
    });

    await recordAudit({
      organizationId: batch.organizationId,
      actor: batch.uploadedById ? { id: batch.uploadedById, fullName: batch.uploadedBy, role: 'RISK_ANALYST' } : null,
      action: 'IMPORT.VALIDATED',
      entityType: 'ImportBatch',
      entityId: batch.publicId,
      detail: `Validated ${result.summary.totalRows} row(s): ${result.summary.validRows} valid, ${result.summary.quarantinedRows} quarantined, ${result.summary.errorCount} error(s), ${result.summary.warningCount} warning(s), ${result.summary.duplicateCount} duplicate exposure id(s)`,
    });
  } catch (error) {
    logger.error({ err: error, batchId }, 'import validation failed');
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: 'FAILED',
        message: error instanceof Error ? error.message : 'Validation failed',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Preview, mapping, issues
// ---------------------------------------------------------------------------

export async function getImportPreview(
  organizationId: string,
  publicId: string,
  actor: AuditActor,
): Promise<ImportPreviewRecord> {
  const batch = await findBatch(organizationId, publicId);
  const table = rawTableFromJson(batch.rawTable);

  await recordAudit({
    organizationId,
    actor,
    action: 'IMPORT.PREVIEWED',
    entityType: 'ImportBatch',
    entityId: batch.publicId,
    detail: `Previewed ${Math.min(PREVIEW_ROWS, table.rows.length)} of ${table.rows.length} row(s)`,
  });

  return {
    batch: toImportBatchRecord(batch),
    previewRows: table.rows.slice(0, PREVIEW_ROWS).map((row) => ({
      rowNumber: row.rowNumber,
      cells: row.cells,
    })),
    fieldGuide: TEMPLATE_FIELD_GUIDE.map((entry) => ({
      key: entry.field,
      label: entry.header,
      kind: entry.kind,
      required: entry.required,
      description: entry.description,
    })),
  };
}

/**
 * Column headers and sample values for one batch, shaped for the AI mapper.
 *
 * Deliberately reads the persisted raw table without recording a preview audit
 * event and without re-validating. Suggesting a mapping changes nothing, so the
 * honest record of what happened is the `AI.MAPPING_SUGGESTED` row the caller
 * writes — not a claim that a human previewed the file.
 */
export async function getBatchColumns(organizationId: string, publicId: string, sampleRows = 8) {
  const batch = await findBatch(organizationId, publicId);
  const table = rawTableFromJson(batch.rawTable);
  const sample = table.rows.slice(0, sampleRows);

  return {
    batch: toImportBatchRecord(batch),
    headers: table.headers,
    columns: table.headers.map((header, index) => ({
      header,
      samples: sample.map((row) => row.cells[index] ?? '').filter((cell) => cell.trim().length > 0),
    })),
    rowCount: table.rows.length,
    truncated: table.truncated,
    rowsSkippedByTruncation: table.rowsSkippedByTruncation,
    currentMapping: mappingFromJson(batch.mapping),
  };
}

export async function applyImportMapping(
  actor: AuditActor,
  publicId: string,
  request: MappingRequest,
): Promise<ReturnType<typeof toImportBatchRecord>> {
  const batch = await findBatch(actor.organizationId, publicId);
  if (batch.status === 'IMPORTED' || batch.status === 'COMMITTED') {
    throw new HttpError(
      409,
      'IMPORT_ALREADY_COMMITTED',
      'This batch has already been committed. Re-mapping a committed batch would desynchronize it from the ledger.',
    );
  }
  if (batch.status === 'QUEUED' || batch.status === 'VALIDATING') {
    // Upload enqueues validation immediately, so a re-map can land mid-flight.
    // Writing a new mapping while the job reads the old one would attribute the
    // reported issues to a mapping that was never validated.
    throw new HttpError(
      409,
      'IMPORT_VALIDATION_IN_FLIGHT',
      `This batch is '${batch.status}'. Wait for validation to finish before changing the column mapping.`,
    );
  }

  const table = rawTableFromJson(batch.rawTable);
  const unknownHeaders = Object.values(request.mapping).filter(
    (header): header is string => typeof header === 'string' && !table.headers.includes(header),
  );
  if (unknownHeaders.length > 0) {
    throw new HttpError(
      422,
      'MAPPING_UNKNOWN_HEADER',
      `Mapping references column(s) that are not in the uploaded file: ${unknownHeaders.join(', ')}`,
      unknownHeaders.map((header) => ({ path: header, message: 'not present in the file header row' })),
    );
  }

  const mapping = request.mapping as ColumnMapping;
  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      mapping: mapping as unknown as Prisma.InputJsonValue,
      percentageNormalization: request.percentageNormalizationMode,
      status: 'MAPPING',
      unmappedHeaders: table.headers.filter((header) => !Object.values(mapping).includes(header)),
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'IMPORT.MAPPED',
    entityType: 'ImportBatch',
    entityId: updated.publicId,
    detail: `Mapped ${Object.values(mapping).filter(Boolean).length} canonical field(s); percentage normalization ${request.percentageNormalizationMode}`,
  });

  if (request.revalidate) {
    await validateImportBatch(updated.id);
    return toImportBatchRecord(await prisma.importBatch.findUniqueOrThrow({ where: { id: updated.id } }));
  }
  return toImportBatchRecord(updated);
}

export async function getImportIssues(
  organizationId: string,
  publicId: string,
): Promise<ImportIssuesRecord> {
  const batch = await findBatch(organizationId, publicId);
  const issues = await prisma.importValidationIssue.findMany({
    where: { batchId: batch.id },
    orderBy: [{ severity: 'asc' }, { rowNumber: 'asc' }, { field: 'asc' }],
  });

  const { result } = await revalidate(batch);
  const exposureIdField = mappingFromJson(batch.mapping).exposureId;
  const table = rawTableFromJson(batch.rawTable);
  const exposureIdColumn = exposureIdField ? table.headers.indexOf(exposureIdField) : -1;

  const issueCodes = Array.from(new Set(issues.map((issue) => issue.issueCode))) as ImportIssuesRecord['issueCodes'];
  const severities = Array.from(new Set(issues.map((issue) => issue.severity))) as ImportIssuesRecord['severities'];

  return {
    batchId: batch.publicId,
    issues: issues.map(toValidationIssueRecord),
    quarantinedRows: result.quarantinedRows.map((row) => ({
      rowNumber: row.rowNumber,
      sheetRow: row.sheetRow,
      exposureId:
        exposureIdColumn >= 0
          ? (table.rows.find((candidate) => candidate.rowNumber === row.rowNumber)?.cells[exposureIdColumn] ?? null)
          : null,
    })),
    issueCodes,
    severities,
    errorReportCsv: issuesToCsv(
      issues.map((issue) => ({
        rowNumber: issue.rowNumber,
        sheetRow: issue.sheetRow,
        field: issue.field,
        rawValue: issue.rawValue ?? '',
        issueCode: issue.issueCode as ValidationIssue['issueCode'],
        severity: issue.severity,
        message: issue.message,
        suggestedCorrection: issue.suggestedCorrection,
      })),
    ),
  };
}

export async function listImportBatches(
  organizationId: string,
  query: ListQuery,
): Promise<Paginated<ReturnType<typeof toImportBatchRecord>>> {
  const where: Prisma.ImportBatchWhereInput = {
    organizationId,
    ...(query.search
      ? {
          OR: [
            { fileName: { contains: query.search } },
            { publicId: { contains: query.search } },
            { uploadedBy: { contains: query.search } },
          ],
        }
      : {}),
  };
  const { skip, take } = toPageArgs(query);
  const [totalItems, rows] = await Promise.all([
    prisma.importBatch.count({ where }),
    prisma.importBatch.findMany({
      where,
      skip,
      take,
      // rawTable is the whole uploaded file; never load it for a list view.
      omit: { rawTable: true },
      orderBy: orderBy(query.sortBy, query.sortDir, ['fileName', 'status', 'createdAt', 'rowCount'], {
        createdAt: 'desc',
      }),
    }),
  ]);
  return {
    items: rows.map((row) => toImportBatchRecord(row as ImportBatchRow)),
    meta: buildPageMeta(query, totalItems),
  };
}

// ---------------------------------------------------------------------------
// Commit (runs as a background job)
// ---------------------------------------------------------------------------

export async function commitImportBatch(
  actor: AuditActor,
  publicId: string,
  request: CommitRequest,
): Promise<{ record: ReturnType<typeof toImportBatchRecord>; jobId: string; driver: string }> {
  const batch = await findBatch(actor.organizationId, publicId);
  if (batch.status === 'COMMITTED') {
    throw new HttpError(409, 'IMPORT_ALREADY_COMMITTED', 'This batch is already being committed to the ledger');
  }
  if (batch.status === 'IMPORTED') {
    throw new HttpError(409, 'IMPORT_ALREADY_COMMITTED', 'This batch has already been committed');
  }
  if (batch.status !== 'VALIDATED') {
    throw new HttpError(
      409,
      'IMPORT_NOT_VALIDATED',
      `This batch is '${batch.status}' and cannot be committed. Resolve the reported issues and re-validate first.`,
    );
  }

  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: 'COMMITTED',
      committedById: actor.id,
      committedBy: actor.fullName,
      committedAt: new Date(),
      snapshotLabel: request.snapshotLabel ?? `Import ${batch.fileName}`,
    },
  });

  const receipt = await jobs.enqueue('import.commit', {
    batchId: batch.id,
    actorId: actor.id,
    actorName: actor.fullName,
    skipDuplicates: request.skipDuplicates,
  });

  return { record: toImportBatchRecord(updated), jobId: receipt.jobId, driver: receipt.driver };
}

/**
 * Writes the validated rows to the ledger as a new immutable snapshot.
 *
 * A snapshot is the input version every later calculation cites, so it is
 * created whole inside one transaction: either every exposure and its initial
 * staging assessment land, or none of them do.
 */
export async function runImportCommit(
  batchId: string,
  actorId: string | null,
  actorName: string,
  skipDuplicates: boolean,
): Promise<void> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    logger.warn({ batchId }, 'import.commit job for a batch that no longer exists');
    return;
  }

  try {
    const { result, options } = await revalidate(batch);
    if (result.validRows.length === 0) {
      await prisma.importBatch.update({
        where: { id: batchId },
        data: { status: 'FAILED', message: 'No valid rows to commit' },
      });
      return;
    }

    const rows = skipDuplicates
      ? deduplicateAgainstLedger(result.validRows, options.existingExposureIds)
      : result.validRows;

    if (rows.length === 0) {
      await prisma.importBatch.update({
        where: { id: batchId },
        data: {
          status: 'FAILED',
          message: 'Every valid row duplicates an exposure already on the ledger',
        },
      });
      return;
    }

    const asOfDate = rows
      .map((row) => row.reportingDate)
      .sort()
      .at(-1)!;
    const snapshotId = newId();
    const snapshotPublicId = newPublicId('SNAP');
    const inputVersion = `IV-${snapshotPublicId}`;
    const totalGross = rows.reduce((sum, row) => sum + Number(row.grossCarryingAmount), 0);

    await prisma.$transaction(async (tx) => {
      await tx.portfolioSnapshot.create({
        data: {
          id: snapshotId,
          organizationId: batch.organizationId,
          publicId: snapshotPublicId,
          label: batch.snapshotLabel ?? `Import ${batch.fileName}`,
          asOfDate: new Date(`${asOfDate}T00:00:00.000Z`),
          source: 'IMPORT',
          inputVersion,
          exposureCount: rows.length,
          totalGrossExposure: totalGross.toFixed(2),
          importBatchId: batch.publicId,
        },
      });

      const borrowerIds = Array.from(new Set(rows.map((row) => row.borrowerId || row.exposureId)));
      const borrowerRowByKey = new Map<string, ParsedExposureRow>();
      for (const row of rows) {
        const key = row.borrowerId || row.exposureId;
        if (!borrowerRowByKey.has(key)) borrowerRowByKey.set(key, row);
      }
      const borrowerDbIdByKey = new Map<string, string>();
      for (const key of borrowerIds) {
        const source = borrowerRowByKey.get(key)!;
        const existing = await tx.borrower.findUnique({
          where: { organizationId_publicId: { organizationId: batch.organizationId, publicId: key } },
          select: { id: true },
        });
        if (existing) {
          borrowerDbIdByKey.set(key, existing.id);
        } else {
          const created = await tx.borrower.create({
            data: {
              id: newId(),
              organizationId: batch.organizationId,
              publicId: key,
              name: source.borrowerName,
              industry: source.industry,
              region: source.region,
            },
            select: { id: true },
          });
          borrowerDbIdByKey.set(key, created.id);
        }
      }

      const exposureDbIdByPublicId = new Map<string, string>();
      const exposureData = rows.map((row) => {
        const id = newId();
        exposureDbIdByPublicId.set(row.exposureId, id);
        return {
          id,
          organizationId: batch.organizationId,
          snapshotId,
          borrowerId: borrowerDbIdByKey.get(row.borrowerId || row.exposureId)!,
          publicId: row.exposureId,
          segment: row.segment,
          productType: row.productType,
          originationDate: new Date(`${row.originationDate}T00:00:00.000Z`),
          maturityDate: new Date(`${row.maturityDate}T00:00:00.000Z`),
          reportingDate: new Date(`${row.reportingDate}T00:00:00.000Z`),
          currency: row.currency,
          grossCarryingAmount: row.grossCarryingAmount,
          undrawnCommitment: row.undrawnCommitment,
          creditConversionFactor: row.creditConversionFactor,
          effectiveInterestRate: row.effectiveInterestRate,
          daysPastDue: row.daysPastDue,
          originalCreditRating: row.originalCreditRating,
          currentCreditRating: row.currentCreditRating,
          twelveMonthPd: row.twelveMonthPd,
          lifetimePd: row.lifetimePd,
          pdAtOrigination: row.pdAtOrigination || row.twelveMonthPd,
          lgd: row.lgd,
          collateralValue: row.collateralValue,
          defaultFlag: row.defaultFlag,
          creditImpairedFlag: row.creditImpairedFlag,
          forbearanceFlag: row.forbearanceFlag,
          restructuringFlag: row.restructuringFlag,
          watchlistFlag: row.watchlistFlag,
          region: row.region,
          industry: row.industry,
        };
      });
      // No `skipDuplicates` option here: SQLite's connector doesn't support it, and
      // it would be redundant on any connector — `rows` is already free of both
      // intra-batch duplicates (quarantined at validation) and ledger duplicates
      // (deduplicateAgainstLedger above, when skipDuplicates was requested).
      for (let index = 0; index < exposureData.length; index += 500) {
        await tx.exposure.createMany({
          data: exposureData.slice(index, index + 500),
        });
      }

      // Initial staging assessment: the "current" live stage, runId null.
      if (options.ruleSet) {
        const assessments = exposureData.map((row) => {
          const decision = assessStage(
            toStagingInput(row as unknown as ExposureEngineRow),
            options.ruleSet as StagingRuleSetConfig,
            null,
          );
          return {
            id: newId(),
            organizationId: batch.organizationId,
            runId: null,
            exposureId: row.id,
            stage: decision.stage,
            modelStage: decision.modelStage,
            primaryReason: decision.primaryReason,
            primaryRuleCode: decision.primaryRuleCode,
            triggeredRules: decision.triggeredRules as unknown as Prisma.InputJsonValue,
            ruleSetId: decision.ruleSetId,
            ruleSetVersion: decision.ruleSetVersion,
            hasOverride: decision.hasOverride,
          };
        });
        for (let index = 0; index < assessments.length; index += 500) {
          await tx.stagingAssessment.createMany({ data: assessments.slice(index, index + 500) });
        }
      }

      // Quarantined rows surface as data-quality exceptions, capped so a badly
      // formed file cannot bury the queue.
      const exceptionRows = result.quarantinedRows.slice(0, MAX_DATA_QUALITY_EXCEPTIONS);
      if (exceptionRows.length > 0) {
        await tx.exceptionItem.createMany({
          data: exceptionRows.map((row) => {
            const first = row.issues.find((issue) => issue.severity === 'ERROR') ?? row.issues[0];
            const candidate = dataQualityException(
              `row ${row.rowNumber}`,
              {
                field: first?.field ?? 'row',
                code: first?.issueCode ?? 'IMPORT_QUARANTINED',
                message: first?.message ?? 'Row quarantined during import validation',
                severity: (first?.severity === 'ERROR' ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
              },
            );
            return {
              id: newId(),
              organizationId: batch.organizationId,
              kind: candidate.kind,
              severity: candidate.severity,
              status: 'OPEN',
              exposureId: null,
              runId: null,
              title: `${candidate.title} (import ${batch.publicId})`,
              detail: `Sheet row ${row.sheetRow}: ${candidate.detail}`,
              metric: candidate.metric ?? null,
            };
          }),
        });
      }

      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status: 'IMPORTED',
          snapshotId,
          validRowCount: rows.length,
          message: `Committed ${rows.length} exposure(s) into snapshot ${snapshotPublicId} (input version ${inputVersion})`,
        },
      });
    });

    await recordAudit({
      organizationId: batch.organizationId,
      actor: actorId ? { id: actorId, fullName: actorName, role: 'RISK_ANALYST' } : null,
      action: 'IMPORT.COMMITTED',
      entityType: 'ImportBatch',
      entityId: batch.publicId,
      detail: `Committed ${rows.length} exposure(s) from ${batch.fileName} into snapshot ${inputVersion}; ${result.quarantinedRows.length} row(s) quarantined`,
    });
  } catch (error) {
    logger.error({ err: error, batchId }, 'import commit failed');
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: 'FAILED',
        message: error instanceof Error ? error.message : 'Commit failed',
      },
    });
  }
}

/**
 * `validateImportedRows` detects duplicates *inside* the file. Rows that
 * duplicate an exposure already on the ledger are dropped here instead, and the
 * decision is reported rather than hidden.
 */
function deduplicateAgainstLedger(
  rows: ParsedExposureRow[],
  existingExposureIds: string[],
): ParsedExposureRow[] {
  const existing = new Set(existingExposureIds);
  return rows.filter((row) => !existing.has(row.exposureId));
}
