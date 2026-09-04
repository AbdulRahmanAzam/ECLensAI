/**
 * Decimal arithmetic foundation for the ECL engine.
 *
 * Financial totals in ECLens are never computed with binary floating point.
 * Every probability, rate, factor and amount that reaches a persisted total is
 * an `EngineDecimal`. A dedicated `Decimal.clone()` is used so the engine owns
 * its precision and rounding configuration instead of mutating the global
 * Decimal.js settings of whatever process imports this package.
 */
import Decimal from 'decimal.js';

export const EngineDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

/** The decimal type used throughout the engine. */
export type Dec = Decimal;

/** Anything Decimal.js can accept: number, string, or another Decimal. */
export type DecValue = Decimal.Value;

/** Money is persisted and displayed to 2 decimal places (paisa / cents). */
export const MONEY_DP = 2;
/**
 * Probabilities, rates, factors and discount factors carry 10 decimal places.
 * Intermediate arithmetic keeps the full 40-digit precision above; rounding to
 * this scale happens only when a value is reported or persisted.
 */
export const RATE_DP = 10;

/** Tolerance used for "weights must total exactly 1" style decimal checks. */
export const WEIGHT_SUM_TOLERANCE = '0.000000001';

export const dec = (value: DecValue): Dec => new EngineDecimal(value);
export const zero = (): Dec => new EngineDecimal(0);
export const one = (): Dec => new EngineDecimal(1);

export const roundMoney = (value: Dec): Dec =>
  value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);

export const roundRate = (value: Dec): Dec =>
  value.toDecimalPlaces(RATE_DP, Decimal.ROUND_HALF_UP);

/** Plain, non-exponential string for money. Safe for JSON and Prisma Decimal. */
export const moneyToString = (value: Dec): string => roundMoney(value).toFixed(MONEY_DP);

/** Plain, non-exponential string for rates/probabilities/factors. */
export const rateToString = (value: Dec): string => roundRate(value).toFixed(RATE_DP);

/** Compact display string for rates without trailing zero padding. */
export const rateToDisplayString = (value: Dec, dp = 6): string =>
  roundRate(value).toFixed(dp).replace(/\.?0+$/, '') || '0';

export function clampDec(value: Dec, min: Dec, max: Dec): Dec {
  if (value.lessThan(min)) return min;
  if (value.greaterThan(max)) return max;
  return value;
}

/** True when `|a - b| <= tolerance`. Used for decimal equality assertions. */
export function decCloseTo(a: Dec, b: Dec, tolerance: DecValue = WEIGHT_SUM_TOLERANCE): boolean {
  return a.minus(b).abs().lessThanOrEqualTo(dec(tolerance));
}

/**
 * Parses a decimal string, rejecting values Decimal.js cannot represent.
 * Throws rather than coercing so ambiguous input is never silently repaired.
 */
export function parseDec(value: string, field: string): Dec {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field}: empty value cannot be parsed as a decimal`);
  }
  let parsed: Dec;
  try {
    parsed = new EngineDecimal(trimmed);
  } catch {
    throw new Error(`${field}: '${trimmed}' is not a valid decimal number`);
  }
  if (!parsed.isFinite()) {
    throw new Error(`${field}: '${trimmed}' is not a finite decimal number`);
  }
  return parsed;
}

/** Percentage (e.g. "18.5") to decimal (0.185). */
export const percentToDecimal = (percent: Dec): Dec => percent.dividedBy(100);

/** Decimal (0.185) to percentage number for display only. */
export const decimalToPercentNumber = (value: Dec): number => value.times(100).toNumber();
