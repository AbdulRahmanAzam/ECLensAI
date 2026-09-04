/**
 * Read-only portfolio analytics: the aggregations behind the dashboard and
 * behind the copilot's evidence tools.
 *
 * Both consumers live in one module because they must not be able to disagree.
 * A figure the copilot quotes and the same figure on a KPI card come from one
 * function, so a judge who asks the model about the number on screen gets the
 * number on screen.
 *
 * Three properties are non-negotiable:
 *
 *   - Every query is scoped by `organizationId` before anything else, so a call
 *     carrying a foreign id finds nothing rather than finding someone else's
 *     portfolio.
 *   - Every figure is summed with Decimal and rendered with the same rounding
 *     helpers the engine uses. Nothing here re-derives an ECL: the allowances
 *     are read from stored `EclResult` rows, and the only arithmetic is
 *     addition, subtraction and a share-of-total.
 *   - Every returned figure is a string at stored precision. For the copilot
 *     that is what makes the grounding check reliable; for the dashboard it is
 *     what makes a total here byte-identical to the same total on the run
 *     detail page.
 */
import { Prisma } from '@prisma/client';
import {
  CONCENTRATION_DIMENSIONS,
  RATING_SCALE,
  dec,
  moneyToString,
  rateToString,
  zero,
  type AnalyticsConcentration,
  type AnalyticsDrivers,
  type AnalyticsFilter,
  type AnalyticsMigration,
  type AnalyticsScenarios,
  type AnalyticsStageRow,
  type AnalyticsSummary,
  type AnalyticsTrend,
  type ConcentrationBucket,
  type ConcentrationDimension,
  type ConcentrationSlice,
  type Dec,
  type DriverExposure,
  type FilterOption,
  type MigrationCell,
  type MovementBridge,
  type MovementComponent,
  type MovementComponentCode,
  type MovementEndpoint,
  type PortfolioFilters,
  type PortfolioTotalsDto,
  type ReportingPeriodOption,
  type RunComparison,
  type RunComparisonExposureRow,
  type RunComparisonQuery,
  type ScenarioRow,
  type Stage,
  type StagingRuleContribution,
  type TrendPoint,
} from '@eclens/shared';
import { notFound } from '../utils/httpError';
import { prisma } from '../lib/prisma';
import { dateStr, jsonAs, stageOf, stagingOf } from './mappers';
import { RESULT_BEARING_STATUSES } from './portfolio.service';

const money = (value: Prisma.Decimal | null | undefined): string => moneyToString(dec(value?.toString() ?? 0));
const rate = (value: Prisma.Decimal | null | undefined): string => rateToString(dec(value?.toString() ?? 0));
const sum = (values: Array<Prisma.Decimal | null | undefined>): Dec =>
  values.reduce<Dec>((total, value) => total.plus(dec(value?.toString() ?? 0)), dec(0));

/** Share of a total, as a percentage string, or null when the total is zero. */
function shareOf(part: Dec, total: Dec): string | null {
  if (total.isZero()) return null;
  return rateToString(part.dividedBy(total).times(100));
}

function changePercent(from: Dec, to: Dec): string | null {
  if (from.isZero()) return null;
  return rateToString(to.minus(from).dividedBy(from.abs()).times(100));
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

async function findRunRow(organizationId: string, idOrPublicId: string) {
  const run = await prisma.eclRun.findFirst({
    where: { organizationId, OR: [{ id: idOrPublicId }, { publicId: idOrPublicId }] },
    select: {
      id: true,
      publicId: true,
      notes: true,
      status: true,
      runDate: true,
      snapshotId: true,
      completedAt: true,
      createdAt: true,
      snapshot: { select: { id: true, publicId: true, label: true, asOfDate: true } },
    },
  });
  if (!run) throw notFound('No run matches that id in your organisation');
  return run;
}

/** A run has no name column; `notes` is what an analyst would recognise. */
const runLabel = (run: { publicId: string; notes: string | null }): string => run.notes?.trim() || run.publicId;

export async function findSnapshotRow(organizationId: string, idOrPublicId: string) {
  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { organizationId, OR: [{ id: idOrPublicId }, { publicId: idOrPublicId }] },
    select: { id: true, publicId: true, label: true, asOfDate: true, exposureCount: true },
  });
  if (!snapshot) throw notFound('No snapshot matches that id in your organisation');
  return snapshot;
}

/** The most recent run for a snapshot that actually produced results. */
export async function latestResultBearingRunFor(organizationId: string, snapshotId: string) {
  return prisma.eclRun.findFirst({
    where: { organizationId, snapshotId, status: { in: RESULT_BEARING_STATUSES } },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, publicId: true, status: true, runDate: true },
  });
}

/**
 * The newest run holding a stored result for one exposure.
 *
 * Selects the run id only: the trace tool needs to know *which* run to explain
 * before it fetches that run's full period-level detail, and paying for the
 * heavy result include twice would double the latency of every explanation.
 */
export async function latestRunIdForExposure(
  organizationId: string,
  exposureIdOrPublicId: string,
): Promise<string | null> {
  const result = await prisma.eclResult.findFirst({
    where: {
      run: { organizationId, status: { in: RESULT_BEARING_STATUSES } },
      exposure: { OR: [{ publicId: exposureIdOrPublicId }, { id: exposureIdOrPublicId }] },
    },
    orderBy: { createdAt: 'desc' },
    select: { run: { select: { publicId: true } } },
  });
  return result?.run.publicId ?? null;
}

/**
 * The run executive commentary should compare against.
 *
 * `EclLineage` freezes a run's assumptions but not its predecessor, so the
 * comparison base is resolved here: the most recent *other* result-bearing run
 * on the same snapshot. Null when this is the first run on that snapshot — a
 * first run has no movement to report, and the caller has to be able to say
 * that instead of inventing a baseline.
 */
export async function previousRunFor(organizationId: string, idOrPublicId: string) {
  const current = await prisma.eclRun.findFirst({
    where: { organizationId, OR: [{ id: idOrPublicId }, { publicId: idOrPublicId }] },
    select: { id: true, snapshotId: true, completedAt: true, createdAt: true },
  });
  if (!current) throw notFound('No run matches that id in your organisation');

  const previous = await prisma.eclRun.findFirst({
    where: {
      organizationId,
      snapshotId: current.snapshotId,
      status: { in: RESULT_BEARING_STATUSES },
      id: { not: current.id },
      createdAt: { lte: current.createdAt },
    },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, publicId: true, status: true, runDate: true, notes: true },
  });
  if (!previous) return null;
  return {
    id: previous.id,
    publicId: previous.publicId,
    status: previous.status,
    runDate: dateStr(previous.runDate),
    notes: previous.notes,
  };
}

const tsStr = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

// ---------------------------------------------------------------------------
// Scenario comparison
// ---------------------------------------------------------------------------

/**
 * Per-scenario contribution to one run's total allowance.
 *
 * Grouping on the scenario's own configuration columns is safe because a
 * completed run freezes its scenario set: within one run those values are
 * constant per scenario code, so the group key cannot split a scenario.
 */
export async function getScenarioComparison(
  organizationId: string,
  runIdOrPublicId: string,
): Promise<AnalyticsScenarios> {
  const run = await findRunRow(organizationId, runIdOrPublicId);

  // `horizonMonths` is excluded from the grouping key: it is an exposure's
  // remaining lifetime, not a property of the scenario, so it varies row to
  // row within one scenario. Grouping by it would fragment each scenario into
  // one group per distinct horizon and sum its weight once per fragment —
  // wrong by roughly the fragment count. `_max` reports the longest horizon
  // considered under that scenario instead.
  const groups = await prisma.eclScenarioResult.groupBy({
    by: ['scenarioCode', 'scenarioName', 'weight', 'pdMultiplier', 'lgdMultiplier'],
    where: { result: { runId: run.id } },
    _sum: { unweightedEcl: true, weightedEcl: true },
    _avg: { cumulativePdInHorizon: true },
    _max: { horizonMonths: true },
    _count: { _all: true },
    orderBy: { scenarioCode: 'asc' },
  });

  const totalWeighted = sum(groups.map((group) => group._sum.weightedEcl));
  const scenarios: ScenarioRow[] = groups.map((group) => {
    const weighted = dec(group._sum.weightedEcl?.toString() ?? 0);
    return {
      scenarioCode: group.scenarioCode,
      scenarioName: group.scenarioName,
      weight: rate(group.weight),
      pdMultiplier: rate(group.pdMultiplier),
      lgdMultiplier: rate(group.lgdMultiplier),
      horizonMonths: group._max.horizonMonths ?? 0,
      unweightedEcl: money(group._sum.unweightedEcl),
      weightedEcl: money(weighted),
      shareOfWeightedEclPercent: shareOf(weighted, totalWeighted),
      averageCumulativePdInHorizon: rate(group._avg.cumulativePdInHorizon),
      exposureCount: group._count._all,
    };
  });

  const exposureCount = await prisma.eclResult.count({ where: { runId: run.id } });

  return {
    runPublicId: run.publicId,
    runStatus: run.status,
    runLabel: runLabel(run),
    snapshotPublicId: run.snapshot.publicId,
    reportingDate: dateStr(run.snapshot.asOfDate),
    scenarios,
    totalUnweightedEcl: money(sum(groups.map((group) => group._sum.unweightedEcl))),
    totalWeightedEcl: money(totalWeighted),
    weightSum: rate(sum(groups.map((group) => group.weight))),
    exposureCount,
  };
}

// ---------------------------------------------------------------------------
// Stage migration
// ---------------------------------------------------------------------------

async function stageByExposurePublicId(runId: string): Promise<Map<string, { stage: number; gca: Prisma.Decimal }>> {
  const rows = await prisma.eclResult.findMany({
    where: { runId },
    select: { stage: true, grossCarryingAmount: true, exposure: { select: { publicId: true } } },
  });
  return new Map(rows.map((row) => [row.exposure.publicId, { stage: row.stage, gca: row.grossCarryingAmount }]));
}

/**
 * Stage movement between two snapshots, matched on the exposure's public id —
 * the one identifier that survives from one snapshot to the next, since each
 * snapshot owns its own exposure rows.
 */
export async function getStageMigration(
  organizationId: string,
  fromSnapshotIdOrPublicId: string,
  toSnapshotIdOrPublicId: string,
): Promise<AnalyticsMigration> {
  const from = await findSnapshotRow(organizationId, fromSnapshotIdOrPublicId);
  const to = await findSnapshotRow(organizationId, toSnapshotIdOrPublicId);

  const [fromRun, toRun] = await Promise.all([
    latestResultBearingRunFor(organizationId, from.id),
    latestResultBearingRunFor(organizationId, to.id),
  ]);

  const limitations: string[] = [];
  if (from.id === to.id) {
    limitations.push(
      `Both sides are the same snapshot (${from.publicId}), so every exposure matches itself and no migration is possible. This is not an observation about credit quality.`,
    );
  }
  if (!fromRun) limitations.push(`Snapshot ${from.publicId} has no completed run, so its stages are unavailable.`);
  if (!toRun) limitations.push(`Snapshot ${to.publicId} has no completed run, so its stages are unavailable.`);

  const [fromStages, toStages] = await Promise.all([
    fromRun ? stageByExposurePublicId(fromRun.id) : Promise.resolve(new Map()),
    toRun ? stageByExposurePublicId(toRun.id) : Promise.resolve(new Map()),
  ]);

  const cells = new Map<string, MigrationCell>();
  let matched = 0;
  for (const [publicId, target] of toStages) {
    const source = fromStages.get(publicId);
    if (!source) continue;
    matched += 1;
    const key = `${source.stage}->${target.stage}`;
    const existing = cells.get(key);
    if (existing) {
      existing.count += 1;
      existing.grossCarryingAmount = money(dec(existing.grossCarryingAmount).plus(dec(target.gca.toString())));
    } else {
      cells.set(key, {
        fromStage: source.stage,
        toStage: target.stage,
        count: 1,
        grossCarryingAmount: money(target.gca),
      });
    }
  }

  const countBy = (stages: Map<string, { stage: number }>): Record<string, number> => {
    const out: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    for (const { stage } of stages.values()) out[String(stage)] = (out[String(stage)] ?? 0) + 1;
    return out;
  };
  const stageCountsFrom = countBy(fromStages);
  const stageCountsTo = countBy(toStages);

  if (matched === 0 && limitations.length === 0) {
    limitations.push(
      'No exposure public id is common to both snapshots, so no migration could be measured. The two snapshots may cover different portfolios.',
    );
  }
  if (fromRun?.status !== 'APPROVED' || toRun?.status !== 'APPROVED') {
    limitations.push('At least one side of this comparison is not an approved run, so its stages are not locked.');
  }

  return {
    fromSnapshot: { publicId: from.publicId, label: from.label, asOfDate: from.asOfDate.toISOString(), runPublicId: fromRun?.publicId ?? null },
    toSnapshot: { publicId: to.publicId, label: to.label, asOfDate: to.asOfDate.toISOString(), runPublicId: toRun?.publicId ?? null },
    cells: [...cells.values()].sort((a, b) => a.fromStage - b.fromStage || a.toStage - b.toStage),
    matchedExposures: matched,
    onlyInFromSnapshot: Math.max(0, fromStages.size - matched),
    onlyInToSnapshot: Math.max(0, toStages.size - matched),
    stageCountsFrom,
    stageCountsTo,
    netStage3Change: (stageCountsTo['3'] ?? 0) - (stageCountsFrom['3'] ?? 0),
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Run comparison
// ---------------------------------------------------------------------------

const TOP_N = 10;

/**
 * Exposure-level difference between two runs.
 *
 * `comparableConfiguration` is the honest bit: two runs on different model
 * configurations or scenario sets are not measuring the same thing, and an
 * analyst reading "allowance up 12%" without that caveat would be misled.
 */
export async function compareRuns(
  organizationId: string,
  baseRunIdOrPublicId: string,
  comparisonRunIdOrPublicId: string,
): Promise<RunComparison> {
  const [base, comparison] = await Promise.all([
    findRunRow(organizationId, baseRunIdOrPublicId),
    findRunRow(organizationId, comparisonRunIdOrPublicId),
  ]);
  if (base.id === comparison.id) {
    throw notFound('Base and comparison run are the same run; nothing to compare');
  }

  // One projection for both sides, so the two runs cannot drift into being
  // measured over different columns.
  const comparisonSelect = {
    stage: true,
    grossCarryingAmount: true,
    lossAllowance: true,
    exposure: { select: { publicId: true, segment: true } },
  } as const;

  const [baseRows, comparisonRows] = await Promise.all([
    prisma.eclResult.findMany({ where: { runId: base.id }, select: comparisonSelect }),
    prisma.eclResult.findMany({ where: { runId: comparison.id }, select: comparisonSelect }),
  ]);

  const baseByPublicId = new Map(baseRows.map((row) => [row.exposure.publicId, row]));
  const comparisonByPublicId = new Map(comparisonRows.map((row) => [row.exposure.publicId, row]));

  const rows: RunComparisonExposureRow[] = [];
  const migrations = new Map<string, MigrationCell>();
  for (const [publicId, target] of comparisonByPublicId) {
    const source = baseByPublicId.get(publicId);
    if (!source) continue;
    const baseAllowance = dec(source.lossAllowance.toString());
    const comparisonAllowance = dec(target.lossAllowance.toString());
    const change = comparisonAllowance.minus(baseAllowance);
    rows.push({
      exposurePublicId: publicId,
      segment: target.exposure.segment,
      baseStage: source.stage,
      comparisonStage: target.stage,
      baseAllowance: money(baseAllowance),
      comparisonAllowance: money(comparisonAllowance),
      change: money(change),
      changePercent: changePercent(baseAllowance, comparisonAllowance),
    });

    const key = `${source.stage}->${target.stage}`;
    const cell = migrations.get(key);
    if (cell) {
      cell.count += 1;
      cell.grossCarryingAmount = money(dec(cell.grossCarryingAmount).plus(dec(target.grossCarryingAmount.toString())));
    } else {
      migrations.set(key, {
        fromStage: source.stage,
        toStage: target.stage,
        count: 1,
        grossCarryingAmount: money(target.grossCarryingAmount),
      });
    }
  }

  const byChange = [...rows].sort((a, b) => Number(dec(b.change)) - Number(dec(a.change)));
  const baseTotal = sum(baseRows.map((row) => row.lossAllowance));
  const comparisonTotal = sum(comparisonRows.map((row) => row.lossAllowance));

  const configSelect = {
    snapshotId: true,
    modelConfiguration: { select: { name: true, version: true } },
    scenarioSet: { select: { name: true, version: true } },
    lockedStagingRuleSet: true,
  } satisfies Prisma.EclRunSelect;
  const [baseConfig, comparisonConfig] = await Promise.all([
    prisma.eclRun.findUnique({ where: { id: base.id }, select: configSelect }),
    prisma.eclRun.findUnique({ where: { id: comparison.id }, select: configSelect }),
  ]);

  const stagingVersion = (locked: Prisma.JsonValue | null): string => {
    const version = (locked as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : 'unlocked';
  };

  const sameReportingDate = base.snapshot.asOfDate.getTime() === comparison.snapshot.asOfDate.getTime();

  const configurationDifferences: string[] = [];
  if (baseConfig && comparisonConfig) {
    // Keyed on the reporting date rather than the snapshot id. Two runs over
    // different dates are a period comparison, which is what the dashboard asks
    // for by default; flagging that as incomparable would warn about the very
    // thing the reader requested. Two runs over the *same* date on different
    // snapshots are a data-version change, and that is a real caveat.
    if (sameReportingDate && baseConfig.snapshotId !== comparisonConfig.snapshotId) {
      configurationDifferences.push('snapshot (the two runs are calculated over different versions of the same reporting date)');
    }
    const baseModel = `${baseConfig.modelConfiguration.name} ${baseConfig.modelConfiguration.version}`;
    const comparisonModel = `${comparisonConfig.modelConfiguration.name} ${comparisonConfig.modelConfiguration.version}`;
    if (baseModel !== comparisonModel) {
      configurationDifferences.push(`model configuration (${baseModel} vs ${comparisonModel})`);
    }
    const baseScenarios = `${baseConfig.scenarioSet.name} ${baseConfig.scenarioSet.version}`;
    const comparisonScenarios = `${comparisonConfig.scenarioSet.name} ${comparisonConfig.scenarioSet.version}`;
    if (baseScenarios !== comparisonScenarios) {
      configurationDifferences.push(`scenario set (${baseScenarios} vs ${comparisonScenarios})`);
    }
    const baseRules = stagingVersion(baseConfig.lockedStagingRuleSet);
    const comparisonRules = stagingVersion(comparisonConfig.lockedStagingRuleSet);
    if (baseRules !== comparisonRules) {
      configurationDifferences.push(`staging rule set (${baseRules} vs ${comparisonRules})`);
    }
  }

  const limitations: string[] = [];
  if (!RESULT_BEARING_STATUSES.includes(base.status as never)) limitations.push(`Base run ${base.publicId} is '${base.status}' and may not hold final results.`);
  if (!RESULT_BEARING_STATUSES.includes(comparison.status as never)) {
    limitations.push(`Comparison run ${comparison.publicId} is '${comparison.status}' and may not hold final results.`);
  }
  if (configurationDifferences.length > 0) {
    limitations.push(`The two runs differ in ${configurationDifferences.join(', ')}, so the difference is not purely a change in credit quality.`);
  }
  if (!sameReportingDate) {
    limitations.push(
      `The two runs are calculated over different reporting dates (${tsStr(base.snapshot.asOfDate)} then ${tsStr(comparison.snapshot.asOfDate)}), so the difference includes book composition — exposures originated and derecognised between the two dates — and not only a change in credit quality.`,
    );
  }
  if (rows.length === 0) {
    limitations.push('No exposure public id is common to both runs, so no exposure-level comparison was possible.');
  }

  return {
    baseRun: {
      publicId: base.publicId,
      label: runLabel(base),
      status: base.status,
      reportingDate: dateStr(base.snapshot.asOfDate),
      snapshotPublicId: base.snapshot.publicId,
    },
    comparisonRun: {
      publicId: comparison.publicId,
      label: runLabel(comparison),
      status: comparison.status,
      reportingDate: dateStr(comparison.snapshot.asOfDate),
      snapshotPublicId: comparison.snapshot.publicId,
    },
    totals: {
      baseAllowance: money(baseTotal),
      comparisonAllowance: money(comparisonTotal),
      change: money(comparisonTotal.minus(baseTotal)),
      changePercent: changePercent(baseTotal, comparisonTotal),
      baseExposureCount: baseRows.length,
      comparisonExposureCount: comparisonRows.length,
    },
    comparableConfiguration: configurationDifferences.length === 0,
    sameReportingDate,
    configurationDifferences,
    largestIncreases: byChange.slice(0, TOP_N),
    largestDecreases: byChange.slice(-TOP_N).reverse(),
    stageMigrations: [...migrations.values()].sort((a, b) => a.fromStage - b.fromStage || a.toStage - b.toStage),
    matchedExposures: rows.length,
    onlyInBase: Math.max(0, baseRows.length - rows.length),
    onlyInComparison: Math.max(0, comparisonRows.length - rows.length),
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
//
// Everything below answers a question the dashboard asks about one *reporting
// period*, and every function resolves that period the same way: the named
// snapshot or the newest one, and the newest run on it that produced results.
// A figure produced here and the same figure produced by the copilot's tools
// therefore describe the same run — which is what makes "ask the model about
// the number on screen" safe to demonstrate.
//
// Every aggregate folds the same narrow result rows in Decimal rather than
// asking the database to group by an exposure column, because Prisma cannot
// group by a related model's field. At demo scale that is a few hundred rows of
// six columns; the point is not the row count but that one loader feeds every
// chart, so two charts cannot disagree about which rows they counted.
// ---------------------------------------------------------------------------

const STAGES: Stage[] = [1, 2, 3];

const PERIOD_SNAPSHOT_SELECT = {
  id: true,
  publicId: true,
  label: true,
  asOfDate: true,
  exposureCount: true,
} satisfies Prisma.PortfolioSnapshotSelect;

const PERIOD_RUN_SELECT = {
  id: true,
  publicId: true,
  status: true,
  notes: true,
  totals: true,
  completedAt: true,
  modelConfiguration: { select: { version: true } },
  scenarioSet: { select: { version: true } },
} satisfies Prisma.EclRunSelect;

type PeriodSnapshotRow = Prisma.PortfolioSnapshotGetPayload<{ select: typeof PERIOD_SNAPSHOT_SELECT }>;
type PeriodRunRow = Prisma.EclRunGetPayload<{ select: typeof PERIOD_RUN_SELECT }>;

export interface ResolvedRun {
  id: string;
  publicId: string;
  status: string;
  label: string;
  completedAt: Date | null;
  modelConfigurationVersion: string;
  scenarioSetVersion: string;
  /** The totals the engine persisted when this run completed. */
  totals: PortfolioTotalsDto | null;
}

export interface ResolvedPeriod {
  snapshotId: string;
  snapshotPublicId: string;
  label: string;
  asOfDate: Date;
  reportingDate: string;
  exposureCount: number;
  run: ResolvedRun | null;
}

function toResolvedRun(row: PeriodRunRow): ResolvedRun {
  return {
    id: row.id,
    publicId: row.publicId,
    status: row.status,
    label: runLabel(row),
    completedAt: row.completedAt,
    modelConfigurationVersion: row.modelConfiguration.version,
    scenarioSetVersion: row.scenarioSet.version,
    totals: jsonAs<PortfolioTotalsDto | null>(row.totals, null),
  };
}

function toResolvedPeriod(snapshot: PeriodSnapshotRow, run: PeriodRunRow | null): ResolvedPeriod {
  return {
    snapshotId: snapshot.id,
    snapshotPublicId: snapshot.publicId,
    label: snapshot.label,
    asOfDate: snapshot.asOfDate,
    reportingDate: dateStr(snapshot.asOfDate),
    exposureCount: snapshot.exposureCount,
    run: run ? toResolvedRun(run) : null,
  };
}

/** The period an unqualified dashboard call means, and the run behind it. */
export async function resolvePeriod(organizationId: string, snapshotId?: string): Promise<ResolvedPeriod> {
  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: {
      organizationId,
      ...(snapshotId ? { OR: [{ id: snapshotId }, { publicId: snapshotId }] } : {}),
    },
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    select: PERIOD_SNAPSHOT_SELECT,
  });
  if (!snapshot) throw notFound('No portfolio snapshot found for this organization');

  const run = await prisma.eclRun.findFirst({
    where: { organizationId, snapshotId: snapshot.id, status: { in: RESULT_BEARING_STATUSES } },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: PERIOD_RUN_SELECT,
  });

  return toResolvedPeriod(snapshot, run);
}

/**
 * The period before this one that has results to compare against.
 *
 * Resolved through `EclRun` rather than through snapshots, so a period whose run
 * never completed is skipped instead of becoming an empty side of a comparison.
 */
async function resolvePreviousPeriod(
  organizationId: string,
  current: ResolvedPeriod,
): Promise<ResolvedPeriod | null> {
  const run = await prisma.eclRun.findFirst({
    where: {
      organizationId,
      status: { in: RESULT_BEARING_STATUSES },
      snapshotId: { not: current.snapshotId },
      snapshot: { asOfDate: { lt: current.asOfDate } },
    },
    orderBy: [{ snapshot: { asOfDate: 'desc' } }, { completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { ...PERIOD_RUN_SELECT, snapshotId: true, snapshot: { select: PERIOD_SNAPSHOT_SELECT } },
  });
  if (!run) return null;
  return toResolvedPeriod(run.snapshot, run);
}

async function organizationCurrency(organizationId: string): Promise<string> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  return organization?.currency ?? 'PKR';
}

// ---------------------------------------------------------------------------
// The one result-row loader every aggregate folds
// ---------------------------------------------------------------------------

/**
 * `staging` is the run's frozen decision JSON. Reading it here means the driver
 * and rule aggregations describe exactly the run whose allowances they sum,
 * rather than a live assessment a later re-run may have moved on from.
 */
const RESULT_SLICE_SELECT = {
  stage: true,
  grossCarryingAmount: true,
  eadAtReportingDate: true,
  lossAllowance: true,
  netCarryingAmount: true,
  coverageRatio: true,
  staging: true,
  exposure: {
    select: {
      publicId: true,
      segment: true,
      productType: true,
      region: true,
      industry: true,
      currentCreditRating: true,
      daysPastDue: true,
      borrower: { select: { name: true } },
    },
  },
} satisfies Prisma.EclResultSelect;

type ResultSlice = Prisma.EclResultGetPayload<{ select: typeof RESULT_SLICE_SELECT }>;

/**
 * `stage` narrows on the result's own staged outcome rather than on the live
 * assessment, so a selection can never include a row the run staged differently.
 */
function resultWhere(runId: string, filter: AnalyticsFilter): Prisma.EclResultWhereInput {
  const exposure: Prisma.ExposureWhereInput = {};
  if (filter.segment) exposure.segment = filter.segment;
  if (filter.productType) exposure.productType = filter.productType;
  if (filter.region) exposure.region = filter.region;
  if (filter.industry) exposure.industry = filter.industry;
  if (filter.rating) exposure.currentCreditRating = filter.rating;
  return {
    runId,
    ...(filter.stage ? { stage: filter.stage } : {}),
    ...(Object.keys(exposure).length > 0 ? { exposure } : {}),
  };
}

async function loadResultSlice(runId: string | null, filter: AnalyticsFilter): Promise<ResultSlice[]> {
  if (!runId) return [];
  return prisma.eclResult.findMany({ where: resultWhere(runId, filter), select: RESULT_SLICE_SELECT });
}

/** The chips the filter bar renders, in a stable order. */
function describeFilters(filter: AnalyticsFilter): string[] {
  const applied: string[] = [];
  if (filter.segment) applied.push(`Segment: ${filter.segment}`);
  if (filter.productType) applied.push(`Product: ${filter.productType}`);
  if (filter.region) applied.push(`Region: ${filter.region}`);
  if (filter.industry) applied.push(`Industry: ${filter.industry}`);
  if (filter.rating) applied.push(`Rating: ${filter.rating}`);
  if (filter.stage) applied.push(`Stage ${filter.stage}`);
  return applied;
}

// ---------------------------------------------------------------------------
// Decimal accumulators
// ---------------------------------------------------------------------------

interface Amounts {
  count: number;
  gross: Dec;
  ead: Dec;
  allowance: Dec;
  net: Dec;
  stages: Record<Stage, number>;
}

/** Keyed by stage rather than a Map so `byStage[stage]` is total, never maybe-undefined. */
type StageAmounts = Record<Stage, Amounts>;

const emptyAmounts = (): Amounts => ({
  count: 0,
  gross: zero(),
  ead: zero(),
  allowance: zero(),
  net: zero(),
  stages: { 1: 0, 2: 0, 3: 0 },
});

const emptyStageAmounts = (): StageAmounts => ({ 1: emptyAmounts(), 2: emptyAmounts(), 3: emptyAmounts() });

function addResult(acc: Amounts, row: ResultSlice): void {
  acc.count += 1;
  acc.stages[stageOf(row.stage)] += 1;
  acc.gross = acc.gross.plus(dec(row.grossCarryingAmount.toString()));
  acc.ead = acc.ead.plus(dec(row.eadAtReportingDate.toString()));
  acc.allowance = acc.allowance.plus(dec(row.lossAllowance.toString()));
  acc.net = acc.net.plus(dec(row.netCarryingAmount.toString()));
}

function mergeAmounts(target: Amounts, source: Amounts): void {
  target.count += source.count;
  for (const stage of STAGES) target.stages[stage] += source.stages[stage];
  target.gross = target.gross.plus(source.gross);
  target.ead = target.ead.plus(source.ead);
  target.allowance = target.allowance.plus(source.allowance);
  target.net = target.net.plus(source.net);
}

function totalOf(rows: ResultSlice[]): Amounts {
  const acc = emptyAmounts();
  for (const row of rows) addResult(acc, row);
  return acc;
}

const coverageOf = (acc: Amounts): Dec => (acc.gross.isZero() ? zero() : acc.allowance.dividedBy(acc.gross));

const allowanceOf = (row: ResultSlice): Dec => dec(row.lossAllowance.toString());

/** Ranked by allowance, largest first — the order every "top drivers" list uses. */
const byAllowanceDesc = (a: { acc: Amounts }, b: { acc: Amounts }): number =>
  b.acc.allowance.comparedTo(a.acc.allowance);

/**
 * Generic so a caller can key on a column it added itself — the staging-rule
 * tally reads a `ruleCode` it derived from the frozen decision, which is not a
 * stored result column.
 */
function tallyBy<T extends ResultSlice>(rows: T[], keyOf: (row: T) => string): Array<{ key: string; acc: Amounts }> {
  const map = new Map<string, Amounts>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = map.get(key);
    if (existing) {
      addResult(existing, row);
    } else {
      const created = emptyAmounts();
      addResult(created, row);
      map.set(key, created);
    }
  }
  return [...map.entries()].map(([key, acc]) => ({ key, acc }));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * The dashboard's headline numbers for one reporting period.
 *
 * With no filter active this publishes the run's own persisted totals verbatim,
 * so a KPI card is byte-identical to the run detail page rather than equal to it
 * up to a rounding step. A filtered selection is the only case that has no
 * persisted figure to read, and there the rows are folded instead.
 *
 * The fold is computed either way and used as a cross-check, because a result
 * set that has lost rows since the run completed is exactly what a dashboard
 * should refuse to present silently. `reconcilesToRun` reports that check.
 */
export async function getAnalyticsSummary(
  organizationId: string,
  filter: AnalyticsFilter,
): Promise<AnalyticsSummary> {
  const [period, currency] = await Promise.all([
    resolvePeriod(organizationId, filter.snapshotId),
    organizationCurrency(organizationId),
  ]);
  const rows = await loadResultSlice(period.run?.id ?? null, filter);
  const filtersApplied = describeFilters(filter);
  const persisted = period.run?.totals ?? null;
  const unfiltered = filtersApplied.length === 0 && persisted !== null;

  const total = totalOf(rows);
  const byStage = emptyStageAmounts();
  for (const row of rows) addResult(byStage[stageOf(row.stage)], row);

  const publishedGross = unfiltered ? persisted.totalGrossCarryingAmount : moneyToString(total.gross);
  const publishedAllowance = unfiltered ? persisted.totalLossAllowance : moneyToString(total.allowance);

  const stages: AnalyticsStageRow[] = STAGES.map((stage) => {
    const acc = byStage[stage];
    const bucket = unfiltered ? persisted.stageBuckets.find((entry) => entry.stage === stage) ?? null : null;
    const gross = bucket ? bucket.grossCarryingAmount : moneyToString(acc.gross);
    const allowance = bucket ? bucket.lossAllowance : moneyToString(acc.allowance);
    return {
      stage,
      exposureCount: bucket ? bucket.exposureCount : acc.count,
      grossCarryingAmount: gross,
      ead: bucket ? bucket.ead : moneyToString(acc.ead),
      lossAllowance: allowance,
      netCarryingAmount: bucket ? bucket.netCarryingAmount : moneyToString(acc.net),
      coverageRatio: bucket ? bucket.coverageRatio : rateToString(coverageOf(acc)),
      // Shares are taken against the published totals, not the fold, so the
      // percentages on screen add up to the figures beside them.
      shareOfGrossPercent: shareOf(dec(gross), dec(publishedGross)),
      shareOfAllowancePercent: shareOf(dec(allowance), dec(publishedAllowance)),
    };
  });

  const publishedCoverage = unfiltered ? persisted.coverageRatio : rateToString(coverageOf(total));
  const stageCount = (stage: Stage): number => stages.find((row) => row.stage === stage)?.exposureCount ?? 0;

  const totals = {
    exposureCount: unfiltered ? persisted.exposureCount : rows.length,
    grossCarryingAmount: publishedGross,
    ead: unfiltered ? persisted.totalEad : moneyToString(total.ead),
    lossAllowance: publishedAllowance,
    netCarryingAmount: unfiltered ? persisted.totalNetCarryingAmount : moneyToString(total.net),
    coverageRatio: publishedCoverage,
    // Derived from the published ratio rather than from the full-precision
    // quotient, so the two coverage cards can never disagree with each other.
    coveragePercent: rateToString(dec(publishedCoverage).times(100)),
    stage2And3Count: stageCount(2) + stageCount(3),
    stage3Count: stageCount(3),
  };

  /**
   * EAD is deliberately absent from this check. It is a product of a 2dp balance
   * and a 6dp conversion factor, so each row is rounded to 2dp on the way into
   * `Decimal(24,2)` while the run's total was rounded once at the end; the gap
   * cannot exceed half a paisa per exposure, and flagging it would train a
   * reviewer to ignore the warning that matters. The four figures compared here
   * are provably exact under `ROUNDING_POLICY`: gross is an input at 2dp, an
   * allowance is an exact sum of amounts already rounded to 2dp, and net is
   * their difference.
   */
  const foldDisagrees =
    unfiltered &&
    (persisted.exposureCount !== rows.length ||
      persisted.totalGrossCarryingAmount !== moneyToString(total.gross) ||
      persisted.totalLossAllowance !== moneyToString(total.allowance) ||
      persisted.totalNetCarryingAmount !== moneyToString(total.net));

  const limitations: string[] = [];
  if (!period.run) {
    limitations.push(
      `${period.reportingDate} has no completed run, so there is no allowance to report. Commit an import and execute a run for this period first.`,
    );
  } else if (filtersApplied.length > 0) {
    limitations.push(
      `These figures cover only ${filtersApplied.join(', ')} — ${rows.length} of the ${persisted?.exposureCount ?? period.exposureCount} exposures in run ${period.run.publicId}. They are exact for that selection but are not the run's headline totals.`,
    );
  } else if (foldDisagrees) {
    limitations.push(
      `The figures above are run ${period.run.publicId}'s own persisted totals, but refolding its ${rows.length} result rows gives different ones. The result set has changed since the run completed; the run page remains authoritative and this is a defect worth investigating.`,
    );
  }

  return {
    currency,
    reportingDate: period.reportingDate,
    snapshot: { publicId: period.snapshotPublicId, label: period.label, exposureCount: period.exposureCount },
    run: period.run
      ? {
          publicId: period.run.publicId,
          status: period.run.status,
          label: period.run.label,
          completedAt: period.run.completedAt ? period.run.completedAt.toISOString() : null,
          modelConfigurationVersion: period.run.modelConfigurationVersion,
          scenarioSetVersion: period.run.scenarioSetVersion,
        }
      : null,
    totals,
    stages,
    filtersApplied,
    reconcilesToRun: unfiltered && !foldDisagrees,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Movement bridge
// ---------------------------------------------------------------------------

const MOVEMENT_LABELS: Record<MovementComponentCode, string> = {
  OPENING: 'Opening allowance',
  NEW_ORIGINATIONS: 'New originations',
  DERECOGNITION: 'Derecognition and repayments',
  STAGE_TRANSFERS: 'Stage transfers',
  CONTINUING_SAME_STAGE: 'Continuing book, stage unchanged',
  PARAMETER_CHANGES: 'Parameter changes',
  SCENARIO_CHANGES: 'Scenario changes',
  WRITE_OFFS: 'Write-offs',
  CLOSING: 'Closing allowance',
};

const WRITE_OFF_NOTE =
  'This book records no write-off events, so write-offs cannot be separated from derecognition. Anything shown under "Derecognition and repayments" is an exposure the earlier period held and the later one does not, for whatever reason.';

/**
 * Why the allowance moved between two reporting periods.
 *
 * The decomposition is by exposure cohort: what the later period holds that the
 * earlier one did not (originations), what it no longer holds (derecognition),
 * and — for the book held at both dates — the part whose stage changed and the
 * part whose stage did not. Those four add to the movement exactly, which is
 * what makes the waterfall a reconciliation rather than an illustration.
 *
 * What it is *not* is a factor decomposition. Parameter, scenario and write-off
 * components are reported as null with an explanation whenever they cannot be
 * measured separately, because inventing a plausible split is the easiest way
 * to mislead a reviewer with a chart that looks authoritative.
 */
export async function getMovementBridge(
  organizationId: string,
  filter: AnalyticsFilter,
): Promise<MovementBridge> {
  const period = await resolvePeriod(organizationId, filter.snapshotId);
  if (!period.run) {
    throw notFound(`${period.reportingDate} has no completed run, so there is no movement to measure from it`);
  }
  const previous = await resolvePreviousPeriod(organizationId, period);
  if (!previous?.run) {
    throw notFound(
      `${period.reportingDate} is the earliest reporting period with a completed run, so there is no prior allowance to move from`,
    );
  }

  const [currency, toRows, fromRows] = await Promise.all([
    organizationCurrency(organizationId),
    loadResultSlice(period.run.id, filter),
    loadResultSlice(previous.run.id, filter),
  ]);

  const fromByPublicId = new Map(fromRows.map((row) => [row.exposure.publicId, row]));
  const toByPublicId = new Map(toRows.map((row) => [row.exposure.publicId, row]));

  let originated = zero();
  let originatedCount = 0;
  let stageTransfers = zero();
  let stageTransferCount = 0;
  let continuing = zero();
  let continuingCount = 0;
  for (const [publicId, to] of toByPublicId) {
    const from = fromByPublicId.get(publicId);
    if (!from) {
      originated = originated.plus(allowanceOf(to));
      originatedCount += 1;
      continue;
    }
    const delta = allowanceOf(to).minus(allowanceOf(from));
    if (stageOf(from.stage) === stageOf(to.stage)) {
      continuing = continuing.plus(delta);
      continuingCount += 1;
    } else {
      stageTransfers = stageTransfers.plus(delta);
      stageTransferCount += 1;
    }
  }

  let derecognised = zero();
  let derecognisedCount = 0;
  for (const [publicId, from] of fromByPublicId) {
    if (toByPublicId.has(publicId)) continue;
    derecognised = derecognised.minus(allowanceOf(from));
    derecognisedCount += 1;
  }

  const opening = sum(fromRows.map((row) => row.lossAllowance));
  const closing = sum(toRows.map((row) => row.lossAllowance));
  const change = closing.minus(opening);

  const sameModel = previous.run.modelConfigurationVersion === period.run.modelConfigurationVersion;
  const sameScenarios = previous.run.scenarioSetVersion === period.run.scenarioSetVersion;
  const parameterNote = sameModel
    ? `Both periods were calculated on model configuration v${period.run.modelConfigurationVersion}, so no part of this movement is attributable to a parameter change.`
    : `The periods used different model configurations (v${previous.run.modelConfigurationVersion} then v${period.run.modelConfigurationVersion}). That effect is inside "Continuing book, stage unchanged" and cannot be separated from credit-quality movement without recalculating one period on the other's parameters.`;
  const scenarioNote = sameScenarios
    ? `Both periods were calculated on scenario set v${period.run.scenarioSetVersion}, so no part of this movement is attributable to a change of scenario weights or multipliers.`
    : `The periods used different scenario sets (v${previous.run.scenarioSetVersion} then v${period.run.scenarioSetVersion}). That effect is inside "Continuing book, stage unchanged" and cannot be separated from credit-quality movement without recalculating one period on the other's scenarios.`;

  const endpoint = (resolved: ResolvedPeriod, allowance: Dec, count: number): MovementEndpoint => ({
    reportingDate: resolved.reportingDate,
    snapshotPublicId: resolved.snapshotPublicId,
    runPublicId: resolved.run?.publicId ?? '',
    runStatus: resolved.run?.status ?? '',
    lossAllowance: moneyToString(allowance),
    exposureCount: count,
  });

  const components: MovementComponent[] = [
    {
      code: 'OPENING',
      label: MOVEMENT_LABELS.OPENING,
      amount: moneyToString(opening),
      exposureCount: fromRows.length,
      note: `As at ${previous.reportingDate}, run ${previous.run.publicId} (${previous.run.status}).`,
    },
    {
      code: 'NEW_ORIGINATIONS',
      label: MOVEMENT_LABELS.NEW_ORIGINATIONS,
      amount: moneyToString(originated),
      exposureCount: originatedCount,
      note: 'Allowance on exposures the later period holds and the earlier one did not.',
    },
    {
      code: 'DERECOGNITION',
      label: MOVEMENT_LABELS.DERECOGNITION,
      amount: moneyToString(derecognised),
      exposureCount: derecognisedCount,
      note: 'Negative: the allowance the earlier period carried on exposures the later one no longer holds.',
    },
    {
      code: 'STAGE_TRANSFERS',
      label: MOVEMENT_LABELS.STAGE_TRANSFERS,
      amount: moneyToString(stageTransfers),
      exposureCount: stageTransferCount,
      note: 'Movement on exposures held at both dates whose stage changed. Includes the effect of the balance and parameters moving with the stage, which a cohort split cannot separate.',
    },
    {
      code: 'CONTINUING_SAME_STAGE',
      label: MOVEMENT_LABELS.CONTINUING_SAME_STAGE,
      amount: moneyToString(continuing),
      exposureCount: continuingCount,
      note: 'Movement on exposures held at both dates whose stage did not change: balances running off, PD and LGD drift, and the passage of time.',
    },
    { code: 'PARAMETER_CHANGES', label: MOVEMENT_LABELS.PARAMETER_CHANGES, amount: null, exposureCount: null, note: parameterNote },
    { code: 'SCENARIO_CHANGES', label: MOVEMENT_LABELS.SCENARIO_CHANGES, amount: null, exposureCount: null, note: scenarioNote },
    { code: 'WRITE_OFFS', label: MOVEMENT_LABELS.WRITE_OFFS, amount: null, exposureCount: null, note: WRITE_OFF_NOTE },
    {
      code: 'CLOSING',
      label: MOVEMENT_LABELS.CLOSING,
      amount: moneyToString(closing),
      exposureCount: toRows.length,
      note: `As at ${period.reportingDate}, run ${period.run.publicId} (${period.run.status}).`,
    },
  ];

  const movementSum = components
    .filter((component) => component.code !== 'OPENING' && component.code !== 'CLOSING')
    .reduce<Dec>((acc, component) => (component.amount === null ? acc : acc.plus(dec(component.amount))), zero());
  const componentsSumToChange = movementSum.equals(change);

  const filtersApplied = describeFilters(filter);
  const limitations: string[] = [
    'Components are decomposed by exposure cohort, not by model factor. A cohort split closes arithmetically; attributing movement to one parameter would require recalculating a period on the other period\'s assumptions, which this endpoint does not do.',
  ];
  if (filtersApplied.length > 0) {
    limitations.push(`Both sides are narrowed to ${filtersApplied.join(', ')}, so this is the movement of that selection rather than of the whole book.`);
  }
  if (!componentsSumToChange) {
    limitations.push('The movement components do not add to the reported change. This is a defect, not a data limitation; the opening and closing figures remain the authoritative ones.');
  }
  if (originatedCount === toRows.length && toRows.length > 0) {
    limitations.push('No exposure is common to both periods, so the whole of the later allowance reads as new origination. The two periods may cover different portfolios.');
  }
  if (!sameModel || !sameScenarios) {
    limitations.push('The two periods were not calculated on identical assumptions, so part of this movement is a change of model rather than a change of credit quality.');
  }

  return {
    currency,
    from: endpoint(previous, opening, fromRows.length),
    to: endpoint(period, closing, toRows.length),
    components,
    change: moneyToString(change),
    changePercent: changePercent(opening, closing),
    componentsSumToChange,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * ECL and coverage across every reporting period.
 *
 * Each point is folded from the same result rows the summary uses, so the newest
 * point and the summary's KPI cards cannot disagree — including under a filter,
 * in which case the whole trend narrows with it.
 */
export async function getTrend(organizationId: string, filter: AnalyticsFilter): Promise<AnalyticsTrend> {
  const [snapshots, currency] = await Promise.all([
    prisma.portfolioSnapshot.findMany({
      where: { organizationId },
      orderBy: [{ asOfDate: 'asc' }, { createdAt: 'asc' }],
      select: PERIOD_SNAPSHOT_SELECT,
    }),
    organizationCurrency(organizationId),
  ]);

  // Newest completion first, so the first row seen for a snapshot is the one
  // every other endpoint would resolve for it.
  const runs = await prisma.eclRun.findMany({
    where: { organizationId, status: { in: RESULT_BEARING_STATUSES } },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { ...PERIOD_RUN_SELECT, snapshotId: true },
  });
  const runBySnapshot = new Map<string, PeriodRunRow>();
  for (const run of runs) {
    if (!runBySnapshot.has(run.snapshotId)) runBySnapshot.set(run.snapshotId, run);
  }

  const resolved = snapshots.map((snapshot) => ({ snapshot, runRow: runBySnapshot.get(snapshot.id) ?? null }));
  const rowSets = await Promise.all(resolved.map(({ runRow }) => loadResultSlice(runRow?.id ?? null, filter)));

  const points: TrendPoint[] = resolved.map(({ snapshot, runRow }, index) => {
    const rows = rowSets[index];
    const total = totalOf(rows);
    const byStage = emptyStageAmounts();
    for (const row of rows) addResult(byStage[stageOf(row.stage)], row);
    const run = runRow ? toResolvedRun(runRow) : null;

    return {
      reportingDate: dateStr(snapshot.asOfDate),
      snapshotPublicId: snapshot.publicId,
      snapshotLabel: snapshot.label,
      runPublicId: run?.publicId ?? null,
      runStatus: run?.status ?? null,
      exposureCount: rows.length,
      grossCarryingAmount: moneyToString(total.gross),
      ead: moneyToString(total.ead),
      lossAllowance: moneyToString(total.allowance),
      netCarryingAmount: moneyToString(total.net),
      coverageRatio: rateToString(coverageOf(total)),
      stageCounts: { 1: byStage[1].count, 2: byStage[2].count, 3: byStage[3].count },
      stageAllowance: {
        1: moneyToString(byStage[1].allowance),
        2: moneyToString(byStage[2].allowance),
        3: moneyToString(byStage[3].allowance),
      },
      modelConfigurationVersion: run?.modelConfigurationVersion ?? null,
      scenarioSetVersion: run?.scenarioSetVersion ?? null,
    };
  });

  const limitations: string[] = [];
  const withoutRun = points.filter((point) => point.runPublicId === null).map((point) => point.reportingDate);
  if (withoutRun.length > 0) {
    limitations.push(
      `${withoutRun.join(', ')} ha${withoutRun.length === 1 ? 's' : 've'} no completed run, so ${withoutRun.length === 1 ? 'its' : 'their'} allowance and coverage are zero because nothing was calculated, not because the book was risk-free.`,
    );
  }
  if (points.length < 2) {
    limitations.push('Only one reporting period exists, so there is no trend to draw yet.');
  }
  const filtersApplied = describeFilters(filter);
  if (filtersApplied.length > 0) {
    limitations.push(`Every period is narrowed to ${filtersApplied.join(', ')}, so this is the trend of that selection rather than of the whole book.`);
  }

  return { currency, points, limitations };
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------

/** Long enough for the seven regions and ten ratings; industries fold into "Other". */
const MAX_BUCKETS = 10;

const DIMENSION_LABELS: Record<ConcentrationDimension, string> = {
  segment: 'Segment',
  productType: 'Product type',
  region: 'Region',
  industry: 'Industry',
  rating: 'Credit rating',
};

const DIMENSION_VALUE: Record<ConcentrationDimension, (row: ResultSlice) => string> = {
  segment: (row) => row.exposure.segment,
  productType: (row) => row.exposure.productType,
  region: (row) => row.exposure.region,
  industry: (row) => row.exposure.industry,
  rating: (row) => row.exposure.currentCreditRating,
};

/** Credit quality order; an unrecognised grade sorts after the published scale. */
const ratingRank = (value: string): number => {
  const index = RATING_SCALE.indexOf(value as (typeof RATING_SCALE)[number]);
  return index === -1 ? RATING_SCALE.length : index;
};

function toBucket(key: string, acc: Amounts, total: Amounts): ConcentrationBucket {
  return {
    key,
    exposureCount: acc.count,
    grossCarryingAmount: moneyToString(acc.gross),
    lossAllowance: moneyToString(acc.allowance),
    coverageRatio: rateToString(coverageOf(acc)),
    shareOfGrossPercent: shareOf(acc.gross, total.gross),
    shareOfAllowancePercent: shareOf(acc.allowance, total.allowance),
    stageCounts: { 1: acc.stages[1], 2: acc.stages[2], 3: acc.stages[3] },
  };
}

/**
 * Where the risk sits, on every dimension the book carries.
 *
 * One call returns all five slices because the dashboard renders them together;
 * five round trips to answer one question ("is this book concentrated?") would
 * be five chances for the charts to disagree about which rows they counted.
 */
export async function getConcentration(
  organizationId: string,
  filter: AnalyticsFilter,
): Promise<AnalyticsConcentration> {
  const [period, currency] = await Promise.all([
    resolvePeriod(organizationId, filter.snapshotId),
    organizationCurrency(organizationId),
  ]);
  const rows = await loadResultSlice(period.run?.id ?? null, filter);
  const total = totalOf(rows);

  const slices: ConcentrationSlice[] = CONCENTRATION_DIMENSIONS.map((dimension) => {
    const ranked = tallyBy(rows, DIMENSION_VALUE[dimension]).sort(byAllowanceDesc);
    // Ratings are never folded: the scale has exactly ten grades, and merging
    // the weakest ones into "Other" would hide precisely the tail a credit
    // concentration chart exists to show.
    const uncapped = dimension === 'rating';
    const visible = uncapped ? ranked : ranked.slice(0, MAX_BUCKETS);
    const remainder = uncapped ? [] : ranked.slice(MAX_BUCKETS);

    const otherAcc = emptyAmounts();
    for (const entry of remainder) mergeAmounts(otherAcc, entry.acc);

    const buckets = visible.map((entry) => toBucket(entry.key, entry.acc, total));
    if (dimension === 'rating') buckets.sort((a, b) => ratingRank(a.key) - ratingRank(b.key));

    const topAllowance = ranked.slice(0, 3).reduce<Dec>((acc, entry) => acc.plus(entry.acc.allowance), zero());

    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      buckets,
      otherBucket: remainder.length > 0 ? toBucket(`Other (${remainder.length})`, otherAcc, total) : null,
      topBucketShareOfAllowancePercent: ranked.length > 0 ? shareOf(ranked[0].acc.allowance, total.allowance) : null,
      topThreeShareOfAllowancePercent: shareOf(topAllowance, total.allowance),
    };
  });

  const limitations: string[] = [];
  if (!period.run) {
    limitations.push(`${period.reportingDate} has no completed run, so there is no allowance to concentrate.`);
  } else if (rows.length === 0) {
    limitations.push('No exposure in this run matches the current filters.');
  }
  const filtersApplied = describeFilters(filter);
  for (const dimension of filtersApplied) {
    const narrowed = CONCENTRATION_DIMENSIONS.find((candidate) => dimension.startsWith(`${DIMENSION_LABELS[candidate]}:`));
    if (narrowed) {
      limitations.push(`The ${DIMENSION_LABELS[narrowed].toLowerCase()} slice has one bucket because the filter already narrows by it.`);
    }
  }

  return { currency, reportingDate: period.reportingDate, runPublicId: period.run?.publicId ?? null, slices, limitations };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * What is producing the allowance: the largest exposures, the segments they
 * belong to, and the staging rules that put them where they are.
 *
 * The rule counts come from each result's frozen `staging` decision rather than
 * from the live assessment, so "why is this book staged the way it is" is
 * answered about the run being displayed and not about whatever ran since.
 */
export async function getDrivers(
  organizationId: string,
  filter: AnalyticsFilter,
  limit: number,
): Promise<AnalyticsDrivers> {
  const [period, currency] = await Promise.all([
    resolvePeriod(organizationId, filter.snapshotId),
    organizationCurrency(organizationId),
  ]);
  const rows = await loadResultSlice(period.run?.id ?? null, filter);
  const total = totalOf(rows);

  const staged = rows.map((row) => ({ row, decision: stagingOf(row.staging) }));
  const ranked = [...staged].sort((a, b) => b.row.lossAllowance.comparedTo(a.row.lossAllowance));
  const top = ranked.slice(0, limit);

  const topExposures: DriverExposure[] = top.map(({ row, decision }) => ({
    exposurePublicId: row.exposure.publicId,
    borrowerName: row.exposure.borrower.name,
    segment: row.exposure.segment,
    stage: stageOf(row.stage),
    grossCarryingAmount: moneyToString(dec(row.grossCarryingAmount.toString())),
    lossAllowance: moneyToString(allowanceOf(row)),
    coverageRatio: rateToString(dec(row.coverageRatio.toString())),
    shareOfTotalAllowancePercent: shareOf(allowanceOf(row), total.allowance),
    daysPastDue: row.exposure.daysPastDue,
    currentCreditRating: row.exposure.currentCreditRating,
    primaryRuleCode: decision?.primaryRuleCode ?? 'NOT_RECORDED',
    primaryReason: decision?.primaryReason ?? 'This result carries no staging decision, so the reason it is in this stage is not recorded.',
  }));

  const bySegment = tallyBy(rows, (row) => row.exposure.segment)
    .sort(byAllowanceDesc)
    .map(({ key, acc }) => ({
      key,
      lossAllowance: moneyToString(acc.allowance),
      shareOfAllowancePercent: shareOf(acc.allowance, total.allowance),
    }));

  const stagingRules: StagingRuleContribution[] = tallyBy(
    staged.map(({ row, decision }) => ({ ...row, ruleCode: decision?.primaryRuleCode ?? 'NOT_RECORDED' })),
    (row) => `${row.ruleCode}|${row.stage}`,
  )
    .map(({ key, acc }) => {
      const [code, stage] = key.split('|');
      return {
        code,
        stage: stageOf(Number(stage)),
        exposureCount: acc.count,
        lossAllowance: moneyToString(acc.allowance),
        shareOfAllowancePercent: shareOf(acc.allowance, total.allowance),
      };
    })
    .sort((a, b) => b.exposureCount - a.exposureCount || Number(dec(b.lossAllowance)) - Number(dec(a.lossAllowance)));

  const topAllowance = top.reduce<Dec>((acc, { row }) => acc.plus(allowanceOf(row)), zero());

  const limitations: string[] = [];
  if (!period.run) {
    limitations.push(`${period.reportingDate} has no completed run, so there are no drivers to rank.`);
  } else if (rows.length === 0) {
    limitations.push('No exposure in this run matches the current filters, so there are no drivers to rank.');
  } else if (rows.length > top.length) {
    limitations.push(`Showing the ${top.length} largest of ${rows.length} exposures in run ${period.run.publicId}.`);
  }

  return {
    currency,
    reportingDate: period.reportingDate,
    runPublicId: period.run?.publicId ?? null,
    totalLossAllowance: moneyToString(total.allowance),
    topExposures,
    topExposuresShareOfAllowancePercent: shareOf(topAllowance, total.allowance),
    bySegment,
    stagingRules,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/**
 * Everything the global filter bar needs, in one call.
 *
 * Counts are per selected reporting period, because a value that exists in the
 * book at one date may not exist at another — a segment that was derecognised,
 * say — and offering it produces nothing but an empty state.
 */
export async function getPortfolioFilters(
  organizationId: string,
  snapshotId?: string,
): Promise<PortfolioFilters> {
  const period = await resolvePeriod(organizationId, snapshotId);

  const [snapshots, runs, exposures] = await Promise.all([
    prisma.portfolioSnapshot.findMany({
      where: { organizationId },
      orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
      select: PERIOD_SNAPSHOT_SELECT,
    }),
    prisma.eclRun.findMany({
      where: { organizationId, status: { in: RESULT_BEARING_STATUSES } },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      select: { snapshotId: true, publicId: true, status: true },
    }),
    prisma.exposure.findMany({
      where: { organizationId, snapshotId: period.snapshotId },
      select: {
        segment: true,
        productType: true,
        region: true,
        industry: true,
        currentCreditRating: true,
        stagingAssessments: { where: { runId: null }, select: { stage: true }, take: 1 },
      },
    }),
  ]);

  const runBySnapshot = new Map<string, { publicId: string; status: string }>();
  for (const run of runs) {
    if (!runBySnapshot.has(run.snapshotId)) runBySnapshot.set(run.snapshotId, run);
  }

  const periods: ReportingPeriodOption[] = snapshots.map((snapshot) => {
    const run = runBySnapshot.get(snapshot.id);
    return {
      snapshotId: snapshot.publicId,
      label: snapshot.label,
      reportingDate: dateStr(snapshot.asOfDate),
      exposureCount: snapshot.exposureCount,
      hasResults: run !== undefined,
      runPublicId: run?.publicId ?? null,
      runStatus: run?.status ?? null,
    };
  });

  type ExposureOptionRow = (typeof exposures)[number];
  const tally = (pick: (row: ExposureOptionRow) => string): FilterOption[] => {
    const counts = new Map<string, number>();
    for (const row of exposures) {
      const value = pick(row);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  // Counted from the live assessment only, because that is what the ledger's
  // stage filter matches on. An exposure never assessed is *shown* as stage 1
  // but is not *returned* by a stage filter, so counting it here would promise
  // rows the filter cannot produce.
  const stageCounts: Record<Stage, number> = { 1: 0, 2: 0, 3: 0 };
  for (const row of exposures) {
    const assessment = row.stagingAssessments[0];
    if (assessment) stageCounts[stageOf(assessment.stage)] += 1;
  }

  return {
    periods,
    segments: tally((row) => row.segment),
    productTypes: tally((row) => row.productType),
    regions: tally((row) => row.region),
    industries: tally((row) => row.industry),
    ratings: tally((row) => row.currentCreditRating).sort((a, b) => ratingRank(a.value) - ratingRank(b.value)),
    stages: STAGES.map((stage) => ({ stage, count: stageCounts[stage] })),
  };
}

// ---------------------------------------------------------------------------
// Defaults for the three comparison aggregates
//
// The scenario, migration and run-comparison functions above take explicit ids
// because the copilot's tools are handed ids by the model. The dashboard has no
// ids to hand: it opens on the newest period and compares against the one
// before it. These resolve that default so the two callers share one
// aggregation rather than two implementations of the same question.
// ---------------------------------------------------------------------------

/** Scenario split of the selected period's run, or of an explicitly named run. */
export async function getScenariosForPeriod(
  organizationId: string,
  snapshotId?: string,
  runId?: string,
): Promise<AnalyticsScenarios> {
  if (runId) return getScenarioComparison(organizationId, runId);
  const period = await resolvePeriod(organizationId, snapshotId);
  if (!period.run) {
    throw notFound(`${period.reportingDate} has no completed run, so there is no scenario split to show`);
  }
  return getScenarioComparison(organizationId, period.run.publicId);
}

/** Stage migration between two periods, defaulting to the two newest with results. */
export async function getMigrationForPeriods(
  organizationId: string,
  fromSnapshotId?: string,
  toSnapshotId?: string,
): Promise<AnalyticsMigration> {
  const to = await resolvePeriod(organizationId, toSnapshotId);
  const from = fromSnapshotId
    ? await resolvePeriod(organizationId, fromSnapshotId)
    : await resolvePreviousPeriod(organizationId, to);
  if (!from) {
    throw notFound(`${to.reportingDate} is the earliest reporting period, so there is no prior period to migrate from`);
  }
  return getStageMigration(organizationId, from.snapshotPublicId, to.snapshotPublicId);
}

/**
 * Run diff for the run detail page.
 *
 * With no ids: the selected period's run against the period before it. An
 * explicit `comparisonRunId` without a `baseRunId` still compares against the
 * selected period's predecessor, so a caller overriding one side should
 * override both.
 */
export async function getRunComparison(
  organizationId: string,
  query: RunComparisonQuery,
): Promise<RunComparison> {
  const period = await resolvePeriod(organizationId, query.snapshotId);
  if (!period.run) {
    throw notFound(`${period.reportingDate} has no completed run, so there is nothing to compare`);
  }
  const baseRunId = query.baseRunId ?? (await resolvePreviousPeriod(organizationId, period))?.run?.publicId;
  if (!baseRunId) {
    throw notFound(
      `${period.reportingDate} is the earliest reporting period with a completed run, so there is no prior run to compare against`,
    );
  }
  return compareRuns(organizationId, baseRunId, query.comparisonRunId ?? period.run.publicId);
}
