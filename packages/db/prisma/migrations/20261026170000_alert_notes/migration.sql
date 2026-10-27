-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "acknowledgeNote" TEXT,
ADD COLUMN     "resolveNote" TEXT,
ADD COLUMN     "resolvedBy" TEXT;
