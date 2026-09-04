/**
 * required_tests[6], [7] and the domain half of [8].
 *
 *   [6] Boundary tests for 29, 30, 89 and 90 days past due, plus the same
 *       boundaries recomputed against a deliberately different rule set to
 *       prove the thresholds are configuration, not code.
 *   [7] Stage precedence when several rules fire at once.
 *   [8] Override authorization — the domain rules that make an override
 *       admissible, and the guarantee that an override never erases the model
 *       decision it overrode.
 */
import { describe, expect, it } from 'vitest';
import {
  assessStage,
  DEFAULT_STAGING_RULE_SET,
  detectNearStagingThreshold,
  evaluateStagingRules,
  NO_SICR_CODE,
  OVERRIDE_CODE,
  ratingNotchDistance,
  type Stage,
  type StageOverrideRecord,
  type StagingInput,
  type StagingRuleSetConfig,
} from '../src/index';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
};

/** A clean bill of health: no rule in the seeded set can fire on this input. */
const healthy = (overrides: Partial<StagingInput> = {}): StagingInput => ({
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

const ruleSet = (overrides: Partial<StagingRuleSetConfig> = {}): StagingRuleSetConfig => ({
  ...DEFAULT_STAGING_RULE_SET,
  ...overrides,
});

const codes = (input: StagingInput, config: StagingRuleSetConfig = DEFAULT_STAGING_RULE_SET): string[] =>
  evaluateStagingRules(input, config).map((rule) => rule.code);

describe('required_tests[6] — DPD boundaries against the seeded 30/90 thresholds', () => {
  it('keeps 29 days past due in Stage 1', () => {
    const decision = assessStage(healthy({ daysPastDue: 29 }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(1);
    expect(decision.modelStage).toEqual(1);
    expect(decision.triggeredRules).toEqual([]);
    expect(decision.primaryRuleCode).toEqual(NO_SICR_CODE);
  });

  it('moves 30 days past due to Stage 2 on the SICR backstop', () => {
    const decision = assessStage(healthy({ daysPastDue: 30 }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(2);
    expect(decision.primaryRuleCode).toEqual('DPD_SICR_BACKSTOP');
    expect(codes(healthy({ daysPastDue: 30 }))).toEqual(['DPD_SICR_BACKSTOP']);
    expect(decision.triggeredRules[0].sourceFields).toEqual(['daysPastDue']);
    expect(decision.triggeredRules[0].observedValue).toEqual('30');
    expect(decision.triggeredRules[0].configuredThreshold).toEqual('daysPastDue >= 30');
  });

  it('keeps 89 days past due in Stage 2, not Stage 3', () => {
    const decision = assessStage(healthy({ daysPastDue: 89 }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(2);
    expect(codes(healthy({ daysPastDue: 89 }))).toEqual(['DPD_SICR_BACKSTOP']);
  });

  it('moves 90 days past due to Stage 3 on the default backstop', () => {
    const decision = assessStage(healthy({ daysPastDue: 90 }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(3);
    // The SICR backstop is bounded above by the Stage 3 threshold, so only the
    // default backstop fires — no double counting of the same arrears.
    expect(codes(healthy({ daysPastDue: 90 }))).toEqual(['DPD_DEFAULT_BACKSTOP']);
    expect(decision.primaryReason).toContain('90-day default backstop');
  });

  it('recomputes every boundary when the thresholds are reconfigured', () => {
    const tighter = ruleSet({ stage2DpdThreshold: 15, stage3DpdThreshold: 60 });
    expect(assessStage(healthy({ daysPastDue: 14 }), tighter).stage).toEqual(1);
    expect(assessStage(healthy({ daysPastDue: 15 }), tighter).stage).toEqual(2);
    expect(assessStage(healthy({ daysPastDue: 30 }), tighter).stage).toEqual(2);
    expect(assessStage(healthy({ daysPastDue: 59 }), tighter).stage).toEqual(2);
    expect(assessStage(healthy({ daysPastDue: 60 }), tighter).stage).toEqual(3);
    // 90 days is Stage 3 under either rule set, but the reason quotes the
    // configured threshold rather than a hard-coded 90.
    expect(assessStage(healthy({ daysPastDue: 90 }), tighter).primaryReason).toContain(
      '60-day default backstop',
    );
  });

  it('turns a rule off entirely when it is removed from enabledRules', () => {
    const noDpdSicr = ruleSet({
      enabledRules: DEFAULT_STAGING_RULE_SET.enabledRules.filter(
        (code) => code !== 'DPD_SICR_BACKSTOP',
      ),
    });
    expect(assessStage(healthy({ daysPastDue: 45 }), noDpdSicr).stage).toEqual(1);
    // The Stage 3 backstop is a separate rule and still fires.
    expect(assessStage(healthy({ daysPastDue: 95 }), noDpdSicr).stage).toEqual(3);
  });

  it('rejects a rule set whose thresholds are internally inconsistent', () => {
    expect(codeOf(() => assessStage(healthy(), ruleSet({ stage2DpdThreshold: 90 })))).toEqual(
      'STAGING_RULE_SET_INVALID',
    );
    expect(codeOf(() => assessStage(healthy(), ruleSet({ stage3DpdThreshold: 0 })))).toEqual(
      'STAGING_RULE_SET_INVALID',
    );
    expect(codeOf(() => assessStage(healthy(), ruleSet({ pdIncreaseSicrMultiple: 1 })))).toEqual(
      'STAGING_RULE_SET_INVALID',
    );
    expect(
      codeOf(() =>
        assessStage(
          healthy(),
          ruleSet({
            enabledRules: [
              ...DEFAULT_STAGING_RULE_SET.enabledRules,
              'SOMETHING_ELSE',
            ] as typeof DEFAULT_STAGING_RULE_SET.enabledRules,
          }),
        ),
      ),
    ).toEqual('STAGING_RULE_SET_INVALID');
  });
});

describe('Stage 3 conditions', () => {
  it('assigns Stage 3 on the default flag', () => {
    const decision = assessStage(healthy({ defaultFlag: true }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(3);
    expect(decision.primaryRuleCode).toEqual('DEFAULT_FLAG');
  });

  it('assigns Stage 3 on the credit-impaired flag alone', () => {
    const decision = assessStage(healthy({ creditImpairedFlag: true }), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(3);
    expect(decision.primaryRuleCode).toEqual('CREDIT_IMPAIRED_FLAG');
  });
});

describe('Stage 2 SICR triggers', () => {
  it('counts rating notches along the configured scale', () => {
    expect(ratingNotchDistance('BBB', 'BBB')).toEqual(0);
    expect(ratingNotchDistance('BBB', 'BB')).toEqual(1);
    expect(ratingNotchDistance('BBB', 'B')).toEqual(2);
    expect(ratingNotchDistance('AAA', 'D')).toEqual(9);
    expect(ratingNotchDistance('B', 'BBB')).toEqual(-2);
    expect(ratingNotchDistance('BBB', 'NOT_A_RATING')).toEqual(0);
  });

  it('fires on a material rating downgrade at the configured notch threshold', () => {
    expect(codes(healthy({ originalCreditRating: 'BBB', currentCreditRating: 'BB' }))).toEqual([]);
    expect(codes(healthy({ originalCreditRating: 'BBB', currentCreditRating: 'B' }))).toEqual([
      'RATING_DOWNGRADE_SICR',
    ]);
    // A one-notch threshold makes the same downgrade material.
    expect(
      codes(
        healthy({ originalCreditRating: 'BBB', currentCreditRating: 'BB' }),
        ruleSet({ ratingNotchSicrThreshold: 1 }),
      ),
    ).toEqual(['RATING_DOWNGRADE_SICR']);
    // An upgrade never fires.
    expect(codes(healthy({ originalCreditRating: 'BB', currentCreditRating: 'BBB' }))).toEqual([]);
  });

  it('fires when the 12-month PD rises past the configured multiple and absolute floor', () => {
    // 0.01 -> 0.02 is a 2x rise above the 1.5x multiple and above the 0.5% floor.
    expect(codes(healthy({ pdAtOrigination: '0.01', currentPd: '0.02' }))).toEqual([
      'PD_INCREASE_SICR',
    ]);
    // 1.4x is below the multiple.
    expect(codes(healthy({ pdAtOrigination: '0.01', currentPd: '0.014' }))).toEqual([]);
    // 4x, but the absolute PD is still below the floor: a low-PD borrower moving
    // from 0.1% to 0.4% is not a significant increase in credit risk.
    expect(codes(healthy({ pdAtOrigination: '0.001', currentPd: '0.004' }))).toEqual([]);
    // A zero PD at origination cannot produce a ratio and must not divide by zero.
    expect(codes(healthy({ pdAtOrigination: '0', currentPd: '0.5' }))).toEqual([]);
  });

  it('fires on forbearance, restructuring and watchlist status independently', () => {
    expect(codes(healthy({ forbearanceFlag: true }))).toEqual(['FORBEARANCE_SICR']);
    expect(codes(healthy({ restructuringFlag: true }))).toEqual(['RESTRUCTURING_SICR']);
    expect(codes(healthy({ watchlistFlag: true }))).toEqual(['WATCHLIST_SICR']);
    expect(assessStage(healthy({ forbearanceFlag: true }), DEFAULT_STAGING_RULE_SET).stage).toEqual(2);
  });

  it('leaves a clean exposure in Stage 1', () => {
    const decision = assessStage(healthy(), DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(1);
    expect(decision.primaryReason).toEqual(
      'No significant increase in credit risk observed since origination',
    );
    expect(decision.hasOverride).toBe(false);
    expect(decision.override).toBeNull();
  });
});

describe('required_tests[7] — stage precedence when multiple rules trigger', () => {
  const input = healthy({
    daysPastDue: 45,
    defaultFlag: true,
    watchlistFlag: true,
    originalCreditRating: 'BBB',
    currentCreditRating: 'B',
  });

  it('reports every rule that fired, highest stage first', () => {
    const rules = evaluateStagingRules(input, DEFAULT_STAGING_RULE_SET);
    expect(rules.map((rule) => rule.code)).toEqual([
      'DEFAULT_FLAG',
      'DPD_SICR_BACKSTOP',
      'RATING_DOWNGRADE_SICR',
      'WATCHLIST_SICR',
    ]);
    expect(rules.map((rule) => rule.stage)).toEqual([3, 2, 2, 2]);
    const stages = rules.map((rule) => rule.stage);
    expect(stages).toEqual([...stages].sort((a, b) => b - a));
  });

  it('resolves to Stage 3 while keeping the Stage 2 evidence visible', () => {
    const decision = assessStage(input, DEFAULT_STAGING_RULE_SET);
    expect(decision.stage).toEqual(3);
    expect(decision.modelStage).toEqual(3);
    expect(decision.primaryRuleCode).toEqual('DEFAULT_FLAG');
    expect(decision.triggeredRules.some((rule) => rule.stage === 2)).toBe(true);
  });

  it('prefers Stage 2 over Stage 1 when only SICR evidence exists', () => {
    const decision = assessStage(
      healthy({ daysPastDue: 45, watchlistFlag: true }),
      DEFAULT_STAGING_RULE_SET,
    );
    expect(decision.stage).toEqual(2);
    expect(decision.triggeredRules.map((rule) => rule.code)).toEqual([
      'DPD_SICR_BACKSTOP',
      'WATCHLIST_SICR',
    ]);
  });

  it('stamps the rule set identity and version on every decision', () => {
    const versioned = ruleSet({ id: 'srs-tight', version: '2.1.0' });
    const decision = assessStage(healthy({ daysPastDue: 45 }), versioned);
    expect(decision.ruleSetId).toEqual('srs-tight');
    expect(decision.ruleSetVersion).toEqual('2.1.0');
  });
});

describe('required_tests[8] — analyst override authorization', () => {
  const authorized = (overrides: Partial<StageOverrideRecord> = {}): StageOverrideRecord => ({
    stageBefore: 1,
    stageAfter: 3,
    reason: 'Borrower entered court-supervised insolvency after the reporting date.',
    actorId: 'usr-analyst-1',
    actorName: 'Ayesha Kazmi',
    occurredAt: '2026-08-31T09:15:00.000Z',
    reviewerStatus: 'PENDING_REVIEW',
    ...overrides,
  });

  it('applies an authorized override and reports it as one', () => {
    const decision = assessStage(healthy(), DEFAULT_STAGING_RULE_SET, authorized());
    expect(decision.stage).toEqual(3);
    expect(decision.hasOverride).toBe(true);
    expect(decision.primaryRuleCode).toEqual(OVERRIDE_CODE);
    expect(decision.primaryReason).toMatch(/^Analyst override: /);
    expect(decision.override?.actorName).toEqual('Ayesha Kazmi');
  });

  it('never erases the model decision the override replaced', () => {
    const decision = assessStage(
      healthy({ watchlistFlag: true }),
      DEFAULT_STAGING_RULE_SET,
      authorized({ stageBefore: 2, stageAfter: 1 }),
    );
    expect(decision.stage).toEqual(1);
    expect(decision.modelStage).toEqual(2);
    expect(decision.triggeredRules.map((rule) => rule.code)).toEqual(['WATCHLIST_SICR']);
  });

  it.each([
    ['a reason shorter than ten characters', authorized({ reason: 'too short' })],
    ['an empty reason', authorized({ reason: '   ' })],
    ['no actor id', authorized({ actorId: '' })],
    ['no actor name', authorized({ actorName: '' })],
    ['no timestamp', authorized({ occurredAt: '' })],
    ['no reviewer status', authorized({ reviewerStatus: '' as never })],
    ['a stage outside 1..3', authorized({ stageAfter: 4 as Stage })],
  ])('refuses an override with %s', (_label, override) => {
    expect(codeOf(() => assessStage(healthy(), DEFAULT_STAGING_RULE_SET, override))).toEqual(
      'OVERRIDE_INCOMPLETE',
    );
  });

  it('treats a null override as no override at all', () => {
    const decision = assessStage(healthy(), DEFAULT_STAGING_RULE_SET, null);
    expect(decision.hasOverride).toBe(false);
    expect(decision.stage).toEqual(decision.modelStage);
  });
});

describe('detectNearStagingThreshold — the exception-queue signal', () => {
  it('flags arrears inside the configured buffer below each backstop', () => {
    expect(detectNearStagingThreshold(healthy({ daysPastDue: 87 }), DEFAULT_STAGING_RULE_SET))
      .toMatchObject({ nearStage3Dpd: true, nearStage2Dpd: false });
    expect(detectNearStagingThreshold(healthy({ daysPastDue: 27 }), DEFAULT_STAGING_RULE_SET))
      .toMatchObject({ nearStage2Dpd: true, nearStage3Dpd: false });
  });

  it('does not flag an exposure that has already crossed the threshold', () => {
    const signal = detectNearStagingThreshold(healthy({ daysPastDue: 90 }), DEFAULT_STAGING_RULE_SET);
    expect(signal.nearStage3Dpd).toBe(false);
    expect(signal.messages).toEqual([]);
  });

  it('flags a PD ratio just under the SICR multiple', () => {
    // 1.44x against a 1.5x trigger is inside the 10% buffer (lower bound 1.35x).
    const near = detectNearStagingThreshold(
      healthy({ pdAtOrigination: '0.01', currentPd: '0.0144' }),
      DEFAULT_STAGING_RULE_SET,
    );
    expect(near.nearPdIncreaseTrigger).toBe(true);
    expect(near.messages[0]).toContain('1.5x SICR trigger');

    const far = detectNearStagingThreshold(
      healthy({ pdAtOrigination: '0.01', currentPd: '0.011' }),
      DEFAULT_STAGING_RULE_SET,
    );
    expect(far.nearPdIncreaseTrigger).toBe(false);
  });

  it('emits a human-readable message for every signal it raises', () => {
    const signal = detectNearStagingThreshold(healthy({ daysPastDue: 88 }), DEFAULT_STAGING_RULE_SET);
    expect(signal.messages).toHaveLength(1);
    expect(signal.messages[0]).toContain('88 days past due');
    expect(signal.messages[0]).toContain('90-day Stage 3 backstop');
  });
});
