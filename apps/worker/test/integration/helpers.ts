import { StrKey } from '@stellar/stellar-sdk';
import pino from 'pino';
import { createSecretBox, getPrisma } from '@stellar-health/db';
import type {
  ContractInfo,
  EventsPage,
  GetEventsParams,
  LedgerEntryTtl,
  NormalizedEvent,
  RpcHealth,
  StellarClient,
} from '@stellar-health/stellar-client';
import { loadConfig } from '../../src/config';
import type { DeliveryDeps, Mailer } from '../../src/delivery';
import { createWorkerMetrics } from '../../src/metrics';

export const TEST_SECRETS_KEY = 'cd'.repeat(32);

export function contractId(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

/** Simulated RPC holding an in-memory event log with a retention window. */
export class FakeRpc implements StellarClient {
  health: RpcHealth = {
    status: 'healthy',
    latestLedger: 1000,
    oldestLedger: 500,
    ledgerRetentionWindow: 500,
  };
  events: NormalizedEvent[] = [];
  ttls = new Map<string, LedgerEntryTtl>();
  /** What getContractInfo returns per contract ID (null when unset). */
  contractInfos = new Map<string, ContractInfo>();
  calls: GetEventsParams[] = [];

  emit(contract: string, ledger: number, topics: string[], at = new Date()): NormalizedEvent {
    const e: NormalizedEvent = {
      id: `${String(ledger).padStart(19, '0')}-${String(this.events.length).padStart(10, '0')}`,
      type: 'contract',
      ledger,
      ledgerClosedAt: at,
      txHash: 'a'.repeat(64),
      contractId: contract,
      topics,
      topicsXdr: [],
      value: { n: this.events.length },
      valueXdr: '',
      inSuccessfulContractCall: true,
    };
    this.events.push(e);
    this.health.latestLedger = Math.max(this.health.latestLedger, ledger);
    return e;
  }

  async getHealth() {
    return { ...this.health };
  }
  async getNetworkPassphrase() {
    return 'Test SDF Network ; September 2015';
  }
  async getEvents(params: GetEventsParams): Promise<EventsPage> {
    this.calls.push(params);
    const limit = params.limit ?? 100;
    let after: string | null = null;
    if (params.cursor) {
      const ledger = Number(params.cursor.split('-')[0]);
      if (ledger < this.health.oldestLedger) {
        throw Object.assign(new Error('cursor is before the oldest ledger'), { code: -32600 });
      }
      after = params.cursor;
    } else if (params.startLedger! < this.health.oldestLedger) {
      throw new Error(
        `startLedger must be within the ledger range: ${this.health.oldestLedger} - ${this.health.latestLedger}`,
      );
    }
    const matching = this.events
      .filter((e) => params.contractIds.includes(e.contractId ?? ''))
      .filter((e) => (after ? e.id > after : e.ledger >= params.startLedger!))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);
    const cursor = matching.length
      ? matching[matching.length - 1]!.id
      : `${String(this.health.latestLedger).padStart(19, '0')}-9999999999`;
    return {
      events: matching,
      cursor,
      latestLedger: this.health.latestLedger,
      oldestLedger: this.health.oldestLedger,
    };
  }
  async getContractInfo(contractId: string) {
    return this.contractInfos.get(contractId) ?? null;
  }
  async getLedgerEntryTtls(keys: string[]) {
    return {
      latestLedger: this.health.latestLedger,
      entries: keys.map(
        (k) =>
          this.ttls.get(k) ?? {
            ledgerKeyXdr: k,
            exists: false,
            liveUntilLedger: null,
            lastModifiedLedger: null,
          },
      ),
    };
  }
}

export interface Harness {
  deps: DeliveryDeps;
  rpc: FakeRpc;
  queued: string[];
  sent: Parameters<Mailer['send']>[0][];
  setNow(d: Date): void;
}

export function createHarness(overrides: Record<string, string> = {}): Harness {
  const rpc = new FakeRpc();
  const queued: string[] = [];
  const sent: Parameters<Mailer['send']>[0][] = [];
  let now: Date | null = null;
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    LOG_LEVEL: 'silent',
    INGEST_PAGE_LIMIT: '5',
    WEBHOOK_TIMEOUT_MS: '2000',
    ...overrides,
  });
  const deps: DeliveryDeps = {
    config,
    prisma: getPrisma(),
    logger: pino({ level: 'silent' }),
    metrics: createWorkerMetrics(),
    getClient: async () => rpc,
    enqueueDelivery: async (id) => {
      queued.push(id);
    },
    now: () => now ?? new Date(),
    secrets: createSecretBox(TEST_SECRETS_KEY),
    mailer: { send: async (m) => void sent.push(m) },
  };
  return { deps, rpc, queued, sent, setNow: (d) => (now = d) };
}

export async function createContract(
  seed: number,
  extra: { startLedger?: number; createdAt?: Date } = {},
) {
  return getPrisma().contract.create({
    data: {
      contractId: contractId(seed),
      network: 'TESTNET',
      label: `Contract ${seed}`,
      startLedger: extra.startLedger ?? 600,
      createdAt: extra.createdAt,
    },
  });
}
