/**
 * required_tests[4] — discount-factor calculation.
 *
 * DF(t) = (1 + EIR)^(-years(t)) where years(t) = t/12 under END_PERIOD and
 * (t - 0.5)/12 under MID_PERIOD. Whole-year periods are exact integer powers,
 * so those are asserted to the digit; fractional periods go through ln/exp and
 * are asserted relationally instead of against a hand-typed decimal.
 */
import { describe, expect, it } from 'vitest';
import {
  dec,
  discountFactorForPeriod,
  discountingYears,
  isZeroRate,
  one,
  PERIODS_PER_YEAR,
  validateEffectiveInterestRate,
  zero,
} from '../src/index';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
};

describe('discountingYears', () => {
  it('treats period 12 as exactly one year under END_PERIOD', () => {
    expect(discountingYears(12, 'END_PERIOD').toString()).toEqual('1');
    expect(discountingYears(24, 'END_PERIOD').toString()).toEqual('2');
  });

  it('shifts period t back half a month under MID_PERIOD', () => {
    // (1 - 0.5) / 12 = 1/24
    expect(discountingYears(1, 'MID_PERIOD').toString()).toEqual(dec(1).dividedBy(24).toString());
    expect(discountingYears(12, 'MID_PERIOD').toString()).toEqual(dec('11.5').dividedBy(12).toString());
  });

  it('exposes the monthly grid the engine defaults to', () => {
    expect(PERIODS_PER_YEAR).toEqual(12);
  });

  it('rejects a non-positive or fractional period index', () => {
    expect(codeOf(() => discountingYears(0, 'END_PERIOD'))).toEqual('INVALID_HORIZON');
    expect(codeOf(() => discountingYears(-3, 'END_PERIOD'))).toEqual('INVALID_HORIZON');
    expect(codeOf(() => discountingYears(1.5, 'END_PERIOD'))).toEqual('INVALID_HORIZON');
  });
});

describe('discountFactorForPeriod', () => {
  it('is exactly 1 at a zero rate for every period and convention', () => {
    for (const period of [1, 6, 12, 60, 120]) {
      expect(discountFactorForPeriod('0', period, 'END_PERIOD').toString()).toEqual('1');
      expect(discountFactorForPeriod('0', period, 'MID_PERIOD').toString()).toEqual('1');
    }
    expect(isZeroRate(zero())).toBe(true);
    expect(isZeroRate(dec('0.0001'))).toBe(false);
  });

  it('gives DF(12) = 1/1.12 exactly at a 12% EIR under END_PERIOD', () => {
    // One whole year, so the exponent is an integer and the power is exact.
    expect(discountFactorForPeriod('0.12', 12, 'END_PERIOD').toFixed(20)).toEqual(
      '0.89285714285714285714',
    );
    expect(discountFactorForPeriod('0.12', 24, 'END_PERIOD').toFixed(20)).toEqual(
      dec('1.12').pow(-2).toFixed(20),
    );
  });

  it('declines monotonically with the period', () => {
    let previous = one();
    for (let period = 1; period <= 36; period += 1) {
      const df = discountFactorForPeriod('0.18', period, 'END_PERIOD');
      expect(df.lessThan(previous)).toBe(true);
      expect(df.greaterThan(zero())).toBe(true);
      previous = df;
    }
  });

  it('discounts less under MID_PERIOD than END_PERIOD for the same period', () => {
    for (const period of [1, 3, 12, 24]) {
      const mid = discountFactorForPeriod('0.18', period, 'MID_PERIOD');
      const end = discountFactorForPeriod('0.18', period, 'END_PERIOD');
      expect(mid.greaterThan(end)).toBe(true);
      expect(mid.lessThan(one())).toBe(true);
    }
  });

  it('brackets the fractional one-month factor between 1 and the one-year factor', () => {
    const oneMonth = discountFactorForPeriod('0.12', 1, 'END_PERIOD');
    const oneYear = discountFactorForPeriod('0.12', 12, 'END_PERIOD');
    expect(oneMonth.lessThan(one())).toBe(true);
    expect(oneMonth.greaterThan(oneYear)).toBe(true);
  });
});

describe('validateEffectiveInterestRate', () => {
  it('accepts rates inside the supported range', () => {
    expect(validateEffectiveInterestRate('0').toString()).toEqual('0');
    expect(validateEffectiveInterestRate('0.245').toString()).toEqual('0.245');
    expect(validateEffectiveInterestRate('-0.4').toString()).toEqual('-0.4');
  });

  it('rejects values that are not numbers', () => {
    expect(codeOf(() => validateEffectiveInterestRate('abc'))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
    expect(codeOf(() => validateEffectiveInterestRate(''))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
  });

  it('rejects non-finite values', () => {
    expect(codeOf(() => validateEffectiveInterestRate(Number.NaN))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
    expect(codeOf(() => validateEffectiveInterestRate(Number.POSITIVE_INFINITY))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
  });

  it('rejects a rate at or below -100%, where the discount base stops being positive', () => {
    expect(codeOf(() => validateEffectiveInterestRate('-1'))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
    expect(codeOf(() => validateEffectiveInterestRate('-2'))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
  });

  it('rejects fat-finger magnitudes outside the configured band', () => {
    expect(codeOf(() => validateEffectiveInterestRate('6'))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
    expect(codeOf(() => validateEffectiveInterestRate('0.6', { min: '0', max: '0.5' }))).toEqual(
      'INVALID_EFFECTIVE_INTEREST_RATE',
    );
    expect(validateEffectiveInterestRate('0.5', { min: '0', max: '0.5' }).toString()).toEqual('0.5');
  });
});
