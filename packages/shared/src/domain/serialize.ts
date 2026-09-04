/**
 * JSON serialization for engine results.
 *
 * Decimal.js instances are not safe to hand straight to `JSON.stringify`
 * (the shape depends on the library version and loses the trailing zeros that
 * make a figure auditable). Every value that crosses the API boundary is
 * therefore emitted as a fixed-point decimal *string*:
 *
 *   - money  -> 2 decimal places  (`moneyToString`)
 *   - rates  -> 10 decimal places (`rateToString`)
 *
 * Nothing is ever converted to a binary float on the way out, so a reviewer
 * replaying a formula trace gets exactly the digits the engine used.
 */
import { moneyToString, rateToString, type Dec } from './decimal';
import type { DiscountConvention } from './discount';
import type { EadProfileKind } from './ead';
import type {
  EducationalApproximation,
  EclExposureResult,
  EclLineage,
  EclPeriodResult,
  EclScenarioResult,
  PortfolioTotalsResult,
  StageBucketTotals,
  StageDistributionTotals,
} from './ecl';
import type { StagingDecision } from './staging';
import type { Stage } from '../types';

const money = (value: Dec): string => moneyToString(value);
const rate = (value: Dec): string => rateToString(value);

export interface PeriodDto {
  period: number;
  periodStart: string;
  periodEnd: string;
  monthsFromReportingDate: number;
  marginalPd: string;
  cumulativePd: string;
  lgd: string;
  ead: string;
  discountFactor: string;
  expectedLoss: string;
  formulaTrace: string;
}

export interface ScenarioResultDto {
  scenarioCode: string;
  scenarioName: string;
  weight: string;
  pdMultiplier: string;
  lgdMultiplier: string;
  horizonMonths: number;
  periods: PeriodDto[];
  unweightedEcl: string;
  weightedEcl: string;
  cumulativePdInHorizon: string;
}

export interface EducationalApproximationDto {
  label: string;
  lumpPd: string;
  lgd: string;
  eadAtReportingDate: string;
  discountFactor: string;
  value: string;
  formulaTrace: string;
}

export interface ExposureEclResultDto {
  exposureKey: string;
  currency: string;
  stage: Stage;
  staging: StagingDecision;
  horizonBasisNote: string;
  remainingContractualMonths: number;
  horizonMonths: number;
  grossCarryingAmount: string;
  eadAtReportingDate: string;
  eadProfileKind: EadProfileKind;
  eadProfileLabel: string;
  eadScheduleExtendedFlat: boolean;
  pdSourceKind: EclExposureResult['pdSourceKind'];
  effectiveInterestRate: string;
  discountConvention: DiscountConvention;
  scenarioResults: ScenarioResultDto[];
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
  coverageOfEad: string;
  lifetimePdAtReportingDate: string;
  educationalApproximation: EducationalApproximationDto;
  explanation: string[];
  lineage: EclLineage;
}

export interface StageBucketTotalsDto {
  stage: Stage;
  exposureCount: number;
  grossCarryingAmount: string;
  ead: string;
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
}

/** Wire form of `StageDistributionTotals`: money as exact decimal strings. */
export interface StageDistributionEntryDto {
  balance: string;
  ecl: string;
  count: number;
}

export type StageDistributionDto = Record<Stage, StageDistributionEntryDto>;

export interface PortfolioTotalsDto {
  currency: string;
  exposureCount: number;
  totalGrossCarryingAmount: string;
  totalEad: string;
  totalLossAllowance: string;
  totalNetCarryingAmount: string;
  coverageRatio: string;
  stageBuckets: StageBucketTotalsDto[];
  stageDistribution: StageDistributionDto;
  roundingPolicy: string;
}

export function serializePeriod(period: EclPeriodResult): PeriodDto {
  return {
    period: period.period,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    monthsFromReportingDate: period.monthsFromReportingDate,
    marginalPd: rate(period.marginalPd),
    cumulativePd: rate(period.cumulativePd),
    lgd: rate(period.lgd),
    ead: money(period.ead),
    discountFactor: rate(period.discountFactor),
    expectedLoss: money(period.expectedLoss),
    formulaTrace: period.formulaTrace,
  };
}

export function serializeScenario(scenario: EclScenarioResult): ScenarioResultDto {
  return {
    scenarioCode: scenario.scenarioCode,
    scenarioName: scenario.scenarioName,
    weight: rate(scenario.weight),
    pdMultiplier: rate(scenario.pdMultiplier),
    lgdMultiplier: rate(scenario.lgdMultiplier),
    horizonMonths: scenario.horizonMonths,
    periods: scenario.periods.map(serializePeriod),
    unweightedEcl: money(scenario.unweightedEcl),
    weightedEcl: money(scenario.weightedEcl),
    cumulativePdInHorizon: rate(scenario.cumulativePdInHorizon),
  };
}

/**
 * Scenario results without their period rows — used by list endpoints where the
 * period drill-down would be tens of thousands of rows for no benefit.
 */
export function serializeScenarioSummary(scenario: EclScenarioResult): Omit<ScenarioResultDto, 'periods'> {
  const { periods: _periods, ...rest } = serializeScenario(scenario);
  return rest;
}

export function serializeEducationalApproximation(
  value: EducationalApproximation,
): EducationalApproximationDto {
  return {
    label: value.label,
    lumpPd: rate(value.lumpPd),
    lgd: rate(value.lgd),
    eadAtReportingDate: money(value.eadAtReportingDate),
    discountFactor: rate(value.discountFactor),
    value: money(value.value),
    formulaTrace: value.formulaTrace,
  };
}

export function serializeExposureResult(result: EclExposureResult): ExposureEclResultDto {
  return {
    exposureKey: result.exposureKey,
    currency: result.currency,
    stage: result.stage,
    staging: result.staging,
    horizonBasisNote: result.horizonBasisNote,
    remainingContractualMonths: result.remainingContractualMonths,
    horizonMonths: result.horizonMonths,
    grossCarryingAmount: money(result.grossCarryingAmount),
    eadAtReportingDate: money(result.eadAtReportingDate),
    eadProfileKind: result.eadProfileKind,
    eadProfileLabel: result.eadProfileLabel,
    eadScheduleExtendedFlat: result.eadScheduleExtendedFlat,
    pdSourceKind: result.pdSourceKind,
    effectiveInterestRate: rate(result.effectiveInterestRate),
    discountConvention: result.discountConvention,
    scenarioResults: result.scenarioResults.map(serializeScenario),
    lossAllowance: money(result.lossAllowance),
    netCarryingAmount: money(result.netCarryingAmount),
    coverageRatio: rate(result.coverageRatio),
    coverageOfEad: rate(result.coverageOfEad),
    lifetimePdAtReportingDate: rate(result.lifetimePdAtReportingDate),
    educationalApproximation: serializeEducationalApproximation(result.educationalApproximation),
    explanation: result.explanation,
    lineage: result.lineage,
  };
}

export function serializeStageBucket(bucket: StageBucketTotals): StageBucketTotalsDto {
  return {
    stage: bucket.stage,
    exposureCount: bucket.exposureCount,
    grossCarryingAmount: money(bucket.grossCarryingAmount),
    ead: money(bucket.ead),
    lossAllowance: money(bucket.lossAllowance),
    netCarryingAmount: money(bucket.netCarryingAmount),
    coverageRatio: rate(bucket.coverageRatio),
  };
}

function serializeStageDistribution(
  distribution: Record<Stage, StageDistributionTotals>,
): StageDistributionDto {
  const entry = (value: StageDistributionTotals): StageDistributionEntryDto => ({
    balance: money(value.balance),
    ecl: money(value.ecl),
    count: value.count,
  });
  return { 1: entry(distribution[1]), 2: entry(distribution[2]), 3: entry(distribution[3]) };
}

export function serializePortfolioTotals(totals: PortfolioTotalsResult): PortfolioTotalsDto {
  return {
    currency: totals.currency,
    exposureCount: totals.exposureCount,
    totalGrossCarryingAmount: money(totals.totalGrossCarryingAmount),
    totalEad: money(totals.totalEad),
    totalLossAllowance: money(totals.totalLossAllowance),
    totalNetCarryingAmount: money(totals.totalNetCarryingAmount),
    coverageRatio: rate(totals.coverageRatio),
    stageBuckets: totals.stageBuckets.map(serializeStageBucket),
    stageDistribution: serializeStageDistribution(totals.stageDistribution),
    roundingPolicy: totals.roundingPolicy,
  };
}
