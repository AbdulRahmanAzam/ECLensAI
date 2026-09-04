/**
 * Historical reporting periods.
 *
 * The point of deriving earlier periods is comparison, and a comparison is only
 * meaningful if the two sides describe the same loans. These tests hold the
 * derivation to that: contractual dates must not move, the credit cycle must
 * actually reverse so exposures genuinely stage lower in the past, and the
 * further back you go the more of today's problem loans must have been
 * performing. A period set that failed any of these would render a migration
 * matrix full of noise and a bridge nobody could explain.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGING_RULE_SET } from '../src/domain/config';
import { addMonths, monthsBetween } from '../src/domain/dates';
import { assessStage, type StagingInput } from '../src/domain/staging';
import { DEFAULT_GENERATOR_OPTIONS, generatePortfolioRows } from '../src/ingest/generator';
import {
  DEFAULT_PERIOD_CYCLE,
  buildHistoricalPeriods,
  type HistoricalPeriod,
} from '../src/ingest/history';
import type { PortfolioField } from '../src/ingest/columns';
import type { Stage } from '../src/types';

const BASE = generatePortfolioRows({
  count: DEFAULT_GENERATOR_OPTIONS.count,
  seed: DEFAULT_GENERATOR_OPTIONS.seed,
  reportingDate: DEFAULT_GENERATOR_OPTIONS.reportingDate,
});

const PERIODS = buildHistoricalPeriods(BASE, {
  baseReportingDate: DEFAULT_GENERATOR_OPTIONS.reportingDate,
  seed: DEFAULT_GENERATOR_OPTIONS.seed,
  currency: DEFAULT_GENERATOR_OPTIONS.currency,
});

const baseById = new Map(BASE.map((row) => [row.values.exposureId, row]));

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

const stageOf = (values: Record<PortfolioField, string>): Stage =>
  assessStage(stagingInputOf(values), DEFAULT_STAGING_RULE_SET).stage;

function stageCounts(rows: { values: Record<PortfolioField, string> }[]): Record<Stage, number> {
  const out: Record<Stage, number> = { 1: 0, 2: 0, 3: 0 };
  for (const row of rows) out[stageOf(row.values)] += 1;
  return out;
}

/** Rows in a period that also exist at the base date — the migration cohort. */
const continuing = (period: HistoricalPeriod): typeof period.rows =>
  period.rows.filter((row) => baseById.has(row.values.exposureId));

const BASE_STAGES = stageCounts(BASE);

describe('historical reporting periods', () => {
  it('builds the configured periods, nearest first, anchored to the base date', () => {
    expect(PERIODS).toHaveLength(DEFAULT_PERIOD_CYCLE.length);
    expect(PERIODS[0].monthsBack).toBeLessThan(PERIODS[1].monthsBack);
    for (const [index, period] of PERIODS.entries()) {
      const definition = DEFAULT_PERIOD_CYCLE[index];
      expect(period.reportingDate).toBe(
        addMonths(DEFAULT_GENERATOR_OPTIONS.reportingDate, -definition.monthsBack),
      );
      expect(period.reportingDate < DEFAULT_GENERATOR_OPTIONS.reportingDate).toBe(true);
      expect(period.inputVersion).toBe(`SEED/${period.reportingDate}/v1`);
    }
  });

  it('is deterministic — rebuilding produces identical rows', () => {
    const rebuilt = buildHistoricalPeriods(BASE, {
      baseReportingDate: DEFAULT_GENERATOR_OPTIONS.reportingDate,
      seed: DEFAULT_GENERATOR_OPTIONS.seed,
      currency: DEFAULT_GENERATOR_OPTIONS.currency,
    });
    expect(rebuilt).toEqual(PERIODS);
  });

  it('treats origination and maturity as contractual facts that do not move', () => {
    for (const period of PERIODS) {
      for (const row of continuing(period)) {
        const base = baseById.get(row.values.exposureId);
        expect(row.values.originationDate).toBe(base?.values.originationDate);
        expect(row.values.maturityDate).toBe(base?.values.maturityDate);
        expect(row.values.reportingDate).toBe(period.reportingDate);
        // Same maturity, earlier reporting date: the horizon genuinely lengthens.
        expect(row.remainingMonths).toBeGreaterThan(base?.remainingMonths ?? 0);
        expect(row.remainingMonths).toBe(
          monthsBetween(period.reportingDate, row.values.maturityDate),
        );
      }
    }
  });

  it('excludes exposures not yet seasoned at the period date and reports them', () => {
    for (const period of PERIODS) {
      expect(period.originatedLaterIds.length).toBeGreaterThan(0);
      const ids = new Set(period.rows.map((row) => row.values.exposureId));
      for (const exposureId of period.originatedLaterIds) {
        expect(ids.has(exposureId), `${exposureId} should not exist yet`).toBe(false);
        const base = baseById.get(exposureId);
        expect(base?.values.originationDate >= period.reportingDate).toBe(true);
      }
    }
  });

  it('adds since-derecognised exposures past the end of the base book, ids never colliding', () => {
    for (const [index, period] of PERIODS.entries()) {
      expect(period.derecognisedIds).toHaveLength(DEFAULT_PERIOD_CYCLE[index].derecognisedCount);
      for (const exposureId of period.derecognisedIds) {
        expect(baseById.has(exposureId), `${exposureId} must not be a current exposure`).toBe(false);
      }
      const rows = period.rows.filter((row) => period.derecognisedIds.includes(row.values.exposureId));
      expect(rows).toHaveLength(period.derecognisedIds.length);
    }

    // Further back, more loans were still on the books: the nearer period's
    // derecognised set is a subset of the further one, so the bridge's
    // derecognition component does not invent and then un-invent the same loan.
    expect(PERIODS[1].derecognisedIds.slice(0, PERIODS[0].derecognisedIds.length)).toEqual(
      PERIODS[0].derecognisedIds,
    );
  });

  it('keeps every derived row internally consistent', () => {
    for (const period of PERIODS) {
      for (const row of period.rows) {
        const values = row.values;
        const pd12 = Number(values.twelveMonthPd);
        const lifetime = Number(values.lifetimePd);
        expect(pd12).toBeGreaterThan(0);
        expect(lifetime).toBeGreaterThanOrEqual(pd12);
        expect(Number(values.lgd)).toBeGreaterThan(0);
        expect(Number(values.lgd)).toBeLessThanOrEqual(0.95);
        expect(Number(values.daysPastDue)).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(Number(values.daysPastDue))).toBe(true);
        expect(values.originationDate < period.reportingDate).toBe(true);
        expect(period.reportingDate < values.maturityDate).toBe(true);
      }
    }
  });

  it('reverses the credit cycle so earlier periods carry strictly less risk', () => {
    let previous = BASE_STAGES;
    for (const period of PERIODS) {
      const counts = stageCounts(period.rows);
      expect(counts[2] + counts[3], period.reportingDate).toBeLessThan(previous[2] + previous[3]);
      expect(counts[1]).toBeGreaterThan(previous[1]);
      expect(counts[2]).toBeGreaterThan(0, 'some Stage 2 must remain for a credible matrix');
      expect(counts[3]).toBeGreaterThan(0, 'some Stage 3 must remain for a credible matrix');
      previous = counts;
    }
  });

  it('produces real stage migration for the same exposures, not a different book', () => {
    const nearest = PERIODS[0];
    const migrations: Record<string, number> = {};
    for (const row of continuing(nearest)) {
      const base = baseById.get(row.values.exposureId);
      if (!base) continue;
      const from = stageOf(row.values);
      const to = stageOf(base.values);
      if (from !== to) migrations[`${from}->${to}`] = (migrations[`${from}->${to}`] ?? 0) + 1;
    }

    // Deterioration only: an exposure may worsen going forward, never improve,
    // because the derivation removes evidence rather than adding it.
    for (const key of Object.keys(migrations)) {
      const [from, to] = key.split('->').map(Number);
      expect(to, `${key} must be a deterioration`).toBeGreaterThan(from as number);
    }
    expect(migrations['1->2'] ?? 0).toBeGreaterThan(20);
    expect(migrations['2->3'] ?? 0).toBeGreaterThan(10);
  });

  it('reverts a superset as the period gets further back', () => {
    const idsOf = (period: HistoricalPeriod): Set<string> =>
      new Set(continuing(period).map((row) => row.values.exposureId));

    // The continuing cohorts differ by construction: a loan originated between
    // the two period dates exists only in the nearer one, and a loan absent from
    // a period cannot have reverted in it. The monotone-reversion claim is
    // therefore made over the cohort that existed at both dates.
    const furthestIds = idsOf(PERIODS[1]);
    const shared = [...idsOf(PERIODS[0])].filter((id) => furthestIds.has(id));
    expect(shared.length).toBeGreaterThan(0);

    const revertedIn = (period: HistoricalPeriod): Set<string> => {
      const stages = new Map(
        continuing(period).map((row) => [row.values.exposureId, stageOf(row.values)]),
      );
      const out = new Set<string>();
      for (const exposureId of shared) {
        const then = stages.get(exposureId);
        const base = baseById.get(exposureId);
        if (base && then !== undefined && then !== stageOf(base.values)) out.add(exposureId);
      }
      return out;
    };

    const nearest = revertedIn(PERIODS[0]);
    const furthest = revertedIn(PERIODS[1]);
    expect(nearest.size).toBeGreaterThan(0);
    expect(furthest.size).toBeGreaterThan(nearest.size);
    for (const exposureId of nearest) expect(furthest.has(exposureId)).toBe(true);
  });

  it('relieves the 12-month PD of every continuing exposure', () => {
    for (const period of PERIODS) {
      for (const row of continuing(period)) {
        const base = baseById.get(row.values.exposureId);
        expect(Number(row.values.twelveMonthPd)).toBeLessThan(Number(base?.values.twelveMonthPd));
      }
    }
  });

  it('leaves the base book exactly as it was generated', () => {
    const regenerated = generatePortfolioRows({
      count: DEFAULT_GENERATOR_OPTIONS.count,
      seed: DEFAULT_GENERATOR_OPTIONS.seed,
      reportingDate: DEFAULT_GENERATOR_OPTIONS.reportingDate,
    });
    expect(BASE).toEqual(regenerated);
    expect(BASE).toHaveLength(DEFAULT_GENERATOR_OPTIONS.count);
  });
});
