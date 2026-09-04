/**
 * implementation_tasks (step 4) — "frontend component tests for important
 * financial formatters." These are pure functions with no DOM dependency
 * (apps/web has no testing-library/jsdom wired up — see src/lib/ai.test.ts's
 * own note on why its tests are pure-function-only for the same reason), so
 * they are tested here in the shared package rather than faked into a
 * component-rendering suite that does not exist.
 */
import { describe, expect, it } from 'vitest';
import {
  decimalStringToNumber,
  formatBps,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDecimalBps,
  formatDecimalMoney,
  formatDecimalPercent,
  formatDecimalText,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  formatVersionedRef,
} from '../src/index';

/**
 * Intl.NumberFormat separates a 3-letter currency code (PKR) from its amount
 * with the no-break space character (Unicode code point 160), not a plain
 * ASCII space (code point 32). Built from the numeric code point rather than
 * typed as a literal character, which is easy to retype as the wrong
 * lookalike whitespace character by accident.
 */
const NBSP = String.fromCharCode(160);

describe('formatCurrency', () => {
  it('formats a whole PKR amount with no decimals by default', () => {
    expect(formatCurrency(1234567)).toBe(`PKR${NBSP}1,234,567`);
  });

  it('formats a different currency code', () => {
    expect(formatCurrency(1000, 'USD')).toBe('$1,000');
  });

  it('uses compact notation with 2 decimal places when asked', () => {
    expect(formatCurrency(1234567, 'PKR', { compact: true })).toBe(`PKR${NBSP}1.23M`);
  });

  it('respects an explicit maximumFractionDigits', () => {
    expect(formatCurrency(1234.5, 'PKR', { maximumFractionDigits: 2 })).toBe(`PKR${NBSP}1,234.50`);
  });

  it('formats zero and negative amounts', () => {
    expect(formatCurrency(0)).toBe(`PKR${NBSP}0`);
    expect(formatCurrency(-500)).toBe(`-PKR${NBSP}500`);
  });
});

describe('formatNumber', () => {
  it('formats an integer with thousands separators and no decimals by default', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('pads and rounds to the requested digit count', () => {
    expect(formatNumber(1.5, 2)).toBe('1.50');
    expect(formatNumber(1.005, 2)).toBe('1.01');
  });
});

describe('formatPercent', () => {
  it('scales a fraction to a percentage string with 2 decimals by default', () => {
    expect(formatPercent(0.0423)).toBe('4.23%');
  });

  it('honours a custom digit count', () => {
    expect(formatPercent(0.5, 0)).toBe('50%');
  });

  it('formats zero and values above 1 (over 100%)', () => {
    expect(formatPercent(0)).toBe('0.00%');
    expect(formatPercent(1.5, 1)).toBe('150.0%');
  });
});

describe('formatBps', () => {
  it('scales a fraction to whole basis points', () => {
    expect(formatBps(0.0423)).toBe('423 bps');
  });

  it('rounds to the nearest basis point', () => {
    expect(formatBps(0.00005)).toBe('1 bps');
    expect(formatBps(0.000049)).toBe('0 bps');
  });
});

describe('formatDate', () => {
  it('renders an ISO date as "DD Mon YYYY" in UTC', () => {
    expect(formatDate('2026-08-31')).toBe('31 Aug 2026');
  });

  it('renders an ISO timestamp the same way, ignoring time-of-day', () => {
    expect(formatDate('2026-08-31T23:59:59.000Z')).toBe('31 Aug 2026');
  });
});

describe('formatDateTime', () => {
  it('renders date and 24-hour time in UTC', () => {
    expect(formatDateTime('2026-08-31T14:05:00.000Z')).toBe('31 Aug 2026, 14:05');
  });
});

describe('formatSignedPercent', () => {
  it('prefixes a positive value with +', () => {
    expect(formatSignedPercent(0.05)).toBe('+5.00%');
  });

  it('does not double the sign on a negative value', () => {
    expect(formatSignedPercent(-0.05)).toBe('-5.00%');
  });

  it('adds no sign for exactly zero', () => {
    expect(formatSignedPercent(0)).toBe('0.00%');
  });
});

describe('decimalStringToNumber', () => {
  it('parses a valid decimal string', () => {
    expect(decimalStringToNumber('1234.56')).toBe(1234.56);
  });

  it('treats null, undefined and empty string as zero', () => {
    expect(decimalStringToNumber(null)).toBe(0);
    expect(decimalStringToNumber(undefined)).toBe(0);
    expect(decimalStringToNumber('')).toBe(0);
  });

  it('falls back to zero for a non-numeric string rather than NaN', () => {
    expect(decimalStringToNumber('not-a-number')).toBe(0);
    expect(Number.isNaN(decimalStringToNumber('not-a-number'))).toBe(false);
  });

  it('parses a negative decimal string', () => {
    expect(decimalStringToNumber('-42.5')).toBe(-42.5);
  });
});

describe('formatDecimalMoney', () => {
  it('parses the decimal string then formats it as currency', () => {
    expect(formatDecimalMoney('1234567.89')).toBe(`PKR${NBSP}1,234,568`);
  });

  it('treats a missing value as zero rather than throwing', () => {
    expect(formatDecimalMoney(null)).toBe(`PKR${NBSP}0`);
  });
});

describe('formatDecimalPercent', () => {
  it('parses the decimal string then formats it as a percentage', () => {
    expect(formatDecimalPercent('0.0254625539', 2)).toBe('2.55%');
  });

  it('treats a missing value as zero', () => {
    expect(formatDecimalPercent(undefined)).toBe('0.00%');
  });
});

describe('formatDecimalBps', () => {
  it('parses the decimal string then formats it as basis points', () => {
    expect(formatDecimalBps('0.0423')).toBe('423 bps');
  });
});

describe('formatDecimalText', () => {
  it('returns the string verbatim, trailing zeros included', () => {
    expect(formatDecimalText('1.4500000000')).toBe('1.4500000000');
  });

  it('falls back to a placeholder by default when missing', () => {
    const fallback = formatDecimalText(null);
    expect(formatDecimalText(undefined)).toBe(fallback);
    expect(formatDecimalText('')).toBe(fallback);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).not.toBe('1.4500000000');
  });

  it('accepts a custom fallback', () => {
    expect(formatDecimalText(null, 'n/a')).toBe('n/a');
  });
});

describe('formatVersionedRef', () => {
  it('prefers the name, with the version suffixed', () => {
    expect(formatVersionedRef('Pakistan macro base case', 'cuid123', '1.0.0')).toBe('Pakistan macro base case v1.0.0');
  });

  it('falls back to the id when no name is present', () => {
    expect(formatVersionedRef(null, 'cuid123', '1.0.0')).toBe('cuid123 v1.0.0');
    expect(formatVersionedRef(undefined, 'cuid123', '1.0.0')).toBe('cuid123 v1.0.0');
    expect(formatVersionedRef('', 'cuid123', '1.0.0')).toBe('cuid123 v1.0.0');
  });

  it('falls back to a placeholder when neither name nor id is present', () => {
    const withoutVersion = formatVersionedRef(null, null, '');
    const withVersion = formatVersionedRef(null, null, '1.0.0');
    expect(withVersion).toBe(`${withoutVersion} v1.0.0`);
    expect(withoutVersion.length).toBeGreaterThan(0);
  });

  it('omits the version suffix when no version is present', () => {
    expect(formatVersionedRef('Pakistan macro base case', 'cuid123', null)).toBe('Pakistan macro base case');
    expect(formatVersionedRef('Pakistan macro base case', 'cuid123', '')).toBe('Pakistan macro base case');
  });
});
