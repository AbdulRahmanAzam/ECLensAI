/**
 * The Step 2 wire contract.
 *
 * Everything the API returns and everything the web client sends is described
 * here, so the two apps are built against one source of truth rather than two
 * guesses. Two rules hold across every shape:
 *
 *   1. Money and rates are decimal **strings**, never binary floats. They come
 *      straight out of `domain/serialize.ts`, which is the only place the
 *      engine's exact Decimal values are rendered.
 *   2. Dates are ISO-8601 (`YYYY-MM-DD` for dates, full UTC timestamps for
 *      events) and are never ambiguous.
 */
import { z } from 'zod';
import type { ColumnMapping, IssueCode, IssueSeverity, ValidationIssue } from './ingest/validate';
import type { SuggestedMapping, PortfolioField } from './ingest/columns';
import type { PercentageNormalizationMode } from './ingest/normalize';
import type {
  EducationalApproximationDto,
  ExposureEclResultDto,
  PeriodDto,
  PortfolioTotalsDto,
  ScenarioResultDto,
} from './domain/serialize';
import type { EclLineage } from './domain/ecl';
import { STAGING_RULE_CODES, type StagingDecision, type StagingRuleCode, type StagingRuleSetConfig } from './domain/staging';
import { DEFAULT_MODEL_CONFIGURATION, type EclModelConfigurationInput } from './domain/config';
import { DISCOUNT_CONVENTIONS, type DiscountConvention } from './domain/discount';
import { SIMPLIFIED_EAD_PROFILES, type SimplifiedEadProfile } from './domain/ead';
import { type ExceptionKind, type LargeEclChangeThresholds } from './domain/exceptions';
import { type ScenarioDefinitionInput } from './domain/scenarios';
import type {
  AiInsight,
  CopilotMessage,
  DemoUser,
  ImportStatus,
  MacroIndicators,
  ReportDefinition,
  RoleName,
  RunStatus,
  Stage,
} from './types';

// ---------------------------------------------------------------------------
// Pagination, sorting, filtering
// ---------------------------------------------------------------------------

export interface PageMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortBy: z.string().min(1).max(64).optional(),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
  search: z.string().max(200).optional(),
  segment: z.string().max(80).optional(),
  productType: z.string().max(80).optional(),
  stage: z.coerce.number().int().min(1).max(3).optional(),
  region: z.string().max(80).optional(),
  industry: z.string().max(120).optional(),
  /** Current credit rating. The scale stops at three characters ('AAA'..'D'). */
  rating: z.string().max(8).optional(),
  snapshotId: z.string().max(64).optional(),
  runId: z.string().max(64).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const auditListQuerySchema = listQuerySchema.extend({
  action: z.string().max(80).optional(),
  entityType: z.string().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const exceptionListQuerySchema = listQuerySchema.extend({
  kind: z.string().max(40).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
});
export type ExceptionListQuery = z.infer<typeof exceptionListQuerySchema>;

// ---------------------------------------------------------------------------
// Portfolio exposures
// ---------------------------------------------------------------------------

/** One committed exposure row plus its latest staging outcome. */
export interface ExposureRecord {
  id: string;
  publicId: string;
  snapshotId: string;
  snapshotLabel: string;
  inputVersion: string;
  borrowerId: string;
  borrowerName: string;
  segment: string;
  productType: string;
  originationDate: string;
  maturityDate: string;
  reportingDate: string;
  currency: string;
  grossCarryingAmount: string;
  undrawnCommitment: string;
  creditConversionFactor: string;
  effectiveInterestRate: string;
  daysPastDue: number;
  originalCreditRating: string;
  currentCreditRating: string;
  twelveMonthPd: string;
  lifetimePd: string;
  pdAtOrigination: string;
  lgd: string;
  collateralValue: string;
  defaultFlag: boolean;
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  region: string;
  industry: string;
  hasContractualSchedule: boolean;
  hasPdTermStructure: boolean;
  simplifiedEadProfile: SimplifiedEadProfile;
  currentStage: Stage;
  stagePrimaryReason: string;
  stageRuleCodes: StagingRuleCode[];
  hasStageOverride: boolean;
  latestRunId: string | null;
  latestLossAllowance: string | null;
  latestNetCarryingAmount: string | null;
  latestCoverageRatio: string | null;
}

export interface EadSchedulePointRecord {
  period: number;
  drawnBalance: string;
  undrawnCommitment: string;
  creditConversionFactor: string;
  ead: string;
}

export interface PdTermStructureRecord {
  basis: 'MARGINAL' | 'CONDITIONAL' | 'CUMULATIVE';
  points: Array<{ period: number; pd: string }>;
}

/** A persisted override row. Distinct from the engine's `StageOverrideRecord` input. */
export interface StageOverrideHistoryRecord {
  id: string;
  exposureId: string;
  stageBefore: Stage;
  stageAfter: Stage;
  reason: string;
  actorId: string;
  actorName: string;
  actorRole: RoleName;
  occurredAt: string;
  reviewerStatus: 'PENDING_REVIEW' | 'REVIEWED' | 'REJECTED';
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
}

/**
 * One row of the override review queue. A reviewer decides on an exposure, not
 * on an internal id, so the queue carries the exposure context alongside the
 * override itself.
 */
export interface StageOverrideListItem extends StageOverrideHistoryRecord {
  exposurePublicId: string;
  borrowerName: string;
  segment: string;
}

export interface ExceptionItemRecord {
  id: string;
  kind: ExceptionKind;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  exposureId: string | null;
  exposurePublicId: string | null;
  borrowerName: string | null;
  runId: string | null;
  title: string;
  detail: string;
  metric: string | null;
  createdAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

/** Counts for the exception queue header, so badges need no extra round trip. */
export interface ExceptionSummaryRecord {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  byKind: Partial<Record<ExceptionKind, number>>;
  bySeverity: Partial<Record<'LOW' | 'MEDIUM' | 'HIGH', number>>;
}

export interface ExposureDetailRecord {
  exposure: ExposureRecord;
  /** Staging decision as produced by the latest run, or a live assessment. */
  staging: StagingDecision;
  latestResult: ExposureRunResultRecord | null;
  eadSchedule: EadSchedulePointRecord[];
  pdTermStructure: PdTermStructureRecord | null;
  overrideHistory: StageOverrideHistoryRecord[];
  exceptions: ExceptionItemRecord[];
  lineage: EclLineage | null;
  auditTrail: AuditEventRecord[];
}

/** Per-exposure result persisted by a run, with scenario summaries only. */
export interface ExposureRunResultRecord {
  id: string;
  runId: string;
  exposureId: string;
  exposurePublicId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  staging: StagingDecision;
  horizonBasisNote: string;
  remainingContractualMonths: number;
  horizonMonths: number;
  grossCarryingAmount: string;
  eadAtReportingDate: string;
  eadProfileKind: string;
  eadProfileLabel: string;
  eadScheduleExtendedFlat: boolean;
  pdSourceKind: string;
  effectiveInterestRate: string;
  discountConvention: DiscountConvention;
  lifetimePdAtReportingDate: string;
  scenarioResults: Array<Omit<ScenarioResultDto, 'periods'>>;
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
  coverageOfEad: string;
  educationalApproximation: EducationalApproximationDto;
  explanation: string[];
  lineage: EclLineage;
}

/** One row of `GET /ecl-runs/:id/results`. */
export interface RunResultRowRecord {
  id: string;
  exposureId: string;
  exposurePublicId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  stagePrimaryReason: string;
  horizonMonths: number;
  grossCarryingAmount: string;
  ead: string;
  pd: string;
  lgd: string;
  lossAllowance: string;
  netCarryingAmount: string;
  coverageRatio: string;
  scenarioContributions: Array<{ scenarioCode: string; scenarioName: string; weight: string; weightedEcl: string }>;
  changeVsPreviousRun: string | null;
}

/** One period row of the drill-down endpoint. */
export interface RunResultPeriodRecord extends PeriodDto {
  scenarioCode: string;
  scenarioName: string;
  weight: string;
  weightedExpectedLoss: string;
}

export interface RunResultDetailRecord {
  result: ExposureRunResultRecord;
  scenarioPeriods: Array<{ scenario: Omit<ScenarioResultDto, 'periods'>; periods: PeriodDto[] }>;
  fullResult: ExposureEclResultDto;
}

export interface SegmentBreakdownRecord {
  segment: string;
  exposureCount: number;
  grossCarryingAmount: string;
  lossAllowance: string;
  coverageRatio: string;
  stage3Count: number;
}

export interface PortfolioSnapshotRecord {
  id: string;
  label: string;
  asOfDate: string;
  exposureCount: number;
  totalGrossExposure: string;
  totalEcl: string;
  coverageRatio: string;
  stage3Share: string;
  source: 'IMPORT' | 'RUN' | 'SEED';
  importBatchId: string | null;
  createdAt: string;
}

export interface HighRiskExposureRecord {
  exposureId: string;
  exposurePublicId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  daysPastDue: number;
  currentCreditRating: string;
  grossCarryingAmount: string;
  lossAllowance: string;
  riskReason: string;
}

export interface PortfolioSummaryRecord {
  asOf: string;
  currency: string;
  snapshotId: string;
  snapshotLabel: string;
  totals: PortfolioTotalsDto;
  segmentBreakdown: SegmentBreakdownRecord[];
  trend: PortfolioSnapshotRecord[];
  highRisk: HighRiskExposureRecord[];
  recentRuns: EclRunSummaryRecord[];
  exceptionCounts: Record<string, number>;
  openExceptionCount: number;
  lineage: EclLineage | null;
}

// ---------------------------------------------------------------------------
// ECL runs and the review workflow
// ---------------------------------------------------------------------------

export interface RunReadinessCheck {
  code: string;
  ok: boolean;
  message: string;
}

export interface RunReadiness {
  ready: boolean;
  checks: RunReadinessCheck[];
}

export interface EclRunSummaryRecord {
  id: string;
  publicId: string;
  runDate: string;
  status: RunStatus;
  createdByName: string;
  completedAt: string | null;
  totalLossAllowance: string | null;
  coverageRatio: string | null;
  modelConfigurationVersion: string;
  scenarioSetVersion: string;
}

export interface EclRunRecord {
  id: string;
  publicId: string;
  organizationId: string;
  runDate: string;
  status: RunStatus;
  snapshotId: string;
  snapshotLabel: string;
  modelConfigurationId: string;
  modelConfigurationName: string;
  modelConfigurationVersion: string;
  scenarioSetId: string;
  scenarioSetName: string;
  scenarioSetVersion: string;
  createdById: string | null;
  createdByName: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  totals: PortfolioTotalsDto | null;
  scenarioWeights: Record<string, string>;
  notes: string | null;
  error: string | null;
  readiness: RunReadiness;
  submittedById: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  reviewDecision: 'APPROVED' | 'REJECTED' | null;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  lockedAt: string | null;
  /** Versions frozen when the run completed; later edits cannot change them. */
  lockedConfiguration: EclModelConfigurationInput | null;
  lockedScenarioSet: ScenarioSetRecord | null;
  lineage: EclLineage | null;
}

export const createRunRequestSchema = z.object({
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'runDate must be an ISO date (YYYY-MM-DD)'),
  snapshotId: z.string().min(1),
  modelConfigurationId: z.string().min(1),
  scenarioSetId: z.string().min(1),
  notes: z.string().max(2000).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const reviewRequestSchema = z.object({
  comment: z.string().min(3, 'A review comment is required').max(2000),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const stageOverrideRequestSchema = z.object({
  stageAfter: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reason: z
    .string()
    .min(10, 'An override reason of at least 10 characters is required for the audit trail')
    .max(2000),
});
export type StageOverrideRequest = z.infer<typeof stageOverrideRequestSchema>;

export const overrideReviewRequestSchema = z.object({
  decision: z.enum(['REVIEWED', 'REJECTED']),
  comment: z.string().min(3).max(2000),
});
export type OverrideReviewRequest = z.infer<typeof overrideReviewRequestSchema>;

// ---------------------------------------------------------------------------
// Scenario sets and model configurations (versioned, never mutated in place)
// ---------------------------------------------------------------------------

export interface ScenarioRecord {
  id: string;
  code: string;
  name: string;
  kind: string;
  weight: string;
  pdMultiplier: string;
  lgdMultiplier: string;
  isActive: boolean;
  description: string;
  indicators: MacroIndicators | null;
}

export interface ScenarioSetRecord {
  id: string;
  name: string;
  version: string;
  isActive: boolean;
  description: string;
  scenarios: ScenarioRecord[];
  createdBy: string;
  createdAt: string;
  lockedByRunCount: number;
  /** A set starts PENDING; only APPROVED sets should be offered when creating a run. */
  approvalStatus: 'PENDING' | 'APPROVED';
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface ModelConfigurationRecord extends EclModelConfigurationInput {
  isActive: boolean;
  approvedBy: string;
  approvedAt: string;
  exceptionThresholds: LargeEclChangeThresholds;
  createdBy: string;
  createdAt: string;
  lockedByRunCount: number;
  supersedesVersion: string | null;
}

export const scenarioInputSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  kind: z.string().min(1).max(32).optional(),
  weight: z.string().min(1).max(32),
  pdMultiplier: z.string().min(1).max(32),
  lgdMultiplier: z.string().min(1).max(32),
  isActive: z.boolean().default(true),
  description: z.string().max(1000).optional(),
  indicators: z
    .object({
      gdpGrowth: z.number(),
      inflationRate: z.number(),
      unemploymentRate: z.number(),
      policyRate: z.number(),
    })
    .optional(),
});

export const createScenarioSetRequestSchema = z.object({
  name: z.string().min(3).max(120),
  version: z.string().min(1).max(32),
  description: z.string().max(1000).optional(),
  scenarios: z.array(scenarioInputSchema).min(1),
});
export type CreateScenarioSetRequest = z.infer<typeof createScenarioSetRequestSchema>;

export const stagingRuleSetSchema = z.object({
  id: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  stage3DpdThreshold: z.number().int().positive(),
  stage2DpdThreshold: z.number().int().min(0),
  ratingNotchSicrThreshold: z.number().int().min(1),
  pdIncreaseSicrMultiple: z.number().gt(1),
  pdIncreaseSicrAbsoluteFloor: z.number().min(0),
  nearThresholdDpdBufferDays: z.number().int().min(0),
  nearThresholdPdBufferFraction: z.number().min(0),
  enabledRules: z.array(z.enum(STAGING_RULE_CODES)).min(1),
});

export const createModelConfigurationRequestSchema = z.object({
  name: z.string().min(3).max(160),
  version: z.string().min(1).max(32),
  description: z.string().max(2000).optional(),
  stagingRuleSet: stagingRuleSetSchema,
  lgdFloor: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.lgdFloor),
  lgdCeiling: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.lgdCeiling),
  pdFloor: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.pdFloor),
  pdCeiling: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.pdCeiling),
  lifetimeHorizonMonthsCap: z.number().int().min(1).max(600).default(DEFAULT_MODEL_CONFIGURATION.lifetimeHorizonMonthsCap),
  maxCalculationPeriods: z.number().int().min(1).max(1200).default(DEFAULT_MODEL_CONFIGURATION.maxCalculationPeriods),
  discountConvention: z.enum(DISCOUNT_CONVENTIONS).default(DEFAULT_MODEL_CONFIGURATION.discountConvention),
  effectiveInterestRateMin: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMin),
  effectiveInterestRateMax: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.effectiveInterestRateMax),
  defaultCreditConversionFactor: z.string().min(1).default(DEFAULT_MODEL_CONFIGURATION.defaultCreditConversionFactor),
  defaultSimplifiedEadProfile: z
    .enum(SIMPLIFIED_EAD_PROFILES)
    .default(DEFAULT_MODEL_CONFIGURATION.defaultSimplifiedEadProfile),
  twelveMonthWindow: z.number().int().min(1).max(60).default(DEFAULT_MODEL_CONFIGURATION.twelveMonthWindow),
  exceptionThresholds: z
    .object({
      relativeChange: z.string().min(1),
      absoluteChange: z.string().min(1),
      materialityFloor: z.string().min(1),
    })
    .optional(),
  approvedBy: z.string().min(2).max(160),
  approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activate: z.boolean().default(false),
});
export type CreateModelConfigurationRequest = z.infer<typeof createModelConfigurationRequestSchema>;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ImportBatchRecord {
  id: string;
  publicId: string;
  fileName: string;
  sourceFormat: 'CSV' | 'XLSX';
  status: ImportStatus;
  uploadedAt: string;
  uploadedById: string | null;
  uploadedBy: string;
  rowCount: number;
  previewRowCount: number;
  validRowCount: number;
  quarantinedRowCount: number;
  errorCount: number;
  warningCount: number;
  message: string;
  headers: string[];
  mapping: ColumnMapping;
  suggestedMapping: SuggestedMapping;
  missingRequiredFields: PortfolioField[];
  percentageNormalizationMode: PercentageNormalizationMode;
  unmappedHeaders: string[];
  truncated: boolean;
  rowsSkippedByTruncation: number;
  committedAt: string | null;
  committedBy: string | null;
  snapshotId: string | null;
  snapshotLabel: string | null;
}

export interface ImportPreviewRecord {
  batch: ImportBatchRecord;
  previewRows: Array<{ rowNumber: number; cells: string[] }>;
  fieldGuide: Array<{ key: string; label: string; kind: string; required: boolean; description: string }>;
}

export interface ValidationIssueRecord extends ValidationIssue {
  id: string;
}

export interface ImportIssuesRecord {
  batchId: string;
  issues: ValidationIssueRecord[];
  quarantinedRows: Array<{ rowNumber: number; sheetRow: number; exposureId: string | null }>;
  issueCodes: IssueCode[];
  severities: IssueSeverity[];
  errorReportCsv: string;
}

export const mappingRequestSchema = z.object({
  mapping: z.record(z.string(), z.string().nullable()),
  percentageNormalizationMode: z.enum(['AS_DECIMAL', 'PERCENT_TO_DECIMAL', 'AUTO_DETECT']).default('AUTO_DETECT'),
  revalidate: z.boolean().default(true),
});
export type MappingRequest = z.infer<typeof mappingRequestSchema>;

export const commitRequestSchema = z.object({
  snapshotLabel: z.string().min(3).max(120).optional(),
  skipDuplicates: z.boolean().default(true),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  organizationId: string;
  userId: string | null;
  userName: string;
  role: RoleName;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  ipAddress: string | null;
  requestId: string | null;
}

export const AUDIT_ACTIONS = [
  'AUTH.LOGIN',
  'AUTH.LOGOUT',
  'AUTH.LOGIN_FAILED',
  'IMPORT.UPLOADED',
  'IMPORT.PREVIEWED',
  'IMPORT.MAPPED',
  'IMPORT.VALIDATED',
  'IMPORT.COMMITTED',
  'IMPORT.ISSUES_EXPORTED',
  'EXPOSURE.STAGED',
  'EXPOSURE.STAGE_OVERRIDE_REQUESTED',
  'EXPOSURE.STAGE_OVERRIDE_REVIEWED',
  'MODEL_CONFIG.CREATED',
  'MODEL_CONFIG.ACTIVATED',
  'SCENARIO_SET.CREATED',
  'SCENARIO_SET.ACTIVATED',
  'ECL_RUN.CREATED',
  'ECL_RUN.EXECUTED',
  'ECL_RUN.SUBMITTED',
  'ECL_RUN.APPROVED',
  'ECL_RUN.REJECTED',
  'EXCEPTION.ACKNOWLEDGED',
  'REPORT.EXPORTED',
  'TEMPLATE.DOWNLOADED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Session and the download payloads
// ---------------------------------------------------------------------------

export interface SessionUserRecord extends DemoUser {
  permissions: string[];
}

export interface TemplateDownloadRecord {
  fileName: string;
  contentType: string;
  /** Base64 payload so the browser client can trigger a download without a second round trip. */
  contentBase64: string;
  rowCount: number;
  fieldGuide: Array<{ key: string; label: string; kind: string; required: boolean; description: string }>;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: Array<{ path?: string; field?: string; message?: string; observed?: string; expected?: string }>;
  };
}

// Re-exported so the web app has one import site for everything it renders.
export type {
  AiInsight,
  ColumnMapping,
  CopilotMessage,
  ExceptionKind,
  ImportStatus,
  IssueCode,
  IssueSeverity,
  PeriodDto,
  PortfolioField,
  PortfolioTotalsDto,
  ReportDefinition,
  RoleName,
  RunStatus,
  ScenarioDefinitionInput,
  Stage,
  StagingDecision,
  StagingRuleCode,
  StagingRuleSetConfig,
  ValidationIssue,
};
