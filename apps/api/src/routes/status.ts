import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAllNetworkConfigs } from '@stellar-health/db';
import type { AppDeps } from '../app';
import { doc } from '../openapi';
import { healthSchema, readySchema, statusSchema } from '../openapi/responses';

const tags = ['Status'];

const WORKER_STALE_MS = 60_000;

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; latencyMs: number; error?: string; value?: T }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Date.now() - started, value };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export async function statusRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, redis, jobs, metrics, config } = deps;

  /** Liveness: the process is up. */
  app.get(
    '/health',
    {
      config: { public: true },
      schema: doc({ tags, summary: 'Liveness check', response: { 200: healthSchema } }),
    },
    async () => ({ status: 'ok' }),
  );

  /** Readiness: dependencies reachable. */
  app.get(
    '/ready',
    {
      config: { public: true },
      schema: doc({
        tags,
        summary: 'Readiness check',
        description: 'Checks that the database and Redis are reachable. Returns 503 when not.',
        response: { 200: readySchema, 503: readySchema },
      }),
    },
    async (_req, reply) => {
      const [db, cache] = await Promise.all([
        timed(() => prisma.$queryRaw`SELECT 1`),
        timed(() => redis.ping()),
      ]);
      const ok = db.ok && cache.ok;
      reply.status(ok ? 200 : 503);
      return { status: ok ? 'ready' : 'degraded', database: db.ok, redis: cache.ok };
    },
  );

  app.get(
    '/metrics',
    {
      config: { public: true },
      schema: doc({
        tags,
        summary: 'Prometheus metrics',
        description:
          'Public unless `METRICS_TOKEN` is set, in which case send `Authorization: Bearer <METRICS_TOKEN>`.',
        contentType: 'text/plain',
        response: { 200: z.string(), 401: z.string() },
      }),
    },
    async (req, reply) => {
      if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
        reply.status(401);
        return 'unauthorized';
      }
      reply.header('content-type', metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  /** Full monitoring status for the dashboard. */
  app.get(
    '/status',
    {
      schema: doc({
        tags,
        summary: 'Monitoring status for the dashboard',
        description: 'Dependency health, workers, RPC networks and totals.',
        response: { 200: statusSchema },
      }),
    },
    async () => {
      const since24h = new Date(Date.now() - 86400_000);
      const [
        db,
        cache,
        queues,
        heartbeats,
        networks,
        states,
        contracts,
        events24h,
        openAlerts,
        failed24h,
      ] = await Promise.all([
        timed(() => prisma.$queryRaw`SELECT 1`),
        timed(() => redis.ping()),
        timed(() => jobs.counts()),
        prisma.workerHeartbeat.findMany(),
        resolveAllNetworkConfigs(prisma),
        prisma.networkState.findMany(),
        prisma.contract.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.event.count({ where: { ledgerClosedAt: { gte: since24h } } }),
        prisma.alert.count({ where: { status: 'TRIGGERED' } }),
        prisma.notificationDelivery.count({
          where: { status: 'FAILED', updatedAt: { gte: since24h } },
        }),
      ]);
      const now = Date.now();
      const stateMap = new Map(states.map((s) => [s.network, s]));
      const workers = heartbeats.map((h) => ({
        name: h.name,
        lastBeatAt: h.lastBeatAt,
        healthy: now - h.lastBeatAt.getTime() < WORKER_STALE_MS,
        info: h.info,
      }));
      return {
        database: { ok: db.ok, latencyMs: db.latencyMs, error: db.error },
        redis: { ok: cache.ok, latencyMs: cache.latencyMs, error: cache.error },
        queues: queues.value ?? null,
        workers,
        workerHealthy: workers.some((w) => w.healthy),
        networks: networks.map((n) => {
          const s = stateMap.get(n.network);
          return {
            network: n.network,
            rpcUrl: n.rpcUrl || null,
            configured: Boolean(n.rpcUrl) && n.enabled,
            source: n.source,
            latestLedger: s?.latestLedger ?? null,
            oldestLedger: s?.oldestLedger ?? null,
            lastCheckedAt: s?.lastCheckedAt ?? null,
            lastError: s?.lastError ?? null,
          };
        }),
        totals: {
          contracts: Object.fromEntries(contracts.map((c) => [c.status, c._count._all])),
          events24h,
          openAlerts,
          failedDeliveries24h: failed24h,
        },
      };
    },
  );
}
