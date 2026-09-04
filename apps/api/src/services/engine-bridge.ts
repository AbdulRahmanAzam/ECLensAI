/**
 * Database rows -> pure engine inputs.
 *
 * The engine in `@eclens/shared` knows nothing about Prisma or Express. This
 * module is the only bridge, and it deliberately converts every persisted
 * `Decimal` to its exact string form before handing it over, so no binary float
 * can enter the calculation at any point.
 */
import type { Prisma } from '@prisma/client';
import type {
  EclExposureInput,
  EclModelConfigurationInput,
  ScenarioSetInput,
  SimplifiedEadProfile,
  StageOverrideRecord,
  StagingInput,
} from '@eclens/shared';
import { dateStr } from './mappers';

export interface ExposureEngineRow {
  id: string;
  publicId: string;
  currency: string;
  reportingDate: Date;
  maturityDate: Date;
  grossCarryingAmount: Prisma.Decimal;
  undrawnCommitment: Prisma.Decimal;
  creditConversionFactor: Prisma.Decimal;
  effectiveInterestRate: Prisma.Decimal;
  lgd: Prisma.Decimal;
  twelveMonthPd: Prisma.Decimal;
  lifetimePd: Prisma.Decimal;
  pdAtOrigination: Prisma.Decimal;
  daysPastDue: number;
  originalCreditRating: string;
  currentCreditRating: string;
  defaultFlag: boolean;
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  simplifiedEadProfile: string;
  eadSchedule?: Array<{ period: number; drawnBalance: Prisma.Decimal; undrawnCommitment: Prisma.Decimal }>;
  pdTermStructure?: { basis: string; points: Prisma.JsonValue } | null;
}

export interface OverrideEngineRow {
  id: string;
  stageBefore: number;
  stageAfter: number;
  reason: string;
  actorId: string;
  actorName: string;
  occurredAt: Date;
  reviewerStatus: string;
  reviewerName: string | null;
  reviewedAt: Date | null;
}

export function toStagingInput(row: ExposureEngineRow): StagingInput {
  return {
    daysPastDue: row.daysPastDue,
    defaultFlag: row.defaultFlag,
    creditImpairedFlag: row.creditImpairedFlag,
    forbearanceFlag: row.forbearanceFlag,
    restructuringFlag: row.restructuringFlag,
    watchlistFlag: row.watchlistFlag,
    originalCreditRating: row.originalCreditRating,
    currentCreditRating: row.currentCreditRating,
    pdAtOrigination: row.pdAtOrigination.toString(),
    currentPd: row.twelveMonthPd.toString(),
  };
}

/**
 * Only the most recent override is offered to the engine, and only once it has
 * been reviewed or is still awaiting review — a REJECTED override is history,
 * not an instruction, so it must not change the stage.
 */
export function toEngineOverride(row: OverrideEngineRow | null): StageOverrideRecord | null {
  if (!row || row.reviewerStatus === 'REJECTED') return null;
  return {
    stageBefore: row.stageBefore === 3 ? 3 : row.stageBefore === 2 ? 2 : 1,
    stageAfter: row.stageAfter === 3 ? 3 : row.stageAfter === 2 ? 2 : 1,
    reason: row.reason,
    actorId: row.actorId,
    actorName: row.actorName,
    occurredAt: row.occurredAt.toISOString(),
    reviewerStatus: row.reviewerStatus as StageOverrideRecord['reviewerStatus'],
    reviewerName: row.reviewerName,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

export function toEclExposureInput(
  row: ExposureEngineRow,
  override: OverrideEngineRow | null,
): EclExposureInput {
  const schedule = row.eadSchedule ?? [];
  const termStructure = row.pdTermStructure;
  const points =
    termStructure && Array.isArray(termStructure.points)
      ? (termStructure.points as Array<{ period: number; pd: string }>)
      : null;

  return {
    exposureKey: row.publicId,
    currency: row.currency,
    reportingDate: dateStr(row.reportingDate),
    maturityDate: dateStr(row.maturityDate),
    grossCarryingAmount: row.grossCarryingAmount.toString(),
    undrawnCommitment: row.undrawnCommitment.toString(),
    creditConversionFactor: row.creditConversionFactor.toString(),
    effectiveInterestRate: row.effectiveInterestRate.toString(),
    lgd: row.lgd.toString(),
    twelveMonthPd: row.twelveMonthPd.toString(),
    lifetimePd: row.lifetimePd.toString(),
    pdTermStructure:
      points && points.length > 0 && termStructure
        ? {
            basis: termStructure.basis as 'MARGINAL' | 'CONDITIONAL' | 'CUMULATIVE',
            points: points.map((point) => ({ period: point.period, pd: String(point.pd) })),
          }
        : null,
    eadSchedule:
      schedule.length > 0
        ? [...schedule]
            .sort((a, b) => a.period - b.period)
            .map((point) => ({
              period: point.period,
              drawnBalance: point.drawnBalance.toString(),
              undrawnCommitment: point.undrawnCommitment.toString(),
            }))
        : null,
    simplifiedEadProfile: row.simplifiedEadProfile as SimplifiedEadProfile,
    staging: toStagingInput(row),
    override: toEngineOverride(override),
  };
}

export interface ModelConfigurationEngineRow {
  id: string;
  name: string;
  version: string;
  description: string;
  stagingRuleSet: Prisma.JsonValue;
  lgdFloor: Prisma.Decimal;
  lgdCeiling: Prisma.Decimal;
  pdFloor: Prisma.Decimal;
  pdCeiling: Prisma.Decimal;
  lifetimeHorizonMonthsCap: number;
  maxCalculationPeriods: number;
  discountConvention: string;
  effectiveInterestRateMin: Prisma.Decimal;
  effectiveInterestRateMax: Prisma.Decimal;
  defaultCreditConversionFactor: Prisma.Decimal;
  defaultSimplifiedEadProfile: string;
  twelveMonthWindow: number;
  approvedBy: string;
  approvedAt: Date;
}

export function toModelConfigurationInput(
  row: ModelConfigurationEngineRow,
): EclModelConfigurationInput {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    stagingRuleSet: row.stagingRuleSet as unknown as EclModelConfigurationInput['stagingRuleSet'],
    lgdFloor: row.lgdFloor.toString(),
    lgdCeiling: row.lgdCeiling.toString(),
    pdFloor: row.pdFloor.toString(),
    pdCeiling: row.pdCeiling.toString(),
    lifetimeHorizonMonthsCap: row.lifetimeHorizonMonthsCap,
    maxCalculationPeriods: row.maxCalculationPeriods,
    discountConvention: row.discountConvention as EclModelConfigurationInput['discountConvention'],
    effectiveInterestRateMin: row.effectiveInterestRateMin.toString(),
    effectiveInterestRateMax: row.effectiveInterestRateMax.toString(),
    defaultCreditConversionFactor: row.defaultCreditConversionFactor.toString(),
    defaultSimplifiedEadProfile:
      row.defaultSimplifiedEadProfile as EclModelConfigurationInput['defaultSimplifiedEadProfile'],
    twelveMonthWindow: row.twelveMonthWindow,
    approvedBy: row.approvedBy,
    approvedAt: dateStr(row.approvedAt),
  };
}

export interface ScenarioSetEngineRow {
  id: string;
  name: string;
  version: string;
  scenarios: Array<{
    code: string;
    name: string;
    kind: string;
    weight: Prisma.Decimal;
    pdMultiplier: Prisma.Decimal;
    lgdMultiplier: Prisma.Decimal;
    isActive: boolean;
    description: string;
    indicators: Prisma.JsonValue | null;
  }>;
}

export function toScenarioSetInput(row: ScenarioSetEngineRow): ScenarioSetInput {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    scenarios: row.scenarios.map((scenario) => ({
      code: scenario.code,
      name: scenario.name,
      weight: scenario.weight.toString(),
      pdMultiplier: scenario.pdMultiplier.toString(),
      lgdMultiplier: scenario.lgdMultiplier.toString(),
      isActive: scenario.isActive,
      description: scenario.description,
      indicators:
        scenario.indicators && typeof scenario.indicators === 'object'
          ? (scenario.indicators as unknown as ScenarioSetInput['scenarios'][number]['indicators'])
          : undefined,
    })),
  };
}
