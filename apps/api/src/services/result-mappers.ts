/**
 * Persisted ECL result rows -> wire DTOs.
 *
 * A run stores everything the engine produced: the exposure-level result, one
 * row per scenario, and one row per calculation period including its formula
 * trace. These mappers read that back out without recomputing anything, so a
 * historical run renders exactly the numbers it was approved with — even after
 * the model configuration that produced it has been superseded.
 *
 * Decimals are rendered through `mappers.ts` (`moneyStr` 2dp, `rateStr` 10dp),
 * the same functions the engine's serializer uses, so a figure read from the
 * database is byte-identical to the figure the engine emitted.
 */
import type { Prisma } from '@prisma/client';
import type {
  DiscountConvention,
  EadProfileKind,
  EclLineage,
  EducationalApproximationDto,
  ExposureEclResultDto,
  ExposureRunResultRecord,
  PeriodDto,
  RunResultDetailRecord,
  RunResultPeriodRecord,
  RunResultRowRecord,
  ScenarioResultDto,
  Stage,
  StagingDecision,
} from '@eclens/shared';
import { dateStr, jsonAs, moneyStr, rateStr, stageOf } from './mappers';

export interface PeriodRow {
  period: number;
  periodStart: Date;
  periodEnd: Date;
  monthsFromReportingDate: number;
  marginalPd: Prisma.Decimal;
  cumulativePd: Prisma.Decimal;
  lgd: Prisma.Decimal;
  ead: Prisma.Decimal;
  discountFactor: Prisma.Decimal;
  expectedLoss: Prisma.Decimal;
  weightedExpectedLoss: Prisma.Decimal;
  formulaTrace: string;
}

export interface ScenarioResultRow {
  id: string;
  scenarioCode: string;
  scenarioName: string;
  weight: Prisma.Decimal;
  pdMultiplier: Prisma.Decimal;
  lgdMultiplier: Prisma.Decimal;
  horizonMonths: number;
  unweightedEcl: Prisma.Decimal;
  weightedEcl: Prisma.Decimal;
  cumulativePdInHorizon: Prisma.Decimal;
  /** Present only when the query asked for the period drill-down. */
  periods?: PeriodRow[];
}

/** The exposure columns every result read needs, and nothing more. */
export interface ResultExposureRef {
  id: string;
  publicId: string;
  segment: string;
  currency: string;
  lgd: Prisma.Decimal;
  borrower: { name: string };
}

export interface ResultRow {
  id: string;
  runId: string;
  exposureId: string;
  stage: number;
  staging: Prisma.JsonValue;
  horizonBasisNote: string;
  remainingContractualMonths: number;
  horizonMonths: number;
  grossCarryingAmount: Prisma.Decimal;
  eadAtReportingDate: Prisma.Decimal;
  eadProfileKind: string;
  eadProfileLabel: string;
  eadScheduleExtendedFlat: boolean;
  pdSourceKind: string;
  effectiveInterestRate: Prisma.Decimal;
  discountConvention: string;
  lifetimePdAtReportingDate: Prisma.Decimal;
  lossAllowance: Prisma.Decimal;
  netCarryingAmount: Prisma.Decimal;
  coverageRatio: Prisma.Decimal;
  coverageOfEad: Prisma.Decimal;
  educationalApproximation: Prisma.JsonValue;
  explanation: Prisma.JsonValue;
  lineage: Prisma.JsonValue;
  exposure: ResultExposureRef;
  scenarioResults: ScenarioResultRow[];
}

const EMPTY_STAGING: StagingDecision = {
  stage: 1,
  modelStage: 1,
  primaryReason: '',
  primaryRuleCode: 'NO_SICR_OBSERVED',
  triggeredRules: [],
  ruleSetId: '',
  ruleSetVersion: '',
  hasOverride: false,
  override: null,
};

export const stagingOfResult = (row: Pick<ResultRow, 'staging'>): StagingDecision =>
  jsonAs<StagingDecision | null>(row.staging, null) ?? EMPTY_STAGING;

export const lineageOfResult = (row: Pick<ResultRow, 'lineage'>): EclLineage | null =>
  jsonAs<EclLineage | null>(row.lineage, null);

export function toPeriodDto(row: PeriodRow): PeriodDto {
  return {
    period: row.period,
    periodStart: dateStr(row.periodStart),
    periodEnd: dateStr(row.periodEnd),
    monthsFromReportingDate: row.monthsFromReportingDate,
    marginalPd: rateStr(row.marginalPd),
    cumulativePd: rateStr(row.cumulativePd),
    lgd: rateStr(row.lgd),
    ead: moneyStr(row.ead),
    discountFactor: rateStr(row.discountFactor),
    expectedLoss: moneyStr(row.expectedLoss),
    formulaTrace: row.formulaTrace,
  };
}

function toScenarioSummary(row: ScenarioResultRow): Omit<ScenarioResultDto, 'periods'> {
  return {
    scenarioCode: row.scenarioCode,
    scenarioName: row.scenarioName,
    weight: rateStr(row.weight),
    pdMultiplier: rateStr(row.pdMultiplier),
    lgdMultiplier: rateStr(row.lgdMultiplier),
    horizonMonths: row.horizonMonths,
    unweightedEcl: moneyStr(row.unweightedEcl),
    weightedEcl: moneyStr(row.weightedEcl),
    cumulativePdInHorizon: rateStr(row.cumulativePdInHorizon),
  };
}

function toScenarioDto(row: ScenarioResultRow): ScenarioResultDto {
  return { ...toScenarioSummary(row), periods: (row.periods ?? []).map(toPeriodDto) };
}

/** The per-exposure result card: everything except the period drill-down. */
export function toExposureRunResultRecord(row: ResultRow, runPublicId: string): ExposureRunResultRecord {
  return {
    id: row.id,
    runId: runPublicId,
    exposureId: row.exposure.publicId,
    exposurePublicId: row.exposure.publicId,
    borrowerName: row.exposure.borrower.name,
    segment: row.exposure.segment,
    stage: stageOf(row.stage),
    staging: stagingOfResult(row),
    horizonBasisNote: row.horizonBasisNote,
    remainingContractualMonths: row.remainingContractualMonths,
    horizonMonths: row.horizonMonths,
    grossCarryingAmount: moneyStr(row.grossCarryingAmount),
    eadAtReportingDate: moneyStr(row.eadAtReportingDate),
    eadProfileKind: row.eadProfileKind,
    eadProfileLabel: row.eadProfileLabel,
    eadScheduleExtendedFlat: row.eadScheduleExtendedFlat,
    pdSourceKind: row.pdSourceKind,
    effectiveInterestRate: rateStr(row.effectiveInterestRate),
    discountConvention: row.discountConvention as DiscountConvention,
    lifetimePdAtReportingDate: rateStr(row.lifetimePdAtReportingDate),
    scenarioResults: row.scenarioResults.map(toScenarioSummary),
    lossAllowance: moneyStr(row.lossAllowance),
    netCarryingAmount: moneyStr(row.netCarryingAmount),
    coverageRatio: rateStr(row.coverageRatio),
    coverageOfEad: rateStr(row.coverageOfEad),
    educationalApproximation: jsonAs<EducationalApproximationDto>(row.educationalApproximation, {
      label: 'Single-period PD x LGD x EAD (educational approximation only)',
      lumpPd: '0.0000000000',
      lgd: '0.0000000000',
      eadAtReportingDate: moneyStr(row.eadAtReportingDate),
      discountFactor: '1.0000000000',
      value: '0.00',
      formulaTrace: '',
    }),
    explanation: jsonAs<string[]>(row.explanation, []),
    lineage: lineageOfResult(row) ?? ({} as EclLineage),
  };
}

/** One row of the paginated results table for a run. */
export function toRunResultRowRecord(
  row: ResultRow,
  previousLossAllowance: Prisma.Decimal | null,
): RunResultRowRecord {
  const staging = stagingOfResult(row);
  return {
    id: row.id,
    exposureId: row.exposure.publicId,
    exposurePublicId: row.exposure.publicId,
    borrowerName: row.exposure.borrower.name,
    segment: row.exposure.segment,
    stage: stageOf(row.stage) as Stage,
    stagePrimaryReason: staging.primaryReason,
    horizonMonths: row.horizonMonths,
    grossCarryingAmount: moneyStr(row.grossCarryingAmount),
    ead: moneyStr(row.eadAtReportingDate),
    pd: rateStr(row.lifetimePdAtReportingDate),
    lgd: rateStr(row.exposure.lgd),
    lossAllowance: moneyStr(row.lossAllowance),
    netCarryingAmount: moneyStr(row.netCarryingAmount),
    coverageRatio: rateStr(row.coverageRatio),
    scenarioContributions: row.scenarioResults.map((scenario) => ({
      scenarioCode: scenario.scenarioCode,
      scenarioName: scenario.scenarioName,
      weight: rateStr(scenario.weight),
      weightedEcl: moneyStr(scenario.weightedEcl),
    })),
    changeVsPreviousRun: previousLossAllowance ? moneyStr(row.lossAllowance.minus(previousLossAllowance)) : null,
  };
}

/** The full drill-down payload: persisted rows re-rendered as the engine's DTO. */
export function toRunResultDetailRecord(row: ResultRow, runPublicId: string): RunResultDetailRecord {
  const result = toExposureRunResultRecord(row, runPublicId);
  const scenarioPeriods = row.scenarioResults.map((scenario) => ({
    scenario: toScenarioSummary(scenario),
    periods: (scenario.periods ?? []).map(toPeriodDto),
  }));
  const fullResult: ExposureEclResultDto = {
    exposureKey: row.exposure.publicId,
    currency: row.exposure.currency,
    stage: stageOf(row.stage),
    staging: stagingOfResult(row),
    horizonBasisNote: row.horizonBasisNote,
    remainingContractualMonths: row.remainingContractualMonths,
    horizonMonths: row.horizonMonths,
    grossCarryingAmount: moneyStr(row.grossCarryingAmount),
    eadAtReportingDate: moneyStr(row.eadAtReportingDate),
    eadProfileKind: row.eadProfileKind as EadProfileKind,
    eadProfileLabel: row.eadProfileLabel,
    eadScheduleExtendedFlat: row.eadScheduleExtendedFlat,
    pdSourceKind: row.pdSourceKind as ExposureEclResultDto['pdSourceKind'],
    effectiveInterestRate: rateStr(row.effectiveInterestRate),
    discountConvention: row.discountConvention as DiscountConvention,
    scenarioResults: row.scenarioResults.map(toScenarioDto),
    lossAllowance: moneyStr(row.lossAllowance),
    netCarryingAmount: moneyStr(row.netCarryingAmount),
    coverageRatio: rateStr(row.coverageRatio),
    coverageOfEad: rateStr(row.coverageOfEad),
    lifetimePdAtReportingDate: rateStr(row.lifetimePdAtReportingDate),
    educationalApproximation: result.educationalApproximation,
    explanation: result.explanation,
    lineage: result.lineage,
  };
  return { result, scenarioPeriods, fullResult };
}

/** Period rows flattened with their scenario context, for the CSV/period table. */
export function toRunResultPeriodRecords(row: ResultRow): RunResultPeriodRecord[] {
  return row.scenarioResults.flatMap((scenario) =>
    (scenario.periods ?? []).map((period) => ({
      ...toPeriodDto(period),
      scenarioCode: scenario.scenarioCode,
      scenarioName: scenario.scenarioName,
      weight: rateStr(scenario.weight),
      weightedExpectedLoss: moneyStr(period.weightedExpectedLoss),
    })),
  );
}
