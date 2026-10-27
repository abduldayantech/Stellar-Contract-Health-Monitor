import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifySchema } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { requiredRole } from '../lib/policy';
import pkg from '../../package.json' with { type: 'json' };
import { errorSchema } from './responses';

/** Converts a Zod schema to JSON Schema (draft 2020-12 compatible, as OpenAPI 3.1 expects). */
export function jsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    // Describe what clients send: e.g. a preprocessed or transformed field shows its input type.
    effectStrategy: 'input',
    pipeStrategy: 'input',
  }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export interface RouteDoc {
  tags: string[];
  summary: string;
  description?: string;
  params?: ZodTypeAny;
  querystring?: ZodTypeAny;
  body?: ZodTypeAny;
  /** Success responses by status code; `null` means no body (e.g. 204). */
  response: Record<number, ZodTypeAny | null>;
  /** Response media type for success responses (defaults to JSON). */
  contentType?: string;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  401: 'Unauthorized',
  503: 'Service unavailable',
};

/**
 * Builds a Fastify route schema from Zod schemas, for the OpenAPI document only.
 * Requests are still validated by the Zod `.parse()` calls in each handler (see `docsOnly`).
 */
export function doc(d: RouteDoc): FastifySchema {
  const response: Record<string, unknown> = {};
  for (const [code, schema] of Object.entries(d.response)) {
    const description = STATUS_TEXT[Number(code)] ?? 'Response';
    if (schema === null) response[code] = { description, type: 'null' };
    else if (d.contentType)
      response[code] = {
        description,
        content: { [d.contentType]: { schema: jsonSchema(schema) } },
      };
    else response[code] = { description, ...jsonSchema(schema) };
  }
  response['4XX'] = { description: 'Client error', ...jsonSchema(errorSchema) };
  return {
    tags: d.tags,
    summary: d.summary,
    ...(d.description ? { description: d.description } : {}),
    ...(d.params ? { params: jsonSchema(d.params) } : {}),
    ...(d.querystring ? { querystring: jsonSchema(d.querystring) } : {}),
    ...(d.body ? { body: jsonSchema(d.body) } : {}),
    response,
  };
}

const TAGS = [
  { name: 'Status', description: 'Health, readiness, metrics and monitoring status' },
  { name: 'Contracts', description: 'Monitored contracts and their storage entries' },
  { name: 'Events', description: 'Ingested contract events' },
  { name: 'Alert rules', description: 'Conditions that raise alerts' },
  { name: 'Alerts', description: 'Raised alerts and notification deliveries' },
  { name: 'Destinations', description: 'Where alert notifications are sent' },
  { name: 'Settings', description: 'RPC providers, API tokens, audit log and preferences' },
];

const SECURITY: Record<string, string[]>[] = [{ bearerAuth: [] }, { apiKey: [] }];

/**
 * Route schemas are documentation only: Zod in each handler stays the single validator (so error
 * responses keep their format), and responses are serialized with plain JSON.stringify instead of
 * being filtered through the response schema.
 */
function docsOnly(app: FastifyInstance) {
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
}

/**
 * Serves the OpenAPI document at /openapi.json and Swagger UI at /docs.
 * Register before any routes so they are all collected.
 */
export async function registerOpenApi(app: FastifyInstance) {
  docsOnly(app);

  // Add auth requirements to each route's docs, from the same policy the auth hook enforces.
  app.addHook('onRoute', (route) => {
    const schema = (route.schema ?? {}) as FastifySchema & Record<string, unknown>;
    if (schema.hide) return;
    if (route.config?.public) {
      route.schema = { ...schema, security: [] };
      return;
    }
    const method = Array.isArray(route.method) ? route.method[0]! : route.method;
    const role = requiredRole(method, route.url);
    const note = `**Required role:** \`${role}\`${role === 'ADMIN' ? '' : ' or higher'}.`;
    const withAuth: FastifySchema & Record<string, unknown> = {
      ...schema,
      security: SECURITY,
      description: schema.description ? `${schema.description}\n\n${note}` : note,
      'x-required-role': role,
    };
    route.schema = withAuth;
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Stellar Contract Health Monitor API',
        version: pkg.version,
        description: [
          'REST API for monitoring Stellar (Soroban) smart contracts.',
          '',
          'Authenticate with `Authorization: Bearer <token>` (or the `x-api-key` header).',
          'Tokens have a role: `VIEWER` can read, `EDITOR` can also make changes, and `ADMIN`',
          'can also manage RPC providers, notification preferences, API tokens and the audit log.',
          'The bootstrap `ADMIN_API_TOKEN` always has the `ADMIN` role.',
          'Each operation lists the role it needs.',
        ].join('\n'),
        license: { name: 'MIT', identifier: 'MIT' },
      },
      tags: TAGS,
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'API token' },
        },
      },
    },
  });

  app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () =>
    app.swagger(),
  );

  // Swagger UI and its assets are public, like the document they display.
  await app.register(async (docs) => {
    docs.addHook('onRoute', (route) => {
      route.config = { ...route.config, public: true };
    });
    await docs.register(swaggerUi, { routePrefix: '/docs' });
  });
}
