-- AlterTable
ALTER TABLE "Alert" ADD COLUMN "silenced" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Silence" (
    "id" TEXT NOT NULL,
    "contractRefId" TEXT,
    "ruleId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Silence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Silence_startsAt_endsAt_idx" ON "Silence"("startsAt", "endsAt");
CREATE INDEX "Silence_contractRefId_idx" ON "Silence"("contractRefId");
CREATE INDEX "Silence_ruleId_idx" ON "Silence"("ruleId");

-- AddForeignKey
ALTER TABLE "Silence" ADD CONSTRAINT "Silence_contractRefId_fkey" FOREIGN KEY ("contractRefId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Silence" ADD CONSTRAINT "Silence_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
