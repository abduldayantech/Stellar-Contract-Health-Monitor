import type {
  ContractInfo,
  EventsPage,
  GetEventsParams,
  LedgerEntryTtl,
  RpcHealth,
  StellarClient,
} from './client';
import { RpcError } from './errors';

export interface RpcProvider {
  url: string;
  client: StellarClient;
}

export interface FailoverClientOptions {
  /** In order of preference: the first healthy provider serves every call. */
  providers: RpcProvider[];
  /** How long a provider that failed is skipped before it is tried again. */
  cooldownMs?: number;
  /** A provider this many ledgers behind the most advanced one is treated as unhealthy. */
  maxLagLedgers?: number;
  /** How often every provider's getHealth is compared. */
  healthCheckIntervalMs?: number;
  now?: () => number;
  /** Called when calls move to a different provider. */
  onSwitch?: (from: string, to: string, reason: string) => void;
}

interface ProviderState extends RpcProvider {
  downUntil: number;
  lagging: boolean;
}

/** Errors another provider might not have: outages, overload and rate limits. */
function shouldFailOver(err: unknown): boolean {
  return err instanceof RpcError && err.retryable;
}

/**
 * Spreads calls over several RPC providers for one network. The first healthy provider in
 * preference order serves each call; when it fails with a transient error the call is retried
 * on the next one, and the failed provider is skipped for `cooldownMs`. Providers are also
 * compared periodically, so one that is reachable but stuck behind the others is avoided too.
 *
 * Event cursors are event IDs, which are the same on every provider, so ingestion carries on
 * from its saved position after a switch.
 */
export class FailoverClient implements StellarClient {
  private readonly providers: ProviderState[];
  private readonly cooldownMs: number;
  private readonly maxLagLedgers: number;
  private readonly healthCheckIntervalMs: number;
  private readonly now: () => number;
  private lastHealthCheck = Number.NEGATIVE_INFINITY;
  private healthCheck: Promise<void> | null = null;
  private active: string;

  constructor(private readonly opts: FailoverClientOptions) {
    if (opts.providers.length === 0) throw new Error('FailoverClient needs at least one provider');
    this.providers = opts.providers.map((p) => ({ ...p, downUntil: 0, lagging: false }));
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.maxLagLedgers = opts.maxLagLedgers ?? 10;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.active = this.providers[0]!.url;
  }

  /** The provider that served the most recent successful call. */
  activeRpcUrl(): string {
    return this.active;
  }

  getHealth(): Promise<RpcHealth> {
    return this.run((c) => c.getHealth());
  }
  getNetworkPassphrase(): Promise<string> {
    return this.run((c) => c.getNetworkPassphrase());
  }
  getEvents(params: GetEventsParams): Promise<EventsPage> {
    return this.run((c) => c.getEvents(params));
  }
  getContractInfo(contractId: string): Promise<ContractInfo | null> {
    return this.run((c) => c.getContractInfo(contractId));
  }
  getLedgerEntryTtls(
    ledgerKeysXdr: string[],
  ): Promise<{ latestLedger: number; entries: LedgerEntryTtl[] }> {
    return this.run((c) => c.getLedgerEntryTtls(ledgerKeysXdr));
  }

  /** Healthy providers first (in preference order), then the rest as a last resort. */
  private order(): ProviderState[] {
    const now = this.now();
    const healthy = this.providers.filter((p) => p.downUntil <= now && !p.lagging);
    return [...healthy, ...this.providers.filter((p) => !healthy.includes(p))];
  }

  private async run<T>(fn: (client: StellarClient) => Promise<T>): Promise<T> {
    if (this.providers.length > 1) await this.compareHealth();
    let lastError: unknown;
    for (const p of this.order()) {
      try {
        const result = await fn(p.client);
        this.markActive(
          p.url,
          lastError
            ? `previous provider failed: ${(lastError as Error).message}`
            : 'preferred provider is healthy again',
        );
        return result;
      } catch (err) {
        if (!shouldFailOver(err)) throw err;
        p.downUntil = this.now() + this.cooldownMs;
        lastError = err;
      }
    }
    throw lastError;
  }

  private markActive(url: string, reason: string) {
    if (url === this.active) return;
    const from = this.active;
    this.active = url;
    this.opts.onSwitch?.(from, url, reason);
  }

  /** At most once per interval (shared by concurrent calls): find failed or lagging providers. */
  private compareHealth(): Promise<void> {
    if (this.healthCheck) return this.healthCheck;
    if (this.now() - this.lastHealthCheck < this.healthCheckIntervalMs) return Promise.resolve();
    this.lastHealthCheck = this.now();
    this.healthCheck = (async () => {
      const results = await Promise.allSettled(this.providers.map((p) => p.client.getHealth()));
      const latest = results.map((r) => (r.status === 'fulfilled' ? r.value.latestLedger : null));
      const best = Math.max(...latest.map((l) => l ?? Number.NEGATIVE_INFINITY));
      results.forEach((r, i) => {
        const p = this.providers[i]!;
        if (r.status === 'rejected') {
          p.downUntil = this.now() + this.cooldownMs;
        } else {
          p.downUntil = 0;
          p.lagging = best - r.value.latestLedger > this.maxLagLedgers;
        }
      });
    })().finally(() => {
      this.healthCheck = null;
    });
    return this.healthCheck;
  }
}
