/**
 * Dashboard analytics aggregates against the seeded three-period book.
 *
 * The property under test is not that these endpoints return 200. It is that
 * every figure they publish is the *same* figure the run that produced it
 * publishes, and that a filter narrows to exactly the rows it names — because a
 * dashboard that quietly disagrees with the run page is worse than no dashboard.
 *
 * So each assertion compares the HTTP response against an independent fold of
 * the result rows read straight from Prisma and summed in Decimal inside this
 * file. Two implementations of "the allowance of this book" agreeing to the cent
 * is evidence; one implementation agreeing with itself is not. Responses are
 * typed with the shared contract rather than `any`, so a field the endpoint
 * stopped sending fails to compile here instead of silently asserting nothing.
 *
 * Where an exact match is impossible by construction the test says so and bounds
 * the drift instead of loosening the assertion quietly. That applies to EAD and
 * to the scenario split, both rounded per row on the way into `Decimal(24,2)`
 * while the run's headline was rounded once at the end.
 *
 * Skipped, not failed, when no seeded database is reachable.
 */
import type { RoleName, RunStatus } from '@prisma/client';
import {
  CONCENTRATION_DIMENSIONS,
  DEMO_ORGANIZATION,
  DEMO_PASSWORD,
  DEMO_USERS,
  MAX_PAGE_SIZE,
  MOVEMENT_COMPONENT_CODES,
  RATING_SCALE,
  dec,
  moneyToString,
  rateToString,
  zero,
  type AnalyticsConcentration,
  type AnalyticsDrivers,
  type AnalyticsMigration,
  type AnalyticsScenarios,
  type AnalyticsSummary,
  type AnalyticsTrend,
  type Dec,
  type MovementBridge,
  type PortfolioFilters,
  type PortfolioTotalsDto,
  type RunComparison,
} from '@eclens/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted above the imports: `config/env.ts` parses `process.env` once at module
// load, so the limits have to be raised before `createApp` is ever imported.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.LOG_LEVEL = 'fatal';
});

const { createApp } = await import('../src/app');
const { prisma } = await import('../src/lib/prisma');
const { newId, newPublicId } = await import('../src/lib/ids');

const app = createApp();

const RESULT_BEARING: RunStatus[] = ['COMPLETED', 'SUBMITTED', 'APPROVED', 'REJECTED'];

async function seededDatabaseIsPresent(): Promise<boolean> {
  try {
    const organization = await prisma.organization.findFirst({ where: { name: DEMO_ORGANIZATION } });
    if (!organization) return false;
    // Two approved periods, not one: the movement, trend, migration and
    // comparison endpoints have nothing to measure over a single period.
    return prisma.eclRun
      .count({ where: { organizationId: organization.id, status: 'APPROVED' } })
      .then((count) => count >= 2);
  } catch {
    return false;
  }
}

const SEEDED = await seededDatabaseIsPresent();
if (!SEEDED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[analytics] skipped: no seeded database with at least two approved periods. Run `npm run db:up && npm run db:migrate && npm run db:seed` first.',
  );
}

interface SessionUser {
  id: string;
  role: RoleName;
  organizationId: string;
}

interface Session extends SessionUser {
  agent: ReturnType<typeof request.agent>;
}

async function login(email: string): Promise<Session> {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  expect(response.status, `login failed for ${email}: ${response.text}`).toBe(200);
  return { agent, ...(response.body.user as SessionUser) };
}

// ---------------------------------------------------------------------------
// The independent reference fold
// ---------------------------------------------------------------------------

interface RefRow {
  publicId: string;
  segment: string;
  productType: string;
  region: string;
  industry: string;
  rating: string;
  stage: number;
  gross: Dec;
  ead: Dec;
  allowance: Dec;
  net: Dec;
}

interface Fold {
  count: number;
  gross: Dec;
  ead: Dec;
  allowance: Dec;
  net: Dec;
  stages: Record<number, number>;
}

function fold(rows: RefRow[]): Fold {
  const acc: Fold = { count: 0, gross: zero(), ead: zero(), allowance: zero(), net: zero(), stages: { 1: 0, 2: 0, 3: 0 } };
  for (const row of rows) {
    acc.count += 1;
    acc.stages[row.stage] = (acc.stages[row.stage] ?? 0) + 1;
    acc.gross = acc.gross.plus(row.gross);
    acc.ead = acc.ead.plus(row.ead);
    acc.allowance = acc.allowance.plus(row.allowance);
    acc.net = acc.net.plus(row.net);
  }
  return acc;
}

const money = moneyToString;
const coverageOfFold = (acc: Fold): string =>
  rateToString(acc.gross.isZero() ? zero() : acc.allowance.dividedBy(acc.gross));

/** Sum of decimal strings, in Decimal — never in binary float. */
function sumStrings(values: Iterable<string | null>): Dec {
  let total = zero();
  for (const value of values) if (value !== null) total = total.plus(dec(value));
  return total;
}

const groupBy = (rows: RefRow[], pick: (row: RefRow) => string): Map<string, RefRow[]> => {
  const groups = new Map<string, RefRow[]>();
  for (const row of rows) {
    const key = pick(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
};

let demoOrganizationId: string;

async function referenceRows(runId: string): Promise<RefRow[]> {
  const rows = await prisma.eclResult.findMany({
    where: { runId },
    select: {
      stage: true,
      grossCarryingAmount: true,
      eadAtReportingDate: true,
      lossAllowance: true,
      netCarryingAmount: true,
      exposure: {
        select: {
          publicId: true,
          segment: true,
          productType: true,
          region: true,
          industry: true,
          currentCreditRating: true,
        },
      },
    },
  });
  return rows.map((row) => ({
    publicId: row.exposure.publicId,
    segment: row.exposure.segment,
    productType: row.exposure.productType,
    region: row.exposure.region,
    industry: row.exposure.industry,
    rating: row.exposure.currentCreditRating,
    stage: row.stage,
    gross: dec(row.grossCarryingAmount.toString()),
    ead: dec(row.eadAtReportingDate.toString()),
    allowance: dec(row.lossAllowance.toString()),
    net: dec(row.netCarryingAmount.toString()),
  }));
}

interface PeriodRef {
  runId: string;
  runPublicId: string;
  status: RunStatus;
  snapshotPublicId: string;
  reportingDate: string;
  totals: PortfolioTotalsDto;
  rows: RefRow[];
  folded: Fold;
}

/** Resolved from the database, not from any endpoint, so it can check one. */
async function referencePeriod(snapshotId: string): Promise<PeriodRef> {
  const [snapshot, run] = await Promise.all([
    prisma.portfolioSnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
      select: { publicId: true, asOfDate: true },
    }),
    prisma.eclRun.findFirstOrThrow({
      where: { organizationId: demoOrganizationId, snapshotId, status: { in: RESULT_BEARING } },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, publicId: true, status: true, totals: true },
    }),
  ]);
  const rows = await referenceRows(run.id);
  return {
    runId: run.id,
    runPublicId: run.publicId,
    status: run.status,
    snapshotPublicId: snapshot.publicId,
    reportingDate: snapshot.asOfDate.toISOString().slice(0, 10),
    totals: run.totals as unknown as PortfolioTotalsDto,
    rows,
    folded: fold(rows),
  };
}

describe.skipIf(!SEEDED)('analytics aggregates against the seeded database', () => {
  const demoEmail = (role: RoleName): string => DEMO_USERS.find((user) => user.role === role)!.email;

  let analyst: Session;
  let auditor: Session;
  /** The newest reporting period — what an unqualified dashboard call resolves to. */
  let current: PeriodRef;
  /** The one before it — the other side of every comparison. */
  let previous: PeriodRef;
  let snapshotCount: number;
  /** The run's totals as the run detail endpoint publishes them. */
  let runPageTotals: PortfolioTotalsDto;

  beforeAll(async () => {
    const organization = await prisma.organization.findFirstOrThrow({
      where: { name: DEMO_ORGANIZATION },
      orderBy: { createdAt: 'asc' },
    });
    demoOrganizationId = organization.id;

    [analyst, auditor] = await Promise.all([login(demoEmail('RISK_ANALYST')), login(demoEmail('AUDITOR'))]);

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: { organizationId: demoOrganizationId },
      orderBy: { asOfDate: 'desc' },
      select: { id: true },
    });
    snapshotCount = snapshots.length;
    expect(snapshotCount, 'the demo book needs at least two reporting periods').toBeGreaterThanOrEqual(2);

    current = await referencePeriod(snapshots[0].id);
    previous = await referencePeriod(snapshots[1].id);
    expect(current.status).toBe('APPROVED');
    expect(previous.status).toBe('APPROVED');
    expect(current.reportingDate > previous.reportingDate).toBe(true);

    const response = await analyst.agent
      .get(`/api/v1/ecl-runs/${current.runPublicId}/results`)
      .query({ page: 1, pageSize: MAX_PAGE_SIZE });
    expect(response.status, response.text).toBe(200);
    runPageTotals = response.body.totals as PortfolioTotalsDto;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** GETs an analytics endpoint, asserts it succeeded, and types the body. */
  async function get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const response = await analyst.agent.get(`/api/v1/analytics${path}`).query(query);
    expect(response.status, `${path} ${JSON.stringify(query)}: ${response.text}`).toBe(200);
    return response.body as T;
  }

  const componentByCode = (bridge: MovementBridge): Map<string, MovementBridge['components'][number]> =>
    new Map(bridge.components.map((component) => [component.code, component]));

  // -------------------------------------------------------------------------
  // Summary: the KPI cards
  // -------------------------------------------------------------------------

  describe('summary', () => {
    it('publishes the run totals byte-for-byte when nothing is filtered', async () => {
      const body = await get<AnalyticsSummary>('/summary');

      expect(body.reconcilesToRun).toBe(true);
      expect(body.filtersApplied).toEqual([]);
      expect(body.limitations).toEqual([]);
      expect(body.currency).toBe('PKR');
      expect(body.reportingDate).toBe(current.reportingDate);
      expect(body.snapshot.publicId).toBe(current.snapshotPublicId);
      expect(body.run?.publicId).toBe(current.runPublicId);
      expect(body.run?.status).toBe('APPROVED');
      expect(body.run?.modelConfigurationVersion).toBe('1.0.0');

      // The point of the endpoint: a KPI card and the run page carry the same
      // string, not two roundings of the same number.
      expect(body.totals.exposureCount).toBe(runPageTotals.exposureCount);
      expect(body.totals.grossCarryingAmount).toBe(runPageTotals.totalGrossCarryingAmount);
      expect(body.totals.ead).toBe(runPageTotals.totalEad);
      expect(body.totals.lossAllowance).toBe(runPageTotals.totalLossAllowance);
      expect(body.totals.netCarryingAmount).toBe(runPageTotals.totalNetCarryingAmount);
      expect(body.totals.coverageRatio).toBe(runPageTotals.coverageRatio);
    });

    it('reproduces the same totals from an independent fold of the result rows', () => {
      // Not an HTTP assertion: this is the other half of the reconciliation, so
      // a failure here means the seed wrote rows that do not add to their own
      // run totals, rather than that an endpoint is wrong.
      expect(current.folded.count).toBe(current.totals.exposureCount);
      expect(money(current.folded.gross)).toBe(current.totals.totalGrossCarryingAmount);
      expect(money(current.folded.allowance)).toBe(current.totals.totalLossAllowance);
      expect(money(current.folded.net)).toBe(current.totals.totalNetCarryingAmount);
      expect(coverageOfFold(current.folded)).toBe(current.totals.coverageRatio);

      // EAD is the documented exception: each row is rounded to 2dp on write
      // while the total was rounded once, so the gap is bounded, not zero.
      const drift = dec(current.totals.totalEad).minus(current.folded.ead).abs();
      expect(drift.lte(dec(current.folded.count).times('0.005'))).toBe(true);
    });

    it('splits the same money across the three stage rows', async () => {
      const body = await get<AnalyticsSummary>('/summary');

      expect(body.stages.map((row) => row.stage)).toEqual([1, 2, 3]);
      expect(body.stages.reduce((total, row) => total + row.exposureCount, 0)).toBe(body.totals.exposureCount);
      expect(money(sumStrings(body.stages.map((row) => row.lossAllowance)))).toBe(body.totals.lossAllowance);
      expect(money(sumStrings(body.stages.map((row) => row.grossCarryingAmount)))).toBe(body.totals.grossCarryingAmount);
      expect(money(sumStrings(body.stages.map((row) => row.netCarryingAmount)))).toBe(body.totals.netCarryingAmount);

      // Against the run's own buckets, and against a fold of the rows in each.
      for (const row of body.stages) {
        const bucket = runPageTotals.stageBuckets.find((entry) => entry.stage === row.stage)!;
        const folded = fold(current.rows.filter((candidate) => candidate.stage === row.stage));
        expect(row.exposureCount, `stage ${row.stage}`).toBe(bucket.exposureCount);
        expect(row.exposureCount, `stage ${row.stage}`).toBe(folded.count);
        expect(row.lossAllowance, `stage ${row.stage}`).toBe(bucket.lossAllowance);
        expect(row.lossAllowance, `stage ${row.stage}`).toBe(money(folded.allowance));
        expect(row.grossCarryingAmount, `stage ${row.stage}`).toBe(bucket.grossCarryingAmount);
        expect(row.shareOfAllowancePercent).toBe(
          rateToString(dec(row.lossAllowance).dividedBy(dec(body.totals.lossAllowance)).times(100)),
        );
      }

      expect(body.totals.stage3Count).toBe(current.folded.stages[3]);
      expect(body.totals.stage2And3Count).toBe(current.folded.stages[2] + current.folded.stages[3]);
      expect(money(sumStrings(body.stages.map((row) => row.shareOfAllowancePercent)))).not.toBe('');
      expect(sumStrings(body.stages.map((row) => row.shareOfAllowancePercent)).minus(dec(100)).abs().lt(dec('0.00001'))).toBe(
        true,
      );
    });

    it('reports coverage as a ratio and as exactly 100 times that ratio', async () => {
      const body = await get<AnalyticsSummary>('/summary');
      // Derived from the published ratio rather than the full-precision
      // quotient, so the two coverage cards cannot disagree with each other.
      expect(body.totals.coveragePercent).toBe(rateToString(dec(body.totals.coverageRatio).times(100)));
      expect(dec(body.totals.coverageRatio).gt(zero())).toBe(true);
      expect(dec(body.totals.coverageRatio).lt(dec(1))).toBe(true);
    });

    it('narrows a stage filter to exactly the rows it names', async () => {
      const body = await get<AnalyticsSummary>('/summary', { stage: 3 });
      const expected = fold(current.rows.filter((row) => row.stage === 3));
      expect(expected.count).toBeGreaterThan(0);

      expect(body.reconcilesToRun).toBe(false);
      expect(body.filtersApplied).toEqual(['Stage 3']);
      expect(body.limitations).toHaveLength(1);
      expect(body.limitations[0]).toContain(`${expected.count} of the ${current.totals.exposureCount}`);

      expect(body.totals.exposureCount).toBe(expected.count);
      expect(body.totals.lossAllowance).toBe(money(expected.allowance));
      expect(body.totals.grossCarryingAmount).toBe(money(expected.gross));
      expect(body.totals.netCarryingAmount).toBe(money(expected.net));
      expect(body.totals.coverageRatio).toBe(coverageOfFold(expected));
      expect(body.totals.stage3Count).toBe(expected.count);
      expect(body.totals.stage2And3Count).toBe(expected.count);
      expect(body.stages.map((row) => row.exposureCount)).toEqual([0, 0, expected.count]);
    });

    it('narrows a segment filter to exactly the rows it names', async () => {
      const segment = current.rows[0].segment;
      const body = await get<AnalyticsSummary>('/summary', { segment });
      const expected = fold(current.rows.filter((row) => row.segment === segment));

      expect(body.filtersApplied).toEqual([`Segment: ${segment}`]);
      expect(body.reconcilesToRun).toBe(false);
      expect(body.totals.exposureCount).toBe(expected.count);
      expect(body.totals.lossAllowance).toBe(money(expected.allowance));
      expect(body.totals.grossCarryingAmount).toBe(money(expected.gross));
      expect(body.totals.coverageRatio).toBe(coverageOfFold(expected));

      // A separate endpoint, with its own filter implementation, must agree on
      // how many exposures that segment holds in this run.
      const results = await analyst.agent
        .get(`/api/v1/ecl-runs/${current.runPublicId}/results`)
        .query({ segment, pageSize: 1 });
      expect(results.status, results.text).toBe(200);
      expect(results.body.meta.totalItems).toBe(expected.count);
    });

    it('intersects two filters rather than unioning them', async () => {
      const region = current.rows[0].region;
      const rating = current.rows.find((row) => row.region === region)!.rating;
      const body = await get<AnalyticsSummary>('/summary', { region, rating });
      const expected = fold(current.rows.filter((row) => row.region === region && row.rating === rating));
      const union = new Set(
        current.rows.filter((row) => row.region === region || row.rating === rating).map((row) => row.publicId),
      );

      expect(body.filtersApplied).toEqual([`Region: ${region}`, `Rating: ${rating}`]);
      expect(body.totals.exposureCount).toBe(expected.count);
      expect(body.totals.lossAllowance).toBe(money(expected.allowance));
      expect(expected.count).toBeLessThan(union.size);
      expect(expected.count).toBeLessThan(current.folded.count);
    });

    it('returns an empty but honest selection for a filter nothing matches', async () => {
      const body = await get<AnalyticsSummary>('/summary', { segment: 'not-a-real-segment' });

      expect(body.totals.exposureCount).toBe(0);
      expect(body.totals.lossAllowance).toBe('0.00');
      expect(body.reconcilesToRun).toBe(false);
      expect(body.limitations).toHaveLength(1);
      // A zero denominator is a fact about the selection, not a 0% measurement.
      expect(body.totals.coverageRatio).toBe(rateToString(zero()));
      for (const row of body.stages) {
        expect(row.shareOfAllowancePercent).toBeNull();
        expect(row.shareOfGrossPercent).toBeNull();
      }
    });

    it('resolves an explicit period instead of the newest one', async () => {
      const body = await get<AnalyticsSummary>('/summary', { snapshotId: previous.snapshotPublicId });

      expect(body.reportingDate).toBe(previous.reportingDate);
      expect(body.run?.publicId).toBe(previous.runPublicId);
      expect(body.totals.lossAllowance).toBe(previous.totals.totalLossAllowance);
      expect(body.totals.exposureCount).toBe(previous.totals.exposureCount);
      expect(body.reconcilesToRun).toBe(true);
      expect(body.limitations).toEqual([]);
    });

    it('refuses a stage outside the IFRS 9 scale', async () => {
      for (const stage of [0, 4, -1]) {
        const response = await analyst.agent.get('/api/v1/analytics/summary').query({ stage });
        expect(response.status, `stage=${stage}`).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Movement bridge
  // -------------------------------------------------------------------------

  describe('movement bridge', () => {
    it('opens and closes on the two runs it is comparing', async () => {
      const body = await get<MovementBridge>('/movement');

      expect(body.from.runPublicId).toBe(previous.runPublicId);
      expect(body.to.runPublicId).toBe(current.runPublicId);
      expect(body.from.reportingDate).toBe(previous.reportingDate);
      expect(body.to.reportingDate).toBe(current.reportingDate);
      expect(body.from.lossAllowance).toBe(previous.totals.totalLossAllowance);
      expect(body.to.lossAllowance).toBe(current.totals.totalLossAllowance);
      expect(body.from.exposureCount).toBe(previous.folded.count);
      expect(body.to.exposureCount).toBe(current.folded.count);
      expect(body.currency).toBe('PKR');

      expect(body.change).toBe(money(dec(body.to.lossAllowance).minus(dec(body.from.lossAllowance))));
      expect(body.changePercent).toBe(
        rateToString(
          dec(body.to.lossAllowance)
            .minus(dec(body.from.lossAllowance))
            .dividedBy(dec(body.from.lossAllowance).abs())
            .times(100),
        ),
      );
    });

    it('closes arithmetically: the movement components add exactly to the change', async () => {
      const body = await get<MovementBridge>('/movement');

      expect(body.componentsSumToChange).toBe(true);
      expect(body.components.map((component) => component.code)).toEqual([...MOVEMENT_COMPONENT_CODES]);

      const byCode = componentByCode(body);
      expect(byCode.get('OPENING')!.amount).toBe(body.from.lossAllowance);
      expect(byCode.get('CLOSING')!.amount).toBe(body.to.lossAllowance);

      const movements = ['NEW_ORIGINATIONS', 'DERECOGNITION', 'STAGE_TRANSFERS', 'CONTINUING_SAME_STAGE'].map(
        (code) => byCode.get(code)!.amount,
      );
      expect(movements.every((amount) => amount !== null)).toBe(true);
      expect(money(sumStrings(movements))).toBe(body.change);
    });

    it('assigns every exposure to exactly one cohort, matching an independent fold', async () => {
      const body = await get<MovementBridge>('/movement');

      const fromByPublicId = new Map(previous.rows.map((row) => [row.publicId, row]));
      let originated = zero();
      let originatedCount = 0;
      let transfers = zero();
      let transferCount = 0;
      let continuing = zero();
      let continuingCount = 0;
      for (const row of current.rows) {
        const before = fromByPublicId.get(row.publicId);
        if (!before) {
          originated = originated.plus(row.allowance);
          originatedCount += 1;
        } else if (before.stage === row.stage) {
          continuing = continuing.plus(row.allowance.minus(before.allowance));
          continuingCount += 1;
        } else {
          transfers = transfers.plus(row.allowance.minus(before.allowance));
          transferCount += 1;
        }
      }
      const toPublicIds = new Set(current.rows.map((row) => row.publicId));
      const derecognisedRows = previous.rows.filter((row) => !toPublicIds.has(row.publicId));
      const derecognised = derecognisedRows.reduce((acc, row) => acc.minus(row.allowance), zero());

      const byCode = componentByCode(body);
      expect(byCode.get('NEW_ORIGINATIONS')!.amount).toBe(money(originated));
      expect(byCode.get('NEW_ORIGINATIONS')!.exposureCount).toBe(originatedCount);
      expect(byCode.get('STAGE_TRANSFERS')!.amount).toBe(money(transfers));
      expect(byCode.get('STAGE_TRANSFERS')!.exposureCount).toBe(transferCount);
      expect(byCode.get('CONTINUING_SAME_STAGE')!.amount).toBe(money(continuing));
      expect(byCode.get('CONTINUING_SAME_STAGE')!.exposureCount).toBe(continuingCount);
      expect(byCode.get('DERECOGNITION')!.amount).toBe(money(derecognised));
      expect(byCode.get('DERECOGNITION')!.exposureCount).toBe(derecognisedRows.length);

      // The cohorts partition the later period exactly, and the derecognised
      // cohort is the remainder of the earlier one.
      expect(originatedCount + transferCount + continuingCount).toBe(current.folded.count);
      expect(derecognisedRows.length).toBe(previous.folded.count - (transferCount + continuingCount));
    });

    it('reports the components it cannot measure as null with a reason, never as zero', async () => {
      const body = await get<MovementBridge>('/movement');
      const unmeasurable = body.components.filter((component) =>
        ['PARAMETER_CHANGES', 'SCENARIO_CHANGES', 'WRITE_OFFS'].includes(component.code),
      );

      expect(unmeasurable).toHaveLength(3);
      for (const component of unmeasurable) {
        expect(component.amount, component.code).toBeNull();
        expect(component.exposureCount, component.code).toBeNull();
        expect(component.note, component.code).toBeTruthy();
        expect(component.note!.length, component.code).toBeGreaterThan(40);
      }
      // Both periods ran on the same frozen configuration, so the notes say that
      // positively rather than leaving the reader to infer it from a blank.
      expect(unmeasurable.find((component) => component.code === 'PARAMETER_CHANGES')!.note).toContain('1.0.0');
      expect(body.limitations.some((text) => text.includes('cohort'))).toBe(true);
      // Nothing here is a defect, so no limitation claims one.
      expect(body.limitations.some((text) => text.includes('do not add'))).toBe(false);
    });

    it('narrows both sides by the same filter and says so', async () => {
      const segment = current.rows[0].segment;
      const body = await get<MovementBridge>('/movement', { segment });
      const expectedTo = fold(current.rows.filter((row) => row.segment === segment));
      const expectedFrom = fold(previous.rows.filter((row) => row.segment === segment));

      expect(body.to.lossAllowance).toBe(money(expectedTo.allowance));
      expect(body.from.lossAllowance).toBe(money(expectedFrom.allowance));
      expect(body.to.exposureCount).toBe(expectedTo.count);
      expect(body.from.exposureCount).toBe(expectedFrom.count);
      expect(body.componentsSumToChange).toBe(true);
      expect(body.limitations.some((text) => text.includes(`Segment: ${segment}`))).toBe(true);
    });

    it('refuses a stage filter, which would contradict the decomposition', async () => {
      const response = await analyst.agent.get('/api/v1/analytics/movement').query({ stage: 2 });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // Trend
  // -------------------------------------------------------------------------

  describe('trend', () => {
    it('spans every reporting period, oldest first, each reconciling to its own run', async () => {
      const body = await get<AnalyticsTrend>('/trend');

      expect(body.points).toHaveLength(snapshotCount);
      expect(body.limitations).toEqual([]);
      const dates = body.points.map((point) => point.reportingDate);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);

      for (const point of body.points) {
        // Resolved independently from the database, not from the response.
        const snapshot = await prisma.portfolioSnapshot.findFirstOrThrow({
          where: { organizationId: demoOrganizationId, asOfDate: new Date(`${point.reportingDate}T00:00:00.000Z`) },
          select: { id: true },
        });
        const reference = await referencePeriod(snapshot.id);
        expect(point.snapshotPublicId).toBe(reference.snapshotPublicId);
        expect(point.runPublicId).toBe(reference.runPublicId);
        expect(point.runStatus).toBe('APPROVED');
        expect(point.exposureCount).toBe(reference.totals.exposureCount);
        expect(point.lossAllowance).toBe(reference.totals.totalLossAllowance);
        expect(point.grossCarryingAmount).toBe(reference.totals.totalGrossCarryingAmount);
        expect(point.netCarryingAmount).toBe(reference.totals.totalNetCarryingAmount);
        expect(point.modelConfigurationVersion).toBe('1.0.0');
        expect(point.scenarioSetVersion).toBeTruthy();
      }
    });

    it('ends on exactly the figures the summary publishes', async () => {
      const [trend, summary] = await Promise.all([get<AnalyticsTrend>('/trend'), get<AnalyticsSummary>('/summary')]);
      const newest = trend.points[trend.points.length - 1];

      expect(newest.reportingDate).toBe(summary.reportingDate);
      expect(newest.runPublicId).toBe(summary.run?.publicId);
      expect(newest.lossAllowance).toBe(summary.totals.lossAllowance);
      expect(newest.grossCarryingAmount).toBe(summary.totals.grossCarryingAmount);
      expect(newest.netCarryingAmount).toBe(summary.totals.netCarryingAmount);
      expect(newest.exposureCount).toBe(summary.totals.exposureCount);
      expect(newest.coverageRatio).toBe(summary.totals.coverageRatio);
      expect(newest.stageCounts).toEqual({
        1: summary.stages[0].exposureCount,
        2: summary.stages[1].exposureCount,
        3: summary.stages[2].exposureCount,
      });
    });

    it('splits each point across stages that add back to the point', async () => {
      const body = await get<AnalyticsTrend>('/trend');
      for (const point of body.points) {
        expect(point.stageCounts[1] + point.stageCounts[2] + point.stageCounts[3]).toBe(point.exposureCount);
        expect(money(sumStrings([point.stageAllowance[1], point.stageAllowance[2], point.stageAllowance[3]]))).toBe(
          point.lossAllowance,
        );
      }
    });

    it('narrows every period by the same filter', async () => {
      const segment = current.rows[0].segment;
      const body = await get<AnalyticsTrend>('/trend', { segment });
      const newest = body.points[body.points.length - 1];
      const expected = fold(current.rows.filter((row) => row.segment === segment));

      expect(newest.exposureCount).toBe(expected.count);
      expect(newest.lossAllowance).toBe(money(expected.allowance));
      expect(body.limitations.some((text) => text.includes(`Segment: ${segment}`))).toBe(true);
    });

    it('refuses a period filter, because the trend is the periods', async () => {
      const response = await analyst.agent
        .get('/api/v1/analytics/trend')
        .query({ snapshotId: current.snapshotPublicId });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // Concentration
  // -------------------------------------------------------------------------

  describe('concentration', () => {
    const DIMENSION_KEY: Array<{ dimension: string; pick: (row: RefRow) => string }> = [
      { dimension: 'segment', pick: (row) => row.segment },
      { dimension: 'productType', pick: (row) => row.productType },
      { dimension: 'region', pick: (row) => row.region },
      { dimension: 'industry', pick: (row) => row.industry },
      { dimension: 'rating', pick: (row) => row.rating },
    ];

    const sliceFor = (body: AnalyticsConcentration, dimension: string) =>
      body.slices.find((candidate) => candidate.dimension === dimension)!;

    it('returns all five dimensions, each summing back to the run total', async () => {
      const body = await get<AnalyticsConcentration>('/concentration');

      expect(body.slices.map((slice) => slice.dimension)).toEqual([...CONCENTRATION_DIMENSIONS]);
      expect(body.runPublicId).toBe(current.runPublicId);
      expect(body.reportingDate).toBe(current.reportingDate);
      expect(body.limitations).toEqual([]);

      for (const slice of body.slices) {
        const all = slice.otherBucket ? [...slice.buckets, slice.otherBucket] : slice.buckets;
        expect(money(sumStrings(all.map((bucket) => bucket.lossAllowance))), slice.dimension).toBe(
          current.totals.totalLossAllowance,
        );
        expect(money(sumStrings(all.map((bucket) => bucket.grossCarryingAmount))), slice.dimension).toBe(
          current.totals.totalGrossCarryingAmount,
        );
        expect(all.reduce((total, bucket) => total + bucket.exposureCount, 0), slice.dimension).toBe(
          current.totals.exposureCount,
        );
        // Shares add to 100 within the last published decimal, not exactly: ten
        // roundings at 10dp cannot be expected to cancel.
        const shares = sumStrings(all.map((bucket) => bucket.shareOfAllowancePercent));
        expect(shares.minus(dec(100)).abs().lt(dec('0.00001')), slice.dimension).toBe(true);
      }
    });

    it('buckets each dimension by the rows that actually carry that value', async () => {
      const body = await get<AnalyticsConcentration>('/concentration');

      for (const { dimension, pick } of DIMENSION_KEY) {
        const slice = sliceFor(body, dimension);
        const groups = groupBy(current.rows, pick);

        for (const bucket of slice.buckets) {
          const group = groups.get(bucket.key);
          expect(group, `${dimension}/${bucket.key}`).toBeDefined();
          const reference = fold(group!);
          expect(bucket.exposureCount, `${dimension}/${bucket.key}`).toBe(reference.count);
          expect(bucket.lossAllowance, `${dimension}/${bucket.key}`).toBe(money(reference.allowance));
          expect(bucket.grossCarryingAmount, `${dimension}/${bucket.key}`).toBe(money(reference.gross));
          expect(bucket.coverageRatio, `${dimension}/${bucket.key}`).toBe(coverageOfFold(reference));
          for (const stage of [1, 2, 3] as const) {
            expect(bucket.stageCounts[stage], `${dimension}/${bucket.key}/stage${stage}`).toBe(reference.stages[stage]);
          }
        }

        // The remainder is every key the cap pushed out, not an arbitrary slice.
        const namedKeys = new Set(slice.buckets.map((bucket) => bucket.key));
        const remainderRows = current.rows.filter((row) => !namedKeys.has(pick(row)));
        const remainderKeys = new Set(remainderRows.map(pick));
        if (slice.otherBucket) {
          const reference = fold(remainderRows);
          expect(slice.otherBucket.key, dimension).toBe(`Other (${remainderKeys.size})`);
          expect(slice.otherBucket.exposureCount, dimension).toBe(reference.count);
          expect(slice.otherBucket.lossAllowance, dimension).toBe(money(reference.allowance));
          expect(slice.otherBucket.grossCarryingAmount, dimension).toBe(money(reference.gross));
        } else {
          expect(remainderRows, dimension).toEqual([]);
        }
        expect(namedKeys.size + remainderKeys.size, dimension).toBe(groups.size);
      }
    });

    it('never folds a credit rating into Other, and orders the grades by credit quality', async () => {
      const body = await get<AnalyticsConcentration>('/concentration');
      const slice = sliceFor(body, 'rating');

      // Merging the weakest grades into "Other" would hide exactly the tail a
      // credit concentration chart exists to show.
      expect(slice.otherBucket).toBeNull();
      expect(slice.buckets.length).toBe(new Set(current.rows.map((row) => row.rating)).size);

      const ranks = slice.buckets.map((bucket) => RATING_SCALE.indexOf(bucket.key as (typeof RATING_SCALE)[number]));
      expect(ranks.every((rank) => rank !== -1)).toBe(true);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    });

    it('caps the long dimensions, ranked by allowance, and keeps the slice total intact', async () => {
      const body = await get<AnalyticsConcentration>('/concentration');

      for (const slice of body.slices) {
        expect(slice.buckets.length, slice.dimension).toBeLessThanOrEqual(10);
        if (slice.otherBucket) expect(slice.buckets.length, slice.dimension).toBe(10);

        // Non-rating slices stay in allowance order; ratings are re-sorted into
        // credit-quality order for display, which is the point of that slice.
        if (slice.dimension !== 'rating') {
          const allowances = slice.buckets.map((bucket) => dec(bucket.lossAllowance));
          for (let index = 1; index < allowances.length; index += 1) {
            expect(allowances[index - 1].gte(allowances[index]), slice.dimension).toBe(true);
          }
        }
      }
    });

    it('names the largest bucket share, computed on the ranking rather than the display order', async () => {
      const body = await get<AnalyticsConcentration>('/concentration');

      for (const slice of body.slices) {
        const largest = slice.buckets.reduce(
          (max, bucket) => dec(bucket.shareOfAllowancePercent ?? '0').gt(max) ? dec(bucket.shareOfAllowancePercent!) : max,
          zero(),
        );
        expect(slice.topBucketShareOfAllowancePercent, slice.dimension).toBe(rateToString(largest));

        const topThree = [...slice.buckets]
          .sort((a, b) => dec(b.lossAllowance).comparedTo(dec(a.lossAllowance)))
          .slice(0, 3)
          .reduce((acc, bucket) => acc.plus(dec(bucket.lossAllowance)), zero());
        expect(slice.topThreeShareOfAllowancePercent, slice.dimension).toBe(
          rateToString(topThree.dividedBy(dec(current.totals.totalLossAllowance)).times(100)),
        );
      }
    });

    it('warns that a filtered dimension has one bucket because the filter narrowed it', async () => {
      const segment = current.rows[0].segment;
      const body = await get<AnalyticsConcentration>('/concentration', { segment });

      expect(sliceFor(body, 'segment').buckets).toHaveLength(1);
      expect(sliceFor(body, 'segment').buckets[0].key).toBe(segment);
      expect(body.limitations.some((text) => text.includes('segment slice has one bucket'))).toBe(true);
      // The other four slices still describe the narrowed book in full.
      expect(sliceFor(body, 'region').buckets.length).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // Drivers
  // -------------------------------------------------------------------------

  describe('drivers', () => {
    it('ranks the largest allowances first and states the share they hold', async () => {
      const body = await get<AnalyticsDrivers>('/drivers', { limit: 10 });

      expect(body.totalLossAllowance).toBe(current.totals.totalLossAllowance);
      expect(body.runPublicId).toBe(current.runPublicId);
      expect(body.reportingDate).toBe(current.reportingDate);
      expect(body.topExposures).toHaveLength(10);

      const descending = [...current.rows].sort((a, b) => b.allowance.comparedTo(a.allowance));
      expect(body.topExposures.map((row) => row.lossAllowance)).toEqual(
        descending.slice(0, 10).map((row) => money(row.allowance)),
      );

      const byPublicId = new Map(current.rows.map((row) => [row.publicId, row]));
      for (const driver of body.topExposures) {
        const reference = byPublicId.get(driver.exposurePublicId);
        expect(reference, driver.exposurePublicId).toBeDefined();
        expect(driver.lossAllowance).toBe(money(reference!.allowance));
        expect(driver.grossCarryingAmount).toBe(money(reference!.gross));
        expect(driver.segment).toBe(reference!.segment);
        expect(driver.stage).toBe(reference!.stage);
        expect(driver.currentCreditRating).toBe(reference!.rating);
        expect(driver.daysPastDue).toBeGreaterThanOrEqual(0);
        expect(driver.borrowerName.length).toBeGreaterThan(0);
        expect(driver.primaryRuleCode.length).toBeGreaterThan(0);
        // Every driver explains itself; a drill-down that cannot say why an
        // exposure is staged as it is does not answer the question asked.
        expect(driver.primaryReason.length).toBeGreaterThan(20);
        expect(driver.shareOfTotalAllowancePercent).toBe(
          rateToString(reference!.allowance.dividedBy(dec(body.totalLossAllowance)).times(100)),
        );
      }

      expect(body.topExposuresShareOfAllowancePercent).toBe(
        rateToString(
          sumStrings(body.topExposures.map((row) => row.lossAllowance))
            .dividedBy(dec(body.totalLossAllowance))
            .times(100),
        ),
      );
      expect(dec(body.topExposuresShareOfAllowancePercent!).lte(dec(100))).toBe(true);
      expect(dec(body.topExposuresShareOfAllowancePercent!).gt(zero())).toBe(true);
    });

    it('attributes the whole allowance across segments and staging rules', async () => {
      const body = await get<AnalyticsDrivers>('/drivers');

      expect(money(sumStrings(body.bySegment.map((row) => row.lossAllowance)))).toBe(
        current.totals.totalLossAllowance,
      );
      expect(body.bySegment.length).toBe(new Set(current.rows.map((row) => row.segment)).size);
      const segmentGroups = groupBy(current.rows, (row) => row.segment);
      for (const entry of body.bySegment) {
        expect(entry.lossAllowance, entry.key).toBe(money(fold(segmentGroups.get(entry.key)!).allowance));
      }

      // The rules come from each result's frozen staging decision, so they
      // partition the run: every exposure is counted once and every paisa of
      // allowance is attributed to the rule that staged it.
      expect(body.stagingRules.reduce((total, rule) => total + rule.exposureCount, 0)).toBe(
        current.totals.exposureCount,
      );
      expect(money(sumStrings(body.stagingRules.map((rule) => rule.lossAllowance)))).toBe(
        current.totals.totalLossAllowance,
      );
      for (const rule of body.stagingRules) {
        expect(rule.code.length).toBeGreaterThan(0);
        expect([1, 2, 3]).toContain(rule.stage);
        expect(rule.exposureCount).toBeGreaterThan(0);
      }
    });

    it('honours the limit and refuses one outside the contract', async () => {
      const three = await get<AnalyticsDrivers>('/drivers', { limit: 3 });
      expect(three.topExposures).toHaveLength(3);

      const unlimited = await get<AnalyticsDrivers>('/drivers');
      expect(unlimited.topExposures).toHaveLength(10);

      for (const limit of [0, 51, -1]) {
        const response = await analyst.agent.get('/api/v1/analytics/drivers').query({ limit });
        expect(response.status, `limit=${limit}`).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Migration, scenarios, run comparison
  // -------------------------------------------------------------------------

  describe('stage migration', () => {
    it('defaults to the two newest periods and reconciles both margins', async () => {
      const body = await get<AnalyticsMigration>('/migration');

      expect(body.toSnapshot.publicId).toBe(current.snapshotPublicId);
      expect(body.fromSnapshot.publicId).toBe(previous.snapshotPublicId);
      expect(body.toSnapshot.runPublicId).toBe(current.runPublicId);
      expect(body.fromSnapshot.runPublicId).toBe(previous.runPublicId);
      expect(body.limitations).toEqual([]);

      // stageCountsFrom/To are each period's full stage distribution — every
      // exposure in that period's own run, matched into the other period or not.
      for (const stage of [1, 2, 3]) {
        expect(body.stageCountsFrom[String(stage)], `from stage ${stage}`).toBe(previous.folded.stages[stage]);
        expect(body.stageCountsTo[String(stage)], `to stage ${stage}`).toBe(current.folded.stages[stage]);
      }

      // The matrix's cells only cover the matched cohort (an exposure public id
      // present in both periods) — the seed deliberately derecognises loans
      // between periods (see `derecognisedCount` in ingest/history.ts), so a
      // row/column margin over `cells` reconciles to the matched subset of each
      // period, not its full stage count. New originations and derecognitions
      // are reconciled separately via onlyInFromSnapshot/onlyInToSnapshot below.
      const previousStageById = new Map(previous.rows.map((row) => [row.publicId, row.stage]));
      const currentStageById = new Map(current.rows.map((row) => [row.publicId, row.stage]));
      const matchedFromStages = [...previousStageById].filter(([publicId]) => currentStageById.has(publicId)).map(([, stage]) => stage);
      const matchedToStages = [...currentStageById].filter(([publicId]) => previousStageById.has(publicId)).map(([, stage]) => stage);

      for (const stage of [1, 2, 3]) {
        const rowSum = body.cells.filter((cell) => cell.fromStage === stage).reduce((total, cell) => total + cell.count, 0);
        const columnSum = body.cells.filter((cell) => cell.toStage === stage).reduce((total, cell) => total + cell.count, 0);
        expect(rowSum, `from stage ${stage}`).toBe(matchedFromStages.filter((s) => s === stage).length);
        expect(columnSum, `to stage ${stage}`).toBe(matchedToStages.filter((s) => s === stage).length);
      }

      expect(body.matchedExposures).toBe(body.cells.reduce((total, cell) => total + cell.count, 0));
      expect(body.onlyInFromSnapshot).toBe(previous.folded.count - body.matchedExposures);
      expect(body.onlyInToSnapshot).toBe(current.folded.count - body.matchedExposures);
      expect(body.netStage3Change).toBe(current.folded.stages[3] - previous.folded.stages[3]);
    });

    it('counts the same cohorts the movement bridge does', async () => {
      const [migration, movement] = await Promise.all([
        get<AnalyticsMigration>('/migration'),
        get<MovementBridge>('/movement'),
      ]);

      // Both match exposures on publicId across the same two periods, so the
      // cohorts they report must be the same cohorts.
      const changedStage = migration.cells
        .filter((cell) => cell.fromStage !== cell.toStage)
        .reduce((total, cell) => total + cell.count, 0);
      const byCode = componentByCode(movement);

      expect(changedStage).toBe(byCode.get('STAGE_TRANSFERS')!.exposureCount);
      expect(migration.matchedExposures - changedStage).toBe(byCode.get('CONTINUING_SAME_STAGE')!.exposureCount);
      expect(migration.onlyInToSnapshot).toBe(byCode.get('NEW_ORIGINATIONS')!.exposureCount);
      expect(migration.onlyInFromSnapshot).toBe(byCode.get('DERECOGNITION')!.exposureCount);
    });

    it('accepts two explicitly named periods, and reversing them reverses the sign', async () => {
      const [forward, backward] = await Promise.all([
        get<AnalyticsMigration>('/migration'),
        get<AnalyticsMigration>('/migration', {
          fromSnapshotId: current.snapshotPublicId,
          toSnapshotId: previous.snapshotPublicId,
        }),
      ]);

      expect(backward.fromSnapshot.publicId).toBe(current.snapshotPublicId);
      expect(backward.toSnapshot.publicId).toBe(previous.snapshotPublicId);
      expect(backward.netStage3Change).toBe(-forward.netStage3Change);
      expect(backward.onlyInFromSnapshot).toBe(forward.onlyInToSnapshot);
      expect(backward.onlyInToSnapshot).toBe(forward.onlyInFromSnapshot);
      expect(backward.matchedExposures).toBe(forward.matchedExposures);
    });
  });

  describe('scenario comparison', () => {
    it('splits the run allowance across the weighted scenarios', async () => {
      const body = await get<AnalyticsScenarios>('/scenarios');

      expect(body.runPublicId).toBe(current.runPublicId);
      expect(body.runStatus).toBe('APPROVED');
      expect(body.reportingDate).toBe(current.reportingDate);
      expect(body.snapshotPublicId).toBe(current.snapshotPublicId);
      expect(body.exposureCount).toBe(current.totals.exposureCount);
      expect(dec(body.weightSum).equals(dec(1))).toBe(true);
      expect(body.scenarios.length).toBeGreaterThanOrEqual(3);

      for (const scenario of body.scenarios) {
        expect(scenario.exposureCount, scenario.scenarioCode).toBe(current.totals.exposureCount);
        expect(dec(scenario.weight).gt(zero()), scenario.scenarioCode).toBe(true);
        expect(scenario.horizonMonths).toBeGreaterThan(0);
        expect(scenario.shareOfWeightedEclPercent, scenario.scenarioCode).toBe(
          rateToString(dec(scenario.weightedEcl).dividedBy(dec(body.totalWeightedEcl)).times(100)),
        );
      }
      expect(money(sumStrings(body.scenarios.map((scenario) => scenario.weightedEcl)))).toBe(body.totalWeightedEcl);
      expect(sumStrings(body.scenarios.map((scenario) => scenario.shareOfWeightedEclPercent)).minus(dec(100)).abs().lt(dec('0.00001'))).toBe(
        true,
      );

      // Bounded, not exact: each exposure's allowance is its scenario ECLs
      // summed and rounded once, so rounding the grand total once instead can
      // differ by up to half a paisa per exposure.
      const drift = dec(body.totalWeightedEcl).minus(dec(current.totals.totalLossAllowance)).abs();
      expect(drift.lte(dec(current.totals.exposureCount).times('0.005'))).toBe(true);
    });

    it('resolves an explicitly named run', async () => {
      const body = await get<AnalyticsScenarios>('/scenarios', { runId: previous.runPublicId });
      expect(body.runPublicId).toBe(previous.runPublicId);
      expect(body.snapshotPublicId).toBe(previous.snapshotPublicId);
      expect(body.exposureCount).toBe(previous.totals.exposureCount);
    });
  });

  describe('run comparison', () => {
    it('defaults to the selected period against the one before it', async () => {
      const body = await get<RunComparison>('/run-comparison');

      expect(body.comparisonRun.publicId).toBe(current.runPublicId);
      expect(body.baseRun.publicId).toBe(previous.runPublicId);
      expect(body.totals.comparisonAllowance).toBe(current.totals.totalLossAllowance);
      expect(body.totals.baseAllowance).toBe(previous.totals.totalLossAllowance);
      expect(body.totals.change).toBe(
        money(dec(current.totals.totalLossAllowance).minus(dec(previous.totals.totalLossAllowance))),
      );

      // The seed calculates every period on the same frozen configuration, so
      // nothing about the *model* differs. What differs is the reporting date,
      // which is what a period comparison is — not a caveat about comparability.
      expect(body.configurationDifferences).toEqual([]);
      expect(body.comparableConfiguration).toBe(true);
      expect(body.sameReportingDate).toBe(false);
      expect(body.limitations.some((text) => text.includes('different reporting dates'))).toBe(true);
    });

    it('matches exposures on public id and totals both sides independently', async () => {
      const body = await get<RunComparison>('/run-comparison');
      const fromByPublicId = new Map(previous.rows.map((row) => [row.publicId, row]));
      const matched = current.rows.filter((row) => fromByPublicId.has(row.publicId));

      expect(body.matchedExposures).toBe(matched.length);
      expect(body.onlyInComparison).toBe(current.folded.count - matched.length);
      expect(body.onlyInBase).toBe(previous.folded.count - matched.length);
      // Each side's total is over its own rows, matched or not.
      expect(body.totals.baseExposureCount).toBe(previous.folded.count);
      expect(body.totals.comparisonExposureCount).toBe(current.folded.count);

      expect(body.largestIncreases).toHaveLength(10);
      expect(body.largestDecreases).toHaveLength(10);
      for (let index = 1; index < body.largestIncreases.length; index += 1) {
        expect(dec(body.largestIncreases[index - 1].change).gte(dec(body.largestIncreases[index].change))).toBe(true);
      }
      for (let index = 1; index < body.largestDecreases.length; index += 1) {
        expect(dec(body.largestDecreases[index - 1].change).lte(dec(body.largestDecreases[index].change))).toBe(true);
      }
      for (const row of [...body.largestIncreases, ...body.largestDecreases]) {
        expect(row.change).toBe(money(dec(row.comparisonAllowance).minus(dec(row.baseAllowance))));
        const before = fromByPublicId.get(row.exposurePublicId);
        const after = current.rows.find((candidate) => candidate.publicId === row.exposurePublicId);
        expect(row.baseAllowance, row.exposurePublicId).toBe(money(before!.allowance));
        expect(row.comparisonAllowance, row.exposurePublicId).toBe(money(after!.allowance));
        expect(row.baseStage).toBe(before!.stage);
        expect(row.comparisonStage).toBe(after!.stage);
      }

      // The stage migrations inside the comparison are the same matrix the
      // migration endpoint reports over the same two periods.
      const migration = await get<AnalyticsMigration>('/migration');
      expect(body.stageMigrations).toEqual(migration.cells);
    });

    it('compares two explicitly named runs', async () => {
      const body = await get<RunComparison>('/run-comparison', {
        baseRunId: previous.runPublicId,
        comparisonRunId: current.runPublicId,
      });
      expect(body.baseRun.publicId).toBe(previous.runPublicId);
      expect(body.comparisonRun.publicId).toBe(current.runPublicId);
      expect(body.sameReportingDate).toBe(false);
      expect(body.totals.change).toBe(
        money(dec(current.totals.totalLossAllowance).minus(dec(previous.totals.totalLossAllowance))),
      );
    });

    it('reports the change it measured against the movement bridge', async () => {
      const [comparison, movement] = await Promise.all([
        get<RunComparison>('/run-comparison'),
        get<MovementBridge>('/movement'),
      ]);
      // Two different aggregations of the same two runs, arriving at one number.
      expect(comparison.totals.change).toBe(movement.change);
      expect(comparison.totals.changePercent).toBe(movement.changePercent);
      expect(comparison.totals.baseAllowance).toBe(movement.from.lossAllowance);
      expect(comparison.totals.comparisonAllowance).toBe(movement.to.lossAllowance);
    });
  });

  // -------------------------------------------------------------------------
  // Filter options
  // -------------------------------------------------------------------------

  describe('filter options', () => {
    it('lists every period newest first and marks which hold results', async () => {
      const body = await get<PortfolioFilters>('/filters');

      expect(body.periods).toHaveLength(snapshotCount);
      const dates = body.periods.map((period) => period.reportingDate);
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(dates[0]).toBe(current.reportingDate);

      for (const period of body.periods) {
        expect(period.hasResults, period.reportingDate).toBe(true);
        expect(period.runStatus, period.reportingDate).toBe('APPROVED');
        expect(period.runPublicId, period.reportingDate).toBeTruthy();
        expect(period.exposureCount, period.reportingDate).toBeGreaterThan(0);
        expect(period.label.length).toBeGreaterThan(0);
      }
      expect(body.periods.find((period) => period.reportingDate === current.reportingDate)?.runPublicId).toBe(
        current.runPublicId,
      );
    });

    it('offers exactly the values the period holds, with counts that add up', async () => {
      const body = await get<PortfolioFilters>('/filters');
      const dimensions: Array<{ key: keyof PortfolioFilters; pick: (row: RefRow) => string }> = [
        { key: 'segments', pick: (row) => row.segment },
        { key: 'productTypes', pick: (row) => row.productType },
        { key: 'regions', pick: (row) => row.region },
        { key: 'industries', pick: (row) => row.industry },
        { key: 'ratings', pick: (row) => row.rating },
      ];

      for (const { key, pick } of dimensions) {
        const options = body[key] as Array<{ value: string; count: number }>;
        const groups = groupBy(current.rows, pick);

        expect(options.length, String(key)).toBe(groups.size);
        expect(options.reduce((total, option) => total + option.count, 0), String(key)).toBe(current.folded.count);
        for (const option of options) {
          expect(option.count, `${String(key)}/${option.value}`).toBe(groups.get(option.value)!.length);
        }
      }
    });

    it('orders the rating options by credit quality, not by population', async () => {
      const body = await get<PortfolioFilters>('/filters');
      const ranks = body.ratings.map((option) => RATING_SCALE.indexOf(option.value as (typeof RATING_SCALE)[number]));
      expect(ranks.every((rank) => rank !== -1)).toBe(true);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      // Ordered by quality, so the counts are generally not descending — which
      // is the whole reason the order is asserted separately from the tallies.
      expect(body.ratings.length).toBeGreaterThan(1);
    });

    it('counts stages from the live assessment the ledger filter actually uses', async () => {
      const body = await get<PortfolioFilters>('/filters');
      expect(body.stages.map((entry) => entry.stage)).toEqual([1, 2, 3]);

      // Counted independently, per stage, over the same snapshot. The service
      // reads the live assessment (runId null) because that is what the ledger's
      // stage filter matches on, not the stage this run happened to assign.
      for (const entry of body.stages) {
        const count = await prisma.exposure.count({
          where: {
            organizationId: demoOrganizationId,
            snapshot: { publicId: current.snapshotPublicId },
            stagingAssessments: { some: { runId: null, stage: entry.stage } },
          },
        });
        expect(entry.count, `stage ${entry.stage}`).toBe(count);
      }
      expect(body.stages.reduce((total, entry) => total + entry.count, 0)).toBeGreaterThan(0);
    });

    it('enumerates the period named in the query rather than the newest', async () => {
      const body = await get<PortfolioFilters>('/filters', { snapshotId: previous.snapshotPublicId });
      const groups = groupBy(previous.rows, (row) => row.segment);
      const segments = body.segments;
      expect(segments.reduce((total, option) => total + option.count, 0)).toBe(previous.folded.count);
      for (const option of segments) {
        expect(option.count, option.value).toBe(groups.get(option.value)!.length);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Authorization and tenancy
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    const OTHER_ORG = 'Analytics Test Isolation Bank';
    const OTHER_EMAIL = 'analytics-isolation@eclens.test';
    let otherOrganizationId: string;
    let other: Session;

    beforeAll(async () => {
      const [role, template] = await Promise.all([
        prisma.role.findUniqueOrThrow({ where: { name: 'RISK_ANALYST' } }),
        prisma.user.findUniqueOrThrow({ where: { email: demoEmail('RISK_ANALYST') } }),
      ]);
      const organization = await prisma.organization.create({
        data: { id: newId(), name: OTHER_ORG, currency: 'PKR' },
      });
      otherOrganizationId = organization.id;
      await prisma.user.create({
        data: {
          id: newId(),
          organizationId: organization.id,
          roleId: role.id,
          publicId: newPublicId('USR'),
          email: OTHER_EMAIL,
          fullName: 'Analytics Isolation Analyst',
          // Reused rather than re-hashed: the point is tenancy, not bcrypt.
          passwordHash: template.passwordHash,
        },
      });
      other = await login(OTHER_EMAIL);
    });

    afterAll(async () => {
      if (!otherOrganizationId) return;
      await prisma.auditEvent.deleteMany({ where: { organizationId: otherOrganizationId } });
      await prisma.user.deleteMany({ where: { organizationId: otherOrganizationId } });
      await prisma.organization.deleteMany({ where: { id: otherOrganizationId } });
    });

    it('refuses an unauthenticated caller on every endpoint', async () => {
      const paths = [
        '/summary',
        '/movement',
        '/trend',
        '/concentration',
        '/drivers',
        '/filters',
        '/scenarios',
        '/migration',
        '/run-comparison',
      ];
      for (const path of paths) {
        const response = await request(app).get(`/api/v1/analytics${path}`);
        expect(response.status, path).toBe(401);
      }
    });

    it('lets a read-only auditor see the aggregates', async () => {
      const response = await auditor.agent.get('/api/v1/analytics/summary');
      expect(response.status, response.text).toBe(200);
      const body = response.body as AnalyticsSummary;
      expect(body.totals.lossAllowance).toBe(current.totals.totalLossAllowance);
      expect(body.reconcilesToRun).toBe(true);
    });

    it('gives a second organization its own empty view and none of the demo book', async () => {
      // No snapshot at all, so period resolution has nothing to resolve.
      for (const path of ['/summary', '/movement', '/concentration', '/drivers', '/filters', '/scenarios', '/migration', '/run-comparison']) {
        const response = await other.agent.get(`/api/v1/analytics${path}`);
        expect(response.status, path).toBe(404);
        expect(response.body.error.code, path).toBe('NOT_FOUND');
      }

      // The trend has no period to resolve, so it reports an empty series
      // rather than failing: an empty book is a fact, not an error.
      const trend = await other.agent.get('/api/v1/analytics/trend');
      expect(trend.status, trend.text).toBe(200);
      expect(trend.body.points).toEqual([]);

      // Naming the demo organization's snapshot, run or period cannot reach it:
      // the tenant comes from the session, so the id does not exist for this
      // caller and there is no parameter that would say whose it is.
      const scoped = await other.agent
        .get('/api/v1/analytics/summary')
        .query({ snapshotId: current.snapshotPublicId });
      expect(scoped.status, scoped.text).toBe(404);

      const comparison = await other.agent
        .get('/api/v1/analytics/run-comparison')
        .query({ baseRunId: previous.runPublicId, comparisonRunId: current.runPublicId });
      expect(comparison.status, comparison.text).toBe(404);

      const scenarios = await other.agent.get('/api/v1/analytics/scenarios').query({ runId: current.runPublicId });
      expect(scenarios.status, scenarios.text).toBe(404);
    });
  });
});
