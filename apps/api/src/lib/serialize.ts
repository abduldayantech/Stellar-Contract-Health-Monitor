import type {
  Alert,
  AlertRule,
  Contract,
  Event,
  NotificationDelivery,
  NotificationDestination,
  StorageEntry,
} from '@stellar-health/db';
import { AVG_LEDGER_SECONDS } from '@stellar-health/shared-types';

export function serializeContract(
  c: Contract,
  extra: {
    latestLedger?: number | null;
    openAlerts?: number;
    nearestExpiryLedgers?: number | null;
  } = {},
) {
  const lag =
    extra.latestLedger && c.lastIngestedLedger
      ? Math.max(0, extra.latestLedger - c.lastIngestedLedger)
      : null;
  return {
    id: c.id,
    contractId: c.contractId,
    network: c.network,
    label: c.label,
    status: c.status,
    executableType: c.executableType,
    wasmHash: c.wasmHash,
    startLedger: c.startLedger,
    lastIngestedLedger: c.lastIngestedLedger,
    ingestionLagLedgers: lag,
    lastEventAt: c.lastEventAt,
    lastPolledAt: c.lastPolledAt,
    lastError: c.lastError,
    consecutiveFailures: c.consecutiveFailures,
    gapDetectedAt: c.gapDetectedAt,
    eventCount: c.eventCount,
    openAlerts: extra.openAlerts ?? 0,
    nearestExpiryLedgers: extra.nearestExpiryLedgers ?? null,
    health: contractHealth(c, extra),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Coarse health classification used for status badges. */
export function contractHealth(
  c: Pick<Contract, 'status' | 'consecutiveFailures' | 'lastPolledAt'>,
  extra: { openAlerts?: number; nearestExpiryLedgers?: number | null } = {},
): 'healthy' | 'warning' | 'critical' | 'paused' | 'pending' {
  if (c.status === 'PAUSED') return 'paused';
  if (c.status === 'ERROR' || c.consecutiveFailures >= 5) return 'critical';
  if (
    extra.nearestExpiryLedgers !== undefined &&
    extra.nearestExpiryLedgers !== null &&
    extra.nearestExpiryLedgers <= 0
  ) {
    return 'critical';
  }
  if (!c.lastPolledAt) return 'pending';
  if (c.consecutiveFailures > 0 || (extra.openAlerts ?? 0) > 0) return 'warning';
  return 'healthy';
}

export function serializeStorageEntry(s: StorageEntry, latestLedger: number | null) {
  const remaining =
    s.liveUntilLedger !== null && latestLedger ? s.liveUntilLedger - latestLedger : null;
  return {
    id: s.id,
    kind: s.kind,
    label: s.label,
    ledgerKeyXdr: s.ledgerKeyXdr,
    exists: s.exists,
    liveUntilLedger: s.liveUntilLedger,
    ledgersRemaining: remaining,
    estimatedExpiry:
      remaining !== null
        ? new Date(Date.now() + remaining * AVG_LEDGER_SECONDS * 1000).toISOString()
        : null,
    lastCheckedLedger: s.lastCheckedLedger,
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.lastError,
  };
}

export function serializeEvent(e: Event & { contract?: Pick<Contract, 'contractId' | 'label'> }) {
  return {
    id: e.id,
    eventId: e.eventId,
    contractRefId: e.contractRefId,
    contractId: e.contract?.contractId,
    contractLabel: e.contract?.label ?? null,
    network: e.network,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    txHash: e.txHash,
    topics: e.topics,
    topicsXdr: e.topicsXdr,
    value: e.value,
    valueXdr: e.valueXdr,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
  };
}

function maskSecret(secret: unknown): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** Shows enough of a credential-bearing URL to recognise it, e.g. `https://hooks.slack.com/…a1b2`. */
export function maskUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return `${new URL(value).origin}/…${value.slice(-4)}`;
  } catch {
    return `…${value.slice(-4)}`;
  }
}

function safeDestinationConfig(
  type: NotificationDestination['type'],
  config: Record<string, unknown>,
  opts: { revealSecret?: boolean },
) {
  switch (type) {
    case 'WEBHOOK':
      return {
        url: config.url,
        headers: config.headers ? Object.keys(config.headers as object) : [],
        secret: opts.revealSecret ? config.secret : maskSecret(config.secret),
      };
    case 'EMAIL':
      return { to: config.to };
    case 'SLACK':
    case 'DISCORD':
    case 'TEAMS':
      return { webhookUrl: maskUrl(config.webhookUrl) };
  }
}

export function serializeDestination(
  d: NotificationDestination,
  opts: { revealSecret?: boolean } = {},
) {
  const config = (d.config ?? {}) as Record<string, unknown>;
  const safeConfig = safeDestinationConfig(d.type, config, opts);
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    enabled: d.enabled,
    config: safeConfig,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function serializeRule(
  r: AlertRule & {
    destinations?: Pick<NotificationDestination, 'id' | 'name' | 'type'>[];
    contract?: Pick<Contract, 'id' | 'contractId' | 'label' | 'network'> | null;
  },
) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    contractRefId: r.contractRefId,
    contract: r.contract ?? null,
    enabled: r.enabled,
    severity: r.severity,
    config: r.config,
    cooldownSeconds: r.cooldownSeconds,
    destinations: r.destinations?.map((d) => ({ id: d.id, name: d.name, type: d.type })) ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function serializeDelivery(
  d: NotificationDelivery & { destination?: Pick<NotificationDestination, 'id' | 'name' | 'type'> },
) {
  return {
    id: d.id,
    alertId: d.alertId,
    kind: d.kind,
    status: d.status,
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    responseStatus: d.responseStatus,
    lastError: d.lastError,
    lastAttemptAt: d.lastAttemptAt,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
    destination: d.destination
      ? { id: d.destination.id, name: d.destination.name, type: d.destination.type }
      : null,
  };
}

export function serializeAlert(
  a: Alert & {
    rule?: Pick<AlertRule, 'id' | 'name' | 'type'> | null;
    contract?: Pick<Contract, 'id' | 'contractId' | 'label' | 'network'> | null;
    deliveries?: (NotificationDelivery & {
      destination?: Pick<NotificationDestination, 'id' | 'name' | 'type'>;
    })[];
  },
) {
  return {
    id: a.id,
    status: a.status,
    severity: a.severity,
    title: a.title,
    message: a.message,
    context: a.context,
    triggeredAt: a.triggeredAt,
    acknowledgedAt: a.acknowledgedAt,
    acknowledgedBy: a.acknowledgedBy,
    resolvedAt: a.resolvedAt,
    rule: a.rule ?? null,
    contract: a.contract ?? null,
    deliveries: a.deliveries?.map(serializeDelivery) ?? [],
  };
}
