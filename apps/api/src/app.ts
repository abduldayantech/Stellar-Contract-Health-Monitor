import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient, SecretBox } from '@stellar-health/db';
import type { ApiConfig } from './config';
import { authPlugin } from './lib/auth';
import { errorHandler, sendError } from './lib/errors';
import { REQUEST_ID_HEADER, requestIdFor } from './lib/request-id';
import type { JobBus } from './lib/jobs';
import type { ApiMetrics } from './lib/metrics';
import type { StellarClientFactory } from './lib/stellar';
import { buildOpenApiDocument } from './openapi/document';
import pkg from '../package.json' with { type: 'json' };
import { alertRuleRoutes } from './routes/alert-rules';
import { alertRoutes } from './routes/alerts';
import { contractRoutes } from './routes/contracts';
import { destinationRoutes } from './routes/destinations';
import { eventRoutes } from './routes/events';
import { settingsRoutes } from './routes/settings';
import { silenceRoutes } from './routes/silences';
import { statusRoutes } from './routes/status';

declare module 'fastify' {
  interface FastifyInstance {
    registeredRoutes: { method: string; url: string }[];
  }
}

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
    // Validated in requestIdFor; Fastify would otherwise trust the header verbatim.
    requestIdHeader: false,
    genReqId: requestIdFor,
    bodyLimit: 256 * 1024,
  });

  // Every registered route, so tests can check the OpenAPI document covers them all.
  const registeredRoutes: { method: string; url: string }[] = [];
  app.decorate('registeredRoutes', registeredRoutes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
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

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    sendError(req, reply, 404, {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.url} not found`,
    });
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

  // API reference: the OpenAPI document and Swagger UI need no token.
  const openApi = buildOpenApiDocument({ version: pkg.version });
  app.addHook('onRoute', (route) => {
    if (route.url === '/docs' || route.url.startsWith('/docs/'))
      route.config = { ...route.config, public: true };
  });
  await app.register(swagger, { mode: 'static', specification: { document: openApi as never } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { config: { public: true } }, async () => openApi);

  await statusRoutes(app, deps);
  await settingsRoutes(app, deps);
  await contractRoutes(app, deps);
  await eventRoutes(app, deps);
  await alertRuleRoutes(app, deps);
  await destinationRoutes(app, deps);
  await alertRoutes(app, deps);
  await silenceRoutes(app, deps);

  return app;
}
