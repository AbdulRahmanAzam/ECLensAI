/**
 * IFRS 9 staging engine — configurable, versioned, fully explainable.
 *
 * Pure module: no Express, no database, no I/O. Every decision returns the
 * stage, the primary reason, *all* triggered rules with the source fields and
 * configured threshold that drove them, the rule-set version, and whether an
 * authorized analyst override is in force.
 *
 * Regulatory judgments live in `StagingRuleSetConfig` (persisted and versioned
 * by the API), never hard-coded here.
 */
import { dec, type Dec, type DecValue } from './decimal';
import { engineError } from './errors';
import type { Stage } from '../types';

/** Stable machine-readable reason codes. Persisted and shown in the UI. */
export const STAGING_RULE_CODES = [
  'DEFAULT_FLAG',
  'CREDIT_IMPAIRED_FLAG',
  'DPD_DEFAULT_BACKSTOP',
  'DPD_SICR_BACKSTOP',
  'RATING_DOWNGRADE_SICR',
  'PD_INCREASE_SICR',
  'FORBEARANCE_SICR',
  'RESTRUCTURING_SICR',
  'WATCHLIST_SICR',
] as const;

export type StagingRuleCode = (typeof STAGING_RULE_CODES)[number];

/** Which stage each rule can assign. Drives precedence. */
export const RULE_STAGE: Record<StagingRuleCode, Stage> = {
  DEFAULT_FLAG: 3,
  CREDIT_IMPAIRED_FLAG: 3,
  DPD_DEFAULT_BACKSTOP: 3,
  DPD_SICR_BACKSTOP: 2,
  RATING_DOWNGRADE_SICR: 2,
  PD_INCREASE_SICR: 2,
  FORBEARANCE_SICR: 2,
  RESTRUCTURING_SICR: 2,
  WATCHLIST_SICR: 2,
};

export const NO_SICR_CODE = 'NO_SICR_OBSERVED' as const;
export const OVERRIDE_CODE = 'ANALYST_OVERRIDE' as const;
export type StagingPrimaryCode = StagingRuleCode | typeof NO_SICR_CODE | typeof OVERRIDE_CODE;

/** Internal rating scale, best → worst. Notch distance = index(to) - index(from). */
export const RATING_ORDER = [
  'AAA',
  'AA',
  'A',
  'BBB',
  'BB',
  'B',
  'CCC',
  'CC',
  'C',
  'D',
] as const;

/**
 * Configurable thresholds and the explicit allow-list of enabled rules.
 * Serialized as JSON by the API so it can be versioned and locked per run.
 */
export interface StagingRuleSetConfig {
  id: string;
  version: string;
  /** Days past due that alone implies credit impairment. Seeded at 90. */
  stage3DpdThreshold: number;
  /** Days past due that alone implies a significant increase in credit risk. Seeded at 30. */
  stage2DpdThreshold: number;
  /** Rating notches of downgrade since origination treated as SICR. */
  ratingNotchSicrThreshold: number;
  /** Current PD >= origination PD x multiple is treated as SICR. */
  pdIncreaseSicrMultiple: number;
  /** Absolute PD floor below which the multiple test is not applied (avoids 0.1% -> 0.2% noise). */
  pdIncreaseSicrAbsoluteFloor: number;
  /** DPD within this many days below a threshold lands on the exception queue. */
  nearThresholdDpdBufferDays: number;
  /** PD multiple within this fraction of the trigger lands on the exception queue. */
  nearThresholdPdBufferFraction: number;
  /** Rules an institution has switched on. Anything absent is not evaluated. */
  enabledRules: StagingRuleCode[];
}

export interface StagingInput {
  daysPastDue: number;
  defaultFlag: boolean;
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  originalCreditRating: string;
  currentCreditRating: string;
  /** 12-month PD at origination, decimal. */
  pdAtOrigination: DecValue;
  /** Current 12-month PD, decimal. */
  currentPd: DecValue;
}

export interface TriggeredStagingRule {
  code: StagingRuleCode;
  stage: Stage;
  reason: string;
  sourceFields: string[];
  observedValue: string;
  configuredThreshold: string;
}

export type OverrideReviewerStatus = 'PENDING_REVIEW' | 'REVIEWED' | 'REJECTED';

/**
 * An authorized analyst override. Requires a reason, before/after values, the
 * actor, a timestamp and a reviewer status — the engine refuses an override
 * missing any of them.
 */
export interface StageOverrideRecord {
  stageBefore: Stage;
  stageAfter: Stage;
  reason: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  reviewerStatus: OverrideReviewerStatus;
  reviewerName?: string | null;
  reviewedAt?: string | null;
}

export interface StagingDecision {
  stage: Stage;
  /** Stage produced by the rules alone, before any override. */
  modelStage: Stage;
  primaryReason: string;
  primaryRuleCode: StagingPrimaryCode;
  /** Every rule that fired, ordered Stage 3 first then Stage 2. */
  triggeredRules: TriggeredStagingRule[];
  ruleSetId: string;
  ruleSetVersion: string;
  hasOverride: boolean;
  override: StageOverrideRecord | null;
}

/** Positive result means `to` is worse than `from` by that many notches. */
export function ratingNotchDistance(from: string, to: string): number {
  const order = RATING_ORDER as readonly string[];
  const fromIndex = order.indexOf(from.trim().toUpperCase() as (typeof RATING_ORDER)[number]);
  const toIndex = order.indexOf(to.trim().toUpperCase() as (typeof RATING_ORDER)[number]);
  if (fromIndex < 0 || toIndex < 0) return 0;
  return toIndex - fromIndex;
}

function assertRuleSet(config: StagingRuleSetConfig): void {
  if (!config.id || !config.version) {
    throw engineError('STAGING_RULE_SET_INVALID', 'Staging rule set requires an id and a version');
  }
  if (!Number.isInteger(config.stage3DpdThreshold) || config.stage3DpdThreshold <= 0) {
    throw engineError('STAGING_RULE_SET_INVALID', 'stage3DpdThreshold must be a positive integer', [
      { field: 'stage3DpdThreshold', observed: String(config.stage3DpdThreshold) },
    ]);
  }
  if (!Number.isInteger(config.stage2DpdThreshold) || config.stage2DpdThreshold < 0) {
    throw engineError('STAGING_RULE_SET_INVALID', 'stage2DpdThreshold must be a non-negative integer', [
      { field: 'stage2DpdThreshold', observed: String(config.stage2DpdThreshold) },
    ]);
  }
  if (config.stage2DpdThreshold >= config.stage3DpdThreshold) {
    throw engineError(
      'STAGING_RULE_SET_INVALID',
      'stage2DpdThreshold must be strictly lower than stage3DpdThreshold',
      [
        {
          field: 'stage2DpdThreshold',
          observed: String(config.stage2DpdThreshold),
          expected: `< ${config.stage3DpdThreshold}`,
        },
      ],
    );
  }
  if (!Number.isInteger(config.ratingNotchSicrThreshold) || config.ratingNotchSicrThreshold < 1) {
    throw engineError(
      'STAGING_RULE_SET_INVALID',
      'ratingNotchSicrThreshold must be an integer >= 1',
    );
  }
  if (!(config.pdIncreaseSicrMultiple > 1)) {
    throw engineError('STAGING_RULE_SET_INVALID', 'pdIncreaseSicrMultiple must be greater than 1');
  }
  const unknown = config.enabledRules.filter(
    (code) => !(STAGING_RULE_CODES as readonly string[]).includes(code),
  );
  if (unknown.length > 0) {
    throw engineError('STAGING_RULE_SET_INVALID', `Unknown staging rule codes: ${unknown.join(', ')}`);
  }
}

const pct = (value: Dec): string => `${value.times(100).toFixed(2)}%`;

/**
 * Evaluates every enabled rule and resolves the stage by precedence:
 * any Stage 3 rule → Stage 3, else any Stage 2 rule → Stage 2, else Stage 1.
 * Lower-priority rules still fire and are reported, so a Stage 3 exposure also
 * shows the SICR evidence that had already accumulated.
 */
export function evaluateStagingRules(
  input: StagingInput,
  config: StagingRuleSetConfig,
): TriggeredStagingRule[] {
  assertRuleSet(config);
  const enabled = new Set(config.enabledRules);
  const triggered: TriggeredStagingRule[] = [];
  const push = (rule: TriggeredStagingRule): void => {
    if (enabled.has(rule.code)) triggered.push(rule);
  };

  if (input.defaultFlag) {
    push({
      code: 'DEFAULT_FLAG',
      stage: 3,
      reason: 'Exposure meets the institution\'s definition of default',
      sourceFields: ['defaultFlag'],
      observedValue: 'true',
      configuredThreshold: 'defaultFlag = true',
    });
  }

  if (input.creditImpairedFlag) {
    push({
      code: 'CREDIT_IMPAIRED_FLAG',
      stage: 3,
      reason: 'Exposure is flagged credit-impaired (objective evidence of impairment)',
      sourceFields: ['creditImpairedFlag'],
      observedValue: 'true',
      configuredThreshold: 'creditImpairedFlag = true',
    });
  }

  if (input.daysPastDue >= config.stage3DpdThreshold) {
    push({
      code: 'DPD_DEFAULT_BACKSTOP',
      stage: 3,
      reason: `${input.daysPastDue} days past due meets the ${config.stage3DpdThreshold}-day default backstop`,
      sourceFields: ['daysPastDue'],
      observedValue: String(input.daysPastDue),
      configuredThreshold: `daysPastDue >= ${config.stage3DpdThreshold}`,
    });
  }

  if (input.daysPastDue >= config.stage2DpdThreshold && input.daysPastDue < config.stage3DpdThreshold) {
    push({
      code: 'DPD_SICR_BACKSTOP',
      stage: 2,
      reason: `${input.daysPastDue} days past due meets the ${config.stage2DpdThreshold}-day SICR backstop`,
      sourceFields: ['daysPastDue'],
      observedValue: String(input.daysPastDue),
      configuredThreshold: `daysPastDue >= ${config.stage2DpdThreshold}`,
    });
  }

  const notches = ratingNotchDistance(input.originalCreditRating, input.currentCreditRating);
  if (notches >= config.ratingNotchSicrThreshold) {
    push({
      code: 'RATING_DOWNGRADE_SICR',
      stage: 2,
      reason: `Internal rating downgraded ${notches} notch(es) since origination (${input.originalCreditRating} → ${input.currentCreditRating})`,
      sourceFields: ['originalCreditRating', 'currentCreditRating'],
      observedValue: String(notches),
      configuredThreshold: `ratingNotchDistance >= ${config.ratingNotchSicrThreshold}`,
    });
  }

  const pdOrigination = dec(input.pdAtOrigination);
  const pdCurrent = dec(input.currentPd);
  const pdMultiple = config.pdIncreaseSicrMultiple;
  const absoluteFloor = dec(config.pdIncreaseSicrAbsoluteFloor);
  if (pdOrigination.greaterThan(0) && pdCurrent.greaterThanOrEqualTo(absoluteFloor)) {
    const ratio = pdCurrent.dividedBy(pdOrigination);
    if (ratio.greaterThanOrEqualTo(dec(pdMultiple))) {
      push({
        code: 'PD_INCREASE_SICR',
        stage: 2,
        reason: `12-month PD rose from ${pct(pdOrigination)} at origination to ${pct(pdCurrent)} (${ratio.toFixed(2)}x)`,
        sourceFields: ['pdAtOrigination', 'currentPd'],
        observedValue: ratio.toFixed(4),
        configuredThreshold: `currentPd / pdAtOrigination >= ${pdMultiple}`,
      });
    }
  }

  if (input.forbearanceFlag) {
    push({
      code: 'FORBEARANCE_SICR',
      stage: 2,
      reason: 'Concessional forbearance granted to the borrower',
      sourceFields: ['forbearanceFlag'],
      observedValue: 'true',
      configuredThreshold: 'forbearanceFlag = true',
    });
  }

  if (input.restructuringFlag) {
    push({
      code: 'RESTRUCTURING_SICR',
      stage: 2,
      reason: 'Exposure has been restructured (terms modified due to borrower distress)',
      sourceFields: ['restructuringFlag'],
      observedValue: 'true',
      configuredThreshold: 'restructuringFlag = true',
    });
  }

  if (input.watchlistFlag) {
    push({
      code: 'WATCHLIST_SICR',
      stage: 2,
      reason: 'Exposure is on the early-warning watchlist',
      sourceFields: ['watchlistFlag'],
      observedValue: 'true',
      configuredThreshold: 'watchlistFlag = true',
    });
  }

  return triggered.sort((a, b) => b.stage - a.stage);
}

function assertOverride(override: StageOverrideRecord): void {
  if (!override.reason || override.reason.trim().length < 10) {
    throw engineError('OVERRIDE_INCOMPLETE', 'A stage override requires a written reason (>= 10 characters)', [
      { field: 'reason', observed: override.reason ?? '' },
    ]);
  }
  if (!override.actorId || !override.actorName) {
    throw engineError('OVERRIDE_INCOMPLETE', 'A stage override requires an actor', [
      { field: 'actorId', observed: override.actorId ?? '' },
    ]);
  }
  if (!override.occurredAt) {
    throw engineError('OVERRIDE_INCOMPLETE', 'A stage override requires a timestamp', [
      { field: 'occurredAt', observed: '' },
    ]);
  }
  if (!override.reviewerStatus) {
    throw engineError('OVERRIDE_INCOMPLETE', 'A stage override requires a reviewer status', [
      { field: 'reviewerStatus', observed: '' },
    ]);
  }
  if (!([1, 2, 3] as Stage[]).includes(override.stageAfter)) {
    throw engineError('OVERRIDE_INCOMPLETE', 'stageAfter must be 1, 2 or 3', [
      { field: 'stageAfter', observed: String(override.stageAfter) },
    ]);
  }
}

/**
 * Full staging decision, including an optional authorized analyst override.
 * The override changes the reported stage but never erases the model decision:
 * `modelStage` and every triggered rule remain in the result.
 */
export function assessStage(
  input: StagingInput,
  config: StagingRuleSetConfig,
  override?: StageOverrideRecord | null,
): StagingDecision {
  const triggeredRules = evaluateStagingRules(input, config);
  const modelStage: Stage = triggeredRules.some((rule) => rule.stage === 3)
    ? 3
    : triggeredRules.some((rule) => rule.stage === 2)
      ? 2
      : 1;

  const base: StagingDecision = {
    stage: modelStage,
    modelStage,
    primaryReason:
      modelStage === 1
        ? 'No significant increase in credit risk observed since origination'
        : (triggeredRules.find((rule) => rule.stage === modelStage)?.reason ??
          'Staging rule triggered'),
    primaryRuleCode:
      modelStage === 1
        ? NO_SICR_CODE
        : ((triggeredRules.find((rule) => rule.stage === modelStage)?.code ??
            NO_SICR_CODE) as StagingPrimaryCode),
    triggeredRules,
    ruleSetId: config.id,
    ruleSetVersion: config.version,
    hasOverride: false,
    override: null,
  };

  if (!override) return base;
  assertOverride(override);

  return {
    ...base,
    stage: override.stageAfter,
    primaryReason: `Analyst override: ${override.reason.trim()}`,
    primaryRuleCode: OVERRIDE_CODE,
    hasOverride: true,
    override,
  };
}

/**
 * Exception-queue signal: the exposure sits just below a staging threshold, so
 * a small data correction would move its stage.
 */
export interface NearThresholdSignal {
  nearStage3Dpd: boolean;
  nearStage2Dpd: boolean;
  nearPdIncreaseTrigger: boolean;
  messages: string[];
}

export function detectNearStagingThreshold(
  input: StagingInput,
  config: StagingRuleSetConfig,
): NearThresholdSignal {
  assertRuleSet(config);
  const messages: string[] = [];
  const buffer = config.nearThresholdDpdBufferDays;

  const nearStage3Dpd =
    input.daysPastDue < config.stage3DpdThreshold &&
    input.daysPastDue >= config.stage3DpdThreshold - buffer;
  if (nearStage3Dpd) {
    messages.push(
      `${input.daysPastDue} days past due is within ${buffer} day(s) of the ${config.stage3DpdThreshold}-day Stage 3 backstop`,
    );
  }

  const nearStage2Dpd =
    input.daysPastDue < config.stage2DpdThreshold &&
    input.daysPastDue >= config.stage2DpdThreshold - buffer;
  if (nearStage2Dpd) {
    messages.push(
      `${input.daysPastDue} days past due is within ${buffer} day(s) of the ${config.stage2DpdThreshold}-day Stage 2 backstop`,
    );
  }

  let nearPdIncreaseTrigger = false;
  const pdOrigination = dec(input.pdAtOrigination);
  const pdCurrent = dec(input.currentPd);
  if (pdOrigination.greaterThan(0) && pdCurrent.greaterThanOrEqualTo(dec(config.pdIncreaseSicrAbsoluteFloor))) {
    const ratio = pdCurrent.dividedBy(pdOrigination);
    const trigger = dec(config.pdIncreaseSicrMultiple);
    const lowerBound = trigger.times(dec(1).minus(dec(config.nearThresholdPdBufferFraction)));
    if (ratio.lessThan(trigger) && ratio.greaterThanOrEqualTo(lowerBound)) {
      nearPdIncreaseTrigger = true;
      messages.push(
        `12-month PD is ${ratio.toFixed(2)}x origination, within ${Math.round(
          config.nearThresholdPdBufferFraction * 100,
        )}% of the ${config.pdIncreaseSicrMultiple}x SICR trigger`,
      );
    }
  }

  return { nearStage3Dpd, nearStage2Dpd, nearPdIncreaseTrigger, messages };
}
