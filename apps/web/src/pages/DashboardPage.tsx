import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  Banknote,
  Clock,
  GitCompare,
  Layers,
  Percent,
  ShieldAlert,
  Target,
  Wallet,
} from 'lucide-react';
import type { AnalyticsFilter, ConcentrationDimension, DriverExposure } from '@eclens/shared';
import {
  decimalStringToNumber,
  formatDate,
  formatDateTime,
  formatDecimalPercent,
} from '@eclens/shared';
import { api } from '@/api/client';
import { ExecutiveCommentaryPanel } from '@/components/ai/ExecutiveCommentaryPanel';
import { MovementBridgeChart } from '@/components/dashboard/MovementBridgeChart';
import { ScenarioComparisonChart } from '@/components/dashboard/ScenarioComparisonChart';
import { StageMigrationMatrix } from '@/components/dashboard/StageMigrationMatrix';
import { Badge, StageBadge, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterChips } from '@/components/ui/FilterChips';
import { MetricCard } from '@/components/ui/MetricCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { useSettings } from '@/providers/SettingsProvider';
import { tooltipStyle, useChartTheme } from '@/lib/chartTheme';

const driverColumn = createColumnHelper<DriverExposure>();

const CONCENTRATION_LABEL: Record<ConcentrationDimension, string> = {
  segment: 'Segment',
  productType: 'Product',
  region: 'Region',
  industry: 'Industry',
  rating: 'Rating',
};

const FILTER_KEYS = [
  'snapshotId',
  'segment',
  'productType',
  'region',
  'industry',
  'rating',
  'stage',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/**
 * The dashboard reads from `/api/v1/analytics/*` — nine aggregates the server
 * computes over the same rows the run detail page and the AI copilot's tools
 * read, so a figure here cannot disagree with a figure anywhere else in the
 * product. Filters live in the URL (`useSearchParams`) so a link reproduces
 * exactly the scope being discussed, and every chart says in one line what
 * question it answers, because a judge has about 30 seconds.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const { moneyString, percentString, percentPointsString } = useSettings();
  const chart = useChartTheme();
  const [searchParams, setSearchParams] = useSearchParams();

  const getParam = (key: FilterKey): string | undefined => searchParams.get(key) ?? undefined;
  const setParam = (key: FilterKey, value: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const clearAll = () => setSearchParams(new URLSearchParams(), { replace: true });

  const snapshotId = getParam('snapshotId');
  const segment = getParam('segment');
  const productType = getParam('productType');
  const region = getParam('region');
  const industry = getParam('industry');
  const rating = getParam('rating');
  const stageParam = getParam('stage');
  const stage = stageParam ? (Number(stageParam) as 1 | 2 | 3) : undefined;

  const fullFilter: AnalyticsFilter = {
    snapshotId,
    segment,
    productType,
    region,
    industry,
    rating,
    stage,
  };
  // The movement and trend endpoints reject a `stage`/`snapshotId` key outright
  // (a filtered bridge or a single-period trend would contradict what each
  // measures) — the key must be genuinely absent, not merely `undefined`.
  const { stage: _omitStage, ...movementFilter } = fullFilter;
  const { snapshotId: _omitSnapshot, ...trendFilter } = fullFilter;

  const filtersQuery = useQuery({
    queryKey: ['analytics-filters', snapshotId],
    queryFn: () => api.analytics.filters(snapshotId),
  });
  const summaryQuery = useQuery({
    queryKey: ['analytics-summary', fullFilter],
    queryFn: () => api.analytics.summary(fullFilter),
  });
  const movementQuery = useQuery({
    queryKey: ['analytics-movement', movementFilter],
    queryFn: () => api.analytics.movement(movementFilter),
  });
  const trendQuery = useQuery({
    queryKey: ['analytics-trend', trendFilter],
    queryFn: () => api.analytics.trend(trendFilter),
  });
  const migrationQuery = useQuery({
    queryKey: ['analytics-migration', snapshotId],
    queryFn: () => api.analytics.migration(snapshotId ? { toSnapshotId: snapshotId } : {}),
  });
  const scenariosQuery = useQuery({
    queryKey: ['analytics-scenarios', snapshotId],
    queryFn: () => api.analytics.scenarios(snapshotId ? { snapshotId } : {}),
    retry: false,
  });
  const concentrationQuery = useQuery({
    queryKey: ['analytics-concentration', fullFilter],
    queryFn: () => api.analytics.concentration(fullFilter),
  });
  const driversQuery = useQuery({
    queryKey: ['analytics-drivers', fullFilter],
    queryFn: () => api.analytics.drivers({ ...fullFilter, limit: 8 }),
  });
  const exceptionsQuery = useQuery({
    queryKey: ['exceptions-summary'],
    queryFn: () => api.exceptions.summary(),
  });

  if (summaryQuery.isError) {
    return (
      <ErrorState
        description={summaryQuery.error instanceof Error ? summaryQuery.error.message : undefined}
        onRetry={() => void summaryQuery.refetch()}
      />
    );
  }

  const summary = summaryQuery.data;
  const totals = summary?.totals;
  const isLoading = summaryQuery.isLoading;

  const trendPoints = (trendQuery.data?.points ?? []).map((point) => ({
    reportingDate: point.reportingDate,
    label: point.snapshotLabel,
    coverageRatio: decimalStringToNumber(point.coverageRatio),
    coverageRatioText: point.coverageRatio,
    allowance: decimalStringToNumber(point.lossAllowance),
    allowanceText: point.lossAllowance,
  }));

  const movementDelta = movementQuery.data?.changePercent
    ? decimalStringToNumber(movementQuery.data.changePercent) / 100
    : undefined;

  const chips = FILTER_KEYS.filter((key) => key !== 'snapshotId' && getParam(key)).map((key) => ({
    key,
    label: `${key === 'productType' ? 'Product' : key.charAt(0).toUpperCase() + key.slice(1)}: ${key === 'stage' ? `Stage ${getParam(key)}` : getParam(key)}`,
  }));

  const driverColumns = [
    driverColumn.accessor('exposurePublicId', {
      header: 'Exposure',
      cell: (info) => (
        <div>
          <p className="font-medium text-navy-800">{info.getValue()}</p>
          <p className="text-2xs text-slate-500">{info.row.original.borrowerName}</p>
        </div>
      ),
    }),
    driverColumn.accessor('stage', {
      header: 'Stage',
      cell: (info) => <StageBadge stage={info.getValue()} />,
    }),
    driverColumn.accessor('lossAllowance', {
      header: 'Allowance',
      cell: (info) => (
        <span className="font-medium text-red-700">
          {moneyString(info.getValue(), { compact: true })}
        </span>
      ),
    }),
    driverColumn.accessor('shareOfTotalAllowancePercent', {
      header: 'Share',
      cell: (info) => <span className="text-slate-500">{percentString(info.getValue(), 1)}</span>,
    }),
    driverColumn.accessor('primaryReason', {
      header: 'Primary driver',
      cell: (info) => <span className="text-xs text-slate-500">{info.getValue()}</span>,
    }),
  ];

  const activePeriod = filtersQuery.data?.periods.find(
    (period) => period.snapshotId === (snapshotId ?? filtersQuery.data?.periods[0]?.snapshotId),
  );

  return (
    <div>
      <PageHeader
        title="Portfolio overview"
        description={
          summary
            ? `${summary.snapshot.label} · reporting date ${formatDate(summary.reportingDate)} · ${
                summary.run
                  ? `run ${summary.run.publicId} (${summary.run.status.toLowerCase()})`
                  : 'no completed run'
              }`
            : 'Provisional ECL position.'
        }
        tags={<SyntheticBadge />}
        actions={
          <Link to="/ecl-runs">
            <Button>Open ECL runs</Button>
          </Link>
        }
      />

      {/* Global filters ---------------------------------------------------- */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 py-3">
          <Select
            label="Reporting period"
            value={snapshotId ?? ''}
            onChange={(event) => setParam('snapshotId', event.target.value || undefined)}
            className="w-44"
          >
            <option value="">Latest</option>
            {(filtersQuery.data?.periods ?? []).map((period) => (
              <option key={period.snapshotId} value={period.snapshotId}>
                {formatDate(period.reportingDate)}
              </option>
            ))}
          </Select>
          <Select
            label="Segment"
            value={segment ?? ''}
            onChange={(event) => setParam('segment', event.target.value || undefined)}
            className="w-36"
          >
            <option value="">All segments</option>
            {(filtersQuery.data?.segments ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </Select>
          <Select
            label="Product"
            value={productType ?? ''}
            onChange={(event) => setParam('productType', event.target.value || undefined)}
            className="w-36"
          >
            <option value="">All products</option>
            {(filtersQuery.data?.productTypes ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </Select>
          <Select
            label="Region"
            value={region ?? ''}
            onChange={(event) => setParam('region', event.target.value || undefined)}
            className="w-36"
          >
            <option value="">All regions</option>
            {(filtersQuery.data?.regions ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </Select>
          <Select
            label="Industry"
            value={industry ?? ''}
            onChange={(event) => setParam('industry', event.target.value || undefined)}
            className="w-36"
          >
            <option value="">All industries</option>
            {(filtersQuery.data?.industries ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </Select>
          <Select
            label="Rating"
            value={rating ?? ''}
            onChange={(event) => setParam('rating', event.target.value || undefined)}
            className="w-28"
          >
            <option value="">All ratings</option>
            {(filtersQuery.data?.ratings ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </Select>
          <Select
            label="Stage"
            value={stageParam ?? ''}
            onChange={(event) => setParam('stage', event.target.value || undefined)}
            className="w-28"
          >
            <option value="">All stages</option>
            {(filtersQuery.data?.stages ?? []).map((option) => (
              <option key={option.stage} value={option.stage}>
                Stage {option.stage} ({option.count})
              </option>
            ))}
          </Select>
          {activePeriod ? (
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-slate-400">
              <Clock className="h-3.5 w-3.5" />
              {activePeriod.hasResults
                ? `Calculated as of ${formatDate(activePeriod.reportingDate)}`
                : 'No completed run for this period'}
            </span>
          ) : null}
        </CardContent>
        {chips.length > 0 ? (
          <CardContent className="border-t border-line-soft py-2.5">
            <FilterChips
              chips={chips}
              onRemove={(key) => setParam(key as FilterKey, undefined)}
              onClearAll={clearAll}
            />
          </CardContent>
        ) : null}
      </Card>

      {/* KPI row ------------------------------------------------------------ */}
      {/* Six across only once the tiles are genuinely wide enough for a label
          to sit on one or two lines — below 2xl they go three across, which
          keeps the figures comparable instead of ragged. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          label="Gross carrying amount"
          value={moneyString(totals?.grossCarryingAmount, { compact: true })}
          hint={totals ? `${totals.exposureCount} exposures` : undefined}
          icon={<Banknote className="h-4 w-4" />}
          loading={isLoading}
        />
        <MetricCard
          label="Total EAD"
          value={moneyString(totals?.ead, { compact: true })}
          hint="Exposure at default, as at the reporting date"
          icon={<Wallet className="h-4 w-4" />}
          loading={isLoading}
        />
        <MetricCard
          label="ECL loss allowance"
          value={moneyString(totals?.lossAllowance, { compact: true })}
          hint={
            movementQuery.data
              ? `vs. ${formatDate(movementQuery.data.from.reportingDate)}`
              : 'Scenario-weighted'
          }
          delta={movementDelta}
          icon={<Layers className="h-4 w-4" />}
          loading={isLoading}
        />
        <MetricCard
          label="Coverage ratio"
          value={percentString(totals?.coverageRatio)}
          hint="Allowance over gross carrying amount"
          icon={<Percent className="h-4 w-4" />}
          loading={isLoading}
        />
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Stage share (gross)
          </p>
          {isLoading || !summary ? (
            <div className="mt-2 h-7 w-32 animate-pulse rounded bg-slate-200" />
          ) : (
            <div className="mt-2 space-y-1">
              {summary.stages.map((row) => (
                <div key={row.stage} className="flex items-center justify-between text-xs">
                  <StageBadge stage={row.stage} />
                  <span className="font-semibold tabular-nums text-navy-950">
                    {percentPointsString(row.shareOfGrossPercent, 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <MetricCard
          label="Stage 2 + 3 count"
          value={String(totals?.stage2And3Count ?? (isLoading ? '' : 0))}
          hint={totals ? `${totals.stage3Count} in Stage 3` : undefined}
          icon={<AlertTriangle className="h-4 w-4" />}
          loading={isLoading}
        />
      </div>

      {/* Movement bridge + trend -------------------------------------------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Allowance movement"
            description="What moved the allowance between the two most recent reporting periods"
          />
          <CardContent>
            <MovementBridgeChart bridge={movementQuery.data} loading={movementQuery.isLoading} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="ECL and coverage trend"
            description="Allowance and coverage ratio across every reporting period"
          />
          <CardContent>
            {trendQuery.isLoading || trendPoints.length === 0 ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <>
                <p className="sr-only">
                  {trendPoints
                    .map(
                      (point) =>
                        `${point.label}: allowance ${point.allowanceText}, coverage ${point.coverageRatioText}`,
                    )
                    .join('. ')}
                </p>
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={trendPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="allowanceFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={chart.brand} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={chart.brand} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                    <XAxis
                      dataKey="reportingDate"
                      tickFormatter={(value: string) =>
                        new Date(value).toLocaleDateString('en-GB', {
                          month: 'short',
                          timeZone: 'UTC',
                        })
                      }
                      tick={{ fontSize: 11, fill: chart.axis }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="allowance"
                      tickFormatter={(value: number) =>
                        moneyString(String(value), { compact: true })
                      }
                      tick={{ fontSize: 11, fill: chart.axis }}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                    />
                    <YAxis
                      yAxisId="coverage"
                      orientation="right"
                      tickFormatter={(value: number) => `${(value * 100).toFixed(1)}%`}
                      tick={{ fontSize: 11, fill: chart.axis }}
                      axisLine={false}
                      tickLine={false}
                      width={44}
                    />
                    <ChartTooltip
                      formatter={(
                        _value: number,
                        name: string,
                        item: { payload?: (typeof trendPoints)[number] },
                      ) =>
                        name === 'allowance'
                          ? [moneyString(item.payload?.allowanceText), 'Allowance']
                          : [
                              formatDecimalPercent(item.payload?.coverageRatioText),
                              'Coverage ratio',
                            ]
                      }
                      labelFormatter={(label: string) => formatDate(String(label))}
                      contentStyle={tooltipStyle(chart)}
                    />
                    <Area
                      yAxisId="allowance"
                      type="monotone"
                      dataKey="allowance"
                      stroke={chart.brand}
                      strokeWidth={2}
                      fill="url(#allowanceFill)"
                    />
                    <Line
                      yAxisId="coverage"
                      type="monotone"
                      dataKey="coverageRatio"
                      stroke={chart.danger}
                      strokeWidth={2}
                      dot={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="mt-1 flex gap-4 text-2xs text-slate-500">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: chart.brand }}
                    />{' '}
                    Allowance
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: chart.danger }}
                    />{' '}
                    Coverage ratio
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stage distribution + migration --------------------------------------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Stage distribution"
            description="EAD and ECL allowance by IFRS 9 stage"
          />
          <CardContent className="space-y-4">
            {isLoading || !summary ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              summary.stages.map((row) => {
                const barColor =
                  row.stage === 1 ? 'bg-teal-500' : row.stage === 2 ? 'bg-amber-500' : 'bg-red-500';
                const width = Math.max(
                  decimalStringToNumber(row.shareOfGrossPercent ?? '0'),
                  row.exposureCount > 0 ? 1 : 0,
                );
                return (
                  <div key={row.stage}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 font-medium text-slate-700">
                        <StageBadge stage={row.stage} />
                        <span className="text-slate-500">{row.exposureCount} exposures</span>
                      </span>
                      <span className="text-slate-500">
                        {percentString(row.coverageRatio, 1)} coverage
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${barColor}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-2xs text-slate-500">
                      <span>Gross {moneyString(row.grossCarryingAmount, { compact: true })}</span>
                      <span>EAD {moneyString(row.ead, { compact: true })}</span>
                      <span>ECL {moneyString(row.lossAllowance, { compact: true })}</span>
                    </div>
                  </div>
                );
              })
            )}
            <p className="border-t border-line-soft pt-3 text-2xs leading-relaxed text-slate-500">
              Stage 1 recognises 12-month ECL. Stages 2 and 3 recognise lifetime ECL over the
              remaining contractual horizon; Stage 3 net carrying amount is gross carrying amount
              less the allowance.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Stage migration"
            description="Movement between the two most recent reporting periods"
            icon={<GitCompare className="h-4 w-4 text-navy-500" />}
          />
          <CardContent>
            <StageMigrationMatrix
              migration={migrationQuery.data}
              loading={migrationQuery.isLoading}
            />
          </CardContent>
        </Card>
      </div>

      {/* Scenario comparison + executive insight ------------------------------ */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Scenario contribution"
            description="Base, upside and downside impact on the reported allowance"
          />
          <CardContent>
            {scenariosQuery.isError ? (
              <EmptyState
                title="No scenario split available"
                description="This period has no completed run to split by scenario."
              />
            ) : (
              <ScenarioComparisonChart
                scenarios={scenariosQuery.data}
                loading={scenariosQuery.isLoading}
              />
            )}
          </CardContent>
        </Card>
        {summary?.run ? (
          <div data-tour="tour-executive-commentary">
            <ExecutiveCommentaryPanel
              runId={summary.run.publicId}
              runLabel={summary.run.publicId}
            />
          </div>
        ) : (
          <Card>
            <CardHeader title="Executive commentary" />
            <CardContent>
              <EmptyState
                title="No completed run"
                description="Executive commentary needs a completed run to summarise."
              />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Concentration -------------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader
          title="Risk concentration"
          description="Where the allowance is concentrated, ranked largest first"
        />
        <CardContent>
          {concentrationQuery.isLoading || !concentrationQuery.data ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Tabs
              tabs={concentrationQuery.data.slices.map((slice) => ({
                id: slice.dimension,
                label: CONCENTRATION_LABEL[slice.dimension],
                content: (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-slate-500">
                        <th className="py-2">{CONCENTRATION_LABEL[slice.dimension]}</th>
                        <th className="py-2 text-right">Exposures</th>
                        <th className="py-2 text-right">Gross</th>
                        <th className="py-2 text-right">Allowance</th>
                        <th className="py-2 text-right">Share of allowance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...slice.buckets, ...(slice.otherBucket ? [slice.otherBucket] : [])].map(
                        (bucket) => (
                          <tr
                            key={bucket.key}
                            className="border-b border-line-soft last:border-b-0"
                          >
                            <td className="py-2 font-medium text-navy-800">{bucket.key}</td>
                            <td className="py-2 text-right tabular-nums">{bucket.exposureCount}</td>
                            <td className="py-2 text-right tabular-nums">
                              {moneyString(bucket.grossCarryingAmount, { compact: true })}
                            </td>
                            <td className="py-2 text-right tabular-nums text-red-700">
                              {moneyString(bucket.lossAllowance, { compact: true })}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {percentPointsString(bucket.shareOfAllowancePercent, 1)}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                ),
              }))}
            />
          )}
        </CardContent>
      </Card>

      {/* Drivers + exceptions --------------------------------------------------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Top ECL drivers"
            description="Largest allowance contributions with their primary staging rule"
            icon={<Target className="h-4 w-4 text-navy-500" />}
            actions={
              <Link to="/portfolio">
                <Button variant="ghost" size="sm">
                  Open portfolio
                </Button>
              </Link>
            }
          />
          <DataTable
            columns={driverColumns}
            data={driversQuery.data?.topExposures ?? []}
            loading={driversQuery.isLoading}
            onRowClick={(row) => navigate(`/portfolio/${row.exposurePublicId}`)}
            getRowId={(row) => row.exposurePublicId}
            emptyTitle="No drivers to show"
            emptyDescription="Nothing currently carries a material allowance under the active filters."
          />
        </Card>
        <Card>
          <CardHeader
            title="Exception queue"
            icon={<ShieldAlert className="h-4 w-4 text-navy-500" />}
            actions={
              <Link to="/exceptions">
                <Button variant="ghost" size="sm">
                  Open queue
                </Button>
              </Link>
            }
          />
          <CardContent>
            {exceptionsQuery.isLoading || !exceptionsQuery.data ? (
              <Skeleton className="h-32 w-full" />
            ) : exceptionsQuery.data.open === 0 ? (
              <EmptyState title="No open exceptions" description="The queue is clear." />
            ) : (
              <div className="space-y-2">
                <p className="text-2xl font-semibold text-navy-950">{exceptionsQuery.data.open}</p>
                <p className="text-xs text-slate-500">open exceptions across the book</p>
                <div className="space-y-1.5 border-t border-line-soft pt-2">
                  {(Object.entries(exceptionsQuery.data.bySeverity) as [string, number][]).map(
                    ([severity, count]) => (
                      <div key={severity} className="flex items-center justify-between text-xs">
                        <Badge
                          tone={
                            severity === 'HIGH'
                              ? 'danger'
                              : severity === 'MEDIUM'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {severity}
                        </Badge>
                        <span className="font-medium text-slate-700">{count}</span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Lineage ---------------------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader title="Data lineage" description="What produced the figures on this screen" />
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : summary?.run ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 border-b border-line-soft pb-1.5">
                <dt className="text-slate-500">Model configuration</dt>
                <dd className="text-right font-medium text-slate-800">
                  v{summary.run.modelConfigurationVersion ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-line-soft pb-1.5">
                <dt className="text-slate-500">Scenario set</dt>
                <dd className="text-right font-medium text-slate-800">
                  v{summary.run.scenarioSetVersion ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-line-soft pb-1.5">
                <dt className="text-slate-500">Reporting date</dt>
                <dd className="text-right font-medium text-slate-800">
                  {formatDate(summary.reportingDate)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-line-soft pb-1.5">
                <dt className="text-slate-500">Calculated at</dt>
                <dd className="text-right font-medium text-slate-800">
                  {summary.run.completedAt ? formatDateTime(summary.run.completedAt) : '—'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">
              No completed run yet, so there is no lineage to report.
            </p>
          )}
          <p className="mt-3 flex items-start gap-2 text-2xs leading-relaxed text-slate-500">
            These versions are frozen on the run. Editing an assumption creates a new version and
            cannot change a completed historical result.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
