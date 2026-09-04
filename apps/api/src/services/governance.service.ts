/**
 * Versioned model governance: scenario sets and model configurations.
 *
 * Two rules make the audit story hold together:
 *
 *   1. **Nothing is edited in place.** A row is created and then frozen. To
 *      change an assumption you create a new version; `supersedesVersion`
 *      records which one it replaces. A completed run stores its own copy of
 *      the configuration and scenario set (`lockedConfiguration`,
 *      `lockedScenarioSet`), so superseding a version can never rewrite history.
 *   2. **The engine validates before we persist.** `resolveScenarioSet` rejects
 *      negative weights and weights that do not total exactly 1 within the
 *      decimal tolerance, and it is the same code the calculation uses — so a
 *      set that can be saved can also be run.
 */
import { Prisma } from '@prisma/client';
import {
  DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
  resolveScenarioSet,
  type CreateModelConfigurationRequest,
  type CreateScenarioSetRequest,
  type LargeEclChangeThresholds,
  type ListQuery,
  type MacroIndicators,
  type ModelConfigurationRecord,
  type Paginated,
  type ScenarioRecord,
  type ScenarioSetRecord,
  type StagingRuleSetConfig,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { newId } from '../lib/ids';
import { prisma } from '../lib/prisma';
import { buildPageMeta, orderBy, toPageArgs } from '../lib/pagination';
import { HttpError, notFound } from '../utils/httpError';
import { toHttpError } from '../utils/engineErrors';
import { jsonAs, rateStr, tsStr } from './mappers';
import {
  toModelConfigurationInput,
  toScenarioSetInput,
  type ModelConfigurationEngineRow,
  type ScenarioSetEngineRow,
} from './engine-bridge';

type ScenarioSetRow = Prisma.ScenarioSetGetPayload<{ include: { scenarios: true } }>;
type ModelConfigurationRow = Prisma.ModelConfigurationGetPayload<Record<string, never>>;

const SCENARIO_SET_INCLUDE = { scenarios: { orderBy: { code: 'asc' } } } as const;

// ---------------------------------------------------------------------------
// Scenario sets
// ---------------------------------------------------------------------------

function toScenarioRecord(row: ScenarioSetRow['scenarios'][number]): ScenarioRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    weight: rateStr(row.weight),
    pdMultiplier: rateStr(row.pdMultiplier),
    lgdMultiplier: rateStr(row.lgdMultiplier),
    isActive: row.isActive,
    description: row.description,
    indicators: jsonAs<MacroIndicators | null>(row.indicators, null),
  };
}

function toScenarioSetRecord(row: ScenarioSetRow, lockedByRunCount: number): ScenarioSetRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    isActive: row.isActive,
    description: row.description,
    scenarios: row.scenarios.map(toScenarioRecord),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lockedByRunCount,
    approvalStatus: row.approvalStatus,
    approvedBy: row.approvedBy,
    approvedAt: tsStr(row.approvedAt),
  };
}

async function runCountForScenarioSet(id: string): Promise<number> {
  return prisma.eclRun.count({ where: { scenarioSetId: id } });
}

export async function listScenarioSets(
  organizationId: string,
  query: ListQuery,
): Promise<Paginated<ScenarioSetRecord>> {
  const where: Prisma.ScenarioSetWhereInput = {
    organizationId,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { version: { contains: query.search } },
            { description: { contains: query.search } },
          ],
        }
      : {}),
  };
  const { skip, take } = toPageArgs(query);
  const [totalItems, rows] = await Promise.all([
    prisma.scenarioSet.count({ where }),
    prisma.scenarioSet.findMany({
      where,
      include: SCENARIO_SET_INCLUDE,
      skip,
      take,
      orderBy: orderBy(query.sortBy, query.sortDir, ['name', 'version', 'createdAt', 'isActive'], {
        createdAt: 'desc',
      }),
    }),
  ]);
  const counts = await prisma.eclRun.groupBy({
    by: ['scenarioSetId'],
    where: { scenarioSetId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((entry) => [entry.scenarioSetId, entry._count._all]));

  return {
    items: rows.map((row) => toScenarioSetRecord(row, countById.get(row.id) ?? 0)),
    meta: buildPageMeta(query, totalItems),
  };
}

export async function getScenarioSet(organizationId: string, id: string): Promise<ScenarioSetRecord> {
  const row = await prisma.scenarioSet.findFirst({
    where: { organizationId, OR: [{ id }, { version: id }] },
    include: SCENARIO_SET_INCLUDE,
  });
  if (!row) throw notFound(`Scenario set '${id}' not found`);
  return toScenarioSetRecord(row, await runCountForScenarioSet(row.id));
}

/**
 * The scenario set currently in force, or null when none has been created.
 *
 * Null rather than a 404: an organization with no scenario set yet is a
 * legitimate state, and a caller drafting a first proposal has to be able to
 * tell it apart from a bad id.
 */
export async function getActiveScenarioSet(organizationId: string): Promise<ScenarioSetRecord | null> {
  const row = await prisma.scenarioSet.findFirst({
    where: { organizationId, isActive: true },
    include: SCENARIO_SET_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return toScenarioSetRecord(row, await runCountForScenarioSet(row.id));
}

export async function createScenarioSet(
  actor: AuditActor,
  input: CreateScenarioSetRequest,
): Promise<ScenarioSetRecord> {
  const existing = await prisma.scenarioSet.findFirst({
    where: { organizationId: actor.organizationId, name: input.name, version: input.version },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(
      409,
      'SCENARIO_SET_VERSION_EXISTS',
      `Scenario set '${input.name}' v${input.version} already exists. Create a new version instead of editing a frozen one.`,
    );
  }

  try {
    resolveScenarioSet({
      id: 'pending',
      name: input.name,
      version: input.version,
      scenarios: input.scenarios.map((scenario) => ({
        code: scenario.code,
        name: scenario.name,
        weight: scenario.weight,
        pdMultiplier: scenario.pdMultiplier,
        lgdMultiplier: scenario.lgdMultiplier,
        isActive: scenario.isActive,
        description: scenario.description,
        indicators: scenario.indicators,
      })),
    });
  } catch (error) {
    throw toHttpError(error, 'Scenario set was rejected by the engine');
  }

  const scenarioSetId = newId();
  const created = await prisma.$transaction(async (tx) => {
    if (input.scenarios.length > 0) {
      // Activation is exclusive: at most one scenario set is the default.
      await tx.scenarioSet.updateMany({
        where: { organizationId: actor.organizationId, isActive: true },
        data: { isActive: false },
      });
    }
    return tx.scenarioSet.create({
      data: {
        id: scenarioSetId,
        organizationId: actor.organizationId,
        name: input.name,
        version: input.version,
        description: input.description ?? '',
        isActive: true,
        createdById: actor.id,
        createdBy: actor.fullName,
        scenarios: {
          create: input.scenarios.map((scenario) => ({
            id: newId(),
            code: scenario.code,
            name: scenario.name,
            kind: scenario.kind ?? scenario.code,
            weight: scenario.weight,
            pdMultiplier: scenario.pdMultiplier,
            lgdMultiplier: scenario.lgdMultiplier,
            isActive: scenario.isActive,
            description: scenario.description ?? '',
            indicators: (scenario.indicators ?? Prisma.DbNull) as Prisma.InputJsonValue,
          })),
        },
      },
      include: SCENARIO_SET_INCLUDE,
    });
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'SCENARIO_SET.CREATED',
    entityType: 'ScenarioSet',
    entityId: created.id,
    detail: `Created scenario set '${created.name}' v${created.version} with ${created.scenarios.length} scenario(s); active weights ${created.scenarios.filter((s) => s.isActive).map((s) => `${s.code}=${rateStr(s.weight)}`).join(', ')}`,
  });

  return toScenarioSetRecord(created, 0);
}

/**
 * Explicit approval, deliberately separate from creation — creating a set and
 * approving it can be, and by role usually are, two different people. Nothing
 * about the set's content changes; this only flips `approvalStatus` and
 * records who signed off and when.
 */
export async function approveScenarioSet(actor: AuditActor, id: string): Promise<ScenarioSetRecord> {
  const row = await prisma.scenarioSet.findFirst({
    where: { organizationId: actor.organizationId, OR: [{ id }, { version: id }] },
  });
  if (!row) throw notFound(`Scenario set '${id}' not found`);
  if (row.approvalStatus === 'APPROVED') {
    throw new HttpError(409, 'SCENARIO_SET_ALREADY_APPROVED', `Scenario set '${row.name}' v${row.version} is already approved.`);
  }

  const updated = await prisma.scenarioSet.update({
    where: { id: row.id },
    data: { approvalStatus: 'APPROVED', approvedById: actor.id, approvedBy: actor.fullName, approvedAt: new Date() },
    include: SCENARIO_SET_INCLUDE,
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'SCENARIO_SET.APPROVED',
    entityType: 'ScenarioSet',
    entityId: updated.id,
    detail: `Approved scenario set '${updated.name}' v${updated.version}.`,
  });

  return toScenarioSetRecord(updated, await runCountForScenarioSet(updated.id));
}

/** Loads a scenario set in the exact shape the engine consumes. */
export async function loadScenarioSetForEngine(
  organizationId: string,
  scenarioSetId: string,
): Promise<ScenarioSetEngineRow> {
  const row = await prisma.scenarioSet.findFirst({
    where: { id: scenarioSetId, organizationId },
    include: SCENARIO_SET_INCLUDE,
  });
  if (!row) throw notFound(`Scenario set '${scenarioSetId}' not found`);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    scenarios: row.scenarios.map((scenario) => ({
      code: scenario.code,
      name: scenario.name,
      kind: scenario.kind,
      weight: scenario.weight,
      pdMultiplier: scenario.pdMultiplier,
      lgdMultiplier: scenario.lgdMultiplier,
      isActive: scenario.isActive,
      description: scenario.description,
      indicators: scenario.indicators,
    })),
  };
}

/** The frozen JSON copy stored on a completed run. */
export function scenarioSetToLock(row: ScenarioSetEngineRow): ScenarioSetRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    isActive: true,
    description: '',
    scenarios: row.scenarios.map((scenario) => ({
      id: scenario.code,
      code: scenario.code,
      name: scenario.name,
      kind: scenario.kind,
      weight: scenario.weight.toString(),
      pdMultiplier: scenario.pdMultiplier.toString(),
      lgdMultiplier: scenario.lgdMultiplier.toString(),
      isActive: scenario.isActive,
      description: scenario.description,
      indicators: jsonAs<MacroIndicators | null>(scenario.indicators, null),
    })),
    createdBy: 'locked-at-run',
    createdAt: new Date(0).toISOString(),
    lockedByRunCount: 1,
    // Frozen at run-completion; the engine row does not carry approval
    // metadata, and a run only ever locks the set that was in force at
    // execution time.
    approvalStatus: 'APPROVED',
    approvedBy: null,
    approvedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Model configurations
// ---------------------------------------------------------------------------

function toModelConfigurationRecord(
  row: ModelConfigurationRow,
  lockedByRunCount: number,
): ModelConfigurationRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    stagingRuleSet: jsonAs<StagingRuleSetConfig>(row.stagingRuleSet, {
      id: row.stagingRuleSetId,
      version: row.stagingRuleSetVersion,
      stage3DpdThreshold: 90,
      stage2DpdThreshold: 30,
      ratingNotchSicrThreshold: 2,
      pdIncreaseSicrMultiple: 1.5,
      pdIncreaseSicrAbsoluteFloor: 0.005,
      nearThresholdDpdBufferDays: 5,
      nearThresholdPdBufferFraction: 0.1,
      enabledRules: [],
    }),
    lgdFloor: rateStr(row.lgdFloor),
    lgdCeiling: rateStr(row.lgdCeiling),
    pdFloor: rateStr(row.pdFloor),
    pdCeiling: rateStr(row.pdCeiling),
    lifetimeHorizonMonthsCap: row.lifetimeHorizonMonthsCap,
    maxCalculationPeriods: row.maxCalculationPeriods,
    discountConvention: row.discountConvention as ModelConfigurationRecord['discountConvention'],
    effectiveInterestRateMin: rateStr(row.effectiveInterestRateMin),
    effectiveInterestRateMax: rateStr(row.effectiveInterestRateMax),
    defaultCreditConversionFactor: rateStr(row.defaultCreditConversionFactor),
    defaultSimplifiedEadProfile:
      row.defaultSimplifiedEadProfile as ModelConfigurationRecord['defaultSimplifiedEadProfile'],
    twelveMonthWindow: row.twelveMonthWindow,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt.toISOString().slice(0, 10),
    isActive: row.isActive,
    exceptionThresholds: jsonAs<LargeEclChangeThresholds>(
      row.exceptionThresholds,
      DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
    ),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lockedByRunCount,
    supersedesVersion: row.supersedesVersion,
  };
}

export async function listModelConfigurations(
  organizationId: string,
  query: ListQuery,
): Promise<Paginated<ModelConfigurationRecord>> {
  const where: Prisma.ModelConfigurationWhereInput = {
    organizationId,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { version: { contains: query.search } },
            { approvedBy: { contains: query.search } },
          ],
        }
      : {}),
  };
  const { skip, take } = toPageArgs(query);
  const [totalItems, rows] = await Promise.all([
    prisma.modelConfiguration.count({ where }),
    prisma.modelConfiguration.findMany({
      where,
      skip,
      take,
      orderBy: orderBy(
        query.sortBy,
        query.sortDir,
        ['name', 'version', 'createdAt', 'isActive', 'approvedAt'],
        { createdAt: 'desc' },
      ),
    }),
  ]);
  const counts = await prisma.eclRun.groupBy({
    by: ['modelConfigurationId'],
    where: { modelConfigurationId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((entry) => [entry.modelConfigurationId, entry._count._all]));

  return {
    items: rows.map((row) => toModelConfigurationRecord(row, countById.get(row.id) ?? 0)),
    meta: buildPageMeta(query, totalItems),
  };
}

export async function getModelConfiguration(
  organizationId: string,
  id: string,
): Promise<ModelConfigurationRecord> {
  const row = await prisma.modelConfiguration.findFirst({
    where: { organizationId, OR: [{ id }, { version: id }] },
  });
  if (!row) throw notFound(`Model configuration '${id}' not found`);
  return toModelConfigurationRecord(row, await prisma.eclRun.count({ where: { modelConfigurationId: row.id } }));
}

export async function createModelConfiguration(
  actor: AuditActor,
  input: CreateModelConfigurationRequest,
): Promise<ModelConfigurationRecord> {
  const existing = await prisma.modelConfiguration.findFirst({
    where: { organizationId: actor.organizationId, name: input.name, version: input.version },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(
      409,
      'MODEL_CONFIGURATION_VERSION_EXISTS',
      `Model configuration '${input.name}' v${input.version} already exists. Create a new version instead of editing a frozen one.`,
    );
  }
  if (Number(input.lgdFloor) > Number(input.lgdCeiling)) {
    throw new HttpError(422, 'LGD_BOUNDS_INVERTED', 'lgdFloor cannot exceed lgdCeiling');
  }
  if (Number(input.pdFloor) > Number(input.pdCeiling)) {
    throw new HttpError(422, 'PD_BOUNDS_INVERTED', 'pdFloor cannot exceed pdCeiling');
  }
  if (Number(input.effectiveInterestRateMin) > Number(input.effectiveInterestRateMax)) {
    throw new HttpError(422, 'EIR_BOUNDS_INVERTED', 'effectiveInterestRateMin cannot exceed effectiveInterestRateMax');
  }

  const previousActive = await prisma.modelConfiguration.findFirst({
    where: { organizationId: actor.organizationId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: { version: true },
  });

  const configurationId = newId();
  const created = await prisma.$transaction(async (tx) => {
    if (input.activate) {
      await tx.modelConfiguration.updateMany({
        where: { organizationId: actor.organizationId, isActive: true },
        data: { isActive: false },
      });
    }
    return tx.modelConfiguration.create({
      data: {
        id: configurationId,
        organizationId: actor.organizationId,
        name: input.name,
        version: input.version,
        description: input.description ?? '',
        isActive: input.activate,
        stagingRuleSetId: input.stagingRuleSet.id,
        stagingRuleSetVersion: input.stagingRuleSet.version,
        stagingRuleSet: input.stagingRuleSet as unknown as Prisma.InputJsonValue,
        lgdFloor: input.lgdFloor,
        lgdCeiling: input.lgdCeiling,
        pdFloor: input.pdFloor,
        pdCeiling: input.pdCeiling,
        lifetimeHorizonMonthsCap: input.lifetimeHorizonMonthsCap,
        maxCalculationPeriods: input.maxCalculationPeriods,
        discountConvention: input.discountConvention,
        effectiveInterestRateMin: input.effectiveInterestRateMin,
        effectiveInterestRateMax: input.effectiveInterestRateMax,
        defaultCreditConversionFactor: input.defaultCreditConversionFactor,
        defaultSimplifiedEadProfile: input.defaultSimplifiedEadProfile,
        twelveMonthWindow: input.twelveMonthWindow,
        exceptionThresholds: (input.exceptionThresholds ??
          DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS) as unknown as Prisma.InputJsonValue,
        approvedBy: input.approvedBy,
        approvedAt: new Date(`${input.approvedAt}T00:00:00.000Z`),
        supersedesVersion: input.activate ? (previousActive?.version ?? null) : null,
        createdById: actor.id,
        createdBy: actor.fullName,
      },
    });
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: input.activate ? 'MODEL_CONFIG.ACTIVATED' : 'MODEL_CONFIG.CREATED',
    entityType: 'ModelConfiguration',
    entityId: created.id,
    detail: `Created model configuration '${created.name}' v${created.version} (rule set ${created.stagingRuleSetId} v${created.stagingRuleSetVersion}, LGD [${rateStr(created.lgdFloor)}, ${rateStr(created.lgdCeiling)}], horizon cap ${created.lifetimeHorizonMonthsCap}m, ${created.discountConvention} discounting)${input.activate ? `; activated, superseding v${previousActive?.version ?? 'none'}` : ''}`,
  });

  return toModelConfigurationRecord(created, 0);
}

/** Loads the active model configuration, or a specific one, for the engine. */
export async function loadModelConfigurationForEngine(
  organizationId: string,
  modelConfigurationId: string,
): Promise<ModelConfigurationEngineRow> {
  const row = await prisma.modelConfiguration.findFirst({
    where: { id: modelConfigurationId, organizationId },
  });
  if (!row) throw notFound(`Model configuration '${modelConfigurationId}' not found`);
  return row;
}

/** The active configuration, used by import validation and live staging. */
export async function loadActiveModelConfiguration(
  organizationId: string,
): Promise<ModelConfigurationEngineRow | null> {
  return prisma.modelConfiguration.findFirst({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

export function modelConfigurationToEngineInput(
  row: ModelConfigurationEngineRow,
): ReturnType<typeof toModelConfigurationInput> {
  return toModelConfigurationInput(row);
}

export function scenarioSetToEngineInput(row: ScenarioSetEngineRow): ReturnType<typeof toScenarioSetInput> {
  return toScenarioSetInput(row);
}

/** Frozen copy stored on a completed run so later edits cannot rewrite it. */
export function modelConfigurationToLock(
  row: ModelConfigurationEngineRow,
): ModelConfigurationRecord {
  return toModelConfigurationRecord(row as ModelConfigurationRow, 1);
}

export const approvedAtIso = (value: Date): string | null => tsStr(value);
