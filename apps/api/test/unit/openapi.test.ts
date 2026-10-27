import { Validator } from '@seriousme/openapi-schema-validator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/app';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createMetrics } from '../../src/lib/metrics';
import { requiredRole } from '../../src/lib/policy';

interface Operation {
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  security?: Record<string, string[]>[];
  'x-required-role'?: string;
}
type Spec = { openapi: string; paths: Record<string, Record<string, Operation>> };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const PUBLIC = ['/health', '/ready', '/metrics'];
/** Action endpoints that take no request body. */
const NO_BODY = [
  'post /alerts/{id}/acknowledge',
  'post /alerts/{id}/resolve',
  'post /deliveries/{id}/retry',
  'post /contracts/{id}/refresh',
  'post /destinations/{id}/rotate-secret',
  'post /destinations/{id}/test',
];

const ADMIN_TOKEN = 'openapi-test-admin-token';

let app: FastifyInstance;
let spec: Spec;

beforeAll(async () => {
  // The spec is built at startup, so no database, Redis or RPC is needed.
  const deps = {
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      ADMIN_API_TOKEN: ADMIN_TOKEN,
    }),
    prisma: { auditLog: { create: async () => ({}) } },
    redis: { ping: async () => 'PONG' },
    stellar: async () => ({}),
    jobs: {},
    metrics: createMetrics(),
    secrets: {},
  } as unknown as AppDeps;
  app = await buildApp(deps);
  const res = await app.inject({ method: 'GET', url: '/openapi.json' });
  expect(res.statusCode).toBe(200);
  spec = res.json();
});

afterAll(() => app.close());

function operations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ path, method, op })),
  );
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    expect(spec.openapi).toBe('3.1.0');
    const validator = new Validator();
    const result = await validator.validate(spec);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('documents the API routes', () => {
    expect(operations().length).toBeGreaterThan(40);
    expect(spec.paths['/contracts']).toHaveProperty('post');
    expect(spec.paths['/docs']).toBeUndefined();
    expect(spec.paths['/openapi.json']).toBeUndefined();
  });

  it('has request schemas for every route', () => {
    for (const { path, method, op } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      for (const param of path.match(/\{(\w+)\}/g) ?? []) {
        const name = param.slice(1, -1);
        expect(op.parameters, where).toContainEqual(expect.objectContaining({ name, in: 'path' }));
      }
      if (['post', 'put', 'patch'].includes(method) && !NO_BODY.includes(`${method} ${path}`)) {
        expect(op.requestBody, where).toBeDefined();
      }
    }
  });

  it('has response schemas for every route', () => {
    for (const { path, method, op } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      const success = Object.entries(op.responses).filter(([code]) => code.startsWith('2'));
      expect(success.length, where).toBeGreaterThan(0);
      for (const [code, res] of success) {
        if (code === '204') expect(res.content, where).toBeUndefined();
        else expect(Object.values(res.content ?? {})[0]?.schema, `${where} ${code}`).toBeDefined();
      }
      expect(op.responses['4XX'], where).toBeDefined();
    }
  });

  it('documents auth and the role each route needs', () => {
    expect(spec).toMatchObject({
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
    });
    for (const { path, method, op } of operations()) {
      if (PUBLIC.includes(path)) {
        expect(op.security, path).toEqual([]);
        continue;
      }
      const route = path.replace(/\{(\w+)\}/g, ':$1');
      expect(op.security, path).toEqual([{ bearerAuth: [] }, { apiKey: [] }]);
      expect(op['x-required-role'], `${method} ${path}`).toBe(
        requiredRole(method.toUpperCase(), route),
      );
    }
    expect(spec.paths['/settings/tokens']!.get!['x-required-role']).toBe('ADMIN');
    expect(spec.paths['/contracts']!.post!['x-required-role']).toBe('EDITOR');
  });
});

describe('docs routes', () => {
  it('serves Swagger UI at /docs without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    const page = res.statusCode === 302 ? await app.inject({ url: res.headers.location! }) : res;
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');

    const asset = await app.inject({ url: '/docs/static/swagger-ui-bundle.js' });
    expect(asset.statusCode).toBe(200);
  });

  it('still requires a token for API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/contracts' });
    expect(res.statusCode).toBe(401);
  });

  it('leaves request validation to Zod, with the usual error format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/settings/networks/test',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { rpcUrl: 'not a url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(res.json().error.message).toContain('rpcUrl');
  });
});
