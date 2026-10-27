import { Validator } from '@seriousme/openapi-schema-validator';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSecretBox } from '@stellar-health/db';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createMetrics } from '../../src/lib/metrics';

// Route registration doesn't touch the database, so stub dependencies are enough.
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({
    config: loadConfig({ DATABASE_URL: 'postgresql://unused', LOG_LEVEL: 'silent' }),
    prisma: {} as never,
    redis: { ping: async () => 'PONG' },
    stellar: async () => ({}) as never,
    jobs: {} as never,
    metrics: createMetrics(),
    secrets: createSecretBox(null),
  });
  await app.ready();
});
afterAll(() => app.close());

async function spec() {
  const res = await app.inject({ url: '/openapi.json' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document served without a token', async () => {
    const doc = await spec();
    expect(doc.openapi).toBe('3.1.0');
    const result = await new Validator().validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('documents every route the API registers, with request and response schemas', async () => {
    const doc = await spec();
    const documented = new Set(
      Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    const registered = app.registeredRoutes
      .filter(({ method }) => method !== 'HEAD' && method !== 'OPTIONS')
      .filter(({ url }) => url !== '/openapi.json' && url !== '/docs' && !url.startsWith('/docs/'))
      .map(({ method, url }) => `${method} ${url.replace(/:([A-Za-z]+)/g, '{$1}')}`);
    expect(registered.length).toBeGreaterThan(40);
    expect([...registered].sort()).toEqual([...documented].sort());

    for (const [path, ops] of Object.entries(
      doc.paths as Record<string, Record<string, Record<string, unknown>>>,
    )) {
      for (const [method, op] of Object.entries(ops)) {
        const responses = op.responses as Record<string, { content?: unknown }>;
        const success = Object.entries(responses).filter(([s]) => s.startsWith('2'));
        expect(success.length, `${method} ${path}`).toBeGreaterThan(0);
        for (const [status, res] of success) {
          if (status !== '204') expect(res.content, `${method} ${path} ${status}`).toBeDefined();
        }
        if (
          ['post', 'put', 'patch'].includes(method) &&
          !path.includes('/test') &&
          !/refresh|rotate|retry/.test(path)
        )
          expect(op.requestBody, `${method} ${path}`).toBeDefined();
      }
    }
  });

  it('documents auth and the required role', async () => {
    const doc = await spec();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer' });
    expect(doc.paths['/health'].get.security).toEqual([]);
    expect(doc.paths['/contracts'].get['x-required-role']).toBe('VIEWER');
    expect(doc.paths['/contracts'].post['x-required-role']).toBe('EDITOR');
    expect(doc.paths['/settings/tokens'].get['x-required-role']).toBe('ADMIN');
    expect(doc.paths['/settings/tokens'].get.description).toContain('ADMIN');
    expect(doc.paths['/contracts/{id}'].get.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
    const eventParams = doc.paths['/events'].get.parameters.map((p: { name: string }) => p.name);
    expect(eventParams).toEqual(expect.arrayContaining(['topic', 'txHash', 'limit', 'cursor']));
  });

  it('serves Swagger UI at /docs without a token', async () => {
    const res = await app.inject({ url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('swagger');
    const json = await app.inject({ url: '/docs/json' });
    expect(json.statusCode).toBe(200);
    expect(json.json().openapi).toBe('3.1.0');
  });
});
