/**
 * Exposure-at-default schedules.
 *
 * EAD(period) = drawn balance(period) + credit conversion factor x undrawn
 * commitment(period). When the institution supplies a contractual amortization
 * schedule its period balances are authoritative. When it does not, a clearly
 * labelled simplified balance profile is generated instead — the label travels
 * with the result so no reader mistakes an assumption for contract data.
 */
import { dec, zero, type Dec, type DecValue } from './decimal';
import { engineError } from './errors';

export const EAD_PROFILE_KINDS = [
  'CONTRACTUAL_SCHEDULE',
  'SIMPLIFIED_LINEAR_AMORTIZATION',
  'SIMPLIFIED_FLAT_BALANCE',
] as const;

export type EadProfileKind = (typeof EAD_PROFILE_KINDS)[number];

export const SIMPLIFIED_EAD_PROFILES = ['LINEAR_AMORTIZATION', 'FLAT'] as const;
export type SimplifiedEadProfile = (typeof SIMPLIFIED_EAD_PROFILES)[number];

export interface EadSchedulePointInput {
  period: number;
  drawnBalance: DecValue;
  undrawnCommitment: DecValue;
}

export interface EadPeriodPoint {
  period: number;
  drawnBalance: Dec;
  undrawnCommitment: Dec;
  creditConversionFactor: Dec;
  ead: Dec;
}

export interface EadSchedule {
  kind: EadProfileKind;
  /** Human-readable provenance shown next to every period row in the UI. */
  label: string;
  points: EadPeriodPoint[];
  /** True when a contractual schedule was shorter than the horizon and had to be extended. */
  extendedFlatBeyondSchedule: boolean;
}

export function validateCreditConversionFactor(ccf: DecValue): Dec {
  const value = dec(ccf);
  if (!value.isFinite() || value.lessThan(zero()) || value.greaterThan(dec(1))) {
    throw engineError('CCF_OUT_OF_RANGE', 'Credit conversion factor must be between 0 and 1', [
      { field: 'creditConversionFactor', observed: value.toString(), expected: '0 <= ccf <= 1' },
    ]);
  }
  return value;
}

const assertNonNegativeAmount = (value: Dec, field: string): Dec => {
  if (!value.isFinite() || value.lessThan(zero())) {
    throw engineError('EAD_NEGATIVE', `${field} cannot be negative`, [
      { field, observed: value.toString(), expected: '>= 0' },
    ]);
  }
  return value;
};

/** EAD = drawn + CCF x undrawn. The core commitment-conversion identity. */
export function periodEad(drawn: DecValue, undrawn: DecValue, ccf: DecValue): Dec {
  const drawnDec = assertNonNegativeAmount(dec(drawn), 'drawnBalance');
  const undrawnDec = assertNonNegativeAmount(dec(undrawn), 'undrawnCommitment');
  const ccfDec = validateCreditConversionFactor(ccf);
  return drawnDec.plus(ccfDec.times(undrawnDec));
}

/**
 * Builds a period-by-period EAD schedule.
 *
 * - `contractualSchedule` wins when present. If it covers fewer periods than the
 *   calculation horizon the final balance is held flat for the remainder and
 *   `extendedFlatBeyondSchedule` is set, so the extension is visible rather
 *   than silent.
 * - Otherwise a simplified profile is generated: `LINEAR_AMORTIZATION` runs the
 *   drawn balance straight-line to zero over the horizon; `FLAT` holds it
 *   constant. Undrawn commitment is held flat in both cases.
 */
export function buildEadSchedule(options: {
  periods: number;
  grossCarryingAmount: DecValue;
  undrawnCommitment: DecValue;
  creditConversionFactor: DecValue;
  contractualSchedule?: EadSchedulePointInput[] | null;
  simplifiedProfile?: SimplifiedEadProfile;
}): EadSchedule {
  const periods = options.periods;
  if (!Number.isInteger(periods) || periods < 1) {
    throw engineError('INVALID_HORIZON', 'EAD schedule needs at least one period', [
      { field: 'periods', observed: String(periods), expected: '>= 1' },
    ]);
  }

  const gross = assertNonNegativeAmount(dec(options.grossCarryingAmount), 'grossCarryingAmount');
  const undrawn = assertNonNegativeAmount(dec(options.undrawnCommitment), 'undrawnCommitment');
  const ccf = validateCreditConversionFactor(options.creditConversionFactor);

  const makePoint = (period: number, drawnBalance: Dec, undrawnCommitment: Dec): EadPeriodPoint => ({
    period,
    drawnBalance,
    undrawnCommitment,
    creditConversionFactor: ccf,
    ead: drawnBalance.plus(ccf.times(undrawnCommitment)),
  });

  if (options.contractualSchedule && options.contractualSchedule.length > 0) {
    const sorted = [...options.contractualSchedule].sort((a, b) => a.period - b.period);
    sorted.forEach((point, index) => {
      if (!Number.isInteger(point.period) || point.period !== index + 1) {
        throw engineError(
          'PD_TERM_STRUCTURE_GAPS',
          'Repayment schedule periods must be 1..n with no gaps',
          [
            { field: 'period', observed: String(point.period), expected: String(index + 1) },
          ],
        );
      }
    });

    const points: EadPeriodPoint[] = [];
    for (let period = 1; period <= periods; period += 1) {
      const source = sorted[period - 1] ?? sorted[sorted.length - 1];
      points.push(makePoint(period, dec(source.drawnBalance), dec(source.undrawnCommitment)));
    }
    return {
      kind: 'CONTRACTUAL_SCHEDULE',
      label: 'Contractual amortization schedule supplied by the source system',
      points,
      extendedFlatBeyondSchedule: sorted.length < periods,
    };
  }

  const profile = options.simplifiedProfile ?? 'LINEAR_AMORTIZATION';
  const points: EadPeriodPoint[] = [];
  for (let period = 1; period <= periods; period += 1) {
    const drawnBalance =
      profile === 'FLAT'
        ? gross
        : gross.times(dec(periods - period + 1)).dividedBy(dec(periods));
    points.push(makePoint(period, drawnBalance, undrawn));
  }

  return {
    kind: profile === 'FLAT' ? 'SIMPLIFIED_FLAT_BALANCE' : 'SIMPLIFIED_LINEAR_AMORTIZATION',
    label:
      profile === 'FLAT'
        ? 'Simplified flat balance profile — no contractual amortization schedule supplied'
        : 'Simplified straight-line amortization profile — no contractual amortization schedule supplied',
    points,
    extendedFlatBeyondSchedule: false,
  };
}
