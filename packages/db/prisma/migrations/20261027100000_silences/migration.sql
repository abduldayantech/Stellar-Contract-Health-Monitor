CREATE TYPE "SilenceRecurrence" AS ENUM ('DAILY', 'WEEKLY');

ALTER TABLE "Silence"
    ADD COLUMN "recurrence" "SilenceRecurrence",
    ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'UTC';

CREATE INDEX "Silence_contractRefId_startsAt_endsAt_idx"
    ON "Silence"("contractRefId", "startsAt", "endsAt");
CREATE INDEX "Silence_ruleId_startsAt_endsAt_idx"
    ON "Silence"("ruleId", "startsAt", "endsAt");
