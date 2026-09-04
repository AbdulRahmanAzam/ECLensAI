/**
 * Versioned model configuration.
 *
 * Every regulatory judgment and modelling assumption the engine relies on lives
 * here, not in code paths. The API persists a configuration as an immutable,
 * versioned row; a completed run stores the exact configuration it used so a
 * later edit can never rewrite history.
 */
import type { DiscountConvention } from './discount';
import type { StagingRuleSetConfig } from './staging';
import type { SimplifiedEadProfile } from './ead';

export interface EclModelConfigurationInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Staging thresholds and enabled rules. */
  stagingRuleSet: StagingRuleSetConfig;
  /** LGD bounds applied after scenario scaling. Decimals, e.g. 0.05 and 0.95. */
  lgdFloor: string;
  lgdCeiling: string;
  /** PD bounds applied before term-structure interpolation. */
  pdFloor: string;
  pdCeiling: string;
  /** Hard cap on the lifetime horizon, in months, for Stages 2 and 3. */
  lifetimeHorizonMonthsCap: number;
  /** Absolute cap on persisted calculation periods per exposure per scenario. */
  maxCalculationPeriods: number;
  /** Loss timing convention used for discounting. */
  discountConvention: DiscountConvention;
  /** Inclusive supported range for the effective interest rate. */
  effectiveInterestRateMin: string;
  effectiveInterestRateMax: string;
  /** CCF applied when the source row does not carry one. */
  defaultCreditConversionFactor: string;
  /** Simplified EAD profile used when no contractual schedule is supplied. */
  defaultSimplifiedEadProfile: SimplifiedEadProfile;
  /** Length of the near-term default window that defines 12-month ECL. */
  twelveMonthWindow: number;
  approvedBy?: string;
  approvedAt?: string;
}

/** Seeded staging rule set. Thresholds are regulatory backstops, not constants. */
export const DEFAULT_STAGING_RULE_SET: StagingRuleSetConfig = {
  id: 'srs-ifrs9-core',
  version: '1.0.0',
  stage3DpdThreshold: 90,
  stage2DpdThreshold: 30,
  ratingNotchSicrThreshold: 2,
  pdIncreaseSicrMultiple: 1.5,
  pdIncreaseSicrAbsoluteFloor: 0.005,
  nearThresholdDpdBufferDays: 5,
  nearThresholdPdBufferFraction: 0.1,
  enabledRules: [
    'DEFAULT_FLAG',
    'CREDIT_IMPAIRED_FLAG',
    'DPD_DEFAULT_BACKSTOP',
    'DPD_SICR_BACKSTOP',
    'RATING_DOWNGRADE_SICR',
    'PD_INCREASE_SICR',
    'FORBEARANCE_SICR',
    'RESTRUCTURING_SICR',
    'WATCHLIST_SICR',
  ],
};

export const DEFAULT_MODEL_CONFIGURATION: EclModelConfigurationInput = {
  id: 'mc-pkr-ifrs9',
  name: 'ECLens IFRS 9 core model (PKR)',
  version: '1.0.0',
  description:
    'Baseline IFRS 9 configuration: 90/30-day staging backstops, 2-notch rating SICR, 1.5x PD-increase SICR, end-period discounting at the original EIR, LGD bounded to [5%, 95%], lifetime horizon capped at 60 months.',
  stagingRuleSet: DEFAULT_STAGING_RULE_SET,
  lgdFloor: '0.05',
  lgdCeiling: '0.95',
  pdFloor: '0.0001',
  pdCeiling: '0.9999',
  lifetimeHorizonMonthsCap: 60,
  maxCalculationPeriods: 120,
  discountConvention: 'END_PERIOD',
  effectiveInterestRateMin: '-0.5',
  effectiveInterestRateMax: '5',
  defaultCreditConversionFactor: '0.5',
  defaultSimplifiedEadProfile: 'LINEAR_AMORTIZATION',
  twelveMonthWindow: 12,
  approvedBy: 'Model Risk Committee',
  approvedAt: '2026-07-01',
};

/**
 * The rounding policy, stated once and echoed in every result so a reviewer can
 * reconcile a portfolio total down to a single period without guessing.
 */
export const ROUNDING_POLICY = [
  'Each period expected loss = marginal PD x LGD x EAD x discount factor, computed at 40-digit decimal precision and rounded once to 2 decimal places (ROUND_HALF_UP).',
  'Scenario ECL = exact sum of the rounded period expected losses, so the displayed period table always adds to the displayed scenario total.',
  'Scenario weighted ECL = scenario ECL x scenario weight, rounded to 2 decimal places.',
  'Exposure loss allowance = exact sum of the rounded scenario weighted ECLs.',
  'Portfolio total = exact sum of exposure loss allowances. No further rounding is applied.',
].join(' ');
