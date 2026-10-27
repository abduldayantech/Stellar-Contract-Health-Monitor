import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  createAlertRuleSchema,
  createApiTokenSchema,
  createContractSchema,
  createDestinationSchema,
  createSilenceSchema,
  createStorageEntrySchema,
  createSilenceSchema,
  listAlertsQuerySchema,
  listAuditLogQuerySchema,
  exportEventsQuerySchema,
  listEventsQuerySchema,
  networkSchema,
  notificationPreferencesSchema,
  updateAlertRuleSchema,
  updateContractSchema,
  updateDestinationSchema,
  updateSilenceSchema,
  upsertNetworkConfigSchema,
  validateContractSchema,
} from '@stellar-health/shared-types';
import { requiredRole } from '../lib/policy';
import * as r from './responses';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface ResponseDoc {
  description: string;
  schema?: ZodTypeAny;
  /** Defaults to application/json. */
  contentType?: string;
}

export interface RouteDoc {
  method: Method;
  /** Fastify-style path, e.g. /contracts/:id */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  query?: z.AnyZodObject;
  body?: ZodTypeAny;
  responses: Record<number, ResponseDoc>;
  /** No token needed. */
  public?: boolean;
}

const ok = (schema: ZodTypeAny, description = 'OK'): ResponseDoc => ({ description, schema });
const noContent: ResponseDoc = { description: 'Done; no body' };

const contractsQuery = z.object({
  network: networkSchema.optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ERROR']).optional(),
  search: z.string().max(120).optional().describe('Matches the label or contract ID'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional().describe('nextCursor from the previous page'),
});
const activityQuery = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
});
const byContractQuery = z.object({ contractRefId: z.string().optional() });
const alertActionBody = z.object({}).describe('No body needed').optional();

/** Every API route. A unit test checks this list matches the routes the app registers. */
export const ROUTES: RouteDoc[] = [
  // ---- Status ----
  {
    method: 'get',
    path: '/health',
    tag: 'Status',
    summary: 'Liveness probe',
    public: true,
    responses: { 200: ok(r.health) },
  },
  {
    method: 'get',
    path: '/ready',
    tag: 'Status',
    summary: 'Readiness probe (database and Redis reachable)',
    public: true,
    responses: { 200: ok(r.ready, 'Ready'), 503: ok(r.ready, 'A dependency is down') },
  },
  {
    method: 'get',
    path: '/metrics',
    tag: 'Status',
    summary: 'Prometheus metrics',
    description: 'Public unless METRICS_TOKEN is set, in which case send it as a bearer token.',
    public: true,
    responses: {
      200: { description: 'Prometheus text format', schema: z.string(), contentType: 'text/plain' },
    },
  },
  {
    method: 'get',
    path: '/status',
    tag: 'Status',
    summary: 'Monitoring status: dependencies, workers, networks and totals',
    responses: { 200: ok(r.status) },
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Status',
    summary: 'The principal behind the current token',
    responses: { 200: ok(r.principal) },
  },

  // ---- Contracts ----
  {
    method: 'post',
    path: '/contracts/validate',
    tag: 'Contracts',
    summary: 'Check that a contract exists on-chain before registering it',
    body: validateContractSchema,
    responses: { 200: ok(r.contractValidation) },
  },
  {
    method: 'post',
    path: '/contracts',
    tag: 'Contracts',
    summary: 'Register a contract for monitoring',
    body: createContractSchema,
    responses: {
      201: ok(r.contract, 'Registered'),
      409: ok(r.errorResponse, 'Already registered'),
    },
  },
  {
    method: 'get',
    path: '/contracts',
    tag: 'Contracts',
    summary: 'List monitored contracts',
    query: contractsQuery,
    responses: { 200: ok(r.list(r.contract)) },
  },
  {
    method: 'get',
    path: '/contracts/:id',
    tag: 'Contracts',
    summary: 'Contract details with storage entries, rules and recent alerts',
    responses: { 200: ok(r.contractDetail) },
  },
  {
    method: 'get',
    path: '/contracts/:id/activity',
    tag: 'Contracts',
    summary: 'Event counts per hour (or per day beyond 72 hours)',
    query: activityQuery,
    responses: { 200: ok(r.activity) },
  },
  {
    method: 'patch',
    path: '/contracts/:id',
    tag: 'Contracts',
    summary: 'Rename, pause or resume a contract',
    body: updateContractSchema,
    responses: { 200: ok(r.contract) },
  },
  {
    method: 'delete',
    path: '/contracts/:id',
    tag: 'Contracts',
    summary: 'Stop monitoring and delete all stored data for a contract',
    responses: { 204: noContent },
  },
  {
    method: 'post',
    path: '/contracts/:id/refresh',
    tag: 'Contracts',
    summary: 'Queue an immediate ingestion and storage check',
    responses: { 202: ok(r.queued, 'Queued') },
  },
  {
    method: 'post',
    path: '/contracts/:id/storage-entries',
    tag: 'Contracts',
    summary: 'Monitor the TTL of a storage key',
    body: createStorageEntrySchema,
    responses: { 201: ok(r.storageEntry, 'Created') },
  },
  {
    method: 'delete',
    path: '/contracts/:id/storage-entries/:entryId',
    tag: 'Contracts',
    summary: 'Stop monitoring a storage key',
    responses: { 204: noContent },
  },

  // ---- Events ----
  {
    method: 'get',
    path: '/events',
    tag: 'Events',
    summary: 'Search stored events, newest first',
    query: listEventsQuerySchema,
    responses: { 200: ok(r.page(r.event)) },
  },
  {
    method: 'get',
    path: '/events/export',
    tag: 'Events',
    summary: 'Download matching events as CSV or NDJSON',
    description: 'Takes the same filters as GET /events and streams every match, newest first.',
    query: exportEventsQuerySchema,
    responses: {
      200: {
        description: 'The file, with a Content-Disposition filename',
        schema: z.string(),
        contentType: 'text/csv',
      },
    },
  },
  {
    method: 'get',
    path: '/events/topics',
    tag: 'Events',
    summary: 'Most common first topics',
    query: byContractQuery,
    responses: { 200: ok(r.topics) },
  },
  {
    method: 'get',
    path: '/events/:id',
    tag: 'Events',
    summary: 'One event with its decoded value and raw XDR',
    responses: { 200: ok(r.event) },
  },

  // ---- Alert rules ----
  {
    method: 'get',
    path: '/alert-rules',
    tag: 'Alert rules',
    summary: 'List rules (for a contract: its own rules plus global ones)',
    query: byContractQuery,
    responses: { 200: ok(r.list(r.alertRule)) },
  },
  {
    method: 'get',
    path: '/alert-rules/:id',
    tag: 'Alert rules',
    summary: 'One rule',
    responses: { 200: ok(r.alertRule) },
  },
  {
    method: 'post',
    path: '/alert-rules',
    tag: 'Alert rules',
    summary: 'Create a rule',
    body: createAlertRuleSchema,
    responses: { 201: ok(r.alertRule, 'Created') },
  },
  {
    method: 'patch',
    path: '/alert-rules/:id',
    tag: 'Alert rules',
    summary: 'Update a rule (its type cannot change)',
    body: updateAlertRuleSchema,
    responses: { 200: ok(r.alertRule) },
  },
  {
    method: 'delete',
    path: '/alert-rules/:id',
    tag: 'Alert rules',
    summary: 'Delete a rule',
    responses: { 204: noContent },
  },

  // ---- Silences ----
  {
    method: 'get',
    path: '/silences',
    tag: 'Silences',
    summary: 'List contract and rule silences',
    responses: { 200: ok(r.list(r.silence)) },
  },
  {
    method: 'get',
    path: '/silences/:id',
    tag: 'Silences',
    summary: 'One silence',
    responses: { 200: ok(r.silence) },
  },
  {
    method: 'post',
    path: '/silences',
    tag: 'Silences',
    summary: 'Create a silence',
    body: createSilenceSchema,
    responses: { 201: ok(r.silence, 'Created') },
  },
  {
    method: 'patch',
    path: '/silences/:id',
    tag: 'Silences',
    summary: 'Update a silence',
    body: updateSilenceSchema,
    responses: { 200: ok(r.silence) },
  },
  {
    method: 'delete',
    path: '/silences/:id',
    tag: 'Silences',
    summary: 'Delete a silence',
    responses: { 204: noContent },
  },

  // ---- Alerts ----
  {
    method: 'get',
    path: '/alerts',
    tag: 'Alerts',
    summary: 'Alert history, newest first',
    query: listAlertsQuerySchema,
    responses: { 200: ok(r.page(r.alert)) },
  },
  {
    method: 'get',
    path: '/alerts/summary',
    tag: 'Alerts',
    summary: 'Alert counts by status and failed delivery count',
    responses: { 200: ok(r.alertSummary) },
  },
  {
    method: 'get',
    path: '/alerts/:id',
    tag: 'Alerts',
    summary: 'One alert with its deliveries',
    responses: { 200: ok(r.alert) },
  },
  {
    method: 'post',
    path: '/alerts/:id/acknowledge',
    tag: 'Alerts',
    summary: 'Acknowledge a triggered alert',
    body: alertActionBody,
    responses: { 200: ok(r.alert), 409: ok(r.errorResponse, 'Not in the TRIGGERED state') },
  },
  {
    method: 'post',
    path: '/alerts/:id/resolve',
    tag: 'Alerts',
    summary: 'Resolve an alert (level rules can fire again if the condition recurs)',
    body: alertActionBody,
    responses: { 200: ok(r.alert), 409: ok(r.errorResponse, 'Already resolved') },
  },
  {
    method: 'post',
    path: '/deliveries/:id/retry',
    tag: 'Alerts',
    summary: 'Retry a failed notification delivery',
    responses: { 202: ok(r.delivery, 'Queued'), 409: ok(r.errorResponse, 'Not failed') },
  },

  // ---- Destinations ----
  {
    method: 'get',
    path: '/destinations',
    tag: 'Destinations',
    summary: 'List destinations with 7-day delivery stats',
    responses: { 200: ok(r.list(r.destinationWithStats)) },
  },
  {
    method: 'post',
    path: '/destinations',
    tag: 'Destinations',
    summary: 'Create a destination (a webhook secret is returned once)',
    body: createDestinationSchema,
    responses: { 201: ok(r.destination, 'Created') },
  },
  {
    method: 'patch',
    path: '/destinations/:id',
    tag: 'Destinations',
    summary: 'Update a destination',
    body: updateDestinationSchema,
    responses: { 200: ok(r.destination) },
  },
  {
    method: 'post',
    path: '/destinations/:id/rotate-secret',
    tag: 'Destinations',
    summary: 'Generate a new webhook signing secret (returned once)',
    responses: { 200: ok(r.destination) },
  },
  {
    method: 'delete',
    path: '/destinations/:id',
    tag: 'Destinations',
    summary: 'Delete a destination',
    responses: { 204: noContent },
  },
  {
    method: 'post',
    path: '/destinations/:id/test',
    tag: 'Destinations',
    summary: 'Queue a test notification',
    responses: { 202: ok(r.delivery, 'Queued') },
  },
  {
    method: 'get',
    path: '/destinations/:id/deliveries',
    tag: 'Destinations',
    summary: 'The last 50 deliveries',
    responses: { 200: ok(r.list(r.delivery)) },
  },

  // ---- Settings ----
  {
    method: 'get',
    path: '/settings/networks',
    tag: 'Settings',
    summary: 'RPC provider per network',
    responses: { 200: ok(r.list(r.networkSetting)) },
  },
  {
    method: 'put',
    path: '/settings/networks/:network',
    tag: 'Settings',
    summary: 'Set the RPC provider for a network (probed before saving)',
    body: upsertNetworkConfigSchema,
    responses: {
      200: ok(r.networkSaved),
      422: ok(r.errorResponse, 'RPC unreachable or serving another network'),
    },
  },
  {
    method: 'delete',
    path: '/settings/networks/:network',
    tag: 'Settings',
    summary: 'Revert a network to its environment or default RPC',
    responses: { 204: noContent },
  },
  {
    method: 'post',
    path: '/settings/networks/test',
    tag: 'Settings',
    summary: 'Probe an RPC URL without saving it',
    body: z.object({ rpcUrl: z.string().url() }),
    responses: { 200: ok(r.networkProbe) },
  },
  {
    method: 'get',
    path: '/settings/tokens',
    tag: 'Settings',
    summary: 'List API tokens',
    responses: { 200: ok(r.list(r.apiToken)) },
  },
  {
    method: 'post',
    path: '/settings/tokens',
    tag: 'Settings',
    summary: 'Create an API token (the plaintext is returned once)',
    body: createApiTokenSchema,
    responses: { 201: ok(r.apiTokenCreated, 'Created') },
  },
  {
    method: 'delete',
    path: '/settings/tokens/:id',
    tag: 'Settings',
    summary: 'Revoke an API token',
    responses: { 204: noContent },
  },
  {
    method: 'get',
    path: '/audit-log',
    tag: 'Settings',
    summary: 'State-changing requests, newest first',
    query: listAuditLogQuerySchema,
    responses: { 200: ok(r.page(r.auditEntry)) },
  },
  {
    method: 'get',
    path: '/settings/notifications',
    tag: 'Settings',
    summary: 'Notification preferences',
    responses: { 200: ok(notificationPreferencesSchema) },
  },
  {
    method: 'put',
    path: '/settings/notifications',
    tag: 'Settings',
    summary: 'Update notification preferences',
    body: notificationPreferencesSchema,
    responses: { 200: ok(notificationPreferencesSchema) },
  },
];

type JsonSchema = Record<string, unknown>;

/** JSON Schema (2020-12 compatible) for a Zod schema, inlined, describing accepted input. */
function toSchema(schema: ZodTypeAny, io: 'input' | 'output' = 'output'): JsonSchema {
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    effectStrategy: 'input',
    pipeStrategy: io,
  }) as JsonSchema;
  delete out.$schema;
  return out;
}

const openApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

function parameters(route: RouteDoc) {
  const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: name === 'network' ? toSchema(networkSchema) : { type: 'string' },
  }));
  if (!route.query) return params;
  const shape = route.query.shape as Record<string, ZodTypeAny>;
  const query = Object.entries(shape).map(([name, s]) => {
    const schema = toSchema(s, 'input');
    return {
      name,
      in: 'query',
      required: !s.isOptional(),
      ...(schema.description ? { description: schema.description } : {}),
      schema,
    };
  });
  return [...params, ...query];
}

const ERROR_RESPONSES: Record<number, string> = {
  400: 'Invalid request (VALIDATION_ERROR, INVALID_JSON, …)',
  401: 'Missing, invalid, revoked or expired token',
  403: 'The token’s role is too low for this route',
  404: 'Not found',
};

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: Record<string, unknown>;
  [key: string]: unknown;
}

/** Builds the OpenAPI 3.1 document for the REST API. */
export function buildOpenApiDocument(opts: {
  version: string;
  serverUrl?: string;
}): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const errorSchema = toSchema(r.errorResponse);
  for (const route of ROUTES) {
    const role = route.public ? null : requiredRole(route.method.toUpperCase(), route.path);
    const responses: Record<string, unknown> = {};
    for (const [status, res] of Object.entries(route.responses)) {
      responses[status] = {
        description: res.description,
        ...(res.schema
          ? {
              content: {
                [res.contentType ?? 'application/json']: { schema: toSchema(res.schema) },
              },
            }
          : {}),
      };
    }
    const errors = route.public ? [] : Object.keys(ERROR_RESPONSES).map(Number);
    if (route.body || route.query) errors.push(400);
    for (const status of new Set(errors)) {
      responses[status] ??= {
        description: ERROR_RESPONSES[status],
        content: { 'application/json': { schema: errorSchema } },
      };
    }
    const operation: Record<string, unknown> = {
      tags: [route.tag],
      summary: route.summary,
      operationId: `${route.method}${route.path
        .split('/')
        .map((p) => p.replace(/^:/, 'by-'))
        .map((p) => p.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase()))
        .join('')}`,
      description: [route.description, role && `Requires the **${role}** role.`]
        .filter(Boolean)
        .join('\n\n'),
      ...(role ? { 'x-required-role': role } : { security: [] }),
      parameters: parameters(route),
      ...(route.body
        ? {
            requestBody: {
              required: !route.body.isOptional(),
              content: { 'application/json': { schema: toSchema(route.body, 'input') } },
            },
          }
        : {}),
      responses,
    };
    (paths[openApiPath(route.path)] ??= {})[route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Stellar Contract Health Monitor API',
      version: opts.version,
      description:
        'Monitor Soroban contracts: events, storage TTLs, alert rules and notifications. ' +
        'Send `Authorization: Bearer <token>` (or `X-API-Key`). Each operation lists the minimum ' +
        'token role it needs (VIEWER < EDITOR < ADMIN).',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    security: [{ bearerAuth: [] }, { apiKey: [] }],
    tags: [...new Set(ROUTES.map((route) => route.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  };
}
