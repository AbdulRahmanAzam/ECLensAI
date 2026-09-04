/**
 * Date helpers for the ECL engine.
 *
 * All dates cross module boundaries as unambiguous ISO strings: `YYYY-MM-DD`
 * for calendar dates and full ISO-8601 UTC for timestamps. Calendar arithmetic
 * is done in UTC so results never shift with the server's local timezone.
 */

export type IsoDate = string;
export type IsoTimestamp = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates and normalizes an ISO calendar date. Throws on anything ambiguous. */
export function assertIsoDate(value: string, field: string): IsoDate {
  const match = ISO_DATE.exec(value.trim());
  if (!match) {
    throw new Error(`${field}: '${value}' is not an unambiguous ISO date (expected YYYY-MM-DD)`);
  }
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error(`${field}: '${value}' is not a real calendar date`);
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Whole calendar months from `fromIso` to `toIso`. Can be negative.
 *
 * Deliberately the exact inverse of `addMonths`, month-end clamping included:
 * `addMonths('2026-08-31', 1)` is `'2026-09-30'`, so that pair must measure as
 * one whole month even though 30 < 31. Comparing raw day-of-month numbers would
 * report 0 and make the engine reject a genuine one-month exposure. ISO dates
 * sort lexicographically, so a plain string comparison is a date comparison.
 */
export function monthsBetween(fromIso: IsoDate, toIso: IsoDate): number {
  const from = assertIsoDate(fromIso, 'fromIso');
  const to = assertIsoDate(toIso, 'toIso');
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const wholeMonths =
    (toDate.getUTCFullYear() - fromDate.getUTCFullYear()) * 12 +
    (toDate.getUTCMonth() - fromDate.getUTCMonth());
  if (to < addMonths(from, wholeMonths)) return wholeMonths - 1;
  return wholeMonths;
}

/** Adds whole months to an ISO date, clamping to the last valid day of month. */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const base = new Date(assertIsoDate(iso, 'iso'));
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Inclusive end date of a calculation period that is `period` months out. */
export function periodEndDate(reportingDate: IsoDate, period: number): IsoDate {
  return addMonths(reportingDate, period);
}

/** Start date of a calculation period (end of the previous period). */
export function periodStartDate(reportingDate: IsoDate, period: number): IsoDate {
  return addMonths(reportingDate, period - 1);
}

/** Days between two ISO dates (to - from). */
export function daysBetween(fromIso: IsoDate, toIso: IsoDate): number {
  const from = new Date(assertIsoDate(fromIso, 'fromIso')).getTime();
  const to = new Date(assertIsoDate(toIso, 'toIso')).getTime();
  return Math.round((to - from) / 86_400_000);
}
