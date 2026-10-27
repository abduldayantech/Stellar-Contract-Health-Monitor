import { describe, expect, it } from 'vitest';
import { FailoverClient, RpcError, type RpcHealth, type StellarClient } from '../src';

class FakeProvider implements StellarClient {
  latestLedger = 1000;
  failWith: Error | null = null;
  calls: string[] = [];

  private async answer<T>(method: string, value: T): Promise<T> {
    this.calls.push(method);
    if (this.failWith) throw this.failWith;
    return value;
  }
  getHealth(): Promise<RpcHealth> {
    return this.answer('getHealth', {
      status: 'healthy',
      latestLedger: this.latestLedger,
      oldestLedger: 1,
      ledgerRetentionWindow: 1000,
    });
  }
  getNetworkPassphrase() {
    return this.answer('getNetworkPassphrase', 'Test SDF Network ; September 2015');
  }
  getEvents() {
    return this.answer('getEvents', {
      events: [],
      cursor: 'c',
      latestLedger: this.latestLedger,
      oldestLedger: 1,
    });
  }
  getContractInfo() {
    return this.answer('getContractInfo', null);
  }
  getLedgerEntryTtls() {
    return this.answer('getLedgerEntryTtls', { latestLedger: this.latestLedger, entries: [] });
  }
}

const outage = () => new RpcError('RPC server error (HTTP 503)', 'server', true);
const nonEventCalls = (p: FakeProvider) => p.calls.filter((c) => c !== 'getHealth');

function setup(opts: { healthCheckIntervalMs?: number } = {}) {
  let now = 0;
  const a = new FakeProvider();
  const b = new FakeProvider();
  const switches: string[] = [];
  const client = new FailoverClient({
    providers: [
      { url: 'https://a', client: a },
      { url: 'https://b', client: b },
    ],
    cooldownMs: 60_000,
    maxLagLedgers: 10,
    healthCheckIntervalMs: opts.healthCheckIntervalMs ?? 30_000,
    now: () => now,
    onSwitch: (from, to) => switches.push(`${from} -> ${to}`),
  });
  return { a, b, client, switches, advance: (ms: number) => (now += ms) };
}

describe('FailoverClient', () => {
  it('uses the first provider while it is healthy', async () => {
    const { a, b, client } = setup();
    await client.getEvents({ contractIds: ['C'], cursor: 'x' });
    await client.getEvents({ contractIds: ['C'], cursor: 'x' });
    expect(nonEventCalls(a)).toEqual(['getEvents', 'getEvents']);
    expect(nonEventCalls(b)).toEqual([]);
    expect(client.activeRpcUrl()).toBe('https://a');
  });

  it('retries a failed call on the backup and skips the primary during its cooldown', async () => {
    const { a, b, client, switches, advance } = setup();
    await client.getHealth();
    a.failWith = outage();
    await expect(client.getEvents({ contractIds: ['C'], cursor: 'x' })).resolves.toMatchObject({
      cursor: 'c',
    });
    expect(client.activeRpcUrl()).toBe('https://b');
    expect(switches).toEqual(['https://a -> https://b']);

    a.calls = [];
    advance(10_000);
    await client.getEvents({ contractIds: ['C'], cursor: 'x' });
    expect(a.calls).toEqual([]);

    // After the cooldown and once healthy, calls return to the preferred provider.
    a.failWith = null;
    advance(60_000);
    await client.getEvents({ contractIds: ['C'], cursor: 'x' });
    expect(client.activeRpcUrl()).toBe('https://a');
    expect(switches).toEqual(['https://a -> https://b', 'https://b -> https://a']);
    expect(nonEventCalls(b)).toHaveLength(2);
  });

  it('avoids a provider that is reachable but behind the others', async () => {
    const { a, b, client } = setup();
    a.latestLedger = 900;
    b.latestLedger = 1000;
    await client.getEvents({ contractIds: ['C'], cursor: 'x' });
    expect(nonEventCalls(a)).toEqual([]);
    expect(client.activeRpcUrl()).toBe('https://b');
  });

  it('does not fail over on caller errors such as an out-of-retention cursor', async () => {
    const { a, b, client } = setup();
    await client.getHealth();
    a.failWith = new RpcError('cursor is before the oldest ledger', 'invalid_request', false);
    await expect(client.getEvents({ contractIds: ['C'], cursor: 'x' })).rejects.toThrow(
      /oldest ledger/,
    );
    expect(nonEventCalls(b)).toEqual([]);
  });

  it('throws the last error when every provider is down, and still tries them later', async () => {
    const { a, b, client, advance } = setup();
    a.failWith = outage();
    b.failWith = outage();
    await expect(client.getHealth()).rejects.toThrow(/503/);
    // Both are cooling down, but a call still goes out rather than failing without trying.
    b.failWith = null;
    advance(1_000);
    await expect(client.getHealth()).resolves.toMatchObject({ latestLedger: 1000 });
    expect(client.activeRpcUrl()).toBe('https://b');
  });

  it('shares one health comparison between concurrent calls', async () => {
    const { a, b, client } = setup();
    await Promise.all([client.getHealth(), client.getHealth(), client.getHealth()]);
    // One comparison round (1 each) plus the three calls served by the primary.
    expect(a.calls.filter((c) => c === 'getHealth')).toHaveLength(4);
    expect(b.calls).toEqual(['getHealth']);
  });
});
