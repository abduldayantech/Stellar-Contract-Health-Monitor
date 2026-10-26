-- AlterTable
ALTER TABLE "NotificationDestination" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledReason" TEXT,
ADD COLUMN     "firstFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureAt" TIMESTAMP(3);
