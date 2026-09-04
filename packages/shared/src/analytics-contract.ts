/**
 * Wire contract for the dashboard analytics endpoints (`/api/v1/analytics/*`).
 *
 * These exist so a dashboard can render a whole book without downloading it:
 * every shape here is an aggregate the server computed, never a row the client
 * is expected to fold up itself.
 *
 * Three rules carried over from `api-contract.ts`:
 *
 *   - Money is a decimal string at 2dp and rates at 10dp. Nothing here is a
 *     binary float, so a total on a KPI card is byte-identical to the same
 *     total on the run detail page.
 *   - Shares and percentages are `string | null`, null when the denominator is
 *     zero. A division by zero is a fact about the book, not an error, and
 *     rendering it as `0%` would claim a measurement that was never made.
 *   - Every aggregate carries `limitations: string[]`. Where a figure could not
 *     be computed honestly the endpoint says so in prose rather than padding
 *     the response with a plausible zero.
 */
import { z } from 'zod';
import type { Stage } from './types';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The global dashboard filter set, in the shape the URL carries it.
 *
 * `snapshotId` selects the reporting period; the rest narrow the book within
 * it. `stage` filters on the run's staged outcome (`EclResult.stage`), not on
 * the live staging assessment — an analytical view describes the run it is
 * reconciled to.
 */
export const analyticsFilterSchema = z.object({
  snapshotId: z.string().max(64).optional(),
  segment: z.string().max(80).optional(),
  productType: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  industry: z.string().max(120).optional(),
  /** Current credit rating. The scale stops at three characters ('AAA'..'D'). */
  rating: z.string().max(8).optional(),
  stage: z.coerce.number().int().min(1).max(3).optional(),
});
export type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;

/**
 * The bridge decomposes movement partly *by* stage change, so a stage filter
 * would contradict it: selecting stage 2 hides every loan that left stage 2,
 * which is exactly the transfer the component is meant to measure.
 */
export const movementQuerySchema = analyticsFilterSchema.omit({ stage: true }).strict();
export type MovementQuery = z.infer<typeof movementQuerySchema>;

/** The trend spans every reporting period, so there is no period to select. */
export const trendQuerySchema = analyticsFilterSchema.omit({ snapshotId: true }).strict();
export type TrendQuery = z.infer<typeof trendQuerySchema>;

/** Two reporting periods to compare. Both default to the two newest. */
export const migrationQuerySchema = z.object({
  fromSnapshotId: z.string().max(64).optional(),
  toSnapshotId: z.string().max(64).optional(),
});
export type MigrationQuery = z.infer<typeof migrationQuerySchema>;

export const driversQuerySchema = analyticsFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type DriversQuery = z.infer<typeof driversQuerySchema>;

export const scenarioQuerySchema = z.object({
  /** Resolve the scenario split of this run; defaults to the period's newest. */
  runId: z.string().max(64).optional(),
  snapshotId: z.string().max(64).optional(),
});
export type ScenarioQuery = z.infer<typeof scenarioQuerySchema>;

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/** A selectable value and how many exposures in the period carry it. */
export interface FilterOption {
  value: string;
  count: number;
}

export interface ReportingPeriodOption {
  snapshotId: string;
  label: string;
  reportingDate: string;
  exposureCount: number;
  /** False until a run has produced results, so the UI can mark it as such. */
  hasResults: boolean;
  runPublicId: string | null;
  runStatus: string | null;
}

/**
 * Everything the global filter bar needs to build itself.
 *
 * Counts come with the options because a filter that lists a segment with zero
 * exposures in the selected period invites a click that returns an empty state.
 */
export interface PortfolioFilters {
  /** Newest first — the order a reporting-date picker should show. */
  periods: ReportingPeriodOption[];
  segments: FilterOption[];
  productTypes: FilterOption[];
  regions: FilterOption[];
  industries: FilterOption[];
  ratings: FilterOption[];
  stages: Array<{ stage: Stage; count: number }>;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface AnalyticsStageRow {
  stage: Stage;
  exposureCount: number;
  grossCarryingAmount: string;
  ead: string;
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
  shareOfGrossPercent: string | null;
  shareOfAllowancePercent: string | null;
}

export interface AnalyticsSummary {
  currency: string;
  reportingDate: string;
  snapshot: { publicId: string; label: string; exposureCount: number };
  run: {
    publicId: string;
    status: string;
    label: string;
    completedAt: string | null;
    modelConfigurationVersion: string | null;
    scenarioSetVersion: string | null;
  } | null;
  totals: {
    exposureCount: number;
    grossCarryingAmount: string;
    ead: string;
    lossAllowance: string;
    netCarryingAmount: string;
    coverageRatio: string;
    stage2And3Count: number;
    stage3Count: number;
    /** Allowance divided by gross, as a percentage — the KPI card's own unit. */
    coveragePercent: string;
  };
  stages: AnalyticsStageRow[];
  /** Human-readable, in the order the chips should render. */
  filtersApplied: string[];
  /**
   * True when these totals are the run's own persisted totals, i.e. the
   * selection covers the whole book. False means a filter is active and the
   * figures are a subset — still exact, but not the run headline.
   */
  reconcilesToRun: boolean;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Movement bridge
// ---------------------------------------------------------------------------

export const MOVEMENT_COMPONENT_CODES = [
  'OPENING',
  'NEW_ORIGINATIONS',
  'DERECOGNITION',
  'STAGE_TRANSFERS',
  'CONTINUING_SAME_STAGE',
  'PARAMETER_CHANGES',
  'SCENARIO_CHANGES',
  'WRITE_OFFS',
  'CLOSING',
] as const;
export type MovementComponentCode = (typeof MOVEMENT_COMPONENT_CODES)[number];

export interface MovementComponent {
  code: MovementComponentCode;
  label: string;
  /** Null when the component could not be measured; see `note`. */
  amount: string | null;
  exposureCount: number | null;
  /** Why this component is null, or what it does and does not capture. */
  note: string | null;
}

export interface MovementEndpoint {
  reportingDate: string;
  snapshotPublicId: string;
  runPublicId: string;
  runStatus: string;
  lossAllowance: string;
  exposureCount: number;
}

export interface MovementBridge {
  currency: string;
  from: MovementEndpoint;
  to: MovementEndpoint;
  /** Waterfall order: opening, then every movement, then closing. */
  components: MovementComponent[];
  change: string;
  changePercent: string | null;
  /**
   * True when the non-null movement components add exactly to `change`. The
   * decomposition is by exposure cohort (present in both periods or not, and
   * stage changed or not), so it closes arithmetically by construction; a false
   * here would mean a bug, not a data limitation.
   */
  componentsSumToChange: boolean;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendPoint {
  reportingDate: string;
  snapshotPublicId: string;
  snapshotLabel: string;
  runPublicId: string | null;
  runStatus: string | null;
  exposureCount: number;
  grossCarryingAmount: string;
  ead: string;
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
  stageCounts: Record<Stage, number>;
  stageAllowance: Record<Stage, string>;
  modelConfigurationVersion: string | null;
  scenarioSetVersion: string | null;
}

export interface AnalyticsTrend {
  currency: string;
  /** Oldest first, so a line chart can be drawn without re-sorting. */
  points: TrendPoint[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------

export const CONCENTRATION_DIMENSIONS = [
  'segment',
  'productType',
  'region',
  'industry',
  'rating',
] as const;
export type ConcentrationDimension = (typeof CONCENTRATION_DIMENSIONS)[number];

export interface ConcentrationBucket {
  key: string;
  exposureCount: number;
  grossCarryingAmount: string;
  lossAllowance: string;
  coverageRatio: string;
  shareOfGrossPercent: string | null;
  shareOfAllowancePercent: string | null;
  stageCounts: Record<Stage, number>;
}

export interface ConcentrationSlice {
  dimension: ConcentrationDimension;
  label: string;
  /** Ranked by allowance, largest first, capped at `maxBuckets`. */
  buckets: ConcentrationBucket[];
  /** Buckets beyond the cap, folded together so the slice still sums to 100%. */
  otherBucket: ConcentrationBucket | null;
  topBucketShareOfAllowancePercent: string | null;
  topThreeShareOfAllowancePercent: string | null;
}

export interface AnalyticsConcentration {
  currency: string;
  reportingDate: string;
  runPublicId: string | null;
  slices: ConcentrationSlice[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export interface DriverExposure {
  exposurePublicId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  grossCarryingAmount: string;
  lossAllowance: string;
  coverageRatio: string;
  shareOfTotalAllowancePercent: string | null;
  daysPastDue: number;
  currentCreditRating: string;
  primaryRuleCode: string;
  primaryReason: string;
}

export interface StagingRuleContribution {
  code: string;
  stage: Stage;
  exposureCount: number;
  lossAllowance: string;
  shareOfAllowancePercent: string | null;
}

export interface AnalyticsDrivers {
  currency: string;
  reportingDate: string;
  runPublicId: string | null;
  totalLossAllowance: string;
  /** The drill-down queue: largest allowance first. */
  topExposures: DriverExposure[];
  /**
   * What share of the whole allowance `topExposures` holds. Computed here
   * rather than left to the client because summing decimal strings in binary
   * float would make the headline share disagree with the figures beside it.
   */
  topExposuresShareOfAllowancePercent: string | null;
  /** Allowance ranked by segment — "which segments drive the number". */
  bySegment: Array<{ key: string; lossAllowance: string; shareOfAllowancePercent: string | null }>;
  stagingRules: StagingRuleContribution[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Stage migration and scenario comparison
// ---------------------------------------------------------------------------

export interface MigrationCell {
  fromStage: number;
  toStage: number;
  count: number;
  grossCarryingAmount: string;
}

export interface MigrationEndpoint {
  publicId: string;
  label: string;
  asOfDate: string;
  runPublicId: string | null;
}

export interface AnalyticsMigration {
  fromSnapshot: MigrationEndpoint;
  toSnapshot: MigrationEndpoint;
  cells: MigrationCell[];
  matchedExposures: number;
  onlyInFromSnapshot: number;
  onlyInToSnapshot: number;
  stageCountsFrom: Record<string, number>;
  stageCountsTo: Record<string, number>;
  netStage3Change: number;
  limitations: string[];
}

export interface ScenarioRow {
  scenarioCode: string;
  scenarioName: string;
  weight: string;
  pdMultiplier: string;
  lgdMultiplier: string;
  horizonMonths: number;
  unweightedEcl: string;
  weightedEcl: string;
  shareOfWeightedEclPercent: string | null;
  averageCumulativePdInHorizon: string;
  exposureCount: number;
}

export interface AnalyticsScenarios {
  runPublicId: string;
  runStatus: string;
  runLabel: string;
  snapshotPublicId: string;
  reportingDate: string | null;
  scenarios: ScenarioRow[];
  totalUnweightedEcl: string;
  totalWeightedEcl: string;
  weightSum: string;
  exposureCount: number;
}

// ---------------------------------------------------------------------------
// Run comparison
// ---------------------------------------------------------------------------

/**
 * Two runs to diff. Without explicit ids the endpoint compares the selected
 * period's run against the run of the period before it, which is the comparison
 * the run detail page opens on.
 */
export const runComparisonQuerySchema = z.object({
  snapshotId: z.string().max(64).optional(),
  baseRunId: z.string().max(64).optional(),
  comparisonRunId: z.string().max(64).optional(),
});
export type RunComparisonQuery = z.infer<typeof runComparisonQuerySchema>;

export interface RunComparisonExposureRow {
  exposurePublicId: string;
  segment: string;
  baseStage: number;
  comparisonStage: number;
  baseAllowance: string;
  comparisonAllowance: string;
  change: string;
  changePercent: string | null;
}

export interface RunComparisonEndpoint {
  publicId: string;
  label: string;
  status: string;
  reportingDate: string | null;
  snapshotPublicId: string;
}

export interface RunComparison {
  baseRun: RunComparisonEndpoint;
  comparisonRun: RunComparisonEndpoint;
  totals: {
    baseAllowance: string;
    comparisonAllowance: string;
    change: string;
    changePercent: string | null;
    baseExposureCount: number;
    comparisonExposureCount: number;
  };
  /**
   * False when the two runs were calculated on different reporting dates. This
   * is not a defect — it is what a period-over-period comparison is — but it
   * means the difference carries book composition (originations and repayments)
   * and not only a change in credit quality, so the client says so.
   */
  sameReportingDate: boolean;
  /**
   * False when the two runs differ in model configuration, scenario set, staging
   * rule set, or — within one reporting date — the snapshot they were calculated
   * over. In that case the difference is not purely a change in credit quality
   * and `configurationDifferences` says what else it is.
   */
  comparableConfiguration: boolean;
  configurationDifferences: string[];
  largestIncreases: RunComparisonExposureRow[];
  largestDecreases: RunComparisonExposureRow[];
  stageMigrations: MigrationCell[];
  matchedExposures: number;
  onlyInBase: number;
  onlyInComparison: number;
  limitations: string[];
}
