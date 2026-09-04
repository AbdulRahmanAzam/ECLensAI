/**
 * Deterministic historical reporting periods for the demonstration book.
 *
 * A single snapshot can answer "what is the allowance now" but not "why did it
 * move", and the movement bridge, the stage migration matrix and the coverage
 * trend all need at least two periods to say anything at all. This module builds
 * those earlier periods from the *same* generated book rather than inventing a
 * second one, so the loans are genuinely the same loans and a stage transition
 * means an exposure actually moved.
 *
 * Three principles keep the result honest:
 *
 *   1. **Only inputs are derived; every output is still computed.** This file
 *      perturbs PD, LGD, days-past-due, ratings and credit flags to describe an
 *      earlier, better point in the credit cycle. It never writes an allowance,
 *      a stage or a total. The Decimal engine in `domain/ecl.ts` produces those
 *      from the perturbed inputs exactly as it does for the current period.
 *   2. **Contractual dates are facts.** Origination and maturity come from the
 *      base book unchanged. Only `reportingDate` moves, so an exposure naturally
 *      has a longer remaining horizon in an earlier period — and one originated
 *      after that date simply does not exist yet, which is where the bridge's
 *      "new originations" component comes from rather than from an arbitrary
 *      exclusion list.
 *   3. **The current period is untouched.** Rows for the base reporting date come
 *      from `generateDemoPortfolio()` verbatim. Derivation runs backwards only,
 *      so the book the existing tests and docs describe stays byte-identical.
 *
 * Gross balances are deliberately *not* scaled per period: holding them constant
 * isolates credit deterioration as the reason the allowance grew, which is the
 * question the demonstration has to answer. Amortization is still modelled, via
 * the contractual schedule regenerated against each period's longer horizon.
 */
import { addMonths, monthsBetween } from '../domain/dates';
import {
  generatePortfolioRows,
  shiftRating,
  templateMoney,
  templateRate,
  type GeneratedExposureRow,
} from './generator';

/** How much better credit looked at an earlier date, and how much of it reverts. */
export interface PeriodCycleDefinition {
  /** Whole months before the base reporting date. */
  monthsBack: number;
  /** Multiplies the current 12-month PD. Below 1: the cycle has since turned. */
  pdRelief: number;
  /** Multiplies LGD. Below 1: recoveries were assumed slightly better. */
  lgdRelief: number;
  /** Multiplies days past due, so some backstops had not yet been breached. */
  dpdRelief: number;
  /**
   * Share of today's Stage 2 exposures whose SICR evidence had not yet
   * materialised at this date. Applied as `exposureIndex % 100 < share * 100`,
   * so a longer-ago period reverts a strict superset of a nearer one and the
   * migration path stays monotone.
   */
  stage2ReversionShare: number;
  /** Share of today's Stage 3 exposures that were merely Stage 2 then. */
  stage3ReversionShare: number;
  /**
   * Exposures that existed at this date and have since been repaid or
   * derecognised. Generated past the end of the base book, so their ids never
   * collide with a loan still on the books.
   */
  derecognisedCount: number;
}

export interface HistoricalPeriod {
  reportingDate: string;
  monthsBack: number;
  label: string;
  publicId: string;
  /** Lineage key in the same shape the current snapshot uses. */
  inputVersion: string;
  rows: GeneratedExposureRow[];
  /** Ids present here but not at the base date: repaid or derecognised since. */
  derecognisedIds: string[];
  /** Base-date ids absent here: originated on or after this date, so unseasoned. */
  originatedLaterIds: string[];
}

/**
 * Three months apart, worsening monotonically toward the present. The nearer
 * period reverts less than the further one, so Feb < May < Aug in allowance and
 * the trend line has a direction a judge can read without being told.
 */
export const DEFAULT_PERIOD_CYCLE: readonly PeriodCycleDefinition[] = [
  {
    monthsBack: 3,
    pdRelief: 0.88,
    lgdRelief: 0.97,
    dpdRelief: 0.55,
    stage2ReversionShare: 0.35,
    stage3ReversionShare: 0.3,
    derecognisedCount: 24,
  },
  {
    monthsBack: 6,
    pdRelief: 0.78,
    lgdRelief: 0.95,
    dpdRelief: 0.3,
    stage2ReversionShare: 0.6,
    stage3ReversionShare: 0.55,
    derecognisedCount: 48,
  },
] as const;

export interface HistoricalPeriodOptions {
  baseReportingDate: string;
  seed: number;
  currency: string;
  cycle?: readonly PeriodCycleDefinition[];
}

/** `EXP-000042` -> 42. Used for the deterministic reversion subsets. */
function exposureIndexOf(exposureId: string): number {
  const digits = exposureId.replace(/\D/g, '');
  return digits.length > 0 ? Number.parseInt(digits, 10) : 0;
}

function reverts(share: number, index: number): boolean {
  return index % 100 < Math.round(share * 100);
}

/**
 * Rewrites one base exposure as it looked at an earlier reporting date.
 *
 * The reverted branches do not merely soften a number: they remove the specific
 * piece of evidence the staging rule reads, so the exposure genuinely stages
 * lower. A Stage 2 row reverted on its trigger loses the downgrade, or the
 * forbearance flag, or drops below the 30-day backstop — whichever one put it
 * there — because clearing the wrong field would leave it in Stage 2 and the
 * migration matrix would show nothing.
 */
function toPeriodRow(
  base: GeneratedExposureRow,
  periodDate: string,
  definition: PeriodCycleDefinition,
): GeneratedExposureRow {
  const values = { ...base.values } as Record<string, string>;
  const index = exposureIndexOf(values.exposureId);

  values.reportingDate = periodDate;

  const basePd = Number(values.twelveMonthPd);
  let daysPastDue = Number.parseInt(values.daysPastDue, 10);
  let twelveMonthPd = basePd * definition.pdRelief;
  const lgd = Number(values.lgd) * definition.lgdRelief;

  if (base.targetStage === 2 && reverts(definition.stage2ReversionShare, index)) {
    // Still performing at this date: withdraw every SICR trigger the row carries.
    values.forbearanceFlag = 'false';
    values.restructuringFlag = 'false';
    values.watchlistFlag = 'false';
    values.currentCreditRating = values.originalCreditRating;
    daysPastDue = daysPastDue % 30;
    // Below the 1.5x PD-increase multiple, so that test cannot fire either — and
    // never above the relieved current PD, because a row staged 2 on a flag, a
    // downgrade or the DPD backstop carries its origination PD unchanged, and
    // 1.1x of that would make the past look worse than the present.
    twelveMonthPd = Math.min(Number(values.pdAtOrigination) * 1.1, twelveMonthPd);
  } else if (base.targetStage === 3 && reverts(definition.stage3ReversionShare, index)) {
    // Credit-impaired today, significantly increased in credit risk back then.
    values.defaultFlag = 'false';
    values.creditImpairedFlag = 'false';
    values.forbearanceFlag = 'false';
    values.restructuringFlag = 'false';
    values.watchlistFlag = 'false';
    daysPastDue = 30 + (daysPastDue % 60);
    values.currentCreditRating = shiftRating(values.originalCreditRating, 2);
  } else {
    daysPastDue = Math.floor(daysPastDue * definition.dpdRelief);
  }

  values.daysPastDue = String(daysPastDue);
  values.twelveMonthPd = templateRate(twelveMonthPd);
  values.lgd = templateRate(lgd);
  // Balances and collateral are held at their base-date values on purpose.
  values.collateralValue = templateMoney(Number(values.collateralValue));

  // Contractual maturity is unchanged, so the horizon genuinely lengthens.
  const remainingMonths = Math.max(1, monthsBetween(periodDate, values.maturityDate));
  const years = remainingMonths / 12;
  const lifetimePd = Math.min(1 - Math.pow(1 - twelveMonthPd, Math.max(years, 1)), 0.98);
  values.lifetimePd = templateRate(Math.max(lifetimePd, twelveMonthPd));

  return {
    values: values as GeneratedExposureRow['values'],
    // Construction metadata from the base book. The engine re-derives the actual
    // stage from the fields above, and for a reverted row it derives a lower one.
    targetStage: base.targetStage,
    targetTrigger: base.targetTrigger,
    segment: base.segment,
    productType: base.productType,
    remainingMonths,
    hasContractualSchedule: base.hasContractualSchedule,
  };
}

/**
 * Builds the earlier reporting periods, nearest first.
 *
 * Rows past the end of the base book are generated with the same PRNG seed and
 * the period's own reporting date. `stagePlan` keys off `index % 26` and each
 * index consumes a fixed number of draws, so the first `baseRows.length` rows of
 * a larger generation are identical to the base generation — which is what makes
 * the extra ids a clean superset rather than a reshuffle.
 */
export function buildHistoricalPeriods(
  baseRows: GeneratedExposureRow[],
  options: HistoricalPeriodOptions,
): HistoricalPeriod[] {
  const cycle = options.cycle ?? DEFAULT_PERIOD_CYCLE;
  const baseById = new Map(baseRows.map((row) => [row.values.exposureId, row]));
  const periods: HistoricalPeriod[] = [];

  for (const definition of cycle) {
    const reportingDate = addMonths(options.baseReportingDate, -definition.monthsBack);
    const generated = generatePortfolioRows({
      count: baseRows.length + definition.derecognisedCount,
      seed: options.seed,
      reportingDate,
      currency: options.currency,
    });

    const rows: GeneratedExposureRow[] = [];
    const derecognisedIds: string[] = [];
    const originatedLaterIds: string[] = [];

    for (const candidate of generated) {
      const exposureId = candidate.values.exposureId;
      const base = baseById.get(exposureId);

      if (!base) {
        // Past the end of the base book: on the books then, repaid since.
        derecognisedIds.push(exposureId);
        rows.push(candidate);
        continue;
      }

      // ISO dates sort lexicographically, so this is a date comparison. `>=`
      // rather than `>`: origination is anchored to the base reporting date, so
      // a loan with exactly 3 or 6 elapsed months lands precisely on a derived
      // month-end period date. It exists then, but with zero seasoning — no
      // elapsed month and no payment history to stage against.
      if (base.values.originationDate >= reportingDate) {
        originatedLaterIds.push(exposureId);
        continue;
      }

      rows.push(toPeriodRow(base, reportingDate, definition));
    }

    periods.push({
      reportingDate,
      monthsBack: definition.monthsBack,
      label: `Seeded portfolio as at ${reportingDate}`,
      publicId: `SNAP-${reportingDate}`,
      inputVersion: `SEED/${reportingDate}/v1`,
      rows,
      derecognisedIds,
      originatedLaterIds,
    });
  }

  return periods;
}
