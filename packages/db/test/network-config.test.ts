import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveNetworkConfig } from '../src/network-config';

const prismaWith = (row: unknown) =>
  ({ networkConfig: { findUnique: async () => row } }) as unknown as PrismaClient;

describe('resolveNetworkConfig', () => {
  it('reads a comma-separated provider list from the environment', async () => {
    const cfg = await resolveNetworkConfig(prismaWith(null), 'TESTNET', {
      TESTNET_RPC_URL: ' https://a.example , https://b.example,https://a.example,',
    });
    expect(cfg).toMatchObject({
      rpcUrl: 'https://a.example',
      fallbackRpcUrls: ['https://b.example'],
      rpcUrls: ['https://a.example', 'https://b.example'],
      source: 'environment',
    });
  });

  it('puts the database primary first, followed by its backups', async () => {
    const cfg = await resolveNetworkConfig(
      prismaWith({
        rpcUrl: 'https://db.example',
        fallbackRpcUrls: ['https://backup.example'],
        networkPassphrase: 'Test SDF Network ; September 2015',
        enabled: true,
      }),
      'TESTNET',
      { TESTNET_RPC_URL: 'https://env.example' },
    );
    expect(cfg.rpcUrls).toEqual(['https://db.example', 'https://backup.example']);
    expect(cfg.source).toBe('database');
  });

  it('has no providers when mainnet is not configured', async () => {
    const cfg = await resolveNetworkConfig(prismaWith(null), 'MAINNET', {});
    expect(cfg).toMatchObject({ rpcUrl: '', rpcUrls: [], enabled: false, source: 'unconfigured' });
  });
});
