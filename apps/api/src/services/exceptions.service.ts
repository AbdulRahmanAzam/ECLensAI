/**
 * The exception queue.
 *
 * Four kinds of item land here, and they are produced elsewhere — this module
 * only reads and triages them:
 *
 *   - `DATA_QUALITY`        written by the import pipeline for quarantined rows.
 *   - `ANALYST_OVERRIDE`    written by `overrides.service.ts` on every request.
 *   - `LARGE_ECL_CHANGE`    written by a run against the previous run's allowance.
 *   - `NEAR_STAGING_THRESHOLD` written by a run for exposures just under a rule.
 *
 * Triage is deliberately two-state and reversible in one direction only:
 * OPEN -> ACKNOWLEDGED ("seen, not yet fixed") -> RESOLVED. Nothing is deleted,
 * so the queue is also the record of what was raised and when it was handled.
 */
import type { Prisma, RoleName } from '@prisma/client';
import {
  EXCEPTION_KINDS,
  type ExceptionItemRecord,
  type ExceptionKind,
  type ExceptionListQuery,
  type ExceptionSummaryRecord,
  type Paginated,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { HttpError, forbidden, notFound } from '../utils/httpError';
import { toExceptionItemRecord } from './mappers';

/** Auditors may read the queue but must not triage it — triage is a decision. */
const TRIAGE_ROLES: RoleName[] = ['ADMIN', 'RISK_ANALYST', 'REVIEWER'];

const EXCEPTION_SORT_COLUMNS = ['createdAt', 'severity', 'status', 'kind', 'title'] as const;

const exceptionInclude = {
  exposure: { select: { publicId: true, borrower: { select: { name: true } } } },
} as const;

/** The shape `exceptionInclude` produces, declared structurally. */
interface ExceptionRow {
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
  acknowledgedById: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  exposure: { publicId: string; borrower: { name: string } } | null;
}

const SEVERITY_ORDER: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export async function listExceptions(
  organizationId: string,
  query: ExceptionListQuery,
): Promise<Paginated<ExceptionItemRecord>> {
  const term = query.search?.trim();
  const where: Prisma.ExceptionItemWhereInput = {
    organizationId,
    ...(query.kind && isKnownKind(query.kind) ? { kind: query.kind } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.runId ? { run: { publicId: query.runId } } : {}),
    ...(term
      ? { OR: [...(containsSearch(term, ['title', 'detail', 'metric']) ?? [])] }
      : {}),
  };

  const [totalItems, rows] = await Promise.all([
    prisma.exceptionItem.count({ where }),
    prisma.exceptionItem.findMany({
      where,
      include: exceptionInclude,
      ...toPageArgs(query),
      // Highest severity first, then newest: an unsorted queue hides the item
      // that matters, and Prisma cannot order by a computed severity rank.
      orderBy: query.sortBy
        ? orderBy(query.sortBy, query.sortDir, EXCEPTION_SORT_COLUMNS)
        : [{ severity: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
  ]);

  const items = rows.map(toExceptionItemRecord);
  if (!query.sortBy) {
    items.sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));
  }

  return { items, meta: buildPageMeta(query, totalItems) };
}

/**
 * One exception by id.
 *
 * The queue otherwise only offers a paginated list, and addressing a single row
 * by search text is not reliable. Scoped to the organization so an id from
 * another institution is a 404 rather than a disclosure.
 */
export async function getException(organizationId: string, id: string): Promise<ExceptionItemRecord> {
  const row = await prisma.exceptionItem.findFirst({
    where: { organizationId, id },
    include: exceptionInclude,
  });
  if (!row) throw notFound('No exception matches that id in your organisation');
  return toExceptionItemRecord(row);
}

function isKnownKind(value: string): value is ExceptionKind {
  return (EXCEPTION_KINDS as readonly string[]).includes(value);
}

/** Badge counts for the queue header, so the client needs no extra round trip. */
export async function getExceptionSummary(organizationId: string): Promise<ExceptionSummaryRecord> {
  const [total, open, acknowledged, resolved, byKindRows, bySeverityRows] = await Promise.all([
    prisma.exceptionItem.count({ where: { organizationId } }),
    prisma.exceptionItem.count({ where: { organizationId, status: 'OPEN' } }),
    prisma.exceptionItem.count({ where: { organizationId, status: 'ACKNOWLEDGED' } }),
    prisma.exceptionItem.count({ where: { organizationId, status: 'RESOLVED' } }),
    prisma.exceptionItem.groupBy({ by: ['kind'], where: { organizationId }, _count: { _all: true } }),
    prisma.exceptionItem.groupBy({ by: ['severity'], where: { organizationId }, _count: { _all: true } }),
  ]);

  const byKind: Partial<Record<ExceptionKind, number>> = {};
  for (const row of byKindRows) {
    if (isKnownKind(row.kind)) byKind[row.kind] = row._count._all;
  }

  const bySeverity: Partial<Record<'LOW' | 'MEDIUM' | 'HIGH', number>> = {};
  for (const row of bySeverityRows) {
    bySeverity[row.severity as 'LOW' | 'MEDIUM' | 'HIGH'] = row._count._all;
  }

  return { total, open, acknowledged, resolved, byKind, bySeverity };
}

async function findException(organizationId: string, id: string): Promise<ExceptionRow> {
  const row = await prisma.exceptionItem.findFirst({
    where: { id, organizationId },
    include: exceptionInclude,
  });
  if (!row) throw notFound(`Exception ${id} was not found`);
  return row as unknown as ExceptionRow;
}

async function setStatus(
  actor: AuditActor,
  id: string,
  status: 'ACKNOWLEDGED' | 'RESOLVED',
  note: string | undefined,
): Promise<ExceptionItemRecord> {
  if (!TRIAGE_ROLES.includes(actor.role)) {
    throw forbidden(`Only ${TRIAGE_ROLES.join(' or ')} may triage exceptions`);
  }

  const existing = await findException(actor.organizationId, id);
  if (existing.status === 'RESOLVED') {
    throw new HttpError(409, 'EXCEPTION_ALREADY_RESOLVED', 'This exception is already resolved and cannot change state again.');
  }
  if (existing.status === status) {
    throw new HttpError(409, 'EXCEPTION_ALREADY_ACKNOWLEDGED', 'This exception is already acknowledged.');
  }

  const updated = await prisma.exceptionItem.update({
    where: { id: existing.id },
    data: {
      status,
      acknowledgedById: actor.id,
      acknowledgedBy: actor.fullName,
      acknowledgedAt: new Date(),
      ...(note ? { detail: `${existing.detail}\n\n[${status} by ${actor.fullName}] ${note}` } : {}),
    },
    include: exceptionInclude,
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'EXCEPTION.ACKNOWLEDGED',
    entityType: 'ExceptionItem',
    entityId: existing.id,
    detail: `${status} exception "${existing.title}" (${existing.kind}, ${existing.severity})${
      existing.exposure ? ` on exposure ${existing.exposure.publicId}` : ''
    }${note ? `. Note: ${note}` : '.'}`,
  });

  return toExceptionItemRecord(updated as unknown as ExceptionRow);
}

export function acknowledgeException(
  actor: AuditActor,
  id: string,
  note?: string,
): Promise<ExceptionItemRecord> {
  return setStatus(actor, id, 'ACKNOWLEDGED', note);
}

export function resolveException(
  actor: AuditActor,
  id: string,
  note?: string,
): Promise<ExceptionItemRecord> {
  return setStatus(actor, id, 'RESOLVED', note);
}

/**
 * Every validation issue of an import batch as a CSV file, so a data owner can
 * work through the quarantine offline. Columns match `ValidationIssueRecord`.
 *
 * Audited because the file leaves the system: it carries borrower names and the
 * raw values an uploader submitted, so who took a copy and when is part of the
 * record, not an optional extra.
 */
export async function exportIssuesCsv(actor: AuditActor, batchPublicId: string): Promise<string> {
  const batch = await prisma.importBatch.findFirst({
    where: { organizationId: actor.organizationId, publicId: batchPublicId },
    select: { id: true, fileName: true },
  });
  if (!batch) throw notFound(`Import batch ${batchPublicId} was not found`);

  const issues = await prisma.importValidationIssue.findMany({
    where: { batchId: batch.id },
    orderBy: [{ rowNumber: 'asc' }, { field: 'asc' }],
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'IMPORT.ISSUES_EXPORTED',
    entityType: 'ImportBatch',
    entityId: batchPublicId,
    detail: `Exported ${issues.length} validation issue(s) from ${batch.fileName} as CSV`,
  });

  const header = ['rowNumber', 'sheetRow', 'field', 'rawValue', 'issueCode', 'severity', 'message', 'suggestedCorrection'];
  const escape = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = issues.map((issue) =>
    [
      String(issue.rowNumber),
      String(issue.sheetRow),
      issue.field,
      issue.rawValue ?? '',
      issue.issueCode,
      issue.severity,
      issue.message,
      issue.suggestedCorrection ?? '',
    ]
      .map(escape)
      .join(','),
  );

  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
