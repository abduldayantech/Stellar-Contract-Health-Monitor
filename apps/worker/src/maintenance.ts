import { sealDestinationConfig, type Prisma } from '@stellar-health/db';
import type { WorkerDeps } from './deps';

/** Rows removed per DELETE, so pruning never holds long locks or builds a huge transaction. */
export const PRUNE_BATCH_SIZE = 5000;

/** Runs a batched delete until a batch comes back short; returns the total deleted. */
async function deleteInBatches(deleteBatch: (limit: number) => Promise<number>, batchSize: number) {
  let total = 0;
  for (;;) {
    const n = await deleteBatch(batchSize);
    total += n;
    if (n < batchSize) return total;
  }
}

/**
 * Deletes events and audit log rows older than their retention periods (0 keeps them forever),
 * in batches, and stale worker heartbeats.
 */
export async function pruneOldData(deps: WorkerDeps, batchSize = PRUNE_BATCH_SIZE) {
  const { prisma, config } = deps;
  const daysAgo = (days: number) => new Date(deps.now().getTime() - days * 86400_000);

  let deleted = 0;
  if (config.EVENT_RETENTION_DAYS > 0) {
    const cutoff = daysAgo(config.EVENT_RETENTION_DAYS);
    deleted = await deleteInBatches(
      (limit) => prisma.$executeRaw`
        DELETE FROM "Event" WHERE id IN (
          SELECT id FROM "Event" WHERE "ledgerClosedAt" < ${cutoff} LIMIT ${limit}
        )`,
      batchSize,
    );
  }

  let auditDeleted = 0;
  if (config.AUDIT_LOG_RETENTION_DAYS > 0) {
    const cutoff = daysAgo(config.AUDIT_LOG_RETENTION_DAYS);
    auditDeleted = await deleteInBatches(
      (limit) => prisma.$executeRaw`
        DELETE FROM "AuditLog" WHERE id IN (
          SELECT id FROM "AuditLog" WHERE "createdAt" < ${cutoff} LIMIT ${limit}
        )`,
      batchSize,
    );
  }

  await prisma.workerHeartbeat.deleteMany({
    where: { lastBeatAt: { lt: daysAgo(1) } },
  });
  return { deleted, auditDeleted };
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
