import { sealDestinationConfig, type Prisma } from '@stellar-health/db';
import type { WorkerDeps } from './deps';

/** Deletes events older than the retention period in batches, and stale worker heartbeats. */
export async function pruneOldData(deps: WorkerDeps) {
  const { prisma, config } = deps;
  let deleted = 0;
  if (config.EVENT_RETENTION_DAYS > 0) {
    const cutoff = new Date(deps.now().getTime() - config.EVENT_RETENTION_DAYS * 86400_000);
    for (;;) {
      const n = await prisma.$executeRaw`
        DELETE FROM "Event" WHERE id IN (
          SELECT id FROM "Event" WHERE "ledgerClosedAt" < ${cutoff} LIMIT 5000
        )`;
      deleted += n;
      if (n < 5000) break;
    }
  }
  await prisma.workerHeartbeat.deleteMany({
    where: { lastBeatAt: { lt: new Date(deps.now().getTime() - 86400_000) } },
  });
  return { deleted };
}

/**
 * Encrypts webhook secrets that were stored before SECRETS_ENCRYPTION_KEY was configured.
 * Runs at worker start-up; a no-op when no key is set or everything is already encrypted.
 */
export async function encryptLegacySecrets(deps: WorkerDeps): Promise<{ updated: number }> {
  if (!deps.secrets.enabled) return { updated: 0 };
  const rows = await deps.prisma.notificationDestination.findMany();
  let updated = 0;
  for (const row of rows) {
    const sealed = sealDestinationConfig(deps.secrets, row.config);
    if (JSON.stringify(sealed) === JSON.stringify(row.config)) continue;
    await deps.prisma.notificationDestination.update({
      where: { id: row.id },
      data: { config: sealed as Prisma.InputJsonValue },
    });
    updated++;
  }
  return { updated };
}
