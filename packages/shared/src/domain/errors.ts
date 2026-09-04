/**
 * Typed engine errors.
 *
 * Every failure mode the engine can hit has a stable machine-readable code so
 * the API can surface it as a validation issue and the UI can explain it,
 * instead of leaking a generic 500 or silently repairing the input.
 */

export type EngineErrorCode =
  | 'INVALID_EFFECTIVE_INTEREST_RATE'
  | 'INVALID_DATE_RANGE'
  | 'INVALID_HORIZON'
  | 'PD_TERM_STRUCTURE_EMPTY'
  | 'PD_TERM_STRUCTURE_GAPS'
  | 'PD_NEGATIVE'
  | 'PD_CUMULATIVE_EXCEEDS_ONE'
  | 'PD_CUMULATIVE_NOT_MONOTONIC'
  | 'PD_TERM_STRUCTURE_INCONSISTENT'
  | 'EAD_NEGATIVE'
  | 'CCF_OUT_OF_RANGE'
  | 'LGD_OUT_OF_RANGE'
  | 'SCENARIO_SET_EMPTY'
  | 'SCENARIO_CODE_DUPLICATE'
  | 'SCENARIO_WEIGHT_NEGATIVE'
  | 'SCENARIO_WEIGHTS_NOT_NORMALIZED'
  | 'SCENARIO_FACTOR_INVALID'
  | 'STAGING_RULE_SET_INVALID'
  | 'OVERRIDE_INCOMPLETE';

export interface EngineErrorDetail {
  field?: string;
  observed?: string;
  expected?: string;
}

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
    public readonly details: EngineErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export const engineError = (
  code: EngineErrorCode,
  message: string,
  details: EngineErrorDetail[] = [],
): EngineError => new EngineError(code, message, details);
