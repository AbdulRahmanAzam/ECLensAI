/**
 * ECLens AI shared domain types.
 * Field names follow docs/data-dictionary.md exactly.
 */

export type Stage = 1 | 2 | 3;

export type RoleName = 'ADMIN' | 'RISK_ANALYST' | 'REVIEWER' | 'AUDITOR';

export type ScenarioKind = 'BASE' | 'UPSIDE' | 'DOWNSIDE';

export type RunStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED';

/** An APPROVED run is locked: its results and configuration versions are frozen. */
export const LOCKED_RUN_STATUSES: readonly RunStatus[] = ['APPROVED'];

export const isRunLocked = (status: RunStatus): boolean => LOCKED_RUN_STATUSES.includes(status);

export type ImportStatus =
  | 'QUEUED'
  | 'UPLOADED'
  | 'MAPPING'
  | 'VALIDATING'
  | 'VALIDATED'
  | 'QUARANTINED'
  | 'COMMITTED'
  | 'IMPORTED'
  | 'FAILED';

export type InsightKind = 'RISK_SPIKE' | 'STAGE_MIGRATION' | 'RECOMMENDATION' | 'SUMMARY';

/** One credit exposure as described by the 28-field data dictionary. */
export interface Exposure {
  exposureId: string;
  borrowerId: string;
  borrowerName: string;
  segment: string;
  productType: string;
  originationDate: string; // ISO date
  maturityDate: string; // ISO date
  reportingDate: string; // ISO date
  currency: string; // ISO 4217
  grossCarryingAmount: number;
  undrawnCommitment: number;
  creditConversionFactor: number; // 0..1
  effectiveInterestRate: number; // decimal, e.g. 0.185
  daysPastDue: number;
  originalCreditRating: string;
  currentCreditRating: string;
  twelveMonthPd: number; // 0..1
  lifetimePd: number; // 0..1
  /** 12-month PD observed when the facility was originated; drives the PD-increase SICR test. */
  pdAtOrigination: number; // 0..1
  lgd: number; // 0..1
  collateralValue: number;
  defaultFlag: boolean;
  /** Credit-impaired under IFRS 9 (evidence of default) — implies Stage 3. */
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  /** Concessionary restructuring granted — a SICR trigger distinct from forbearance. */
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  region: string;
  industry: string;
}

/** Exposure enriched with deterministic engine output. */
export interface EnrichedExposure extends Exposure {
  stage: Stage;
  stageReasons: string[];
  ead: number;
  discountFactor: number;
  horizonMonths: number;
  eclByScenario: Record<ScenarioKind, number>;
  weightedEcl: number;
}

export interface MacroIndicators {
  gdpGrowth: number; // decimal, e.g. 0.032 = 3.2%
  inflationRate: number;
  unemploymentRate: number;
  policyRate: number;
}

export interface MacroScenario {
  id: string;
  name: string;
  kind: ScenarioKind;
  weight: number; // 0..1, weights across scenarios must sum to 1
  description: string;
  indicators: MacroIndicators;
}

export interface ModelParameters {
  /** PD multiplier applied under the upside macro view (< 1). */
  pdMultiplierUpside: number;
  /** PD multiplier applied under the downside macro view (> 1). */
  pdMultiplierDownside: number;
  lgdFloor: number;
  lgdCeiling: number;
  defaultCreditConversionFactor: number;
  /** Cap on the lifetime loss horizon used for Stages 2–3. */
  lifetimeHorizonMonths: number;
  /** DPD threshold (days) that alone implies Stage 2. */
  stage2DpdThreshold: number;
  /** DPD threshold (days) that implies credit impairment (Stage 3). */
  stage3DpdThreshold: number;
  /** Rating downgrade (notches) considered a significant increase in credit risk. */
  ratingNotchSicrThreshold: number;
}

export interface ModelConfiguration {
  id: string;
  name: string;
  version: string;
  isActive: boolean;
  description: string;
  approvedBy: string;
  approvedAt: string; // ISO date
  parameters: ModelParameters;
}

export interface StageDistributionEntry {
  balance: number;
  ecl: number;
  count: number;
}

export type StageDistribution = Record<Stage, StageDistributionEntry>;

export interface RunTotals {
  exposureCount: number;
  totalGrossExposure: number;
  totalEad: number;
  totalEcl: number;
  coverageRatio: number;
  stageDistribution: StageDistribution;
}

export interface EclRun {
  id: string;
  runDate: string; // ISO date
  status: RunStatus;
  createdBy: string;
  startedAt: string; // ISO datetime
  completedAt: string | null; // ISO datetime
  durationMs: number | null;
  scenarioWeights: Record<ScenarioKind, number>;
  modelConfigurationName: string;
  modelConfigurationVersion: string;
  totals: RunTotals | null;
  notes: string;
}

export interface EclResultRow {
  exposureId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  grossCarryingAmount: number;
  ead: number;
  pd: number;
  lgd: number;
  weightedEcl: number;
  coverageOfExposure: number; // weightedEcl / grossCarryingAmount
}

export interface PortfolioSnapshot {
  asOf: string; // ISO date
  totalGrossExposure: number;
  totalEcl: number;
  coverageRatio: number;
  stage3Share: number; // share of gross balances in Stage 3
}

export interface AuditEvent {
  id: string;
  occurredAt: string; // ISO datetime
  userName: string;
  role: RoleName;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  ipAddress: string;
}

export interface AiInsight {
  id: string;
  createdAt: string; // ISO datetime
  kind: InsightKind;
  title: string;
  body: string;
  confidence: number; // 0..1
  relatedExposureIds: string[];
}

export interface ImportRecord {
  id: string;
  fileName: string;
  uploadedAt: string; // ISO datetime
  uploadedBy: string;
  rowCount: number;
  status: ImportStatus;
  errorCount: number;
  message: string;
}

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  lastGeneratedAt: string | null; // ISO datetime
}

export interface DemoUser {
  id: string;
  email: string;
  fullName: string;
  role: RoleName;
  organizationName: string;
}

export interface HighRiskRow {
  exposureId: string;
  borrowerName: string;
  segment: string;
  stage: Stage;
  daysPastDue: number;
  currentCreditRating: string;
  grossCarryingAmount: number;
  weightedEcl: number;
  riskReason: string;
}

export interface DashboardSummary {
  asOf: string;
  currency: string;
  totalGrossExposure: number;
  totalEcl: number;
  coverageRatio: number;
  coverageChange30d: number;
  stageDistribution: StageDistribution;
  trend: PortfolioSnapshot[];
  highRisk: HighRiskRow[];
  recentRuns: EclRun[];
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string; // ISO datetime
}
