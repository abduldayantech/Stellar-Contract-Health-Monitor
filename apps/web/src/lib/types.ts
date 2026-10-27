import type { ExtendTarget } from '@stellar-health/shared-types/extend-command';

import type { ContractHealth } from '@stellar-health/ui';

export type Network = 'TESTNET' | 'MAINNET' | 'FUTURENET' | 'LOCAL';
export const NETWORK_OPTIONS: Network[] = ['TESTNET', 'MAINNET', 'FUTURENET', 'LOCAL'];

export interface Contract {
  id: string;
  contractId: string;
  network: Network;
  label: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'ERROR';
  executableType: string | null;
  wasmHash: string | null;
  startLedger: number;
  lastIngestedLedger: number | null;
  ingestionLagLedgers: number | null;
  lastEventAt: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  gapDetectedAt: string | null;
  eventCount: number;
  openAlerts: number;
  nearestExpiryLedgers: number | null;
  health: ContractHealth;
  createdAt: string;
}

export interface StorageEntry {
  id: string;
  kind: 'INSTANCE' | 'CODE' | 'PERSISTENT' | 'TEMPORARY';
  label: string;
  ledgerKeyXdr: string;
  exists: boolean;
  liveUntilLedger: number | null;
  ledgersRemaining: number | null;
  estimatedExpiry: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** How to pass this entry to `stellar contract extend`; null for unknown key types. */
  extend: ExtendTarget | null;
}

export interface AlertRule {
  id: string;
  name: string;
  type: 'EVENT_MATCH' | 'TTL_EXPIRY' | 'INACTIVITY' | 'WASM_CHANGED';
  contractRefId: string | null;
  contract: { id: string; contractId: string; label: string | null; network: Network } | null;
  enabled: boolean;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  config: Record<string, unknown>;
  cooldownSeconds: number;
  destinations: { id: string; name: string; type: string }[];
  createdAt: string;
}

export interface Delivery {
  id: string;
  alertId: string | null;
  kind: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  destination: { id: string; name: string; type: string } | null;
}

export interface AlertItem {
  id: string;
  status: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  context: Record<string, unknown>;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgeNote?: string | null;
  resolvedAt: string | null;
  resolvedBy?: string | null;
  resolveNote?: string | null;
  rule: { id: string; name: string; type: string } | null;
  contract: { id: string; contractId: string; label: string | null; network: Network } | null;
  deliveries: Delivery[];
}

export interface ContractDetail extends Contract {
  latestLedger: number | null;
  storageEntries: StorageEntry[];
  alertRules: AlertRule[];
  recentAlerts: AlertItem[];
}

export interface EventItem {
  id: string;
  eventId: string;
  contractRefId: string;
  contractId?: string;
  contractLabel: string | null;
  network: Network;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topics: string[];
  topicsXdr: string[];
  value: unknown;
  valueXdr: string;
  inSuccessfulContractCall: boolean;
}

export type DestinationType = 'WEBHOOK' | 'EMAIL' | 'SLACK';

export interface Destination {
  id: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  config: {
    url?: string;
    secret?: string | null;
    headers?: string[];
    to?: string[];
    /** Masked chat webhook URL (Slack). */
    webhookUrl?: string | null;
  };
  last7Days?: Record<string, number>;
  consecutiveFailures?: number;
  lastFailureAt?: string | null;
  /** Why the worker disabled this destination, if it did. */
  disabledReason?: string | null;
  disabledAt?: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface Status {
  database: { ok: boolean; latencyMs: number; error?: string };
  redis: { ok: boolean; latencyMs: number; error?: string };
  queues: Record<string, Record<string, number>> | null;
  workers: { name: string; lastBeatAt: string; healthy: boolean }[];
  workerHealthy: boolean;
  networks: {
    network: Network;
    rpcUrl: string | null;
    configured: boolean;
    source: string;
    latestLedger: number | null;
    oldestLedger: number | null;
    lastCheckedAt: string | null;
    lastError: string | null;
  }[];
  totals: {
    contracts: Record<string, number>;
    events24h: number;
    openAlerts: number;
    failedDeliveries24h: number;
  };
}
