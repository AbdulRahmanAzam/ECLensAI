import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PageMeta } from '@eclens/shared';
import { Button } from './Button';

/**
 * Server-side paging. The API owns the page window, so this bar is driven purely
 * by `PageMeta` and never slices an array locally — a screen that filters must
 * re-query, not hide rows it already fetched.
 */
export function Pagination({
  meta,
  onPageChange,
  loading = false,
}: {
  meta: PageMeta;
  onPageChange: (page: number) => void;
  loading?: boolean;
}) {
  const firstItem = meta.totalItems === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const lastItem = Math.min(meta.page * meta.pageSize, meta.totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-500">
      <span className="tabular-nums">
        {firstItem}–{lastItem} of {meta.totalItems.toLocaleString('en-US')} · page {meta.page} of{' '}
        {Math.max(meta.totalPages, 1)}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || meta.page <= 1}
          onClick={() => onPageChange(meta.page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || meta.page >= meta.totalPages}
          onClick={() => onPageChange(meta.page + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );
}
