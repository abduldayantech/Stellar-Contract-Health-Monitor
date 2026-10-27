CREATE TYPE "SilenceRecurrence" AS ENUM ('DAILY', 'WEEKLY');

ALTER TABLE "Alert" ADD COLUMN "silenced" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Silence" (
    "id" TEXT NOT NULL,
    "contractRefId" TEXT,
    "ruleId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "recurrence" "SilenceRecurrence",
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Silence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Silence_contractRefId_startsAt_endsAt_idx" ON "Silence"("contractRefId", "startsAt", "endsAt");
CREATE INDEX "Silence_ruleId_startsAt_endsAt_idx" ON "Silence"("ruleId", "startsAt", "endsAt");

ALTER TABLE "Silence" ADD CONSTRAINT "Silence_contractRefId_fkey"
    FOREIGN KEY ("contractRefId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Silence" ADD CONSTRAINT "Silence_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
