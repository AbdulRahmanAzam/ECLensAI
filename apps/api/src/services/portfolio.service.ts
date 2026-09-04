/**
 * Portfolio reads: the exposure ledger, one exposure in full, and the summary.
 *
 * Two conventions make the list endpoints exact rather than approximate:
 *
 *   • The **current** staging of an exposure is its `StagingAssessment` row with
 *     `runId: null`. There is exactly one per exposure — re-assessment replaces
 *     it — so a `stage` filter can be pushed into SQL and still agree with
 *     pagination. Run-scoped assessments (`runId` set) are the immutable
 *     per-run record and are never used for filtering.
 *   • The **current** result of an exposure is its `EclResult` from the newest
 *     run that produced results. That run is resolved once per page, so every
 *     row is compared against the same baseline.
 *
 * Money and rates leave this module only as strings rendered by `mappers.ts`.
 * The few aggregates computed here (segment breakdown, EAD per schedule period)
 * accumulate in Decimal, never in binary float.
 */
import type { Prisma } from '@prisma/client';
import {
  ROUNDING_POLICY,
  dec,
  moneyToString,
  periodEad,
  rateToDisplayString,
  rateToString,
  zero,
  type AuditEventRecord,
  type EclLineage,
  type ExposureDetailRecord,
  type ExposureRecord,
  type HighRiskExposureRecord,
  type ListQuery,
  type Paginated,
  type PortfolioSnapshotRecord,
  type PortfolioSummaryRecord,
  type PortfolioTotalsDto,
  type RunStatus,
  type SegmentBreakdownRecord,
  type SimplifiedEadProfile,
  type StagingDecision,
  type StagingRuleCode,
  type TriggeredStagingRule,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { notFound } from '../utils/httpError';
import {
  dateStr,
  jsonAs,
  moneyStr,
  rateStr,
  stageOf,
  toAuditEventRecord,
  toExceptionItemRecord,
  toPortfolioSnapshotRecord,
  toStageOverrideHistoryRecord,
} from './mappers';
import {
  toExposureRunResultRecord,
  type ResultRow,
} from './result-mappers';

/** Run statuses whose persisted results a reader can rely on. */
export const RESULT_BEARING_STATUSES: RunStatus[] = ['COMPLETED', 'SUBMITTED', 'APPROVED', 'REJECTED'];

const EXPOSURE_SORT_COLUMNS = [
  'publicId',
  'segment',
  'productType',
  'grossCarryingAmount',
  'undrawnCommitment',
  'daysPastDue',
  'effectiveInterestRate',
  'twelveMonthPd',
  'lifetimePd',
  'lgd',
  'currentCreditRating',
  'maturityDate',
  'reportingDate',
  'originationDate',
  'createdAt',
] as const;

/** The exposure columns a result read needs, matching `ResultRow['exposure']`. */
export const resultExposureSelect = {
  id: true,
  publicId: true,
  segment: true,
  currency: true,
  lgd: true,
  borrower: { select: { name: true } },
} satisfies Prisma.ExposureSelect;

const exposureInclude = {
  snapshot: { select: { publicId: true, label: true, inputVersion: true } },
  borrower: { select: { id: true, publicId: true, name: true } },
  pdTermStructure: { select: { id: true } },
  _count: { select: { eadSchedule: true } },
  // runId: null is the live assessment; take 1 so the shape stays an array.
  stagingAssessments: {
    where: { runId: null },
    orderBy: { assessedAt: 'desc' },
    take: 1,
  },
  stageOverrides: {
    where: { reviewerStatus: { not: 'REJECTED' } },
    orderBy: { occurredAt: 'desc' },
    take: 1,
    select: { id: true },
  },
} satisfies Prisma.ExposureInclude;

type ExposureRow = Prisma.ExposureGetPayload<{ include: typeof exposureInclude }>;

function ruleCodesOf(assessment: { triggeredRules: Prisma.JsonValue } | undefined): StagingRuleCode[] {
  if (!assessment) return [];
  return jsonAs<TriggeredStagingRule[]>(assessment.triggeredRules, [])
    .map((rule) => rule.code)
    .filter((code): code is StagingRuleCode => typeof code === 'string' && code.length > 0);
}

/** The newest run that actually produced results, optionally within a snapshot. */
export async function latestResultBearingRun(organizationId: string, snapshotId?: string) {
  return prisma.eclRun.findFirst({
    where: {
      organizationId,
      status: { in: RESULT_BEARING_STATUSES },
      ...(snapshotId ? { snapshot: { OR: [{ id: snapshotId }, { publicId: snapshotId }] } } : {}),
    },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, publicId: true, lineage: true, totals: true },
  });
}

async function latestResultsByExposure(
  runId: string | null,
  exposureIds: string[],
): Promise<Map<string, ResultRow>> {
  if (!runId || exposureIds.length === 0) return new Map();
  const rows = await prisma.eclResult.findMany({
    where: { runId, exposureId: { in: exposureIds } },
    include: { exposure: { select: resultExposureSelect }, scenarioResults: true },
  });
  return new Map(rows.map((row) => [row.exposureId, row as unknown as ResultRow]));
}

function toExposureRecord(
  row: ExposureRow,
  latest: ResultRow | null,
  runPublicId: string | null,
): ExposureRecord {
  const assessment = row.stagingAssessments[0];
  const override = row.stageOverrides[0];

  return {
    id: row.publicId,
    publicId: row.publicId,
    snapshotId: row.snapshot.publicId,
    snapshotLabel: row.snapshot.label,
    inputVersion: row.snapshot.inputVersion,
    borrowerId: row.borrower.publicId,
    borrowerName: row.borrower.name,
    segment: row.segment,
    productType: row.productType,
    originationDate: dateStr(row.originationDate),
    maturityDate: dateStr(row.maturityDate),
    reportingDate: dateStr(row.reportingDate),
    currency: row.currency,
    grossCarryingAmount: moneyStr(row.grossCarryingAmount),
    undrawnCommitment: moneyStr(row.undrawnCommitment),
    creditConversionFactor: rateStr(row.creditConversionFactor),
    effectiveInterestRate: rateStr(row.effectiveInterestRate),
    daysPastDue: row.daysPastDue,
    originalCreditRating: row.originalCreditRating,
    currentCreditRating: row.currentCreditRating,
    twelveMonthPd: rateStr(row.twelveMonthPd),
    lifetimePd: rateStr(row.lifetimePd),
    pdAtOrigination: rateStr(row.pdAtOrigination),
    lgd: rateStr(row.lgd),
    collateralValue: moneyStr(row.collateralValue),
    defaultFlag: row.defaultFlag,
    creditImpairedFlag: row.creditImpairedFlag,
    forbearanceFlag: row.forbearanceFlag,
    restructuringFlag: row.restructuringFlag,
    watchlistFlag: row.watchlistFlag,
    region: row.region,
    industry: row.industry,
    hasContractualSchedule: row._count.eadSchedule > 0,
    hasPdTermStructure: row.pdTermStructure !== null,
    simplifiedEadProfile: row.simplifiedEadProfile as SimplifiedEadProfile,
    // Until the first assessment exists the exposure has no modelled stage;
    // Stage 1 is shown because nothing has evidenced a significant increase.
    currentStage: assessment ? stageOf(assessment.stage) : 1,
    stagePrimaryReason: assessment ? assessment.primaryReason : 'Not yet assessed',
    stageRuleCodes: ruleCodesOf(assessment),
    hasStageOverride: Boolean(assessment?.hasOverride) || Boolean(override),
    latestRunId: latest ? runPublicId : null,
    latestLossAllowance: latest ? moneyStr(latest.lossAllowance) : null,
    latestNetCarryingAmount: latest ? moneyStr(latest.netCarryingAmount) : null,
    latestCoverageRatio: latest ? rateStr(latest.coverageRatio) : null,
  };
}

/**
 * The snapshot a reader means when they do not name one: the newest.
 *
 * `Exposure.publicId` is unique only within its snapshot, so once the book carries
 * several reporting dates an unscoped read returns the same loan once per period
 * and every count disagrees with the run it is displayed next to. Point-in-time
 * reads therefore default to the latest snapshot, which is also the period the
 * dashboard, the explorer and the run detail page are showing.
 */
export async function resolveSnapshotId(
  organizationId: string,
  snapshotId?: string,
): Promise<string | undefined> {
  if (snapshotId) return snapshotId;
  const latest = await prisma.portfolioSnapshot.findFirst({
    where: { organizationId },
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return latest?.id;
}

function exposureFilters(
  organizationId: string,
  query: ListQuery,
  snapshotId?: string,
): Prisma.ExposureWhereInput {
  const where: Prisma.ExposureWhereInput = { organizationId };

  if (snapshotId) {
    where.snapshot = { OR: [{ id: snapshotId }, { publicId: snapshotId }] };
  }
  if (query.segment) where.segment = query.segment;
  if (query.productType) where.productType = query.productType;
  if (query.region) where.region = query.region;
  if (query.industry) where.industry = query.industry;
  if (query.rating) where.currentCreditRating = query.rating;
  if (query.stage) {
    where.stagingAssessments = { some: { runId: null, stage: query.stage } };
  }

  const term = query.search?.trim();
  if (term) {
    const columns = containsSearch(term, ['publicId', 'segment', 'productType', 'region', 'industry']) ?? [];
    where.OR = [...columns, { borrower: { name: { contains: term } } }];
  }

  return where;
}

export async function listExposures(
  organizationId: string,
  query: ListQuery,
): Promise<Paginated<ExposureRecord>> {
  const snapshotId = await resolveSnapshotId(organizationId, query.snapshotId);
  const where = exposureFilters(organizationId, query, snapshotId);
  const { skip, take } = toPageArgs(query);

  const [totalItems, rows] = await prisma.$transaction([
    prisma.exposure.count({ where }),
    prisma.exposure.findMany({
      where,
      include: exposureInclude,
      orderBy: orderBy(query.sortBy, query.sortDir, EXPOSURE_SORT_COLUMNS, { publicId: 'asc' }),
      skip,
      take,
    }),
  ]);

  const run = await latestResultBearingRun(organizationId, snapshotId);
  const latest = await latestResultsByExposure(
    run?.id ?? null,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) => toExposureRecord(row, latest.get(row.id) ?? null, run?.publicId ?? null)),
    meta: buildPageMeta(query, totalItems),
  };
}

/** Upper bound so an unbounded filter cannot turn an export into an outage. */
const MAX_EXPORT_ROWS = 10_000;

const EXPORT_COLUMNS = [
  'publicId',
  'borrowerName',
  'segment',
  'productType',
  'currentStage',
  'stagePrimaryReason',
  'grossCarryingAmount',
  'daysPastDue',
  'currentCreditRating',
  'lgd',
  'latestLossAllowance',
  'latestCoverageRatio',
  'region',
  'industry',
] as const;

/** Quotes a cell only when it needs it — matches RFC 4180 without over-escaping plain values. */
function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The same filtered, sorted set `listExposures` would page through, as one
 * CSV covering every matching row rather than one page of them — "export"
 * means the full scope on screen, not what happened to be rendered.
 */
export async function exportExposuresCsv(actor: AuditActor, query: ListQuery): Promise<{ csv: string; rowCount: number }> {
  const organizationId = actor.organizationId;
  const snapshotId = await resolveSnapshotId(organizationId, query.snapshotId);
  const where = exposureFilters(organizationId, query, snapshotId);

  const rows = await prisma.exposure.findMany({
    where,
    include: exposureInclude,
    orderBy: orderBy(query.sortBy, query.sortDir, EXPOSURE_SORT_COLUMNS, { publicId: 'asc' }),
    take: MAX_EXPORT_ROWS,
  });

  const run = await latestResultBearingRun(organizationId, snapshotId);
  const latest = await latestResultsByExposure(run?.id ?? null, rows.map((row) => row.id));
  const records = rows.map((row) => toExposureRecord(row, latest.get(row.id) ?? null, run?.publicId ?? null));

  const lines = [
    EXPORT_COLUMNS.join(','),
    ...records.map((record) => EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(',')),
  ];

  await recordAudit({
    organizationId,
    actor,
    action: 'PORTFOLIO.EXPORTED',
    entityType: 'PortfolioSnapshot',
    entityId: snapshotId ?? 'unscoped',
    detail: `Exported ${records.length} exposure row(s) as CSV${query.search ? ` matching '${query.search}'` : ''}.`,
  });

  return { csv: lines.join('\r\n'), rowCount: records.length };
}

/**
 * Loads one exposure by publicId (preferred) or internal id, org-scoped.
 *
 * `publicId` repeats across snapshots — the same loan exists at each reporting
 * date — so a caller that knows the period it is drilling from should pass it.
 * Without one the newest snapshot wins, which is the period every unscoped
 * screen is showing.
 */
export async function findExposure(
  organizationId: string,
  idOrPublicId: string,
  snapshotId?: string,
): Promise<ExposureRow> {
  const row = await prisma.exposure.findFirst({
    where: {
      organizationId,
      OR: [{ publicId: idOrPublicId }, { id: idOrPublicId }],
      ...(snapshotId ? { snapshot: { OR: [{ id: snapshotId }, { publicId: snapshotId }] } } : {}),
    },
    include: exposureInclude,
    orderBy: [{ snapshot: { asOfDate: 'desc' } }, { createdAt: 'desc' }],
  });
  if (!row) throw notFound('Exposure not found');
  return row;
}

const UNASSESSED_STAGING: StagingDecision = {
  stage: 1,
  modelStage: 1,
  primaryReason: 'Not yet assessed — commit an import or execute a run',
  primaryRuleCode: 'NO_SICR_OBSERVED',
  triggeredRules: [],
  ruleSetId: '',
  ruleSetVersion: '',
  hasOverride: false,
  override: null,
};

function toStagingDecision(row: {
  stage: number;
  modelStage: number;
  primaryReason: string;
  primaryRuleCode: string;
  triggeredRules: Prisma.JsonValue;
  ruleSetId: string;
  ruleSetVersion: string;
  hasOverride: boolean;
}): StagingDecision {
  return {
    stage: stageOf(row.stage),
    modelStage: stageOf(row.modelStage),
    primaryReason: row.primaryReason,
    primaryRuleCode: row.primaryRuleCode as StagingDecision['primaryRuleCode'],
    triggeredRules: jsonAs<TriggeredStagingRule[]>(row.triggeredRules, []),
    ruleSetId: row.ruleSetId,
    ruleSetVersion: row.ruleSetVersion,
    hasOverride: row.hasOverride,
    override: null,
  };
}

export async function getExposureDetail(
  organizationId: string,
  idOrPublicId: string,
  snapshotId?: string,
): Promise<ExposureDetailRecord> {
  const row = await findExposure(organizationId, idOrPublicId, snapshotId);

  const [
    eadSchedule,
    pdTermStructure,
    overrides,
    exceptions,
    auditTrail,
    latestResult,
    runScopedAssessment,
    liveAssessment,
  ] = await Promise.all([
    prisma.exposureEadPeriod.findMany({ where: { exposureId: row.id }, orderBy: { period: 'asc' } }),
    prisma.exposurePdTermStructure.findUnique({ where: { exposureId: row.id } }),
    prisma.stageOverride.findMany({
      where: { organizationId, exposureId: row.id },
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.exceptionItem.findMany({
      where: { organizationId, exposureId: row.id },
      include: { exposure: { select: { publicId: true, borrower: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.auditEvent.findMany({
      where: { organizationId, entityType: 'EXPOSURE', entityId: row.publicId },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    }),
    prisma.eclResult.findFirst({
      where: { exposureId: row.id, run: { organizationId, status: { in: RESULT_BEARING_STATUSES } } },
      orderBy: { createdAt: 'desc' },
      include: {
        exposure: { select: resultExposureSelect },
        scenarioResults: { orderBy: { scenarioCode: 'asc' }, include: { periods: { orderBy: { period: 'asc' } } } },
        run: { select: { publicId: true, lineage: true } },
      },
    }),
    prisma.stagingAssessment.findFirst({
      where: { exposureId: row.id, runId: { not: null } },
      orderBy: { assessedAt: 'desc' },
    }),
    prisma.stagingAssessment.findFirst({ where: { exposureId: row.id, runId: null }, orderBy: { assessedAt: 'desc' } }),
  ]);

  const assessment = runScopedAssessment ?? liveAssessment;
  const resultRow = latestResult as unknown as (ResultRow & { run: { publicId: string; lineage: Prisma.JsonValue } }) | null;
  const latestRecord = resultRow ? toExposureRunResultRecord(resultRow, resultRow.run.publicId) : null;

  return {
    exposure: toExposureRecord(row, resultRow, resultRow?.run.publicId ?? null),
    staging: assessment ? toStagingDecision(assessment) : UNASSESSED_STAGING,
    latestResult: latestRecord,
    eadSchedule: eadSchedule.map((point) => ({
      period: point.period,
      drawnBalance: moneyStr(point.drawnBalance),
      undrawnCommitment: moneyStr(point.undrawnCommitment),
      creditConversionFactor: rateStr(row.creditConversionFactor),
      // Derived with the engine's own EAD formula (drawn + CCF x undrawn) in
      // Decimal, so the schedule shown here cannot disagree with the run.
      ead: moneyStr(periodEad(point.drawnBalance, point.undrawnCommitment, row.creditConversionFactor)),
    })),
    pdTermStructure: pdTermStructure
      ? {
          basis: pdTermStructure.basis,
          points: jsonAs<Array<{ period: number; pd: unknown }>>(pdTermStructure.points, []).map((point) => ({
            period: point.period,
            pd: String(point.pd),
          })),
        }
      : null,
    overrideHistory: overrides.map(toStageOverrideHistoryRecord),
    exceptions: exceptions.map(toExceptionItemRecord),
    lineage: resultRow ? jsonAs<EclLineage | null>(resultRow.run.lineage, null) : null,
    auditTrail: auditTrail.map((event): AuditEventRecord => toAuditEventRecord(event)),
  };
}

export async function listSnapshots(organizationId: string, take = 50): Promise<PortfolioSnapshotRecord[]> {
  const rows = await prisma.portfolioSnapshot.findMany({
    where: { organizationId },
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    take,
  });
  return rows.map(toPortfolioSnapshotRecord);
}

interface SegmentAccumulator {
  segment: string;
  exposureCount: number;
  gross: ReturnType<typeof zero>;
  allowance: ReturnType<typeof zero>;
  stage3Count: number;
}

function toSegmentBreakdown(accumulator: SegmentAccumulator): SegmentBreakdownRecord {
  const coverage = accumulator.gross.isZero()
    ? zero()
    : accumulator.allowance.dividedBy(accumulator.gross);
  return {
    segment: accumulator.segment,
    exposureCount: accumulator.exposureCount,
    grossCarryingAmount: moneyToString(accumulator.gross),
    lossAllowance: moneyToString(accumulator.allowance),
    coverageRatio: rateToString(coverage),
    stage3Count: accumulator.stage3Count,
  };
}

function riskReason(result: {
  stage: number;
  coverageRatio: Prisma.Decimal;
  exposure: { daysPastDue: number; currentCreditRating: string };
}): string {
  const parts = [`Stage ${result.stage}`];
  if (result.exposure.daysPastDue > 0) parts.push(`${result.exposure.daysPastDue} days past due`);
  parts.push(`rated ${result.exposure.currentCreditRating}`);
  // Prose, so display precision: the 10dp wire format would print "27.3361467600%".
  parts.push(`allowance covers ${rateToDisplayString(dec(result.coverageRatio).times(100), 2)}% of gross`);
  return parts.join(', ');
}

/** Stage first, then delinquency, then coverage: the ordering a reviewer uses. */
function riskScore(result: {
  stage: number;
  lossAllowance: Prisma.Decimal;
  coverageRatio: Prisma.Decimal;
  exposure: { daysPastDue: number };
}): string {
  return [
    String(result.stage),
    String(Math.min(result.exposure.daysPastDue, 999)).padStart(3, '0'),
    result.coverageRatio.toFixed(12),
    result.lossAllowance.toFixed(2).padStart(20, '0'),
  ].join('|');
}

export interface RunSummaryRow {
  id: string;
  publicId: string;
  runDate: Date;
  status: string;
  createdBy: string;
  completedAt: Date | null;
  totals: Prisma.JsonValue | null;
  modelConfiguration: { version: string };
  scenarioSet: { version: string };
}

export const runSummaryInclude = {
  modelConfiguration: { select: { version: true } },
  scenarioSet: { select: { version: true } },
} satisfies Prisma.EclRunInclude;

export function toRunSummaryRecord(row: RunSummaryRow) {
  const totals = jsonAs<PortfolioTotalsDto | null>(row.totals, null);
  return {
    id: row.publicId,
    publicId: row.publicId,
    runDate: dateStr(row.runDate),
    status: row.status as RunStatus,
    createdByName: row.createdBy,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    totalLossAllowance: totals?.totalLossAllowance ?? null,
    coverageRatio: totals?.coverageRatio ?? null,
    modelConfigurationVersion: row.modelConfiguration.version,
    scenarioSetVersion: row.scenarioSet.version,
  };
}

/**
 * Portfolio summary.
 *
 * The authoritative totals are read back from the newest result-bearing run's
 * persisted `totals` JSON rather than recomputed here, so this page can never
 * disagree with the run detail page. When no run exists yet the snapshot's own
 * aggregates are shown with a zero allowance and `lineage: null`, which the
 * client renders as "awaiting first run".
 */
export async function getPortfolioSummary(
  organizationId: string,
  snapshotId?: string,
): Promise<PortfolioSummaryRecord> {
  const snapshot = await prisma.portfolioSnapshot.findFirst({
    where: { organizationId, ...(snapshotId ? { OR: [{ id: snapshotId }, { publicId: snapshotId }] } : {}) },
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
  });
  if (!snapshot) throw notFound('No portfolio snapshot found for this organization');

  const [organization, run, trend, exceptionGroups, recentRuns] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } }),
    prisma.eclRun.findFirst({
      where: { organizationId, snapshotId: snapshot.id, status: { in: RESULT_BEARING_STATUSES } },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      include: runSummaryInclude,
    }),
    listSnapshots(organizationId, 12),
    prisma.exceptionItem.groupBy({ by: ['kind', 'status'], where: { organizationId }, _count: { _all: true } }),
    prisma.eclRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: runSummaryInclude,
    }),
  ]);

  const currency = organization?.currency ?? 'PKR';

  const runResults = run
    ? ((await prisma.eclResult.findMany({
        where: { runId: run.id },
        include: {
          exposure: {
            select: {
              publicId: true,
              segment: true,
              daysPastDue: true,
              currentCreditRating: true,
              borrower: { select: { name: true } },
            },
          },
        },
      })) as unknown as Array<
        Pick<
          ResultRow,
          'stage' | 'grossCarryingAmount' | 'lossAllowance' | 'coverageRatio' | 'scenarioResults'
        > & {
          exposure: {
            publicId: string;
            segment: string;
            daysPastDue: number;
            currentCreditRating: string;
            borrower: { name: string };
          };
        }
      >)
    : [];

  const segments = new Map<string, SegmentAccumulator>();
  for (const result of runResults) {
    const accumulator = segments.get(result.exposure.segment) ?? {
      segment: result.exposure.segment,
      exposureCount: 0,
      gross: zero(),
      allowance: zero(),
      stage3Count: 0,
    };
    accumulator.exposureCount += 1;
    accumulator.gross = accumulator.gross.plus(dec(result.grossCarryingAmount.toString()));
    accumulator.allowance = accumulator.allowance.plus(dec(result.lossAllowance.toString()));
    if (result.stage === 3) accumulator.stage3Count += 1;
    segments.set(accumulator.segment, accumulator);
  }
  const segmentBreakdown = [...segments.values()].map(toSegmentBreakdown).sort((a, b) => b.exposureCount - a.exposureCount);

  const highRisk: HighRiskExposureRecord[] = runResults
    .map((result) => ({ result, key: riskScore(result) }))
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .slice(0, 8)
    .map(({ result }) => ({
      exposureId: result.exposure.publicId,
      exposurePublicId: result.exposure.publicId,
      borrowerName: result.exposure.borrower.name,
      segment: result.exposure.segment,
      stage: stageOf(result.stage),
      daysPastDue: result.exposure.daysPastDue,
      currentCreditRating: result.exposure.currentCreditRating,
      grossCarryingAmount: moneyStr(result.grossCarryingAmount),
      lossAllowance: moneyStr(result.lossAllowance),
      riskReason: riskReason(result),
    }));

  const exceptionCounts: Record<string, number> = {};
  let openExceptionCount = 0;
  for (const group of exceptionGroups) {
    exceptionCounts[group.kind] = (exceptionCounts[group.kind] ?? 0) + group._count._all;
    if (group.status === 'OPEN') openExceptionCount += group._count._all;
  }

  const persistedTotals = run ? jsonAs<PortfolioTotalsDto | null>(run.totals, null) : null;
  const totals: PortfolioTotalsDto = persistedTotals ?? {
    currency,
    exposureCount: snapshot.exposureCount,
    totalGrossCarryingAmount: moneyStr(snapshot.totalGrossExposure),
    totalEad: moneyStr(snapshot.totalGrossExposure),
    totalLossAllowance: '0.00',
    totalNetCarryingAmount: moneyStr(snapshot.totalGrossExposure),
    coverageRatio: '0.0000000000',
    stageBuckets: [],
    stageDistribution: {
      1: { balance: moneyStr(snapshot.totalGrossExposure), ecl: '0.00', count: snapshot.exposureCount },
      2: { balance: '0.00', ecl: '0.00', count: 0 },
      3: { balance: '0.00', ecl: '0.00', count: 0 },
    },
    roundingPolicy: ROUNDING_POLICY,
  };

  return {
    asOf: dateStr(snapshot.asOfDate),
    currency,
    snapshotId: snapshot.publicId,
    snapshotLabel: snapshot.label,
    totals,
    segmentBreakdown,
    trend: [...trend].reverse(),
    highRisk,
    recentRuns: recentRuns.map(toRunSummaryRecord),
    exceptionCounts,
    openExceptionCount,
    lineage: run ? jsonAs<EclLineage | null>(run.lineage, null) : null,
  };
}
