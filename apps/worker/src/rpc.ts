import type { Logger } from 'pino';
import type { PrismaClient } from '@stellar-health/db';
import { resolveNetworkConfig } from '@stellar-health/db';
import type { Network } from '@stellar-health/shared-types';
import {
  FailoverClient,
  StellarRpcClient,
  type StellarClient,
} from '@stellar-health/stellar-client';
import type { WorkerMetrics } from './metrics';

export class NetworkNotConfiguredError extends Error {
  constructor(network: Network) {
    super(`No RPC provider configured for ${network}`);
  }
}

const CONFIG_TTL_MS = 30_000;

/** Metric label for a provider: the host only, since some providers put API keys in the URL. */
export function providerLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Returns RPC clients per network. Network config is re-read every 30s so RPC provider
 * changes made in Settings take effect without restarting the worker. With backup providers
 * configured, calls go through a FailoverClient.
 */
export function createClientFactory(
  prisma: PrismaClient,
  metrics: WorkerMetrics,
  logger?: Pick<Logger, 'warn'>,
) {
  const rpcClients = new Map<string, StellarRpcClient>();
  const networkClients = new Map<string, StellarClient>();
  const resolved = new Map<Network, { rpcUrls: string[]; enabled: boolean; at: number }>();

  const rpcClient = (url: string, failover: boolean) => {
    const key = `${failover}:${url}`;
    let client = rpcClients.get(key);
    if (!client) {
      const provider = providerLabel(url);
      client = new StellarRpcClient({
        rpcUrl: url,
        // With a backup available, give up on a failing provider sooner and let failover retry.
        retries: failover ? 1 : 3,
        timeoutMs: failover ? 10_000 : 20_000,
        onRetry: (err) => metrics.rpcRetries.labels(err.kind).inc(),
        onCall: (method, ms, ok) => {
          metrics.rpcCalls.labels(method, ok ? 'ok' : 'error', provider).inc();
          metrics.rpcDuration.labels(method, provider).observe(ms / 1000);
        },
      });
      rpcClients.set(key, client);
    }
    return client;
  };

  return async function getClient(network: Network): Promise<StellarClient> {
    let cfg = resolved.get(network);
    if (!cfg || Date.now() - cfg.at > CONFIG_TTL_MS) {
      const r = await resolveNetworkConfig(prisma, network);
      cfg = { rpcUrls: r.rpcUrls, enabled: r.enabled, at: Date.now() };
      resolved.set(network, cfg);
    }
    if (cfg.rpcUrls.length === 0 || !cfg.enabled) throw new NetworkNotConfiguredError(network);
    const key = `${network}:${cfg.rpcUrls.join(',')}`;
    let client = networkClients.get(key);
    if (!client) {
      client =
        cfg.rpcUrls.length === 1
          ? rpcClient(cfg.rpcUrls[0]!, false)
          : new FailoverClient({
              providers: cfg.rpcUrls.map((url) => ({ url, client: rpcClient(url, true) })),
              onSwitch: (from, to, reason) => {
                metrics.rpcFailovers.labels(network, providerLabel(to)).inc();
                logger?.warn(
                  { network, from: providerLabel(from), to: providerLabel(to), reason },
                  'switched RPC provider',
                );
              },
            });
      networkClients.set(key, client);
    }
    return client;
  };
}
