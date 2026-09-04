/**
 * The authoritative ECL calculation engine.
 *
 * Methodology
 * -----------
 * For each exposure and each active macro scenario:
 *
 *   ECL(scenario) = SUM over periods t of
 *                   marginalPD(t, scenario) x LGD(t, scenario) x EAD(t) x DF(t)
 *
 *   Loss allowance = SUM over scenarios of  ECL(scenario) x weight(scenario)
 *
 * Period marginals come from survival logic (see ./pd.ts), EAD from the
 * contractual amortization schedule or a labelled simplified profile
 * (see ./ead.ts), and DF from the original effective interest rate at the
 * configured timing convention (see ./discount.ts).
 *
 * Stage horizons
 * --------------
 * Stage 1 — sum over the first `twelveMonthWindow` (12) periods. This is the
 *           *lifetime* cash shortfall associated with default events that are
 *           possible in the next 12 months, NOT merely cash shortfalls that
 *           occur during those 12 months: at each period t inside the window,
 *           LGD(t) x EAD(t) measures the whole contractual shortfall that a
 *           default in t would cause, discounted back to the reporting date.
 * Stage 2 — sum over the remaining contractual lifetime after a significant
 *           increase in credit risk, capped by `lifetimeHorizonMonthsCap`.
 * Stage 3 — sum over the remaining contractual lifetime for credit-impaired
 *           exposures; the net carrying amount (gross - loss allowance) is
 *           reported alongside for disclosure analysis.
 *
 * The single-period shortcut `PD x LGD x EAD x DF` is explicitly NOT used for
 * the reported allowance. It is computed once and returned as
 * `educationalApproximation`, labelled as such, for teaching only.
 *
 * This module is pure: no Express, no database, no I/O, no wall-clock reads.
 * `calculatedAt` and actor identity are injected so a run is reproducible.
 */
import {
  clampDec,
  dec,
  moneyToString,
  one,
  rateToString,
  roundMoney,
  zero,
  type Dec,
  type DecValue,
} from './decimal';
import {
  assertIsoDate,
  monthsBetween,
  periodEndDate,
  periodStartDate,
  type IsoDate,
  type IsoTimestamp,
} from './dates';
import { engineError } from './errors';
import {
  discountFactorForPeriod,
  validateEffectiveInterestRate,
  type DiscountConvention,
} from './discount';
import { buildEadSchedule, type EadSchedule, type EadSchedulePointInput, type SimplifiedEadProfile } from './ead';
import {
  cumulativePdOver,
  deriveTermStructureFromAnchors,
  scaleMarginalPd,
  toMarginalPd,
  type MarginalPdPoint,
  type PdTermStructureInput,
} from './pd';
import { resolveScenarioSet, type ResolvedScenario, type ScenarioSetInput } from './scenarios';
import {
  assessStage,
  type StageOverrideRecord,
  type StagingDecision,
  type StagingInput,
} from './staging';
import { ROUNDING_POLICY, type EclModelConfigurationInput } from './config';
import type { Stage } from '../types';

/** Provenance attached to every result. Nothing is reported without it. */
export interface EclLineage {
  /** Identifies the exposure input set, e.g. the portfolio snapshot id. */
  inputVersion: string;
  modelConfigurationId: string;
  /**
   * Human label for `modelConfigurationId`. The id remains the authoritative
   * reference; this is here so a screen can name the assumption an auditor
   * recognises instead of showing a surrogate key. Optional because lineage is
   * frozen JSON on completed runs — rows written before this field existed
   * carry only the id, and consumers must fall back to it.
   */
  modelConfigurationName?: string;
  modelConfigurationVersion: string;
  stagingRuleSetId: string;
  stagingRuleSetVersion: string;
  scenarioSetId: string;
  /** Human label for `scenarioSetId`. Optional for the same reason as above. */
  scenarioSetName?: string;
  scenarioSetVersion: string;
  reportingDate: IsoDate;
  /** Injected so results stay deterministic and reproducible. */
  calculatedAt: IsoTimestamp;
  actorId: string;
  actorName: string;
  roundingPolicy: string;
}

export interface EclExposureInput {
  /** Stable business key, e.g. the loan account number. */
  exposureKey: string;
  currency: string;
  reportingDate: IsoDate;
  maturityDate: IsoDate;
  grossCarryingAmount: DecValue;
  undrawnCommitment: DecValue;
  creditConversionFactor: DecValue;
  /** Original effective interest rate, decimal (0.185 = 18.5%). */
  effectiveInterestRate: DecValue;
  /** Point-in-time LGD, decimal, before scenario scaling and clamping. */
  lgd: DecValue;
  twelveMonthPd: DecValue;
  lifetimePd: DecValue;
  /** Optional supplier term structure. Wins over the two anchor PDs. */
  pdTermStructure?: PdTermStructureInput | null;
  /** Optional contractual amortization / EAD schedule. */
  eadSchedule?: EadSchedulePointInput[] | null;
  /** Simplified profile used when no contractual schedule is supplied. */
  simplifiedEadProfile?: SimplifiedEadProfile;
  staging: StagingInput;
  override?: StageOverrideRecord | null;
}

export interface EclPeriodResult {
  period: number;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  monthsFromReportingDate: number;
  /** Scenario-adjusted marginal PD: probability of first default in this period. */
  marginalPd: Dec;
  /** Scenario-adjusted cumulative PD up to and including this period. */
  cumulativePd: Dec;
  /** Scenario-adjusted LGD after floor/ceiling clamping. */
  lgd: Dec;
  ead: Dec;
  discountFactor: Dec;
  /** marginalPd x lgd x ead x discountFactor, rounded to money. */
  expectedLoss: Dec;
  /** The exact arithmetic for this row, as a string an auditor can replay. */
  formulaTrace: string;
}

export interface EclScenarioResult {
  scenarioCode: string;
  scenarioName: string;
  weight: Dec;
  pdMultiplier: Dec;
  lgdMultiplier: Dec;
  horizonMonths: number;
  periods: EclPeriodResult[];
  /** Sum of the rounded period expected losses. */
  unweightedEcl: Dec;
  /** unweightedEcl x weight, rounded to money. */
  weightedEcl: Dec;
  /** Scenario-adjusted cumulative PD across the horizon. */
  cumulativePdInHorizon: Dec;
}

/** The labelled shortcut. Educational only — never the reported allowance. */
export interface EducationalApproximation {
  label: string;
  lumpPd: Dec;
  lgd: Dec;
  eadAtReportingDate: Dec;
  discountFactor: Dec;
  value: Dec;
  formulaTrace: string;
}

export interface EclExposureResult {
  exposureKey: string;
  currency: string;
  stage: Stage;
  staging: StagingDecision;
  /** Explains which horizon was used and why. */
  horizonBasisNote: string;
  remainingContractualMonths: number;
  horizonMonths: number;
  grossCarryingAmount: Dec;
  eadAtReportingDate: Dec;
  eadProfileKind: EadSchedule['kind'];
  eadProfileLabel: string;
  eadScheduleExtendedFlat: boolean;
  pdSourceKind: 'SUPPLIED_TERM_STRUCTURE' | 'DERIVED_FROM_ANCHORS';
  effectiveInterestRate: Dec;
  discountConvention: DiscountConvention;
  scenarioResults: EclScenarioResult[];
  /** The reported IFRS 9 loss allowance for this exposure. */
  lossAllowance: Dec;
  /** Gross carrying amount minus loss allowance (Stage 3 disclosure view). */
  netCarryingAmount: Dec;
  /** lossAllowance / grossCarryingAmount. */
  coverageRatio: Dec;
  /** lossAllowance / EAD at the reporting date. */
  coverageOfEad: Dec;
  lifetimePdAtReportingDate: Dec;
  educationalApproximation: EducationalApproximation;
  explanation: string[];
  lineage: EclLineage;
}

const STAGE_1_HORIZON_NOTE =
  'Stage 1: 12-month ECL. The horizon covers default events possible in the next 12 months, and each period measures the FULL lifetime cash shortfall such a default would cause (LGD x the contractual EAD outstanding at that date, discounted to the reporting date) — not only shortfalls arising inside the 12 months.';
const STAGE_2_HORIZON_NOTE =
  'Stage 2: lifetime ECL over the remaining contractual term after a significant increase in credit risk, capped by the configured lifetime horizon.';
const STAGE_3_HORIZON_NOTE =
  'Stage 3: lifetime ECL over the remaining contractual term for a credit-impaired exposure. Net carrying amount = gross carrying amount - loss allowance.';

function horizonNoteFor(stage: Stage): string {
  if (stage === 1) return STAGE_1_HORIZON_NOTE;
  return stage === 2 ? STAGE_2_HORIZON_NOTE : STAGE_3_HORIZON_NOTE;
}

const money = (value: Dec): string => Number(moneyToString(value)).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percent = (value: Dec, dp = 4): string => `${value.times(100).toFixed(dp)}%`;

/**
 * Calculates the full loss allowance for one exposure across every active
 * scenario, with period-level lineage.
 */
export function calculateExposureEcl(
  exposure: EclExposureInput,
  scenarioSet: ScenarioSetInput,
  config: EclModelConfigurationInput,
  lineage?: Partial<EclLineage>,
): EclExposureResult {
  const reportingDate = assertIsoDate(exposure.reportingDate, 'reportingDate');
  const maturityDate = assertIsoDate(exposure.maturityDate, 'maturityDate');

  const stagingDecision = assessStage(exposure.staging, config.stagingRuleSet, exposure.override ?? null);
  const stage = stagingDecision.stage;

  const remainingContractualMonths = monthsBetween(reportingDate, maturityDate);
  if (remainingContractualMonths < 1) {
    // `periodEndDate(reportingDate, 1)` is the earliest maturity that yields a
    // one-period horizon, month-end clamping included, so the detail an analyst
    // sees states a date they can actually act on rather than a bare inequality.
    throw engineError(
      'INVALID_DATE_RANGE',
      `Maturity date ${maturityDate} must be at least one month after reporting date ${reportingDate}`,
      [
        {
          field: 'maturityDate',
          observed: maturityDate,
          expected: `>= ${periodEndDate(reportingDate, 1)}`,
        },
      ],
    );
  }

  const pdFloor = dec(config.pdFloor);
  const pdCeiling = dec(config.pdCeiling);
  const lgdFloor = dec(config.lgdFloor);
  const lgdCeiling = dec(config.lgdCeiling);

  const window = config.twelveMonthWindow;
  const cap = stage === 1 ? Math.min(window, config.lifetimeHorizonMonthsCap) : config.lifetimeHorizonMonthsCap;
  const horizonMonths = Math.max(1, Math.min(remainingContractualMonths, cap, config.maxCalculationPeriods));

  const eir = validateEffectiveInterestRate(exposure.effectiveInterestRate, {
    min: config.effectiveInterestRateMin,
    max: config.effectiveInterestRateMax,
  });

  const gross = dec(exposure.grossCarryingAmount);
  if (!gross.isFinite() || gross.lessThan(zero())) {
    throw engineError('EAD_NEGATIVE', 'Gross carrying amount cannot be negative', [
      { field: 'grossCarryingAmount', observed: gross.toString(), expected: '>= 0' },
    ]);
  }

  const baseLgdUnclamped = dec(exposure.lgd);
  if (!baseLgdUnclamped.isFinite() || baseLgdUnclamped.lessThan(zero()) || baseLgdUnclamped.greaterThan(one())) {
    throw engineError('LGD_OUT_OF_RANGE', 'LGD must be a decimal between 0 and 1', [
      { field: 'lgd', observed: baseLgdUnclamped.toString(), expected: '0 <= lgd <= 1' },
    ]);
  }

  // --- PD term structure -------------------------------------------------
  let baseMarginals: MarginalPdPoint[];
  let pdSourceKind: EclExposureResult['pdSourceKind'];
  if (exposure.pdTermStructure && exposure.pdTermStructure.points.length > 0) {
    baseMarginals = toMarginalPd(exposure.pdTermStructure);
    pdSourceKind = 'SUPPLIED_TERM_STRUCTURE';
    if (baseMarginals.length < horizonMonths) {
      throw engineError(
        'PD_TERM_STRUCTURE_GAPS',
        `Supplied PD term structure covers ${baseMarginals.length} periods but the ${stage === 1 ? '12-month' : 'lifetime'} horizon needs ${horizonMonths}`,
        [
          {
            field: 'pdTermStructure.points',
            observed: String(baseMarginals.length),
            expected: `>= ${horizonMonths}`,
          },
        ],
      );
    }
  } else {
    baseMarginals = deriveTermStructureFromAnchors({
      twelveMonthPd: exposure.twelveMonthPd,
      lifetimePd: exposure.lifetimePd,
      remainingMonths: remainingContractualMonths,
      twelveMonthWindow: window,
      pdFloor,
      pdCeiling,
    });
    pdSourceKind = 'DERIVED_FROM_ANCHORS';
  }
  const horizonMarginals = baseMarginals.slice(0, horizonMonths);

  // --- EAD schedule ------------------------------------------------------
  const eadSchedule = buildEadSchedule({
    periods: horizonMonths,
    grossCarryingAmount: gross,
    undrawnCommitment: exposure.undrawnCommitment,
    creditConversionFactor: exposure.creditConversionFactor,
    contractualSchedule: exposure.eadSchedule ?? null,
    simplifiedProfile: exposure.simplifiedEadProfile ?? config.defaultSimplifiedEadProfile,
  });

  const eadAtReportingDate = eadSchedule.points[0].ead;
  const lifetimePdAtReportingDate = cumulativePdOver(horizonMarginals);

  // --- Scenarios ---------------------------------------------------------
  const resolvedSet = resolveScenarioSet(scenarioSet);
  const scenarioResults: EclScenarioResult[] = resolvedSet.activeScenarios.map((scenario) =>
    calculateScenario(
      scenario,
      horizonMarginals,
      eadSchedule,
      horizonMonths,
      {
        eir,
        convention: config.discountConvention,
        baseLgd: baseLgdUnclamped,
        lgdFloor,
        lgdCeiling,
        reportingDate,
      },
    ),
  );

  const lossAllowance = scenarioResults.reduce(
    (total, scenario) => total.plus(scenario.weightedEcl),
    zero(),
  );
  const netCarryingAmount = gross.minus(lossAllowance);
  const coverageRatio = gross.isZero() ? zero() : lossAllowance.dividedBy(gross);
  const coverageOfEad = eadAtReportingDate.isZero() ? zero() : lossAllowance.dividedBy(eadAtReportingDate);

  // --- Educational shortcut (never the reported figure) ------------------
  const lumpPd = clampDec(
    stage === 1 ? dec(exposure.twelveMonthPd) : dec(exposure.lifetimePd),
    pdFloor,
    pdCeiling,
  );
  const lumpLgd = clampDec(baseLgdUnclamped, lgdFloor, lgdCeiling);
  const lumpDf = discountFactorForPeriod(eir, horizonMonths, config.discountConvention, {
    min: config.effectiveInterestRateMin,
    max: config.effectiveInterestRateMax,
  });
  const lumpValue = roundMoney(lumpPd.times(lumpLgd).times(eadAtReportingDate).times(lumpDf));

  const resolvedLineage: EclLineage = {
    inputVersion: lineage?.inputVersion ?? 'unversioned',
    modelConfigurationId: config.id,
    modelConfigurationName: config.name,
    modelConfigurationVersion: config.version,
    stagingRuleSetId: config.stagingRuleSet.id,
    stagingRuleSetVersion: config.stagingRuleSet.version,
    scenarioSetId: resolvedSet.id,
    scenarioSetName: resolvedSet.name,
    scenarioSetVersion: resolvedSet.version,
    reportingDate,
    calculatedAt: lineage?.calculatedAt ?? '1970-01-01T00:00:00.000Z',
    actorId: lineage?.actorId ?? 'system',
    actorName: lineage?.actorName ?? 'ECL engine',
    roundingPolicy: ROUNDING_POLICY,
  };

  const explanation = [
    `Stage ${stage} — ${stagingDecision.primaryReason}. Rule set ${config.stagingRuleSet.id} v${config.stagingRuleSet.version}; ${stagingDecision.triggeredRules.length} rule(s) triggered${stagingDecision.hasOverride ? '; analyst override in force' : ''}.`,
    horizonNoteFor(stage),
    `Horizon = ${horizonMonths} month(s): min(remaining contractual term ${remainingContractualMonths}, ${stage === 1 ? `12-month window ${window}` : `lifetime cap ${config.lifetimeHorizonMonthsCap}`}).`,
    `PD source: ${pdSourceKind === 'SUPPLIED_TERM_STRUCTURE' ? `supplied ${exposure.pdTermStructure?.basis ?? ''} term structure converted to marginals by survival logic` : `flat hazard interpolated from the 12-month PD (${percent(dec(exposure.twelveMonthPd), 2)}) and lifetime PD (${percent(dec(exposure.lifetimePd), 2)}) anchors`}. Cumulative PD in horizon = ${percent(lifetimePdAtReportingDate)}.`,
    `EAD: ${eadSchedule.label}. EAD(period 1) = drawn ${money(eadSchedule.points[0].drawnBalance)} + CCF ${rateToString(eadSchedule.points[0].creditConversionFactor)} x undrawn ${money(eadSchedule.points[0].undrawnCommitment)} = ${money(eadAtReportingDate)} ${exposure.currency}.`,
    `Discounting at the original EIR ${percent(eir, 2)} using the ${config.discountConvention} convention: DF(t) = (1 + EIR)^(-t/12).`,
    ...scenarioResults.map(
      (scenario) =>
        `${scenario.scenarioName} (weight ${percent(scenario.weight, 1)}, PD x${rateToString(scenario.pdMultiplier)}, LGD x${rateToString(scenario.lgdMultiplier)}): ECL ${money(scenario.unweightedEcl)}, weighted ${money(scenario.weightedEcl)}.`,
    ),
    `Loss allowance = ${scenarioResults.map((s) => money(s.weightedEcl)).join(' + ')} = ${money(lossAllowance)} ${exposure.currency}. Coverage ${percent(coverageRatio, 2)} of gross carrying amount.`,
    `Net carrying amount = ${money(gross)} - ${money(lossAllowance)} = ${money(netCarryingAmount)} ${exposure.currency}.`,
    `Rounding: ${ROUNDING_POLICY}`,
  ];

  return {
    exposureKey: exposure.exposureKey,
    currency: exposure.currency,
    stage,
    staging: stagingDecision,
    horizonBasisNote: horizonNoteFor(stage),
    remainingContractualMonths,
    horizonMonths,
    grossCarryingAmount: gross,
    eadAtReportingDate,
    eadProfileKind: eadSchedule.kind,
    eadProfileLabel: eadSchedule.label,
    eadScheduleExtendedFlat: eadSchedule.extendedFlatBeyondSchedule,
    pdSourceKind,
    effectiveInterestRate: eir,
    discountConvention: config.discountConvention,
    scenarioResults,
    lossAllowance,
    netCarryingAmount,
    coverageRatio,
    coverageOfEad,
    lifetimePdAtReportingDate,
    educationalApproximation: {
      label:
        'Educational approximation only — the single-period PD x LGD x EAD x DF shortcut. This is NOT the reported IFRS 9 allowance and must never be used for booking.',
      lumpPd,
      lgd: lumpLgd,
      eadAtReportingDate,
      discountFactor: lumpDf,
      value: lumpValue,
      formulaTrace: `PD ${rateToString(lumpPd)} x LGD ${rateToString(lumpLgd)} x EAD ${moneyToString(eadAtReportingDate)} x DF ${rateToString(lumpDf)} = ${moneyToString(lumpValue)}`,
    },
    explanation,
    lineage: resolvedLineage,
  };
}

interface ScenarioCalculationContext {
  eir: Dec;
  convention: DiscountConvention;
  baseLgd: Dec;
  lgdFloor: Dec;
  lgdCeiling: Dec;
  reportingDate: IsoDate;
}

/**
 * One scenario slice: scale the PD term structure in hazard space, scale and
 * clamp LGD, walk the periods and accumulate discounted expected losses.
 */
function calculateScenario(
  scenario: ResolvedScenario,
  baseMarginals: MarginalPdPoint[],
  eadSchedule: EadSchedule,
  horizonMonths: number,
  context: ScenarioCalculationContext,
): EclScenarioResult {
  const scaled = scaleMarginalPd(baseMarginals, scenario.pdMultiplier);
  const scenarioLgd = clampDec(
    context.baseLgd.times(scenario.lgdMultiplier),
    context.lgdFloor,
    context.lgdCeiling,
  );

  const periods: EclPeriodResult[] = [];
  let unweighted = zero();

  for (let period = 1; period <= horizonMonths; period += 1) {
    const marginal = scaled[period - 1];
    const eadPoint = eadSchedule.points[period - 1];
    const df = discountFactorForPeriod(context.eir, period, context.convention);
    const expectedLoss = roundMoney(
      marginal.marginalPd.times(scenarioLgd).times(eadPoint.ead).times(df),
    );
    unweighted = unweighted.plus(expectedLoss);

    periods.push({
      period,
      periodStart: periodStartDate(context.reportingDate, period),
      periodEnd: periodEndDate(context.reportingDate, period),
      monthsFromReportingDate: period,
      marginalPd: marginal.marginalPd,
      cumulativePd: marginal.cumulativePd,
      lgd: scenarioLgd,
      ead: eadPoint.ead,
      discountFactor: df,
      expectedLoss,
      formulaTrace:
        `P${period}: marginalPD ${rateToString(marginal.marginalPd)} x LGD ${rateToString(scenarioLgd)}` +
        ` x EAD ${moneyToString(eadPoint.ead)} x DF ${rateToString(df)}` +
        ` (=(1+EIR)^(-${period}/12)) = ${moneyToString(expectedLoss)}`,
    });
  }

  const weightedEcl = roundMoney(unweighted.times(scenario.weight));

  return {
    scenarioCode: scenario.code,
    scenarioName: scenario.name,
    weight: scenario.weight,
    pdMultiplier: scenario.pdMultiplier,
    lgdMultiplier: scenario.lgdMultiplier,
    horizonMonths,
    periods,
    unweightedEcl: unweighted,
    weightedEcl,
    cumulativePdInHorizon: scaled.length > 0 ? scaled[scaled.length - 1].cumulativePd : zero(),
  };
}

// ---------------------------------------------------------------------------
// Portfolio aggregation
// ---------------------------------------------------------------------------

export interface StageBucketTotals {
  stage: Stage;
  exposureCount: number;
  grossCarryingAmount: Dec;
  ead: Dec;
  lossAllowance: Dec;
  netCarryingAmount: Dec;
  coverageRatio: Dec;
}

/**
 * Per-stage balance, allowance and count, still in exact decimals. The wire
 * shape (`StageDistributionDto`) is produced by `serializePortfolioTotals`;
 * money never passes through a binary float on the way out.
 */
export interface StageDistributionTotals {
  balance: Dec;
  ecl: Dec;
  count: number;
}

export interface PortfolioTotalsResult {
  currency: string;
  exposureCount: number;
  totalGrossCarryingAmount: Dec;
  totalEad: Dec;
  totalLossAllowance: Dec;
  totalNetCarryingAmount: Dec;
  coverageRatio: Dec;
  stageBuckets: StageBucketTotals[];
  stageDistribution: Record<Stage, StageDistributionTotals>;
  roundingPolicy: string;
}

const emptyBucket = (stage: Stage): StageBucketTotals => ({
  stage,
  exposureCount: 0,
  grossCarryingAmount: zero(),
  ead: zero(),
  lossAllowance: zero(),
  netCarryingAmount: zero(),
  coverageRatio: zero(),
});

/**
 * Aggregates exposure results into portfolio totals.
 *
 * The total is the exact sum of the per-exposure loss allowances, which are
 * themselves exact sums of rounded scenario and period amounts. Portfolio
 * totals therefore always equal the sum of the exposure rows a reviewer sees.
 */
export function aggregatePortfolioResults(
  results: EclExposureResult[],
  currency = 'PKR',
): PortfolioTotalsResult {
  const buckets = new Map<Stage, StageBucketTotals>([
    [1, emptyBucket(1)],
    [2, emptyBucket(2)],
    [3, emptyBucket(3)],
  ]);

  let totalGross = zero();
  let totalEad = zero();
  let totalAllowance = zero();
  let totalNet = zero();

  for (const result of results) {
    const bucket = buckets.get(result.stage) ?? emptyBucket(result.stage);
    bucket.exposureCount += 1;
    bucket.grossCarryingAmount = bucket.grossCarryingAmount.plus(result.grossCarryingAmount);
    bucket.ead = bucket.ead.plus(result.eadAtReportingDate);
    bucket.lossAllowance = bucket.lossAllowance.plus(result.lossAllowance);
    bucket.netCarryingAmount = bucket.netCarryingAmount.plus(result.netCarryingAmount);
    buckets.set(result.stage, bucket);

    totalGross = totalGross.plus(result.grossCarryingAmount);
    totalEad = totalEad.plus(result.eadAtReportingDate);
    totalAllowance = totalAllowance.plus(result.lossAllowance);
    totalNet = totalNet.plus(result.netCarryingAmount);
  }

  const stageBuckets = [1, 2, 3].map((stage) => {
    const bucket = buckets.get(stage as Stage) ?? emptyBucket(stage as Stage);
    return {
      ...bucket,
      coverageRatio: bucket.grossCarryingAmount.isZero()
        ? zero()
        : bucket.lossAllowance.dividedBy(bucket.grossCarryingAmount),
    };
  });

  const stageDistribution = stageBuckets.reduce(
    (acc, bucket) => {
      acc[bucket.stage] = {
        balance: bucket.grossCarryingAmount,
        ecl: bucket.lossAllowance,
        count: bucket.exposureCount,
      };
      return acc;
    },
    {
      1: { balance: zero(), ecl: zero(), count: 0 },
      2: { balance: zero(), ecl: zero(), count: 0 },
      3: { balance: zero(), ecl: zero(), count: 0 },
    } as Record<Stage, StageDistributionTotals>,
  );

  return {
    currency,
    exposureCount: results.length,
    totalGrossCarryingAmount: totalGross,
    totalEad,
    totalLossAllowance: totalAllowance,
    totalNetCarryingAmount: totalNet,
    coverageRatio: totalGross.isZero() ? zero() : totalAllowance.dividedBy(totalGross),
    stageBuckets,
    stageDistribution,
    roundingPolicy: ROUNDING_POLICY,
  };
}

/** Convenience: totals for a whole portfolio in one call. */
export function calculatePortfolioEcl(
  exposures: EclExposureInput[],
  scenarioSet: ScenarioSetInput,
  config: EclModelConfigurationInput,
  lineage?: Partial<EclLineage>,
): { results: EclExposureResult[]; totals: PortfolioTotalsResult } {
  const results = exposures.map((exposure) =>
    calculateExposureEcl(exposure, scenarioSet, config, lineage),
  );
  return {
    results,
    totals: aggregatePortfolioResults(results, exposures[0]?.currency ?? 'PKR'),
  };
}
