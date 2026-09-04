-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('ADMIN', 'RISK_ANALYST', 'REVIEWER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('DRAFT', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ImportSourceFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('QUEUED', 'UPLOADED', 'MAPPING', 'VALIDATING', 'VALIDATED', 'QUARANTINED', 'COMMITTED', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "PdBasis" AS ENUM ('MARGINAL', 'CONDITIONAL', 'CUMULATIVE');

-- CreateEnum
CREATE TYPE "SnapshotSource" AS ENUM ('SEED', 'IMPORT', 'RUN');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('DATA_QUALITY', 'ANALYST_OVERRIDE', 'LARGE_ECL_CHANGE', 'NEAR_STAGING_THRESHOLD');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OverrideReviewStatus" AS ENUM ('PENDING_REVIEW', 'REVIEWED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" "RoleName" NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Borrower" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Borrower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "source" "SnapshotSource" NOT NULL DEFAULT 'SEED',
    "inputVersion" TEXT NOT NULL,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "totalGrossExposure" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "totalEcl" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "coverageRatio" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "stage3Share" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exposure" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "originationDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "reportingDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "grossCarryingAmount" DECIMAL(24,2) NOT NULL,
    "undrawnCommitment" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "creditConversionFactor" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "effectiveInterestRate" DECIMAL(20,12) NOT NULL,
    "daysPastDue" INTEGER NOT NULL DEFAULT 0,
    "originalCreditRating" TEXT NOT NULL,
    "currentCreditRating" TEXT NOT NULL,
    "twelveMonthPd" DECIMAL(20,12) NOT NULL,
    "lifetimePd" DECIMAL(20,12) NOT NULL,
    "pdAtOrigination" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "lgd" DECIMAL(20,12) NOT NULL,
    "collateralValue" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "defaultFlag" BOOLEAN NOT NULL DEFAULT false,
    "creditImpairedFlag" BOOLEAN NOT NULL DEFAULT false,
    "forbearanceFlag" BOOLEAN NOT NULL DEFAULT false,
    "restructuringFlag" BOOLEAN NOT NULL DEFAULT false,
    "watchlistFlag" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "simplifiedEadProfile" TEXT NOT NULL DEFAULT 'LINEAR_AMORTIZATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExposureEadPeriod" (
    "id" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "drawnBalance" DECIMAL(24,2) NOT NULL,
    "undrawnCommitment" DECIMAL(24,2) NOT NULL,

    CONSTRAINT "ExposureEadPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExposurePdTermStructure" (
    "id" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "basis" "PdBasis" NOT NULL,
    "points" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExposurePdTermStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sourceFormat" "ImportSourceFormat" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "storageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "previewRowCount" INTEGER NOT NULL DEFAULT 0,
    "validRowCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedRowCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',
    "headers" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "suggestedMapping" JSONB NOT NULL,
    "missingRequiredFields" JSONB NOT NULL,
    "unmappedHeaders" JSONB NOT NULL,
    "percentageNormalization" TEXT NOT NULL DEFAULT 'AUTO_DETECT',
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "rowsSkippedByTruncation" INTEGER NOT NULL DEFAULT 0,
    "rawTable" JSONB NOT NULL,
    "uploadedById" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "committedById" TEXT,
    "committedBy" TEXT,
    "snapshotId" TEXT,
    "snapshotLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportValidationIssue" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sheetRow" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "rawValue" TEXT,
    "issueCode" TEXT NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "suggestedCorrection" TEXT,
    "normalizationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportValidationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioSet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioFactor" (
    "id" TEXT NOT NULL,
    "scenarioSetId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BASE',
    "weight" DECIMAL(20,12) NOT NULL,
    "pdMultiplier" DECIMAL(20,12) NOT NULL,
    "lgdMultiplier" DECIMAL(20,12) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "indicators" JSONB,

    CONSTRAINT "ScenarioFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelConfiguration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "stagingRuleSetId" TEXT NOT NULL,
    "stagingRuleSetVersion" TEXT NOT NULL,
    "stagingRuleSet" JSONB NOT NULL,
    "lgdFloor" DECIMAL(20,12) NOT NULL,
    "lgdCeiling" DECIMAL(20,12) NOT NULL,
    "pdFloor" DECIMAL(20,12) NOT NULL,
    "pdCeiling" DECIMAL(20,12) NOT NULL,
    "lifetimeHorizonMonthsCap" INTEGER NOT NULL,
    "maxCalculationPeriods" INTEGER NOT NULL,
    "discountConvention" TEXT NOT NULL,
    "effectiveInterestRateMin" DECIMAL(20,12) NOT NULL,
    "effectiveInterestRateMax" DECIMAL(20,12) NOT NULL,
    "defaultCreditConversionFactor" DECIMAL(20,12) NOT NULL,
    "defaultSimplifiedEadProfile" TEXT NOT NULL,
    "twelveMonthWindow" INTEGER NOT NULL,
    "exceptionThresholds" JSONB NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "supersedesVersion" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EclRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshotId" TEXT NOT NULL,
    "modelConfigurationId" TEXT NOT NULL,
    "scenarioSetId" TEXT NOT NULL,
    "lockedConfiguration" JSONB,
    "lockedScenarioSet" JSONB,
    "lockedStagingRuleSet" JSONB,
    "scenarioWeights" JSONB,
    "lineage" JSONB,
    "totals" JSONB,
    "notes" TEXT,
    "error" TEXT,
    "readiness" JSONB,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "submittedById" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewDecision" "ReviewDecision",
    "reviewedById" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EclRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EclResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "staging" JSONB NOT NULL,
    "horizonBasisNote" TEXT NOT NULL,
    "remainingContractualMonths" INTEGER NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "grossCarryingAmount" DECIMAL(24,2) NOT NULL,
    "eadAtReportingDate" DECIMAL(24,2) NOT NULL,
    "eadProfileKind" TEXT NOT NULL,
    "eadProfileLabel" TEXT NOT NULL,
    "eadScheduleExtendedFlat" BOOLEAN NOT NULL DEFAULT false,
    "pdSourceKind" TEXT NOT NULL,
    "effectiveInterestRate" DECIMAL(20,12) NOT NULL,
    "discountConvention" TEXT NOT NULL,
    "lifetimePdAtReportingDate" DECIMAL(20,12) NOT NULL,
    "lossAllowance" DECIMAL(24,2) NOT NULL,
    "netCarryingAmount" DECIMAL(24,2) NOT NULL,
    "coverageRatio" DECIMAL(20,12) NOT NULL,
    "coverageOfEad" DECIMAL(20,12) NOT NULL,
    "educationalApproximation" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "lineage" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EclResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EclScenarioResult" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "scenarioCode" TEXT NOT NULL,
    "scenarioName" TEXT NOT NULL,
    "weight" DECIMAL(20,12) NOT NULL,
    "pdMultiplier" DECIMAL(20,12) NOT NULL,
    "lgdMultiplier" DECIMAL(20,12) NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "unweightedEcl" DECIMAL(24,2) NOT NULL,
    "weightedEcl" DECIMAL(24,2) NOT NULL,
    "cumulativePdInHorizon" DECIMAL(20,12) NOT NULL,

    CONSTRAINT "EclScenarioResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EclCalculationPeriod" (
    "id" TEXT NOT NULL,
    "scenarioResultId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "monthsFromReportingDate" INTEGER NOT NULL,
    "marginalPd" DECIMAL(20,12) NOT NULL,
    "cumulativePd" DECIMAL(20,12) NOT NULL,
    "lgd" DECIMAL(20,12) NOT NULL,
    "ead" DECIMAL(24,2) NOT NULL,
    "discountFactor" DECIMAL(20,12) NOT NULL,
    "expectedLoss" DECIMAL(24,2) NOT NULL,
    "weightedExpectedLoss" DECIMAL(24,2) NOT NULL,
    "formulaTrace" TEXT NOT NULL,

    CONSTRAINT "EclCalculationPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagingAssessment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "exposureId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "modelStage" INTEGER NOT NULL,
    "primaryReason" TEXT NOT NULL,
    "primaryRuleCode" TEXT NOT NULL,
    "triggeredRules" JSONB NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "ruleSetVersion" TEXT NOT NULL,
    "hasOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideId" TEXT,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagingAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "stageBefore" INTEGER NOT NULL,
    "stageAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" "RoleName" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerStatus" "OverrideReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,

    CONSTRAINT "StageOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "exposureId" TEXT,
    "runId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "metric" TEXT,
    "acknowledgedById" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExceptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "exposureIds" TEXT[],
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT,
    "message" TEXT,
    "rowCount" INTEGER,
    "storageKey" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_publicId_key" ON "User"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "Borrower_organizationId_idx" ON "Borrower"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Borrower_organizationId_publicId_key" ON "Borrower"("organizationId", "publicId");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_organizationId_asOfDate_idx" ON "PortfolioSnapshot"("organizationId", "asOfDate");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_organizationId_publicId_key" ON "PortfolioSnapshot"("organizationId", "publicId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_organizationId_inputVersion_key" ON "PortfolioSnapshot"("organizationId", "inputVersion");

-- CreateIndex
CREATE INDEX "Exposure_organizationId_segment_idx" ON "Exposure"("organizationId", "segment");

-- CreateIndex
CREATE INDEX "Exposure_snapshotId_idx" ON "Exposure"("snapshotId");

-- CreateIndex
CREATE INDEX "Exposure_borrowerId_idx" ON "Exposure"("borrowerId");

-- CreateIndex
CREATE UNIQUE INDEX "Exposure_snapshotId_publicId_key" ON "Exposure"("snapshotId", "publicId");

-- CreateIndex
CREATE UNIQUE INDEX "ExposureEadPeriod_exposureId_period_key" ON "ExposureEadPeriod"("exposureId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ExposurePdTermStructure_exposureId_key" ON "ExposurePdTermStructure"("exposureId");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_createdAt_idx" ON "ImportBatch"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_organizationId_publicId_key" ON "ImportBatch"("organizationId", "publicId");

-- CreateIndex
CREATE INDEX "ImportValidationIssue_batchId_severity_idx" ON "ImportValidationIssue"("batchId", "severity");

-- CreateIndex
CREATE INDEX "ImportValidationIssue_batchId_rowNumber_idx" ON "ImportValidationIssue"("batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "ScenarioSet_organizationId_isActive_idx" ON "ScenarioSet"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioSet_organizationId_name_version_key" ON "ScenarioSet"("organizationId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioFactor_scenarioSetId_code_key" ON "ScenarioFactor"("scenarioSetId", "code");

-- CreateIndex
CREATE INDEX "ModelConfiguration_organizationId_isActive_idx" ON "ModelConfiguration"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ModelConfiguration_organizationId_name_version_key" ON "ModelConfiguration"("organizationId", "name", "version");

-- CreateIndex
CREATE INDEX "EclRun_organizationId_runDate_idx" ON "EclRun"("organizationId", "runDate");

-- CreateIndex
CREATE INDEX "EclRun_organizationId_status_idx" ON "EclRun"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EclRun_organizationId_publicId_key" ON "EclRun"("organizationId", "publicId");

-- CreateIndex
CREATE INDEX "EclResult_runId_stage_idx" ON "EclResult"("runId", "stage");

-- CreateIndex
CREATE INDEX "EclResult_exposureId_idx" ON "EclResult"("exposureId");

-- CreateIndex
CREATE UNIQUE INDEX "EclResult_runId_exposureId_key" ON "EclResult"("runId", "exposureId");

-- CreateIndex
CREATE UNIQUE INDEX "EclScenarioResult_resultId_scenarioCode_key" ON "EclScenarioResult"("resultId", "scenarioCode");

-- CreateIndex
CREATE UNIQUE INDEX "EclCalculationPeriod_scenarioResultId_period_key" ON "EclCalculationPeriod"("scenarioResultId", "period");

-- CreateIndex
CREATE INDEX "StagingAssessment_exposureId_assessedAt_idx" ON "StagingAssessment"("exposureId", "assessedAt");

-- CreateIndex
CREATE INDEX "StagingAssessment_runId_idx" ON "StagingAssessment"("runId");

-- CreateIndex
CREATE INDEX "StageOverride_exposureId_occurredAt_idx" ON "StageOverride"("exposureId", "occurredAt");

-- CreateIndex
CREATE INDEX "StageOverride_organizationId_reviewerStatus_idx" ON "StageOverride"("organizationId", "reviewerStatus");

-- CreateIndex
CREATE INDEX "ExceptionItem_organizationId_status_severity_idx" ON "ExceptionItem"("organizationId", "status", "severity");

-- CreateIndex
CREATE INDEX "ExceptionItem_exposureId_idx" ON "ExceptionItem"("exposureId");

-- CreateIndex
CREATE INDEX "AiInsight_organizationId_idx" ON "AiInsight"("organizationId");

-- CreateIndex
CREATE INDEX "Document_organizationId_idx" ON "Document"("organizationId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_occurredAt_idx" ON "AuditEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_action_idx" ON "AuditEvent"("organizationId", "action");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Borrower" ADD CONSTRAINT "Borrower_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exposure" ADD CONSTRAINT "Exposure_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exposure" ADD CONSTRAINT "Exposure_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PortfolioSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exposure" ADD CONSTRAINT "Exposure_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExposureEadPeriod" ADD CONSTRAINT "ExposureEadPeriod_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExposurePdTermStructure" ADD CONSTRAINT "ExposurePdTermStructure_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportValidationIssue" ADD CONSTRAINT "ImportValidationIssue_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioSet" ADD CONSTRAINT "ScenarioSet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioFactor" ADD CONSTRAINT "ScenarioFactor_scenarioSetId_fkey" FOREIGN KEY ("scenarioSetId") REFERENCES "ScenarioSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelConfiguration" ADD CONSTRAINT "ModelConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclRun" ADD CONSTRAINT "EclRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclRun" ADD CONSTRAINT "EclRun_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PortfolioSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclRun" ADD CONSTRAINT "EclRun_modelConfigurationId_fkey" FOREIGN KEY ("modelConfigurationId") REFERENCES "ModelConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclRun" ADD CONSTRAINT "EclRun_scenarioSetId_fkey" FOREIGN KEY ("scenarioSetId") REFERENCES "ScenarioSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclResult" ADD CONSTRAINT "EclResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclResult" ADD CONSTRAINT "EclResult_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclScenarioResult" ADD CONSTRAINT "EclScenarioResult_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "EclResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EclCalculationPeriod" ADD CONSTRAINT "EclCalculationPeriod_scenarioResultId_fkey" FOREIGN KEY ("scenarioResultId") REFERENCES "EclScenarioResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingAssessment" ADD CONSTRAINT "StagingAssessment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingAssessment" ADD CONSTRAINT "StagingAssessment_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageOverride" ADD CONSTRAINT "StageOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageOverride" ADD CONSTRAINT "StageOverride_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionItem" ADD CONSTRAINT "ExceptionItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionItem" ADD CONSTRAINT "ExceptionItem_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionItem" ADD CONSTRAINT "ExceptionItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
