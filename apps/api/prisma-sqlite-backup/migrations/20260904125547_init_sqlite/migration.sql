-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Borrower" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Borrower_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "asOfDate" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SEED',
    "inputVersion" TEXT NOT NULL,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "totalGrossExposure" DECIMAL NOT NULL DEFAULT 0,
    "totalEcl" DECIMAL NOT NULL DEFAULT 0,
    "coverageRatio" DECIMAL NOT NULL DEFAULT 0,
    "stage3Share" DECIMAL NOT NULL DEFAULT 0,
    "importBatchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PortfolioSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Exposure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "originationDate" DATETIME NOT NULL,
    "maturityDate" DATETIME NOT NULL,
    "reportingDate" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "grossCarryingAmount" DECIMAL NOT NULL,
    "undrawnCommitment" DECIMAL NOT NULL DEFAULT 0,
    "creditConversionFactor" DECIMAL NOT NULL DEFAULT 0,
    "effectiveInterestRate" DECIMAL NOT NULL,
    "daysPastDue" INTEGER NOT NULL DEFAULT 0,
    "originalCreditRating" TEXT NOT NULL,
    "currentCreditRating" TEXT NOT NULL,
    "twelveMonthPd" DECIMAL NOT NULL,
    "lifetimePd" DECIMAL NOT NULL,
    "pdAtOrigination" DECIMAL NOT NULL DEFAULT 0,
    "lgd" DECIMAL NOT NULL,
    "collateralValue" DECIMAL NOT NULL DEFAULT 0,
    "defaultFlag" BOOLEAN NOT NULL DEFAULT false,
    "creditImpairedFlag" BOOLEAN NOT NULL DEFAULT false,
    "forbearanceFlag" BOOLEAN NOT NULL DEFAULT false,
    "restructuringFlag" BOOLEAN NOT NULL DEFAULT false,
    "watchlistFlag" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "simplifiedEadProfile" TEXT NOT NULL DEFAULT 'LINEAR_AMORTIZATION',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Exposure_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Exposure_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PortfolioSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Exposure_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExposureEadPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exposureId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "drawnBalance" DECIMAL NOT NULL,
    "undrawnCommitment" DECIMAL NOT NULL,
    CONSTRAINT "ExposureEadPeriod_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExposurePdTermStructure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exposureId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExposurePdTermStructure_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
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
    "committedAt" DATETIME,
    "committedById" TEXT,
    "committedBy" TEXT,
    "snapshotId" TEXT,
    "snapshotLabel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportValidationIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sheetRow" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "rawValue" TEXT,
    "issueCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "suggestedCorrection" TEXT,
    "normalizationNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportValidationIssue_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScenarioSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    CONSTRAINT "ScenarioSet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScenarioFactor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scenarioSetId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BASE',
    "weight" DECIMAL NOT NULL,
    "pdMultiplier" DECIMAL NOT NULL,
    "lgdMultiplier" DECIMAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "indicators" JSONB,
    CONSTRAINT "ScenarioFactor_scenarioSetId_fkey" FOREIGN KEY ("scenarioSetId") REFERENCES "ScenarioSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "stagingRuleSetId" TEXT NOT NULL,
    "stagingRuleSetVersion" TEXT NOT NULL,
    "stagingRuleSet" JSONB NOT NULL,
    "lgdFloor" DECIMAL NOT NULL,
    "lgdCeiling" DECIMAL NOT NULL,
    "pdFloor" DECIMAL NOT NULL,
    "pdCeiling" DECIMAL NOT NULL,
    "lifetimeHorizonMonthsCap" INTEGER NOT NULL,
    "maxCalculationPeriods" INTEGER NOT NULL,
    "discountConvention" TEXT NOT NULL,
    "effectiveInterestRateMin" DECIMAL NOT NULL,
    "effectiveInterestRateMax" DECIMAL NOT NULL,
    "defaultCreditConversionFactor" DECIMAL NOT NULL,
    "defaultSimplifiedEadProfile" TEXT NOT NULL,
    "twelveMonthWindow" INTEGER NOT NULL,
    "exceptionThresholds" JSONB NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" DATETIME NOT NULL,
    "supersedesVersion" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EclRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "runDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
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
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "submittedById" TEXT,
    "submittedBy" TEXT,
    "submittedAt" DATETIME,
    "reviewDecision" TEXT,
    "reviewedById" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "reviewComment" TEXT,
    "lockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EclRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EclRun_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PortfolioSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EclRun_modelConfigurationId_fkey" FOREIGN KEY ("modelConfigurationId") REFERENCES "ModelConfiguration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EclRun_scenarioSetId_fkey" FOREIGN KEY ("scenarioSetId") REFERENCES "ScenarioSet" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EclResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "staging" JSONB NOT NULL,
    "horizonBasisNote" TEXT NOT NULL,
    "remainingContractualMonths" INTEGER NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "grossCarryingAmount" DECIMAL NOT NULL,
    "eadAtReportingDate" DECIMAL NOT NULL,
    "eadProfileKind" TEXT NOT NULL,
    "eadProfileLabel" TEXT NOT NULL,
    "eadScheduleExtendedFlat" BOOLEAN NOT NULL DEFAULT false,
    "pdSourceKind" TEXT NOT NULL,
    "effectiveInterestRate" DECIMAL NOT NULL,
    "discountConvention" TEXT NOT NULL,
    "lifetimePdAtReportingDate" DECIMAL NOT NULL,
    "lossAllowance" DECIMAL NOT NULL,
    "netCarryingAmount" DECIMAL NOT NULL,
    "coverageRatio" DECIMAL NOT NULL,
    "coverageOfEad" DECIMAL NOT NULL,
    "educationalApproximation" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "lineage" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EclResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EclResult_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EclScenarioResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resultId" TEXT NOT NULL,
    "scenarioCode" TEXT NOT NULL,
    "scenarioName" TEXT NOT NULL,
    "weight" DECIMAL NOT NULL,
    "pdMultiplier" DECIMAL NOT NULL,
    "lgdMultiplier" DECIMAL NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "unweightedEcl" DECIMAL NOT NULL,
    "weightedEcl" DECIMAL NOT NULL,
    "cumulativePdInHorizon" DECIMAL NOT NULL,
    CONSTRAINT "EclScenarioResult_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "EclResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EclCalculationPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scenarioResultId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "monthsFromReportingDate" INTEGER NOT NULL,
    "marginalPd" DECIMAL NOT NULL,
    "cumulativePd" DECIMAL NOT NULL,
    "lgd" DECIMAL NOT NULL,
    "ead" DECIMAL NOT NULL,
    "discountFactor" DECIMAL NOT NULL,
    "expectedLoss" DECIMAL NOT NULL,
    "weightedExpectedLoss" DECIMAL NOT NULL,
    "formulaTrace" TEXT NOT NULL,
    CONSTRAINT "EclCalculationPeriod_scenarioResultId_fkey" FOREIGN KEY ("scenarioResultId") REFERENCES "EclScenarioResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StagingAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "assessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StagingAssessment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StagingAssessment_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StageOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "stageBefore" INTEGER NOT NULL,
    "stageAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "reviewedAt" DATETIME,
    "reviewComment" TEXT,
    CONSTRAINT "StageOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StageOverride_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExceptionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "exposureId" TEXT,
    "runId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "metric" TEXT,
    "acknowledgedById" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExceptionItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExceptionItem_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "Exposure" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExceptionItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EclRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "exposureIds" JSONB NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT,
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "processingStatus" TEXT NOT NULL DEFAULT 'QUEUED',
    "message" TEXT NOT NULL DEFAULT '',
    "documentType" TEXT,
    "summary" TEXT,
    "extraction" JSONB,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT,
    "uploadedById" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "page" INTEGER,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "embedding" JSONB,
    "embeddingModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DocumentSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "page" INTEGER,
    "supportingText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentSignal_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentSignal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiConversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parsed" JSONB,
    "toolActivity" JSONB,
    "status" TEXT,
    "model" TEXT,
    "latencyMs" INTEGER,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "feedbackVote" TEXT,
    "feedbackNote" TEXT,
    "aiRequestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicro" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "toolsUsed" JSONB NOT NULL,
    "sourceRefs" JSONB,
    "dataCategoriesSent" JSONB NOT NULL,
    "redactionProfile" TEXT NOT NULL,
    "groundingRejected" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "conversationId" TEXT,
    "requestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
CREATE INDEX "Document_organizationId_category_idx" ON "Document"("organizationId", "category");

-- CreateIndex
CREATE INDEX "Document_organizationId_processingStatus_idx" ON "Document"("organizationId", "processingStatus");

-- CreateIndex
CREATE INDEX "Document_organizationId_sha256_idx" ON "Document"("organizationId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_publicId_key" ON "Document"("organizationId", "publicId");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_idx" ON "DocumentChunk"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_ordinal_key" ON "DocumentChunk"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "DocumentSignal_documentId_status_idx" ON "DocumentSignal"("documentId", "status");

-- CreateIndex
CREATE INDEX "DocumentSignal_organizationId_status_idx" ON "DocumentSignal"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AiConversation_organizationId_updatedAt_idx" ON "AiConversation"("organizationId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiConversation_organizationId_publicId_key" ON "AiConversation"("organizationId", "publicId");

-- CreateIndex
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiMessage_organizationId_idx" ON "AiMessage"("organizationId");

-- CreateIndex
CREATE INDEX "AiRequest_organizationId_createdAt_idx" ON "AiRequest"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRequest_organizationId_feature_idx" ON "AiRequest"("organizationId", "feature");

-- CreateIndex
CREATE INDEX "AiRequest_organizationId_status_idx" ON "AiRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_occurredAt_idx" ON "AuditEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_action_idx" ON "AuditEvent"("organizationId", "action");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
