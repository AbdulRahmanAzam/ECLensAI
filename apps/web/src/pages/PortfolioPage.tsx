import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Download, SearchX, UserCog } from 'lucide-react';
import type { ExposureRecord, Stage } from '@eclens/shared';
import { formatDecimalPercent, formatDecimalText } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError, saveTextFile } from '@/api/http';
import { Badge, StageBadge, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterChips } from '@/components/ui/FilterChips';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { useServerList } from '@/hooks/useServerList';
import { stagingCodeLabel } from '@/lib/staging';
import { useSettings } from '@/providers/SettingsProvider';

type PortfolioFilterKey = 'segment' | 'stage' | 'region';
const FILTER_LABEL: Record<PortfolioFilterKey, string> = {
  segment: 'Segment',
  stage: 'Stage',
  region: 'Region',
};

const column = createColumnHelper<ExposureRecord>();

/**
 * Server-paged portfolio list.
 *
 * Filtering, sorting and paging all happen in the API, so the totals strip is
 * read from `GET /portfolio/summary` rather than summed from the rows on screen —
 * adding up one page of decimal strings would report a number that is neither
 * the page nor the portfolio.
 */
export function PortfolioPage() {
  const navigate = useNavigate();
  const { moneyString, currency } = useSettings();
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Seeded once from the URL on mount, so a shared link reproduces the same
  // scope. Read directly rather than through `useServerList`'s own state: the
  // hook is shared by several pages and stays URL-agnostic itself.
  const initialFiltersRef = useRef({
    segment: searchParams.get('segment') ?? undefined,
    stage: searchParams.get('stage') ? (Number(searchParams.get('stage')) as Stage) : undefined,
    region: searchParams.get('region') ?? undefined,
  });

  const list = useServerList<{
    segment?: string;
    stage?: Stage;
    region?: string;
    industry?: string;
  }>(initialFiltersRef.current, { sortBy: 'grossCarryingAmount', sortDir: 'desc', pageSize: 25 });

  // Written back so the address bar always reproduces the current filters —
  // never read from again here, which is what keeps this a one-way mirror
  // instead of fighting `useServerList`'s own state on every keystroke.
  useEffect(() => {
    const next = new URLSearchParams();
    if (list.filters.segment) next.set('segment', list.filters.segment);
    if (list.filters.stage) next.set('stage', String(list.filters.stage));
    if (list.filters.region) next.set('region', list.filters.region);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.filters.segment, list.filters.stage, list.filters.region]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portfolio-exposures', list.query],
    queryFn: () => api.portfolio.listExposures(list.query),
  });

  const exportCsv = useMutation({
    mutationFn: () => api.portfolio.exportExposuresCsv(list.query),
    onSuccess: (csv) => {
      const rowCount = csv.split('\r\n').length - 1;
      saveTextFile(`portfolio-export-${rowCount}-rows.csv`, csv, 'text/csv;charset=utf-8');
      push(
        'success',
        'Export ready',
        `${rowCount} row(s) matching the current filters. Recorded in the audit log.`,
      );
    },
    onError: (error) =>
      push(
        'error',
        'Export failed',
        error instanceof ApiError ? error.message : 'The export could not be generated.',
      ),
  });

  const { data: summary } = useQuery({
    queryKey: ['portfolio-summary'],
    queryFn: () => api.portfolio.summary(),
  });

  const segments = useMemo(
    () => summary?.segmentBreakdown.map((row) => row.segment) ?? [],
    [summary],
  );
  const regions = useMemo(
    () => Array.from(new Set((data?.items ?? []).map((row) => row.region).filter(Boolean))).sort(),
    [data],
  );

  const columns = useMemo(
    () => [
      column.accessor('publicId', {
        header: 'Exposure',
        cell: (info) => (
          <div>
            <p className="font-medium text-navy-800">{info.getValue()}</p>
            <p className="text-2xs text-slate-400">{info.row.original.borrowerId}</p>
          </div>
        ),
      }),
      column.accessor('segment', {
        header: 'Borrower',
        cell: (info) => (
          <div>
            <p className="font-medium text-slate-800">{info.row.original.borrowerName}</p>
            <p className="text-2xs text-slate-500">
              {info.getValue()} · {info.row.original.productType}
            </p>
          </div>
        ),
      }),
      column.accessor('currentStage', {
        header: 'Stage',
        enableSorting: false,
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="flex items-center gap-1.5">
              <StageBadge stage={info.getValue()} />
              {row.hasStageOverride ? (
                <Tooltip content={`Analyst override in force — model stage ${row.currentStage}`}>
                  <UserCog className="h-3.5 w-3.5 text-navy-500" />
                </Tooltip>
              ) : null}
            </span>
          );
        },
      }),
      column.accessor('stagePrimaryReason', {
        header: 'Primary driver',
        enableSorting: false,
        cell: (info) => (
          <span className="text-2xs text-slate-500">
            {stagingCodeLabel(info.row.original.stageRuleCodes[0] ?? '') || info.getValue()}
          </span>
        ),
      }),
      column.accessor('grossCarryingAmount', {
        header: 'Gross carrying amount',
        cell: (info) => (
          <span className="tabular-nums">{moneyString(info.getValue(), { compact: true })}</span>
        ),
      }),
      column.accessor('daysPastDue', {
        header: 'DPD',
        cell: (info) =>
          info.getValue() > 0 ? (
            <span className="font-medium tabular-nums text-amber-700">{info.getValue()}</span>
          ) : (
            <span className="tabular-nums text-slate-400">0</span>
          ),
      }),
      column.accessor('currentCreditRating', { header: 'Rating' }),
      column.accessor('lgd', {
        header: 'LGD',
        cell: (info) => (
          <span className="tabular-nums">{formatDecimalPercent(info.getValue(), 1)}</span>
        ),
      }),
      column.accessor('latestLossAllowance', {
        header: 'Loss allowance',
        enableSorting: false,
        cell: (info) =>
          info.getValue() === null ? (
            <span className="text-slate-400">not yet run</span>
          ) : (
            <span className="font-medium tabular-nums text-red-700">
              {moneyString(info.getValue(), { compact: true })}
            </span>
          ),
      }),
      column.accessor('latestCoverageRatio', {
        header: 'Coverage',
        enableSorting: false,
        cell: (info) => (
          <span className="tabular-nums text-slate-600">
            {info.getValue() === null ? '—' : formatDecimalPercent(info.getValue())}
          </span>
        ),
      }),
      column.accessor('region', { header: 'Region', enableSorting: false }),
    ],
    [moneyString],
  );

  const rows = data?.items ?? [];
  const totals = summary?.totals;

  return (
    <div>
      <PageHeader
        title="Loan portfolio"
        description={
          summary
            ? `${summary.snapshotLabel} · reporting date ${summary.asOf} · every figure is an exact decimal string from the engine.`
            : 'Every exposure with its computed stage and scenario-weighted allowance. Click a row for the full ECL derivation.'
        }
        tags={<SyntheticBadge />}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="h-3.5 w-3.5" />}
              loading={exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
            >
              Export CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate('/imports')}>
              Import a portfolio
            </Button>
          </>
        }
      />

      {totals ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-xs text-slate-600">
          <span>
            Exposures{' '}
            <strong className="font-semibold tabular-nums text-navy-900">
              {totals.exposureCount.toLocaleString('en-US')}
            </strong>
          </span>
          <span>
            Gross{' '}
            <strong className="font-semibold tabular-nums text-navy-900">
              {moneyString(totals.totalGrossCarryingAmount, { compact: true })}
            </strong>
          </span>
          <span>
            Allowance{' '}
            <strong className="font-semibold tabular-nums text-red-700">
              {moneyString(totals.totalLossAllowance, { compact: true })}
            </strong>
          </span>
          <span>
            Coverage{' '}
            <strong className="font-semibold tabular-nums text-navy-900">
              {formatDecimalPercent(totals.coverageRatio)}
            </strong>
          </span>
          <span className="text-slate-400">
            Net carrying {moneyString(totals.totalNetCarryingAmount, { compact: true })} · display
            currency {currency}
          </span>
        </div>
      ) : null}

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_190px_140px_170px_110px]">
          <Input
            aria-label="Search portfolio"
            placeholder="Search borrower or exposure ID…"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
          />
          <Select
            aria-label="Filter by segment"
            value={list.filters.segment ?? ''}
            onChange={(event) =>
              list.setFilter('segment', event.target.value === '' ? undefined : event.target.value)
            }
          >
            <option value="">All segments</option>
            {segments.map((segment) => (
              <option key={segment} value={segment}>
                {segment}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by stage"
            value={list.filters.stage === undefined ? '' : String(list.filters.stage)}
            onChange={(event) =>
              list.setFilter(
                'stage',
                event.target.value === '' ? undefined : (Number(event.target.value) as Stage),
              )
            }
          >
            <option value="">All stages</option>
            <option value="1">Stage 1</option>
            <option value="2">Stage 2</option>
            <option value="3">Stage 3</option>
          </Select>
          <Select
            aria-label="Filter by region"
            value={list.filters.region ?? ''}
            onChange={(event) =>
              list.setFilter('region', event.target.value === '' ? undefined : event.target.value)
            }
          >
            <option value="">All regions</option>
            {regions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Rows per page"
            value={String(list.pageSize)}
            onChange={(event) => list.setPageSize(Number(event.target.value))}
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size} rows
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {(['segment', 'stage', 'region'] as PortfolioFilterKey[]).some(
        (key) => list.filters[key] !== undefined,
      ) ? (
        <div className="mb-4">
          <FilterChips
            chips={(['segment', 'stage', 'region'] as PortfolioFilterKey[])
              .filter((key) => list.filters[key] !== undefined)
              .map((key) => ({
                key,
                label: `${FILTER_LABEL[key]}: ${key === 'stage' ? `Stage ${list.filters.stage}` : list.filters[key]}`,
              }))}
            onRemove={(key) => list.setFilter(key as PortfolioFilterKey, undefined)}
            onClearAll={list.reset}
          />
        </div>
      ) : null}

      {selectedIds.length > 0 ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-navy-200 bg-navy-50 px-3 py-2 text-xs text-navy-800">
          <span className="font-medium">{selectedIds.length} row(s) selected</span>
          <span className="text-navy-500">
            — export currently downloads every row matching the active filters, not only the
            selection.
          </span>
        </div>
      ) : null}

      <Card>
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : !isLoading && rows.length === 0 && list.hasActiveFilters ? (
          <EmptyState
            icon={<SearchX className="h-8 w-8" />}
            title="No exposures match your filters"
            description="Try a different search term, or reset the segment, stage and region filters."
            action={
              <Button size="sm" variant="secondary" onClick={list.reset}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            loading={isLoading}
            manualSorting
            sorting={list.sortingState}
            onSortingChange={list.applySorting}
            onRowClick={(row) => navigate(`/portfolio/${row.publicId}`)}
            getRowId={(row) => row.id}
            enableSelection
            onSelectionChange={setSelectedIds}
            enableColumnVisibility
            emptyTitle="Portfolio is empty"
            emptyDescription="Import a portfolio extract, or download the synthetic template, to begin computing ECL."
            emptyAction={
              <Button size="sm" onClick={() => navigate('/imports')}>
                Go to imports
              </Button>
            }
          />
        )}
        {data ? (
          <Pagination meta={data.meta} onPageChange={list.setPage} loading={isLoading} />
        ) : null}
      </Card>

      <p className="mt-3 text-2xs text-slate-500">
        Only the columns the API whitelists are sortable; the rest are display-only so a header
        click never implies an ordering the server does not perform. Loss allowance and coverage
        come from each exposure's most recent result-bearing run —{' '}
        {rows.length > 0 && rows[0].latestRunId === null
          ? 'no run has covered this page yet'
          : 'hover a value for the exact digits'}
        .
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {rows
          .filter((row) => row.latestLossAllowance !== null)
          .slice(0, 1)
          .map((row) => (
            <Badge key={row.id} tone="neutral">
              {row.publicId} allowance {formatDecimalText(row.latestLossAllowance)} {row.currency}
            </Badge>
          ))}
      </div>
    </div>
  );
}
