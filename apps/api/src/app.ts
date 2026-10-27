import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient, SecretBox } from '@stellar-health/db';
import type { ApiConfig } from './config';
import { authPlugin } from './lib/auth';
import { errorHandler } from './lib/errors';
import type { JobBus } from './lib/jobs';
import type { ApiMetrics } from './lib/metrics';
import type { StellarClientFactory } from './lib/stellar';
import { registerOpenApi } from './openapi';
import { alertRuleRoutes } from './routes/alert-rules';
import { alertRoutes } from './routes/alerts';
import { contractRoutes } from './routes/contracts';
import { destinationRoutes } from './routes/destinations';
import { eventRoutes } from './routes/events';
import { settingsRoutes } from './routes/settings';
import { statusRoutes } from './routes/status';

export interface AppDeps {
  config: ApiConfig;
  prisma: PrismaClient;
  redis: Pick<Redis, 'ping'>;
  stellar: StellarClientFactory;
  jobs: JobBus;
  metrics: ApiMetrics;
  secrets: SecretBox;
  /** When set, rate limits are shared across API replicas through Redis. */
  rateLimitRedis?: Redis;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
            ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  // Accept an empty body sent as JSON (e.g. `curl -X POST -H 'content-type: application/json'`)
  // on action endpoints such as /alerts/:id/acknowledge, instead of failing with 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(
        Object.assign(new Error('Request body is not valid JSON'), {
          statusCode: 400,
          code: 'INVALID_JSON',
        }),
        undefined,
      );
    }
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis, nameSpace: 'schm-ratelimit:' } : {}),
    allowList: (req) => req.url === '/health' || req.url === '/ready' || req.url === '/metrics',
  });

  app.addHook('onResponse', async (req, reply) => {
    deps.metrics.httpDuration
      .labels(req.method, req.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  await app.register(authPlugin, { prisma: deps.prisma, adminToken: config.ADMIN_API_TOKEN });
  await registerOpenApi(app);

  await statusRoutes(app, deps);
  await settingsRoutes(app, deps);
  await contractRoutes(app, deps);
  await eventRoutes(app, deps);
  await alertRuleRoutes(app, deps);
  await destinationRoutes(app, deps);
  await alertRoutes(app, deps);

  return app;
}
