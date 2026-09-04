/**
 * Discounting expected cash shortfalls at the effective interest rate.
 *
 * IFRS 9 requires the loss allowance to be the present value of expected cash
 * shortfalls discounted at the *original effective interest rate* (EIR), not a
 * risk-free or current market rate. Periods are monthly by default.
 *
 * Two timing conventions are supported and the choice is part of the versioned
 * model configuration:
 *   END_PERIOD — shortfall assumed at the end of period t:  DF = (1+EIR)^(-t/12)
 *   MID_PERIOD — shortfall assumed mid-period:             DF = (1+EIR)^(-(t-0.5)/12)
 */
import { dec, one, zero, type Dec, type DecValue } from './decimal';
import { engineError } from './errors';

export const DISCOUNT_CONVENTIONS = ['END_PERIOD', 'MID_PERIOD'] as const;
export type DiscountConvention = (typeof DISCOUNT_CONVENTIONS)[number];

/** Periods per year. Monthly calculation grids are the engine default. */
export const PERIODS_PER_YEAR = 12;

export interface EffectiveRateLimits {
  /** Inclusive lower bound. Must be > -1 so the discount base stays positive. */
  min: DecValue;
  /** Inclusive upper bound, e.g. 5 = 500% annual. Guards against fat-finger rates. */
  max: DecValue;
}

export const DEFAULT_EIR_LIMITS: EffectiveRateLimits = { min: '-0.5', max: '5' };

/**
 * Validates an effective interest rate before it is used anywhere.
 * Unsupported values (NaN, non-finite, base <= 0, absurd magnitudes) are
 * rejected loudly instead of producing a silent zero or negative allowance.
 */
export function validateEffectiveInterestRate(
  rate: DecValue,
  limits: EffectiveRateLimits = DEFAULT_EIR_LIMITS,
): Dec {
  let value: Dec;
  try {
    value = dec(rate);
  } catch {
    throw engineError('INVALID_EFFECTIVE_INTEREST_RATE', 'Effective interest rate is not a number', [
      { field: 'effectiveInterestRate', observed: String(rate) },
    ]);
  }
  if (!value.isFinite()) {
    throw engineError('INVALID_EFFECTIVE_INTEREST_RATE', 'Effective interest rate must be finite', [
      { field: 'effectiveInterestRate', observed: value.toString() },
    ]);
  }
  if (one().plus(value).lessThanOrEqualTo(zero())) {
    throw engineError(
      'INVALID_EFFECTIVE_INTEREST_RATE',
      'Effective interest rate must be greater than -100% so the discount base stays positive',
      [{ field: 'effectiveInterestRate', observed: value.toString(), expected: '> -1' }],
    );
  }
  const min = dec(limits.min);
  const max = dec(limits.max);
  if (value.lessThan(min) || value.greaterThan(max)) {
    throw engineError(
      'INVALID_EFFECTIVE_INTEREST_RATE',
      `Effective interest rate ${value.toString()} is outside the supported range [${min.toString()}, ${max.toString()}]`,
      [
        {
          field: 'effectiveInterestRate',
          observed: value.toString(),
          expected: `${min.toString()} <= eir <= ${max.toString()}`,
        },
      ],
    );
  }
  return value;
}

/** Years of discounting applied to a given period under the chosen convention. */
export function discountingYears(period: number, convention: DiscountConvention): Dec {
  if (!Number.isInteger(period) || period < 1) {
    throw engineError('INVALID_HORIZON', 'Period index must be a positive integer', [
      { field: 'period', observed: String(period), expected: '>= 1' },
    ]);
  }
  const offset = convention === 'MID_PERIOD' ? dec(period).minus(dec('0.5')) : dec(period);
  const years = offset.dividedBy(PERIODS_PER_YEAR);
  return years.lessThan(zero()) ? zero() : years;
}

/** DF(t) = (1 + EIR) ^ -years(t). */
export function discountFactorForPeriod(
  effectiveInterestRate: DecValue,
  period: number,
  convention: DiscountConvention = 'END_PERIOD',
  limits: EffectiveRateLimits = DEFAULT_EIR_LIMITS,
): Dec {
  const eir = validateEffectiveInterestRate(effectiveInterestRate, limits);
  const years = discountingYears(period, convention);
  return one().plus(eir).pow(years.negated());
}

/** A zero rate discounts to exactly 1 for every period — asserted in tests. */
export function isZeroRate(effectiveInterestRate: Dec): boolean {
  return effectiveInterestRate.isZero();
}
