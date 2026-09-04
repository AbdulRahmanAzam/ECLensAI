/**
 * Shared pagination, sorting, filtering and organization scoping.
 *
 * Every list endpoint is organization-scoped by construction: `scopeWhere`
 * always injects the caller's organizationId, and callers compose their own
 * filters on top of it rather than replacing it. A cross-tenant read is
 * therefore not expressible through this helper.
 */
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListQuery,
  type PageMeta,
} from '@eclens/shared';

export interface PageArgs {
  skip: number;
  take: number;
}

export function toPageArgs(query: ListQuery): PageArgs {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function buildPageMeta(query: ListQuery, totalItems: number): PageMeta {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  return {
    page,
    pageSize,
    totalItems,
    totalPages: pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1,
  };
}

/**
 * Sorts by an allow-listed column only. An unknown `sortBy` is ignored rather
 * than forwarded, so a client can never sort by a column the endpoint did not
 * intend to expose (which could leak ordering information about it). A stable
 * tie-breaker is always appended so pagination cannot skip or repeat rows.
 *
 * Each clause is emitted as its own single-key object: Prisma rejects an
 * `orderBy` array element carrying two keys, so a multi-column tie-breaker has
 * to be spread rather than pushed whole.
 */
export function orderBy(
  sortBy: string | undefined,
  sortDir: string | undefined,
  allowed: readonly string[],
  tieBreaker: Record<string, 'asc' | 'desc'> = { id: 'asc' },
): Record<string, 'asc' | 'desc'>[] {
  const direction: 'asc' | 'desc' = sortDir === 'desc' ? 'desc' : 'asc';
  const clauses: Record<string, 'asc' | 'desc'>[] = [];
  const sorted = new Set<string>();
  if (sortBy && allowed.includes(sortBy)) {
    clauses.push({ [sortBy]: direction });
    sorted.add(sortBy);
  }
  for (const [column, order] of Object.entries(tieBreaker)) {
    if (sorted.has(column)) continue;
    clauses.push({ [column]: order });
  }
  return clauses;
}

/** Case-insensitive substring match across the given columns. */
export function containsSearch(
  search: string | undefined,
  columns: readonly string[],
): Record<string, unknown>[] | undefined {
  const term = search?.trim();
  if (!term || columns.length === 0) return undefined;
  return columns.map((column) => ({ [column]: { contains: term } }));
}
