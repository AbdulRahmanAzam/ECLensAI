/**
 * End-to-end engine tests with hand-checkable arithmetic.
 *
 * The fixtures are built so an auditor can reproduce every digit on paper:
 *   - EIR = 0            -> discount factor is exactly 1 for every period
 *   - FLAT EAD profile   -> EAD is the same number in every period
 *   - CONDITIONAL basis  -> a flat hazard h gives marginalPD(t) = (1-h)^(t-1) x h
 *
 * The CONDITIONAL basis matters: `scaleMarginalPd` re-derives marginals from
 * conditional PDs on every call, including a multiplier of exactly 1. A
 * MARGINAL-basis fixture would therefore drift through a non-terminating
 * `m(t) / S(t-1)` division and could not be asserted to the digit.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregatePortfolioResults,
  calculateExposureEcl,
  calculatePortfolioEcl,
  dec,
  DEFAULT_MODEL_CONFIGURATION,
  resolveScenarioSet,
  ROUNDING_POLICY,
  roundMoney,
  serializeExposureResult,
  serializePortfolioTotals,
  zero,
  type Dec,
  type EclExposureInput,
  type PdTermStructureInput,
  type ScenarioSetInput,
  type StagingInput,
} from '../src/index';

const REPORTING_DATE = '2026-08-31';
const GROSS = '100000';
const LGD = '0.5';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
};

const cleanStaging = (overrides: Partial<StagingInput> = {}): StagingInput => ({
  daysPastDue: 0,
  defaultFlag: false,
  creditImpairedFlag: false,
  forbearanceFlag: false,
  restructuringFlag: false,
  watchlistFlag: false,
  originalCreditRating: 'BBB',
  currentCreditRating: 'BBB',
  pdAtOrigination: '0.01',
  currentPd: '0.01',
  ...overrides,
});

/** A flat conditional (hazard) term structure over `periods` months. */
const flatHazard = (pd: string, periods: number): PdTermStructureInput => ({
  basis: 'CONDITIONAL',
  points: Array.from({ length: periods }, (_, index) => ({ period: index + 1, pd })),
});

const periodLosses = (result: ReturnType<typeof calculateExposureEcl>, scenario = 0): string[] =>
  result.scenarioResults[scenario].periods.map((period) => period.expectedLoss.toFixed(2));

const SINGLE_SCENARIO: ScenarioSetInput = {
  id: 'scs-test-single',
  name: 'Single scenario',
  version: '1.0.0',
  scenarios: [
    {
      code: 'BASE',
      name: 'Base',
      weight: '1',
      pdMultiplier: '1',
      lgdMultiplier: '1',
      isActive: true,
    },
  ],
};

const TWO_SCENARIOS: ScenarioSetInput = {
  id: 'scs-test-pair',
  name: 'Base and downside',
  version: '1.0.0',
  scenarios: [
    {
      code: 'BASE',
      name: 'Base',
      weight: '0.6',
      pdMultiplier: '1',
      lgdMultiplier: '1',
      isActive: true,
    },
    {
      code: 'DOWNSIDE',
      name: 'Downside',
      weight: '0.4',
      pdMultiplier: '2',
      lgdMultiplier: '1',
      isActive: true,
    },
  ],
};

const exposure = (overrides: Partial<EclExposureInput> = {}): EclExposureInput => ({
  exposureKey: 'EXP-TEST-0001',
  currency: 'PKR',
  reportingDate: REPORTING_DATE,
  maturityDate: '2026-11-30',
  grossCarryingAmount: GROSS,
  undrawnCommitment: '0',
  creditConversionFactor: '0',
  effectiveInterestRate: '0',
  lgd: LGD,
  twelveMonthPd: '0.03',
  lifetimePd: '0.09',
  pdTermStructure: flatHazard('0.01', 3),
  simplifiedEadProfile: 'FLAT',
  staging: cleanStaging(),
  ...overrides,
});

describe('Stage 1 — hand-checkable period arithmetic', () => {
  const result = calculateExposureEcl(exposure(), SINGLE_SCENARIO, DEFAULT_MODEL_CONFIGURATION);

  it('runs a 3-month horizon at the zero rate with a flat EAD', () => {
    expect(result.stage).toBe(1);
    expect(result.remainingContractualMonths).toBe(3);
    expect(result.horizonMonths).toBe(3);
    expect(result.eadProfileKind).toEqual('SIMPLIFIED_FLAT_BALANCE');
    expect(result.eadProfileLabel).toContain('no contractual amortization schedule supplied');
    expect(result.pdSourceKind).toEqual('SUPPLIED_TERM_STRUCTURE');
    expect(result.discountConvention).toEqual('END_PERIOD');
  });

  it('documents that Stage 1 measures the FULL lifetime shortfall of a 12-month default', () => {
    expect(result.horizonBasisNote).toContain('Stage 1: 12-month ECL');
    expect(result.horizonBasisNote).toContain('FULL lifetime cash shortfall');
    expect(result.horizonBasisNote).toContain('not only shortfalls arising inside the 12 months');
  });

  it('produces period losses an auditor can reproduce by hand', () => {
    // marginalPD(t) = 0.99^(t-1) x 0.01; loss(t) = marginalPD x 0.5 x 100000 x 1
    //   P1 0.01      x 50000 = 500.00
    //   P2 0.0099    x 50000 = 495.00
    //   P3 0.009801  x 50000 = 490.05
    expect(periodLosses(result)).toEqual(['500.00', '495.00', '490.05']);
    expect(result.scenarioResults[0].unweightedEcl.toFixed(2)).toEqual('1485.05');
  });

  it('carries the survival-logic marginals and cumulatives', () => {
    const periods = result.scenarioResults[0].periods;
    expect(periods.map((p) => p.marginalPd.toFixed(10))).toEqual([
      '0.0100000000',
      '0.0099000000',
      '0.0098010000',
    ]);
    expect(periods.map((p) => p.cumulativePd.toFixed(10))).toEqual([
      '0.0100000000',
      '0.0199000000',
      '0.0297010000',
    ]);
    expect(result.lifetimePdAtReportingDate.toFixed(10)).toEqual('0.0297010000');
  });

  it('holds discount factor, EAD and LGD constant across the horizon', () => {
    const periods = result.scenarioResults[0].periods;
    expect(periods.map((p) => p.discountFactor.toFixed(10))).toEqual([
      '1.0000000000',
      '1.0000000000',
      '1.0000000000',
    ]);
    expect(periods.map((p) => p.ead.toFixed(2))).toEqual(['100000.00', '100000.00', '100000.00']);
    expect(periods.map((p) => p.lgd.toFixed(10))).toEqual([
      '0.5000000000',
      '0.5000000000',
      '0.5000000000',
    ]);
  });

  it('labels every period with unambiguous ISO start and end dates', () => {
    const periods = result.scenarioResults[0].periods;
    expect(periods.map((p) => p.periodStart)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31']);
    expect(periods.map((p) => p.periodEnd)).toEqual(['2026-09-30', '2026-10-31', '2026-11-30']);
    expect(periods.map((p) => p.monthsFromReportingDate)).toEqual([1, 2, 3]);
  });

  it('emits a formula trace that replays the exact digits used', () => {
    expect(result.scenarioResults[0].periods[0].formulaTrace).toEqual(
      'P1: marginalPD 0.0100000000 x LGD 0.5000000000 x EAD 100000.00 x DF 1.0000000000 (=(1+EIR)^(-1/12)) = 500.00',
    );
  });

  it('derives allowance, net carrying amount and coverage from the period rows', () => {
    expect(result.lossAllowance.toFixed(2)).toEqual('1485.05');
    expect(result.netCarryingAmount.toFixed(2)).toEqual('98514.95');
    expect(result.coverageRatio.toFixed(10)).toEqual('0.0148505000');
    expect(result.grossCarryingAmount.toFixed(2)).toEqual('100000.00');
    expect(result.eadAtReportingDate.toFixed(2)).toEqual('100000.00');
  });
});

describe('Stage 2 and Stage 3 horizons', () => {
  it('switches to the lifetime horizon after a significant increase in credit risk', () => {
    const result = calculateExposureEcl(
      exposure({ staging: cleanStaging({ watchlistFlag: true }) }),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    expect(result.stage).toBe(2);
    expect(result.staging.primaryRuleCode).toEqual('WATCHLIST_SICR');
    expect(result.horizonBasisNote).toContain('Stage 2: lifetime ECL');
  });

  it('exposes the net carrying amount for credit-impaired exposures', () => {
    const result = calculateExposureEcl(
      exposure({
        staging: cleanStaging({ defaultFlag: true, daysPastDue: 120 }),
      }),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    expect(result.stage).toBe(3);
    expect(result.staging.primaryRuleCode).toEqual('DEFAULT_FLAG');
    expect(result.horizonBasisNote).toContain('Stage 3: lifetime ECL');
    expect(result.horizonBasisNote).toContain(
      'Net carrying amount = gross carrying amount - loss allowance',
    );
    expect(result.netCarryingAmount.toFixed(2)).toEqual(
      result.grossCarryingAmount.minus(result.lossAllowance).toFixed(2),
    );
  });
});

describe('Horizon capping by stage', () => {
  const longDated = (staging: StagingInput): EclExposureInput =>
    exposure({
      maturityDate: '2028-08-31',
      pdTermStructure: flatHazard('0.01', 24),
      staging,
    });

  /**
   * Recomputes the horizon total without the engine's survival recursion, so a
   * bug in the recursion cannot hide behind a matching expected constant.
   */
  const independentTotal = (periods: number): Dec => {
    let total = zero();
    for (let period = 1; period <= periods; period += 1) {
      const marginal = dec('0.99').pow(period - 1).times(dec('0.01'));
      total = total.plus(roundMoney(marginal.times(dec(LGD)).times(dec(GROSS))));
    }
    return total;
  };

  it('caps Stage 1 at the 12-month window while Stage 2 runs the full term', () => {
    const stage1 = calculateExposureEcl(
      longDated(cleanStaging()),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    const stage2 = calculateExposureEcl(
      longDated(cleanStaging({ watchlistFlag: true })),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );

    expect(stage1.remainingContractualMonths).toBe(24);
    expect(stage1.horizonMonths).toBe(12);
    expect(stage2.horizonMonths).toBe(24);

    // 500.00 + 495.00 + 490.05 + 485.15 + 480.30 + 475.50 + 470.74 + 466.03
    //   + 461.37 + 456.76 + 452.19 + 447.67
    expect(stage1.lossAllowance.toFixed(2)).toEqual('5680.76');
    expect(stage1.lossAllowance.toFixed(2)).toEqual(independentTotal(12).toFixed(2));
    expect(stage2.lossAllowance.toFixed(2)).toEqual(independentTotal(24).toFixed(2));
    expect(stage2.lossAllowance.greaterThan(stage1.lossAllowance)).toBe(true);
  });
});

describe('Scenario weighting and reconciliation', () => {
  const result = calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION);
  const [base, downside] = result.scenarioResults;

  it('weights each scenario ECL by its probability weight', () => {
    expect(base.scenarioCode).toEqual('BASE');
    expect(base.unweightedEcl.toFixed(2)).toEqual('1485.05');
    expect(base.weightedEcl.toFixed(2)).toEqual('891.03');

    // Downside doubles the hazard: 0.02, 0.98 x 0.02 = 0.0196, 0.9604 x 0.02 = 0.019208
    expect(downside.scenarioCode).toEqual('DOWNSIDE');
    expect(periodLosses(result, 1)).toEqual(['1000.00', '980.00', '960.40']);
    expect(downside.unweightedEcl.toFixed(2)).toEqual('2940.40');
    expect(downside.weightedEcl.toFixed(2)).toEqual('1176.16');
  });

  it('reconciles the loss allowance to the exact sum of weighted scenario ECLs', () => {
    expect(result.lossAllowance.toFixed(2)).toEqual('2067.19');
    const weighted = result.scenarioResults.reduce((total, s) => total.plus(s.weightedEcl), zero());
    expect(result.lossAllowance.toFixed(2)).toEqual(weighted.toFixed(2));
  });

  it('makes each scenario period table add up to its own displayed total', () => {
    for (const scenario of result.scenarioResults) {
      const tableSum = scenario.periods.reduce((total, p) => total.plus(p.expectedLoss), zero());
      expect(tableSum.toFixed(2)).toEqual(scenario.unweightedEcl.toFixed(2));
    }
  });

  it('sums only over active scenarios', () => {
    const resolved = resolveScenarioSet({
      ...TWO_SCENARIOS,
      scenarios: [
        { ...TWO_SCENARIOS.scenarios[0], weight: '1' },
        { ...TWO_SCENARIOS.scenarios[1], isActive: false },
      ],
    });
    expect(resolved.scenarios).toHaveLength(2);
    expect(resolved.activeScenarios.map((s) => s.code)).toEqual(['BASE']);
    expect(resolved.weightTotal.toFixed(10)).toEqual('1.0000000000');
  });

  it('accepts more than the base/upside/downside trio', () => {
    const resolved = resolveScenarioSet({
      id: 'scs-test-five',
      name: 'Five scenarios',
      version: '1.0.0',
      scenarios: [0.6, 0.1, 0.1, 0.1, 0.1].map((weight, index) => ({
        code: `SCENARIO_${index + 1}`,
        name: `Scenario ${index + 1}`,
        weight: String(weight),
        pdMultiplier: '1',
        lgdMultiplier: '1',
        isActive: true,
      })),
    });
    expect(resolved.activeScenarios).toHaveLength(5);
    expect(resolved.weightTotal.toFixed(10)).toEqual('1.0000000000');
  });

  it('accepts weights that only total 1 in exact decimal arithmetic', () => {
    const resolved = resolveScenarioSet({
      id: 'scs-test-thirds',
      name: 'Thirds',
      version: '1.0.0',
      scenarios: ['0.333333333333333333', '0.333333333333333333', '0.333333333333333334'].map(
        (weight, index) => ({
          code: `THIRD_${index + 1}`,
          name: `Third ${index + 1}`,
          weight,
          pdMultiplier: '1',
          lgdMultiplier: '1',
          isActive: true,
        }),
      ),
    });
    expect(resolved.weightTotal.toString()).toEqual('1');
  });

  it('rejects malformed scenario sets instead of repairing them', () => {
    const withScenarios = (scenarios: ScenarioSetInput['scenarios']): ScenarioSetInput => ({
      id: 'scs-test-invalid',
      name: 'Invalid',
      version: '1.0.0',
      scenarios,
    });
    const scenario = (overrides: Partial<ScenarioSetInput['scenarios'][number]>) => ({
      code: 'BASE',
      name: 'Base',
      weight: '1',
      pdMultiplier: '1',
      lgdMultiplier: '1',
      isActive: true,
      ...overrides,
    });

    expect(
      codeOf(() =>
        resolveScenarioSet(
          withScenarios([scenario({ weight: '0.6' }), scenario({ code: 'OTHER', weight: '0.5' })]),
        ),
      ),
    ).toEqual('SCENARIO_WEIGHTS_NOT_NORMALIZED');

    expect(
      codeOf(() =>
        resolveScenarioSet(
          withScenarios([scenario({ weight: '1.2' }), scenario({ code: 'OTHER', weight: '-0.2' })]),
        ),
      ),
    ).toEqual('SCENARIO_WEIGHT_NEGATIVE');

    expect(
      codeOf(() => resolveScenarioSet(withScenarios([scenario(), scenario()]))),
    ).toEqual('SCENARIO_CODE_DUPLICATE');

    expect(
      codeOf(() => resolveScenarioSet(withScenarios([scenario({ pdMultiplier: '0' })]))),
    ).toEqual('SCENARIO_FACTOR_INVALID');

    expect(codeOf(() => resolveScenarioSet(withScenarios([])))).toEqual('SCENARIO_SET_EMPTY');
  });
});

describe('Portfolio aggregation', () => {
  const exposures: EclExposureInput[] = [
    exposure(),
    exposure({
      exposureKey: 'EXP-TEST-0002',
      grossCarryingAmount: '250000',
      maturityDate: '2027-02-28',
      pdTermStructure: flatHazard('0.02', 6),
      staging: cleanStaging({ daysPastDue: 45 }),
    }),
    exposure({
      exposureKey: 'EXP-TEST-0003',
      grossCarryingAmount: '75000',
      lgd: '0.7',
      staging: cleanStaging({ creditImpairedFlag: true, daysPastDue: 150 }),
    }),
  ];

  const { results, totals } = calculatePortfolioEcl(
    exposures,
    TWO_SCENARIOS,
    DEFAULT_MODEL_CONFIGURATION,
  );

  it('assigns one exposure to each stage', () => {
    expect(results.map((r) => r.stage)).toEqual([1, 2, 3]);
  });

  it('reports a total that is the exact sum of the exposure allowances', () => {
    const manualSum = results.reduce((total, r) => total.plus(r.lossAllowance), zero());
    expect(totals.totalLossAllowance.toFixed(2)).toEqual(manualSum.toFixed(2));
    expect(totals.roundingPolicy).toEqual(ROUNDING_POLICY);
  });

  it('reports gross, net and coverage consistently', () => {
    expect(totals.currency).toEqual('PKR');
    expect(totals.exposureCount).toBe(3);
    expect(totals.totalGrossCarryingAmount.toFixed(2)).toEqual('425000.00');
    expect(totals.totalNetCarryingAmount.toFixed(2)).toEqual(
      totals.totalGrossCarryingAmount.minus(totals.totalLossAllowance).toFixed(2),
    );
    expect(totals.coverageRatio.toFixed(10)).toEqual(
      totals.totalLossAllowance.dividedBy(totals.totalGrossCarryingAmount).toFixed(10),
    );
  });

  it('buckets by stage and adds back to the portfolio total', () => {
    expect(totals.stageBuckets.map((bucket) => bucket.stage)).toEqual([1, 2, 3]);
    expect(totals.stageBuckets.map((bucket) => bucket.exposureCount)).toEqual([1, 1, 1]);

    const allowanceSum = totals.stageBuckets.reduce(
      (total, bucket) => total.plus(bucket.lossAllowance),
      zero(),
    );
    const grossSum = totals.stageBuckets.reduce(
      (total, bucket) => total.plus(bucket.grossCarryingAmount),
      zero(),
    );
    expect(allowanceSum.toFixed(2)).toEqual(totals.totalLossAllowance.toFixed(2));
    expect(grossSum.toFixed(2)).toEqual(totals.totalGrossCarryingAmount.toFixed(2));

    for (const bucket of totals.stageBuckets) {
      expect(totals.stageDistribution[bucket.stage].count).toBe(bucket.exposureCount);
      expect(totals.stageDistribution[bucket.stage].balance.toFixed(2)).toEqual(
        bucket.grossCarryingAmount.toFixed(2),
      );
      expect(totals.stageDistribution[bucket.stage].ecl.toFixed(2)).toEqual(
        bucket.lossAllowance.toFixed(2),
      );
    }
  });

  it('agrees with aggregatePortfolioResults over the same exposure results', () => {
    expect(serializePortfolioTotals(aggregatePortfolioResults(results, 'PKR'))).toEqual(
      serializePortfolioTotals(totals),
    );
  });

  it('keeps empty stages visible with zero balances', () => {
    const partial = aggregatePortfolioResults([results[0], results[2]], 'PKR');
    expect(partial.exposureCount).toBe(2);
    expect(partial.stageDistribution[2].count).toBe(0);
    expect(partial.stageDistribution[2].balance.toFixed(2)).toEqual('0.00');
    expect(partial.stageDistribution[2].ecl.toFixed(2)).toEqual('0.00');

    const empty = aggregatePortfolioResults([], 'PKR');
    expect(empty.exposureCount).toBe(0);
    expect(empty.coverageRatio.toFixed(2)).toEqual('0.00');
    expect(empty.totalLossAllowance.toFixed(2)).toEqual('0.00');
  });
});

describe('Lineage, explanation and determinism', () => {
  it('stamps every result with input, model, rule-set, scenario, time and actor', () => {
    const result = calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION, {
      inputVersion: 'SEED/2026-08-31/v1',
      calculatedAt: '2026-08-31T18:00:00.000Z',
      actorId: 'usr-analyst-1',
      actorName: 'Ayesha Kazmi',
    });

    expect(result.lineage).toMatchObject({
      inputVersion: 'SEED/2026-08-31/v1',
      modelConfigurationId: 'mc-pkr-ifrs9',
      modelConfigurationName: 'ECLens IFRS 9 core model (PKR)',
      modelConfigurationVersion: '1.0.0',
      stagingRuleSetId: 'srs-ifrs9-core',
      stagingRuleSetVersion: '1.0.0',
      scenarioSetId: 'scs-test-pair',
      scenarioSetName: 'Base and downside',
      scenarioSetVersion: '1.0.0',
      reportingDate: REPORTING_DATE,
      calculatedAt: '2026-08-31T18:00:00.000Z',
      actorId: 'usr-analyst-1',
      actorName: 'Ayesha Kazmi',
      roundingPolicy: ROUNDING_POLICY,
    });
  });

  it('falls back to a system actor rather than inventing one', () => {
    const result = calculateExposureEcl(exposure(), SINGLE_SCENARIO, DEFAULT_MODEL_CONFIGURATION);
    expect(result.lineage.actorId).toEqual('system');
    expect(result.lineage.inputVersion).toEqual('unversioned');
  });

  it('explains the calculation in the order a reviewer reads it', () => {
    const result = calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION);
    const text = result.explanation.join('\n');

    expect(text).toContain('Stage 1');
    expect(text).toContain('Horizon = 3 month(s)');
    expect(text).toContain('Downside (weight 40.0%');
    expect(text).toContain('Loss allowance = 891.03 + 1,176.16 = 2,067.19 PKR');
    expect(text).toContain(ROUNDING_POLICY);
  });

  it('labels the single-period shortcut as educational and never reports it', () => {
    const result = calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION);
    const approximation = result.educationalApproximation;

    expect(approximation.label).toContain('Educational approximation only');
    expect(approximation.label).toContain('NOT the reported IFRS 9 allowance');
    // 0.03 x 0.5 x 100000 x 1 = 1500.00, which is not the reported 2067.19.
    expect(approximation.value.toFixed(2)).toEqual('1500.00');
    expect(approximation.value.toFixed(2)).not.toEqual(result.lossAllowance.toFixed(2));
    expect(approximation.formulaTrace).toContain('PD 0.0300000000');
  });

  it('is byte-identical across repeated runs', () => {
    const first = serializeExposureResult(
      calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION),
    );
    const second = serializeExposureResult(
      calculateExposureEcl(exposure(), TWO_SCENARIOS, DEFAULT_MODEL_CONFIGURATION),
    );
    expect(second).toEqual(first);
  });
});

describe('Input rejection', () => {
  const run = (overrides: Partial<EclExposureInput>) => (): unknown =>
    calculateExposureEcl(exposure(overrides), SINGLE_SCENARIO, DEFAULT_MODEL_CONFIGURATION);

  it('rejects a maturity on the reporting date', () => {
    expect(codeOf(run({ maturityDate: REPORTING_DATE }))).toEqual('INVALID_DATE_RANGE');
  });

  it('accepts the earliest maturity that yields a one-period horizon', () => {
    // addMonths('2026-08-31', 1) is '2026-09-30': month-end clamping means the
    // day-of-month goes backwards while the term still measures one whole month.
    const result = calculateExposureEcl(
      exposure({ maturityDate: '2026-09-30', pdTermStructure: flatHazard('0.01', 1) }),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    expect(result.remainingContractualMonths).toBe(1);
    expect(result.horizonMonths).toBe(1);
  });

  it('rejects a term structure shorter than the horizon', () => {
    expect(codeOf(run({ maturityDate: '2027-08-31' }))).toEqual('PD_TERM_STRUCTURE_GAPS');
  });

  it('rejects out-of-range and malformed inputs without repairing them', () => {
    expect(codeOf(run({ lgd: '1.5' }))).toEqual('LGD_OUT_OF_RANGE');
    expect(codeOf(run({ grossCarryingAmount: '-1' }))).toEqual('EAD_NEGATIVE');
    expect(codeOf(run({ effectiveInterestRate: '9' }))).toEqual('INVALID_EFFECTIVE_INTEREST_RATE');
    expect(codeOf(run({ creditConversionFactor: '1.4' }))).toEqual('CCF_OUT_OF_RANGE');
  });
});

describe('Contractual EAD schedule inside the engine', () => {
  const result = calculateExposureEcl(
    exposure({
      undrawnCommitment: '20000',
      creditConversionFactor: '0.5',
      eadSchedule: [
        { period: 1, drawnBalance: '90000', undrawnCommitment: '20000' },
        { period: 2, drawnBalance: '60000', undrawnCommitment: '20000' },
        { period: 3, drawnBalance: '30000', undrawnCommitment: '20000' },
      ],
    }),
    SINGLE_SCENARIO,
    DEFAULT_MODEL_CONFIGURATION,
  );

  it('prefers the supplied schedule over the simplified profile', () => {
    expect(result.eadProfileKind).toEqual('CONTRACTUAL_SCHEDULE');
    expect(result.eadScheduleExtendedFlat).toBe(false);
    // EAD(t) = drawn(t) + 0.5 x 20000
    expect(result.scenarioResults[0].periods.map((p) => p.ead.toFixed(2))).toEqual([
      '100000.00',
      '70000.00',
      '40000.00',
    ]);
    expect(result.eadAtReportingDate.toFixed(2)).toEqual('100000.00');
  });

  it('produces the hand-checkable amortizing allowance', () => {
    // 0.01 x 0.5 x 100000 = 500.00
    // 0.0099 x 0.5 x 70000 = 346.50
    // 0.009801 x 0.5 x 40000 = 196.02
    expect(periodLosses(result)).toEqual(['500.00', '346.50', '196.02']);
    expect(result.lossAllowance.toFixed(2)).toEqual('1042.52');
    expect(result.coverageOfEad.toFixed(10)).toEqual(
      result.lossAllowance.dividedBy(dec('100000')).toFixed(10),
    );
  });
});

describe('Discounting at the original effective interest rate', () => {
  it('reduces the allowance relative to the undiscounted zero-rate case', () => {
    const undiscounted = calculateExposureEcl(
      exposure(),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    const discounted = calculateExposureEcl(
      exposure({ effectiveInterestRate: '0.18' }),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );

    expect(discounted.effectiveInterestRate.toFixed(4)).toEqual('0.1800');
    expect(discounted.discountConvention).toEqual('END_PERIOD');
    expect(discounted.lossAllowance.lessThan(undiscounted.lossAllowance)).toBe(true);
    for (const period of discounted.scenarioResults[0].periods) {
      expect(period.discountFactor.greaterThan(zero())).toBe(true);
      expect(period.discountFactor.lessThan(dec(1))).toBe(true);
    }
  });

  it('produces a larger allowance under mid-period discounting', () => {
    const endPeriod = calculateExposureEcl(
      exposure({ effectiveInterestRate: '0.18' }),
      SINGLE_SCENARIO,
      DEFAULT_MODEL_CONFIGURATION,
    );
    const midPeriod = calculateExposureEcl(
      exposure({ effectiveInterestRate: '0.18' }),
      SINGLE_SCENARIO,
      { ...DEFAULT_MODEL_CONFIGURATION, discountConvention: 'MID_PERIOD' },
    );

    expect(midPeriod.discountConvention).toEqual('MID_PERIOD');
    expect(midPeriod.lossAllowance.greaterThan(endPeriod.lossAllowance)).toBe(true);
  });
});
