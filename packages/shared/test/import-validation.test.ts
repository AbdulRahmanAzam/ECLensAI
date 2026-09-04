/**
 * Import validation, quarantine and column mapping.
 *
 * Covers required test #9 — missing, negative, out-of-range, duplicated and
 * inconsistent import fields — plus the "never silently repair an ambiguous
 * value" rule: anything that needed a judgment call is either rejected with a
 * suggested correction or accepted with a visible WARNING, never both.
 *
 * The fixtures are the three hand-written template rows (one per stage), so the
 * assertions below describe exactly what an analyst gets when they download the
 * template, fill it in and upload it.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMapping,
  buildTemplateCsv,
  buildTemplateExampleRows,
  issuesToCsv,
  mappingIssues,
  missingRequiredHeaders,
  normalizeHeaderText,
  PORTFOLIO_FIELDS,
  REQUIRED_FIELDS,
  suggestHeaderMapping,
  TEMPLATE_HEADERS,
  validateImportedRows,
  type ColumnMapping,
  type PortfolioField,
  type RawTable,
  type ValidationResult,
  type ValidationOptions,
} from '../src/index';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPORTING_DATE = '2026-08-31';

/** The template ships its own labels as headers, so the identity map is valid. */
const IDENTITY_MAPPING: Record<PortfolioField, string> = PORTFOLIO_FIELDS.reduce(
  (acc, field, index) => {
    acc[field] = TEMPLATE_HEADERS[index];
    return acc;
  },
  {} as Record<PortfolioField, string>,
);

/** Re-keys a canonical row by header text so partial/shuffled headers stay aligned. */
const byHeader = (row: Record<PortfolioField, string>): Record<string, string> =>
  PORTFOLIO_FIELDS.reduce(
    (acc, field, index) => {
      acc[TEMPLATE_HEADERS[index]] = row[field] ?? '';
      return acc;
    },
    {} as Record<string, string>,
  );

const tableFrom = (headers: string[], rows: Record<string, string>[]): RawTable => ({
  sourceFileName: 'test-portfolio.csv',
  sourceFormat: 'CSV',
  headers,
  rows: rows.map((cells, index) => ({
    rowNumber: index + 1,
    sheetRow: index + 2,
    cells: headers.map((header) => cells[header] ?? ''),
  })),
  truncated: false,
  rowsSkippedByTruncation: 0,
});

const options = (overrides: Partial<ValidationOptions> = {}): ValidationOptions => ({
  percentageNormalization: 'AS_DECIMAL',
  ...overrides,
});

/** Stage 1 / Stage 2 / Stage 3, all valid, all PKR. */
const BASE_ROWS = buildTemplateExampleRows();

function validateRows(
  rows: Record<PortfolioField, string>[],
  overrides: Partial<ValidationOptions> = {},
): ValidationResult {
  const table = tableFrom(TEMPLATE_HEADERS, rows.map(byHeader));
  return validateImportedRows(applyMapping(table, IDENTITY_MAPPING).rows, options(overrides));
}

const validate = (overrides: Partial<ValidationOptions> = {}): ValidationResult =>
  validateRows(BASE_ROWS, overrides);

/** Mutates one field of one row, leaving the other template rows untouched. */
function mutated(
  field: PortfolioField,
  value: string,
  rowIndex = 0,
): Record<PortfolioField, string>[] {
  return BASE_ROWS.map((row, index) =>
    index === rowIndex ? { ...row, [field]: value } : row,
  );
}

const codesOf = (result: ValidationResult): string[] =>
  result.issues.map((issue) => issue.issueCode);

const onlyIssue = (result: ValidationResult) => {
  expect(result.issues).toHaveLength(1);
  return result.issues[0];
};

describe('the shipped template validates cleanly', () => {
  it('accepts all three example rows with no issues at all', () => {
    const result = validate();
    expect(result.quarantinedRows).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.validRows).toHaveLength(3);
    expect(result.summary).toEqual({
      totalRows: 3,
      validRows: 3,
      quarantinedRows: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      duplicateCount: 0,
      issuesByCode: {},
    });
  });

  it('normalizes money and rates to exact decimal strings, never binary floats', () => {
    const [stage1] = validate().validRows;
    // Trailing zeros are dropped because the text is Decimal.toString(): the
    // value is exact, the rendering is canonical.
    expect(stage1.grossCarryingAmount).toBe('1850000');
    expect(stage1.undrawnCommitment).toBe('0');
    expect(stage1.collateralValue).toBe('0');
    expect(stage1.creditConversionFactor).toBe('0');
    expect(stage1.effectiveInterestRate).toBe('0.178');
    expect(stage1.twelveMonthPd).toBe('0.0115');
    expect(stage1.lifetimePd).toBe('0.042');
    expect(stage1.lgd).toBe('0.42');
    expect(stage1.pdAtOrigination).toBe('0.0112');
  });

  it('normalizes text, integers, booleans and ratings to their canonical forms', () => {
    const [stage1, stage2, stage3] = validate().validRows;

    expect(stage1.exposureId).toBe('EXP-000001');
    expect(stage1.borrowerId).toBe('BOR-000001');
    expect(stage1.borrowerName).toBe('Ayesha Kazmi');
    expect(stage1.segment).toBe('consumer');
    expect(stage1.productType).toBe('auto_loan');
    expect(stage1.currency).toBe('PKR');
    expect(stage1.region).toBe('Punjab');
    expect(stage1.industry).toBe('Textiles');
    expect(stage1.daysPastDue).toBe(0);
    expect(stage1.defaultFlag).toBe(false);
    expect(stage1.creditImpairedFlag).toBe(false);
    expect(stage1.forbearanceFlag).toBe(false);
    expect(stage1.restructuringFlag).toBe(false);
    expect(stage1.watchlistFlag).toBe(false);

    expect(stage2.daysPastDue).toBe(47);
    expect(stage2.currentCreditRating).toBe('BB');
    expect(stage3.daysPastDue).toBe(128);
    expect(stage3.defaultFlag).toBe(true);
    expect(stage3.currentCreditRating).toBe('CCC');
  });

  it('keeps every date unambiguously ISO and correctly ordered', () => {
    for (const row of validate().validRows) {
      expect(row.originationDate).toMatch(ISO_DATE);
      expect(row.maturityDate).toMatch(ISO_DATE);
      expect(row.reportingDate).toBe(REPORTING_DATE);
      expect(row.originationDate < row.reportingDate).toBe(true);
      expect(row.maturityDate > row.reportingDate).toBe(true);
    }
  });

  it('clamps month-end origination and maturity dates to the last valid day', () => {
    const [stage1, stage2, stage3] = validate().validRows;
    // 2026-08-31 has no 31st in June or February, so addMonths clamps.
    expect(stage1.originationDate).toBe('2025-06-30');
    expect(stage1.maturityDate).toBe('2029-06-30');
    expect(stage2.originationDate).toBe('2024-06-30');
    expect(stage2.maturityDate).toBe('2028-06-30');
    expect(stage3.originationDate).toBe('2024-02-29');
    expect(stage3.maturityDate).toBe('2027-02-28');
  });

  it('carries rowNumber and sheetRow so the analyst can find the row in their file', () => {
    const rows = validate().validRows;
    expect(rows.map((row) => row.rowNumber)).toEqual([1, 2, 3]);
    // sheetRow counts the header line, so it is rowNumber + 1.
    expect(rows.map((row) => row.sheetRow)).toEqual([2, 3, 4]);
  });
});

describe('blank optional columns take their documented defaults', () => {
  it('defaults undrawn, collateral, ccf, flags, region and industry', () => {
    const blanked: Record<PortfolioField, string>[] = BASE_ROWS.map((row, index) =>
      index === 0
        ? {
            ...row,
            borrowerId: '',
            undrawnCommitment: '',
            creditConversionFactor: '',
            collateralValue: '',
            defaultFlag: '',
            watchlistFlag: '',
            region: '',
            industry: '',
          }
        : row,
    );
    const result = validateRows(blanked);
    expect(result.issues).toEqual([]);
    const [row] = result.validRows;
    expect(row.undrawnCommitment).toBe('0');
    expect(row.creditConversionFactor).toBe('0');
    expect(row.collateralValue).toBe('0');
    expect(row.defaultFlag).toBe(false);
    expect(row.watchlistFlag).toBe(false);
    expect(row.region).toBe('Unspecified');
    expect(row.industry).toBe('Unspecified');
    // borrower_id falls back to the exposure id, keeping the row identifiable.
    expect(row.borrowerId).toBe('EXP-000001');
  });

  it('defaults pd_at_origination to the normalized 12-month PD, not the raw cell', () => {
    // Under PERCENT_TO_DECIMAL the raw cell would be 1.15 (> 1) and would fail
    // the range check; the default must be applied after normalization.
    const blanked = mutated('pdAtOrigination', '');
    const result = validateRows(blanked, { percentageNormalization: 'PERCENT_TO_DECIMAL' });
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].twelveMonthPd).toBe('0.000115');
    expect(result.validRows[0].pdAtOrigination).toBe('0.000115');
  });
});

describe('missing required fields are quarantined, never guessed', () => {
  it('rejects a blank borrower name with full attribution', () => {
    const result = validateRows(mutated('borrowerName', ''));
    expect(result.validRows).toHaveLength(2);
    expect(result.quarantinedRows).toHaveLength(1);
    const issue = onlyIssue(result);
    expect(issue).toEqual({
      rowNumber: 1,
      sheetRow: 2,
      field: 'borrowerName',
      rawValue: '',
      issueCode: 'MISSING_REQUIRED_FIELD',
      severity: 'ERROR',
      message: 'borrower_name is required',
      suggestedCorrection: null,
    });
    expect(result.summary.errorCount).toBe(1);
    expect(result.summary.issuesByCode.MISSING_REQUIRED_FIELD).toBe(1);
  });

  it('quarantines the whole row rather than committing it partially', () => {
    const result = validateRows(mutated('grossCarryingAmount', ''));
    expect(codesOf(result)).toEqual(['MISSING_REQUIRED_FIELD']);
    const [quarantined] = result.quarantinedRows;
    expect(quarantined.rowNumber).toBe(1);
    // The raw cells survive so the error report can show what was uploaded.
    expect(quarantined.raw.gross_carrying_amount).toBe('');
    expect(quarantined.raw.exposure_id).toBe('EXP-000001');
  });

  it('rejects a blank reporting date unless a default is supplied', () => {
    const withoutDefault = validateRows(mutated('reportingDate', ''));
    expect(codesOf(withoutDefault)).toEqual(['MISSING_REQUIRED_FIELD']);
    expect(withoutDefault.validRows).toHaveLength(2);

    const withDefault = validateRows(mutated('reportingDate', ''), {
      defaultReportingDate: REPORTING_DATE,
    });
    expect(withDefault.issues).toEqual([]);
    expect(withDefault.validRows).toHaveLength(3);
    expect(withDefault.validRows[0].reportingDate).toBe(REPORTING_DATE);
  });

  it('applies the configured default currency, but only when one is configured', () => {
    const withoutDefault = validateRows(mutated('currency', ''));
    expect(codesOf(withoutDefault)).toEqual(['MISSING_REQUIRED_FIELD']);
    expect(withoutDefault.validRows).toHaveLength(2);

    const result = validateRows(mutated('currency', ''), { defaultCurrency: 'USD' });
    expect(result.issues).toEqual([]);
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows[0].currency).toBe('USD');
  });
});

describe('malformed cells produce a typed issue code', () => {
  it('rejects a non-numeric amount as INVALID_NUMBER', () => {
    const result = validateRows(mutated('grossCarryingAmount', 'abc'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INVALID_NUMBER');
    expect(issue.severity).toBe('ERROR');
    expect(issue.field).toBe('grossCarryingAmount');
    expect(issue.rawValue).toBe('abc');
    expect(issue.message).toContain('is not a number');
  });

  it('rejects a decimal days-past-due as INVALID_INTEGER instead of truncating', () => {
    const result = validateRows(mutated('daysPastDue', '12.5'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INVALID_INTEGER');
    expect(issue.message).toContain('is not a whole number');
  });

  it('rejects an unrecognised boolean token as INVALID_BOOLEAN', () => {
    const result = validateRows(mutated('watchlistFlag', 'maybe'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INVALID_BOOLEAN');
    expect(issue.message).toContain('is not a boolean');
  });

  it('accepts every documented boolean spelling', () => {
    for (const token of ['true', 'TRUE', 'yes', 'Y', '1']) {
      const result = validateRows(mutated('watchlistFlag', token));
      expect(result.issues, `token ${token}`).toEqual([]);
      expect(result.validRows[0].watchlistFlag, `token ${token}`).toBe(true);
    }
    for (const token of ['false', 'FALSE', 'no', 'N', '0']) {
      const result = validateRows(mutated('watchlistFlag', token));
      expect(result.issues, `token ${token}`).toEqual([]);
      expect(result.validRows[0].watchlistFlag, `token ${token}`).toBe(false);
    }
  });

  it('rejects free text in a date column as INVALID_DATE', () => {
    const result = validateRows(mutated('maturityDate', 'not-a-date'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INVALID_DATE');
    expect(issue.severity).toBe('ERROR');
    expect(issue.message).toContain('is not an ISO YYYY-MM-DD date');
  });
});

describe('ambiguous dates are recognised and rejected with a correction', () => {
  it('refuses to guess the day/month order of a slashed date', () => {
    const result = validateRows(mutated('maturityDate', '31/12/2027'));
    expect(result.validRows).toHaveLength(2);
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('AMBIGUOUS_DATE_FORMAT');
    expect(issue.severity).toBe('ERROR');
    expect(issue.rawValue).toBe('31/12/2027');
    expect(issue.suggestedCorrection).toBe('2027-12-31');
    expect(issue.message).toContain('could be 2027-12-31 or 2027-31-12');
  });

  it('flags an Excel serial date instead of persisting a converted guess', () => {
    const result = validateRows(mutated('maturityDate', '46000'));
    expect(result.validRows).toHaveLength(2);
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('AMBIGUOUS_DATE_FORMAT');
    expect(issue.severity).toBe('ERROR');
    expect(issue.message).toContain('Excel serial date');
    expect(issue.suggestedCorrection).toMatch(ISO_DATE);
  });
});

describe('negative and out-of-range values are rejected', () => {
  it.each([
    ['grossCarryingAmount', '-1'],
    ['undrawnCommitment', '-5000'],
    ['collateralValue', '-0.01'],
  ] as [PortfolioField, string][])('rejects a negative %s as NEGATIVE_AMOUNT', (field, value) => {
    const result = validateRows(mutated(field, value));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('NEGATIVE_AMOUNT');
    expect(issue.severity).toBe('ERROR');
    expect(issue.field).toBe(field);
    expect(issue.message).toContain('cannot be negative');
  });

  it.each([
    ['lgd', '1.5'],
    ['creditConversionFactor', '1.2'],
    ['twelveMonthPd', '-0.1'],
    ['lifetimePd', '2'],
    ['pdAtOrigination', '1.01'],
  ] as [PortfolioField, string][])('rejects %s outside [0,1] as OUT_OF_RANGE_RATE', (field, value) => {
    const result = validateRows(mutated(field, value));
    expect(result.validRows).toHaveLength(2);
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('OUT_OF_RANGE_RATE');
    expect(issue.field).toBe(field);
    expect(issue.message).toContain('must be a decimal between 0 and 1');
  });

  it('rejects an effective interest rate above the default ceiling', () => {
    const result = validateRows(mutated('effectiveInterestRate', '9'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('OUT_OF_RANGE_RATE');
    expect(issue.message).toBe(
      'Effective interest rate 9 is outside the supported range [-0.5, 5]',
    );
  });

  it('honours a configured interest-rate ceiling rather than a hard-coded one', () => {
    // All three template rows price above 15%, so a tighter bound quarantines
    // every row — proof the bound is data, not a constant in the parser.
    const result = validate({ effectiveInterestRateMax: '0.15' });
    expect(result.validRows).toHaveLength(0);
    expect(result.quarantinedRows).toHaveLength(3);
    expect(result.issues.map((issue) => issue.issueCode)).toEqual([
      'OUT_OF_RANGE_RATE',
      'OUT_OF_RANGE_RATE',
      'OUT_OF_RANGE_RATE',
    ]);
    expect(result.issues[0].message).toBe(
      'Effective interest rate 0.178 is outside the supported range [-0.5, 0.15]',
    );
    // The raw cell is reported, not the normalized value.
    expect(result.issues[0].rawValue).toBe('0.178000');

    const permissive = validate({ effectiveInterestRateMax: '0.25' });
    expect(permissive.issues).toEqual([]);
    expect(permissive.validRows).toHaveLength(3);
  });

  it('rejects a rating that is not on the internal scale', () => {
    const result = validateRows(mutated('currentCreditRating', 'XYZ'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INVALID_RATING');
    expect(issue.message).toContain('is not on the internal rating scale');
    expect(issue.message).toContain('AAA, AA, A, BBB, BB, B, CCC, CC, C, D');
  });

  it('accepts a lowercase rating by normalizing case, not by relaxing the scale', () => {
    const result = validateRows(mutated('currentCreditRating', 'bbb'));
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].currentCreditRating).toBe('BBB');
  });
});

describe('percentage normalization is an explicit, visible choice', () => {
  it('AS_DECIMAL never divides, so a percentage-shaped LGD is an error', () => {
    const result = validateRows(mutated('lgd', '45'), {
      percentageNormalization: 'AS_DECIMAL',
    });
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('OUT_OF_RANGE_RATE');
    expect(issue.field).toBe('lgd');
    expect(result.summary.warningCount).toBe(0);
  });

  it('PERCENT_TO_DECIMAL divides every rate by 100 without raising a warning', () => {
    const result = validateRows(mutated('lgd', '45'), {
      percentageNormalization: 'PERCENT_TO_DECIMAL',
    });
    expect(result.issues).toEqual([]);
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows[0].lgd).toBe('0.45');
    // The chosen mode is unambiguous, so no AMBIGUOUS_PERCENTAGE noise.
    expect(result.summary.warningCount).toBe(0);
  });

  it('AUTO_DETECT converts a value above 1 and reports the judgment as a WARNING', () => {
    const result = validateRows(mutated('lgd', '45'), {
      percentageNormalization: 'AUTO_DETECT',
    });
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows[0].lgd).toBe('0.45');
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('AMBIGUOUS_PERCENTAGE');
    expect(issue.severity).toBe('WARNING');
    expect(issue.field).toBe('lgd');
    expect(issue.rawValue).toBe('45');
    expect(issue.suggestedCorrection).toBe('0.45');
    expect(issue.message).toContain('Choose AS_DECIMAL if the file already holds decimals');
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.errorCount).toBe(0);
  });

  it('AUTO_DETECT leaves an already-decimal rate alone and stays silent', () => {
    const result = validateRows(mutated('lgd', '0.45'), {
      percentageNormalization: 'AUTO_DETECT',
    });
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].lgd).toBe('0.45');
  });
});

describe('ambiguous thousands separators are reported, not silently repaired', () => {
  it('reads an unambiguous grouped amount without comment', () => {
    const result = validateRows(mutated('grossCarryingAmount', '1,850,000.00'));
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].grossCarryingAmount).toBe('1850000');
  });

  it('warns when a single comma with three trailing digits could be a decimal comma', () => {
    const result = validateRows(mutated('grossCarryingAmount', '1,234'));
    // A WARNING keeps the row committable — the analyst decides, the engine does not.
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows[0].grossCarryingAmount).toBe('1234');
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('AMBIGUOUS_THOUSANDS_SEPARATOR');
    expect(issue.severity).toBe('WARNING');
    expect(issue.suggestedCorrection).toBe('1234');
    expect(issue.message).toContain('If it is a decimal comma the value should be 1.234');
  });

  it('strips a currency prefix and surrounding whitespace as unambiguous cleanup', () => {
    const result = validateRows(mutated('grossCarryingAmount', '  PKR 1850000.00 '));
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].grossCarryingAmount).toBe('1850000');
  });
});

describe('duplicate exposure ids are detected in-file and against the organisation', () => {
  it('rejects the second occurrence of an id within the same upload', () => {
    const result = validateRows([...BASE_ROWS, BASE_ROWS[0]]);
    expect(result.validRows).toHaveLength(3);
    expect(result.quarantinedRows).toHaveLength(1);
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('DUPLICATE_EXPOSURE_ID');
    expect(issue.severity).toBe('ERROR');
    expect(issue.field).toBe('exposureId');
    expect(issue.rowNumber).toBe(4);
    expect(issue.message).toBe(
      "exposure_id 'EXP-000001' appears more than once in this file",
    );
    expect(result.summary.duplicateCount).toBe(1);
  });

  it('rejects an id that already exists in this organisation only', () => {
    const result = validate({ existingExposureIds: ['EXP-000002'] });
    expect(result.validRows).toHaveLength(2);
    expect(result.validRows.map((row) => row.exposureId)).toEqual([
      'EXP-000001',
      'EXP-000003',
    ]);
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('DUPLICATE_EXPOSURE_ID');
    expect(issue.rowNumber).toBe(2);
    expect(issue.message).toBe(
      "exposure_id 'EXP-000002' already exists in this organisation's portfolio",
    );
  });

  it('does not treat ids from another organisation as duplicates', () => {
    const result = validate({ existingExposureIds: ['EXP-999999'] });
    expect(result.issues).toEqual([]);
    expect(result.validRows).toHaveLength(3);
  });
});

describe('cross-field consistency is checked after parsing', () => {
  it('rejects an origination date after the reporting date', () => {
    const result = validateRows(mutated('originationDate', '2026-09-15'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INCONSISTENT_DATES');
    expect(issue.field).toBe('originationDate');
    expect(issue.message).toBe(
      'Origination date 2026-09-15 is after the reporting date 2026-08-31',
    );
  });

  it('rejects a maturity date that is not after the reporting date', () => {
    const result = validateRows(mutated('maturityDate', '2026-08-31'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INCONSISTENT_DATES');
    expect(issue.field).toBe('maturityDate');
    expect(issue.message).toBe(
      'Maturity date 2026-08-31 must be after the reporting date 2026-08-31',
    );
  });

  it('rejects a lifetime PD below the 12-month PD on a long-dated exposure', () => {
    // Row 0 has 34 months remaining, so the monotonicity rule applies.
    const result = validateRows(mutated('lifetimePd', '0.005'));
    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('INCONSISTENT_PD');
    expect(issue.field).toBe('lifetimePd');
    expect(issue.message).toContain('cannot be below the 12-month PD');
  });

  it('does not apply the PD monotonicity rule inside a 12-month term', () => {
    // Row 2 matures in 6 months, where an inverted term structure is legitimate.
    const result = validateRows(mutated('lifetimePd', '0.005', 2));
    expect(result.issues).toEqual([]);
    expect(result.validRows[2].lifetimePd).toBe('0.005');
  });
});

describe('a high days-past-due with no default flag warns but still commits', () => {
  it('emits FLAG_DPD_INCONSISTENT as a WARNING and keeps the row valid', () => {
    const result = validateRows(mutated('daysPastDue', '120'));
    expect(result.quarantinedRows).toEqual([]);
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows[0].daysPastDue).toBe(120);
    expect(result.validRows[0].warnings).toHaveLength(1);

    const issue = onlyIssue(result);
    expect(issue.issueCode).toBe('FLAG_DPD_INCONSISTENT');
    expect(issue.severity).toBe('WARNING');
    expect(issue.field).toBe('defaultFlag');
    expect(issue.suggestedCorrection).toBe('true');
    expect(issue.message).toBe(
      '120 days past due but neither default_flag nor credit_impaired_flag is set. ' +
        'Staging will still assign Stage 3 via the DPD backstop.',
    );
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.errorCount).toBe(0);
  });

  it('stays quiet when the credit-impaired flag explains the arrears', () => {
    const rows = mutated('daysPastDue', '120').map((row, index) =>
      index === 0 ? { ...row, creditImpairedFlag: 'true' } : row,
    );
    const result = validateRows(rows);
    expect(result.issues).toEqual([]);
    expect(result.validRows[0].creditImpairedFlag).toBe(true);
  });

  it('stays quiet below the 90-day backstop', () => {
    const result = validateRows(mutated('daysPastDue', '89'));
    expect(result.issues).toEqual([]);
  });
});

describe('oversized rows are rejected before any cell is parsed', () => {
  it('emits ROW_TOO_LARGE against the row rather than a field', () => {
    const result = validate({ maxCellsPerRow: 5 });
    expect(result.validRows).toHaveLength(0);
    expect(result.quarantinedRows).toHaveLength(3);
    expect(codesOf(result)).toEqual(['ROW_TOO_LARGE', 'ROW_TOO_LARGE', 'ROW_TOO_LARGE']);
    expect(result.issues[0].field).toBe('(row)');
    expect(result.issues[0].message).toBe('Row has 28 cells, above the 5 limit');
  });
});

describe('column mapping and header suggestions', () => {
  it('maps the template headers to every field at full confidence', () => {
    const suggested = suggestHeaderMapping(TEMPLATE_HEADERS);
    for (const field of PORTFOLIO_FIELDS) {
      const hit = suggested[field];
      expect(hit, field).not.toBeNull();
      expect(hit?.field).toBe(field);
      expect(hit?.header).toBe(IDENTITY_MAPPING[field]);
      expect(hit?.matchedOn).toBe('LABEL');
      expect(hit?.confidence).toBe(1);
    }
    expect(missingRequiredHeaders(suggested)).toEqual([]);
  });

  it('recognises common source-system aliases at 0.95 confidence', () => {
    const suggested = suggestHeaderMapping(['loan_id', 'dpd', 'eir']);
    expect(suggested.exposureId).toEqual({
      field: 'exposureId',
      header: 'loan_id',
      confidence: 0.95,
      matchedOn: 'ALIAS',
    });
    expect(suggested.daysPastDue?.header).toBe('dpd');
    expect(suggested.daysPastDue?.matchedOn).toBe('ALIAS');
    expect(suggested.effectiveInterestRate?.header).toBe('eir');
    expect(suggested.effectiveInterestRate?.matchedOn).toBe('ALIAS');
  });

  it('treats differently-cased and spaced headers as the same column', () => {
    expect(normalizeHeaderText('Gross Carrying Amount')).toBe('grosscarryingamount');
    expect(normalizeHeaderText('GROSS_CARRYING_AMOUNT')).toBe('grosscarryingamount');
    const suggested = suggestHeaderMapping(['Gross Carrying Amount']);
    expect(suggested.grossCarryingAmount?.matchedOn).toBe('LABEL');
    expect(suggested.grossCarryingAmount?.confidence).toBe(1);
  });

  it('never lets two fields claim the same header', () => {
    const suggested = suggestHeaderMapping([...TEMPLATE_HEADERS, 'balance', 'rating']);
    const claimed = Object.values(suggested)
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
      .map((hit) => hit.header);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('lists exactly the required fields a partial file cannot supply', () => {
    const suggested = suggestHeaderMapping(['loan_id', 'dpd', 'eir']);
    const missing = missingRequiredHeaders(suggested);
    expect(missing).toHaveLength(REQUIRED_FIELDS.length - 3);
    expect(missing).not.toContain('exposureId');
    expect(missing).not.toContain('daysPastDue');
    expect(missing).not.toContain('effectiveInterestRate');
    expect(missing).toContain('borrowerName');
    expect(missing).toContain('lgd');
    // Optional fields are never reported as missing headers.
    expect(missing).not.toContain('undrawnCommitment');
    expect(missing).not.toContain('region');
  });

  it('reports unmapped required columns as file-level issues with no row number', () => {
    const mapping: ColumnMapping = { ...IDENTITY_MAPPING, borrowerName: null };
    const result = applyMapping(
      tableFrom([...TEMPLATE_HEADERS, 'notes'], BASE_ROWS.map(byHeader)),
      mapping,
    );

    expect(result.missingRequiredFields).toEqual(['borrowerName']);
    // Filtered from the file's own header order, so the unmapped canonical
    // column comes before the extra column appended at the end.
    expect(result.unmappedHeaders).toEqual(['borrower_name', 'notes']);

    const issues = mappingIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      rowNumber: null,
      sheetRow: null,
      field: 'borrowerName',
      rawValue: '',
      issueCode: 'UNMAPPED_REQUIRED_COLUMN',
      severity: 'ERROR',
      message: "Required column 'borrower_name' is not mapped to any header in the file",
      suggestedCorrection: null,
    });

    // Every row then fails on the unmapped column, not on a silent empty string.
    const validated = validateImportedRows(result.rows, options());
    expect(validated.validRows).toHaveLength(0);
    expect(validated.quarantinedRows).toHaveLength(3);
    expect(codesOf(validated)).toEqual([
      'MISSING_REQUIRED_FIELD',
      'MISSING_REQUIRED_FIELD',
      'MISSING_REQUIRED_FIELD',
    ]);
  });

  it('keeps the original header text alongside the canonical values', () => {
    const result = applyMapping(
      tableFrom(TEMPLATE_HEADERS, BASE_ROWS.map(byHeader)),
      IDENTITY_MAPPING,
    );
    const [row] = result.rows;
    expect(row.raw.gross_carrying_amount).toBe('1850000.00');
    expect(row.raw.effective_interest_rate).toBe('0.178000');
    expect(row.raw.exposure_id).toBe('EXP-000001');
    expect(Object.keys(row.raw)).toHaveLength(TEMPLATE_HEADERS.length);
    expect(row.values.grossCarryingAmount).toBe('1850000.00');
  });
});

describe('the downloadable template and the error report round-trip', () => {
  /** Minimal quote-aware split; the template quotes only when a cell needs it. */
  const splitCsvLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  };

  it('ships 28 unique headers in the canonical field order', () => {
    expect(TEMPLATE_HEADERS).toHaveLength(28);
    expect(TEMPLATE_HEADERS).toHaveLength(PORTFOLIO_FIELDS.length);
    expect(new Set(TEMPLATE_HEADERS).size).toBe(TEMPLATE_HEADERS.length);
    expect(TEMPLATE_HEADERS).toEqual(PORTFOLIO_FIELDS.map((field) => field.replace(/([A-Z])/g, '_$1').toLowerCase()));
  });

  it('produces a CRLF-terminated CSV with a header line and three examples', () => {
    const csv = buildTemplateCsv();
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.split('\r\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(TEMPLATE_HEADERS.join(','));
  });

  it('validates cleanly when the template is uploaded back unchanged', () => {
    const lines = buildTemplateCsv().split('\r\n').filter((line) => line.length > 0);
    const headers = splitCsvLine(lines[0]);
    expect(headers).toEqual(TEMPLATE_HEADERS);

    const table: RawTable = {
      sourceFileName: 'eclens-portfolio-template.csv',
      sourceFormat: 'CSV',
      headers,
      rows: lines.slice(1).map((line, index) => ({
        rowNumber: index + 1,
        sheetRow: index + 2,
        cells: splitCsvLine(line),
      })),
      truncated: false,
      rowsSkippedByTruncation: 0,
    };

    const suggested = suggestHeaderMapping(headers);
    const mapping = Object.fromEntries(
      PORTFOLIO_FIELDS.map((field) => [field, suggested[field]?.header ?? null]),
    ) as ColumnMapping;

    const applied = applyMapping(table, mapping);
    expect(applied.missingRequiredFields).toEqual([]);
    const result = validateImportedRows(applied.rows, options());
    expect(result.issues).toEqual([]);
    expect(result.validRows).toHaveLength(3);
    expect(result.validRows.map((row) => row.exposureId)).toEqual([
      'EXP-000001',
      'EXP-000002',
      'EXP-000003',
    ]);
  });

  it('exports the error report as CSV with a stable header row', () => {
    const result = validateRows(mutated('lgd', '1.5'));
    const csv = issuesToCsv(result.issues);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      '"row_number","sheet_row","field","raw_value","issue_code","severity","message","suggested_correction"',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"OUT_OF_RANGE_RATE"');
    expect(lines[1]).toContain('"1.5"');
    expect(lines[1]).toContain('"ERROR"');
  });

  it('keeps commas inside a message in a single quoted cell', () => {
    const result = validateRows(mutated('currentCreditRating', 'XYZ'));
    const csv = issuesToCsv(result.issues);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    // The message lists the whole rating scale, so it is full of commas.
    expect(lines[1]).toContain('(AAA, AA, A, BBB, BB, B, CCC, CC, C, D)');
    const cells = splitCsvLine(lines[1]);
    expect(cells).toHaveLength(8);
    expect(cells[4]).toBe('INVALID_RATING');
    expect(cells[6]).toBe(
      "'XYZ' is not on the internal rating scale (AAA, AA, A, BBB, BB, B, CCC, CC, C, D)",
    );
    expect(cells[7]).toBe('');
  });
});
