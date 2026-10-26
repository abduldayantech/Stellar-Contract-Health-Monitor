/** BullMQ queue names shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  scheduler: 'scheduler',
  ingest: 'ingest',
  storage: 'storage',
  notifications: 'notifications',
} as const;

/** One contract, or a batch of caught-up contracts on the same network polled together. */
export type IngestJobData = { contractRefId: string } | { contractRefIds: string[] };

export interface StorageJobData {
  contractRefId: string;
}

export interface NotificationJobData {
  deliveryId: string;
}

/**
 * Retry policy for notification jobs. The worker registers a custom backoff strategy for this
 * type: exponential from 10s, but never sooner than a destination's `Retry-After`.
 */
export const DELIVERY_BACKOFF = { type: 'delivery', delay: 10_000 } as const;

export type SchedulerJobName = 'tick-ingest' | 'tick-storage' | 'tick-inactivity' | 'prune-events';
