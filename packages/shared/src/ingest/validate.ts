/**
 * Row-level validation for uploaded portfolios.
 *
 * A row is either fully valid or quarantined — there is no partial repair.
 * Every problem produces a `ValidationIssue` carrying the row number, field,
 * raw value, a stable issue code, a severity and a suggested correction, which
 * is exactly what the error report and the exception queue consume.
 *
 * Zod validates the normalized row shape; cross-field consistency (date order,
 * PD monotonicity, flag/DPD agreement) is checked in a `superRefine` so the
 * issues still carry precise field attribution.
 */
import { z } from 'zod';
import { dec, one, zero } from '../domain/decimal';
import { monthsBetween } from '../domain/dates';
import { RATING_ORDER } from '../domain/staging';
import {
  FIELD_SPECS,
  PORTFOLIO_FIELDS,
  REQUIRED_FIELDS,
  type PortfolioField,
} from './columns';
import {
  normalizationNoteFrom,
  parseBooleanCell,
  parseDateCell,
  parseDecimalCell,
  parseIntegerCell,
  normalizeRateCell,
  type PercentageNormalizationMode,
} from './normalize';

export interface RawRow {
  /** 1-based index among data rows (header excluded). */
  rowNumber: number;
  /** Physical line/sheet row, so the analyst can find it in their file. */
  sheetRow: number;
  cells: string[];
}

export interface RawTable {
  sourceFileName: string;
  sourceFormat: 'CSV' | 'XLSX';
  headers: string[];
  rows: RawRow[];
  /** True when the parser stopped early to bound memory. */
  truncated: boolean;
  rowsSkippedByTruncation: number;
}

/** Canonical field -> header text in the uploaded file. null/absent = unmapped. */
export type ColumnMapping = Partial<Record<PortfolioField, string | null>>;

export interface MappedRow {
  rowNumber: number;
  sheetRow: number;
  values: Record<PortfolioField, string>;
  /** Original header -> original cell text, kept for the error report. */
  raw: Record<string, string>;
}

export interface ApplyMappingResult {
  rows: MappedRow[];
  /** Headers present in the file but not claimed by any canonical field. */
  unmappedHeaders: string[];
  /** Required canonical fields with no header at all. */
  missingRequiredFields: PortfolioField[];
}

export function applyMapping(table: RawTable, mapping: ColumnMapping): ApplyMappingResult {
  const mappedHeaders = new Set(
    Object.values(mapping)
      .filter((header): header is string => typeof header === 'string' && header.length > 0),
  );

  const rows = table.rows.map((row) => {
    const values = PORTFOLIO_FIELDS.reduce(
      (acc, field) => {
        acc[field] = '';
        return acc;
      },
      {} as Record<PortfolioField, string>,
    );
    const raw: Record<string, string> = {};

    table.headers.forEach((header, index) => {
      const cell = row.cells[index] ?? '';
      raw[header] = cell;
    });

    for (const field of PORTFOLIO_FIELDS) {
      const header = mapping[field];
      if (!header) continue;
      const index = table.headers.indexOf(header);
      values[field] = index >= 0 ? (row.cells[index] ?? '').trim() : '';
    }

    return { rowNumber: row.rowNumber, sheetRow: row.sheetRow, values, raw };
  });

  return {
    rows,
    unmappedHeaders: table.headers.filter((header) => !mappedHeaders.has(header)),
    missingRequiredFields: REQUIRED_FIELDS.filter((field) => !mapping[field]),
  };
}

export const ISSUE_CODES = [
  'MISSING_REQUIRED_FIELD',
  'UNMAPPED_REQUIRED_COLUMN',
  'INVALID_NUMBER',
  'INVALID_INTEGER',
  'INVALID_DATE',
  'INVALID_BOOLEAN',
  'INVALID_RATING',
  'NEGATIVE_AMOUNT',
  'OUT_OF_RANGE_RATE',
  'DUPLICATE_EXPOSURE_ID',
  'INCONSISTENT_DATES',
  'INCONSISTENT_PD',
  'FLAG_DPD_INCONSISTENT',
  'AMBIGUOUS_PERCENTAGE',
  'AMBIGUOUS_THOUSANDS_SEPARATOR',
  'AMBIGUOUS_DATE_FORMAT',
  'ROW_TOO_LARGE',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];
export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface ValidationIssue {
  /** null for file-level issues that are not attributable to one row. */
  rowNumber: number | null;
  sheetRow: number | null;
  field: string;
  rawValue: string;
  issueCode: IssueCode;
  severity: IssueSeverity;
  message: string;
  suggestedCorrection: string | null;
}

export interface QuarantinedRow {
  rowNumber: number;
  sheetRow: number;
  raw: Record<string, string>;
  issues: ValidationIssue[];
}

export interface ParsedExposureRow {
  rowNumber: number;
  sheetRow: number;
  exposureId: string;
  borrowerId: string;
  borrowerName: string;
  segment: string;
  productType: string;
  originationDate: string;
  maturityDate: string;
  reportingDate: string;
  currency: string;
  /** Exact decimal strings — never binary floats — for every money/rate value. */
  grossCarryingAmount: string;
  undrawnCommitment: string;
  creditConversionFactor: string;
  effectiveInterestRate: string;
  daysPastDue: number;
  originalCreditRating: string;
  currentCreditRating: string;
  twelveMonthPd: string;
  lifetimePd: string;
  lgd: string;
  collateralValue: string;
  defaultFlag: boolean;
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  pdAtOrigination: string;
  region: string;
  industry: string;
  /** Non-blocking notes produced while normalizing this row. */
  warnings: ValidationIssue[];
}

export interface ImportSummary {
  totalRows: number;
  validRows: number;
  quarantinedRows: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  duplicateCount: number;
  issuesByCode: Partial<Record<IssueCode, number>>;
}

export interface ValidationResult {
  validRows: ParsedExposureRow[];
  quarantinedRows: QuarantinedRow[];
  issues: ValidationIssue[];
  summary: ImportSummary;
}

export interface ValidationOptions {
  percentageNormalization: PercentageNormalizationMode;
  /** Exposure ids already persisted for this organisation. */
  existingExposureIds?: Iterable<string>;
  /** Applied when the file has no reporting_date column. */
  defaultReportingDate?: string;
  defaultCurrency?: string;
  /** Inclusive bounds for the effective interest rate, as decimals. */
  effectiveInterestRateMin?: string;
  effectiveInterestRateMax?: string;
  /** Rows with more mapped cells than this are rejected as malformed. */
  maxCellsPerRow?: number;
}

const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string');

/** Zod schema for the normalized row. Runs after cell parsing. */
export const parsedExposureRowSchema = z
  .object({
    rowNumber: z.number().int().positive(),
    sheetRow: z.number().int().positive(),
    exposureId: z.string().trim().min(1).max(64),
    borrowerId: z.string().trim().min(1).max(64),
    borrowerName: z.string().trim().min(1).max(200),
    segment: z.string().trim().min(1).max(64),
    productType: z.string().trim().min(1).max(64),
    originationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO YYYY-MM-DD'),
    maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO YYYY-MM-DD'),
    reportingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO YYYY-MM-DD'),
    currency: z.string().trim().length(3).toUpperCase(),
    grossCarryingAmount: decimalStringSchema,
    undrawnCommitment: decimalStringSchema,
    creditConversionFactor: decimalStringSchema,
    effectiveInterestRate: decimalStringSchema,
    daysPastDue: z.number().int().min(0).max(100000),
    originalCreditRating: z.string().trim().min(1).max(8),
    currentCreditRating: z.string().trim().min(1).max(8),
    twelveMonthPd: decimalStringSchema,
    lifetimePd: decimalStringSchema,
    lgd: decimalStringSchema,
    collateralValue: decimalStringSchema,
    defaultFlag: z.boolean(),
    creditImpairedFlag: z.boolean(),
    forbearanceFlag: z.boolean(),
    restructuringFlag: z.boolean(),
    watchlistFlag: z.boolean(),
    pdAtOrigination: decimalStringSchema,
    region: z.string().trim().min(1).max(120),
    industry: z.string().trim().min(1).max(120),
    warnings: z.array(z.unknown()),
  })
  .superRefine((row, ctx) => {
    if (row.originationDate > row.reportingDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originationDate'],
        message: `Origination date ${row.originationDate} is after the reporting date ${row.reportingDate}`,
      });
    }
    if (row.maturityDate <= row.reportingDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maturityDate'],
        message: `Maturity date ${row.maturityDate} must be after the reporting date ${row.reportingDate}`,
      });
    }
    if (dec(row.grossCarryingAmount).lessThan(zero())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grossCarryingAmount'],
        message: 'Gross carrying amount cannot be negative',
      });
    }
    if (dec(row.undrawnCommitment).lessThan(zero())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['undrawnCommitment'],
        message: 'Undrawn commitment cannot be negative',
      });
    }
    if (dec(row.collateralValue).lessThan(zero())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collateralValue'],
        message: 'Collateral value cannot be negative',
      });
    }
    for (const field of ['creditConversionFactor', 'twelveMonthPd', 'lifetimePd', 'lgd', 'pdAtOrigination'] as const) {
      if (dec(row[field]).lessThan(zero()) || dec(row[field]).greaterThan(one())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${FIELD_SPECS[field].label} must be a decimal between 0 and 1`,
          // lifetimePd is checked twice below, so the path alone cannot say
          // which rule fired. The code travels with the issue instead.
          params: { issueCode: 'OUT_OF_RANGE_RATE' },
        });
      }
    }
    if (monthsBetween(row.reportingDate, row.maturityDate) > 12 && dec(row.lifetimePd).lessThan(dec(row.twelveMonthPd))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lifetimePd'],
        message: `Lifetime PD (${row.lifetimePd}) cannot be below the 12-month PD (${row.twelveMonthPd}) over a term longer than 12 months`,
        params: { issueCode: 'INCONSISTENT_PD' },
      });
    }
    const ratings = RATING_ORDER as readonly string[];
    if (!ratings.includes(row.originalCreditRating.toUpperCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originalCreditRating'],
        message: `'${row.originalCreditRating}' is not on the internal rating scale (${RATING_ORDER.join(', ')})`,
      });
    }
    if (!ratings.includes(row.currentCreditRating.toUpperCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentCreditRating'],
        message: `'${row.currentCreditRating}' is not on the internal rating scale (${RATING_ORDER.join(', ')})`,
      });
    }
  });

const RATE_FIELDS: PortfolioField[] = [
  'creditConversionFactor',
  'effectiveInterestRate',
  'twelveMonthPd',
  'lifetimePd',
  'lgd',
  'pdAtOrigination',
];
const DATE_FIELDS: PortfolioField[] = ['originationDate', 'maturityDate', 'reportingDate'];
const BOOLEAN_FIELDS: PortfolioField[] = [
  'defaultFlag',
  'creditImpairedFlag',
  'forbearanceFlag',
  'restructuringFlag',
  'watchlistFlag',
];

interface CellParseOutcome {
  text: string;
  issues: ValidationIssue[];
}

function parseCell(
  field: PortfolioField,
  rawValue: string,
  row: MappedRow,
  options: ValidationOptions,
): CellParseOutcome {
  const spec = FIELD_SPECS[field];
  const issues: ValidationIssue[] = [];
  const fail = (issueCode: IssueCode, message: string, suggested: string | null, severity: IssueSeverity = 'ERROR'): never | undefined => {
    issues.push({
      rowNumber: row.rowNumber,
      sheetRow: row.sheetRow,
      field,
      rawValue,
      issueCode,
      severity,
      message,
      suggestedCorrection: suggested,
    });
    return undefined;
  };

  const blank = rawValue.trim().length === 0;
  if (blank) {
    // The reporting date and the currency describe the import batch rather than
    // the individual row, so a blank cell is filled from an explicitly
    // configured batch default. Only an explicit default qualifies: a field's
    // own defaultValue must never stand in for missing required data.
    const batchDefault =
      field === 'reportingDate'
        ? options.defaultReportingDate
        : field === 'currency'
          ? options.defaultCurrency
          : undefined;

    if (spec.required && !batchDefault) {
      fail('MISSING_REQUIRED_FIELD', `${spec.label} is required`, null);
      return { text: '', issues };
    }
    const fallback =
      field === 'reportingDate'
        ? (batchDefault ?? '')
        : field === 'currency'
          ? (batchDefault ?? spec.defaultValue ?? 'PKR')
          : field === 'borrowerId'
            ? row.values.exposureId
            : (spec.defaultValue ?? '');
    return { text: fallback, issues };
  }

  // Text columns need no parsing. Without this branch they fall through to the
  // decimal parser, which rejects every identifier, name, rating and region.
  if (spec.kind === 'TEXT') {
    return { text: rawValue.trim(), issues };
  }

  try {
    if (spec.kind === 'ISO_DATE' || DATE_FIELDS.includes(field)) {
      const parsed = parseDateCell(rawValue, spec.label);
      return { text: parsed.value, issues };
    }
    if (spec.kind === 'BOOLEAN' || BOOLEAN_FIELDS.includes(field)) {
      const parsed = parseBooleanCell(rawValue, spec.label);
      return { text: parsed === null ? 'false' : String(parsed), issues };
    }
    if (spec.kind === 'INTEGER') {
      return { text: String(parseIntegerCell(rawValue, spec.label)), issues };
    }
    if (spec.kind === 'RATE' || RATE_FIELDS.includes(field)) {
      const parsed = normalizeRateCell(rawValue, spec.label, options.percentageNormalization);
      for (const note of parsed.notes) {
        if (note.code === 'PERCENT_CONVERTED_TO_DECIMAL' && options.percentageNormalization === 'AUTO_DETECT') {
          issues.push({
            rowNumber: row.rowNumber,
            sheetRow: row.sheetRow,
            field,
            rawValue,
            issueCode: 'AMBIGUOUS_PERCENTAGE',
            severity: 'WARNING',
            message: note.message,
            suggestedCorrection: note.suggestedCorrection,
          });
        } else if (note.code === 'AMBIGUOUS_THOUSANDS_SEPARATOR') {
          issues.push({
            rowNumber: row.rowNumber,
            sheetRow: row.sheetRow,
            field,
            rawValue,
            issueCode: 'AMBIGUOUS_THOUSANDS_SEPARATOR',
            severity: 'WARNING',
            message: note.message,
            suggestedCorrection: note.suggestedCorrection,
          });
        }
      }
      return { text: parsed.value.toString(), issues };
    }
    const parsed = parseDecimalCell(rawValue, spec.label);
    for (const note of parsed.notes) {
      issues.push({
        rowNumber: row.rowNumber,
        sheetRow: row.sheetRow,
        field,
        rawValue,
        issueCode: 'AMBIGUOUS_THOUSANDS_SEPARATOR',
        severity: 'WARNING',
        message: note.message,
        suggestedCorrection: note.suggestedCorrection,
      });
    }
    return { text: parsed.value.toString(), issues };
  } catch (error) {
    const note = normalizationNoteFrom(error);
    if (note) {
      issues.push({
        rowNumber: row.rowNumber,
        sheetRow: row.sheetRow,
        field,
        rawValue,
        issueCode: note.code === 'AMBIGUOUS_DATE_FORMAT' ? 'AMBIGUOUS_DATE_FORMAT' : 'INVALID_DATE',
        severity: 'ERROR',
        message: note.message,
        suggestedCorrection: note.suggestedCorrection,
      });
      return { text: '', issues };
    }
    const message = error instanceof Error ? error.message : String(error);
    const issueCode: IssueCode = spec.kind === 'ISO_DATE'
      ? 'INVALID_DATE'
      : spec.kind === 'BOOLEAN'
        ? 'INVALID_BOOLEAN'
        : spec.kind === 'INTEGER'
          ? 'INVALID_INTEGER'
          : 'INVALID_NUMBER';
    fail(issueCode, message, null);
    return { text: '', issues };
  }
}

const ISSUE_CODE_BY_PATH: Record<string, IssueCode> = {
  originationDate: 'INCONSISTENT_DATES',
  maturityDate: 'INCONSISTENT_DATES',
  grossCarryingAmount: 'NEGATIVE_AMOUNT',
  undrawnCommitment: 'NEGATIVE_AMOUNT',
  collateralValue: 'NEGATIVE_AMOUNT',
  creditConversionFactor: 'OUT_OF_RANGE_RATE',
  twelveMonthPd: 'OUT_OF_RANGE_RATE',
  lifetimePd: 'INCONSISTENT_PD',
  lgd: 'OUT_OF_RANGE_RATE',
  pdAtOrigination: 'OUT_OF_RANGE_RATE',
  originalCreditRating: 'INVALID_RATING',
  currentCreditRating: 'INVALID_RATING',
  exposureId: 'MISSING_REQUIRED_FIELD',
  borrowerId: 'MISSING_REQUIRED_FIELD',
  borrowerName: 'MISSING_REQUIRED_FIELD',
  segment: 'MISSING_REQUIRED_FIELD',
  productType: 'MISSING_REQUIRED_FIELD',
  reportingDate: 'INVALID_DATE',
  currency: 'MISSING_REQUIRED_FIELD',
  daysPastDue: 'INVALID_INTEGER',
  region: 'MISSING_REQUIRED_FIELD',
  industry: 'MISSING_REQUIRED_FIELD',
};

/**
 * Validates every mapped row.
 *
 * Duplicate exposure ids are detected both inside the file and against ids that
 * already exist for the organisation. A row with any ERROR is quarantined whole;
 * WARNING/INFO issues are attached to the row but do not block it.
 */
export function validateImportedRows(rows: MappedRow[], options: ValidationOptions): ValidationResult {
  const issues: ValidationIssue[] = [];
  const validRows: ParsedExposureRow[] = [];
  const quarantinedRows: QuarantinedRow[] = [];
  const eirMin = dec(options.effectiveInterestRateMin ?? '-0.5');
  const eirMax = dec(options.effectiveInterestRateMax ?? '5');
  const maxCells = options.maxCellsPerRow ?? 200;

  const seenInFile = new Set<string>();
  const existing = new Set(options.existingExposureIds ?? []);

  for (const row of rows) {
    const rowIssues: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (Object.keys(row.raw).length > maxCells) {
      rowIssues.push({
        rowNumber: row.rowNumber,
        sheetRow: row.sheetRow,
        field: '(row)',
        rawValue: '',
        issueCode: 'ROW_TOO_LARGE',
        severity: 'ERROR',
        message: `Row has ${Object.keys(row.raw).length} cells, above the ${maxCells} limit`,
        suggestedCorrection: null,
      });
      quarantinedRows.push({ rowNumber: row.rowNumber, sheetRow: row.sheetRow, raw: row.raw, issues: rowIssues });
      issues.push(...rowIssues);
      continue;
    }

    const values = {} as Record<PortfolioField, string>;
    for (const field of PORTFOLIO_FIELDS) {
      const outcome = parseCell(field, row.values[field] ?? '', row, options);
      values[field] = outcome.text;
      for (const issue of outcome.issues) {
        (issue.severity === 'ERROR' ? rowIssues : warnings).push(issue);
      }
    }

    if (values.effectiveInterestRate.length > 0) {
      const eir = dec(values.effectiveInterestRate);
      if (eir.lessThan(eirMin) || eir.greaterThan(eirMax)) {
        rowIssues.push({
          rowNumber: row.rowNumber,
          sheetRow: row.sheetRow,
          field: 'effectiveInterestRate',
          rawValue: row.values.effectiveInterestRate ?? '',
          issueCode: 'OUT_OF_RANGE_RATE',
          severity: 'ERROR',
          message: `Effective interest rate ${eir.toString()} is outside the supported range [${eirMin.toString()}, ${eirMax.toString()}]`,
          suggestedCorrection: null,
        });
      }
    }

    if (rowIssues.length > 0) {
      quarantinedRows.push({ rowNumber: row.rowNumber, sheetRow: row.sheetRow, raw: row.raw, issues: rowIssues });
      issues.push(...rowIssues, ...warnings);
      continue;
    }

    const candidate: Omit<ParsedExposureRow, 'warnings'> = {
      rowNumber: row.rowNumber,
      sheetRow: row.sheetRow,
      exposureId: values.exposureId,
      borrowerId: values.borrowerId || values.exposureId,
      borrowerName: values.borrowerName,
      segment: values.segment,
      productType: values.productType,
      originationDate: values.originationDate,
      maturityDate: values.maturityDate,
      reportingDate: values.reportingDate,
      currency: values.currency,
      grossCarryingAmount: values.grossCarryingAmount,
      undrawnCommitment: values.undrawnCommitment,
      creditConversionFactor: values.creditConversionFactor,
      effectiveInterestRate: values.effectiveInterestRate,
      daysPastDue: Number(values.daysPastDue),
      originalCreditRating: values.originalCreditRating.toUpperCase(),
      currentCreditRating: values.currentCreditRating.toUpperCase(),
      twelveMonthPd: values.twelveMonthPd,
      lifetimePd: values.lifetimePd,
      lgd: values.lgd,
      collateralValue: values.collateralValue,
      defaultFlag: values.defaultFlag === 'true',
      creditImpairedFlag: values.creditImpairedFlag === 'true',
      forbearanceFlag: values.forbearanceFlag === 'true',
      restructuringFlag: values.restructuringFlag === 'true',
      watchlistFlag: values.watchlistFlag === 'true',
      pdAtOrigination: values.pdAtOrigination || values.twelveMonthPd,
      region: values.region || 'Unspecified',
      industry: values.industry || 'Unspecified',
    };

    const parsed = parsedExposureRowSchema.safeParse({ ...candidate, warnings: [] });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = String(issue.path[0] ?? '(row)');
        // zod types `ZodIssue` as a union that does not declare `params`, but it
        // accepts it on every refinement and preserves it on the parsed error.
        const attached = (issue as { params?: { issueCode?: IssueCode } }).params?.issueCode;
        rowIssues.push({
          rowNumber: row.rowNumber,
          sheetRow: row.sheetRow,
          field: path,
          rawValue: row.values[path as PortfolioField] ?? '',
          issueCode: attached ?? ISSUE_CODE_BY_PATH[path] ?? 'INVALID_NUMBER',
          severity: 'ERROR',
          message: issue.message,
          suggestedCorrection: null,
        });
      }
      quarantinedRows.push({ rowNumber: row.rowNumber, sheetRow: row.sheetRow, raw: row.raw, issues: rowIssues });
      issues.push(...rowIssues, ...warnings);
      continue;
    }

    const data = parsed.data as Omit<ParsedExposureRow, 'warnings'> & { warnings: unknown[] };

    // Flag / DPD coherence — a warning, never a silent correction.
    if (data.daysPastDue >= 90 && !data.defaultFlag && !data.creditImpairedFlag) {
      warnings.push({
        rowNumber: row.rowNumber,
        sheetRow: row.sheetRow,
        field: 'defaultFlag',
        rawValue: 'false',
        issueCode: 'FLAG_DPD_INCONSISTENT',
        severity: 'WARNING',
        message: `${data.daysPastDue} days past due but neither default_flag nor credit_impaired_flag is set. Staging will still assign Stage 3 via the DPD backstop.`,
        suggestedCorrection: 'true',
      });
    }

    const duplicateOf = seenInFile.has(data.exposureId)
      ? 'DUPLICATE_IN_FILE'
      : existing.has(data.exposureId)
        ? 'ALREADY_EXISTS'
        : null;
    if (duplicateOf) {
      rowIssues.push({
        rowNumber: row.rowNumber,
        sheetRow: row.sheetRow,
        field: 'exposureId',
        rawValue: data.exposureId,
        issueCode: 'DUPLICATE_EXPOSURE_ID',
        severity: 'ERROR',
        message:
          duplicateOf === 'DUPLICATE_IN_FILE'
            ? `exposure_id '${data.exposureId}' appears more than once in this file`
            : `exposure_id '${data.exposureId}' already exists in this organisation's portfolio`,
        suggestedCorrection: null,
      });
      quarantinedRows.push({ rowNumber: row.rowNumber, sheetRow: row.sheetRow, raw: row.raw, issues: rowIssues });
      issues.push(...rowIssues, ...warnings);
      continue;
    }
    seenInFile.add(data.exposureId);

    validRows.push({ ...data, warnings });
    issues.push(...warnings);
  }

  return { validRows, quarantinedRows, issues, summary: buildImportSummary(rows.length, validRows, quarantinedRows, issues) };
}

export function buildImportSummary(
  totalRows: number,
  validRows: ParsedExposureRow[],
  quarantinedRows: QuarantinedRow[],
  issues: ValidationIssue[],
): ImportSummary {
  const issuesByCode: Partial<Record<IssueCode, number>> = {};
  for (const issue of issues) {
    issuesByCode[issue.issueCode] = (issuesByCode[issue.issueCode] ?? 0) + 1;
  }
  return {
    totalRows,
    validRows: validRows.length,
    quarantinedRows: quarantinedRows.length,
    errorCount: issues.filter((issue) => issue.severity === 'ERROR').length,
    warningCount: issues.filter((issue) => issue.severity === 'WARNING').length,
    infoCount: issues.filter((issue) => issue.severity === 'INFO').length,
    duplicateCount: issues.filter((issue) => issue.issueCode === 'DUPLICATE_EXPOSURE_ID').length,
    issuesByCode,
  };
}

/** File-level issues raised before any row is parsed. */
export function mappingIssues(result: ApplyMappingResult): ValidationIssue[] {
  return result.missingRequiredFields.map((field) => ({
    rowNumber: null,
    sheetRow: null,
    field,
    rawValue: '',
    issueCode: 'UNMAPPED_REQUIRED_COLUMN' as const,
    severity: 'ERROR' as const,
    message: `Required column '${FIELD_SPECS[field].label}' is not mapped to any header in the file`,
    suggestedCorrection: null,
  }));
}

/** Renders issues as CSV text for the downloadable error report. */
export function issuesToCsv(issues: ValidationIssue[]): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const header = ['row_number', 'sheet_row', 'field', 'raw_value', 'issue_code', 'severity', 'message', 'suggested_correction'];
  const lines = issues.map((issue) =>
    [
      issue.rowNumber === null ? '' : String(issue.rowNumber),
      issue.sheetRow === null ? '' : String(issue.sheetRow),
      issue.field,
      issue.rawValue,
      issue.issueCode,
      issue.severity,
      issue.message,
      issue.suggestedCorrection ?? '',
    ]
      .map((cell) => escape(cell))
      .join(','),
  );
  return [header.map(escape).join(','), ...lines].join('\r\n');
}
