/**
 * Exception queue detection rules.
 *
 * Pure functions that decide whether an exposure, an override, a data-quality
 * issue or a run-over-run movement deserves a human look. Thresholds are
 * supplied by the caller (persisted model governance settings), never baked in.
 */
import { dec, zero, type DecValue } from './decimal';
import { detectNearStagingThreshold, type StagingInput, type StagingRuleSetConfig } from './staging';

export const EXCEPTION_KINDS = [
  'DATA_QUALITY',
  'ANALYST_OVERRIDE',
  'LARGE_ECL_CHANGE',
  'NEAR_STAGING_THRESHOLD',
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

export interface ExceptionCandidate {
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  exposureKey: string;
  title: string;
  detail: string;
  metric?: string;
}

export interface LargeEclChangeThresholds {
  /** Relative change (0.25 = 25%) that flags an exposure. */
  relativeChange: DecValue;
  /** Absolute change in currency units that flags an exposure regardless of ratio. */
  absoluteChange: DecValue;
  /** Changes below this absolute floor are ignored so tiny books do not spam the queue. */
  materialityFloor: DecValue;
}

export const DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS: LargeEclChangeThresholds = {
  relativeChange: '0.25',
  absoluteChange: '250000',
  materialityFloor: '1000',
};

/**
 * Flags an unusually large movement in an exposure's loss allowance between two
 * runs. A missing previous value (new exposure) is not an exception.
 */
export function detectLargeEclChange(
  exposureKey: string,
  currentAllowance: DecValue,
  previousAllowance: DecValue | null,
  thresholds: LargeEclChangeThresholds = DEFAULT_LARGE_ECL_CHANGE_THRESHOLDS,
): ExceptionCandidate | null {
  if (previousAllowance === null || previousAllowance === undefined) return null;

  const current = dec(currentAllowance);
  const previous = dec(previousAllowance);
  const floor = dec(thresholds.materialityFloor);
  const change = current.minus(previous);
  const magnitude = change.abs();

  if (magnitude.lessThan(floor)) return null;

  const relativeTrigger = dec(thresholds.relativeChange);
  const absoluteTrigger = dec(thresholds.absoluteChange);
  const relative = previous.isZero() ? (current.isZero() ? zero() : dec(Infinity)) : magnitude.dividedBy(previous.abs());

  const relativeBreached = previous.isZero()
    ? current.isZero()
      ? false
      : magnitude.greaterThan(absoluteTrigger)
    : relative.greaterThanOrEqualTo(relativeTrigger);
  const absoluteBreached = magnitude.greaterThanOrEqualTo(absoluteTrigger);

  if (!relativeBreached && !absoluteBreached) return null;

  const direction = change.greaterThan(zero()) ? 'increase' : 'decrease';
  const severity: ExceptionSeverity = absoluteBreached && relativeBreached ? 'HIGH' : 'MEDIUM';

  return {
    kind: 'LARGE_ECL_CHANGE',
    severity,
    exposureKey,
    title: `Loss allowance ${direction}d materially`,
    detail: `Allowance moved from ${previous.toFixed(2)} to ${current.toFixed(2)} (${change.greaterThan(zero()) ? '+' : ''}${change.toFixed(2)}, ${previous.isZero() ? 'n/a' : `${relative.times(100).toFixed(1)}%`} against triggers of ${relativeTrigger.times(100).toFixed(0)}% / ${absoluteTrigger.toFixed(0)}).`,
    metric: change.toFixed(2),
  };
}

/** Flags exposures sitting just below a staging threshold. */
export function detectNearThresholdExceptions(
  exposureKey: string,
  stagingInput: StagingInput,
  ruleSet: StagingRuleSetConfig,
): ExceptionCandidate[] {
  const signal = detectNearStagingThreshold(stagingInput, ruleSet);
  return signal.messages.map((message) => ({
    kind: 'NEAR_STAGING_THRESHOLD' as const,
    severity: (signal.nearStage3Dpd ? 'HIGH' : 'MEDIUM') as ExceptionSeverity,
    exposureKey,
    title: 'Close to a staging threshold',
    detail: message,
    metric: String(stagingInput.daysPastDue),
  }));
}

/** Every analyst override is reviewable by design. */
export function overrideException(
  exposureKey: string,
  override: { stageBefore: number; stageAfter: number; reason: string; actorName: string },
): ExceptionCandidate {
  return {
    kind: 'ANALYST_OVERRIDE',
    severity: 'HIGH',
    exposureKey,
    title: `Stage overridden ${override.stageBefore} → ${override.stageAfter}`,
    detail: `${override.actorName}: ${override.reason}`,
    metric: `Stage ${override.stageAfter}`,
  };
}

/** Quarantined import rows surface as data-quality exceptions. */
export function dataQualityException(
  exposureKey: string,
  issue: { field: string; code: string; message: string; severity: ExceptionSeverity },
): ExceptionCandidate {
  return {
    kind: 'DATA_QUALITY',
    severity: issue.severity,
    exposureKey,
    title: `Import issue on ${issue.field}`,
    detail: `${issue.code}: ${issue.message}`,
    metric: issue.field,
  };
}

/** Convenience type guard used by the API when persisting candidates. */
export function isExceptionKind(value: string): value is ExceptionKind {
  return (EXCEPTION_KINDS as readonly string[]).includes(value);
}
