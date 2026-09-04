/**
 * Deterministic synthetic PKR portfolio generator.
 *
 * Produces realistic but entirely fictional exposures in the canonical import
 * template shape, so the exact same rows can be (a) downloaded as a CSV/XLSX
 * sample file, (b) uploaded through the import pipeline, and (c) written
 * directly by the seed script. Seeded PRNG + fixed reporting date means byte
 * identical output on every machine.
 *
 * Stage coverage is intentional: each row carries a `targetStage` and its
 * days-past-due, flags, ratings and PD-at-origination are set so the staging
 * engine actually derives that stage. Stage 2 and Stage 3 rows rotate through
 * every configured trigger so the seeded book demonstrates each reason code.
 */
import { addMonths } from '../domain/dates';
import { DEFAULT_STAGING_RULE_SET } from '../domain/config';
import type { Stage } from '../types';
import { FIELD_SPEC_LIST, PORTFOLIO_FIELDS, type PortfolioField } from './columns';

export const TEMPLATE_HEADERS: string[] = FIELD_SPEC_LIST.map((spec) => spec.label);

export const DEFAULT_GENERATOR_OPTIONS = {
  count: 780,
  seed: 20260831,
  reportingDate: '2026-08-31',
  currency: 'PKR',
} as const;

export interface GeneratorOptions {
  count?: number;
  seed?: number;
  reportingDate?: string;
  currency?: string;
}

export interface GeneratedExposureRow {
  /** Canonical field -> template-format string value. */
  values: Record<PortfolioField, string>;
  /** The stage this row is constructed to produce. */
  targetStage: Stage;
  /** The staging trigger the row is built to exercise. */
  targetTrigger: string;
  segment: string;
  productType: string;
  /** Remaining contractual months from the reporting date. */
  remainingMonths: number;
  /** True when the row should be given a contractual amortization schedule. */
  hasContractualSchedule: boolean;
}

/** Deterministic PRNG — same seed, same portfolio, everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const between = (rand: () => number, min: number, max: number): number => min + rand() * (max - min);
const intBetween = (rand: () => number, min: number, max: number): number => Math.floor(between(rand, min, max + 1));

export const RATING_SCALE = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'CC', 'C', 'D'] as const;

export const SEGMENTS = ['consumer', 'sme', 'agriculture', 'microfinance', 'corporate'] as const;
export type Segment = (typeof SEGMENTS)[number];

interface SegmentProfile {
  segment: Segment;
  products: readonly string[];
  industries: readonly string[];
  /** Drawn balance range in PKR. */
  amountRange: readonly [number, number];
  /** Tenor range in months at origination. */
  tenorRange: readonly [number, number];
  /** Base 12-month PD range, decimal. */
  pdRange: readonly [number, number];
  /** LGD range, decimal. */
  lgdRange: readonly [number, number];
  /** Share of products that carry an undrawn commitment. */
  undrawnShare: number;
  ccfRange: readonly [number, number];
  eirRange: readonly [number, number];
  /** Share of rows given a contractual amortization schedule. */
  scheduleShare: number;
  /** Typical origination rating band (index into RATING_SCALE). */
  ratingBand: readonly [number, number];
  borrowerStyle: 'PERSON' | 'COMPANY';
}

export const SEGMENT_PROFILES: Record<Segment, SegmentProfile> = {
  consumer: {
    segment: 'consumer',
    products: ['auto_loan', 'personal_loan', 'credit_card', 'home_mortgage', 'education_loan'],
    industries: ['Salaried - Private', 'Salaried - Public', 'Self Employed', 'Professional Services'],
    amountRange: [180_000, 18_000_000],
    tenorRange: [12, 84],
    pdRange: [0.004, 0.055],
    lgdRange: [0.28, 0.62],
    undrawnShare: 0.28,
    ccfRange: [0.4, 0.75],
    eirRange: [0.14, 0.28],
    scheduleShare: 0.72,
    ratingBand: [2, 6],
    borrowerStyle: 'PERSON',
  },
  sme: {
    segment: 'sme',
    products: ['working_capital', 'term_loan', 'trade_finance', 'equipment_finance', 'overdraft'],
    industries: ['Textiles', 'Manufacturing', 'Retail Trade', 'Construction', 'Food & Beverage', 'Logistics'],
    amountRange: [2_500_000, 145_000_000],
    tenorRange: [12, 72],
    pdRange: [0.008, 0.085],
    lgdRange: [0.35, 0.68],
    undrawnShare: 0.55,
    ccfRange: [0.45, 0.8],
    eirRange: [0.15, 0.26],
    scheduleShare: 0.55,
    ratingBand: [3, 7],
    borrowerStyle: 'COMPANY',
  },
  agriculture: {
    segment: 'agriculture',
    products: ['crop_loan', 'livestock_finance', 'tubewell_finance', 'orchard_finance', 'agri_machinery'],
    industries: ['Cotton', 'Wheat', 'Rice', 'Dairy & Livestock', 'Sugarcane', 'Horticulture'],
    amountRange: [320_000, 28_000_000],
    tenorRange: [12, 60],
    pdRange: [0.012, 0.095],
    lgdRange: [0.4, 0.72],
    undrawnShare: 0.3,
    ccfRange: [0.35, 0.6],
    eirRange: [0.11, 0.21],
    scheduleShare: 0.45,
    ratingBand: [4, 7],
    borrowerStyle: 'PERSON',
  },
  microfinance: {
    segment: 'microfinance',
    products: ['group_loan', 'micro_enterprise_loan', 'housing_microfinance', 'emergency_loan'],
    industries: ['Micro Retail', 'Handicrafts', 'Tailoring', 'Street Vending', 'Poultry'],
    amountRange: [28_000, 850_000],
    tenorRange: [6, 36],
    pdRange: [0.015, 0.11],
    lgdRange: [0.45, 0.8],
    undrawnShare: 0.12,
    ccfRange: [0.2, 0.5],
    eirRange: [0.18, 0.34],
    scheduleShare: 0.85,
    ratingBand: [5, 8],
    borrowerStyle: 'PERSON',
  },
  corporate: {
    segment: 'corporate',
    products: ['syndicated_term', 'revolving_credit', 'project_finance', 'export_refinance', 'sukuk_facility'],
    industries: ['Energy & Power', 'Cement', 'Steel', 'Telecom', 'Chemicals', 'Independent Power Producers'],
    amountRange: [120_000_000, 3_400_000_000],
    tenorRange: [24, 120],
    pdRange: [0.002, 0.045],
    lgdRange: [0.22, 0.55],
    undrawnShare: 0.68,
    ccfRange: [0.5, 0.85],
    eirRange: [0.12, 0.2],
    scheduleShare: 0.62,
    ratingBand: [0, 5],
    borrowerStyle: 'COMPANY',
  },
};

export const REGIONS = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
  'Gilgit-Baltistan',
  'Azad Jammu & Kashmir',
] as const;

const PERSON_FIRST = [
  'Ayesha', 'Bilal', 'Sana', 'Imran', 'Fatima', 'Usman', 'Zainab', 'Hamza', 'Mariam', 'Farhan',
  'Nadia', 'Owais', 'Hina', 'Tariq', 'Rabia', 'Kamran', 'Sadia', 'Noman', 'Iqra', 'Shahid',
  'Mehwish', 'Adnan', 'Kiran', 'Waqas', 'Bushra', 'Asim', 'Rukhsana', 'Junaid', 'Saima', 'Naveed',
] as const;

const PERSON_LAST = [
  'Kazmi', 'Farooqi', 'Gilani', 'Siddiqui', 'Qureshi', 'Butt', 'Chaudhry', 'Malik', 'Khan', 'Abbasi',
  'Rizvi', 'Hashmi', 'Sheikh', 'Ansari', 'Baloch', 'Khattak', 'Awan', 'Janjua', 'Mirza', 'Satti',
] as const;

const COMPANY_PREFIX = [
  'Indus', 'Chenab', 'Ravi', 'Himalaya', 'Karakoram', 'Mehran', 'Sindh', 'Punjab', 'Khyber', 'Makran',
  'Sialkot', 'Lahore', 'Karachi', 'Multan', 'Faisalabad', 'Sukkur', 'Gwadar', 'Taxila', 'Mohenjo', 'Neelum',
] as const;

const COMPANY_CORE = [
  'Textile Mills', 'Industries', 'Holdings', 'Engineering', 'Logistics', 'Foods', 'Chemicals',
  'Cement Works', 'Steel', 'Trading', 'Agri Services', 'Power', 'Textiles', 'Manufacturing', 'Enterprises',
] as const;

const COMPANY_SUFFIX = ['(Pvt) Ltd', 'Ltd', '(SMC-Pvt) Ltd', 'Group', '(Pvt) Limited'] as const;

const personName = (rand: () => number): string => `${pick(rand, PERSON_FIRST)} ${pick(rand, PERSON_LAST)}`;
const companyName = (rand: () => number): string =>
  `${pick(rand, COMPANY_PREFIX)} ${pick(rand, COMPANY_CORE)} ${pick(rand, COMPANY_SUFFIX)}`;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const money = (value: number): string => round2(value).toFixed(2);
/** Six decimals keeps PDs/LGDs precise without exponential notation. */
const rate = (value: number): string => Math.min(Math.max(value, 0), 0.999999).toFixed(6);

/**
 * The template's numeric writers, exported so a derived dataset renders money
 * and rates at exactly this precision instead of reinventing it and drifting.
 */
export const templateMoney = money;
export const templateRate = rate;

/**
 * Stage-2 trigger rotation. Each entry describes how to push an otherwise
 * performing exposure into Stage 2 using exactly one configured SICR rule.
 */
const STAGE2_TRIGGERS = [
  'DPD_SICR_BACKSTOP',
  'RATING_DOWNGRADE_SICR',
  'PD_INCREASE_SICR',
  'FORBEARANCE_SICR',
  'RESTRUCTURING_SICR',
  'WATCHLIST_SICR',
] as const;

const STAGE3_TRIGGERS = ['DPD_DEFAULT_BACKSTOP', 'DEFAULT_FLAG', 'CREDIT_IMPAIRED_FLAG'] as const;

/** Notch range a Stage 2 row uses when it is built around a material downgrade. */
const RATING_DOWNGRADE_NOTCHES = [2, 4] as const;

/**
 * Builds the target stage mix — roughly 62% Stage 1, 27% Stage 2, 12% Stage 3 —
 * with every segment and every staging trigger represented.
 *
 * The period is 26, deliberately coprime with the five-segment round robin in
 * `generatePortfolioRows`. A period of 25 would make `index % 25` determine
 * `index % 5`, so the three Stage 3 buckets would always land on the same three
 * segments and no microfinance or corporate exposure would ever be credit
 * impaired. At 26 the buckets drift across segments and every segment reaches
 * every stage within a full portfolio.
 */
function stagePlan(count: number): { stage: Stage; trigger: string }[] {
  const plan: { stage: Stage; trigger: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const bucket = index % 26;
    if (bucket < 3) {
      plan.push({ stage: 3, trigger: STAGE3_TRIGGERS[index % STAGE3_TRIGGERS.length] });
    } else if (bucket < 10) {
      plan.push({ stage: 2, trigger: STAGE2_TRIGGERS[index % STAGE2_TRIGGERS.length] });
    } else {
      plan.push({ stage: 1, trigger: 'NO_SICR_OBSERVED' });
    }
  }
  return plan;
}

/**
 * Moves a rating `notches` steps along the scale — positive downgrades, negative
 * upgrades — clamping at both ends. Exported because a historical period has to
 * be able to *upgrade* an exposure that has since deteriorated.
 */
export function shiftRating(rating: string, notches: number): (typeof RATING_SCALE)[number] {
  const index = RATING_SCALE.indexOf(rating as (typeof RATING_SCALE)[number]);
  if (index < 0) return 'CCC';
  return RATING_SCALE[Math.min(RATING_SCALE.length - 1, Math.max(0, index + notches))];
}

function downgradeRating(rating: string, notches: number): (typeof RATING_SCALE)[number] {
  return shiftRating(rating, notches);
}

/**
 * Generates the synthetic portfolio as canonical template rows.
 * `count` defaults to 780, above the 750 minimum, and every one of the five
 * segments plus all three stages is guaranteed to appear.
 */
export function generatePortfolioRows(options: GeneratorOptions = {}): GeneratedExposureRow[] {
  const count = Math.max(1, options.count ?? DEFAULT_GENERATOR_OPTIONS.count);
  const seed = options.seed ?? DEFAULT_GENERATOR_OPTIONS.seed;
  const reportingDate = options.reportingDate ?? DEFAULT_GENERATOR_OPTIONS.reportingDate;
  const currency = options.currency ?? DEFAULT_GENERATOR_OPTIONS.currency;
  const rand = mulberry32(seed);
  const plan = stagePlan(count);
  const rows: GeneratedExposureRow[] = [];

  for (let index = 0; index < count; index += 1) {
    // Round-robin over segments so all five are guaranteed regardless of count.
    const segment = SEGMENTS[index % SEGMENTS.length];
    const profile = SEGMENT_PROFILES[segment];
    const { stage, trigger } = plan[index];

    const productType = pick(rand, profile.products);
    const borrowerName = profile.borrowerStyle === 'PERSON' ? personName(rand) : companyName(rand);
    const region = pick(rand, REGIONS);
    const industry = pick(rand, profile.industries);

    const tenorMonths = intBetween(rand, profile.tenorRange[0], profile.tenorRange[1]);
    const elapsedMonths = intBetween(rand, 1, Math.max(1, tenorMonths - 1));
    const remainingMonths = Math.max(1, tenorMonths - elapsedMonths);
    const originationDate = addMonths(reportingDate, -elapsedMonths);
    // Anchored to the reporting date, never chained off the origination date.
    // `addMonths` clamps to month end and is therefore not associative: from a
    // 2026-08-31 reporting date, -6 months gives 2026-02-28 and +7 more gives
    // 2026-09-28 — zero whole months out, while the row claims one remaining,
    // and the engine rejects it as INVALID_DATE_RANGE. Deriving both dates from
    // the same anchor makes `remainingMonths` true by construction.
    const maturityDate = addMonths(reportingDate, remainingMonths);

    // The engine measures SICR from the *realized* notch distance and the scale
    // stops at 'D', so a downgrade requested from a rating too close to the
    // bottom lands short: `downgradeRating` clamps, only one notch materializes,
    // and the row stages 1 while still advertising Stage 2. Rows built around a
    // material downgrade therefore originate high enough for the worst case in
    // the range to land in full. Same number of draws, so nothing else shifts.
    const needsDowngradeHeadroom = stage === 2 && trigger === 'RATING_DOWNGRADE_SICR';
    const ratingBandCeiling = needsDowngradeHeadroom
      ? Math.min(profile.ratingBand[1], RATING_SCALE.length - 1 - RATING_DOWNGRADE_NOTCHES[1])
      : profile.ratingBand[1];
    const originalRatingIndex = intBetween(
      rand,
      profile.ratingBand[0],
      Math.max(profile.ratingBand[0], ratingBandCeiling),
    );
    const originalCreditRating = RATING_SCALE[originalRatingIndex];
    let currentCreditRating = originalCreditRating;

    const grossCarryingAmount = between(rand, profile.amountRange[0], profile.amountRange[1]);
    const hasUndrawn = rand() < profile.undrawnShare;
    const undrawnCommitment = hasUndrawn ? grossCarryingAmount * between(rand, 0.15, 0.9) : 0;
    const creditConversionFactor = hasUndrawn ? between(rand, profile.ccfRange[0], profile.ccfRange[1]) : 0;
    const effectiveInterestRate = between(rand, profile.eirRange[0], profile.eirRange[1]);

    const basePd12 = between(rand, profile.pdRange[0], profile.pdRange[1]);
    let twelveMonthPd = basePd12;
    let pdAtOrigination = basePd12;
    let lgd = between(rand, profile.lgdRange[0], profile.lgdRange[1]);

    let daysPastDue = 0;
    let defaultFlag = false;
    let creditImpairedFlag = false;
    let forbearanceFlag = false;
    let restructuringFlag = false;
    let watchlistFlag = false;

    if (stage === 1) {
      // Performing: below the 30-day SICR backstop, no downgrade, no PD surge.
      daysPastDue = rand() < 0.72 ? 0 : intBetween(rand, 1, 29);
      pdAtOrigination = twelveMonthPd * between(rand, 0.85, 1.1);
      if (pdAtOrigination > 0) {
        twelveMonthPd = Math.min(pdAtOrigination * between(rand, 1.0, 1.4), 0.95);
      }
      if (rand() < 0.35) {
        currentCreditRating = downgradeRating(originalCreditRating, 1);
      }
    } else if (stage === 2) {
      daysPastDue = intBetween(rand, 0, 29);
      pdAtOrigination = twelveMonthPd;
      if (trigger === 'DPD_SICR_BACKSTOP') {
        daysPastDue = intBetween(rand, 30, 89);
      } else if (trigger === 'RATING_DOWNGRADE_SICR') {
        currentCreditRating = downgradeRating(
          originalCreditRating,
          intBetween(rand, RATING_DOWNGRADE_NOTCHES[0], RATING_DOWNGRADE_NOTCHES[1]),
        );
      } else if (trigger === 'PD_INCREASE_SICR') {
        // The rule is an AND of three conditions: a positive origination PD, a
        // *current* PD at or above `pdIncreaseSicrAbsoluteFloor`, and a ratio at
        // or above `pdIncreaseSicrMultiple`. Corporate PDs start as low as 0.2%,
        // so it is the absolute floor on the current PD — not the ratio — that
        // silently fails and leaves the row performing. Both thresholds come from
        // the seeded rule set rather than being guessed at here.
        const floor = DEFAULT_STAGING_RULE_SET.pdIncreaseSicrAbsoluteFloor;
        const multiple = DEFAULT_STAGING_RULE_SET.pdIncreaseSicrMultiple;
        if (twelveMonthPd < floor * 1.2) twelveMonthPd = floor * 1.2;
        pdAtOrigination = twelveMonthPd / between(rand, multiple * 1.1, multiple * 2);
      } else if (trigger === 'FORBEARANCE_SICR') {
        forbearanceFlag = true;
      } else if (trigger === 'RESTRUCTURING_SICR') {
        restructuringFlag = true;
        daysPastDue = intBetween(rand, 0, 25);
      } else {
        watchlistFlag = true;
      }
      lgd = Math.min(lgd * between(rand, 1.0, 1.12), 0.95);
    } else {
      // Stage 3 — credit impaired.
      pdAtOrigination = twelveMonthPd / between(rand, 2, 4);
      twelveMonthPd = Math.min(basePd12 * between(rand, 4, 9), 0.85);
      lgd = Math.min(lgd * between(rand, 1.15, 1.4), 0.95);
      currentCreditRating = downgradeRating(originalCreditRating, intBetween(rand, 3, 6));
      if (trigger === 'DPD_DEFAULT_BACKSTOP') {
        daysPastDue = intBetween(rand, 90, 420);
      } else if (trigger === 'DEFAULT_FLAG') {
        defaultFlag = true;
        daysPastDue = intBetween(rand, 0, 180);
      } else {
        creditImpairedFlag = true;
        daysPastDue = intBetween(rand, 0, 120);
      }
    }

    // Lifetime PD from the 12-month anchor over the remaining contractual term,
    // so lifetimePd >= twelveMonthPd always holds for terms above 12 months.
    const years = remainingMonths / 12;
    const lifetimePd = Math.min(1 - Math.pow(1 - twelveMonthPd, Math.max(years, 1)), 0.98);
    const collateralValue = grossCarryingAmount * between(rand, 0.2, 1.35);

    const values = {
      exposureId: `EXP-${String(index + 1).padStart(6, '0')}`,
      borrowerId: `BOR-${String(Math.floor(index / 2.4) + 1).padStart(6, '0')}`,
      borrowerName,
      segment,
      productType,
      originationDate,
      maturityDate,
      reportingDate,
      currency,
      grossCarryingAmount: money(grossCarryingAmount),
      undrawnCommitment: money(undrawnCommitment),
      creditConversionFactor: rate(creditConversionFactor),
      effectiveInterestRate: rate(effectiveInterestRate),
      daysPastDue: String(daysPastDue),
      originalCreditRating,
      currentCreditRating,
      twelveMonthPd: rate(twelveMonthPd),
      lifetimePd: rate(Math.max(lifetimePd, twelveMonthPd)),
      lgd: rate(lgd),
      collateralValue: money(collateralValue),
      defaultFlag: String(defaultFlag),
      creditImpairedFlag: String(creditImpairedFlag),
      forbearanceFlag: String(forbearanceFlag),
      restructuringFlag: String(restructuringFlag),
      watchlistFlag: String(watchlistFlag),
      pdAtOrigination: rate(pdAtOrigination),
      region,
      industry,
    } as Record<PortfolioField, string>;

    rows.push({
      values,
      targetStage: stage,
      targetTrigger: trigger,
      segment,
      productType,
      remainingMonths,
      hasContractualSchedule: rand() < profile.scheduleShare,
    });
  }

  return rows;
}

/**
 * A contractual amortization schedule for term products: level principal
 * repayments with the undrawn commitment held flat. Returned in the exact shape
 * the engine's `buildEadSchedule` consumes.
 */
export function generateContractualSchedule(row: GeneratedExposureRow): {
  period: number;
  drawnBalance: string;
  undrawnCommitment: string;
}[] {
  const periods = row.remainingMonths;
  const drawn = Number(row.values.grossCarryingAmount);
  const undrawn = row.values.undrawnCommitment;
  const points: { period: number; drawnBalance: string; undrawnCommitment: string }[] = [];
  for (let period = 1; period <= periods; period += 1) {
    const remaining = drawn * (periods - period + 1) / periods;
    points.push({
      period,
      drawnBalance: money(remaining),
      undrawnCommitment: undrawn,
    });
  }
  return points;
}

const CSV_SPECIAL = /[",\r\n]/;
const escapeCsv = (value: string): string => (CSV_SPECIAL.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Renders canonical rows as CSV text using the template header order. */
export function rowsToCsv(rows: Record<PortfolioField, string>[]): string {
  const header = TEMPLATE_HEADERS.join(',');
  const body = rows.map((row) =>
    PORTFOLIO_FIELDS.map((field) => escapeCsv(row[field] ?? '')).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

/** Three hand-written example rows, one per stage, used in the blank template. */
export function buildTemplateExampleRows(reportingDate: string = DEFAULT_GENERATOR_OPTIONS.reportingDate): Record<PortfolioField, string>[] {
  const base = {
    currency: 'PKR',
    reportingDate,
    undrawnCommitment: '0.00',
    creditConversionFactor: '0.000000',
    collateralValue: '0.00',
    defaultFlag: 'false',
    creditImpairedFlag: 'false',
    forbearanceFlag: 'false',
    restructuringFlag: 'false',
    watchlistFlag: 'false',
    region: 'Punjab',
    industry: 'Textiles',
  };

  return [
    {
      ...base,
      exposureId: 'EXP-000001',
      borrowerId: 'BOR-000001',
      borrowerName: 'Ayesha Kazmi',
      segment: 'consumer',
      productType: 'auto_loan',
      originationDate: addMonths(reportingDate, -14),
      maturityDate: addMonths(reportingDate, 34),
      grossCarryingAmount: '1850000.00',
      effectiveInterestRate: '0.178000',
      daysPastDue: '0',
      originalCreditRating: 'BBB',
      currentCreditRating: 'BBB',
      twelveMonthPd: '0.011500',
      lifetimePd: '0.042000',
      lgd: '0.420000',
      pdAtOrigination: '0.011200',
    },
    {
      ...base,
      exposureId: 'EXP-000002',
      borrowerId: 'BOR-000002',
      borrowerName: 'Indus Textile Mills (Pvt) Ltd',
      segment: 'sme',
      productType: 'working_capital',
      originationDate: addMonths(reportingDate, -26),
      maturityDate: addMonths(reportingDate, 22),
      grossCarryingAmount: '42500000.00',
      undrawnCommitment: '15000000.00',
      creditConversionFactor: '0.600000',
      effectiveInterestRate: '0.192000',
      daysPastDue: '47',
      originalCreditRating: 'BB',
      currentCreditRating: 'BB',
      twelveMonthPd: '0.038000',
      lifetimePd: '0.118000',
      lgd: '0.520000',
      collateralValue: '28000000.00',
      pdAtOrigination: '0.021000',
      industry: 'Textiles',
      region: 'Sindh',
    },
    {
      ...base,
      exposureId: 'EXP-000003',
      borrowerId: 'BOR-000003',
      borrowerName: 'Chenab Agri Services Ltd',
      segment: 'agriculture',
      productType: 'crop_loan',
      originationDate: addMonths(reportingDate, -30),
      maturityDate: addMonths(reportingDate, 6),
      grossCarryingAmount: '8600000.00',
      effectiveInterestRate: '0.155000',
      daysPastDue: '128',
      originalCreditRating: 'B',
      currentCreditRating: 'CCC',
      twelveMonthPd: '0.285000',
      lifetimePd: '0.395000',
      lgd: '0.680000',
      collateralValue: '5200000.00',
      defaultFlag: 'true',
      pdAtOrigination: '0.062000',
      industry: 'Cotton',
      region: 'Punjab',
    },
  ] as Record<PortfolioField, string>[];
}

/**
 * The downloadable blank template: canonical header plus one example row per
 * stage. Small enough to open in any spreadsheet, valid enough to upload back.
 */
export function buildTemplateCsv(reportingDate: string = DEFAULT_GENERATOR_OPTIONS.reportingDate): string {
  return rowsToCsv(buildTemplateExampleRows(reportingDate));
}

/** The downloadable full synthetic sample portfolio (750+ rows). */
export function buildSamplePortfolioCsv(options: GeneratorOptions = {}): string {
  return rowsToCsv(generatePortfolioRows(options).map((row) => row.values));
}

/** Column guide rendered into the template download page and the docs. */
export const TEMPLATE_FIELD_GUIDE = FIELD_SPEC_LIST.map((spec) => ({
  field: spec.key,
  header: spec.label,
  kind: spec.kind,
  required: spec.required,
  description: spec.description,
}));
