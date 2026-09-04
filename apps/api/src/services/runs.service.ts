/**
 * ECL runs: draft -> readiness -> execute -> inspect -> submit -> approve/reject.
 *
 * Three rules shape this module.
 *
 *   1. **The engine computes; this module only wires.** `executeRun` turns
 *      database rows into `EclExposureInput`s, calls `calculatePortfolioEcl`
 *      from `@eclens/shared`, and persists exactly what came back. Nothing here
 *      recalculates, adjusts or re-rounds a figure.
 *   2. **A completed run is frozen.** On completion the run stores its own copy
 *      of the model configuration, the scenario set and the staging rule set.
 *      Later versions cannot reach back into it, and reading a historical run
 *      never joins to live governance rows for anything that affects a number.
 *   3. **An approved run is locked.** `isRunLocked` gates every mutation, so
 *      re-execution, re-submission and re-review of an approved run are all
 *      rejected rather than silently overwritten.
 *
 * Execution is a background job under both drivers (`sync` and `bullmq`): the
 * HTTP call answers with status PENDING and the client polls. Period rows are
 * bulk-inserted inside one interactive transaction with an extended timeout,
 * because a full portfolio run persists tens of thousands of them.
 */
import { Prisma } from '@prisma/client';
import {
  calculatePortfolioEcl,
  dec,
  detectLargeEclChange,
  detectNearThresholdExceptions,
  isRunLocked,
  moneyToString,
  resolveScenarioSet,
  serializePortfolioTotals,
  DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
  type CreateRunRequest,
  type EclExposureResult,
  type EclLineage,
  type EclModelConfigurationInput,
  type EclRunRecord,
  type EclRunSummaryRecord,
  type ExceptionCandidate,
  type LargeEclChangeThresholds,
  type ListQuery,
  type Paginated,
  type PortfolioTotalsDto,
  type RunReadiness,
  type RunReadinessCheck,
  type RunResultDetailRecord,
  type RunResultRowRecord,
  type RunStatus,
  type ScenarioSetRecord,
  type StagingRuleSetConfig,
} from '@eclens/shared';
import { jobs } from '../jobs';
import { recordAudit, type AuditActor } from '../lib/audit';
import { newId, newPublicId } from '../lib/ids';
import { logger } from '../lib/logger';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { HttpError, notFound } from '../utils/httpError';
import {
  toEclExposureInput,
  toModelConfigurationInput,
  toScenarioSetInput,
  toStagingInput,
  type ExposureEngineRow,
  type OverrideEngineRow,
} from './engine-bridge';
import { dateStr, jsonAs, rateStr, tsStr } from './mappers';
import { RESULT_BEARING_STATUSES } from './portfolio.service';
import {
  toExposureRunResultRecord,
  toRunResultDetailRecord,
  toRunResultRowRecord,
  type ResultRow,
} from './result-mappers';

/** Period rows are inserted in chunks so no single statement is unbounded. */
const PERIOD_INSERT_CHUNK = 5_000;
/** A run can flag a lot of exposures; the queue stays useful only if it is bounded. */
const MAX_RUN_EXCEPTIONS = 250;
const EXECUTE_TRANSACTION_TIMEOUT_MS = 180_000;

const RUN_STATUSES_ALLOWED_TO_EXECUTE: RunStatus[] = ['DRAFT', 'FAILED', 'REJECTED', 'COMPLETED'];

const runInclude = {
  snapshot: true,
  modelConfiguration: true,
  scenarioSet: { include: { scenarios: true } },
} satisfies Prisma.EclRunInclude;

type RunRow = Prisma.EclRunGetPayload<{ include: typeof runInclude }>;

const resultInclude = {
  exposure: {
    select: {
      id: true,
      publicId: true,
      segment: true,
      currency: true,
      lgd: true,
      borrower: { select: { name: true } },
    },
  },
  scenarioResults: { orderBy: { scenarioCode: 'asc' as const } },
} satisfies Prisma.EclResultInclude;

const RESULT_SORT_COLUMNS = [
  'stage',
  'lossAllowance',
  'netCarryingAmount',
  'coverageRatio',
  'coverageOfEad',
  'grossCarryingAmount',
  'eadAtReportingDate',
  'horizonMonths',
  'lifetimePdAtReportingDate',
] as const;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function toRunRecord(run: RunRow, readiness: RunReadiness): EclRunRecord {
  return {
    id: run.publicId,
    publicId: run.publicId,
    organizationId: run.organizationId,
    runDate: dateStr(run.runDate),
    status: run.status,
    snapshotId: run.snapshot.publicId,
    snapshotLabel: run.snapshot.label,
    modelConfigurationId: run.modelConfiguration.id,
    modelConfigurationName: run.modelConfiguration.name,
    modelConfigurationVersion: run.modelConfiguration.version,
    scenarioSetId: run.scenarioSet.id,
    scenarioSetName: run.scenarioSet.name,
    scenarioSetVersion: run.scenarioSet.version,
    createdById: run.createdById,
    createdByName: run.createdBy,
    startedAt: tsStr(run.startedAt),
    completedAt: tsStr(run.completedAt),
    durationMs: run.durationMs,
    totals: jsonAs<PortfolioTotalsDto | null>(run.totals, null),
    scenarioWeights: jsonAs<Record<string, string>>(run.scenarioWeights, {}),
    notes: run.notes,
    error: run.error,
    readiness,
    submittedById: run.submittedById,
    submittedByName: run.submittedBy,
    submittedAt: tsStr(run.submittedAt),
    reviewDecision: run.reviewDecision,
    reviewedById: run.reviewedById,
    reviewedByName: run.reviewedBy,
    reviewedAt: tsStr(run.reviewedAt),
    reviewComment: run.reviewComment,
    lockedAt: tsStr(run.lockedAt),
    lockedConfiguration: jsonAs<EclModelConfigurationInput | null>(run.lockedConfiguration, null),
    lockedScenarioSet: jsonAs<ScenarioSetRecord | null>(run.lockedScenarioSet, null),
    lineage: jsonAs<EclLineage | null>(run.lineage, null),
  };
}

function toSummaryRecord(run: RunRow): EclRunSummaryRecord {
  const totals = jsonAs<PortfolioTotalsDto | null>(run.totals, null);
  return {
    id: run.publicId,
    publicId: run.publicId,
    runDate: dateStr(run.runDate),
    status: run.status,
    createdByName: run.createdBy,
    completedAt: tsStr(run.completedAt),
    totalLossAllowance: totals?.totalLossAllowance ?? null,
    coverageRatio: totals?.coverageRatio ?? null,
    modelConfigurationVersion: run.modelConfiguration.version,
    scenarioSetVersion: run.scenarioSet.version,
  };
}

async function findRun(organizationId: string, idOrPublicId: string): Promise<RunRow> {
  const run = await prisma.eclRun.findFirst({
    where: { organizationId, OR: [{ publicId: idOrPublicId }, { id: idOrPublicId }] },
    include: runInclude,
  });
  if (!run) throw notFound('ECL run not found');
  return run;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const check = (code: string, ok: boolean, message: string): RunReadinessCheck => ({ code, ok, message });

/**
 * Everything that would make the engine refuse, checked before a single row is
 * calculated. Each check names the configured threshold it applied, so a failed
 * readiness report is itself an explanation rather than a bare "no".
 */
export async function evaluateReadiness(run: RunRow): Promise<RunReadiness> {
  const config = toModelConfigurationInput(run.modelConfiguration);
  const checks: RunReadinessCheck[] = [];

  const exposureCount = await prisma.exposure.count({ where: { snapshotId: run.snapshotId } });
  checks.push(
    check(
      'SNAPSHOT_HAS_EXPOSURES',
      exposureCount > 0,
      exposureCount > 0
        ? `Snapshot '${run.snapshot.label}' (${run.snapshot.publicId}) holds ${exposureCount} exposure(s) at input version ${run.snapshot.inputVersion}.`
        : `Snapshot '${run.snapshot.label}' has no exposures. Commit an import or choose another snapshot.`,
    ),
  );

  let scenarioSetOk = true;
  let scenarioMessage = '';
  try {
    const resolved = resolveScenarioSet(toScenarioSetInput(run.scenarioSet));
    scenarioMessage = `${resolved.scenarios.length} active scenario(s) with weights ${resolved.scenarios
      .map((scenario) => `${scenario.code} ${rateStr(scenario.weight)}`)
      .join(', ')} summing to exactly 1 within tolerance.`;
  } catch (error) {
    scenarioSetOk = false;
    scenarioMessage = error instanceof Error ? error.message : 'Scenario set could not be resolved';
  }
  checks.push(check('SCENARIO_SET_NORMALIZED', scenarioSetOk, scenarioMessage));

  const ruleSet = jsonAs<StagingRuleSetConfig | null>(run.modelConfiguration.stagingRuleSet, null);
  checks.push(
    check(
      'STAGING_RULE_SET_VALID',
      ruleSet !== null && Array.isArray(ruleSet.enabledRules) && ruleSet.enabledRules.length > 0,
      ruleSet
        ? `Staging rule set ${ruleSet.id} v${ruleSet.version}: DPD>=${ruleSet.stage3DpdThreshold} -> Stage 3, DPD>=${ruleSet.stage2DpdThreshold} -> Stage 2, ${ruleSet.enabledRules.length} rule(s) enabled.`
        : 'The model configuration has no staging rule set.',
    ),
  );

  const badDates = await prisma.exposure.count({
    where: { snapshotId: run.snapshotId, maturityDate: { lte: run.snapshot.asOfDate } },
  });
  checks.push(
    check(
      'MATURITY_AFTER_REPORTING_DATE',
      badDates === 0,
      badDates === 0
        ? 'Every exposure matures after its reporting date, so every horizon is at least one period.'
        : `${badDates} exposure(s) mature on or before the reporting date; the engine rejects a zero-length horizon (INVALID_DATE_RANGE).`,
    ),
  );

  const badEir = await prisma.exposure.count({
    where: {
      snapshotId: run.snapshotId,
      OR: [
        { effectiveInterestRate: { lt: run.modelConfiguration.effectiveInterestRateMin } },
        { effectiveInterestRate: { gt: run.modelConfiguration.effectiveInterestRateMax } },
      ],
    },
  });
  checks.push(
    check(
      'EIR_WITHIN_CONFIGURED_BOUNDS',
      badEir === 0,
      badEir === 0
        ? `All effective interest rates fall inside the configured discounting bounds [${config.effectiveInterestRateMin}, ${config.effectiveInterestRateMax}].`
        : `${badEir} exposure(s) have an effective interest rate outside [${config.effectiveInterestRateMin}, ${config.effectiveInterestRateMax}]; discounting would be unsupported (INVALID_EFFECTIVE_INTEREST_RATE).`,
    ),
  );

  const executable = RUN_STATUSES_ALLOWED_TO_EXECUTE.includes(run.status);
  checks.push(
    check(
      'RUN_STATUS_EXECUTABLE',
      executable,
      executable
        ? `Status ${run.status} may be executed.`
        : isRunLocked(run.status)
          ? `Run is APPROVED and locked; historical results cannot be recomputed.`
          : `Status ${run.status} cannot be executed.`,
    ),
  );

  return { ready: checks.every((item) => item.ok), checks };
}

// ---------------------------------------------------------------------------
// Listing and reading
// ---------------------------------------------------------------------------

export async function listRuns(
  organizationId: string,
  query: ListQuery,
): Promise<Paginated<EclRunSummaryRecord>> {
  const where: Prisma.EclRunWhereInput = { organizationId };
  if (query.snapshotId) {
    where.snapshot = { OR: [{ id: query.snapshotId }, { publicId: query.snapshotId }] };
  }
  const term = query.search?.trim();
  if (term) {
    where.OR = [
      ...(containsSearch(term, ['publicId', 'createdBy', 'notes']) ?? []),
      { snapshot: { label: { contains: term } } },
    ];
  }

  const { skip, take } = toPageArgs(query);
  const [totalItems, rows] = await prisma.$transaction([
    prisma.eclRun.count({ where }),
    prisma.eclRun.findMany({
      where,
      include: runInclude,
      orderBy: orderBy(query.sortBy, query.sortDir, ['runDate', 'status', 'createdAt', 'completedAt'], {
        createdAt: 'desc',
      }),
      skip,
      take,
    }),
  ]);

  return { items: rows.map(toSummaryRecord), meta: buildPageMeta(query, totalItems) };
}

export async function getRun(organizationId: string, idOrPublicId: string): Promise<EclRunRecord> {
  const run = await findRun(organizationId, idOrPublicId);
  const readiness = jsonAs<RunReadiness | null>(run.readiness, null) ?? (await evaluateReadiness(run));
  return toRunRecord(run, readiness);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRun(actor: AuditActor, input: CreateRunRequest): Promise<EclRunRecord> {
  const [snapshot, modelConfiguration, scenarioSet] = await Promise.all([
    prisma.portfolioSnapshot.findFirst({
      where: { organizationId: actor.organizationId, OR: [{ id: input.snapshotId }, { publicId: input.snapshotId }] },
    }),
    prisma.modelConfiguration.findFirst({
      where: {
        organizationId: actor.organizationId,
        OR: [{ id: input.modelConfigurationId }, { version: input.modelConfigurationId }],
      },
    }),
    prisma.scenarioSet.findFirst({
      where: {
        organizationId: actor.organizationId,
        OR: [{ id: input.scenarioSetId }, { version: input.scenarioSetId }],
      },
      include: { scenarios: true },
    }),
  ]);

  if (!snapshot) throw notFound(`Portfolio snapshot '${input.snapshotId}' not found`);
  if (!modelConfiguration) throw notFound(`Model configuration '${input.modelConfigurationId}' not found`);
  if (!scenarioSet) throw notFound(`Scenario set '${input.scenarioSetId}' not found`);

  const created = await prisma.eclRun.create({
    data: {
      organizationId: actor.organizationId,
      publicId: newPublicId('RUN'),
      runDate: new Date(`${input.runDate}T00:00:00.000Z`),
      status: 'DRAFT',
      snapshotId: snapshot.id,
      modelConfigurationId: modelConfiguration.id,
      scenarioSetId: scenarioSet.id,
      notes: input.notes ?? null,
      createdById: actor.id,
      createdBy: actor.fullName,
    },
    include: runInclude,
  });

  const readiness = await evaluateReadiness(created);
  await prisma.eclRun.update({
    where: { id: created.id },
    data: { readiness: readiness as unknown as Prisma.InputJsonValue },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'ECL_RUN.CREATED',
    entityType: 'EclRun',
    entityId: created.publicId,
    detail: `Created draft run for ${dateStr(created.runDate)} on snapshot '${snapshot.label}' (${snapshot.inputVersion}) using model configuration '${modelConfiguration.name}' v${modelConfiguration.version} and scenario set '${scenarioSet.name}' v${scenarioSet.version}. Readiness: ${readiness.ready ? 'ready' : 'blocked'}.`,
  });

  return toRunRecord(created, readiness);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Validates readiness, marks the run PENDING and hands execution to the job
 * runner. Returns immediately: the client polls `GET /ecl-runs/:id`.
 */
export async function startExecution(
  actor: AuditActor,
  idOrPublicId: string,
): Promise<{ run: EclRunRecord; jobId: string; driver: string }> {
  const run = await findRun(actor.organizationId, idOrPublicId);

  if (isRunLocked(run.status)) {
    throw new HttpError(409, 'RUN_LOCKED', 'An approved run is locked and cannot be re-executed');
  }
  if (!RUN_STATUSES_ALLOWED_TO_EXECUTE.includes(run.status)) {
    throw new HttpError(409, 'RUN_NOT_EXECUTABLE', `A run in status ${run.status} cannot be executed`);
  }

  const readiness = await evaluateReadiness(run);
  if (!readiness.ready) {
    throw new HttpError(
      409,
      'RUN_NOT_READY',
      'The run is not ready to execute',
      readiness.checks
        .filter((item) => !item.ok)
        .map((item) => ({ path: item.code, message: item.message })),
    );
  }

  await prisma.eclRun.update({
    where: { id: run.id },
    data: {
      status: 'PENDING',
      error: null,
      readiness: readiness as unknown as Prisma.InputJsonValue,
    },
  });

  const receipt = await jobs.enqueue('run.execute', {
    runId: run.id,
    actorId: actor.id,
    actorName: actor.fullName,
  });

  return { run: toRunRecord({ ...run, status: 'PENDING' }, readiness), jobId: receipt.jobId, driver: receipt.driver };
}

/**
 * The `run.execute` job handler.
 *
 * Owns its terminal state: whatever happens, the run ends as COMPLETED or
 * FAILED with an accurate `error`, so the UI never shows a run stuck in RUNNING
 * after a crash.
 */
export async function executeRun(
  runId: string,
  actorId: string | null,
  actorName: string,
): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const run = await prisma.eclRun.findUnique({ where: { id: runId }, include: runInclude });
    if (!run) throw new Error(`Run ${runId} no longer exists`);

    await prisma.eclRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: new Date(), error: null },
    });

    const config = toModelConfigurationInput(run.modelConfiguration);
    const scenarioSet = toScenarioSetInput(run.scenarioSet);
    // Re-resolving here is deliberate: the run must fail loudly on a scenario
    // set whose weights no longer total 1, rather than calculate with it.
    const resolvedScenarios = resolveScenarioSet(scenarioSet).scenarios;

    const [exposures, overrides] = await Promise.all([
      prisma.exposure.findMany({
        where: { snapshotId: run.snapshotId },
        include: { eadSchedule: { orderBy: { period: 'asc' } }, pdTermStructure: true },
        orderBy: { publicId: 'asc' },
      }),
      prisma.stageOverride.findMany({
        where: { organizationId: run.organizationId, reviewerStatus: { not: 'REJECTED' } },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);

    const latestOverride = new Map<string, OverrideEngineRow>();
    for (const override of overrides) {
      if (!latestOverride.has(override.exposureId)) {
        latestOverride.set(override.exposureId, override as unknown as OverrideEngineRow);
      }
    }

    const inputs = exposures.map((row) =>
      toEclExposureInput(row as unknown as ExposureEngineRow, latestOverride.get(row.id) ?? null),
    );

    const lineage: Partial<EclLineage> = {
      inputVersion: run.snapshot.inputVersion,
      actorId: actorId ?? 'system',
      actorName,
      calculatedAt: new Date().toISOString(),
    };

    const { results, totals } = calculatePortfolioEcl(inputs, scenarioSet, config, lineage);
    const resolvedLineage = results[0]?.lineage ?? null;
    const totalsDto = serializePortfolioTotals(totals);

    const exposureIdByKey = new Map(exposures.map((row) => [row.publicId, row.id]));
    const resultIds = new Map<string, string>();
    const scenarioIds = new Map<string, string>();

    const resultData: Prisma.EclResultCreateManyInput[] = [];
    const scenarioData: Prisma.EclScenarioResultCreateManyInput[] = [];
    const periodData: Prisma.EclCalculationPeriodCreateManyInput[] = [];
    const stagingData: Prisma.StagingAssessmentCreateManyInput[] = [];

    for (const result of results) {
      const exposureId = exposureIdByKey.get(result.exposureKey);
      if (!exposureId) continue;

      const resultId = newId();
      resultIds.set(result.exposureKey, resultId);

      resultData.push({
        id: resultId,
        runId,
        exposureId,
        stage: result.stage,
        staging: result.staging as unknown as Prisma.InputJsonValue,
        horizonBasisNote: result.horizonBasisNote,
        remainingContractualMonths: result.remainingContractualMonths,
        horizonMonths: result.horizonMonths,
        // Stored at the precision the wire renders, so a value read back is
        // byte-identical to the value the engine produced.
        grossCarryingAmount: moneyToString(result.grossCarryingAmount),
        eadAtReportingDate: moneyToString(result.eadAtReportingDate),
        eadProfileKind: result.eadProfileKind,
        eadProfileLabel: result.eadProfileLabel,
        eadScheduleExtendedFlat: result.eadScheduleExtendedFlat,
        pdSourceKind: result.pdSourceKind,
        effectiveInterestRate: rateStr(result.effectiveInterestRate),
        discountConvention: result.discountConvention,
        lifetimePdAtReportingDate: rateStr(result.lifetimePdAtReportingDate),
        lossAllowance: moneyToString(result.lossAllowance),
        netCarryingAmount: moneyToString(result.netCarryingAmount),
        coverageRatio: rateStr(result.coverageRatio),
        coverageOfEad: rateStr(result.coverageOfEad),
        educationalApproximation: {
          label: result.educationalApproximation.label,
          lumpPd: rateStr(result.educationalApproximation.lumpPd),
          lgd: rateStr(result.educationalApproximation.lgd),
          eadAtReportingDate: moneyToString(result.educationalApproximation.eadAtReportingDate),
          discountFactor: rateStr(result.educationalApproximation.discountFactor),
          value: moneyToString(result.educationalApproximation.value),
          formulaTrace: result.educationalApproximation.formulaTrace,
        } as unknown as Prisma.InputJsonValue,
        explanation: result.explanation as unknown as Prisma.InputJsonValue,
        lineage: result.lineage as unknown as Prisma.InputJsonValue,
      });

      stagingData.push({
        id: newId(),
        organizationId: run.organizationId,
        runId,
        exposureId,
        stage: result.staging.stage,
        modelStage: result.staging.modelStage,
        primaryReason: result.staging.primaryReason,
        primaryRuleCode: result.staging.primaryRuleCode,
        triggeredRules: result.staging.triggeredRules as unknown as Prisma.InputJsonValue,
        ruleSetId: result.staging.ruleSetId,
        ruleSetVersion: result.staging.ruleSetVersion,
        hasOverride: result.staging.hasOverride,
        overrideId: latestOverride.get(exposureId)?.id ?? null,
        assessedAt: new Date(),
      });

      for (const scenario of result.scenarioResults) {
        const scenarioResultId = newId();
        scenarioIds.set(`${result.exposureKey}:${scenario.scenarioCode}`, scenarioResultId);
        scenarioData.push({
          id: scenarioResultId,
          resultId,
          scenarioCode: scenario.scenarioCode,
          scenarioName: scenario.scenarioName,
          weight: rateStr(scenario.weight),
          pdMultiplier: rateStr(scenario.pdMultiplier),
          lgdMultiplier: rateStr(scenario.lgdMultiplier),
          horizonMonths: scenario.horizonMonths,
          unweightedEcl: moneyToString(scenario.unweightedEcl),
          weightedEcl: moneyToString(scenario.weightedEcl),
          cumulativePdInHorizon: rateStr(scenario.cumulativePdInHorizon),
        });

        for (const period of scenario.periods) {
          periodData.push({
            id: newId(),
            scenarioResultId,
            period: period.period,
            periodStart: new Date(period.periodStart),
            periodEnd: new Date(period.periodEnd),
            monthsFromReportingDate: period.monthsFromReportingDate,
            marginalPd: rateStr(period.marginalPd),
            cumulativePd: rateStr(period.cumulativePd),
            lgd: rateStr(period.lgd),
            ead: moneyToString(period.ead),
            discountFactor: rateStr(period.discountFactor),
            expectedLoss: moneyToString(period.expectedLoss),
            weightedExpectedLoss: moneyToString(period.expectedLoss.times(scenario.weight)),
            formulaTrace: period.formulaTrace,
          });
        }
      }
    }

    const candidates = await buildRunExceptions(run, exposures, results, config);

    await prisma.$transaction(
      async (tx) => {
        // Cascade removes the previous scenario results and their periods.
        await tx.eclResult.deleteMany({ where: { runId } });
        await tx.stagingAssessment.deleteMany({ where: { runId } });
        await tx.exceptionItem.deleteMany({ where: { runId } });

        for (let index = 0; index < resultData.length; index += 500) {
          await tx.eclResult.createMany({ data: resultData.slice(index, index + 500) });
        }
        for (let index = 0; index < scenarioData.length; index += 2_000) {
          await tx.eclScenarioResult.createMany({ data: scenarioData.slice(index, index + 2_000) });
        }
        for (let index = 0; index < periodData.length; index += PERIOD_INSERT_CHUNK) {
          await tx.eclCalculationPeriod.createMany({ data: periodData.slice(index, index + PERIOD_INSERT_CHUNK) });
        }
        for (let index = 0; index < stagingData.length; index += 2_000) {
          await tx.stagingAssessment.createMany({ data: stagingData.slice(index, index + 2_000) });
        }
        if (candidates.length > 0) {
          await tx.exceptionItem.createMany({ data: candidates });
        }

        await tx.eclRun.update({
          where: { id: runId },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            durationMs: Date.now() - startedAtMs,
            error: null,
            totals: totalsDto as unknown as Prisma.InputJsonValue,
            lineage: resolvedLineage as unknown as Prisma.InputJsonValue,
            scenarioWeights: Object.fromEntries(
              resolvedScenarios.map((scenario) => [scenario.code, rateStr(scenario.weight)]),
            ) as unknown as Prisma.InputJsonValue,
            // Frozen copies. These are what a historical run reads back, so
            // superseding the live version cannot change an approved result.
            lockedConfiguration: config as unknown as Prisma.InputJsonValue,
            lockedScenarioSet: {
              id: run.scenarioSet.id,
              name: run.scenarioSet.name,
              version: run.scenarioSet.version,
              isActive: true,
              description: run.scenarioSet.description,
              scenarios: run.scenarioSet.scenarios.map((scenario) => ({
                id: scenario.id,
                code: scenario.code,
                name: scenario.name,
                kind: scenario.kind,
                weight: rateStr(scenario.weight),
                pdMultiplier: rateStr(scenario.pdMultiplier),
                lgdMultiplier: rateStr(scenario.lgdMultiplier),
                isActive: scenario.isActive,
                description: scenario.description,
                indicators: scenario.indicators,
              })),
              createdBy: run.scenarioSet.createdBy,
              createdAt: run.scenarioSet.createdAt.toISOString(),
              lockedByRunCount: 0,
            } as unknown as Prisma.InputJsonValue,
            lockedStagingRuleSet:
              run.modelConfiguration.stagingRuleSet === null
                ? Prisma.DbNull
                : (run.modelConfiguration.stagingRuleSet as Prisma.InputJsonValue),
            // The snapshot's own aggregates now reflect the latest run against
            // it, which is what makes the dashboard trend a real series.
          },
        });

        await tx.portfolioSnapshot.update({
          where: { id: run.snapshotId },
          data: {
            totalEcl: totalsDto.totalLossAllowance,
            coverageRatio: totalsDto.coverageRatio,
            stage3Share: stage3ShareOf(totalsDto),
          },
        });
      },
      { timeout: EXECUTE_TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
    );

    await recordAudit({
      organizationId: run.organizationId,
      actor: actorId ? { id: actorId, fullName: actorName, role: 'RISK_ANALYST' } : null,
      action: 'ECL_RUN.EXECUTED',
      entityType: 'EclRun',
      entityId: run.publicId,
      detail: `Executed run ${run.publicId}: ${results.length} exposure(s), ${periodData.length} calculation period(s), total loss allowance ${totalsDto.totalLossAllowance} ${totalsDto.currency}, coverage ${totalsDto.coverageRatio}. Input version ${run.snapshot.inputVersion}, model configuration ${config.name} v${config.version}, scenario set ${run.scenarioSet.name} v${run.scenarioSet.version}, rule set ${config.stagingRuleSet.id} v${config.stagingRuleSet.version}. Duration ${Date.now() - startedAtMs}ms.`,
    });

    logger.info(
      { runId, results: results.length, periods: periodData.length },
      'ecl run executed',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId, err: error }, 'ecl run execution failed');
    await prisma.eclRun
      .update({
        where: { id: runId },
        data: { status: 'FAILED', error: message.slice(0, 2000), completedAt: new Date(), durationMs: Date.now() - startedAtMs },
      })
      .catch((persistError: unknown) => {
        logger.error({ runId, err: persistError }, 'could not persist FAILED status for run');
      });
  }
}

function stage3ShareOf(totals: PortfolioTotalsDto): string {
  const stage3 = totals.stageBuckets.find((bucket) => bucket.stage === 3);
  if (!stage3 || Number(totals.totalGrossCarryingAmount) === 0) return '0.0000000000';
  return rateStr(dec(stage3.grossCarryingAmount).dividedBy(dec(totals.totalGrossCarryingAmount)));
}

/**
 * Exceptions raised by a run: material movements against the previous run on
 * the same snapshot, and exposures sitting just under a staging threshold.
 * Thresholds come from the run's own model configuration, never from a default
 * baked into this module.
 */
async function buildRunExceptions(
  run: RunRow,
  exposures: Array<{ id: string; publicId: string }>,
  results: EclExposureResult[],
  config: EclModelConfigurationInput,
): Promise<Prisma.ExceptionItemCreateManyInput[]> {
  const thresholds = jsonAs<LargeEclChangeThresholds>(
    run.modelConfiguration.exceptionThresholds,
    DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
  );
  const ruleSet = config.stagingRuleSet;
  const previous = await previousRunAllowances(run);

  const stagingInputByKey = new Map(
    exposures.map((row) => [row.publicId, toStagingInput(row as unknown as ExposureEngineRow)]),
  );

  const candidates: ExceptionCandidate[] = [];
  for (const result of results) {
    const prior = previous.get(result.exposureKey);
    const large = detectLargeEclChange(result.exposureKey, result.lossAllowance, prior ?? null, thresholds);
    if (large) candidates.push(large);

    const stagingInput = stagingInputByKey.get(result.exposureKey);
    if (stagingInput) candidates.push(...detectNearThresholdExceptions(result.exposureKey, stagingInput, ruleSet));
  }

  const exposureIdByKey = new Map(exposures.map((row) => [row.publicId, row.id]));
  return candidates.slice(0, MAX_RUN_EXCEPTIONS).map((candidate) => ({
    id: newId(),
    organizationId: run.organizationId,
    kind: candidate.kind,
    severity: candidate.severity,
    status: 'OPEN',
    exposureId: exposureIdByKey.get(candidate.exposureKey) ?? null,
    runId: run.id,
    title: candidate.title,
    detail: candidate.detail,
    metric: candidate.metric ?? null,
  }));
}

/** Allowances from the most recent earlier result-bearing run on this snapshot. */
async function previousRunAllowances(run: RunRow): Promise<Map<string, string>> {
  const reference = run.completedAt ?? run.createdAt;
  const previous = await prisma.eclRun.findFirst({
    where: {
      organizationId: run.organizationId,
      snapshotId: run.snapshotId,
      id: { not: run.id },
      status: { in: RESULT_BEARING_STATUSES },
      OR: [{ completedAt: { lt: reference } }, { completedAt: null, createdAt: { lt: reference } }],
    },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!previous) return new Map();

  const rows = await prisma.eclResult.findMany({
    where: { runId: previous.id },
    include: { exposure: { select: { publicId: true } } },
  });
  return new Map(rows.map((row) => [row.exposure.publicId, row.lossAllowance.toString()]));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export async function listRunResults(
  organizationId: string,
  idOrPublicId: string,
  query: ListQuery,
): Promise<Paginated<RunResultRowRecord> & { totals: PortfolioTotalsDto | null }> {
  const run = await findRun(organizationId, idOrPublicId);

  const where: Prisma.EclResultWhereInput = { runId: run.id };
  if (query.stage) where.stage = query.stage;
  if (query.segment) where.exposure = { segment: query.segment };
  const term = query.search?.trim();
  if (term) {
    const exposureOr = [
      { publicId: { contains: term } },
      { borrower: { name: { contains: term } } },
    ];
    where.exposure = query.segment ? { segment: query.segment, OR: exposureOr } : { OR: exposureOr };
  }

  const { skip, take } = toPageArgs(query);
  const [totalItems, rows] = await prisma.$transaction([
    prisma.eclResult.count({ where }),
    prisma.eclResult.findMany({
      where,
      include: resultInclude,
      orderBy: orderBy(query.sortBy, query.sortDir, RESULT_SORT_COLUMNS, { id: 'asc' }),
      skip,
      take,
    }),
  ]);

  const previous = await previousRunAllowancesByExposureId(run);
  const items = (rows as unknown as ResultRow[]).map((row) =>
    toRunResultRowRecord(row, previous.get(row.exposureId) ?? null),
  );

  return {
    items,
    meta: buildPageMeta(query, totalItems),
    totals: jsonAs<PortfolioTotalsDto | null>(run.totals, null),
  };
}

async function previousRunAllowancesByExposureId(run: RunRow): Promise<Map<string, Prisma.Decimal>> {
  const reference = run.completedAt ?? run.createdAt;
  const previous = await prisma.eclRun.findFirst({
    where: {
      organizationId: run.organizationId,
      snapshotId: run.snapshotId,
      id: { not: run.id },
      status: { in: RESULT_BEARING_STATUSES },
      OR: [{ completedAt: { lt: reference } }, { completedAt: null, createdAt: { lt: reference } }],
    },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!previous) return new Map();
  const rows = await prisma.eclResult.findMany({
    where: { runId: previous.id },
    select: { exposureId: true, lossAllowance: true },
  });
  return new Map(rows.map((row) => [row.exposureId, row.lossAllowance]));
}

/**
 * The full drill-down for one exposure in one run: scenario summaries, every
 * calculation period with its formula trace, and the engine's own DTO so the
 * client renders exactly what was persisted.
 */
export async function getRunResultDetail(
  organizationId: string,
  runIdOrPublicId: string,
  exposureIdOrPublicId: string,
): Promise<RunResultDetailRecord> {
  const run = await findRun(organizationId, runIdOrPublicId);

  const row = await prisma.eclResult.findFirst({
    where: {
      runId: run.id,
      exposure: { OR: [{ publicId: exposureIdOrPublicId }, { id: exposureIdOrPublicId }] },
    },
    include: {
      exposure: {
        select: {
          id: true,
          publicId: true,
          segment: true,
          currency: true,
          lgd: true,
          borrower: { select: { name: true } },
        },
      },
      scenarioResults: { orderBy: { scenarioCode: 'asc' }, include: { periods: { orderBy: { period: 'asc' } } } },
    },
  });
  if (!row) throw notFound('No result for that exposure in this run');

  return toRunResultDetailRecord(row as unknown as ResultRow, run.publicId);
}

/** One exposure's latest result across all runs, for the exposure detail page. */
export async function getLatestExposureResult(
  organizationId: string,
  exposureIdOrPublicId: string,
): Promise<ReturnType<typeof toExposureRunResultRecord> | null> {
  const row = await prisma.eclResult.findFirst({
    where: {
      run: { organizationId, status: { in: RESULT_BEARING_STATUSES } },
      exposure: { OR: [{ publicId: exposureIdOrPublicId }, { id: exposureIdOrPublicId }] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      ...resultInclude,
      run: { select: { publicId: true } },
    },
  });
  if (!row) return null;
  return toExposureRunResultRecord(row as unknown as ResultRow, row.run.publicId);
}

// ---------------------------------------------------------------------------
// Review workflow
// ---------------------------------------------------------------------------

function assertNotLocked(run: RunRow): void {
  if (isRunLocked(run.status)) {
    throw new HttpError(
      409,
      'RUN_LOCKED',
      'This run is approved and locked. Its results, configuration and scenario set can no longer change.',
    );
  }
}

export async function submitRun(
  actor: AuditActor,
  idOrPublicId: string,
  comment?: string,
): Promise<EclRunRecord> {
  const run = await findRun(actor.organizationId, idOrPublicId);
  assertNotLocked(run);

  if (run.status !== 'COMPLETED' && run.status !== 'REJECTED') {
    throw new HttpError(
      409,
      'RUN_NOT_SUBMITTABLE',
      `Only a COMPLETED run can be submitted for review; this run is ${run.status}`,
    );
  }
  if (!run.totals) {
    throw new HttpError(409, 'RUN_HAS_NO_RESULTS', 'This run has no persisted results to review');
  }

  const updated = await prisma.eclRun.update({
    where: { id: run.id },
    data: {
      status: 'SUBMITTED',
      submittedById: actor.id,
      submittedBy: actor.fullName,
      submittedAt: new Date(),
      reviewDecision: null,
      reviewedById: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: comment ?? null,
      lockedAt: null,
    },
    include: runInclude,
  });

  const totals = jsonAs<PortfolioTotalsDto | null>(updated.totals, null);
  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'ECL_RUN.SUBMITTED',
    entityType: 'EclRun',
    entityId: updated.publicId,
    detail: `Submitted run ${updated.publicId} for review. Total loss allowance ${totals?.totalLossAllowance ?? 'n/a'} ${totals?.currency ?? ''}, coverage ${totals?.coverageRatio ?? 'n/a'}, ${totals?.exposureCount ?? 0} exposure(s). Model configuration ${updated.modelConfiguration.name} v${updated.modelConfiguration.version}, scenario set ${updated.scenarioSet.name} v${updated.scenarioSet.version}.`,
  });

  return toRunRecord(updated, jsonAs<RunReadiness>(updated.readiness, { ready: true, checks: [] }));
}

/**
 * Approves and locks a run. Four-eyes: the analyst who created the run cannot
 * approve it, which is the control that makes the approval line in the audit
 * trail mean something.
 */
export async function approveRun(
  actor: AuditActor,
  idOrPublicId: string,
  comment: string,
): Promise<EclRunRecord> {
  const run = await findRun(actor.organizationId, idOrPublicId);
  assertNotLocked(run);

  if (run.status !== 'SUBMITTED') {
    throw new HttpError(409, 'RUN_NOT_SUBMITTED', `Only a SUBMITTED run can be approved; this run is ${run.status}`);
  }
  if (run.createdById === actor.id) {
    throw new HttpError(
      409,
      'RUN_SELF_APPROVAL_PROHIBITED',
      'You created this run and cannot approve it. A different reviewer must approve it.',
    );
  }

  const updated = await prisma.eclRun.update({
    where: { id: run.id },
    data: {
      status: 'APPROVED',
      reviewDecision: 'APPROVED',
      reviewedById: actor.id,
      reviewedBy: actor.fullName,
      reviewedAt: new Date(),
      reviewComment: comment,
      lockedAt: new Date(),
    },
    include: runInclude,
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'ECL_RUN.APPROVED',
    entityType: 'EclRun',
    entityId: updated.publicId,
    detail: `Approved and locked run ${updated.publicId} (created by ${run.createdBy}). Comment: ${comment}. Locked model configuration ${updated.modelConfiguration.name} v${updated.modelConfiguration.version}, scenario set ${updated.scenarioSet.name} v${updated.scenarioSet.version}, input version ${updated.snapshot.inputVersion}.`,
  });

  return toRunRecord(updated, jsonAs<RunReadiness>(updated.readiness, { ready: true, checks: [] }));
}

export async function rejectRun(
  actor: AuditActor,
  idOrPublicId: string,
  comment: string,
): Promise<EclRunRecord> {
  const run = await findRun(actor.organizationId, idOrPublicId);
  assertNotLocked(run);

  if (run.status !== 'SUBMITTED') {
    throw new HttpError(409, 'RUN_NOT_SUBMITTED', `Only a SUBMITTED run can be rejected; this run is ${run.status}`);
  }
  if (run.createdById === actor.id) {
    throw new HttpError(
      409,
      'RUN_SELF_REJECTION_PROHIBITED',
      'You created this run and cannot review it. A different reviewer must reject it.',
    );
  }

  const updated = await prisma.eclRun.update({
    where: { id: run.id },
    data: {
      status: 'REJECTED',
      reviewDecision: 'REJECTED',
      reviewedById: actor.id,
      reviewedBy: actor.fullName,
      reviewedAt: new Date(),
      reviewComment: comment,
    },
    include: runInclude,
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'ECL_RUN.REJECTED',
    entityType: 'EclRun',
    entityId: updated.publicId,
    detail: `Rejected run ${updated.publicId} (created by ${run.createdBy}). Comment: ${comment}. The run stays readable and can be corrected and re-executed.`,
  });

  return toRunRecord(updated, jsonAs<RunReadiness>(updated.readiness, { ready: true, checks: [] }));
}
