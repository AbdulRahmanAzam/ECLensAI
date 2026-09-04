/**
 * Cell-level normalization for uploaded portfolio files.
 *
 * Design rule: nothing ambiguous is silently repaired. Unambiguous lexical
 * cleanup (surrounding whitespace, a currency symbol, grouping separators) is
 * applied without comment. Anything that required a *judgment* — most
 * importantly whether a number is already a decimal or is a percentage — is
 * applied according to an explicit, user-selected mode and recorded as an issue
 * so the analyst can see and reverse it.
 */
import { dec, type Dec } from '../domain/decimal';
import { assertIsoDate } from '../domain/dates';

/**
 * How rate columns (PD, LGD, CCF, EIR) should be interpreted.
 *
 * - `AS_DECIMAL`      — the file already holds decimals (0.185 = 18.5%). Values
 *                       above 1 are an error, never divided.
 * - `PERCENT_TO_DECIMAL` — the file holds percentages (18.5 = 18.5%). Every
 *                       value is divided by 100.
 * - `AUTO_DETECT`     — values <= 1 are read as decimals, values > 1 as
 *                       percentages. Each conversion is reported as a WARNING
 *                       issue so the choice is visible.
 */
export const PERCENTAGE_NORMALIZATION_MODES = ['AS_DECIMAL', 'PERCENT_TO_DECIMAL', 'AUTO_DETECT'] as const;
export type PercentageNormalizationMode = (typeof PERCENTAGE_NORMALIZATION_MODES)[number];

export type NormalizationNoteCode =
  | 'PERCENT_CONVERTED_TO_DECIMAL'
  | 'AMBIGUOUS_THOUSANDS_SEPARATOR'
  | 'AMBIGUOUS_DATE_FORMAT';

export interface NormalizationNote {
  code: NormalizationNoteCode;
  rawValue: string;
  appliedValue: string;
  message: string;
  suggestedCorrection: string;
}

export interface NormalizedDecimal {
  value: Dec;
  notes: NormalizationNote[];
}

const CURRENCY_SYMBOLS = ['PKR', 'RS', 'RS.', 'USD', 'EUR', 'GBP', '₨', '₹', '$', '€', '£'];

/** Removes whitespace, a leading currency token and trailing ISO code. */
export function stripCurrencyNoise(raw: string): string {
  let value = raw.trim();
  for (const symbol of CURRENCY_SYMBOLS) {
    const upper = value.toUpperCase();
    if (upper.startsWith(symbol)) {
      value = value.slice(symbol.length).trim();
      break;
    }
    if (upper.endsWith(symbol)) {
      value = value.slice(0, value.length - symbol.length).trim();
      break;
    }
  }
  return value.replace(/\s+/g, '');
}

/**
 * Parses a decimal cell.
 *
 * Grouping separators are resolved by position: when both '.' and ',' appear,
 * the last one is the decimal separator. When only ',' appears the digit count
 * after it decides — 3 digits reads as a thousands separator, 1-2 digits is
 * genuinely ambiguous and is reported rather than guessed silently.
 */
export function parseDecimalCell(raw: string, field: string): NormalizedDecimal {
  const cleaned = stripCurrencyNoise(raw);
  if (cleaned.length === 0) {
    throw new Error(`${field}: value is empty`);
  }
  if (!/^[-+]?[0-9.,]+$/.test(cleaned)) {
    throw new Error(`${field}: '${raw.trim()}' is not a number`);
  }

  const notes: NormalizationNote[] = [];
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized = cleaned;

  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const decimalsAfterComma = cleaned.length - lastComma - 1;
    const commaCount = cleaned.split(',').length - 1;
    if (decimalsAfterComma === 3 && commaCount === 1) {
      notes.push({
        code: 'AMBIGUOUS_THOUSANDS_SEPARATOR',
        rawValue: raw.trim(),
        appliedValue: cleaned.replace(/,/g, ''),
        message: `'${raw.trim()}' was read as ${cleaned.replace(/,/g, '')} (comma treated as a thousands separator). If it is a decimal comma the value should be ${cleaned.replace(',', '.')}.`,
        suggestedCorrection: cleaned.replace(/,/g, ''),
      });
      normalized = cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(/,/g, '.');
    }
  }

  const value = dec(normalized);
  if (!value.isFinite()) {
    throw new Error(`${field}: '${raw.trim()}' is not a finite number`);
  }
  return { value, notes };
}

/**
 * Normalizes a rate cell (PD, LGD, CCF, EIR) to a decimal using the selected
 * percentage mode. Returns the notes that must be surfaced as issues.
 */
export function normalizeRateCell(
  raw: string,
  field: string,
  mode: PercentageNormalizationMode,
): NormalizedDecimal {
  const parsed = parseDecimalCell(raw, field);
  const notes = [...parsed.notes];

  if (mode === 'PERCENT_TO_DECIMAL') {
    const value = parsed.value.dividedBy(100);
    notes.push({
      code: 'PERCENT_CONVERTED_TO_DECIMAL',
      rawValue: raw.trim(),
      appliedValue: value.toString(),
      message: `Column mode PERCENT_TO_DECIMAL: '${raw.trim()}' was divided by 100 to give the decimal ${value.toString()}.`,
      suggestedCorrection: value.toString(),
    });
    return { value, notes };
  }

  if (mode === 'AUTO_DETECT' && parsed.value.greaterThan(1)) {
    const value = parsed.value.dividedBy(100);
    notes.push({
      code: 'PERCENT_CONVERTED_TO_DECIMAL',
      rawValue: raw.trim(),
      appliedValue: value.toString(),
      message: `AUTO_DETECT read '${raw.trim()}' as a percentage and divided by 100 to give ${value.toString()}. Choose AS_DECIMAL if the file already holds decimals.`,
      suggestedCorrection: value.toString(),
    });
    return { value, notes };
  }

  return { value: parsed.value, notes };
}

const TRUE_TOKENS = new Set(['true', 't', 'yes', 'y', '1']);
const FALSE_TOKENS = new Set(['false', 'f', 'no', 'n', '0']);

/** Parses a boolean cell. Blank means the documented default, not an error. */
export function parseBooleanCell(raw: string, field: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (token.length === 0) return null;
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  throw new Error(`${field}: '${raw.trim()}' is not a boolean (expected true/false, yes/no or 1/0)`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLASHED_DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const EXCEL_SERIAL = /^\d{5}(\.\d+)?$/;

export interface NormalizedDate {
  value: string;
  notes: NormalizationNote[];
}

/**
 * Parses a date cell to ISO YYYY-MM-DD.
 *
 * Only ISO input is accepted without comment. `DD/MM/YYYY` and Excel serial
 * dates are *recognised* so a precise suggested correction can be offered, but
 * they are rejected as errors — the engine never guesses a date order and
 * persists it.
 */
export function parseDateCell(raw: string, field: string): NormalizedDate {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`${field}: value is empty`);

  if (ISO_DATE.test(trimmed)) {
    return { value: assertIsoDate(trimmed, field), notes: [] };
  }

  const slashed = SLASHED_DMY.exec(trimmed);
  if (slashed) {
    const [, first, second, year] = slashed;
    const asDmy = `${year}-${second.padStart(2, '0')}-${first.padStart(2, '0')}`;
    const asMdy = `${year}-${first.padStart(2, '0')}-${second.padStart(2, '0')}`;
    const note: NormalizationNote = {
      code: 'AMBIGUOUS_DATE_FORMAT',
      rawValue: trimmed,
      appliedValue: '',
      message: `'${trimmed}' is not ISO YYYY-MM-DD and its day/month order is ambiguous (could be ${asDmy} or ${asMdy}). Reformat the column as ISO dates.`,
      suggestedCorrection: asDmy,
    };
    throw Object.assign(new Error(note.message), { normalizationNote: note });
  }

  if (EXCEL_SERIAL.test(trimmed)) {
    const serial = Number(trimmed);
    const epoch = Date.UTC(1899, 11, 30);
    const iso = new Date(epoch + serial * 86_400_000).toISOString().slice(0, 10);
    const note: NormalizationNote = {
      code: 'AMBIGUOUS_DATE_FORMAT',
      rawValue: trimmed,
      appliedValue: '',
      message: `'${trimmed}' looks like an Excel serial date. Export the column as text in ISO YYYY-MM-DD format.`,
      suggestedCorrection: iso,
    };
    throw Object.assign(new Error(note.message), { normalizationNote: note });
  }

  throw new Error(`${field}: '${trimmed}' is not an ISO YYYY-MM-DD date`);
}

/** Extracts an attached normalization note from a thrown parse error, if any. */
export function normalizationNoteFrom(error: unknown): NormalizationNote | null {
  if (error && typeof error === 'object' && 'normalizationNote' in error) {
    return (error as { normalizationNote: NormalizationNote }).normalizationNote;
  }
  return null;
}

/** Parses an integer cell, rejecting decimals rather than truncating them. */
export function parseIntegerCell(raw: string, field: string): number {
  const trimmed = stripCurrencyNoise(raw);
  if (trimmed.length === 0) throw new Error(`${field}: value is empty`);
  if (!/^[-+]?\d+$/.test(trimmed)) {
    throw new Error(`${field}: '${raw.trim()}' is not a whole number`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field}: '${raw.trim()}' is outside the safe integer range`);
  }
  return value;
}
