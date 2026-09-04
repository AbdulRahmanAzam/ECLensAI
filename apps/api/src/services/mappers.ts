/**
 * Prisma row -> wire DTO mapping.
 *
 * This is the only place a persisted `Decimal` becomes a string on the wire.
 * Money is rendered through the engine's `moneyToString` (2dp) and rates
 * through `rateToString` (10dp), so a figure read back from the database is
 * byte-identical to the figure the engine produced — including trailing zeros,
 * which are part of what makes a number auditable. No binary float is ever
 * introduced on the way out.
 */
import type { Prisma } from '@prisma/client';
import {
  PORTFOLIO_FIELDS,
  moneyToString,
  rateToString,
  dec,
  type AuditEventRecord,
  type EclLineage,
  type ExceptionItemRecord,
  type ImportBatchRecord,
  type PortfolioSnapshotRecord,
  type RoleName,
  type RunStatus,
  type Stage,
  type StageOverrideHistoryRecord,
  type StagingDecision,
  type ValidationIssueRecord,
} from '@eclens/shared';

type DecimalLike = Prisma.Decimal;

/**
 * Fallback for a batch whose suggested mapping could not be read back. `{}` is
 * not a valid `SuggestedMapping` — the record type requires an entry for every
 * portfolio field — so "nothing suggested" has to be spelled out in full.
 */
const UNMAPPED_SUGGESTIONS = Object.fromEntries(
  PORTFOLIO_FIELDS.map((field) => [field, null]),
) as ImportBatchRecord['suggestedMapping'];

export const moneyStr = (value: DecimalLike | null | undefined): string =>
  value === null || value === undefined ? '0.00' : moneyToString(dec(value.toString()));

export const rateStr = (value: DecimalLike | null | undefined): string =>
  value === null || value === undefined ? '0.0000000000' : rateToString(dec(value.toString()));

/** Date column -> unambiguous ISO calendar date. */
export const dateStr = (value: Date): string => value.toISOString().slice(0, 10);

/** Timestamp column -> full UTC ISO-8601, or null. */
export const tsStr = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

export const jsonAs = <T>(value: Prisma.JsonValue | null | undefined, fallback: T): T =>
  value === null || value === undefined ? fallback : (value as unknown as T);

export const stageOf = (value: number): Stage => (value === 3 ? 3 : value === 2 ? 2 : 1);

export function toAuditEventRecord(row: {
  id: string;
  occurredAt: Date;
  organizationId: string;
  userId: string | null;
  userName: string;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  ipAddress: string | null;
  requestId: string | null;
}): AuditEventRecord {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    organizationId: row.organizationId,
    userId: row.userId,
    userName: row.userName,
    role: row.role as RoleName,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    detail: row.detail,
    ipAddress: row.ipAddress,
    requestId: row.requestId,
  };
}

export function toStageOverrideHistoryRecord(row: {
  id: string;
  exposureId: string;
  stageBefore: number;
  stageAfter: number;
  reason: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  occurredAt: Date;
  reviewerStatus: string;
  reviewerName: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
}): StageOverrideHistoryRecord {
  return {
    id: row.id,
    exposureId: row.exposureId,
    stageBefore: stageOf(row.stageBefore),
    stageAfter: stageOf(row.stageAfter),
    reason: row.reason,
    actorId: row.actorId,
    actorName: row.actorName,
    actorRole: row.actorRole as RoleName,
    occurredAt: row.occurredAt.toISOString(),
    reviewerStatus: row.reviewerStatus as StageOverrideHistoryRecord['reviewerStatus'],
    reviewerName: row.reviewerName,
    reviewedAt: tsStr(row.reviewedAt),
    reviewComment: row.reviewComment,
  };
}

export function toExceptionItemRecord(row: {
  id: string;
  kind: string;
  severity: string;
  status: string;
  exposureId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  metric: string | null;
  createdAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  exposure?: { publicId: string; borrower?: { name: string } } | null;
}): ExceptionItemRecord {
  return {
    id: row.id,
    kind: row.kind as ExceptionItemRecord['kind'],
    severity: row.severity as ExceptionItemRecord['severity'],
    status: row.status as ExceptionItemRecord['status'],
    exposureId: row.exposureId,
    exposurePublicId: row.exposure?.publicId ?? null,
    borrowerName: row.exposure?.borrower?.name ?? null,
    runId: row.runId,
    title: row.title,
    detail: row.detail,
    metric: row.metric,
    createdAt: row.createdAt.toISOString(),
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: tsStr(row.acknowledgedAt),
  };
}

export function toPortfolioSnapshotRecord(row: {
  id: string;
  label: string;
  asOfDate: Date;
  exposureCount: number;
  totalGrossExposure: DecimalLike;
  totalEcl: DecimalLike;
  coverageRatio: DecimalLike;
  stage3Share: DecimalLike;
  source: string;
  importBatchId: string | null;
  createdAt: Date;
}): PortfolioSnapshotRecord {
  return {
    id: row.id,
    label: row.label,
    asOfDate: dateStr(row.asOfDate),
    exposureCount: row.exposureCount,
    totalGrossExposure: moneyStr(row.totalGrossExposure),
    totalEcl: moneyStr(row.totalEcl),
    coverageRatio: rateStr(row.coverageRatio),
    stage3Share: rateStr(row.stage3Share),
    source: row.source as PortfolioSnapshotRecord['source'],
    importBatchId: row.importBatchId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toImportBatchRecord(row: {
  id: string;
  publicId: string;
  fileName: string;
  sourceFormat: string;
  status: string;
  createdAt: Date;
  uploadedById: string | null;
  uploadedBy: string;
  rowCount: number;
  previewRowCount: number;
  validRowCount: number;
  quarantinedRowCount: number;
  errorCount: number;
  warningCount: number;
  message: string;
  headers: Prisma.JsonValue;
  mapping: Prisma.JsonValue;
  suggestedMapping: Prisma.JsonValue;
  missingRequiredFields: Prisma.JsonValue;
  unmappedHeaders: Prisma.JsonValue;
  percentageNormalization: string;
  truncated: boolean;
  rowsSkippedByTruncation: number;
  committedAt: Date | null;
  committedBy: string | null;
  snapshotId: string | null;
  snapshotLabel: string | null;
}): ImportBatchRecord {
  return {
    id: row.publicId,
    publicId: row.publicId,
    fileName: row.fileName,
    sourceFormat: row.sourceFormat as ImportBatchRecord['sourceFormat'],
    status: row.status as ImportBatchRecord['status'],
    uploadedAt: row.createdAt.toISOString(),
    uploadedById: row.uploadedById,
    uploadedBy: row.uploadedBy,
    rowCount: row.rowCount,
    previewRowCount: row.previewRowCount,
    validRowCount: row.validRowCount,
    quarantinedRowCount: row.quarantinedRowCount,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    message: row.message,
    headers: jsonAs<string[]>(row.headers, []),
    mapping: jsonAs<ImportBatchRecord['mapping']>(row.mapping, {}),
    suggestedMapping: jsonAs<ImportBatchRecord['suggestedMapping']>(row.suggestedMapping, UNMAPPED_SUGGESTIONS),
    missingRequiredFields: jsonAs<ImportBatchRecord['missingRequiredFields']>(row.missingRequiredFields, []),
    percentageNormalizationMode:
      row.percentageNormalization as ImportBatchRecord['percentageNormalizationMode'],
    unmappedHeaders: jsonAs<string[]>(row.unmappedHeaders, []),
    truncated: row.truncated,
    rowsSkippedByTruncation: row.rowsSkippedByTruncation,
    committedAt: tsStr(row.committedAt),
    committedBy: row.committedBy,
    snapshotId: row.snapshotId,
    snapshotLabel: row.snapshotLabel,
  };
}

export function toValidationIssueRecord(row: {
  id: string;
  rowNumber: number;
  sheetRow: number;
  field: string;
  rawValue: string | null;
  issueCode: string;
  severity: string;
  message: string;
  suggestedCorrection: string | null;
}): ValidationIssueRecord {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    sheetRow: row.sheetRow,
    field: row.field,
    rawValue: row.rawValue ?? '',
    issueCode: row.issueCode as ValidationIssueRecord['issueCode'],
    severity: row.severity as ValidationIssueRecord['severity'],
    message: row.message,
    suggestedCorrection: row.suggestedCorrection,
  };
}

export const runStatusOf = (value: string): RunStatus => value as RunStatus;
export const lineageOf = (value: Prisma.JsonValue | null): EclLineage | null =>
  value === null || value === undefined ? null : (value as unknown as EclLineage);
export const stagingOf = (value: Prisma.JsonValue | null): StagingDecision | null =>
  value === null || value === undefined ? null : (value as unknown as StagingDecision);
