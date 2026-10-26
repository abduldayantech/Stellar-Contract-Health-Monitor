import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  DELIVERY_BACKOFF,
  QUEUES,
  type IngestJobData,
  type NotificationJobData,
  type StorageJobData,
} from '@stellar-health/shared-types';

/** Producer side of the worker queues. An interface so tests can substitute an in-memory fake. */
export interface JobBus {
  enqueueIngest(contractRefId: string): Promise<void>;
  enqueueStorageCheck(contractRefId: string): Promise<void>;
  enqueueDelivery(deliveryId: string): Promise<void>;
  counts(): Promise<Record<string, Record<string, number>>>;
  close(): Promise<void>;
}

export function createJobBus(connection: Redis, maxAttempts = 6): JobBus {
  const ingest = new Queue<IngestJobData>(QUEUES.ingest, { connection });
  const storage = new Queue<StorageJobData>(QUEUES.storage, { connection });
  const notifications = new Queue<NotificationJobData>(QUEUES.notifications, { connection });
  const all = [ingest, storage, notifications];

  return {
    async enqueueIngest(contractRefId) {
      // Deduplicate: a manual refresh while a poll is queued should not double up.
      await ingest.add(
        'ingest',
        { contractRefId },
        { jobId: `ingest-${contractRefId}`, removeOnComplete: true, removeOnFail: true },
      );
    },
    async enqueueStorageCheck(contractRefId) {
      await storage.add(
        'storage',
        { contractRefId },
        { jobId: `storage-${contractRefId}`, removeOnComplete: true, removeOnFail: true },
      );
    },
    async enqueueDelivery(deliveryId) {
      await notifications.add(
        'deliver',
        { deliveryId },
        {
          jobId: `delivery-${deliveryId}-${Date.now()}`,
          attempts: maxAttempts,
          backoff: DELIVERY_BACKOFF,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
    },
    async counts() {
      const out: Record<string, Record<string, number>> = {};
      for (const q of all) {
        out[q.name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      }
      return out;
    },
    async close() {
      await Promise.all(all.map((q) => q.close()));
    },
  };
}
