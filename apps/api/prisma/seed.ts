/**
 * Deterministic seed for ECLens AI.
 *
 * Two different kinds of data are created here and the distinction matters:
 *
 *   - **Inputs are generated.** `generateDemoPortfolio()` produces 780 fictional
 *     PKR exposures from a fixed PRNG seed, and `generateDemoHistory()` derives
 *     two earlier reporting periods from that same book, so every machine gets
 *     byte-identical rows. Nothing here invents a financial result.
 *   - **Outputs are computed.** Staging decisions, ECL results, calculation
 *     periods, lineage and exception items are produced by calling the same
 *     services the API calls (`reassessSnapshot`, `createRun`, `executeRun`).
 *     The seeded numbers therefore come from the real Decimal.js engine and can
 *     be reconciled against the documented methodology — for every period.
 *
 * Three reporting periods are seeded, oldest first, each with its own snapshot
 * and its own approved run:
 *
 *   - a single snapshot can answer "what is the allowance", but the movement
 *     bridge, the stage migration matrix and the coverage trend all need at
 *     least two periods to say anything at all;
 *   - the derived periods are the *same loans* at an earlier, better point in
 *     the credit cycle, so a stage transition means an exposure actually moved
 *     rather than two unrelated books being subtracted;
 *   - exposures originated after a period date are absent from it and exposures
 *     repaid since are present, which is where the bridge's "new originations"
 *     and "derecognition" components come from instead of from a hand-written
 *     list of adjustments.
 *
 * Every seeded run is submitted by a RISK_ANALYST and approved by a REVIEWER, so
 * the demo opens on locked, four-eyes-approved results rather than drafts. The
 * newest period is the primary demo book: unscoped reads resolve to it.
 *
 * Run with: npm run db:seed
 */
import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
  DEMO_ORGANIZATION,
  DEMO_PASSWORD,
  DEMO_USERS,
  REPORTING_DATE,
  dec,
  generateDemoHistory,
  generateDemoPortfolio,
  type ContractualSchedules,
  type GeneratedExposureRow,
  type PortfolioTotalsDto,
  type RoleName,
} from '@eclens/shared';
import type { AuditActor } from '../src/lib/audit';
import { seedGovernanceKnowledge } from '../src/services/ai/retrieval';

const prisma = new PrismaClient();

/** Audit services need an actor; a seeded user standing in for the API caller. */
const currentActorOf = (
  user: { id: string; fullName: string; role: RoleName },
  organizationId: string,
): AuditActor => ({ id: user.id, organizationId, fullName: user.fullName, role: user.role });

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  ADMIN: 'Full access: users, settings, model configuration, all data.',
  RISK_ANALYST: 'Runs ECL calculations, manages imports and scenarios.',
  REVIEWER: 'Reviews and approves runs, scenarios and model changes.',
  AUDITOR: 'Read-only access to runs, results and the audit trail.',
};

/**
 * Lineage key of the primary book. It appears in every seeded result's
 * `inputVersion`, and the derived periods use the same shape with their own date.
 */
const SNAPSHOT_PUBLIC_ID = 'SNAP-SEED-001';
const SNAPSHOT_INPUT_VERSION = `SEED/${REPORTING_DATE}/v1`;

/** Booleans arrive from the generator as template strings. */
const asBool = (value: string): boolean => value.trim().toLowerCase() === 'true';
const asInt = (value: string): number => Number.parseInt(value, 10);
const asDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** One reporting period: a snapshot's worth of inputs plus its EAD schedules. */
interface SeedPeriod {
  publicId: string;
  label: string;
  asOfDate: string;
  inputVersion: string;
  rows: GeneratedExposureRow[];
  schedules: ContractualSchedules;
}

interface SeededPeriod {
  period: SeedPeriod;
  snapshotId: string;
  runPublicId: string;
  runInternalId: string;
  eadPeriods: number;
  totals: PortfolioTotalsDto;
}

/** The service layer, imported lazily so `dotenv/config` runs first. */
interface SeedServices {
  reassessSnapshot: typeof import('../src/services/staging.service')['reassessSnapshot'];
  createRun: typeof import('../src/services/runs.service')['createRun'];
  executeRun: typeof import('../src/services/runs.service')['executeRun'];
  submitRun: typeof import('../src/services/runs.service')['submitRun'];
  approveRun: typeof import('../src/services/runs.service')['approveRun'];
}

/**
 * Bulk inserts, chunked. Postgres binds one parameter per column per row, so an
 * unchunked `createMany` over 2,200 exposures and their schedules runs past the
 * 65,535 parameter limit rather than merely being slow.
 */
async function createInChunks<T>(
  insert: (chunk: T[]) => Promise<unknown>,
  rows: T[],
  chunkSize = 500,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await insert(rows.slice(offset, offset + chunkSize));
  }
}

function exposureCreateData(
  row: GeneratedExposureRow,
  organizationId: string,
  snapshotId: string,
  borrowerId: string,
): Prisma.ExposureCreateManyInput {
  const v = row.values;
  return {
    organizationId,
    snapshotId,
    borrowerId,
    publicId: v.exposureId,
    segment: v.segment,
    productType: v.productType,
    originationDate: asDate(v.originationDate),
    maturityDate: asDate(v.maturityDate),
    reportingDate: asDate(v.reportingDate),
    currency: v.currency,
    grossCarryingAmount: v.grossCarryingAmount,
    undrawnCommitment: v.undrawnCommitment,
    creditConversionFactor: v.creditConversionFactor,
    effectiveInterestRate: v.effectiveInterestRate,
    daysPastDue: asInt(v.daysPastDue),
    originalCreditRating: v.originalCreditRating,
    currentCreditRating: v.currentCreditRating,
    twelveMonthPd: v.twelveMonthPd,
    lifetimePd: v.lifetimePd,
    pdAtOrigination: v.pdAtOrigination,
    lgd: v.lgd,
    collateralValue: v.collateralValue,
    defaultFlag: asBool(v.defaultFlag),
    creditImpairedFlag: asBool(v.creditImpairedFlag),
    forbearanceFlag: asBool(v.forbearanceFlag),
    restructuringFlag: asBool(v.restructuringFlag),
    watchlistFlag: asBool(v.watchlistFlag),
    region: v.region,
    industry: v.industry,
  };
}

async function main(): Promise<void> {
  console.log('Seeding ECLens AI (deterministic inputs, engine-computed results)...');

  const demo = generateDemoPortfolio();
  // `generateDemoHistory` returns nearest-first; the seed runs oldest-first so
  // the newest period — the one unscoped reads resolve to — is created last.
  const history = generateDemoHistory(demo).reverse();

  const periods: SeedPeriod[] = [
    ...history.map(({ period, schedules }) => ({
      publicId: period.publicId,
      label: period.label,
      asOfDate: period.reportingDate,
      inputVersion: period.inputVersion,
      rows: period.rows,
      schedules,
    })),
    {
      publicId: SNAPSHOT_PUBLIC_ID,
      label: `Seeded portfolio as at ${REPORTING_DATE}`,
      asOfDate: REPORTING_DATE,
      inputVersion: SNAPSHOT_INPUT_VERSION,
      rows: demo.rows,
      schedules: demo.schedules,
    },
  ];

  // Wipe in dependency order so re-seeding is idempotent.
  await prisma.eclCalculationPeriod.deleteMany();
  await prisma.eclScenarioResult.deleteMany();
  await prisma.eclResult.deleteMany();
  await prisma.stagingAssessment.deleteMany();
  await prisma.stageOverride.deleteMany();
  await prisma.exceptionItem.deleteMany();
  await prisma.eclRun.deleteMany();
  await prisma.aiInsight.deleteMany();
  await prisma.document.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.importValidationIssue.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.exposurePdTermStructure.deleteMany();
  await prisma.exposureEadPeriod.deleteMany();
  await prisma.exposure.deleteMany();
  await prisma.borrower.deleteMany();
  await prisma.portfolioSnapshot.deleteMany();
  await prisma.scenarioFactor.deleteMany();
  await prisma.scenarioSet.deleteMany();
  await prisma.modelConfiguration.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
  await prisma.organization.deleteMany();

  const organization = await prisma.organization.create({
    data: { name: DEMO_ORGANIZATION, currency: 'PKR' },
  });

  const roleIds = new Map<RoleName, string>();
  for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS) as [RoleName, string][]) {
    const role = await prisma.role.create({ data: { name, description } });
    roleIds.set(name, role.id);
  }

  const users = new Map<string, { id: string; fullName: string; role: RoleName }>();
  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  for (const demoUser of DEMO_USERS) {
    const created = await prisma.user.create({
      data: {
        organizationId: organization.id,
        roleId: roleIds.get(demoUser.role) as string,
        publicId: `USR-${demoUser.role}`,
        email: demoUser.email,
        fullName: demoUser.fullName,
        passwordHash,
      },
    });
    users.set(demoUser.role, { id: created.id, fullName: created.fullName, role: demoUser.role });
  }

  const analyst = users.get('RISK_ANALYST') ?? users.get('ADMIN');
  const reviewer = users.get('REVIEWER');
  if (!analyst) throw new Error('Seed requires a RISK_ANALYST or ADMIN demo user');
  if (!reviewer) throw new Error('Seed requires a REVIEWER demo user so every run is four-eyes approved');
  const analystActor = currentActorOf(analyst, organization.id);
  const reviewerActor = currentActorOf(reviewer, organization.id);

  // --- Versioned governance -------------------------------------------------
  // One configuration and one scenario set are shared by all three periods. That
  // is the point: with the assumptions held constant, the movement between
  // periods is attributable to the portfolio and not to a change of model.
  const scenarioSet = await prisma.scenarioSet.create({
    data: {
      organizationId: organization.id,
      name: demo.scenarioSet.name,
      version: demo.scenarioSet.version,
      isActive: true,
      description: 'Seeded base/upside/downside set. Active weights total exactly 1.',
      createdById: analyst.id,
      createdBy: analyst.fullName,
      // Pre-approved so the seeded book — three real runs already locked to
      // this version — is internally consistent from the first login.
      approvalStatus: 'APPROVED',
      approvedById: reviewer.id,
      approvedBy: reviewer.fullName,
      approvedAt: new Date(),
      scenarios: {
        create: demo.scenarioSet.scenarios.map((scenario) => ({
          code: scenario.code,
          name: scenario.name,
          kind: scenario.code,
          weight: String(scenario.weight),
          pdMultiplier: String(scenario.pdMultiplier),
          lgdMultiplier: String(scenario.lgdMultiplier),
          isActive: scenario.isActive,
          description: scenario.description ?? '',
          indicators: (scenario.indicators ?? undefined) as object | undefined,
        })),
      },
    },
  });

  const ruleSet = demo.modelConfiguration.stagingRuleSet;
  const modelConfiguration = await prisma.modelConfiguration.create({
    data: {
      organizationId: organization.id,
      name: demo.modelConfiguration.name,
      version: demo.modelConfiguration.version,
      isActive: true,
      description: demo.modelConfiguration.description,
      stagingRuleSetId: ruleSet.id,
      stagingRuleSetVersion: ruleSet.version,
      stagingRuleSet: ruleSet as unknown as object,
      lgdFloor: demo.modelConfiguration.lgdFloor,
      lgdCeiling: demo.modelConfiguration.lgdCeiling,
      pdFloor: demo.modelConfiguration.pdFloor,
      pdCeiling: demo.modelConfiguration.pdCeiling,
      lifetimeHorizonMonthsCap: demo.modelConfiguration.lifetimeHorizonMonthsCap,
      maxCalculationPeriods: demo.modelConfiguration.maxCalculationPeriods,
      discountConvention: demo.modelConfiguration.discountConvention,
      effectiveInterestRateMin: demo.modelConfiguration.effectiveInterestRateMin,
      effectiveInterestRateMax: demo.modelConfiguration.effectiveInterestRateMax,
      defaultCreditConversionFactor: demo.modelConfiguration.defaultCreditConversionFactor,
      defaultSimplifiedEadProfile: demo.modelConfiguration.defaultSimplifiedEadProfile,
      twelveMonthWindow: demo.modelConfiguration.twelveMonthWindow,
      exceptionThresholds: DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS as unknown as object,
      approvedBy: demo.modelConfiguration.approvedBy ?? 'Model Risk Committee',
      approvedAt: asDate(demo.modelConfiguration.approvedAt ?? REPORTING_DATE),
      createdById: analyst.id,
      createdBy: analyst.fullName,
    },
  });

  // --- Borrowers ------------------------------------------------------------
  // A borrower is a party, not a period: the same publicId appears in every
  // snapshot, and the derived periods add parties whose loans have since been
  // repaid. Deduplicated across all periods and created once.
  const borrowerRows: Prisma.BorrowerCreateManyInput[] = [];
  const seenBorrowers = new Set<string>();
  for (const period of periods) {
    for (const row of period.rows) {
      const v = row.values;
      if (seenBorrowers.has(v.borrowerId)) continue;
      seenBorrowers.add(v.borrowerId);
      borrowerRows.push({
        organizationId: organization.id,
        publicId: v.borrowerId,
        name: v.borrowerName,
        industry: v.industry,
        region: v.region,
      });
    }
  }
  await createInChunks((chunk) => prisma.borrower.createMany({ data: chunk }), borrowerRows);
  const borrowerIdByPublicId = new Map(
    (
      await prisma.borrower.findMany({
        where: { organizationId: organization.id },
        select: { id: true, publicId: true },
      })
    ).map((borrower) => [borrower.publicId, borrower.id]),
  );

  // --- Periods --------------------------------------------------------------
  const staging = await import('../src/services/staging.service');
  const runs = await import('../src/services/runs.service');
  const services: SeedServices = {
    reassessSnapshot: staging.reassessSnapshot,
    createRun: runs.createRun,
    executeRun: runs.executeRun,
    submitRun: runs.submitRun,
    approveRun: runs.approveRun,
  };

  const seeded: SeededPeriod[] = [];

  for (const period of periods) {
    const snapshot = await prisma.portfolioSnapshot.create({
      data: {
        organizationId: organization.id,
        publicId: period.publicId,
        label: period.label,
        asOfDate: asDate(period.asOfDate),
        source: 'SEED',
        inputVersion: period.inputVersion,
        exposureCount: period.rows.length,
      },
    });

    await createInChunks(
      (chunk) => prisma.exposure.createMany({ data: chunk }),
      period.rows.map((row) =>
        exposureCreateData(
          row,
          organization.id,
          snapshot.id,
          borrowerIdByPublicId.get(row.values.borrowerId) as string,
        ),
      ),
    );

    // `createMany` returns no rows, and the EAD schedule needs the internal id.
    const idByPublicId = new Map(
      (
        await prisma.exposure.findMany({
          where: { snapshotId: snapshot.id },
          select: { id: true, publicId: true },
        })
      ).map((exposure) => [exposure.publicId, exposure.id]),
    );

    const eadPeriods: Prisma.ExposureEadPeriodCreateManyInput[] = [];
    for (const row of period.rows) {
      const schedule = period.schedules[row.values.exposureId];
      const exposureId = idByPublicId.get(row.values.exposureId);
      if (!schedule || !exposureId) continue;
      for (const point of schedule) {
        eadPeriods.push({
          exposureId,
          period: point.period,
          drawnBalance: point.drawnBalance,
          undrawnCommitment: point.undrawnCommitment,
        });
      }
    }
    await createInChunks(
      (chunk) => prisma.exposureEadPeriod.createMany({ data: chunk }),
      eadPeriods,
      1000,
    );

    const assessed = await services.reassessSnapshot(organization.id, snapshot.id, analystActor);

    const run = await services.createRun(analystActor, {
      runDate: period.asOfDate,
      snapshotId: snapshot.id,
      modelConfigurationId: modelConfiguration.id,
      scenarioSetId: scenarioSet.id,
      notes: `Seeded demonstration run over ${period.rows.length} exposures as at ${period.asOfDate}.`,
    });

    // `createRun` returns the wire record, whose `id` is the run's publicId.
    // `executeRun` is a job handler keyed on the internal cuid, so resolve it.
    const runRow = await prisma.eclRun.findFirstOrThrow({
      where: { organizationId: organization.id, publicId: run.publicId },
      select: { id: true },
    });
    await services.executeRun(runRow.id, analyst.id, analyst.fullName);

    await services.submitRun(analystActor, run.publicId, `Seeded run for ${period.asOfDate} ready for review.`);
    // Four-eyes: the reviewer is never the analyst who created the run.
    await services.approveRun(
      reviewerActor,
      run.publicId,
      `Approved at seed time. Configuration and scenario set are locked to the ${period.asOfDate} run.`,
    );

    const completed = await prisma.eclRun.findUniqueOrThrow({ where: { id: runRow.id } });
    const totals = (completed.totals ?? null) as PortfolioTotalsDto | null;
    if (!totals) throw new Error(`Run ${run.publicId} completed without totals; check the engine.`);

    const gross = dec(totals.totalGrossCarryingAmount);
    const stage3Balance = dec(totals.stageDistribution['3']?.balance ?? '0');
    await prisma.portfolioSnapshot.update({
      where: { id: snapshot.id },
      data: {
        totalGrossExposure: totals.totalGrossCarryingAmount,
        totalEcl: totals.totalLossAllowance,
        coverageRatio: totals.coverageRatio,
        stage3Share: gross.isZero() ? '0' : stage3Balance.div(gross).toFixed(12),
      },
    });

    console.log(
      `${period.asOfDate}: ${assessed.assessed} exposures staged against ${ruleSet.id} ${ruleSet.version}, ` +
        `${eadPeriods.length} contractual EAD periods, run ${run.publicId} APPROVED ` +
        `(allowance ${totals.totalLossAllowance} ${totals.currency}, coverage ${totals.coverageRatio}).`,
    );

    seeded.push({
      period,
      snapshotId: snapshot.id,
      runPublicId: run.publicId,
      runInternalId: runRow.id,
      eadPeriods: eadPeriods.length,
      totals,
    });
  }

  const primary = seeded[seeded.length - 1];
  const opening = seeded[0];

  // The governance library the copilot cites for policy and IFRS 9 orientation.
  // Seeded so a demo question can return a real citation with no upload step;
  // idempotent by content hash, so re-running the seed does not duplicate it.
  await seedGovernanceKnowledge(organization.id, reviewer.fullName);

  const counts = {
    exposures: await prisma.exposure.count({ where: { organizationId: organization.id } }),
    results: await prisma.eclResult.count({ where: { runId: primary.runInternalId } }),
    periods: await prisma.eclCalculationPeriod.count({
      where: { scenarioResult: { result: { runId: primary.runInternalId } } },
    }),
    exceptions: await prisma.exceptionItem.count({ where: { organizationId: organization.id } }),
    auditEvents: await prisma.auditEvent.count({ where: { organizationId: organization.id } }),
    documentChunks: await prisma.documentChunk.count({ where: { organizationId: organization.id } }),
  };

  console.log(
    `Seeded: 1 organization, ${DEMO_USERS.length} users, ${seeded.length} reporting periods ` +
      `(${seeded.map((entry) => entry.period.asOfDate).join(', ')}), ${counts.exposures} exposures in total, ` +
      `${seeded.reduce((total, entry) => total + entry.eadPeriods, 0)} contractual EAD periods, ` +
      `${demo.scenarioSet.scenarios.length} scenarios, 1 model configuration (${modelConfiguration.version}), ` +
      `${seeded.length} APPROVED runs, ${counts.results} results and ${counts.periods} calculation periods ` +
      `in the primary run, ${counts.exceptions} exceptions, ${counts.auditEvents} audit events, ` +
      `${counts.documentChunks} governance knowledge chunks.`,
  );
  console.log(
    `Movement ${opening.period.asOfDate} -> ${primary.period.asOfDate}: allowance ` +
      `${opening.totals.totalLossAllowance} -> ${primary.totals.totalLossAllowance} ${primary.totals.currency}, ` +
      `coverage ${opening.totals.coverageRatio} -> ${primary.totals.coverageRatio}.`,
  );
  const analystEmail = DEMO_USERS.find((user) => user.role === 'RISK_ANALYST')?.email ?? DEMO_USERS[0].email;
  console.log(`Demo login: ${analystEmail} / ${DEMO_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
