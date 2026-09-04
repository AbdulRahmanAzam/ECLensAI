/**
 * Read side of the append-only audit trail.
 *
 * Writing happens in `lib/audit.ts` (`recordAudit`); this module only queries.
 * There is deliberately no update, delete or upsert path for `AuditEvent` —
 * an event that was superseded stays in the trail and a new event records the
 * change, which is what makes the log usable as evidence.
 *
 * Filters are additive: `action` and `entityType` are exact matches, `from` and
 * `to` are inclusive calendar dates parsed as UTC, and `search` is a
 * case-insensitive substring across the actor, entity and free-text detail.
 * Route-level permission checks decide who may read this at all (ADMIN,
 * REVIEWER, AUDITOR); the service itself is organization-scoped by construction.
 */
import type { Prisma } from '@prisma/client';
import {
  type AuditEventRecord,
  type AuditListQuery,
  type Paginated,
} from '@eclens/shared';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { toAuditEventRecord } from './mappers';

const AUDIT_SORT_COLUMNS = ['occurredAt', 'action', 'userName', 'entityType', 'role'] as const;

/** `YYYY-MM-DD` -> UTC midnight. The contract schema already guarantees the shape. */
const startOfDay = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

/** End of the `to` day, exclusive, so a single-day range still matches. */
const endOfDayExclusive = (date: string): Date =>
  new Date(startOfDay(date).getTime() + 24 * 60 * 60 * 1000);

export async function listAuditEvents(
  organizationId: string,
  query: AuditListQuery,
): Promise<Paginated<AuditEventRecord>> {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (query.from) occurredAt.gte = startOfDay(query.from);
  if (query.to) occurredAt.lt = endOfDayExclusive(query.to);

  const where: Prisma.AuditEventWhereInput = {
    organizationId,
    ...(query.from || query.to ? { occurredAt } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.search
      ? { OR: containsSearch(query.search, ['userName', 'action', 'entityType', 'entityId', 'detail']) }
      : {}),
  };

  const [totalItems, rows] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      ...toPageArgs(query),
      orderBy: orderBy(
        query.sortBy,
        query.sortDir,
        AUDIT_SORT_COLUMNS,
        query.sortBy === 'occurredAt' ? { id: 'asc' } : { occurredAt: 'desc', id: 'asc' },
      ),
    }),
  ]);

  return {
    items: rows.map(toAuditEventRecord),
    meta: buildPageMeta(query, totalItems),
  };
}
