/**
 * The period-level drill-down for one exposure inside one run.
 *
 * This is the far end of acceptance criterion 2: from a portfolio total, down a
 * result row, to the marginal PD, LGD, EAD, discount factor, scenario weight and
 * the engine's own formula trace for a single month. Every figure is a decimal
 * string exactly as it was persisted — nothing here is re-derived, so a reviewer
 * can replay the arithmetic by hand and get the number on screen.
 */
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';
import type { PeriodDto } from '@eclens/shared';
import {
  formatDate,
  formatDateTime,
  formatDecimalPercent,
  formatDecimalText,
  formatVersionedRef,
} from '@eclens/shared';
import { api } from '@/api/client';
import { ExplainEclPanel } from '@/components/ai/ExplainEclPanel';
import { Badge, StageBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-xs tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}

/** The engine renders digits verbatim, trailing zeros included, so a trace can be replayed exactly. */
function Numeric({ value }: { value: string }) {
  return <span className="font-mono text-[11px]">{formatDecimalText(value)}</span>;
}

function PeriodTable({ periods, scenarioCode }: { periods: PeriodDto[]; scenarioCode: string }) {
  const { moneyString } = useSettings();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Stage 2 and 3 horizons run to 60 months; rendering all of them at once makes
  // the first period — the one a reviewer checks first — hard to reach.
  const visible = showAll ? periods : periods.slice(0, 12);

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">Calculation periods for scenario {scenarioCode}</caption>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
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
                  className="cursor-pointer border-b border-slate-100 transition-colors hover:bg-navy-50/40"
                  onClick={() => setExpanded(isOpen ? null : period.period)}
                  aria-expanded={isOpen}
                >
                  <td className="px-2 py-1.5 text-slate-400">
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </td>
                  <td className="px-2 py-1.5 font-medium tabular-nums text-navy-800">{period.period}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                    {formatDate(period.periodStart)} – {formatDate(period.periodEnd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatDecimalText(period.marginalPd)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                    {formatDecimalText(period.cumulativePd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatDecimalText(period.lgd)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{moneyString(period.ead)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatDecimalText(period.discountFactor)}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums text-red-700">
                    {moneyString(period.expectedLoss)}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="border-b border-slate-100 bg-slate-50/70">
                    <td colSpan={9} className="px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Formula trace · {period.monthsFromReportingDate} month(s) from the reporting date
                      </p>
                      <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-navy-900">
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
      {periods.length > 12 ? (
        <div className="border-t border-slate-100 px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAll((current) => !current)}>
            {showAll ? 'Show first 12 periods' : `Show all ${periods.length} periods`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function RunResultDrawer({
  runId,
  exposurePublicId,
  onClose,
}: {
  runId: string;
  exposurePublicId: string | null;
  onClose: () => void;
}) {
  const { moneyString, percentString } = useSettings();
  const { can } = useAuth();
  const canUseAi = can('ai:use');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['run-result-detail', runId, exposurePublicId],
    queryFn: () => api.runs.resultDetail(runId, exposurePublicId ?? ''),
    enabled: exposurePublicId !== null,
  });

  const result = data?.result;

  return (
    <Drawer
      open={exposurePublicId !== null}
      onClose={onClose}
      title={result ? `${result.borrowerName}` : 'Exposure result'}
      description={
        result
          ? `${result.exposurePublicId} · ${result.segment} · run ${runId}`
          : 'Period-level calculation detail for one exposure in this run'
      }
      footer={
        result ? (
          <Link to={`/portfolio/${result.exposurePublicId}`}>
            <Button size="sm" variant="secondary" icon={<ExternalLink className="h-3.5 w-3.5" />}>
              Open the full exposure record
            </Button>
          </Link>
        ) : undefined
      }
    >
      {isError ? (
        <ErrorState title="The result could not be loaded" onRetry={() => void refetch()} />
      ) : isLoading || !result || !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={result.stage} />
            <Badge tone="neutral">{result.staging.primaryRuleCode}</Badge>
            {result.staging.hasOverride ? <Badge tone="warning">analyst override</Badge> : null}
            <span className="font-medium tabular-nums text-red-700">{moneyString(result.lossAllowance)}</span>
            <span className="text-xs text-slate-500">
              coverage {percentString(result.coverageRatio)} of gross ·{' '}
              {percentString(result.coverageOfEad)} of EAD
            </span>
          </div>

          <p className="rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-[11px] leading-relaxed text-navy-800">
            {result.horizonBasisNote}
          </p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 sm:grid-cols-4">
            <Fact label="Remaining contractual months" value={result.remainingContractualMonths} />
            <Fact label="Horizon used" value={`${result.horizonMonths} month(s)`} />
            <Fact label="Gross carrying amount" value={moneyString(result.grossCarryingAmount)} />
            <Fact label="Net carrying amount" value={moneyString(result.netCarryingAmount)} />
            <Fact label="EAD at reporting date" value={moneyString(result.eadAtReportingDate)} />
            <Fact label="EAD profile" value={result.eadProfileLabel} />
            <Fact label="PD source" value={result.pdSourceKind} />
            <Fact
              label="Lifetime PD at reporting date"
              value={<Numeric value={result.lifetimePdAtReportingDate} />}
            />
            <Fact
              label="Effective interest rate"
              value={`${formatDecimalPercent(result.effectiveInterestRate, 4)} · ${result.discountConvention}`}
            />
            <Fact label="Loss allowance" value={moneyString(result.lossAllowance)} />
            <Fact label="Calculated at" value={formatDateTime(result.lineage.calculatedAt)} />
            <Fact label="By" value={result.lineage.actorName} />
          </dl>

          <Tabs
            tabs={[
              {
                id: 'scenarios',
                label: 'Scenario contributions',
                content: (
                  <div className="overflow-x-auto rounded-md border border-slate-200">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-2.5 py-1.5 font-medium">Scenario</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Weight</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">PD ×</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">LGD ×</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Horizon</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Cumulative PD</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">ECL</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Weighted</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {data.scenarioPeriods.map((entry) => (
                          <tr key={entry.scenario.scenarioCode}>
                            <td className="px-2.5 py-1.5">
                              <span className="font-medium text-navy-800">{entry.scenario.scenarioName}</span>
                              <span className="ml-1.5 text-[10px] text-slate-400">
                                {entry.scenario.scenarioCode}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {formatDecimalPercent(entry.scenario.weight, 2)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">
                              {formatDecimalText(entry.scenario.pdMultiplier)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">
                              {formatDecimalText(entry.scenario.lgdMultiplier)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">
                              {entry.scenario.horizonMonths}m
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              <Numeric value={entry.scenario.cumulativePdInHorizon} />
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {moneyString(entry.scenario.unweightedEcl)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right font-medium tabular-nums text-red-700">
                              {moneyString(entry.scenario.weightedEcl)}
                            </td>
                          </tr>
                        ))}
                        <tr className="bg-slate-50 font-semibold">
                          <td className="px-2.5 py-1.5" colSpan={7}>
                            Loss allowance — exact sum of the weighted contributions
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-red-700">
                            {moneyString(result.lossAllowance)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ),
              },
              {
                id: 'periods',
                label: 'Calculation periods',
                content: (
                  <div className="space-y-4">
                    <p className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      The four factors below are the engine&apos;s display-rounded digits; the expected loss is
                      computed at 40-digit precision and rounded once. Multiplying the shown numbers by hand can
                      therefore land a few paisa away from the stored figure. What reconciles exactly is the column
                      total: each scenario&apos;s period losses sum to its unweighted ECL, and the weighted
                      contributions sum to the loss allowance.
                    </p>
                    {data.scenarioPeriods.map((entry) => (
                      <div key={entry.scenario.scenarioCode}>
                        <p className="mb-1.5 text-xs font-semibold text-slate-700">
                          {entry.scenario.scenarioName}{' '}
                          <span className="font-normal text-slate-400">
                            · {entry.scenario.scenarioCode} · weight{' '}
                            {formatDecimalPercent(entry.scenario.weight, 2)} · {entry.periods.length} period(s)
                          </span>
                        </p>
                        {entry.periods.length === 0 ? (
                          <EmptyState
                            title="No periods"
                            description="The engine produced no calculation periods for this scenario."
                          />
                        ) : (
                          <PeriodTable periods={entry.periods} scenarioCode={entry.scenario.scenarioCode} />
                        )}
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                id: 'approximation',
                label: 'Approximation & lineage',
                content: (
                  <div className="space-y-3">
                    <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      {result.educationalApproximation.label} The authoritative allowance is the scenario-weighted
                      sum of the period table — never this shortcut.
                    </p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
                      <Fact label="Lump PD" value={<Numeric value={result.educationalApproximation.lumpPd} />} />
                      <Fact label="LGD" value={<Numeric value={result.educationalApproximation.lgd} />} />
                      <Fact
                        label="EAD"
                        value={<Numeric value={result.educationalApproximation.eadAtReportingDate} />}
                      />
                      <Fact
                        label="Discount factor"
                        value={<Numeric value={result.educationalApproximation.discountFactor} />}
                      />
                      <Fact
                        label="Approximation"
                        value={moneyString(result.educationalApproximation.value)}
                      />
                    </dl>
                    <code className="block whitespace-pre-wrap break-words rounded-md bg-slate-50 px-3 py-2 font-mono text-[11px] text-navy-900">
                      {result.educationalApproximation.formulaTrace}
                    </code>

                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Lineage
                      </p>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-slate-200 px-3 py-2.5 sm:grid-cols-3">
                        <Fact label="Input version" value={<code>{result.lineage.inputVersion}</code>} />
                        <Fact
                          label="Model configuration"
                          value={formatVersionedRef(
                            result.lineage.modelConfigurationName,
                            result.lineage.modelConfigurationId,
                            result.lineage.modelConfigurationVersion,
                          )}
                        />
                        <Fact
                          label="Staging rule set"
                          value={formatVersionedRef(
                            null,
                            result.lineage.stagingRuleSetId,
                            result.lineage.stagingRuleSetVersion,
                          )}
                        />
                        <Fact
                          label="Scenario set"
                          value={formatVersionedRef(
                            result.lineage.scenarioSetName,
                            result.lineage.scenarioSetId,
                            result.lineage.scenarioSetVersion,
                          )}
                        />
                        <Fact label="Reporting date" value={formatDate(result.lineage.reportingDate)} />
                        <Fact label="Actor" value={`${result.lineage.actorName} (${result.lineage.actorId})`} />
                      </dl>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                        {result.lineage.roundingPolicy}
                      </p>
                    </div>

                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Engine explanation
                      </p>
                      <ul className="space-y-1">
                        {result.explanation.map((line) => (
                          <li key={line} className="text-[11px] leading-relaxed text-slate-600">
                            {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ),
              },
            ]}
          />

          {/*
            Keyed on the run and the exposure: an explanation is about one
            allowance in one run, so a stale answer surviving a switch to another
            row would be prose attached to the wrong number.
          */}
          {canUseAi ? (
            <ExplainEclPanel
              key={`${runId}:${result.exposurePublicId}`}
              exposureId={result.exposurePublicId}
              runId={runId}
              subjectLabel={`${result.exposurePublicId} in run ${runId}`}
            />
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
