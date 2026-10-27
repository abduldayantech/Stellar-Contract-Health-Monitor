import type { PrismaClient } from '@stellar-health/db';
import { resolveNetworkConfig } from '@stellar-health/db';
import type { Network } from '@stellar-health/shared-types';
import {
  FailoverClient,
  StellarRpcClient,
  type StellarClient,
} from '@stellar-health/stellar-client';
import { HttpError } from './errors';

export type StellarClientFactory = (network: Network) => Promise<StellarClient>;

/**
 * Builds RPC clients from the current network configuration, caching one per provider list.
 * With backup providers configured, calls fail over to them like the worker's do.
 */
export function createStellarClientFactory(prisma: PrismaClient): StellarClientFactory {
  const cache = new Map<string, StellarClient>();
  return async (network) => {
    const cfg = await resolveNetworkConfig(prisma, network);
    if (cfg.rpcUrls.length === 0 || !cfg.enabled) {
      throw new HttpError(
        422,
        'NETWORK_NOT_CONFIGURED',
        `No RPC provider is configured for ${network}. Add one in Settings.`,
      );
    }
    const key = cfg.rpcUrls.join(',');
    let client = cache.get(key);
    if (!client) {
      const single = cfg.rpcUrls.length === 1;
      const make = (rpcUrl: string) =>
        new StellarRpcClient({ rpcUrl, retries: single ? 2 : 1, timeoutMs: 10_000 });
      client = single
        ? make(cfg.rpcUrls[0]!)
        : new FailoverClient({
            providers: cfg.rpcUrls.map((url) => ({ url, client: make(url) })),
          });
      cache.set(key, client);
    }
    return client;
  };
}
