/**
 * Exposure drill-down (implementation tasks 10 and 11, acceptance criterion 2).
 *
 * Everything on this page is a decimal string that the engine persisted. The
 * period table is the point of the screen: a reviewer can expand any row and
 * read the engine's own formula trace, so the loss allowance can be replayed by
 * hand without trusting the UI to have re-derived it — and it never does.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Info,
  Scale,
  SearchX,
  UserCog,
} from 'lucide-react';
import type { AuditEventRecord, PeriodDto, ScenarioResultDto, Stage } from '@eclens/shared';
import {
  formatDate,
  formatDateTime,
  formatDecimalPercent,
  formatDecimalText,
  formatVersionedRef,
} from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { ExplainEclPanel } from '@/components/ai/ExplainEclPanel';
import { Badge, StageBadge, SyntheticBadge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { MetricCard } from '@/components/ui/MetricCard';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { LIFETIME_ECL_NOTE, TWELVE_MONTH_ECL_NOTE, stagingCodeLabel } from '@/lib/staging';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';

const auditColumn = createColumnHelper<AuditEventRecord>();

const REVIEWER_TONE: Record<string, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  REVIEWED: 'positive',
  REJECTED: 'danger',
};

const EXCEPTION_TONE: Record<string, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
};

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
    </div>
  );
}

function Numeric({ value }: { value: string | null | undefined }) {
  return <span className="tabular-nums">{formatDecimalText(value)}</span>;
}

/**
 * One scenario's period table. Periods run to the full horizon (up to 60), so the
 * first twelve are shown with the rest behind a toggle rather than a 60-row wall.
 */
function ScenarioPanel({
  scenario,
  periods,
  moneyString,
}: {
  scenario: Omit<ScenarioResultDto, 'periods'>;
  periods: PeriodDto[];
  moneyString: (value: string | null | undefined, options?: { compact?: boolean }) => string;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? periods : periods.slice(0, 12);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {scenario.scenarioName}
            <Badge tone="neutral">weight {formatDecimalPercent(scenario.weight, 2)}</Badge>
          </span>
        }
        description={`${scenario.scenarioCode} · PD multiplier ${formatDecimalText(scenario.pdMultiplier)} · LGD multiplier ${formatDecimalText(scenario.lgdMultiplier)} · horizon ${scenario.horizonMonths} months`}
      />
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Fact
            label="Cumulative PD in horizon"
            value={<Numeric value={scenario.cumulativePdInHorizon} />}
          />
          <Fact
            label="Scenario ECL (unweighted)"
            value={<Numeric value={scenario.unweightedEcl} />}
          />
          <Fact label="Weight applied" value={<Numeric value={scenario.weight} />} />
          <Fact
            label="Weighted contribution"
            value={
              <span className="font-medium text-red-700">
                <Numeric value={scenario.weightedEcl} />
              </span>
            }
          />
        </div>

        {periods.length === 0 ? (
          <EmptyState
            title="No calculation periods"
            description="The engine produced no periods for this scenario."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="w-8 px-2 py-1.5" aria-label="Expand period" />
                  <th className="px-2 py-1.5">Period</th>
                  <th className="px-2 py-1.5">Window</th>
                  <th className="px-2 py-1.5 text-right">Marginal PD</th>
                  <th className="px-2 py-1.5 text-right">Cumulative PD</th>
                  <th className="px-2 py-1.5 text-right">LGD</th>
                  <th className="px-2 py-1.5 text-right">EAD</th>
                  <th className="px-2 py-1.5 text-right">Discount factor</th>
                  <th className="px-2 py-1.5 text-right">Expected loss</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((period) => {
                  const isOpen = expanded === period.period;
                  return (
                    <Fragment key={period.period}>
                      <tr
                        className="cursor-pointer border-b border-line-soft transition-colors hover:bg-navy-50/40"
                        onClick={() => setExpanded(isOpen ? null : period.period)}
                        aria-expanded={isOpen}
                      >
                        <td className="px-2 py-1.5 text-slate-400">
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-medium tabular-nums text-navy-800">
                          {period.period}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                          {formatDate(period.periodStart)} – {formatDate(period.periodEnd)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatDecimalText(period.marginalPd)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                          {formatDecimalText(period.cumulativePd)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatDecimalText(period.lgd)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {moneyString(period.ead)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatDecimalText(period.discountFactor)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums text-red-700">
                          {moneyString(period.expectedLoss)}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="border-b border-line-soft bg-surface-2/70">
                          <td colSpan={9} className="px-3 py-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                              Formula trace · {period.monthsFromReportingDate} month(s) from the
                              reporting date
                            </p>
                            <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-navy-900">
                              {period.formulaTrace}
                            </code>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {periods.length > 12 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll((current) => !current)}>
            {showAll ? `Show first 12 of ${periods.length}` : `Show all ${periods.length} periods`}
          </Button>
        ) : null}

        <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Each period expected loss is marginal PD × LGD × EAD × discount factor at 40-digit
          precision, rounded once to 2 decimals. The scenario ECL is the exact sum of the rounded
          periods shown above, so this table always adds to the scenario total on screen.
        </p>
      </CardContent>
    </Card>
  );
}

export function ExposureDetailPage() {
  const { exposureId } = useParams<{ exposureId: string }>();
  const { moneyString, percentString, currency } = useSettings();
  const { can } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [stageAfter, setStageAfter] = useState<Stage>(2);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['exposure', exposureId],
    queryFn: () => api.portfolio.getExposure(exposureId ?? ''),
    enabled: Boolean(exposureId),
  });

  const latestRunId = data?.exposure.latestRunId ?? null;

  // Periods live on the run result, not on the exposure, so this is a second
  // round trip — and it is skipped entirely when the exposure has never been run.
  const { data: detail } = useQuery({
    queryKey: ['run-result-detail', latestRunId, exposureId],
    queryFn: () => api.runs.resultDetail(latestRunId as string, exposureId ?? ''),
    enabled: Boolean(latestRunId && exposureId),
  });

  const canOverride = can('exposure:override');
  const canUseAi = can('ai:use');

  const overrideMutation = useMutation({
    mutationFn: () =>
      api.overrides.request(exposureId ?? '', { stageAfter, reason: reason.trim() }),
    onSuccess: (override) => {
      push(
        'success',
        'Override requested',
        `Stage ${override.stageBefore} → ${override.stageAfter} is live and awaiting review.`,
      );
      setOverrideOpen(false);
      setReason('');
      setReasonError(null);
      void queryClient.invalidateQueries({ queryKey: ['exposure', exposureId] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio-exposures'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['stage-overrides'] });
      void queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    },
    onError: (error) => {
      // A 400 here is the 10-character reason minimum; anything else is a real refusal.
      if (error instanceof ApiError) {
        const fields = error.fieldMessages();
        const firstFieldError = Object.values(fields)[0];
        setReasonError(firstFieldError ?? null);
        push('error', 'Override rejected', firstFieldError ?? error.message);
        return;
      }
      push('error', 'Override failed', 'The stage override could not be recorded.');
    },
  });

  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!data) {
    return (
      <Card>
        <EmptyState
          icon={<SearchX className="h-8 w-8" />}
          title={`Exposure ${exposureId ?? ''} not found`}
          description="It may belong to another organization or have been superseded by a newer import. Return to the portfolio to pick another exposure."
          action={
            <Link to="/portfolio">
              <Button size="sm">Back to portfolio</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const {
    exposure,
    staging,
    latestResult,
    eadSchedule,
    pdTermStructure,
    overrideHistory,
    exceptions,
    lineage,
    auditTrail,
  } = data;
  const resultLineage = latestResult?.lineage ?? lineage;
  const scenarioPeriods = detail?.scenarioPeriods ?? [];
  const horizonNote = staging.stage === 1 ? TWELVE_MONTH_ECL_NOTE : LIFETIME_ECL_NOTE;

  const inputsTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Source inputs"
          description={`Snapshot ${exposure.snapshotLabel} · input version ${exposure.inputVersion} · reporting date ${formatDate(exposure.reportingDate)}`}
        />
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-4">
            <Fact label="Exposure ID" value={exposure.publicId} />
            <Fact label="Borrower ID" value={exposure.borrowerId} />
            <Fact label="Segment" value={exposure.segment} />
            <Fact label="Product" value={exposure.productType} />
            <Fact label="Region" value={exposure.region || '—'} />
            <Fact label="Industry" value={exposure.industry || '—'} />
            <Fact label="Currency" value={exposure.currency} />
            <Fact label="Origination" value={formatDate(exposure.originationDate)} />
            <Fact label="Maturity" value={formatDate(exposure.maturityDate)} />
            <Fact
              label="Days past due"
              value={<span className="tabular-nums">{exposure.daysPastDue}</span>}
            />
            <Fact
              label="Gross carrying amount"
              value={<Numeric value={exposure.grossCarryingAmount} />}
            />
            <Fact
              label="Undrawn commitment"
              value={<Numeric value={exposure.undrawnCommitment} />}
            />
            <Fact
              label="Credit conversion factor"
              value={<Numeric value={exposure.creditConversionFactor} />}
            />
            <Fact
              label="Effective interest rate"
              value={
                <span className="tabular-nums">
                  {percentString(exposure.effectiveInterestRate, 3)}
                </span>
              }
            />
            <Fact
              label="12-month PD"
              value={
                <span className="tabular-nums">{percentString(exposure.twelveMonthPd, 3)}</span>
              }
            />
            <Fact
              label="Lifetime PD"
              value={<span className="tabular-nums">{percentString(exposure.lifetimePd, 3)}</span>}
            />
            <Fact
              label="PD at origination"
              value={
                <span className="tabular-nums">{percentString(exposure.pdAtOrigination, 3)}</span>
              }
            />
            <Fact
              label="LGD"
              value={<span className="tabular-nums">{percentString(exposure.lgd, 1)}</span>}
            />
            <Fact label="Collateral value" value={<Numeric value={exposure.collateralValue} />} />
            <Fact label="Original rating" value={exposure.originalCreditRating} />
            <Fact label="Current rating" value={exposure.currentCreditRating} />
            <Fact
              label="Risk flags"
              value={
                <span className="flex flex-wrap gap-1">
                  {exposure.defaultFlag ? <Badge tone="danger">Default</Badge> : null}
                  {exposure.creditImpairedFlag ? (
                    <Badge tone="danger">Credit-impaired</Badge>
                  ) : null}
                  {exposure.forbearanceFlag ? <Badge tone="warning">Forbearance</Badge> : null}
                  {exposure.restructuringFlag ? <Badge tone="warning">Restructured</Badge> : null}
                  {exposure.watchlistFlag ? <Badge tone="warning">Watchlist</Badge> : null}
                  {!exposure.defaultFlag &&
                  !exposure.creditImpairedFlag &&
                  !exposure.forbearanceFlag &&
                  !exposure.restructuringFlag &&
                  !exposure.watchlistFlag ? (
                    <span className="text-xs text-slate-400">None</span>
                  ) : null}
                </span>
              }
            />
            <Fact
              label="Simplified EAD profile"
              value={exposure.simplifiedEadProfile.replace(/_/g, ' ').toLowerCase()}
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="EAD schedule"
          description={
            exposure.hasContractualSchedule
              ? 'Contractual amortization schedule — the engine uses these period EADs directly.'
              : 'No contractual schedule was supplied; the engine builds a clearly labeled simplified balance profile instead.'
          }
        />
        {eadSchedule.length === 0 ? (
          <CardContent>
            <EmptyState
              title="No schedule rows"
              description="EAD is held flat at the reporting-date balance for every period."
            />
          </CardContent>
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Period</th>
                  <th className="px-3 py-2 text-right">Drawn balance</th>
                  <th className="px-3 py-2 text-right">Undrawn</th>
                  <th className="px-3 py-2 text-right">CCF</th>
                  <th className="px-3 py-2 text-right">EAD</th>
                </tr>
              </thead>
              <tbody>
                {eadSchedule.map((point) => (
                  <tr key={point.period} className="border-b border-line-soft last:border-b-0">
                    <td className="px-3 py-1.5 font-medium tabular-nums text-navy-800">
                      {point.period}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {moneyString(point.drawnBalance)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                      {moneyString(point.undrawnCommitment)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatDecimalText(point.creditConversionFactor)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                      {moneyString(point.ead)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="PD term structure"
          description={
            pdTermStructure
              ? `Supplied on a ${pdTermStructure.basis.toLowerCase()} basis and converted to non-overlapping marginal probabilities by survival logic.`
              : 'None supplied — the engine derives marginals from the 12-month and lifetime PD anchors.'
          }
        />
        {pdTermStructure ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Period</th>
                  <th className="px-3 py-2 text-right">
                    Supplied PD ({pdTermStructure.basis.toLowerCase()})
                  </th>
                </tr>
              </thead>
              <tbody>
                {pdTermStructure.points.map((point) => (
                  <tr key={point.period} className="border-b border-line-soft last:border-b-0">
                    <td className="px-3 py-1.5 font-medium tabular-nums text-navy-800">
                      {point.period}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatDecimalText(point.pd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CardContent>
            <p className="text-xs leading-relaxed text-slate-500">
              Marginals are built in two blocks from the anchors above: periods 1–12 from the
              12-month PD and the remainder of the horizon from the lifetime PD. Survival logic
              guarantees the cumulative default probability can never exceed 1.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );

  const stagingTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Staging decision"
          description={`Rule set ${staging.ruleSetId} v${staging.ruleSetVersion} · primary code ${staging.primaryRuleCode}`}
          actions={
            canOverride ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<UserCog className="h-3.5 w-3.5" />}
                onClick={() => setOverrideOpen(true)}
              >
                Request override
              </Button>
            ) : null
          }
        />
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <StageBadge stage={staging.stage} />
            {staging.hasOverride ? <Badge tone="info">Analyst override in force</Badge> : null}
            <span className="text-xs text-slate-500">
              Model stage without any override:{' '}
              <strong className="font-semibold text-navy-900">Stage {staging.modelStage}</strong>
            </span>
          </div>
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed text-slate-700">
            {staging.primaryReason}
          </p>
          <p className="rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-2 text-2xs leading-relaxed text-navy-800">
            {horizonNote}
          </p>

          <div>
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">
              Every rule that fired ({staging.triggeredRules.length})
            </p>
            {staging.triggeredRules.length === 0 ? (
              <p className="text-xs text-slate-500">
                No Stage 2 or Stage 3 condition applied, so the exposure sits in Stage 1.
              </p>
            ) : (
              <ul className="space-y-2">
                {staging.triggeredRules.map((rule) => (
                  <li key={rule.code} className="rounded-lg border border-line px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StageBadge stage={rule.stage} />
                      <code className="font-mono text-2xs font-semibold text-navy-800">
                        {rule.code}
                      </code>
                      <span className="text-xs text-slate-500">{stagingCodeLabel(rule.code)}</span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-700">{rule.reason}</p>
                    <p className="mt-1.5 text-2xs text-slate-500">
                      Source fields{' '}
                      <span className="font-mono">{rule.sourceFields.join(', ')}</span> · observed{' '}
                      <span className="font-mono">{rule.observedValue}</span> · configured threshold{' '}
                      <span className="font-mono">{rule.configuredThreshold}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {staging.override ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-wider text-amber-800">
                Override on this decision
              </p>
              <p className="mt-1 text-xs leading-relaxed text-amber-900">
                Stage {staging.override.stageBefore} → {staging.override.stageAfter} by{' '}
                {staging.override.actorName} at {formatDateTime(staging.override.occurredAt)}.
                Reason: {staging.override.reason}
              </p>
              <p className="mt-1 text-2xs text-amber-800">
                Reviewer status {staging.override.reviewerStatus}
                {staging.override.reviewerName ? ` · ${staging.override.reviewerName}` : ''}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {latestResult ? (
        <Card>
          <CardHeader
            title="Horizon applied to the calculation"
            description="How the engine turned the stage into a number of monthly periods"
          />
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
              <Fact label="Stage used" value={<StageBadge stage={latestResult.stage} />} />
              <Fact
                label="Remaining contractual months"
                value={
                  <span className="tabular-nums">{latestResult.remainingContractualMonths}</span>
                }
              />
              <Fact
                label="Horizon months"
                value={<span className="tabular-nums">{latestResult.horizonMonths}</span>}
              />
              <Fact
                label="Discount convention"
                value={latestResult.discountConvention.replace(/_/g, ' ').toLowerCase()}
              />
            </dl>
            <p className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-slate-600">
              {latestResult.horizonBasisNote}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );

  const calculationTab = latestResult ? (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="EAD at reporting date"
          value={moneyString(latestResult.eadAtReportingDate, { compact: true })}
          hint={latestResult.eadProfileLabel}
        />
        <MetricCard
          label="Lifetime PD at reporting date"
          value={percentString(latestResult.lifetimePdAtReportingDate, 3)}
          hint={`PD source ${latestResult.pdSourceKind.toLowerCase()}`}
        />
        <MetricCard
          label="Loss allowance"
          value={moneyString(latestResult.lossAllowance)}
          hint={`Coverage of gross ${percentString(latestResult.coverageRatio, 2)}`}
        />
        <MetricCard
          label="Net carrying amount"
          value={moneyString(latestResult.netCarryingAmount)}
          hint="Gross carrying amount less loss allowance"
        />
      </div>

      <Card>
        <CardHeader
          title="Scenario-weighted result"
          description={`Run ${latestResult.runId} · effective interest rate ${percentString(latestResult.effectiveInterestRate, 3)} · discounted on a ${latestResult.discountConvention.replace(/_/g, ' ').toLowerCase()} basis`}
        />
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3">Scenario</th>
                <th className="py-2 pr-3 text-right">Weight</th>
                <th className="py-2 pr-3 text-right">Cumulative PD</th>
                <th className="py-2 pr-3 text-right">Scenario ECL</th>
                <th className="py-2 text-right">Weighted contribution</th>
              </tr>
            </thead>
            <tbody>
              {latestResult.scenarioResults.map((scenario) => (
                <tr
                  key={scenario.scenarioCode}
                  className="border-b border-line-soft last:border-b-0"
                >
                  <td className="py-2 pr-3">
                    <p className="font-medium text-slate-800">{scenario.scenarioName}</p>
                    <p className="text-2xs text-slate-500">{scenario.scenarioCode}</p>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                    {formatDecimalText(scenario.weight)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                    {formatDecimalText(scenario.cumulativePdInHorizon)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-700">
                    {moneyString(scenario.unweightedEcl)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium text-slate-800">
                    {moneyString(scenario.weightedEcl)}
                  </td>
                </tr>
              ))}
              <tr>
                <td
                  colSpan={4}
                  className="pt-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Loss allowance (exact sum of the weighted contributions)
                </td>
                <td className="pt-3 text-right text-base font-semibold tabular-nums text-red-700">
                  {moneyString(latestResult.lossAllowance)}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Fact
              label="Coverage of gross carrying amount"
              value={
                <span className="tabular-nums">{percentString(latestResult.coverageRatio, 4)}</span>
              }
            />
            <Fact
              label="Coverage of EAD"
              value={
                <span className="tabular-nums">{percentString(latestResult.coverageOfEad, 4)}</span>
              }
            />
            <Fact
              label="Horizon"
              value={<span className="tabular-nums">{latestResult.horizonMonths} month(s)</span>}
            />
          </div>
        </CardContent>
      </Card>

      {scenarioPeriods.length > 0 ? (
        scenarioPeriods.map((entry) => (
          <ScenarioPanel
            key={entry.scenario.scenarioCode}
            scenario={entry.scenario}
            periods={entry.periods}
            moneyString={moneyString}
          />
        ))
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              title="Period detail unavailable"
              description="The run result summary loaded but its calculation periods did not. Reload the page to fetch them again."
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Reload
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Educational approximation — not the reported allowance"
          description={latestResult.educationalApproximation.label}
        />
        <CardContent className="space-y-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-2xs leading-relaxed text-amber-900">
            The single-period PD × LGD × EAD shortcut is shown only to explain why the lifetime
            calculation differs. The authoritative allowance is the scenario-weighted sum of the
            period table above.
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-5">
            <Fact
              label="Lump PD"
              value={<Numeric value={latestResult.educationalApproximation.lumpPd} />}
            />
            <Fact
              label="LGD"
              value={<Numeric value={latestResult.educationalApproximation.lgd} />}
            />
            <Fact
              label="EAD"
              value={<Numeric value={latestResult.educationalApproximation.eadAtReportingDate} />}
            />
            <Fact
              label="Discount factor"
              value={<Numeric value={latestResult.educationalApproximation.discountFactor} />}
            />
            <Fact
              label="Approximation"
              value={<Numeric value={latestResult.educationalApproximation.value} />}
            />
          </dl>
          <code className="block whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-3 py-2 font-mono text-2xs leading-relaxed text-navy-900">
            {latestResult.educationalApproximation.formulaTrace}
          </code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="How this number was produced"
          description="The engine's own plain-language audit trail"
        />
        <CardContent>
          <ol className="space-y-2.5">
            {latestResult.explanation.map((step, index) => (
              <li key={step} className="flex gap-2.5 text-xs leading-relaxed text-slate-600">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-navy-50 text-[10px] font-semibold text-navy-700">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  ) : (
    <Card>
      <CardContent>
        <EmptyState
          icon={<Scale className="h-8 w-8" />}
          title="This exposure has not been calculated yet"
          description="Run the ECL engine over its snapshot to produce period-level results."
          action={
            <Link to="/ecl-runs">
              <Button size="sm">Go to ECL runs</Button>
            </Link>
          }
        />
      </CardContent>
    </Card>
  );

  const historyTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Override history"
          description="Every override carries a reason, before and after stage, actor, timestamp and reviewer status."
        />
        {overrideHistory.length === 0 ? (
          <CardContent>
            <EmptyState
              title="No overrides"
              description="The stage shown is the model's own decision."
            />
          </CardContent>
        ) : (
          <CardContent className="space-y-2">
            {overrideHistory.map((override) => (
              <div key={override.id} className="rounded-lg border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StageBadge stage={override.stageBefore} />
                  <span className="text-slate-400">→</span>
                  <StageBadge stage={override.stageAfter} />
                  <Badge tone={REVIEWER_TONE[override.reviewerStatus] ?? 'neutral'}>
                    {override.reviewerStatus.replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-2xs text-slate-500">
                    {override.actorName} ({override.actorRole.replace(/_/g, ' ')}) ·{' '}
                    {formatDateTime(override.occurredAt)}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-700">{override.reason}</p>
                {override.reviewerName ? (
                  <p className="mt-1 text-2xs text-slate-500">
                    Reviewed by {override.reviewerName}
                    {override.reviewedAt ? ` at ${formatDateTime(override.reviewedAt)}` : ''}
                    {override.reviewComment ? ` · “${override.reviewComment}”` : ''}
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Exceptions raised on this exposure"
          description="Items in the exception queue that name this exposure"
        />
        {exceptions.length === 0 ? (
          <CardContent>
            <EmptyState
              title="No exceptions"
              description="Nothing in the queue references this exposure."
            />
          </CardContent>
        ) : (
          <CardContent className="space-y-2">
            {exceptions.map((item) => (
              <div key={item.id} className="rounded-lg border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={EXCEPTION_TONE[item.severity] ?? 'neutral'}>{item.severity}</Badge>
                  <Badge tone="neutral">{item.kind.replace(/_/g, ' ')}</Badge>
                  <Badge
                    tone={
                      item.status === 'OPEN'
                        ? 'danger'
                        : item.status === 'RESOLVED'
                          ? 'positive'
                          : 'warning'
                    }
                  >
                    {item.status}
                  </Badge>
                  <span className="text-2xs text-slate-500">{formatDateTime(item.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-xs font-medium text-slate-800">{item.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{item.detail}</p>
                {item.metric ? (
                  <p className="mt-1 font-mono text-2xs text-slate-500">{item.metric}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Audit trail"
          description="Append-only events recorded against this exposure"
        />
        <DataTable
          columns={[
            auditColumn.accessor('occurredAt', {
              header: 'When',
              cell: (info) => (
                <span className="whitespace-nowrap">{formatDateTime(info.getValue())}</span>
              ),
            }),
            auditColumn.accessor('action', {
              header: 'Action',
              cell: (info) => <code className="font-mono text-2xs">{info.getValue()}</code>,
            }),
            auditColumn.accessor('userName', {
              header: 'Actor',
              cell: (info) => (
                <span>
                  {info.getValue()}
                  <span className="ml-1 text-2xs text-slate-400">{info.row.original.role}</span>
                </span>
              ),
            }),
            auditColumn.accessor('detail', { header: 'Detail', enableSorting: false }),
          ]}
          data={auditTrail}
          getRowId={(row) => row.id}
          maxHeightClass="max-h-96 overflow-y-auto"
          emptyTitle="No audit events"
          emptyDescription="Nothing has been recorded against this exposure yet."
        />
      </Card>
    </div>
  );

  const lineageTab = (
    <Card>
      <CardHeader
        title="Data lineage and model versions"
        description="Working rule 6: every output names the input version, model configuration version, reporting date, scenario set, timestamp and actor."
      />
      <CardContent className="space-y-4">
        {resultLineage ? (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-4">
              <Fact
                label="Input version"
                value={<code className="font-mono text-xs">{resultLineage.inputVersion}</code>}
              />
              <Fact label="Reporting date" value={formatDate(resultLineage.reportingDate)} />
              <Fact label="Calculated at" value={formatDateTime(resultLineage.calculatedAt)} />
              <Fact label="Actor" value={`${resultLineage.actorName} (${resultLineage.actorId})`} />
              <Fact
                label="Model configuration"
                value={
                  <span>
                    {formatVersionedRef(
                      resultLineage.modelConfigurationName,
                      resultLineage.modelConfigurationId,
                      resultLineage.modelConfigurationVersion,
                    )}
                    {resultLineage.modelConfigurationName ? (
                      <code className="mt-0.5 block font-mono text-[10px] text-slate-400">
                        {resultLineage.modelConfigurationId}
                      </code>
                    ) : null}
                  </span>
                }
              />
              <Fact
                label="Staging rule set"
                value={
                  <code className="font-mono text-xs">
                    {resultLineage.stagingRuleSetId} v{resultLineage.stagingRuleSetVersion}
                  </code>
                }
              />
              <Fact
                label="Scenario set"
                value={
                  <span>
                    {formatVersionedRef(
                      resultLineage.scenarioSetName,
                      resultLineage.scenarioSetId,
                      resultLineage.scenarioSetVersion,
                    )}
                    {resultLineage.scenarioSetName ? (
                      <code className="mt-0.5 block font-mono text-[10px] text-slate-400">
                        {resultLineage.scenarioSetId}
                      </code>
                    ) : null}
                  </span>
                }
              />
              <Fact
                label="Run"
                value={
                  latestResult ? (
                    <Link
                      to={`/ecl-runs/${latestResult.runId}`}
                      className="text-navy-700 underline"
                    >
                      {latestResult.runId}
                    </Link>
                  ) : (
                    '—'
                  )
                }
              />
            </dl>
            <div className="flex items-start gap-2 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-2 text-2xs leading-relaxed text-navy-800">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              These versions are frozen on the run. Editing an assumption creates a new version and
              cannot change this historical result.
            </div>
            <div>
              <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Rounding policy
              </p>
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-slate-600">
                {resultLineage.roundingPolicy}
              </p>
            </div>
          </>
        ) : (
          <EmptyState
            title="No lineage recorded"
            description="This exposure has not been through a run, so there is no frozen model version to show."
          />
        )}
      </CardContent>
    </Card>
  );

  const tabs: TabItem[] = [
    { id: 'calculation', label: 'Calculation', content: calculationTab },
    { id: 'inputs', label: 'Inputs & schedules', content: inputsTab },
    { id: 'staging', label: 'Staging', content: stagingTab },
    { id: 'history', label: 'Overrides & audit', content: historyTab },
    { id: 'lineage', label: 'Lineage', content: lineageTab },
  ];

  return (
    <div>
      <Link
        to="/portfolio"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-navy-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to portfolio
      </Link>

      <PageHeader
        title={exposure.borrowerName}
        description={`${exposure.publicId} · ${exposure.segment} · ${exposure.productType} · ${exposure.region || 'region not stated'}`}
        tags={
          <>
            <StageBadge stage={staging.stage} />
            {staging.hasOverride ? <Badge tone="info">Override</Badge> : null}
            {exposure.defaultFlag ? <Badge tone="danger">Default</Badge> : null}
            {exposure.creditImpairedFlag ? <Badge tone="danger">Credit-impaired</Badge> : null}
            {exposure.forbearanceFlag ? <Badge tone="warning">Forbearance</Badge> : null}
            {exposure.watchlistFlag ? <Badge tone="warning">Watchlist</Badge> : null}
            <SyntheticBadge />
          </>
        }
        actions={
          canOverride ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<UserCog className="h-3.5 w-3.5" />}
              onClick={() => setOverrideOpen(true)}
            >
              Request stage override
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Gross carrying amount"
          value={moneyString(exposure.grossCarryingAmount, { compact: true })}
          hint={`${currency} · ${exposure.daysPastDue} day(s) past due`}
        />
        <MetricCard
          label="Loss allowance"
          value={
            latestResult ? moneyString(latestResult.lossAllowance, { compact: true }) : 'Not run'
          }
          hint={
            latestResult ? `Run ${latestResult.runId}` : 'Execute a run to produce an allowance'
          }
        />
        <MetricCard
          label="Net carrying amount"
          value={
            latestResult ? moneyString(latestResult.netCarryingAmount, { compact: true }) : '—'
          }
          hint="Gross less loss allowance"
        />
        <MetricCard
          label="Coverage ratio"
          value={latestResult ? percentString(latestResult.coverageRatio, 3) : '—'}
          hint={latestResult ? `of EAD ${percentString(latestResult.coverageOfEad, 3)}` : undefined}
        />
      </div>

      {/*
        Outside the tabs, not inside them. `Tabs` unmounts the panel it is not
        showing, so an explanation filed as a sixth tab would be discarded the
        moment the reviewer clicked over to the trace it cites and had to be
        requested again on the way back.
      */}
      {canUseAi && exposureId ? (
        <div className="mb-4">
          <ExplainEclPanel
            exposureId={exposureId}
            runId={latestRunId ?? undefined}
            subjectLabel={exposure.publicId}
          />
        </div>
      ) : null}

      <Card className="p-0">
        <div className="px-4 pt-2">
          <Tabs tabs={tabs} defaultTab="calculation" />
        </div>
      </Card>

      <Modal
        open={overrideOpen}
        onClose={() => setOverrideOpen(false)}
        title="Request a stage override"
        description="A reason of at least 10 characters is required — it is written to the immutable audit trail."
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOverrideOpen(false)}
              disabled={overrideMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              loading={overrideMutation.isPending}
              disabled={reason.trim().length < 10 || stageAfter === staging.stage}
              onClick={() => overrideMutation.mutate()}
            >
              Submit override
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span>Current stage</span>
            <StageBadge stage={staging.stage} />
            <span className="text-slate-400">→</span>
            <StageBadge stage={stageAfter} />
          </div>
          <Select
            label="Override to stage"
            value={String(stageAfter)}
            onChange={(event) => setStageAfter(Number(event.target.value) as Stage)}
            hint="The model's own decision is preserved alongside the override, so the two can always be compared."
          >
            <option value={1}>Stage 1 — 12-month ECL</option>
            <option value={2}>Stage 2 — lifetime ECL</option>
            <option value={3}>Stage 3 — credit-impaired</option>
          </Select>
          <div className="space-y-1.5">
            <label htmlFor="override-reason" className="block text-xs font-medium text-slate-700">
              Reason
            </label>
            <textarea
              id="override-reason"
              rows={4}
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(null);
              }}
              placeholder="Explain the judgement behind this override…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500"
            />
            {reasonError ? (
              <p className="text-xs text-red-600" role="alert">
                {reasonError}
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                {reason.trim().length}/2000 characters, minimum 10.
              </p>
            )}
          </div>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-2xs leading-relaxed text-amber-900">
            The override takes effect immediately and stays live until a second person reviews it.
            You will not be able to review your own request.
          </p>
        </div>
      </Modal>
    </div>
  );
}
