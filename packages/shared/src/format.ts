/** Consistent formatting for money, percentages, dates. */

export const DEFAULT_CURRENCY = 'PKR';

export interface CurrencyFormatOptions {
  /** Compact notation, e.g. 1.2M instead of 1,200,000. */
  compact?: boolean;
  maximumFractionDigits?: number;
}

export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
  options: CurrencyFormatOptions = {},
): string {
  const { compact = false, maximumFractionDigits } = options;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: maximumFractionDigits ?? (compact ? 2 : 0),
  }).format(value);
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** 0.0423 → "4.23%" */
export function formatPercent(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** 0.0423 → "423 bps" */
export function formatBps(value: number): string {
  return `${Math.round(value * 10000)} bps`;
}

/** ISO date → "31 Aug 2026" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** ISO datetime → "31 Aug 2026, 14:05" */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

export function formatSignedPercent(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

/**
 * The API returns money and rates as exact decimal strings, never binary
 * floats. Parse to a number ONLY for charting, sorting and layout decisions —
 * never to re-derive a reported figure.
 */
export function decimalStringToNumber(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDecimalMoney(
  value: string | null | undefined,
  currency: string = DEFAULT_CURRENCY,
  options: CurrencyFormatOptions = {},
): string {
  return formatCurrency(decimalStringToNumber(value), currency, options);
}

export function formatDecimalPercent(value: string | null | undefined, digits = 2): string {
  return formatPercent(decimalStringToNumber(value), digits);
}

export function formatDecimalBps(value: string | null | undefined): string {
  return formatBps(decimalStringToNumber(value));
}

/**
 * Renders the engine's own digits verbatim, trailing zeros included, so a
 * reviewer replaying a formula trace sees exactly what the engine produced.
 */
export function formatDecimalText(value: string | null | undefined, fallback = '—'): string {
  return value === null || value === undefined || value === '' ? fallback : value;
}

/**
 * A versioned lineage reference as a person reads it: "Meridian Baseline v1.0.0".
 *
 * Falls back to the id when no name is present, because lineage is frozen on a
 * completed run and rows written before the name fields existed carry only the
 * surrogate key. Showing the id is still traceable; showing nothing is not.
 */
export function formatVersionedRef(
  name: string | null | undefined,
  id: string | null | undefined,
  version: string | null | undefined,
): string {
  const label = name && name.length > 0 ? name : (id ?? '—');
  return version && version.length > 0 ? `${label} v${version}` : label;
}
