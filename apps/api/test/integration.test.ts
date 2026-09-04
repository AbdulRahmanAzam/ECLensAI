/**
 * Database-backed API integration tests.
 *
 * These run against the seeded demo organization in the isolated `eclens_test`
 * database (`npm run db:test:prepare`) and cover the four acceptance properties
 * that cannot be proven without a real database:
 *
 *   • portfolio totals reconcile exactly to the sum of the per-exposure results
 *     the same endpoint pages through, under the documented rounding policy;
 *   • a completed run is frozen — superseding its model configuration version
 *     changes what is *active*, never what was *approved*;
 *   • a second organization cannot read a single row of the first one, and each
 *     role is refused the actions its permission set does not carry;
 *   • an analyst override needs a second pair of eyes, and both halves land in
 *     the immutable audit trail.
 *
 * The suite is skipped, not failed, when no seeded database is reachable, so a
 * checkout without PostgreSQL still gets a green unit-test run.
 *
 * `test/setup-env.ts` pins `DATABASE_URL` to `eclens_test` before Prisma Client
 * is constructed, which is what keeps the demo book clean: audit events are
 * append-only and have no delete route, so a run against the development
 * database would leave its residue in the audit log forever. The row fixtures
 * this file creates — the run, model configuration, override and tenant — are
 * torn down inside the test that made them; the audit events they wrote are not,
 * and are discarded wholesale by the next `npm run db:test:prepare`.
 */
import type { RoleName } from '@prisma/client';
import {
  DEFAULT_MODEL_CONFIGURATION,
  MAX_PAGE_SIZE,
  PORTFOLIO_FIELDS,
  ROUNDING_POLICY,
  TEMPLATE_FIELD_GUIDE,
  dec,
  permissionsForRole,
} from '@eclens/shared';
import { DEMO_ORGANIZATION, DEMO_PASSWORD, DEMO_USERS } from '@eclens/shared';
import request, { type SuperAgentTest } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted above the imports: `config/env.ts` parses `process.env` once at module
// load, so the limits have to be raised before `createApp` is ever imported.
// The auth limiter is deliberately tight in production (20 per 15 minutes) and
// pino logs full request headers, which would bury the assertion output.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.LOG_LEVEL = 'fatal';
});

const { createApp } = await import('../src/app');
const { prisma } = await import('../src/lib/prisma');
const { activeRuleSet, reassessExposure } = await import('../src/services/staging.service');
const { newId, newPublicId } = await import('../src/lib/ids');

const app = createApp();

/** True only when a reachable database actually holds the seeded demo book. */
async function seededDatabaseIsPresent(): Promise<boolean> {
  try {
    const organization = await prisma.organization.findFirst({ where: { name: DEMO_ORGANIZATION } });
    if (!organization) return false;
    return prisma.eclRun.count({ where: { organizationId: organization.id, status: 'APPROVED' } }).then((n) => n > 0);
  } catch {
    return false;
  }
}

const SEEDED = await seededDatabaseIsPresent();
if (!SEEDED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[integration] skipped: no seeded database. Run `npm run db:up && npm run db:migrate && npm run db:seed` first.',
  );
}

interface Session {
  agent: SuperAgentTest;
  id: string;
  email: string;
  fullName: string;
  role: RoleName;
  organizationId: string;
}

async function login(email: string): Promise<Session> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email, password: DEMO_PASSWORD });
  // Surfaced in the failure message: a 401 here means the seed is stale, not
  // that the endpoint under test is broken.
  expect(response.status, `login failed for ${email}: ${response.text}`).toBe(200);
  const user = response.body.user as Session;
  return { agent, id: user.id, email: user.email, fullName: user.fullName, role: user.role, organizationId: user.organizationId };
}

/** Money summed exactly; the totals endpoints publish strings, never floats. */
function sum(values: Iterable<string>): ReturnType<typeof dec> {
  let total = dec(0);
  for (const value of values) total = total.plus(dec(value));
  return total;
}

const money = (value: ReturnType<typeof dec>): string => value.toDecimalPlaces(2).toFixed(2);

describe.skipIf(!SEEDED)('ECLens API against the seeded database', () => {
  const demoEmail = (role: RoleName): string => DEMO_USERS.find((user) => user.role === role)!.email;

  let analyst: Session;
  let admin: Session;
  let reviewer: Session;
  let auditor: Session;
  let demoOrganizationId: string;
  /** The seeded APPROVED run. Its publicId is regenerated on every seed. */
  let seededRunPublicId: string;
  let seededSnapshotPublicId: string;
  let seededModelConfigurationId: string;
  let seededScenarioSetId: string;
  /** Two Stage 1 exposures the override tests borrow and then put back. */
  let overrideTargets: Array<{ id: string; publicId: string }>;

  /** The whole result set of the seeded run, paged the way the UI pages it. */
  let allResultRows: Array<Record<string, unknown> & { lossAllowance: string; grossCarryingAmount: string; netCarryingAmount: string; ead: string; stage: number; exposureId: string; scenarioContributions: Array<{ weightedEcl: string }> }>;
  let runTotals: Record<string, unknown> & {
    currency: string;
    exposureCount: number;
    totalGrossCarryingAmount: string;
    totalEad: string;
    totalLossAllowance: string;
    totalNetCarryingAmount: string;
    coverageRatio: string;
    stageBuckets: Array<{ stage: number; exposureCount: number; grossCarryingAmount: string; ead: string; lossAllowance: string; netCarryingAmount: string; coverageRatio: string }>;
    stageDistribution: Record<string, { balance: string; ecl: string; count: number }>;
    roundingPolicy: string;
  };

  /**
   * Removes every override on the borrowed exposures and re-runs the model
   * assessment, so an override left behind by an earlier failed run cannot make
   * this one start from a different stage. `StagingAssessment.overrideId` is a
   * plain column with no foreign key, so this order is safe.
   */
  async function resetOverrides(exposureIds: string[]): Promise<void> {
    if (exposureIds.length === 0) return;
    await prisma.exceptionItem.deleteMany({ where: { exposureId: { in: exposureIds }, kind: 'ANALYST_OVERRIDE' } });
    await prisma.stageOverride.deleteMany({ where: { exposureId: { in: exposureIds } } });
    const ruleSet = await activeRuleSet(demoOrganizationId);
    for (const exposureId of exposureIds) {
      const row = await prisma.exposure.findUniqueOrThrow({ where: { id: exposureId } });
      await reassessExposure(row, ruleSet);
    }
  }

  async function liveStage(exposureId: string): Promise<{ stage: number; modelStage: number; hasOverride: boolean }> {
    const assessment = await prisma.stagingAssessment.findFirst({
      where: { exposureId, runId: null },
      orderBy: { assessedAt: 'desc' },
      select: { stage: true, modelStage: true, hasOverride: true },
    });
    expect(assessment, `no live assessment for ${exposureId}`).not.toBeNull();
    return assessment!;
  }

  beforeAll(async () => {
    // `name` is not unique, so this is a find-first — ordered by createdAt so a
    // database that was seeded more than once still resolves the same tenant.
    const organization = await prisma.organization.findFirstOrThrow({
      where: { name: DEMO_ORGANIZATION },
      orderBy: { createdAt: 'asc' },
    });
    demoOrganizationId = organization.id;

    [analyst, admin, reviewer, auditor] = await Promise.all([
      login(demoEmail('RISK_ANALYST')),
      login(demoEmail('ADMIN')),
      login(demoEmail('REVIEWER')),
      login(demoEmail('AUDITOR')),
    ]);

    const run = await prisma.eclRun.findFirstOrThrow({
      where: { organizationId: demoOrganizationId, status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      select: { publicId: true, snapshotId: true, modelConfigurationId: true, scenarioSetId: true },
    });
    seededRunPublicId = run.publicId;
    seededModelConfigurationId = run.modelConfigurationId;
    seededScenarioSetId = run.scenarioSetId;
    seededSnapshotPublicId = (
      await prisma.portfolioSnapshot.findUniqueOrThrow({ where: { id: run.snapshotId }, select: { publicId: true } })
    ).publicId;

    overrideTargets = await prisma.exposure.findMany({
      // Scoped to the seeded run's snapshot: the same publicId now exists once
      // per reporting period, and the override routes resolve an unqualified
      // publicId to the newest one. Borrowing a historical row would leave
      // `liveStage` reading an exposure the API never touched.
      where: {
        organizationId: demoOrganizationId,
        snapshotId: run.snapshotId,
        stagingAssessments: { some: { runId: null, stage: 1 } },
      },
      orderBy: { publicId: 'asc' },
      take: 2,
      select: { id: true, publicId: true },
    });
    expect(overrideTargets).toHaveLength(2);
    await resetOverrides(overrideTargets.map((target) => target.id));

    // Paged exactly as the results table does. The default ordering is the
    // result id, which is unique, so no row is skipped or repeated.
    allResultRows = [];
    for (let page = 1; ; page += 1) {
      const response = await analyst.agent
        .get(`/api/v1/ecl-runs/${seededRunPublicId}/results`)
        .query({ page, pageSize: MAX_PAGE_SIZE });
      expect(response.status, response.text).toBe(200);
      allResultRows.push(...(response.body.items as typeof allResultRows));
      if (page >= response.body.meta.totalPages) {
        runTotals = response.body.totals;
        break;
      }
    }
  });

  afterAll(async () => {
    await resetOverrides(overrideTargets?.map((target) => target.id) ?? []);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // required_tests[10]: totals equal the sum of exposure results
  // -------------------------------------------------------------------------

  describe('portfolio totals reconcile to the exposure results', () => {
    it('pages through every result exactly once', () => {
      expect(runTotals.exposureCount).toBeGreaterThanOrEqual(750);
      expect(allResultRows).toHaveLength(runTotals.exposureCount);
      expect(new Set(allResultRows.map((row) => row.exposureId)).size).toBe(runTotals.exposureCount);
    });

    it('publishes the rounding policy it actually applies', () => {
      expect(runTotals.roundingPolicy).toBe(ROUNDING_POLICY);
      expect(runTotals.currency).toBe('PKR');
    });

    it('sums the loss allowances to the portfolio total to the cent', () => {
      // ROUNDING_POLICY: each allowance is already rounded once to 2dp, and the
      // portfolio total is their exact sum with no further rounding — so this is
      // an equality, not an approximation.
      expect(money(sum(allResultRows.map((row) => row.lossAllowance)))).toBe(runTotals.totalLossAllowance);
      expect(money(sum(allResultRows.map((row) => row.grossCarryingAmount)))).toBe(runTotals.totalGrossCarryingAmount);
      expect(money(sum(allResultRows.map((row) => row.netCarryingAmount)))).toBe(runTotals.totalNetCarryingAmount);
    });

    it('sums the EADs to the portfolio total within one rounding step per exposure', () => {
      // Unlike the allowance, `eadAtReportingDate` is a product of a 2dp balance
      // and a 6dp conversion factor, so each row is rounded on the way out while
      // the total is rounded once at the end. The gap is bounded by half a paisa
      // per exposure and is documented here rather than hidden.
      const total = sum(allResultRows.map((row) => row.ead));
      const drift = total.minus(dec(runTotals.totalEad)).abs();
      expect(drift.lte(dec(allResultRows.length).times('0.005'))).toBe(true);
    });

    it('derives each net carrying amount as gross minus allowance', () => {
      for (const row of allResultRows) {
        expect(money(dec(row.grossCarryingAmount).minus(dec(row.lossAllowance))), row.exposureId).toBe(
          row.netCarryingAmount,
        );
      }
    });

    it('derives each allowance as the exact sum of its weighted scenario ECLs', () => {
      for (const row of allResultRows) {
        expect(money(sum(row.scenarioContributions.map((scenario) => scenario.weightedEcl))), row.exposureId).toBe(
          row.lossAllowance,
        );
      }
    });

    it('splits the same money across the stage buckets and distribution', () => {
      const buckets = [...runTotals.stageBuckets].sort((a, b) => a.stage - b.stage);
      expect(buckets.map((bucket) => bucket.stage)).toEqual([1, 2, 3]);
      expect(buckets.reduce((total, bucket) => total + bucket.exposureCount, 0)).toBe(runTotals.exposureCount);
      expect(money(sum(buckets.map((bucket) => bucket.lossAllowance)))).toBe(runTotals.totalLossAllowance);
      expect(money(sum(buckets.map((bucket) => bucket.grossCarryingAmount)))).toBe(runTotals.totalGrossCarryingAmount);

      for (const bucket of buckets) {
        const rows = allResultRows.filter((row) => row.stage === bucket.stage);
        const distribution = runTotals.stageDistribution[String(bucket.stage)];
        expect(rows, `stage ${bucket.stage}`).toHaveLength(bucket.exposureCount);
        expect(distribution.count).toBe(bucket.exposureCount);
        expect(money(sum(rows.map((row) => row.lossAllowance)))).toBe(bucket.lossAllowance);
        expect(distribution.ecl).toBe(bucket.lossAllowance);
        expect(money(sum(rows.map((row) => row.grossCarryingAmount)))).toBe(bucket.grossCarryingAmount);
        expect(distribution.balance).toBe(bucket.grossCarryingAmount);
      }
    });

    it('shows the dashboard the same totals as the run that produced them', async () => {
      const response = await analyst.agent.get('/api/v1/portfolio/summary');
      expect(response.status, response.text).toBe(200);
      expect(response.body.totals).toEqual(runTotals);
      expect(response.body.lineage).not.toBeNull();
      expect(response.body.lineage.modelConfigurationVersion).toBe('1.0.0');
    });
  });

  // -------------------------------------------------------------------------
  // acceptance_criteria[2]: portfolio total -> period-level formula trace
  // -------------------------------------------------------------------------

  describe('the drill-down from a total to a single period', () => {
    it('exposes period PD, LGD, EAD, discount factor, weight and formula trace', async () => {
      const exposureId = allResultRows[0].exposureId;
      const response = await analyst.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}/results/${exposureId}`);
      expect(response.status, response.text).toBe(200);

      const { result, scenarioPeriods, fullResult } = response.body;
      expect(result.exposureId).toBe(exposureId);
      expect(scenarioPeriods).toHaveLength(3);

      // Active scenario weights must total exactly 1.
      expect(sum(scenarioPeriods.map((entry: { scenario: { weight: string } }) => entry.scenario.weight)).toString()).toBe('1');

      for (const entry of scenarioPeriods) {
        const { scenario, periods } = entry as {
          scenario: { scenarioCode: string; weight: string; unweightedEcl: string; weightedEcl: string; horizonMonths: number; cumulativePdInHorizon: string };
          periods: Array<Record<string, unknown>>;
        };
        expect(periods.length, scenario.scenarioCode).toBeGreaterThan(0);
        expect(periods.length, scenario.scenarioCode).toBe(scenario.horizonMonths);

        // ROUNDING_POLICY: the scenario ECL is the exact sum of the rounded
        // period expected losses, so the visible table always adds up.
        expect(money(sum(periods.map((period) => period.expectedLoss as string))), scenario.scenarioCode).toBe(
          scenario.unweightedEcl,
        );
        expect(money(dec(scenario.unweightedEcl).times(dec(scenario.weight))), scenario.scenarioCode).toBe(
          scenario.weightedEcl,
        );

        let previousCumulative = dec(0);
        for (const period of periods) {
          const trace = period.formulaTrace as string;
          expect(trace.length, scenario.scenarioCode).toBeGreaterThan(0);
          for (const field of ['marginalPd', 'cumulativePd', 'lgd', 'ead', 'discountFactor', 'expectedLoss'] as const) {
            expect(typeof period[field], `${scenario.scenarioCode} p${period.period} ${field}`).toBe('string');
            expect(dec(period[field] as string).gte(0), `${scenario.scenarioCode} p${period.period} ${field}`).toBe(true);
          }
          // Survival logic: cumulative default probability rises and never passes 1.
          const cumulative = dec(period.cumulativePd as string);
          expect(cumulative.gte(previousCumulative), `${scenario.scenarioCode} p${period.period}`).toBe(true);
          expect(cumulative.lte(1), `${scenario.scenarioCode} p${period.period}`).toBe(true);
          expect(dec(period.discountFactor as string).lte(1), `${scenario.scenarioCode} p${period.period}`).toBe(true);
          previousCumulative = cumulative;
        }
        expect(dec(scenario.cumulativePdInHorizon).equals(previousCumulative), scenario.scenarioCode).toBe(true);
      }

      // Weighted scenario ECLs sum to the allowance shown one level up.
      expect(
        money(sum(fullResult.scenarioResults.map((scenario: { weightedEcl: string }) => scenario.weightedEcl))),
      ).toBe(result.lossAllowance);

      // Every output names its input version, configuration version, reporting
      // date, scenario set, actor and timestamp.
      const lineage = fullResult.lineage;
      expect(lineage.inputVersion.length).toBeGreaterThan(0);
      expect(lineage.modelConfigurationVersion).toBe('1.0.0');
      expect(lineage.stagingRuleSetVersion).toBe('1.0.0');
      expect(lineage.scenarioSetVersion).toBe('1.0.0');
      expect(lineage.reportingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lineage.calculatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(lineage.actorName.length).toBeGreaterThan(0);
      expect(lineage.roundingPolicy).toBe(ROUNDING_POLICY);

      // The single-period shortcut is labelled as an approximation, never as ECL.
      expect(result.educationalApproximation.label.toLowerCase()).toContain('approximation');
    });

    it('carries the whole exposure story on one detail call', async () => {
      const exposureId = allResultRows[0].exposureId;
      const response = await analyst.agent.get(`/api/v1/portfolio/exposures/${exposureId}`);
      expect(response.status, response.text).toBe(200);

      const detail = response.body;
      expect(detail.exposure.publicId).toBe(exposureId);
      expect(detail.exposure.inputVersion.length).toBeGreaterThan(0);
      expect(detail.staging.ruleSetId).toBe(DEFAULT_MODEL_CONFIGURATION.stagingRuleSet.id);
      expect(detail.staging.ruleSetVersion).toBe('1.0.0');
      expect([1, 2, 3]).toContain(detail.staging.stage);
      expect(detail.staging.primaryReason.length).toBeGreaterThan(0);
      expect(detail.latestResult).not.toBeNull();
      expect(detail.latestResult.runId).toBe(seededRunPublicId);
      expect(detail.lineage.modelConfigurationVersion).toBe('1.0.0');
      expect(Array.isArray(detail.overrideHistory)).toBe(true);
      expect(Array.isArray(detail.exceptions)).toBe(true);
      expect(Array.isArray(detail.auditTrail)).toBe(true);

      // A contractual schedule, when present, is the engine's own EAD formula
      // re-rendered: drawn + CCF x undrawn, in Decimal.
      if (detail.exposure.hasContractualSchedule) {
        expect(detail.eadSchedule.length).toBeGreaterThan(0);
        const ccf = dec(detail.exposure.creditConversionFactor);
        for (const point of detail.eadSchedule) {
          const expected = money(dec(point.drawnBalance).plus(ccf.times(dec(point.undrawnCommitment))));
          expect(point.ead, `period ${point.period}`).toBe(expected);
        }
      } else {
        expect(detail.eadSchedule).toEqual([]);
        expect(detail.exposure.simplifiedEadProfile.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // required_tests[8]: override authorization and audit history
  // -------------------------------------------------------------------------

  describe('analyst stage overrides', () => {
    it('refuses a reviewer decision from the admin who raised it, then accepts one from a reviewer', async () => {
      const target = overrideTargets[0];
      const before = await liveStage(target.id);
      expect(before.hasOverride).toBe(false);

      try {
        // ADMIN is the actor here on purpose: it is the only role holding both
        // `exposure:override` and `override:review`, so it is the only one for
        // which self-review is expressible at all. An analyst is stopped earlier
        // by the permission matrix, which the role-permission suite covers.
        const raised = await admin.agent
          .post(`/api/v1/exposures/${target.publicId}/stage-override`)
          .send({ stageAfter: 2, reason: 'Borrower entered a formal forbearance arrangement not yet in the feed.' });
        expect(raised.status, raised.text).toBe(201);
        expect(raised.body.override.stageBefore).toBe(before.stage);
        expect(raised.body.override.stageAfter).toBe(2);
        expect(raised.body.override.reviewerStatus).toBe('PENDING_REVIEW');
        expect(raised.body.override.actorName).toBe(admin.fullName);
        expect(raised.body.override.reviewedAt).toBeNull();
        const overrideId = raised.body.override.id;

        // A pending override is already in force, which is the documented trade.
        expect((await liveStage(target.id)).stage).toBe(2);

        // Self-review is refused in the service layer, not per route.
        const selfReview = await admin.agent
          .post(`/api/v1/stage-overrides/${overrideId}/review`)
          .send({ decision: 'REVIEWED', comment: 'Approving my own request' });
        expect(selfReview.status, selfReview.text).toBe(409);
        expect(selfReview.body.error.code).toBe('OVERRIDE_SELF_REVIEW_PROHIBITED');

        // Rejecting restores the model stage.
        const rejected = await reviewer.agent
          .post(`/api/v1/stage-overrides/${overrideId}/review`)
          .send({ decision: 'REJECTED', comment: 'Forbearance is already reflected in the watchlist flag.' });
        expect(rejected.status, rejected.text).toBe(200);
        expect(rejected.body.override.reviewerStatus).toBe('REJECTED');
        expect(rejected.body.override.reviewerName).toBe(reviewer.fullName);
        expect(rejected.body.override.reviewedAt).not.toBeNull();

        const after = await liveStage(target.id);
        expect(after.stage).toBe(before.modelStage);
        expect(after.hasOverride).toBe(false);

        // A rejected override cannot be decided twice.
        const twice = await reviewer.agent
          .post(`/api/v1/stage-overrides/${overrideId}/review`)
          .send({ decision: 'REVIEWED', comment: 'Changed my mind' });
        expect(twice.status).toBe(409);
        expect(twice.body.error.code).toBe('OVERRIDE_ALREADY_REVIEWED');

        // Both halves of the four-eyes control are in the immutable trail.
        const history = await analyst.agent.get(`/api/v1/exposures/${target.publicId}/override-history`);
        expect(history.status, history.text).toBe(200);
        expect(history.body.items).toHaveLength(1);
        expect(history.body.items[0].reviewerStatus).toBe('REJECTED');
      } finally {
        // A pending override is live the moment it is raised, so a failure part
        // way through would otherwise leave this exposure on the wrong stage for
        // every test that runs after it.
        await resetOverrides([target.id]);
      }
    });

    it('rejects an override that would not change the stage', async () => {
      const target = overrideTargets[1];
      const before = await liveStage(target.id);
      const response = await analyst.agent
        .post(`/api/v1/exposures/${target.publicId}/stage-override`)
        .send({ stageAfter: before.stage, reason: 'No change at all, this should be refused.' });
      expect(response.status, response.text).toBe(422);
      expect(response.body.error.code).toBe('OVERRIDE_NO_CHANGE');
    });

    it('rejects a reason too short to be an audit trail', async () => {
      const target = overrideTargets[1];
      const response = await analyst.agent
        .post(`/api/v1/exposures/${target.publicId}/stage-override`)
        .send({ stageAfter: 2, reason: 'too short' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('records the request and the review as separate audit events', async () => {
      const response = await auditor.agent
        .get('/api/v1/audit-events')
        .query({ action: 'EXPOSURE.STAGE_OVERRIDE_REQUESTED', pageSize: 10 });
      expect(response.status, response.text).toBe(200);
      expect(response.body.items.length).toBeGreaterThan(0);
      for (const event of response.body.items) {
        expect(event.action).toBe('EXPOSURE.STAGE_OVERRIDE_REQUESTED');
        expect(event.entityType).toBe('Exposure');
        expect(event.organizationId).toBe(demoOrganizationId);
        expect(event.detail).toContain('Awaiting review');
        expect(event.userName.length).toBeGreaterThan(0);
        expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }

      const reviews = await auditor.agent
        .get('/api/v1/audit-events')
        .query({ action: 'EXPOSURE.STAGE_OVERRIDE_REVIEWED', pageSize: 10 });
      expect(reviews.status, reviews.text).toBe(200);
      expect(reviews.body.items.length).toBeGreaterThan(0);
      expect(reviews.body.items[0].detail).toContain('Rejected');
    });

    it('surfaces the override in the exception queue and triages it', async () => {
      const target = overrideTargets[1];

      try {
        const raised = await analyst.agent
          .post(`/api/v1/exposures/${target.publicId}/stage-override`)
          .send({ stageAfter: 2, reason: 'Group-wide restructuring agreed with the borrower this week.' });
        expect(raised.status, raised.text).toBe(201);

        // The queue is the analyst's work list, so the override appears in it
        // without anyone having to file a separate report.
        const filtered = await analyst.agent.get('/api/v1/exceptions').query({ kind: 'ANALYST_OVERRIDE' });
        expect(filtered.status, filtered.text).toBe(200);
        expect(filtered.body.meta.totalItems).toBeGreaterThan(0);
        const item = filtered.body.items.find(
          (candidate: { exposurePublicId: string | null }) => candidate.exposurePublicId === target.publicId,
        );
        expect(item, `${target.publicId} missing from the ANALYST_OVERRIDE queue`).toBeDefined();
        expect(item.kind).toBe('ANALYST_OVERRIDE');
        expect(item.status).toBe('OPEN');
        expect(item.severity).toMatch(/^(LOW|MEDIUM|HIGH)$/);
        expect(item.detail.length).toBeGreaterThan(0);
        expect(item.borrowerName.length).toBeGreaterThan(0);

        const summary = await analyst.agent.get('/api/v1/exceptions/summary');
        expect(summary.status, summary.text).toBe(200);
        expect(summary.body.byKind.ANALYST_OVERRIDE).toBeGreaterThan(0);
        // The badges are a partition of the queue, not an independent count.
        expect(summary.body.open + summary.body.acknowledged + summary.body.resolved).toBe(summary.body.total);

        // Triage walks OPEN -> ACKNOWLEDGED -> RESOLVED and never backwards.
        const acknowledged = await analyst.agent
          .post(`/api/v1/exceptions/${item.id}/acknowledge`)
          .send({ note: 'Picked up for the September committee.' });
        expect(acknowledged.status, acknowledged.text).toBe(200);
        expect(acknowledged.body.exception.status).toBe('ACKNOWLEDGED');
        expect(acknowledged.body.exception.acknowledgedBy).toBe(analyst.fullName);

        const twice = await analyst.agent.post(`/api/v1/exceptions/${item.id}/acknowledge`).send({});
        expect(twice.status).toBe(409);
        expect(twice.body.error.code).toBe('EXCEPTION_ALREADY_ACKNOWLEDGED');

        const resolved = await analyst.agent
          .post(`/api/v1/exceptions/${item.id}/resolve`)
          .send({ note: 'Reviewer accepted the restructuring evidence.' });
        expect(resolved.status, resolved.text).toBe(200);
        expect(resolved.body.exception.status).toBe('RESOLVED');

        // Resolved is terminal: the queue is evidence of what was handled.
        const afterResolved = await analyst.agent.post(`/api/v1/exceptions/${item.id}/resolve`).send({});
        expect(afterResolved.status).toBe(409);
        expect(afterResolved.body.error.code).toBe('EXCEPTION_ALREADY_RESOLVED');

        // An auditor may read the queue but working an item is a decision.
        const auditorTriage = await auditor.agent.post(`/api/v1/exceptions/${item.id}/acknowledge`).send({});
        expect(auditorTriage.status).toBe(403);
        expect(auditorTriage.body.error.code).toBe('FORBIDDEN');
        expect((await auditor.agent.get('/api/v1/exceptions')).status).toBe(200);
      } finally {
        await resetOverrides([target.id]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // required_tests[12]: role permissions on sensitive endpoints
  // -------------------------------------------------------------------------

  describe('role permissions on sensitive endpoints', () => {
    const forbidden = async (session: Session, method: 'get' | 'post', path: string, body?: unknown) => {
      const response =
        method === 'get'
          ? await session.agent.get(path)
          : await session.agent.post(path).send(body ?? { comment: 'not permitted for this role' });
      expect(response.status, `${session.role} ${method.toUpperCase()} ${path}: ${response.text}`).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message).toContain('Requires permission');
    };

    it('refuses an unauthenticated caller before any permission is considered', async () => {
      const response = await request(app).get('/api/v1/portfolio/summary');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('keeps the auditor read-only', async () => {
      await forbidden(auditor, 'post', `/api/v1/exposures/${overrideTargets[0].publicId}/stage-override`);
      await forbidden(auditor, 'post', `/api/v1/ecl-runs/${seededRunPublicId}/approve`);
      await forbidden(auditor, 'post', '/api/v1/ecl-runs');
      await forbidden(auditor, 'post', '/api/v1/model-configurations');
      // The read side is exactly what an auditor is for.
      expect((await auditor.agent.get('/api/v1/audit-events')).status).toBe(200);
      expect((await auditor.agent.get('/api/v1/portfolio/exposures')).status).toBe(200);
    });

    it('lets a reviewer decide but not act', async () => {
      await forbidden(reviewer, 'post', `/api/v1/exposures/${overrideTargets[0].publicId}/stage-override`);
      await forbidden(reviewer, 'post', '/api/v1/ecl-runs');
      await forbidden(reviewer, 'post', '/api/v1/model-configurations');
      await forbidden(reviewer, 'post', '/api/v1/scenario-sets');
      expect((await reviewer.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}`)).status).toBe(200);
    });

    it('lets an analyst act but not review', async () => {
      await forbidden(analyst, 'post', `/api/v1/stage-overrides/${newId()}/review`);
      await forbidden(analyst, 'post', `/api/v1/ecl-runs/${seededRunPublicId}/approve`);
      await forbidden(analyst, 'post', '/api/v1/model-configurations');
      expect((await analyst.agent.get('/api/v1/portfolio/exposures')).status).toBe(200);
    });

    it('lets an admin reach everything the matrix allows', async () => {
      expect((await admin.agent.get('/api/v1/model-configurations')).status).toBe(200);
      expect((await admin.agent.get('/api/v1/scenario-sets')).status).toBe(200);
      expect((await admin.agent.get('/api/v1/imports')).status).toBe(200);
    });

    it('publishes the resolved permission list on both session endpoints', async () => {
      // The web app gates every write control on `user.permissions`. The field is
      // declared on `SessionUserRecord` but was never populated, so `can()` read
      // `undefined.includes(...)` and threw on every permission-gated screen —
      // a contract type that the compiler could not catch, because it was the
      // server that failed to honour its own declared shape.
      for (const session of [admin, analyst, reviewer, auditor]) {
        const expected = [...permissionsForRole(session.role as Parameters<typeof permissionsForRole>[0])];

        const signed = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: session.email, password: DEMO_PASSWORD });
        expect(signed.status, `login failed for ${session.email}: ${signed.text}`).toBe(200);
        expect(signed.body.user.permissions, `${session.role} login`).toEqual(expected);

        const restored = await session.agent.get('/api/v1/auth/me');
        expect(restored.status).toBe(200);
        expect(restored.body.user.permissions, `${session.role} /auth/me`).toEqual(expected);
      }
    });
  });

  // -------------------------------------------------------------------------
  // required_tests[12]: organization isolation
  // -------------------------------------------------------------------------

  describe('organization isolation', () => {
    const OTHER_ORG = 'Integration Test Isolation Bank';
    const OTHER_EMAIL = 'isolation-analyst@eclens.test';
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
          fullName: 'Isolation Test Analyst',
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

    it('sees an empty portfolio of its own', async () => {
      const exposures = await other.agent.get('/api/v1/portfolio/exposures');
      expect(exposures.status, exposures.text).toBe(200);
      expect(exposures.body.items).toEqual([]);
      expect(exposures.body.meta.totalItems).toBe(0);

      const runs = await other.agent.get('/api/v1/ecl-runs');
      expect(runs.status, runs.text).toBe(200);
      expect(runs.body.items).toEqual([]);

      const configurations = await other.agent.get('/api/v1/model-configurations');
      expect(configurations.status, configurations.text).toBe(200);
      expect(configurations.body.items).toEqual([]);
    });

    it('cannot read the demo organization by id, publicId or search', async () => {
      const summary = await other.agent.get('/api/v1/portfolio/summary');
      expect(summary.status, summary.text).toBe(404);

      const exposure = await other.agent.get(`/api/v1/portfolio/exposures/${allResultRows[0].exposureId}`);
      expect(exposure.status, exposure.text).toBe(404);
      expect(exposure.body.error.code).toBe('NOT_FOUND');

      const run = await other.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}`);
      expect(run.status, run.text).toBe(404);

      const results = await other.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}/results`);
      expect(results.status, results.text).toBe(404);

      const detail = await other.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}/results/${allResultRows[0].exposureId}`);
      expect(detail.status, detail.text).toBe(404);

      const snapshot = await other.agent.get(`/api/v1/portfolio/snapshots`);
      expect(snapshot.status, snapshot.text).toBe(200);
      expect(snapshot.body.items).toEqual([]);
    });

    it('cannot act on the demo organization either', async () => {
      const override = await other.agent
        .post(`/api/v1/exposures/${allResultRows[0].exposureId}/stage-override`)
        .send({ stageAfter: 3, reason: 'Cross-tenant attempt that must never be recorded.' });
      expect(override.status, override.text).toBe(404);

      // RISK_ANALYST holds `run:create`, so this reaches the service and must
      // fail on tenancy, not on permissions: every id belongs to another bank.
      const createRun = await other.agent.post('/api/v1/ecl-runs').send({
        runDate: '2026-08-31',
        snapshotId: seededSnapshotPublicId,
        modelConfigurationId: '1.0.0',
        scenarioSetId: '1.0.0',
        notes: 'Cross-tenant run that must never be created.',
      });
      expect(createRun.status, createRun.text).toBe(404);

      // `run:review` is not in the analyst matrix, so this is refused by the
      // permission layer before the run is ever looked up. Asserted as 403
      // rather than 404 because that is what actually happens — and a 403 here
      // still proves the tenant boundary, since the request never resolves it.
      const approve = await other.agent
        .post(`/api/v1/ecl-runs/${seededRunPublicId}/approve`)
        .send({ comment: 'Cross-tenant approval attempt' });
      expect(approve.status, approve.text).toBe(403);
      expect(approve.body.error.code).toBe('FORBIDDEN');

      // Nothing was written anywhere by those attempts.
      const leakedOverrides = await prisma.stageOverride.count({
        where: { organizationId: demoOrganizationId, stageAfter: 3, reason: { contains: 'Cross-tenant' } },
      });
      expect(leakedOverrides).toBe(0);
      const leakedRuns = await prisma.eclRun.count({
        where: { notes: { contains: 'Cross-tenant' } },
      });
      expect(leakedRuns).toBe(0);
    });

    it('reads only its own audit trail', async () => {
      const response = await other.agent.get('/api/v1/audit-events').query({ pageSize: MAX_PAGE_SIZE });
      expect(response.status, response.text).toBe(200);
      expect(response.body.items.length).toBeGreaterThan(0);
      for (const event of response.body.items) {
        expect(event.organizationId).toBe(otherOrganizationId);
        expect(event.entityId).not.toBe(seededRunPublicId);
        expect(event.entityId).not.toBe(seededSnapshotPublicId);
      }
    });

    it('scoping is not reachable through a query parameter', async () => {
      // `organizationId` is taken from the session, never from the request.
      const response = await other.agent
        .get('/api/v1/portfolio/exposures')
        .query({ organizationId: demoOrganizationId, snapshotId: seededSnapshotPublicId, pageSize: MAX_PAGE_SIZE });
      expect(response.status, response.text).toBe(200);
      expect(response.body.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // required_tests[11] + acceptance_criteria[4]: frozen history
  // -------------------------------------------------------------------------

  describe('a superseded configuration version cannot rewrite history', () => {
    const SUPERSEDING_VERSION = '9.9.9-integration-test';

    it('activates a new version and leaves the approved run untouched', async () => {
      const before = await analyst.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}`);
      expect(before.status, before.text).toBe(200);
      const beforeRun = before.body.run;
      expect(beforeRun.status).toBe('APPROVED');
      expect(beforeRun.modelConfigurationVersion).toBe('1.0.0');
      expect(beforeRun.lockedConfiguration.version).toBe('1.0.0');

      const allowancesBefore = new Map(allResultRows.map((row) => [row.exposureId, row.lossAllowance]));

      let createdConfigurationId: string | null = null;
      try {
        const created = await admin.agent.post('/api/v1/model-configurations').send({
          ...DEFAULT_MODEL_CONFIGURATION,
          version: SUPERSEDING_VERSION,
          description: 'Integration-test version that supersedes the seeded one.',
          // A real change of assumption, not just a version bump.
          defaultCreditConversionFactor: '0.75',
          approvedBy: 'Integration Test Committee',
          approvedAt: '2026-09-02',
          activate: true,
        });
        expect(created.status, created.text).toBe(201);
        createdConfigurationId = created.body.modelConfiguration.id;
        expect(created.body.modelConfiguration.version).toBe(SUPERSEDING_VERSION);
        expect(created.body.modelConfiguration.isActive).toBe(true);
        expect(created.body.modelConfiguration.supersedesVersion).toBe('1.0.0');

        // The seeded version is no longer the one a new run would pick up.
        const listed = await admin.agent.get('/api/v1/model-configurations').query({ pageSize: MAX_PAGE_SIZE });
        expect(listed.status, listed.text).toBe(200);
        const byVersion = new Map(
          listed.body.items.map((item: { version: string; isActive: boolean; lockedByRunCount: number }) => [
            item.version,
            item,
          ]),
        );
        expect(byVersion.get('1.0.0').isActive).toBe(false);
        expect(byVersion.get('1.0.0').lockedByRunCount).toBeGreaterThan(0);
        expect(byVersion.get(SUPERSEDING_VERSION).isActive).toBe(true);

        // The configuration a new run would pick up really has moved on. This
        // is the ModelConfiguration, not the staging rule set: the superseding
        // version reuses the default rule set, so the rule set legitimately
        // still reads 1.0.0 and asserting otherwise would prove nothing.
        const activeNow = await prisma.modelConfiguration.findFirstOrThrow({
          where: { organizationId: demoOrganizationId, isActive: true },
          select: { version: true },
        });
        expect(activeNow.version).toBe(SUPERSEDING_VERSION);

        // ...and the approved run still reports, and still renders, the old one.
        const after = await analyst.agent.get(`/api/v1/ecl-runs/${seededRunPublicId}`);
        expect(after.status, after.text).toBe(200);
        expect(after.body.run.modelConfigurationVersion).toBe('1.0.0');
        expect(after.body.run.lockedConfiguration.version).toBe('1.0.0');
        expect(after.body.run.lockedConfiguration.defaultCreditConversionFactor).toBe(
          DEFAULT_MODEL_CONFIGURATION.defaultCreditConversionFactor,
        );
        expect(after.body.run.totals).toEqual(beforeRun.totals);

        const resultsAfter = await analyst.agent
          .get(`/api/v1/ecl-runs/${seededRunPublicId}/results`)
          .query({ pageSize: MAX_PAGE_SIZE });
        expect(resultsAfter.status, resultsAfter.text).toBe(200);
        for (const row of resultsAfter.body.items) {
          expect(row.lossAllowance, row.exposureId).toBe(allowancesBefore.get(row.exposureId));
        }

        // A locked run cannot be recomputed under the new assumptions either.
        const execute = await analyst.agent.post(`/api/v1/ecl-runs/${seededRunPublicId}/execute`);
        expect(execute.status, execute.text).toBe(409);
        expect(execute.body.error.code).toBe('RUN_LOCKED');

        // Re-registering the same version is refused rather than overwriting it.
        const duplicate = await admin.agent.post('/api/v1/model-configurations').send({
          ...DEFAULT_MODEL_CONFIGURATION,
          version: SUPERSEDING_VERSION,
          approvedBy: 'Integration Test Committee',
          approvedAt: '2026-09-02',
        });
        expect(duplicate.status, duplicate.text).toBe(409);
        expect(duplicate.body.error.code).toBe('MODEL_CONFIGURATION_VERSION_EXISTS');
      } finally {
        if (createdConfigurationId) {
          await prisma.modelConfiguration.deleteMany({ where: { id: createdConfigurationId } });
          await prisma.modelConfiguration.updateMany({
            where: { organizationId: demoOrganizationId, id: seededModelConfigurationId },
            data: { isActive: true },
          });
        }
      }

      const restored = await admin.agent.get('/api/v1/model-configurations/1.0.0');
      expect(restored.status, restored.text).toBe(200);
      expect(restored.body.modelConfiguration.isActive).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // implementation_tasks[7]: the run workflow and its four-eyes control
  // -------------------------------------------------------------------------

  describe('the run review workflow', () => {
    it('creates a draft run with a readiness assessment that names its thresholds', async () => {
      const response = await analyst.agent.post('/api/v1/ecl-runs').send({
        runDate: '2026-08-31',
        snapshotId: seededSnapshotPublicId,
        modelConfigurationId: seededModelConfigurationId,
        scenarioSetId: seededScenarioSetId,
        notes: 'Integration-test draft run.',
      });
      expect(response.status, response.text).toBe(201);
      const run = response.body.run;
      const draftRunId = await internalRunId(run.publicId as string);

      try {
        expect(run.status).toBe('DRAFT');
        expect(run.createdByName).toBe(analyst.fullName);
        expect(run.readiness.ready).toBe(true);
        expect(run.readiness.checks.map((check: { code: string }) => check.code)).toEqual([
          'SNAPSHOT_HAS_EXPOSURES',
          'SCENARIO_SET_NORMALIZED',
          'STAGING_RULE_SET_VALID',
          'MATURITY_AFTER_REPORTING_DATE',
          'EIR_WITHIN_CONFIGURED_BOUNDS',
          'RUN_STATUS_EXECUTABLE',
        ]);
        for (const check of run.readiness.checks) {
          // Each check explains itself with the configured number it applied.
          expect(check.message.length, check.code).toBeGreaterThan(20);
        }
        expect(run.readiness.checks[2].message).toContain('DPD>=90');
      } finally {
        await prisma.eclRun.deleteMany({ where: { id: draftRunId } });
      }
    });

    it('refuses self-review and accepts a review from a second person', async () => {
      // ADMIN creates the run on purpose: `run:review` is not in the analyst
      // matrix, so an analyst submitting their own run is stopped by the
      // permission layer with a 403 and the service-layer guard below would
      // never execute. ADMIN is the only role holding `run:create`,
      // `run:submit` and `run:review` together, which is what makes
      // self-review expressible at all. The role suite covers the analyst 403.
      const created = await admin.agent.post('/api/v1/ecl-runs').send({
        runDate: '2026-08-31',
        snapshotId: seededSnapshotPublicId,
        modelConfigurationId: seededModelConfigurationId,
        scenarioSetId: seededScenarioSetId,
        notes: 'Integration-test four-eyes run.',
      });
      expect(created.status, created.text).toBe(201);
      const publicId = created.body.run.publicId as string;
      const runId = await internalRunId(publicId);

      try {
        // Nothing has been calculated yet, so neither submit nor review is possible.
        const prematureSubmit = await admin.agent.post(`/api/v1/ecl-runs/${publicId}/submit`);
        expect(prematureSubmit.status, prematureSubmit.text).toBe(409);
        expect(prematureSubmit.body.error.code).toBe('RUN_NOT_SUBMITTABLE');

        const prematureApprove = await reviewer.agent
          .post(`/api/v1/ecl-runs/${publicId}/approve`)
          .send({ comment: 'Approving a run that was never calculated' });
        expect(prematureApprove.status, prematureApprove.text).toBe(409);
        expect(prematureApprove.body.error.code).toBe('RUN_NOT_SUBMITTED');

        // Fixture: put the run in SUBMITTED without re-running the 33k-period
        // calculation. The control under test is who may review, not the engine.
        await prisma.eclRun.update({
          where: { id: runId },
          data: { status: 'SUBMITTED', submittedById: admin.id, submittedBy: admin.fullName, submittedAt: new Date() },
        });

        // The guard is on the creator, not the submitter — asserted for both
        // decisions so a run cannot be washed through by rejecting it first.
        const selfApprove = await admin.agent
          .post(`/api/v1/ecl-runs/${publicId}/approve`)
          .send({ comment: 'Approving my own run' });
        expect(selfApprove.status, selfApprove.text).toBe(409);
        expect(selfApprove.body.error.code).toBe('RUN_SELF_APPROVAL_PROHIBITED');

        const selfReject = await admin.agent
          .post(`/api/v1/ecl-runs/${publicId}/reject`)
          .send({ comment: 'Rejecting my own run' });
        expect(selfReject.status, selfReject.text).toBe(409);
        expect(selfReject.body.error.code).toBe('RUN_SELF_REJECTION_PROHIBITED');

        const approved = await reviewer.agent
          .post(`/api/v1/ecl-runs/${publicId}/approve`)
          .send({ comment: 'Reconciled against the seeded book; approved.' });
        expect(approved.status, approved.text).toBe(200);
        expect(approved.body.run.status).toBe('APPROVED');
        expect(approved.body.run.reviewDecision).toBe('APPROVED');
        expect(approved.body.run.reviewedByName).toBe(reviewer.fullName);
        expect(approved.body.run.lockedAt).not.toBeNull();

        // Locked: no re-execution and no second review.
        const execute = await analyst.agent.post(`/api/v1/ecl-runs/${publicId}/execute`);
        expect(execute.status, execute.text).toBe(409);
        expect(execute.body.error.code).toBe('RUN_LOCKED');

        const reviewAgain = await reviewer.agent
          .post(`/api/v1/ecl-runs/${publicId}/reject`)
          .send({ comment: 'Changing the decision after locking' });
        expect(reviewAgain.status, reviewAgain.text).toBe(409);
        expect(reviewAgain.body.error.code).toBe('RUN_LOCKED');

        const trail = await auditor.agent
          .get('/api/v1/audit-events')
          .query({ entityType: 'EclRun', search: publicId, pageSize: MAX_PAGE_SIZE });
        expect(trail.status, trail.text).toBe(200);
        const actions = new Set(trail.body.items.map((event: { action: string }) => event.action));
        expect(actions.has('ECL_RUN.CREATED')).toBe(true);
        expect(actions.has('ECL_RUN.APPROVED')).toBe(true);
      } finally {
        await prisma.eclRun.deleteMany({ where: { id: runId } });
      }

      expect(await prisma.eclRun.count({ where: { publicId } })).toBe(0);
    });
  });

  /** Wire records carry the publicId; deletion and fixtures need the internal id. */
  async function internalRunId(publicId: string): Promise<string> {
    const run = await prisma.eclRun.findFirstOrThrow({
      where: { organizationId: demoOrganizationId, publicId },
      select: { id: true },
    });
    return run.id;
  }

  describe('the seeded book is the one the demo documents', () => {
    it('holds every segment and every stage', async () => {
      const response = await analyst.agent
        .get('/api/v1/portfolio/exposures')
        .query({ pageSize: MAX_PAGE_SIZE, sortBy: 'publicId', sortDir: 'asc' });
      expect(response.status, response.text).toBe(200);
      expect(response.body.meta.totalItems).toBe(runTotals.exposureCount);
      expect(response.body.meta.pageSize).toBe(MAX_PAGE_SIZE);
      expect(response.body.meta.totalPages).toBe(Math.ceil(runTotals.exposureCount / MAX_PAGE_SIZE));
      expect(response.body.items[0].publicId).toBe('EXP-000001');
    });

    it('filters by stage and agrees with the run totals', async () => {
      for (const stage of [1, 2, 3]) {
        const response = await analyst.agent.get('/api/v1/portfolio/exposures').query({ stage, pageSize: 1 });
        expect(response.status, response.text).toBe(200);
        expect(response.body.meta.totalItems, `stage ${stage}`).toBe(
          runTotals.stageDistribution[String(stage)].count,
        );
      }
    });

    it('searches by borrower name and segment', async () => {
      const bySegment = await analyst.agent
        .get('/api/v1/portfolio/exposures')
        .query({ segment: 'agriculture', pageSize: MAX_PAGE_SIZE });
      expect(bySegment.status, bySegment.text).toBe(200);
      expect(bySegment.body.meta.totalItems).toBeGreaterThan(0);
      for (const item of bySegment.body.items) expect(item.segment).toBe('agriculture');

      const byId = await analyst.agent.get('/api/v1/portfolio/exposures').query({ search: 'EXP-000042' });
      expect(byId.status, byId.text).toBe(200);
      expect(byId.body.items.map((item: { publicId: string }) => item.publicId)).toContain('EXP-000042');
    });
  });

  // -------------------------------------------------------------------------
  // acceptance_criteria[1] + required_tests[9]: ingestion, end to end
  // -------------------------------------------------------------------------

  describe('portfolio ingestion from template to committed snapshot', () => {
    const SAMPLE_ROWS = 50;
    const SNAPSHOT_LABEL = 'Integration ingestion fixture';

    /** Column index of a canonical field in the template's header row. */
    function columnOf(lines: string[], field: string): number {
      const headers = lines[0].split(',');
      const label = TEMPLATE_FIELD_GUIDE.find((entry) => entry.field === field)?.header;
      const index = headers.indexOf(label ?? '');
      expect(index, `template header for '${field}'`).toBeGreaterThanOrEqual(0);
      return index;
    }

    /** Rewrites one cell, leaving every other byte of the row untouched. */
    function corrupt(line: string, index: number, value: string): string {
      const cells = line.split(',');
      cells[index] = value;
      return cells.join(',');
    }

    /**
     * The deterministic generator emits `EXP-000001` upward and the seeded book
     * already owns those ids, so an uploaded sample would correctly report a
     * duplicate on every row. Re-stamp the first field with a test-scoped id.
     */
    function restampIds(lines: string[]): string[] {
      // `corrupt` splits on commas, so a quoted cell would misalign every column
      // after it. Fail loudly rather than corrupt rows silently.
      expect(lines.some((line) => line.includes('"')), 'template CSV must not quote fields').toBe(false);
      return lines.map((line, index) =>
        index === 0 ? line : line.replace(/^[^,]*/, `IT-EXP-${String(index).padStart(6, '0')}`),
      );
    }

    async function upload(csv: string, fileName: string) {
      const response = await admin.agent
        .post('/api/v1/imports/portfolio')
        .attach('file', Buffer.from(csv, 'utf8'), fileName);
      expect(response.status, response.text).toBe(201);
      // 201 carries the job receipt: the batch is queued, not yet validated.
      expect(response.body.record.publicId).toBeTruthy();
      expect(response.body.jobId).toBeTruthy();
      expect(response.body.driver).toBeTruthy();
      return response.body.record.publicId as string;
    }

    /** Polls the list endpoint until the batch leaves its in-flight statuses. */
    async function settled(publicId: string): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await admin.agent.get('/api/v1/imports').query({ search: publicId, pageSize: 5 });
        expect(response.status, response.text).toBe(200);
        const batch = response.body.items.find((item: { publicId: string }) => item.publicId === publicId);
        if (batch && !['QUEUED', 'VALIDATING', 'COMMITTED'].includes(batch.status as string)) return batch;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`import batch ${publicId} never settled`);
    }

    it('runs the whole flow and leaves the seeded book exactly as it found it', async () => {
      const exposureCountBefore = await prisma.exposure.count({ where: { organizationId: admin.organizationId } });
      const createdBatches: string[] = [];
      let createdSnapshotLabel: string | null = null;

      try {
        // 1. Download a real template — the same bytes an analyst would start from.
        const template = await admin.agent
          .get('/api/v1/templates/portfolio')
          .query({ kind: 'sample', format: 'csv', count: SAMPLE_ROWS });
        expect(template.status, template.text).toBe(200);
        expect(template.body.template.rowCount).toBe(SAMPLE_ROWS);
        const raw = Buffer.from(template.body.template.contentBase64 as string, 'base64').toString('utf8');
        const lines = restampIds(raw.trim().split(/\r?\n/));
        expect(lines).toHaveLength(SAMPLE_ROWS + 1);
        const csv = lines.join('\n');

        // 2. Upload it.
        const goodId = await upload(csv, 'integration-good.csv');
        createdBatches.push(goodId);
        const uploaded = await settled(goodId);
        // The generator writes the canonical headers, so the suggested mapping
        // resolves every field without help.
        expect(uploaded.status, JSON.stringify(uploaded.message)).toBe('VALIDATED');
        expect(uploaded.rowCount).toBe(SAMPLE_ROWS);

        // 3. Preview: headers, the first rows verbatim, and the field guide.
        const preview = await admin.agent.get(`/api/v1/imports/${goodId}/preview`);
        expect(preview.status, preview.text).toBe(200);
        expect(preview.body.batch.publicId).toBe(goodId);
        expect(preview.body.previewRows.length).toBeGreaterThan(0);
        expect(preview.body.previewRows[0].cells).toHaveLength(preview.body.batch.headers.length);
        expect(preview.body.fieldGuide).toHaveLength(TEMPLATE_FIELD_GUIDE.length);

        // 4. Apply the server's own suggested mapping and re-validate.
        const mapping: Record<string, string | null> = {};
        for (const [field, suggestion] of Object.entries(
          preview.body.batch.suggestedMapping as Record<string, { header: string } | null>,
        )) {
          mapping[field] = suggestion?.header ?? null;
        }
        expect(Object.values(mapping).filter(Boolean)).toHaveLength(PORTFOLIO_FIELDS.length);
        const mapped = await admin.agent
          .post(`/api/v1/imports/${goodId}/mapping`)
          .send({ mapping, percentageNormalizationMode: 'AS_DECIMAL', revalidate: true });
        expect(mapped.status, mapped.text).toBe(200);
        expect(mapped.body.batch.status).toBe('VALIDATED');
        expect(mapped.body.batch.validRowCount).toBe(SAMPLE_ROWS);
        expect(mapped.body.batch.quarantinedRowCount).toBe(0);
        expect(mapped.body.batch.errorCount).toBe(0);
        expect(mapped.body.batch.missingRequiredFields).toEqual([]);

        // 5. No errors and nothing quarantined. Warnings are expected and are
        //    the point: the generator produces Stage 3 rows through the DPD
        //    backstop with `default_flag` false, and the validator explains that
        //    staging will still assign Stage 3 rather than quietly flipping it.
        const issues = await admin.agent.get(`/api/v1/imports/${goodId}/issues`);
        expect(issues.status, issues.text).toBe(200);
        expect(issues.body.quarantinedRows).toEqual([]);
        const severities = issues.body.issues.map((issue: { severity: string }) => issue.severity);
        expect(severities.filter((severity: string) => severity === 'ERROR')).toEqual([]);
        for (const issue of issues.body.issues) {
          expect(issue.severity).toBe('WARNING');
          expect(issue.issueCode).toBe('FLAG_DPD_INCONSISTENT');
          expect(issue.suggestedCorrection).toBeTruthy();
        }
        const exportCsv = await admin.agent.get(`/api/v1/imports/${goodId}/issues/export`);
        expect(exportCsv.status, exportCsv.text).toBe(200);
        const exportLines = exportCsv.text.trim().split(/\r?\n/);
        expect(exportLines[0]).toContain('rowNumber');
        expect(exportLines).toHaveLength(issues.body.issues.length + 1);

        // 6. Corrupt four rows in ways the validator must catch, then confirm
        //    each is reported with the raw value preserved — never repaired.
        const amountColumn = columnOf(lines, 'grossCarryingAmount');
        const dateColumn = columnOf(lines, 'maturityDate');
        const lgdColumn = columnOf(lines, 'lgd');
        const idColumn = columnOf(lines, 'exposureId');
        const damaged = [lines[0], lines[1]];
        damaged.push(corrupt(lines[2], amountColumn, '-250000'));
        damaged.push(corrupt(lines[3], dateColumn, 'not-a-date'));
        damaged.push(corrupt(lines[4], lgdColumn, '1.7'));
        damaged.push(corrupt(lines[5], idColumn, lines[1].split(',')[idColumn]!));
        damaged.push(...lines.slice(6));

        const badId = await upload(damaged.join('\n'), 'integration-bad.csv');
        createdBatches.push(badId);
        const damagedBatch = await settled(badId);
        expect(damagedBatch.errorCount, JSON.stringify(damagedBatch.message)).toBeGreaterThan(0);

        const badIssues = await admin.agent.get(`/api/v1/imports/${badId}/issues`);
        expect(badIssues.status, badIssues.text).toBe(200);
        const codes = badIssues.body.issues.map((issue: { issueCode: string }) => issue.issueCode);
        expect(codes).toContain('NEGATIVE_AMOUNT');
        expect(codes).toContain('INVALID_DATE');
        expect(codes).toContain('DUPLICATE_EXPOSURE_ID');

        const byCode = (code: string) =>
          badIssues.body.issues.find((issue: { issueCode: string }) => issue.issueCode === code);
        // The whole point of the quarantine: the analyst sees what was actually
        // in the cell, not a value the pipeline quietly substituted.
        expect(byCode('NEGATIVE_AMOUNT').rawValue).toBe('-250000');
        expect(byCode('INVALID_DATE').rawValue).toBe('not-a-date');
        for (const code of ['NEGATIVE_AMOUNT', 'INVALID_DATE', 'DUPLICATE_EXPOSURE_ID']) {
          expect(byCode(code).severity, code).toBe('ERROR');
          expect(byCode(code).rowNumber, code).toBeGreaterThan(0);
          expect(byCode(code).field, code).toBeTruthy();
          expect(byCode(code).message, code).toBeTruthy();
        }

        // AUTO_DETECT read the 1.7 LGD as a percentage and divided by 100 — and
        // said so, rather than making the choice silently. Naming the
        // interpretation is what makes it recoverable.
        const ambiguous = badIssues.body.issues.find(
          (issue: { issueCode: string }) => issue.issueCode === 'AMBIGUOUS_PERCENTAGE',
        );
        expect(ambiguous, 'AUTO_DETECT should flag the ambiguous LGD').toBeTruthy();
        expect(ambiguous.field).toBe('lgd');
        expect(ambiguous.rawValue).toBe('1.7');
        expect(ambiguous.message).toContain('divided by 100');

        // The same file read as decimals leaves 1.7 alone, where it is genuinely
        // out of range for an LGD. This is the normalization choice the mapping
        // screen exposes, and the two readings must not be conflated.
        const asDecimal = await admin.agent
          .post(`/api/v1/imports/${badId}/mapping`)
          .send({ mapping, percentageNormalizationMode: 'AS_DECIMAL', revalidate: true });
        expect(asDecimal.status, asDecimal.text).toBe(200);
        const decimalIssues = await admin.agent.get(`/api/v1/imports/${badId}/issues`);
        const outOfRange = decimalIssues.body.issues.find(
          (issue: { issueCode: string }) => issue.issueCode === 'OUT_OF_RANGE_RATE',
        );
        expect(outOfRange, 'AS_DECIMAL should leave 1.7 out of range').toBeTruthy();
        expect(outOfRange.field).toBe('lgd');
        expect(outOfRange.rawValue).toBe('1.7');
        expect(outOfRange.severity).toBe('ERROR');

        // The damaged rows are held back; the clean ones are still committable.
        expect(damagedBatch.quarantinedRowCount).toBeGreaterThanOrEqual(3);

        const badExport = await admin.agent.get(`/api/v1/imports/${badId}/issues/export`);
        expect(badExport.status, badExport.text).toBe(200);
        expect(badExport.text).toContain('NEGATIVE_AMOUNT');
        expect(badExport.text).toContain('-250000');

        // 7. Commit the good batch and confirm a snapshot appears.
        const commit = await admin.agent
          .post(`/api/v1/imports/${goodId}/commit`)
          .send({ snapshotLabel: SNAPSHOT_LABEL, skipDuplicates: true });
        expect(commit.status, commit.text).toBe(202);
        expect(commit.body.record.status).toBe('COMMITTED');
        expect(commit.body.jobId).toBeTruthy();

        const committed = await settled(goodId);
        expect(committed.status, JSON.stringify(committed.message)).toBe('IMPORTED');
        expect(committed.snapshotLabel).toBe(SNAPSHOT_LABEL);
        expect(committed.snapshotId).toBeTruthy();
        createdSnapshotLabel = SNAPSHOT_LABEL;

        const snapshots = await admin.agent.get('/api/v1/portfolio/snapshots');
        expect(snapshots.status, snapshots.text).toBe(200);
        const created = snapshots.body.items.find(
          (item: { label: string }) => item.label === SNAPSHOT_LABEL,
        );
        expect(created, 'the committed snapshot is listed for the run builder').toBeTruthy();
        expect(created.exposureCount).toBe(SAMPLE_ROWS);
        expect(created.source).toBe('IMPORT');

        // 8. Every step is in the immutable trail.
        const audit = await admin.agent.get('/api/v1/audit-events').query({ pageSize: MAX_PAGE_SIZE });
        expect(audit.status, audit.text).toBe(200);
        const actions = audit.body.items.map((event: { action: string }) => event.action);
        for (const action of [
          'TEMPLATE.DOWNLOADED',
          'IMPORT.UPLOADED',
          'IMPORT.PREVIEWED',
          'IMPORT.MAPPED',
          'IMPORT.VALIDATED',
          'IMPORT.COMMITTED',
          'IMPORT.ISSUES_EXPORTED',
        ]) {
          expect(actions, `expected ${action} in the audit trail`).toContain(action);
        }
      } finally {
        // Cascades do the work: the snapshot takes its exposures, schedules,
        // staging assessments, results and exception items with it, and the
        // batch takes its validation issues.
        if (createdSnapshotLabel) {
          await prisma.portfolioSnapshot.deleteMany({
            where: { organizationId: admin.organizationId, label: createdSnapshotLabel },
          });
        }
        await prisma.importBatch.deleteMany({
          where: { organizationId: admin.organizationId, publicId: { in: createdBatches } },
        });
        // Asserted, not assumed: the "seeded book" block counts every exposure
        // in the organization, so a leftover row here would fail there.
        expect(await prisma.exposure.count({ where: { organizationId: admin.organizationId } })).toBe(
          exposureCountBefore,
        );
        expect(
          await prisma.importBatch.count({ where: { organizationId: admin.organizationId } }),
        ).toBe(0);
      }
    });

    it('refuses an upload with no file, and rejects a non-portfolio file at validation', async () => {
      const noFile = await admin.agent.post('/api/v1/imports/portfolio');
      expect(noFile.status, noFile.text).toBe(400);
      expect(noFile.body.error.code).toBe('MISSING_FILE');

      // Upload is deliberately extension-agnostic: the bytes are sniffed and
      // parsed as delimited text, so the rejection lands at validation rather
      // than at the door. Asserting a 4xx here would claim a guard that does
      // not exist.
      const junkName = `integration-junk-${Date.now()}.txt`;
      const junk = await admin.agent
        .post('/api/v1/imports/portfolio')
        .attach('file', Buffer.from('not,a,portfolio\n1,2,3', 'utf8'), junkName);
      try {
        expect(junk.status, junk.text).toBe(201);
        const settledBatch = await settled(junk.body.record.publicId as string);
        expect(settledBatch.status, JSON.stringify(settledBatch.message)).toBe('FAILED');
        expect(settledBatch.validRowCount).toBe(0);
        // The analyst is told exactly which canonical columns were absent.
        expect((settledBatch.missingRequiredFields as string[]).length).toBeGreaterThan(0);
      } finally {
        await prisma.importBatch.deleteMany({
          where: { organizationId: admin.organizationId, fileName: junkName },
        });
      }
    });

    it('keeps ingestion away from roles that cannot upload', async () => {
      const response = await auditor.agent
        .post('/api/v1/imports/portfolio')
        .attach('file', Buffer.from('a,b\n1,2', 'utf8'), 'auditor.csv');
      expect(response.status, response.text).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ---------------------------------------------------------------------
  // Demo reset — authorization only. A real reset takes ~2 minutes and wipes
  // every row this whole suite's fixtures depend on, so it is never actually
  // triggered here; these tests only prove the ADMIN + DEMO_MODE gate refuses
  // everyone else before the (expensive, destructive) reset would start.
  // ---------------------------------------------------------------------
  describe('POST /api/v1/demo/reset', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await request(app).post('/api/v1/demo/reset');
      expect(response.status, response.text).toBe(401);
    });

    it('refuses every role except ADMIN', async () => {
      for (const session of [analyst, reviewer, auditor]) {
        const response = await session.agent.post('/api/v1/demo/reset');
        expect(response.status, `${session.role}: ${response.text}`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    });
  });
});
