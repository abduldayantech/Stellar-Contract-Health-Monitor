import { z } from 'zod';
import {
  ALERT_RULE_TYPES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  CONTRACT_STATUSES,
  DELIVERY_STATUSES,
  DESTINATION_TYPES,
  NETWORKS,
  STORAGE_ENTRY_KINDS,
  TOKEN_ROLES,
} from '@stellar-health/shared-types';

/**
 * Response shapes for the OpenAPI document. They mirror the serializers in lib/serialize.ts and
 * are only used for documentation; responses are not validated against them at runtime.
 */
const dateTime = z.string().datetime().describe('ISO 8601 timestamp');
const nullableDate = dateTime.nullable();
const network = z.enum(NETWORKS);
const json = z.unknown().describe('Arbitrary JSON');

export const errorResponse = z.object({
  error: z.object({
    code: z.string().describe('Machine-readable code, e.g. VALIDATION_ERROR or NOT_FOUND'),
    message: z.string(),
    details: json.optional(),
  }),
});

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page'),
  });
export const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });

const contractRef = z.object({
  id: z.string(),
  contractId: z.string(),
  label: z.string().nullable(),
  network,
});
const ruleRef = z.object({ id: z.string(), name: z.string(), type: z.enum(ALERT_RULE_TYPES) });
const destinationRef = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DESTINATION_TYPES),
});

export const contract = z.object({
  id: z.string(),
  contractId: z.string().describe('C… StrKey'),
  network,
  label: z.string().nullable(),
  status: z.enum(CONTRACT_STATUSES),
  executableType: z.enum(['wasm', 'stellar_asset']).nullable(),
  wasmHash: z.string().nullable(),
  startLedger: z.number().int(),
  lastIngestedLedger: z.number().int().nullable(),
  ingestionLagLedgers: z.number().int().nullable(),
  lastEventAt: nullableDate,
  lastPolledAt: nullableDate,
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  gapDetectedAt: nullableDate,
  eventCount: z.number().int(),
  openAlerts: z.number().int(),
  nearestExpiryLedgers: z.number().int().nullable(),
  health: z.enum(['healthy', 'warning', 'critical', 'paused', 'pending']),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const storageEntry = z.object({
  id: z.string(),
  kind: z.enum(STORAGE_ENTRY_KINDS),
  label: z.string(),
  ledgerKeyXdr: z.string(),
  exists: z.boolean(),
  liveUntilLedger: z.number().int().nullable(),
  ledgersRemaining: z.number().int().nullable(),
  estimatedExpiry: nullableDate,
  lastCheckedLedger: z.number().int().nullable(),
  lastCheckedAt: nullableDate,
  lastError: z.string().nullable(),
});

export const alertRule = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ALERT_RULE_TYPES),
  contractRefId: z.string().nullable(),
  contract: contractRef.nullable(),
  enabled: z.boolean(),
  severity: z.enum(ALERT_SEVERITIES),
  config: json,
  cooldownSeconds: z.number().int(),
  destinations: z.array(destinationRef),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const delivery = z.object({
  id: z.string(),
  alertId: z.string().nullable(),
  kind: z.enum(['alert.triggered', 'alert.resolved', 'test']),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: nullableDate,
  deliveredAt: nullableDate,
  createdAt: dateTime,
  destination: destinationRef.nullable(),
});

export const alert = z.object({
  id: z.string(),
  status: z.enum(ALERT_STATUSES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string(),
  message: z.string(),
  context: json,
  triggeredAt: dateTime,
  acknowledgedAt: nullableDate,
  acknowledgedBy: z.string().nullable(),
  resolvedAt: nullableDate,
  rule: ruleRef.nullable(),
  contract: contractRef.nullable(),
  deliveries: z.array(delivery),
});

export const contractDetail = contract.extend({
  latestLedger: z.number().int().nullable(),
  storageEntries: z.array(storageEntry),
  alertRules: z.array(alertRule),
  recentAlerts: z.array(alert),
});

export const contractValidation = z.object({
  contractId: z.string(),
  network,
  executableType: z.enum(['wasm', 'stellar_asset']),
  wasmHash: z.string().nullable(),
  instanceLiveUntilLedger: z.number().int().nullable(),
  codeLiveUntilLedger: z.number().int().nullable(),
  latestLedger: z.number().int(),
  alreadyRegistered: z.string().nullable().describe('ID of the existing registration, if any'),
});

export const activity = z.object({
  bucket: z.enum(['hour', 'day']),
  since: dateTime,
  points: z.array(z.object({ t: dateTime, count: z.number().int() })),
});

export const event = z.object({
  id: z.string(),
  eventId: z.string().describe('RPC event ID'),
  contractRefId: z.string(),
  contractId: z.string().optional(),
  contractLabel: z.string().nullable(),
  network,
  type: z.enum(['contract', 'system', 'diagnostic']),
  ledger: z.number().int(),
  ledgerClosedAt: dateTime,
  txHash: z.string(),
  topics: z.array(z.string()).describe('Display form of each topic'),
  topicsXdr: z.array(z.string()),
  value: json.describe('Decoded value; 64/128-bit integers as decimal strings'),
  valueXdr: z.string(),
  inSuccessfulContractCall: z.boolean(),
});

export const topics = list(z.object({ topic: z.string(), count: z.number().int() }));

export const destination = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DESTINATION_TYPES),
  enabled: z.boolean(),
  config: z
    .record(json)
    .describe(
      'WEBHOOK: {url, headers (names only), secret (masked; full value only on create/rotate)}. EMAIL: {to}.',
    ),
  createdAt: dateTime,
  updatedAt: dateTime,
});
export const destinationWithStats = destination.extend({
  last7Days: z.record(z.number().int()).describe('Delivery counts by status over the last 7 days'),
});

export const alertSummary = z.object({
  byStatus: z.record(z.number().int()),
  failedDeliveries: z.number().int(),
});

const check = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
});
export const status = z.object({
  database: check,
  redis: check,
  queues: z.record(z.record(z.number().int())).nullable(),
  workers: z.array(
    z.object({ name: z.string(), lastBeatAt: dateTime, healthy: z.boolean(), info: json }),
  ),
  workerHealthy: z.boolean(),
  networks: z.array(
    z.object({
      network,
      rpcUrl: z.string().nullable(),
      configured: z.boolean(),
      source: z.enum(['database', 'environment', 'default', 'unconfigured']),
      latestLedger: z.number().int().nullable(),
      oldestLedger: z.number().int().nullable(),
      lastCheckedAt: nullableDate,
      lastError: z.string().nullable(),
    }),
  ),
  totals: z.object({
    contracts: z.record(z.number().int()).describe('Contract counts by status'),
    events24h: z.number().int(),
    openAlerts: z.number().int(),
    failedDeliveries24h: z.number().int(),
  }),
});

export const health = z.object({ status: z.literal('ok') });
export const ready = z.object({
  status: z.enum(['ready', 'degraded']),
  database: z.boolean(),
  redis: z.boolean(),
});

export const principal = z.object({
  principal: z.object({
    type: z.enum(['admin', 'token']),
    id: z.string(),
    name: z.string(),
    role: z.enum(TOKEN_ROLES),
  }),
});

const networkState = z
  .object({
    network,
    latestLedger: z.number().int().nullable(),
    oldestLedger: z.number().int().nullable(),
    lastCheckedAt: nullableDate,
    lastError: z.string().nullable(),
    updatedAt: dateTime,
  })
  .nullable();
export const networkSetting = z.object({
  network,
  rpcUrl: z.string(),
  networkPassphrase: z.string(),
  enabled: z.boolean(),
  source: z.enum(['database', 'environment', 'default', 'unconfigured']),
  defaultRpcUrl: z.string().nullable(),
  state: networkState,
});
const probe = z.object({
  status: z.string(),
  latestLedger: z.number().int(),
  oldestLedger: z.number().int(),
  ledgerRetentionWindow: z.number().int(),
  passphrase: z.string(),
  latencyMs: z.number(),
});
export const networkSaved = z.object({
  network,
  rpcUrl: z.string(),
  networkPassphrase: z.string(),
  enabled: z.boolean(),
  updatedAt: dateTime,
  probe,
});
export const networkProbe = z.union([
  probe.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const apiToken = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(TOKEN_ROLES),
  prefix: z.string(),
  createdAt: dateTime,
  lastUsedAt: nullableDate,
  revokedAt: nullableDate,
});
export const apiTokenCreated = apiToken
  .pick({ id: true, name: true, role: true, prefix: true, createdAt: true })
  .extend({ token: z.string().describe('Plaintext token; shown only once') });

export const auditEntry = z.object({
  id: z.string(),
  createdAt: dateTime,
  actorType: z.enum(['admin', 'token']),
  actorId: z.string(),
  actorName: z.string(),
  method: z.string(),
  route: z.string(),
  path: z.string(),
  statusCode: z.number().int(),
  ip: z.string().nullable(),
});

export const queued = z.object({ queued: z.literal(true) });
