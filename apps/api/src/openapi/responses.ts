/**
 * Response shapes, used only to document the API in the OpenAPI spec.
 * Keep them in step with lib/serialize.ts and the objects the routes return.
 */
import { z } from 'zod';
import {
  ALERT_RULE_TYPES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  CONTRACT_STATUSES,
  DELIVERY_STATUSES,
  DESTINATION_TYPES,
  STORAGE_ENTRY_KINDS,
  TOKEN_ROLES,
  networkSchema,
  notificationPreferencesSchema,
} from '@stellar-health/shared-types';

const dateTime = z.string().datetime();
const json = z.unknown().describe('Arbitrary JSON');

export const errorSchema = z.object({
  error: z.object({
    code: z.string().describe('Machine-readable error code, e.g. VALIDATION_ERROR or NOT_FOUND'),
    message: z.string(),
    details: json.optional(),
  }),
});

const contractRefSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  label: z.string().nullable(),
  network: networkSchema,
});

const ruleRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ALERT_RULE_TYPES),
});

const destinationRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DESTINATION_TYPES),
});

export const contractSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  network: networkSchema,
  label: z.string().nullable(),
  status: z.enum(CONTRACT_STATUSES),
  executableType: z.string().nullable(),
  wasmHash: z.string().nullable(),
  startLedger: z.number().int(),
  lastIngestedLedger: z.number().int().nullable(),
  ingestionLagLedgers: z.number().int().nullable(),
  lastEventAt: dateTime.nullable(),
  lastPolledAt: dateTime.nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  gapDetectedAt: dateTime.nullable(),
  eventCount: z.number().int(),
  openAlerts: z.number().int(),
  nearestExpiryLedgers: z.number().int().nullable(),
  health: z.enum(['healthy', 'warning', 'critical', 'paused', 'pending']),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const storageEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(STORAGE_ENTRY_KINDS),
  label: z.string(),
  ledgerKeyXdr: z.string(),
  exists: z.boolean(),
  liveUntilLedger: z.number().int().nullable(),
  ledgersRemaining: z.number().int().nullable(),
  estimatedExpiry: dateTime.nullable(),
  lastCheckedLedger: z.number().int().nullable(),
  lastCheckedAt: dateTime.nullable(),
  lastError: z.string().nullable(),
});

export const eventSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  contractRefId: z.string(),
  contractId: z.string().optional(),
  contractLabel: z.string().nullable(),
  network: networkSchema,
  type: z.string(),
  ledger: z.number().int(),
  ledgerClosedAt: dateTime,
  txHash: z.string(),
  topics: z.array(z.string()),
  topicsXdr: z.array(z.string()),
  value: json,
  valueXdr: z.string(),
  inSuccessfulContractCall: z.boolean(),
});

export const destinationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DESTINATION_TYPES),
  enabled: z.boolean(),
  config: z.union([
    z.object({
      url: z.string(),
      headers: z.array(z.string()).describe('Header names; values are never returned'),
      secret: z
        .string()
        .nullable()
        .describe('Masked, except in the response that creates or rotates it'),
    }),
    z.object({ to: z.array(z.string()) }),
  ]),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ALERT_RULE_TYPES),
  contractRefId: z.string().nullable(),
  contract: contractRefSchema.nullable(),
  enabled: z.boolean(),
  severity: z.enum(ALERT_SEVERITIES),
  config: json.describe('Rule configuration; its shape depends on `type`'),
  cooldownSeconds: z.number().int(),
  destinations: z.array(destinationRefSchema),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const deliverySchema = z.object({
  id: z.string(),
  alertId: z.string().nullable(),
  kind: z.string().describe('alert.triggered, alert.resolved or test'),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: dateTime.nullable(),
  deliveredAt: dateTime.nullable(),
  createdAt: dateTime,
  destination: destinationRefSchema.nullable(),
});

export const alertSchema = z.object({
  id: z.string(),
  status: z.enum(ALERT_STATUSES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string(),
  message: z.string(),
  context: json,
  triggeredAt: dateTime,
  acknowledgedAt: dateTime.nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: dateTime.nullable(),
  rule: ruleRefSchema.nullable(),
  contract: contractRefSchema.nullable(),
  deliveries: z.array(deliverySchema),
});

export const items = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page'),
  });

// ---- Contracts ----

export const contractValidationSchema = z.object({
  valid: z.literal(true),
  contractId: z.string(),
  network: networkSchema,
  executableType: z.enum(['wasm', 'stellar_asset']),
  wasmHash: z.string().nullable(),
  instanceLiveUntilLedger: z.number().int().nullable(),
  codeLiveUntilLedger: z.number().int().nullable(),
  latestLedger: z.number().int(),
  alreadyRegistered: z.string().nullable().describe('ID of the existing registration, if any'),
});

export const contractDetailSchema = contractSchema.extend({
  latestLedger: z.number().int().nullable(),
  storageEntries: z.array(storageEntrySchema),
  alertRules: z.array(ruleSchema),
  recentAlerts: z.array(alertSchema),
});

export const contractActivitySchema = z.object({
  bucket: z.enum(['hour', 'day']),
  since: dateTime,
  points: z.array(z.object({ t: dateTime, count: z.number().int() })),
});

export const queuedSchema = z.object({ queued: z.literal(true) });

// ---- Events ----

export const topicCountsSchema = items(z.object({ topic: z.string(), count: z.number().int() }));

// ---- Alerts ----

export const alertSummarySchema = z.object({
  byStatus: z.record(z.number().int()).describe('Alert counts keyed by status'),
  failedDeliveries: z.number().int(),
});

// ---- Destinations ----

export const destinationListSchema = items(
  destinationSchema.extend({
    last7Days: z.record(z.number().int()).describe('Delivery counts keyed by status'),
  }),
);

// ---- Settings ----

const principalSchema = z.object({
  type: z.enum(['admin', 'token']),
  id: z.string(),
  name: z.string(),
  role: z.enum(TOKEN_ROLES),
});

export const authMeSchema = z.object({ principal: principalSchema.optional() });

const networkStateSchema = z.object({
  network: networkSchema,
  latestLedger: z.number().int().nullable(),
  oldestLedger: z.number().int().nullable(),
  lastCheckedAt: dateTime.nullable(),
  lastError: z.string().nullable(),
  updatedAt: dateTime,
});

const networkSourceSchema = z.enum(['database', 'environment', 'default', 'unconfigured']);

export const networkConfigListSchema = items(
  z.object({
    network: networkSchema,
    rpcUrl: z.string(),
    networkPassphrase: z.string(),
    enabled: z.boolean(),
    source: networkSourceSchema,
    defaultRpcUrl: z.string().nullable(),
    state: networkStateSchema.nullable(),
  }),
);

const rpcProbeSchema = z.object({
  status: z.string(),
  latestLedger: z.number().int(),
  oldestLedger: z.number().int(),
  ledgerRetentionWindow: z.number().int(),
  passphrase: z.string(),
  latencyMs: z.number(),
});

export const networkConfigSchema = z.object({
  network: networkSchema,
  rpcUrl: z.string(),
  networkPassphrase: z.string(),
  enabled: z.boolean(),
  updatedAt: dateTime,
  probe: rpcProbeSchema,
});

export const rpcTestResultSchema = z.union([
  rpcProbeSchema.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const tokenFields = {
  id: z.string(),
  name: z.string(),
  role: z.enum(TOKEN_ROLES),
  prefix: z.string().describe('First characters of the token, to tell tokens apart'),
  createdAt: dateTime,
};

export const tokenListSchema = items(
  z.object({ ...tokenFields, lastUsedAt: dateTime.nullable(), revokedAt: dateTime.nullable() }),
);

export const createdTokenSchema = z.object({
  ...tokenFields,
  token: z.string().describe('The plaintext token. It is only returned once.'),
});

export const auditLogPageSchema = page(
  z.object({
    id: z.string(),
    createdAt: dateTime,
    actorType: z.enum(['admin', 'token']),
    actorId: z.string(),
    actorName: z.string(),
    method: z.string(),
    route: z.string().describe('Route pattern, e.g. /contracts/:id'),
    path: z.string(),
    statusCode: z.number().int(),
    ip: z.string().nullable(),
  }),
);

export { notificationPreferencesSchema };

// ---- Status ----

export const healthSchema = z.object({ status: z.literal('ok') });

export const readySchema = z.object({
  status: z.enum(['ready', 'degraded']),
  database: z.boolean(),
  redis: z.boolean(),
});

const dependencyCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
});

export const statusSchema = z.object({
  database: dependencyCheckSchema,
  redis: dependencyCheckSchema,
  queues: z
    .record(z.record(z.number().int()))
    .nullable()
    .describe('Job counts per queue and state; null when Redis is unreachable'),
  workers: z.array(
    z.object({ name: z.string(), lastBeatAt: dateTime, healthy: z.boolean(), info: json }),
  ),
  workerHealthy: z.boolean(),
  networks: z.array(
    z.object({
      network: networkSchema,
      rpcUrl: z.string().nullable(),
      configured: z.boolean(),
      source: networkSourceSchema,
      latestLedger: z.number().int().nullable(),
      oldestLedger: z.number().int().nullable(),
      lastCheckedAt: dateTime.nullable(),
      lastError: z.string().nullable(),
    }),
  ),
  totals: z.object({
    contracts: z.record(z.number().int()).describe('Contract counts keyed by status'),
    events24h: z.number().int(),
    openAlerts: z.number().int(),
    failedDeliveries24h: z.number().int(),
  }),
});
