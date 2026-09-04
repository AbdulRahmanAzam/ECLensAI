-- CreateEnum
CREATE TYPE "DocumentProcessingStatus" AS ENUM ('QUEUED', 'PARSING', 'INDEXED', 'EXTRACTED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('POLICY', 'BORROWER_FINANCIAL', 'GUIDANCE', 'SUPPORTING', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentSignalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('PORTFOLIO_COPILOT', 'EXPLAIN_ECL', 'IMPORT_MAPPING', 'DATA_QUALITY_INVESTIGATION', 'SCENARIO_DRAFT', 'DOCUMENT_INTELLIGENCE', 'EXECUTIVE_COMMENTARY');

-- CreateEnum
CREATE TYPE "AiRequestStatus" AS ENUM ('SUCCEEDED', 'SCHEMA_REPAIRED', 'SCHEMA_INVALID', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AiFeedbackVote" AS ENUM ('UP', 'DOWN');

-- DropIndex
DROP INDEX "Document_organizationId_idx";

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "kind",
DROP COLUMN "rowCount",
DROP COLUMN "status",
ADD COLUMN     "category" "DocumentCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "chunkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "extraction" JSONB,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "processingStatus" "DocumentProcessingStatus" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "publicId" TEXT NOT NULL,
ADD COLUMN     "seeded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sha256" TEXT NOT NULL,
ADD COLUMN     "sizeBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "uploadedBy" TEXT NOT NULL,
ALTER COLUMN "message" SET NOT NULL,
ALTER COLUMN "message" SET DEFAULT '';

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "page" INTEGER,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "embedding" JSONB,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSignal" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "page" INTEGER,
    "supportingText" TEXT NOT NULL,
    "status" "DocumentSignalStatus" NOT NULL DEFAULT 'PROPOSED',
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "parsed" JSONB,
    "toolActivity" JSONB,
    "status" "AiRequestStatus",
    "model" TEXT,
    "latencyMs" INTEGER,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "feedbackVote" "AiFeedbackVote",
    "feedbackNote" TEXT,
    "aiRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "status" "AiRequestStatus" NOT NULL,
    "model" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorRole" "RoleName" NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicro" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "toolsUsed" TEXT[],
    "sourceRefs" JSONB,
    "dataCategoriesSent" TEXT[],
    "redactionProfile" TEXT NOT NULL,
    "groundingRejected" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "conversationId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRequest_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "Document_organizationId_category_idx" ON "Document"("organizationId", "category");

-- CreateIndex
CREATE INDEX "Document_organizationId_processingStatus_idx" ON "Document"("organizationId", "processingStatus");

-- CreateIndex
CREATE INDEX "Document_organizationId_sha256_idx" ON "Document"("organizationId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_publicId_key" ON "Document"("organizationId", "publicId");

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSignal" ADD CONSTRAINT "DocumentSignal_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSignal" ADD CONSTRAINT "DocumentSignal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

