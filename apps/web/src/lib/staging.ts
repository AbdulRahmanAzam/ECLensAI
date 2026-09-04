import type { StagingPrimaryCode, StagingRuleCode } from '@eclens/shared';

/**
 * Human-readable names for the engine's machine reason codes.
 *
 * The codes themselves are what get persisted and audited; these labels exist
 * only so a reviewer reading a staging decision is not decoding SCREAMING_SNAKE.
 */
export const STAGING_RULE_LABEL: Record<StagingRuleCode, string> = {
  DEFAULT_FLAG: 'Flagged as defaulted',
  CREDIT_IMPAIRED_FLAG: 'Flagged credit-impaired',
  DPD_DEFAULT_BACKSTOP: 'Days past due default backstop',
  DPD_SICR_BACKSTOP: 'Days past due SICR backstop',
  RATING_DOWNGRADE_SICR: 'Material rating downgrade',
  PD_INCREASE_SICR: 'PD increase since origination',
  FORBEARANCE_SICR: 'Forbearance granted',
  RESTRUCTURING_SICR: 'Restructured facility',
  WATCHLIST_SICR: 'On the watchlist',
};

export const STAGING_PRIMARY_LABEL: Record<string, string> = {
  ...STAGING_RULE_LABEL,
  NO_SICR_OBSERVED: 'No significant increase in credit risk',
  ANALYST_OVERRIDE: 'Analyst override in force',
};

export function stagingCodeLabel(code: StagingPrimaryCode | string): string {
  return STAGING_PRIMARY_LABEL[code] ?? code;
}

/** The 12-month ECL definition IFRS 9 actually requires, quoted verbatim on stage 1 rows. */
export const TWELVE_MONTH_ECL_NOTE =
  'Stage 1 recognizes 12-month ECL: the lifetime cash shortfall associated with default events that are possible in the next 12 months — not only shortfalls arising during those 12 months.';

export const LIFETIME_ECL_NOTE =
  'Stages 2 and 3 recognize lifetime ECL over the remaining contractual horizon, capped by the model configuration.';
