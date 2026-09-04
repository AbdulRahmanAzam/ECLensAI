/**
 * Deterministic seed book, demo identity and governance defaults.
 *
 * The generator advertises a target stage and trigger for every row. These
 * tests hold it to that advertisement by running the real staging engine over
 * all 780 exposures: a seeded book whose stated stages do not match what the
 * engine computes would make every demo number, doc example and screenshot
 * wrong, and nothing downstream would notice.
 */
import { describe, expect, it } from 'vitest';
import { formatBps, formatCurrency, formatDate, formatPercent } from '../src/format';
import { dec } from '../src/domain/decimal';
import { monthsBetween } from '../src/domain/dates';
import { DEFAULT_MODEL_CONFIGURATION, DEFAULT_STAGING_RULE_SET } from '../src/domain/config';
import { resolveScenarioSet } from '../src/domain/scenarios';
import {
  NO_SICR_CODE,
  STAGING_RULE_CODES,
  assessStage,
  detectNearStagingThreshold,
  ratingNotchDistance,
  type StagingInput,
} from '../src/domain/staging';
import {
  FIELD_SPECS,
  PORTFOLIO_FIELDS,
  REQUIRED_FIELDS,
  type PortfolioField,
} from '../src/ingest/columns';
import {
  DEFAULT_GENERATOR_OPTIONS,
  RATING_SCALE,
  SEGMENTS,
  TEMPLATE_FIELD_GUIDE,
  TEMPLATE_HEADERS,
  buildSamplePortfolioCsv,
  buildTemplateCsv,
  buildTemplateExampleRows,
  generateContractualSchedule,
  generatePortfolioRows,
} from '../src/ingest/generator';
import {
  applyMapping,
  validateImportedRows,
  type ColumnMapping,
  type RawTable,
} from '../src/ingest/validate';
import {
  DEMO_CURRENCY,
  DEMO_ORGANIZATION,
  DEMO_PASSWORD,
  DEMO_PORTFOLIO_SIZE,
  DEMO_USERS,
  REPORTING_DATE,
  ROLE_PERMISSIONS,
  generateDemoPortfolio,
  permissionsForRole,
} from '../src/synthetic';
import type { RoleName } from '../src/types';

const FLAG_FIELDS = [
  'defaultFlag',
  'creditImpairedFlag',
  'forbearanceFlag',
  'restructuringFlag',
  'watchlistFlag',
] as const;

/** The template's own header row mapped straight back onto the canonical keys. */
const IDENTITY_MAPPING = PORTFOLIO_FIELDS.reduce((mapping, field) => {
  mapping[field] = FIELD_SPECS[field].label;
  return mapping;
}, {} as ColumnMapping);

function rawTableOf(rows: Record<PortfolioField, string>[]): RawTable {
  return {
    sourceFileName: 'seed-portfolio.csv',
    sourceFormat: 'CSV',
    headers: TEMPLATE_HEADERS,
    rows: rows.map((values, index) => ({
      rowNumber: index + 1,
      sheetRow: index + 2,
      cells: PORTFOLIO_FIELDS.map((field) => values[field] ?? ''),
    })),
    truncated: false,
    rowsSkippedByTruncation: 0,
  };
}

function validateBook(rows: Record<PortfolioField, string>[]) {
  const mapped = applyMapping(rawTableOf(rows), IDENTITY_MAPPING);
  return validateImportedRows(mapped.rows, {
    percentageNormalization: 'AS_DECIMAL',
    defaultReportingDate: REPORTING_DATE,
    defaultCurrency: DEMO_CURRENCY,
    effectiveInterestRateMin: DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMin,
    effectiveInterestRateMax: DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMax,
  });
}

function stagingInputOf(values: Record<PortfolioField, string>): StagingInput {
  return {
    daysPastDue: Number(values.daysPastDue),
    defaultFlag: values.defaultFlag === 'true',
    creditImpairedFlag: values.creditImpairedFlag === 'true',
    forbearanceFlag: values.forbearanceFlag === 'true',
    restructuringFlag: values.restructuringFlag === 'true',
    watchlistFlag: values.watchlistFlag === 'true',
    originalCreditRating: values.originalCreditRating,
    currentCreditRating: values.currentCreditRating,
    pdAtOrigination: values.pdAtOrigination,
    currentPd: values.twelveMonthPd,
  };
}

function countBy(items: string[]): Record<string, number> {
  return items.reduce((acc, key) => {
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

const BUNDLE = generateDemoPortfolio();
const ROWS = BUNDLE.rows;
const DECISIONS = ROWS.map((row) => assessStage(stagingInputOf(row.values), DEFAULT_STAGING_RULE_SET));
const VALIDATION = validateBook(ROWS.map((row) => row.values));
const BACKSTOP_ONLY_ROWS = ROWS.filter((row) => row.targetTrigger === 'DPD_DEFAULT_BACKSTOP').length;
const ALL_ROLE_NAMES = Object.keys(ROLE_PERMISSIONS) as RoleName[];

describe('formatters', () => {
  it('formats currency with grouping', () => {
    expect(formatCurrency(1_250_000, 'PKR')).toContain('1,250,000');
  });

  it('formats percentages and basis points', () => {
    expect(formatPercent(0.0423)).toBe('4.23%');
    expect(formatBps(0.0423)).toBe('423 bps');
  });

  it('formats ISO dates deterministically', () => {
    expect(formatDate('2026-08-31')).toBe('31 Aug 2026');
  });
});

describe('demo identity and four-eyes permissions', () => {
  it('seeds one distinct user per role in a single demo organisation', () => {
    expect(DEMO_USERS).toHaveLength(4);
    expect(DEMO_USERS.map((user) => user.role)).toEqual(
      expect.arrayContaining(['ADMIN', 'RISK_ANALYST', 'REVIEWER', 'AUDITOR']),
    );
    expect(new Set(DEMO_USERS.map((user) => user.role)).size).toBe(4);
    expect(new Set(DEMO_USERS.map((user) => user.id)).size).toBe(4);
    expect(new Set(DEMO_USERS.map((user) => user.email)).size).toBe(4);
    for (const user of DEMO_USERS) {
      expect(user.organizationName).toBe(DEMO_ORGANIZATION);
      expect(user.fullName.length).toBeGreaterThan(0);
    }
    expect(DEMO_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });

  it('exposes permissionsForRole as a direct view of the permission map', () => {
    for (const role of ALL_ROLE_NAMES) {
      expect(permissionsForRole(role)).toBe(ROLE_PERMISSIONS[role]);
      expect(new Set(ROLE_PERMISSIONS[role]).size).toBe(ROLE_PERMISSIONS[role].length);
    }
  });

  it('keeps run authorship and run review in different roles', () => {
    expect(ROLE_PERMISSIONS.RISK_ANALYST).toEqual(
      expect.arrayContaining(['run:create', 'run:execute', 'run:submit']),
    );
    expect(ROLE_PERMISSIONS.RISK_ANALYST).not.toContain('run:review');
    expect(ROLE_PERMISSIONS.REVIEWER).toEqual(expect.arrayContaining(['run:review', 'override:review']));
    for (const permission of ['run:create', 'run:execute', 'run:submit', 'exposure:override']) {
      expect(ROLE_PERMISSIONS.REVIEWER).not.toContain(permission);
    }
  });

  it('keeps override request and override review in different roles', () => {
    expect(ROLE_PERMISSIONS.RISK_ANALYST).toContain('exposure:override');
    expect(ROLE_PERMISSIONS.RISK_ANALYST).not.toContain('override:review');
    expect(ROLE_PERMISSIONS.REVIEWER).not.toContain('exposure:override');
  });

  it('gives the auditor read-only access and every role portfolio and audit read', () => {
    // Neither exception mutates state: exporting writes a file, and `ai:use`
    // gates the client-side assistant, which only re-reads figures the auditor
    // is already authorised to see.
    const nonReadExceptions = ['report:export', 'ai:use'];
    for (const permission of ROLE_PERMISSIONS.AUDITOR) {
      expect(
        permission.endsWith(':read') || nonReadExceptions.includes(permission),
        `AUDITOR holds '${permission}', which is neither a read nor an allowed exception`,
      ).toBe(true);
    }
    expect(ROLE_PERMISSIONS.AUDITOR).not.toContain('run:execute');
    expect(ROLE_PERMISSIONS.AUDITOR).not.toContain('exposure:override');
    for (const role of ALL_ROLE_NAMES) {
      expect(permissionsForRole(role)).toEqual(expect.arrayContaining(['portfolio:read', 'audit:read']));
    }
  });
});

describe('seeded portfolio shape', () => {
  it('meets the 750-exposure minimum at the documented size', () => {
    expect(DEMO_PORTFOLIO_SIZE).toBeGreaterThanOrEqual(750);
    expect(ROWS).toHaveLength(DEMO_PORTFOLIO_SIZE);
    expect(REPORTING_DATE).toBe(DEFAULT_GENERATOR_OPTIONS.reportingDate);
    expect(DEMO_CURRENCY).toBe('PKR');
  });

  it('is identical for a fixed seed and different for another one', () => {
    expect(generateDemoPortfolio().rows).toEqual(ROWS);
    const base = generatePortfolioRows({ count: 40 });
    const other = generatePortfolioRows({ count: 40, seed: DEFAULT_GENERATOR_OPTIONS.seed + 1 });
    expect(base.map((row) => row.values.grossCarryingAmount)).not.toEqual(
      other.map((row) => row.values.grossCarryingAmount),
    );
  });

  it('stamps every row with the reporting date, currency and a unique exposure id', () => {
    const ids = ROWS.map((row) => row.values.exposureId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of ROWS) {
      expect(row.values.reportingDate).toBe(REPORTING_DATE);
      expect(row.values.currency).toBe(DEMO_CURRENCY);
      expect(row.values.exposureId).toMatch(/^EXP-\d{6}$/);
      expect(row.values.borrowerId.length).toBeGreaterThan(0);
      expect(row.values.borrowerName.length).toBeGreaterThan(0);
    }
  });

  it('fills every required template field on every row', () => {
    for (const row of ROWS) {
      for (const field of REQUIRED_FIELDS) {
        expect(row.values[field].trim().length, `${row.values.exposureId}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('spreads the book evenly across the five segments', () => {
    const bySegment = countBy(ROWS.map((row) => row.segment));
    expect(Object.keys(bySegment).sort()).toEqual([...SEGMENTS].sort());
    for (const segment of SEGMENTS) {
      expect(bySegment[segment], segment).toBe(DEMO_PORTFOLIO_SIZE / SEGMENTS.length);
    }
  });

  it('represents all three stages in the documented mix', () => {
    expect(countBy(ROWS.map((row) => String(row.targetStage)))).toEqual({ '1': 480, '2': 210, '3': 90 });
  });

  it('uses every staging trigger and the performing code at least once', () => {
    const byTrigger = countBy(ROWS.map((row) => row.targetTrigger));
    for (const code of [...STAGING_RULE_CODES, NO_SICR_CODE]) {
      expect(byTrigger[code], code).toBeGreaterThan(0);
    }
    expect(Object.values(byTrigger).reduce((total, count) => total + count, 0)).toBe(DEMO_PORTFOLIO_SIZE);
  });

  it('still covers every segment and stage in a minimal 26-row book', () => {
    const small = generatePortfolioRows({ count: 26 });
    expect(new Set(small.map((row) => row.segment)).size).toBe(SEGMENTS.length);
    expect(new Set(small.map((row) => row.targetStage)).size).toBe(3);
  });
});

describe('row internal consistency', () => {
  it('keeps every date unambiguously ISO and correctly ordered', () => {
    for (const row of ROWS) {
      const { originationDate, maturityDate, reportingDate } = row.values;
      for (const date of [originationDate, maturityDate, reportingDate]) {
        expect(date, row.values.exposureId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(originationDate < reportingDate, row.values.exposureId).toBe(true);
      expect(maturityDate > reportingDate, row.values.exposureId).toBe(true);
    }
  });

  it('anchors maturity to the reporting date so remainingMonths is exact', () => {
    // `addMonths` clamps to month end and is not associative, so chaining the
    // maturity date off the origination date can yield a row that claims one
    // remaining month while the dates are zero months apart.
    for (const row of ROWS) {
      expect(row.remainingMonths, row.values.exposureId).toBeGreaterThanOrEqual(1);
      expect(
        monthsBetween(row.values.reportingDate, row.values.maturityDate),
        row.values.exposureId,
      ).toBe(row.remainingMonths);
    }
  });

  it('keeps PDs inside [0, 1] with lifetime at or above 12-month', () => {
    for (const row of ROWS) {
      const pd12 = dec(row.values.twelveMonthPd);
      const pdLife = dec(row.values.lifetimePd);
      expect(pd12.greaterThan(0), row.values.exposureId).toBe(true);
      expect(pd12.lessThanOrEqualTo(1), row.values.exposureId).toBe(true);
      expect(pdLife.greaterThanOrEqualTo(pd12), row.values.exposureId).toBe(true);
      expect(pdLife.lessThanOrEqualTo(1), row.values.exposureId).toBe(true);
      expect(dec(row.values.pdAtOrigination).greaterThan(0), row.values.exposureId).toBe(true);
    }
  });

  it('keeps money non-negative and LGD strictly inside (0, 1)', () => {
    for (const row of ROWS) {
      expect(dec(row.values.grossCarryingAmount).greaterThan(0), row.values.exposureId).toBe(true);
      expect(dec(row.values.undrawnCommitment).greaterThanOrEqualTo(0)).toBe(true);
      expect(dec(row.values.collateralValue).greaterThanOrEqualTo(0)).toBe(true);
      const lgd = dec(row.values.lgd);
      expect(lgd.greaterThan(0), row.values.exposureId).toBe(true);
      expect(lgd.lessThan(1), row.values.exposureId).toBe(true);
    }
  });

  it('offers a credit conversion factor only where there is an undrawn commitment', () => {
    for (const row of ROWS) {
      const ccf = dec(row.values.creditConversionFactor);
      expect(ccf.greaterThanOrEqualTo(0)).toBe(true);
      expect(ccf.lessThanOrEqualTo(1), row.values.exposureId).toBe(true);
      expect(ccf.greaterThan(0), row.values.exposureId).toBe(
        dec(row.values.undrawnCommitment).greaterThan(0),
      );
    }
  });

  it('keeps the effective interest rate inside the configured supported range', () => {
    const min = dec(DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMin);
    const max = dec(DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMax);
    for (const row of ROWS) {
      const eir = dec(row.values.effectiveInterestRate);
      expect(eir.greaterThan(0), row.values.exposureId).toBe(true);
      expect(eir.greaterThanOrEqualTo(min), row.values.exposureId).toBe(true);
      expect(eir.lessThanOrEqualTo(max), row.values.exposureId).toBe(true);
    }
  });

  it('uses only canonical ratings and never upgrades one', () => {
    const scale = new Set<string>(RATING_SCALE);
    for (const row of ROWS) {
      expect(scale.has(row.values.originalCreditRating), row.values.exposureId).toBe(true);
      expect(scale.has(row.values.currentCreditRating), row.values.exposureId).toBe(true);
      expect(
        ratingNotchDistance(row.values.originalCreditRating, row.values.currentCreditRating),
        row.values.exposureId,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('emits flags as the lowercase booleans the ingest parser accepts', () => {
    for (const row of ROWS) {
      for (const field of FLAG_FIELDS) {
        expect(['true', 'false'], `${row.values.exposureId}.${field}`).toContain(row.values[field]);
      }
    }
  });
});

describe('the generated book stages exactly as advertised', () => {
  it('reproduces the advertised stage for every exposure', () => {
    const mismatches: string[] = [];
    ROWS.forEach((row, index) => {
      if (DECISIONS[index].modelStage !== row.targetStage) {
        mismatches.push(
          `${row.values.exposureId} ${row.segment} target=${row.targetStage} got=${DECISIONS[index].modelStage} rule=${DECISIONS[index].primaryRuleCode}`,
        );
      }
    });
    expect(mismatches).toEqual([]);
  });

  it('names the advertised trigger as the primary reason code', () => {
    const mismatches: string[] = [];
    ROWS.forEach((row, index) => {
      if (DECISIONS[index].primaryRuleCode !== row.targetTrigger) {
        mismatches.push(
          `${row.values.exposureId} target=${row.targetTrigger} got=${DECISIONS[index].primaryRuleCode}`,
        );
      }
    });
    expect(mismatches).toEqual([]);
    expect(countBy(DECISIONS.map((decision) => decision.primaryRuleCode))).toEqual(
      countBy(ROWS.map((row) => row.targetTrigger)),
    );
  });

  it('returns a fully explainable decision for every exposure', () => {
    DECISIONS.forEach((decision, index) => {
      const id = ROWS[index].values.exposureId;
      expect(decision.primaryReason.length, id).toBeGreaterThan(0);
      expect(decision.ruleSetId, id).toBe(DEFAULT_STAGING_RULE_SET.id);
      expect(decision.ruleSetVersion, id).toBe(DEFAULT_STAGING_RULE_SET.version);
      expect(decision.hasOverride, id).toBe(false);
      expect(decision.override, id).toBeNull();
      expect(decision.stage, id).toBe(ROWS[index].targetStage);
      expect(decision.modelStage, id).toBe(decision.stage);
      if (decision.stage === 1) {
        expect(decision.triggeredRules, id).toEqual([]);
        expect(decision.primaryRuleCode, id).toBe(NO_SICR_CODE);
      } else {
        expect(decision.triggeredRules.length, id).toBeGreaterThan(0);
        for (const rule of decision.triggeredRules) {
          expect(rule.reason.length, id).toBeGreaterThan(0);
          expect(rule.sourceFields.length, id).toBeGreaterThan(0);
          expect([2, 3], id).toContain(rule.stage);
        }
        // Every rule that fired is listed, highest stage first; the decision
        // takes the highest, so a Stage 3 row that is also 30+ days past due
        // legitimately carries a Stage 2 rule alongside the Stage 3 one.
        const stages = decision.triggeredRules.map((rule) => rule.stage);
        expect(stages, id).toEqual([...stages].sort((a, b) => b - a));
        expect(stages[0], id).toBe(decision.stage);
        expect(decision.triggeredRules[0].code, id).toBe(decision.primaryRuleCode);
      }
    });
  });

  it('puts every segment in every stage', () => {
    // Regression guard: a stage-plan period aligned with the five-segment round
    // robin makes `index % period` determine `index % 5`, so Stage 3 could only
    // ever land on three segments and no microfinance or corporate exposure was
    // ever credit impaired. The period is coprime with five for this reason.
    const matrix: Record<string, Record<number, number>> = {};
    ROWS.forEach((row, index) => {
      matrix[row.segment] = matrix[row.segment] ?? { 1: 0, 2: 0, 3: 0 };
      matrix[row.segment][DECISIONS[index].modelStage] += 1;
    });
    for (const segment of SEGMENTS) {
      expect(matrix[segment], segment).toEqual({ 1: 96, 2: 42, 3: 18 });
    }
  });

  it('realizes the configured notch distance on every downgrade-driven Stage 2 row', () => {
    // `downgradeRating` clamps at 'D', so a downgrade requested from a rating
    // too close to the bottom of the scale materializes short of the threshold.
    const shortfall: string[] = [];
    ROWS.forEach((row, index) => {
      if (row.targetTrigger !== 'RATING_DOWNGRADE_SICR') return;
      const notches = ratingNotchDistance(row.values.originalCreditRating, row.values.currentCreditRating);
      if (notches < DEFAULT_STAGING_RULE_SET.ratingNotchSicrThreshold) {
        shortfall.push(
          `${row.values.exposureId} ${row.values.originalCreditRating}->${row.values.currentCreditRating} = ${notches}`,
        );
      }
      expect(DECISIONS[index].primaryRuleCode, row.values.exposureId).toBe('RATING_DOWNGRADE_SICR');
    });
    expect(shortfall).toEqual([]);
  });

  it('satisfies both limbs of the PD-increase rule where it is advertised', () => {
    // The rule is an AND of a positive origination PD, a *current* PD at or
    // above the absolute floor, and a ratio at or above the multiple. For
    // low-PD segments the floor is the limb that silently fails.
    const floor = dec(DEFAULT_STAGING_RULE_SET.pdIncreaseSicrAbsoluteFloor);
    const multiple = dec(DEFAULT_STAGING_RULE_SET.pdIncreaseSicrMultiple);
    const failures: string[] = [];
    ROWS.forEach((row, index) => {
      if (row.targetTrigger !== 'PD_INCREASE_SICR') return;
      const current = dec(row.values.twelveMonthPd);
      const origination = dec(row.values.pdAtOrigination);
      if (current.lessThan(floor) || current.div(origination).lessThan(multiple)) {
        failures.push(`${row.values.exposureId} ${row.segment} pd=${current} orig=${origination}`);
      }
      expect(DECISIONS[index].primaryRuleCode, row.values.exposureId).toBe('PD_INCREASE_SICR');
    });
    expect(failures).toEqual([]);
  });

  it('never lets a performing row trip any Stage 2 or Stage 3 rule', () => {
    ROWS.forEach((row, index) => {
      if (row.targetStage !== 1) return;
      const values = row.values;
      expect(DECISIONS[index].triggeredRules, values.exposureId).toEqual([]);
      expect(Number(values.daysPastDue), values.exposureId).toBeLessThan(
        DEFAULT_STAGING_RULE_SET.stage2DpdThreshold,
      );
      expect(
        ratingNotchDistance(values.originalCreditRating, values.currentCreditRating),
        values.exposureId,
      ).toBeLessThan(DEFAULT_STAGING_RULE_SET.ratingNotchSicrThreshold);
      expect(
        dec(values.twelveMonthPd).div(dec(values.pdAtOrigination)).lessThan(
          dec(DEFAULT_STAGING_RULE_SET.pdIncreaseSicrMultiple),
        ),
        values.exposureId,
      ).toBe(true);
      for (const field of FLAG_FIELDS) {
        expect(values[field], `${values.exposureId}.${field}`).toBe('false');
      }
    });
  });

  it('backs every Stage 3 row with a flag or the configured default backstop', () => {
    ROWS.forEach((row, index) => {
      if (row.targetStage !== 3) return;
      const values = row.values;
      const flagged = values.defaultFlag === 'true' || values.creditImpairedFlag === 'true';
      const pastDue = Number(values.daysPastDue);
      expect(
        flagged || pastDue >= DEFAULT_STAGING_RULE_SET.stage3DpdThreshold,
        values.exposureId,
      ).toBe(true);
      expect(DECISIONS[index].stage, values.exposureId).toBe(3);
    });
  });

  it('resolves precedence where several rules fire on one exposure', () => {
    // Non-vacuous: the seeded book must actually contain multi-rule exposures,
    // otherwise the precedence path would never be exercised.
    const multiRule = DECISIONS.filter((decision) => decision.triggeredRules.length > 1);
    expect(multiRule.length).toBeGreaterThan(0);
    for (const decision of multiRule) {
      const highest = Math.max(...decision.triggeredRules.map((rule) => rule.stage));
      expect(decision.stage).toBe(highest);
      expect(decision.modelStage).toBe(highest);
      expect(decision.triggeredRules[0].stage).toBe(highest);
      expect(decision.primaryRuleCode).toBe(decision.triggeredRules[0].code);
    }
  });
});

describe('the seeded book passes ingestion untouched', () => {
  it('maps cleanly against its own template headers', () => {
    const mapped = applyMapping(rawTableOf(ROWS.map((row) => row.values)), IDENTITY_MAPPING);
    expect(mapped.missingRequiredFields).toEqual([]);
    expect(mapped.unmappedHeaders).toEqual([]);
    expect(mapped.rows).toHaveLength(DEMO_PORTFOLIO_SIZE);
  });

  it('validates every row with nothing quarantined', () => {
    expect(VALIDATION.summary).toEqual({
      totalRows: DEMO_PORTFOLIO_SIZE,
      validRows: DEMO_PORTFOLIO_SIZE,
      quarantinedRows: 0,
      errorCount: 0,
      warningCount: BACKSTOP_ONLY_ROWS,
      infoCount: 0,
      duplicateCount: 0,
      issuesByCode: { FLAG_DPD_INCONSISTENT: BACKSTOP_ONLY_ROWS },
    });
    expect(VALIDATION.quarantinedRows).toEqual([]);
    expect(VALIDATION.validRows).toHaveLength(DEMO_PORTFOLIO_SIZE);
    expect(BACKSTOP_ONLY_ROWS).toBe(30);
  });

  it('warns about past-due rows that carry no default flag instead of repairing them', () => {
    // 90+ days past due with neither flag set is exactly the inconsistency the
    // exception queue exists to surface, so it is a warning, never a silent fix.
    const warnings = VALIDATION.issues.filter((issue) => issue.issueCode === 'FLAG_DPD_INCONSISTENT');
    expect(warnings).toHaveLength(BACKSTOP_ONLY_ROWS);
    for (const issue of warnings) {
      expect(issue.severity).toBe('WARNING');
      expect(issue.rowNumber).not.toBeNull();
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a re-upload of exposures the organisation already holds', () => {
    const mapped = applyMapping(
      rawTableOf(ROWS.slice(0, 20).map((row) => row.values)),
      IDENTITY_MAPPING,
    );
    const result = validateImportedRows(mapped.rows, {
      percentageNormalization: 'AS_DECIMAL',
      existingExposureIds: ROWS.slice(0, 10).map((row) => row.values.exposureId),
    });
    expect(result.summary.duplicateCount).toBe(10);
    expect(result.summary.validRows).toBe(10);
    expect(result.summary.quarantinedRows).toBe(10);
  });
});

describe('contractual amortization schedules', () => {
  const termRows = ROWS.filter((row) => row.hasContractualSchedule);

  it('supplies a schedule for exactly the rows that declare one', () => {
    expect(termRows.length).toBeGreaterThan(0);
    expect(Object.keys(BUNDLE.schedules)).toHaveLength(termRows.length);
    for (const row of termRows) {
      expect(BUNDLE.schedules[row.values.exposureId], row.values.exposureId).toBeDefined();
    }
  });

  it('amortizes level principal from the full drawn balance over the remaining term', () => {
    for (const row of termRows) {
      const schedule = BUNDLE.schedules[row.values.exposureId];
      const drawn = dec(row.values.grossCarryingAmount);
      expect(schedule, row.values.exposureId).toHaveLength(row.remainingMonths);
      schedule.forEach((point, index) => expect(point.period, row.values.exposureId).toBe(index + 1));
      expect(dec(schedule[0].drawnBalance).equals(drawn), row.values.exposureId).toBe(true);
      for (let index = 1; index < schedule.length; index += 1) {
        expect(
          dec(schedule[index].drawnBalance).lessThan(dec(schedule[index - 1].drawnBalance)),
          row.values.exposureId,
        ).toBe(true);
      }
      const residual = dec(schedule[schedule.length - 1].drawnBalance);
      expect(residual.greaterThan(0), row.values.exposureId).toBe(true);
      expect(
        residual.lessThanOrEqualTo(drawn.div(schedule.length).plus('0.01')),
        row.values.exposureId,
      ).toBe(true);
      for (const point of schedule) {
        expect(point.undrawnCommitment, row.values.exposureId).toBe(row.values.undrawnCommitment);
      }
    }
  });

  it('is reproducible from the row alone', () => {
    const row = termRows[0];
    expect(generateContractualSchedule(row)).toEqual(BUNDLE.schedules[row.values.exposureId]);
  });
});

describe('downloadable template and sample file', () => {
  it('documents every canonical field in template order', () => {
    expect(TEMPLATE_FIELD_GUIDE).toHaveLength(PORTFOLIO_FIELDS.length);
    expect(TEMPLATE_FIELD_GUIDE.map((entry) => entry.field)).toEqual([...PORTFOLIO_FIELDS]);
    expect(TEMPLATE_HEADERS).toHaveLength(PORTFOLIO_FIELDS.length);
    expect(new Set(TEMPLATE_HEADERS).size).toBe(TEMPLATE_HEADERS.length);
    for (const entry of TEMPLATE_FIELD_GUIDE) {
      expect(entry.header.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('ships one example row per stage that the engine agrees with', () => {
    const examples = buildTemplateExampleRows();
    expect(examples).toHaveLength(3);
    expect(examples.map((row) => row.exposureId)).toEqual(['EXP-000001', 'EXP-000002', 'EXP-000003']);
    expect(validateBook(examples).summary.errorCount).toBe(0);
    expect(
      examples.map(
        (values) => assessStage(stagingInputOf(values), DEFAULT_STAGING_RULE_SET).stage,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('renders the blank template and the full sample as canonical CSV', () => {
    const template = buildTemplateCsv().split('\r\n');
    expect(template[0]).toBe(TEMPLATE_HEADERS.join(','));
    expect(template).toHaveLength(5);
    expect(template[4]).toBe('');

    const sample = buildSamplePortfolioCsv().split('\r\n');
    expect(sample[0]).toBe(TEMPLATE_HEADERS.join(','));
    expect(sample).toHaveLength(DEMO_PORTFOLIO_SIZE + 2);
    expect(sample[DEMO_PORTFOLIO_SIZE + 1]).toBe('');
    expect(sample[1].startsWith('EXP-000001,BOR-000001,')).toBe(true);
  });
});

describe('governance defaults shipped with the bundle', () => {
  it('resolves the default scenario set with normalized active weights', () => {
    const resolved = resolveScenarioSet(BUNDLE.scenarioSet);
    expect(resolved.activeScenarios.map((scenario) => scenario.code)).toEqual([
      'BASE',
      'UPSIDE',
      'DOWNSIDE',
    ]);
    expect(resolved.activeScenarios.map((scenario) => scenario.weight.toString())).toEqual([
      '0.5',
      '0.2',
      '0.3',
    ]);
    expect(resolved.weightTotal.toString()).toBe('1');
    expect(resolved.activeScenarios.map((scenario) => scenario.pdMultiplier.toFixed(2))).toEqual([
      '1.00',
      '0.75',
      '1.45',
    ]);
    expect(resolved.activeScenarios.map((scenario) => scenario.lgdMultiplier.toFixed(2))).toEqual([
      '1.00',
      '0.92',
      '1.08',
    ]);
  });

  it('hands out the versioned model configuration and its staging rule set', () => {
    expect(BUNDLE.modelConfiguration).toBe(DEFAULT_MODEL_CONFIGURATION);
    expect(BUNDLE.modelConfiguration.stagingRuleSet).toBe(DEFAULT_STAGING_RULE_SET);
    expect(BUNDLE.modelConfiguration.version).toBe('1.0.0');
    expect(BUNDLE.modelConfiguration.twelveMonthWindow).toBe(12);
    expect(BUNDLE.scenarioSet.version).toBe('1.0.0');
  });
});

describe('exception queue material in the seeded book', () => {
  it('flags exposures sitting just below the Stage 3 days-past-due backstop', () => {
    const threshold = DEFAULT_STAGING_RULE_SET.stage3DpdThreshold;
    const buffer = DEFAULT_STAGING_RULE_SET.nearThresholdDpdBufferDays;
    let nearStage3 = 0;
    for (const row of ROWS) {
      const signal = detectNearStagingThreshold(stagingInputOf(row.values), DEFAULT_STAGING_RULE_SET);
      const pastDue = Number(row.values.daysPastDue);
      expect(signal.nearStage3Dpd, row.values.exposureId).toBe(
        pastDue >= threshold - buffer && pastDue < threshold,
      );
      if (signal.nearStage3Dpd) {
        expect(signal.messages.length, row.values.exposureId).toBeGreaterThan(0);
        nearStage3 += 1;
      }
      for (const message of signal.messages) {
        expect(message.length, row.values.exposureId).toBeGreaterThan(0);
      }
    }
    expect(nearStage3).toBeGreaterThan(0);
  });
});
