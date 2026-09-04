import { useEffect, useMemo, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import type { ListQuery, SortDirection } from '@eclens/shared';

/** Search is debounced so typing a borrower name does not fire a request per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface UseServerListOptions {
  pageSize?: number;
  sortBy?: string;
  sortDir?: SortDirection;
  debounceMs?: number;
}

/**
 * State for a server-paged list endpoint.
 *
 * Every filter, sort and page-size change resets the page to 1, because the API
 * windows rows *after* filtering — staying on page 4 of a narrowed result set
 * would render an empty table for a query that has matches.
 */
export function useServerList<TFilters extends Record<string, unknown>>(
  initialFilters: TFilters,
  options: UseServerListOptions = {},
) {
  const { pageSize: initialPageSize = 25, sortBy, sortDir = 'desc', debounceMs = 300 } = options;

  const [filters, setFilters] = useState<TFilters>(initialFilters);
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [activeSortBy, setActiveSortBy] = useState<string | undefined>(sortBy);
  const [activeSortDir, setActiveSortDir] = useState<SortDirection>(sortDir);

  const search = useDebouncedValue(searchInput, debounceMs);

  const setFilter = <K extends keyof TFilters>(key: K, value: TFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const setPageSize = (value: number) => {
    setPageSizeState(value);
    setPage(1);
  };

  /** Accepts the resolved state from a `DataTable manualSorting` header click. */
  const applySorting = (next: SortingState) => {
    const first = next[0];
    setActiveSortBy(first?.id);
    setActiveSortDir(first?.desc ? 'desc' : 'asc');
    setPage(1);
  };

  const reset = () => {
    setFilters(initialFilters);
    setSearchInput('');
    setPage(1);
    setPageSizeState(initialPageSize);
    setActiveSortBy(sortBy);
    setActiveSortDir(sortDir);
  };

  const hasActiveFilters = useMemo(
    () =>
      Object.values(filters).some((value) => value !== '' && value != null) || search.trim() !== '',
    [filters, search],
  );

  /** The active server sort in the shape `DataTable manualSorting` expects. */
  const sortingState = useMemo<SortingState>(
    () => (activeSortBy ? [{ id: activeSortBy, desc: activeSortDir === 'desc' }] : []),
    [activeSortBy, activeSortDir],
  );

  /** The exact object handed to `api.*` — `undefined` fields are dropped by `toQueryString`. */
  const query = useMemo<ListQuery & TFilters>(
    () =>
      ({
        ...filters,
        page,
        pageSize,
        sortBy: activeSortBy,
        sortDir: activeSortDir,
        search: search.trim() === '' ? undefined : search.trim(),
      }) as ListQuery & TFilters,
    [filters, page, pageSize, activeSortBy, activeSortDir, search],
  );

  return {
    filters,
    setFilter,
    reset,
    hasActiveFilters,
    searchInput,
    setSearchInput: (value: string) => {
      setSearchInput(value);
      setPage(1);
    },
    search,
    page,
    setPage,
    pageSize,
    setPageSize,
    sortBy: activeSortBy,
    sortDir: activeSortDir,
    sortingState,
    applySorting,
    query,
  };
}
