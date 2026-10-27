import type { PrismaClient } from '@prisma/client';
import { NETWORK_DEFAULTS, NETWORKS, type Network } from '@stellar-health/shared-types';

export interface ResolvedNetworkConfig {
  network: Network;
  /** The primary provider (first of `rpcUrls`), or '' when unconfigured. */
  rpcUrl: string;
  /** Backup providers, in order. */
  fallbackRpcUrls: string[];
  /** Primary first, then backups, without duplicates. */
  rpcUrls: string[];
  networkPassphrase: string;
  enabled: boolean;
  source: 'database' | 'environment' | 'default' | 'unconfigured';
}

/** `TESTNET_RPC_URL=https://primary,https://backup` lists providers in order of preference. */
function envRpcUrls(network: Network, env: NodeJS.ProcessEnv): string[] {
  return (env[`${network}_RPC_URL`] ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

function withUrls(primary: string, fallbacks: string[]) {
  const rpcUrls = [...new Set([primary, ...fallbacks].filter(Boolean))];
  return { rpcUrl: rpcUrls[0] ?? '', fallbackRpcUrls: rpcUrls.slice(1), rpcUrls };
}

/** Resolves the RPC provider for a network: database override → env var → built-in default. */
export async function resolveNetworkConfig(
  prisma: PrismaClient,
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedNetworkConfig> {
  const row = await prisma.networkConfig.findUnique({ where: { network } });
  if (row) {
    return {
      network,
      ...withUrls(row.rpcUrl, row.fallbackRpcUrls),
      networkPassphrase: row.networkPassphrase,
      enabled: row.enabled,
      source: 'database',
    };
  }
  const defaults = NETWORK_DEFAULTS[network];
  const fromEnv = envRpcUrls(network, env);
  if (fromEnv.length > 0) {
    return {
      network,
      ...withUrls(fromEnv[0]!, fromEnv.slice(1)),
      networkPassphrase: defaults.networkPassphrase,
      enabled: true,
      source: 'environment',
    };
  }
  if (defaults.rpcUrl) {
    return {
      network,
      ...withUrls(defaults.rpcUrl, []),
      networkPassphrase: defaults.networkPassphrase,
      enabled: true,
      source: 'default',
    };
  }
  return {
    network,
    ...withUrls('', []),
    networkPassphrase: defaults.networkPassphrase,
    enabled: false,
    source: 'unconfigured',
  };
}

export async function resolveAllNetworkConfigs(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedNetworkConfig[]> {
  return Promise.all(NETWORKS.map((n) => resolveNetworkConfig(prisma, n, env)));
}
