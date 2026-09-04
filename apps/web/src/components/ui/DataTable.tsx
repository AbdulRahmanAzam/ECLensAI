import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { cn } from '@/lib/utils';

/** Column-visibility toggle. Self-contained: no shared popover primitive exists yet. */
function ColumnVisibilityMenu({
  columns,
  visibility,
  onToggle,
}: {
  columns: Array<{ id: string; label: string }>;
  visibility: VisibilityState;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-2xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <Columns3 className="h-3.5 w-3.5" /> Columns
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-52 animate-scale-in rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          {columns.map((column) => (
            <label
              key={column.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900"
            >
              <input
                type="checkbox"
                checked={visibility[column.id] !== false}
                onChange={() => onToggle(column.id)}
                className="h-3.5 w-3.5 rounded border-slate-300 bg-surface text-brand focus:ring-brand/50"
              />
              {column.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface DataTableProps<TData> {
  // Column value types differ per column; `any` is the TanStack-recommended wrapper typing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<TData, any>[];
  data: TData[];
  loading?: boolean;
  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  maxHeightClass?: string;
  /**
   * Hand sorting to the server. A paged endpoint returns one window of rows, so
   * sorting that window locally would silently reorder a slice of a larger set;
   * with this flag the header click is reported upward and re-queried instead.
   */
  manualSorting?: boolean;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /**
   * Adds a checkbox column and reports the selected rows by id (via `getRowId`,
   * required when this is set). Selection is local UI state — what a caller
   * does with it (bulk export, bulk action) is up to them.
   */
  enableSelection?: boolean;
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Adds a "Columns" toggle above the table. Every column needs a stable `id`. */
  enableColumnVisibility?: boolean;
}

const SELECT_COLUMN_ID = '__select__';

/** Compact financial table wrapper over TanStack Table with sorting built in. */
export function DataTable<TData>({
  columns,
  data,
  loading = false,
  onRowClick,
  getRowId,
  emptyTitle = 'No records',
  emptyDescription,
  emptyAction,
  maxHeightClass,
  manualSorting = false,
  sorting: controlledSorting,
  onSortingChange,
  enableSelection = false,
  onSelectionChange,
  enableColumnVisibility = false,
}: DataTableProps<TData>) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const sorting = manualSorting ? (controlledSorting ?? []) : internalSorting;
  const emitSorting = manualSorting ? (onSortingChange ?? setInternalSorting) : setInternalSorting;
  const handleSortingChange = (
    updater: SortingState | ((previous: SortingState) => SortingState),
  ) => {
    emitSorting(typeof updater === 'function' ? updater(sorting) : updater);
  };

  const effectiveColumns = enableSelection
    ? [
        {
          id: SELECT_COLUMN_ID,
          size: 32,
          header: ({ table: tbl }) => (
            <input
              type="checkbox"
              aria-label="Select all rows"
              checked={tbl.getIsAllRowsSelected()}
              ref={(el) => {
                if (el)
                  el.indeterminate = tbl.getIsSomeRowsSelected() && !tbl.getIsAllRowsSelected();
              }}
              onChange={tbl.getToggleAllRowsSelectedHandler()}
              onClick={(event) => event.stopPropagation()}
              className="h-3.5 w-3.5 rounded border-slate-300 bg-surface text-brand focus:ring-brand/50"
            />
          ),
          cell: ({ row }) => (
            <input
              type="checkbox"
              aria-label="Select row"
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
              onClick={(event) => event.stopPropagation()}
              className="h-3.5 w-3.5 rounded border-slate-300 bg-surface text-brand focus:ring-brand/50"
            />
          ),
          enableSorting: false,
        } satisfies ColumnDef<TData, unknown>,
        ...columns,
      ]
    : columns;

  const table = useReactTable({
    data,
    columns: effectiveColumns,
    state: { sorting, rowSelection, columnVisibility },
    onSortingChange: handleSortingChange,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      setRowSelection(next);
      onSelectionChange?.(Object.keys(next).filter((id) => next[id]));
    },
    onColumnVisibilityChange: setColumnVisibility,
    manualSorting,
    enableRowSelection: enableSelection,
    getCoreRowModel: getCoreRowModel(),
    ...(manualSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
  });

  const toggleableColumns = table
    .getAllLeafColumns()
    .filter((column) => column.id !== SELECT_COLUMN_ID && column.getCanHide())
    .map((column) => ({
      id: column.id,
      label: typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id,
    }));

  if (loading) {
    return (
      <div className="space-y-2.5 p-4" role="status" aria-label="Loading table">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div>
      {enableColumnVisibility ? (
        <div className="flex justify-end border-b border-line-soft px-3 py-2">
          <ColumnVisibilityMenu
            columns={toggleableColumns}
            visibility={columnVisibility}
            onToggle={(id) => table.getColumn(id)?.toggleVisibility()}
          />
        </div>
      ) : null}
      <div className={cn('overflow-x-auto', maxHeightClass)}>
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-line bg-surface-2">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        'sticky top-0 z-10 bg-surface-2 px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.07em] text-slate-500',
                        header.column.getCanSort() &&
                          'cursor-pointer select-none transition-colors hover:text-slate-800',
                      )}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() ? (
                          sorted === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sorted === 'desc' ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          )
                        ) : null}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b border-line-soft transition-colors last:border-b-0',
                  row.getIsSelected() && 'bg-brand-soft',
                  onRowClick && 'cursor-pointer hover:bg-surface-2',
                )}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5 align-middle text-slate-600">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
