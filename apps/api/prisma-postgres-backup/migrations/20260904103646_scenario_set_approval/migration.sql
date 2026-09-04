-- CreateEnum
CREATE TYPE "ScenarioApprovalStatus" AS ENUM ('PENDING', 'APPROVED');

-- AlterTable
ALTER TABLE "ScenarioSet" ADD COLUMN     "approvalStatus" "ScenarioApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "approvedById" TEXT;
