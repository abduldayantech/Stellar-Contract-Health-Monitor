import { createServer } from 'node:http';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createSecretBox, disconnectPrisma, getPrisma, type Prisma } from '@stellar-health/db';
import {
  DELIVERY_BACKOFF,
  QUEUES,
  type IngestJobData,
  type NotificationJobData,
  type SchedulerJobName,
  type StorageJobData,
} from '@stellar-health/shared-types';
import { loadConfig } from './config';
import {
  deliverNotification,
  deliveryBackoff,
  PermanentDeliveryError,
  type DeliveryDeps,
} from './delivery';
import type { WorkerDeps } from './deps';
import { checkInactivity } from './inactivity';
import { ingestBatch, ingestContract } from './ingest';
import { planIngestJobs } from './plan';
import { createMailer } from './mailer';
import { encryptLegacySecrets, pruneOldData } from './maintenance';
import { createWorkerMetrics } from './metrics';
import { createClientFactory, NetworkNotConfiguredError } from './rpc';
import { checkStorage } from './storage';

const HEARTBEAT_MS = 15_000;

async function main() {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker', worker: config.WORKER_NAME },
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
  const prisma = getPrisma();
  const metrics = createWorkerMetrics();
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const ingestQueue = new Queue<IngestJobData>(QUEUES.ingest, { connection });
  const storageQueue = new Queue<StorageJobData>(QUEUES.storage, { connection });
  const notificationQueue = new Queue<NotificationJobData>(QUEUES.notifications, { connection });
  const schedulerQueue = new Queue(QUEUES.scheduler, { connection });
  const queues = [ingestQueue, storageQueue, notificationQueue, schedulerQueue];

  const deps: DeliveryDeps = {
    config,
    prisma,
    logger,
    metrics,
    now: () => new Date(),
    secrets: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
    getClient: createClientFactory(prisma, metrics),
    mailer: createMailer(config),
    enqueueDelivery: async (deliveryId) => {
      await notificationQueue.add(
        'deliver',
        { deliveryId },
        {
          jobId: `delivery-${deliveryId}`,
          attempts: config.WEBHOOK_MAX_ATTEMPTS,
          backoff: DELIVERY_BACKOFF,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
    },
  };
  const baseDeps: WorkerDeps = deps;
  const legacy = await encryptLegacySecrets(baseDeps);
  if (legacy.updated > 0)
    logger.info(legacy, 'encrypted webhook secrets stored before encryption was enabled');
  if (!deps.secrets.enabled)
    logger.warn('SECRETS_ENCRYPTION_KEY is not set: webhook secrets are stored unencrypted');

  // ---- Recurring schedules (idempotent: safe with several worker replicas) ----
  const schedules: [SchedulerJobName, number][] = [
    ['tick-ingest', config.INGEST_INTERVAL_MS],
    ['tick-storage', config.STORAGE_CHECK_INTERVAL_MS],
    ['tick-inactivity', config.INACTIVITY_CHECK_INTERVAL_MS],
    ['prune-events', 6 * 3600_000],
  ];
  for (const [name, every] of schedules) {
    await schedulerQueue.upsertJobScheduler(
      name,
      { every },
      { name, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  const fanOut = async (queue: Queue, prefix: string) => {
    const contracts = await prisma.contract.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    await queue.addBulk(
      contracts.map((c) => ({
        name: prefix,
        data: { contractRefId: c.id },
        // One pending job per contract: ticks never pile up behind a slow RPC.
        opts: { jobId: `${prefix}-${c.id}`, removeOnComplete: true, removeOnFail: true },
      })),
    );
    return contracts.length;
  };

  const fanOutIngest = async () => {
    const [contracts, states] = await Promise.all([
      prisma.contract.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, network: true, cursor: true, lastIngestedLedger: true },
      }),
      prisma.networkState.findMany({ select: { network: true, latestLedger: true } }),
    ]);
    const latest = new Map(
      states
        .filter((s) => s.latestLedger !== null)
        .map((s) => [s.network as string, s.latestLedger!]),
    );
    const jobs = planIngestJobs(contracts, latest, {
      batchSize: config.INGEST_BATCH_SIZE,
      maxLagLedgers: config.INGEST_BATCH_MAX_LAG_LEDGERS,
    });
    await ingestQueue.addBulk(
      jobs.map((j) => ({
        name: 'ingest',
        data:
          j.kind === 'batch'
            ? { contractRefIds: j.contractRefIds }
            : { contractRefId: j.contractRefId },
        // One pending job per contract or batch: ticks never pile up behind a slow RPC.
        opts: { jobId: j.jobId, removeOnComplete: true, removeOnFail: true },
      })),
    );
    return { contracts: contracts.length, jobs: jobs.length };
  };

  const workers = [
    new Worker(
      QUEUES.scheduler,
      async (job: Job) => {
        switch (job.name as SchedulerJobName) {
          case 'tick-ingest':
            return fanOutIngest();
          case 'tick-storage':
            return { queued: await fanOut(storageQueue, 'storage') };
          case 'tick-inactivity':
            return checkInactivity(baseDeps);
          case 'prune-events':
            return pruneOldData(baseDeps);
        }
      },
      { connection, concurrency: 1 },
    ),
    new Worker<IngestJobData>(
      QUEUES.ingest,
      async (job) => {
        try {
          return 'contractRefIds' in job.data
            ? await ingestBatch(baseDeps, job.data.contractRefIds)
            : await ingestContract(baseDeps, job.data.contractRefId);
        } catch (err) {
          if (err instanceof NetworkNotConfiguredError) throw new UnrecoverableError(err.message);
          throw err;
        }
      },
      { connection, concurrency: config.INGEST_CONCURRENCY },
    ),
    new Worker<StorageJobData>(
      QUEUES.storage,
      async (job) => checkStorage(baseDeps, job.data.contractRefId),
      {
        connection,
        concurrency: 2,
      },
    ),
    new Worker<NotificationJobData>(
      QUEUES.notifications,
      async (job) => {
        const maxAttempts = job.opts.attempts ?? 1;
        try {
          return await deliverNotification(deps, job.data.deliveryId, {
            number: job.attemptsMade + 1,
            isFinalAttempt: job.attemptsMade + 1 >= maxAttempts,
          });
        } catch (err) {
          if (err instanceof PermanentDeliveryError) throw new UnrecoverableError(err.message);
          throw err;
        }
      },
      {
        connection,
        concurrency: config.NOTIFICATION_CONCURRENCY,
        settings: { backoffStrategy: deliveryBackoff },
      },
    ),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) =>
      logger.warn({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'),
    );
    w.on('error', (err) => logger.error({ queue: w.name, err }, 'worker error'));
  }

  // ---- Heartbeat + gauges ----
  const startedAt = new Date();
  const beat = async () => {
    try {
      const counts: Record<string, Record<string, number>> = {};
      for (const q of queues) {
        counts[q.name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts[q.name]!))
          metrics.queueDepth.labels(q.name, state).set(n);
      }
      const lags = await prisma.$queryRaw<{ network: string; lag: number | null }[]>`
        SELECT c."network"::text AS network, MAX(s."latestLedger" - c."lastIngestedLedger") AS lag
        FROM "Contract" c JOIN "NetworkState" s ON s."network" = c."network"
        WHERE c."status" = 'ACTIVE' GROUP BY 1`;
      for (const l of lags)
        metrics.maxIngestionLag.labels(l.network).set(Math.max(0, Number(l.lag ?? 0)));
      await prisma.workerHeartbeat.upsert({
        where: { name: config.WORKER_NAME },
        create: {
          name: config.WORKER_NAME,
          lastBeatAt: new Date(),
          info: { startedAt, counts } as Prisma.InputJsonValue,
        },
        update: { lastBeatAt: new Date(), info: { startedAt, counts } as Prisma.InputJsonValue },
      });
    } catch (err) {
      logger.error({ err }, 'heartbeat failed');
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);

  // ---- Metrics / health endpoint ----
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
    } else if (req.url === '/health') {
      const running = workers.every((w) => w.isRunning());
      res.statusCode = running ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: running ? 'ok' : 'degraded' }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(config.WORKER_METRICS_PORT, () =>
    logger.info({ port: config.WORKER_METRICS_PORT, smtp: Boolean(deps.mailer) }, 'worker started'),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down; waiting for active jobs');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    clearInterval(heartbeat);
    server.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(queues.map((q) => q.close()));
    connection.disconnect();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
