import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nativeToScVal, StrKey } from '@stellar/stellar-sdk';

/**
 * A Stellar JSON-RPC stand-in for load tests. It serves `getHealth`, `getEvents`,
 * `getLatestLedger`, `getNetwork` and an empty `getLedgerEntries` for any number of synthetic
 * contracts, with a ledger that closes every `ledgerMs` like a real network.
 *
 * Contract `i` (see {@link benchContractId}) emits one event in every ledger where
 * `(ledger + i) % eventPeriod === 0`, so the fleet emits `contracts / eventPeriod` events per
 * ledger. Event IDs, cursors, the 5x5 filter limit and retention errors behave like stellar-rpc.
 */
export interface MockRpcOptions {
  ledgerMs: number;
  eventPeriod: number;
  /** Added to every response, to mimic network round trips. */
  latencyMs: number;
  /** Ledgers kept by the mock (stellar-rpc defaults to 7 days; 1 day keeps scans cheap). */
  retentionLedgers: number;
  firstLedger: number;
  maxLimit: number;
}

export interface MockRpcStats {
  calls: Record<string, number>;
  /** Contract IDs requested across all getEvents calls. */
  contractsRequested: number;
  eventsServed: number;
  errors: number;
}

const DEFAULTS: MockRpcOptions = {
  ledgerMs: 5000,
  eventPeriod: 20,
  latencyMs: 30,
  retentionLedgers: 17_280,
  firstLedger: 1_000_000,
  maxLimit: 10_000,
};

const PASSPHRASE = 'Test SDF Network ; September 2015';
const TOPIC_XDR = nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64');
const pad = (n: bigint | number | string, width: number) => n.toString().padStart(width, '0');
const toid = (ledger: number, tx: number) => (BigInt(ledger) << 32n) | (BigInt(tx) << 12n);

/** Deterministic contract ID for synthetic contract `index`. */
export function benchContractId(index: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(index, 0);
  raw.write('bench', 4);
  return StrKey.encodeContract(raw);
}

function contractIndex(contractId: string): number {
  return StrKey.decodeContract(contractId).readUInt32BE(0);
}

class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startMockRpc(options: Partial<MockRpcOptions> = {}) {
  const opts = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const stats: MockRpcStats = { calls: {}, contractsRequested: 0, eventsServed: 0, errors: 0 };

  const latestLedger = () =>
    opts.firstLedger + Math.floor((Date.now() - startedAt) / opts.ledgerMs);
  const oldestLedger = () => Math.max(1, latestLedger() - opts.retentionLedgers + 1);
  const closedAt = (ledger: number) =>
    new Date(startedAt + (ledger - opts.firstLedger) * opts.ledgerMs).toISOString();

  function getEvents(params: {
    filters?: { contractIds?: string[] }[];
    startLedger?: number;
    pagination?: { cursor?: string; limit?: number };
  }) {
    const filters = params.filters ?? [];
    if (filters.length > 5) throw new RpcFault(-32602, 'maximum 5 filters per request');
    const indexes = new Set<number>();
    for (const f of filters) {
      const ids = f.contractIds ?? [];
      if (ids.length > 5) throw new RpcFault(-32602, 'maximum 5 contract IDs per filter');
      for (const id of ids) indexes.add(contractIndex(id));
    }
    stats.contractsRequested += indexes.size;
    const sorted = [...indexes].sort((a, b) => a - b);

    const latest = latestLedger();
    const oldest = oldestLedger();
    const limit = Math.min(params.pagination?.limit ?? 100, opts.maxLimit);
    const cursor = params.pagination?.cursor;
    let fromLedger: number;
    let after = '';
    if (cursor) {
      after = cursor;
      fromLedger = Number(BigInt(cursor.split('-')[0]!) >> 32n);
      if (fromLedger < oldest) throw new RpcFault(-32600, 'cursor is before the oldest ledger');
    } else {
      fromLedger = params.startLedger ?? latest;
      if (fromLedger < oldest || fromLedger > latest)
        throw new RpcFault(
          -32600,
          `startLedger must be between the oldest ledger: ${oldest} and the latest ledger: ${latest}`,
        );
    }

    const events: object[] = [];
    let lastId = '';
    scan: for (let ledger = fromLedger; ledger <= latest; ledger++) {
      for (const i of sorted) {
        if ((ledger + i) % opts.eventPeriod !== 0) continue;
        const id = `${pad(toid(ledger, (i % 1_000_000) + 1), 19)}-${pad(0, 10)}`;
        if (id <= after) continue;
        events.push({
          type: 'contract',
          ledger,
          ledgerClosedAt: closedAt(ledger),
          contractId: benchContractId(i),
          id,
          txHash: pad(ledger.toString(16), 32) + pad(i.toString(16), 32),
          inSuccessfulContractCall: true,
          topic: [TOPIC_XDR],
          value: nativeToScVal(ledger, { type: 'u32' }).toXDR('base64'),
        });
        lastId = id;
        if (events.length >= limit) break scan;
      }
    }
    stats.eventsServed += events.length;
    // A short page means the whole range was scanned: resume after the latest ledger.
    const next = events.length >= limit ? lastId : `${pad(toid(latest + 1, 0), 19)}-${pad(0, 10)}`;
    return {
      events,
      cursor: next,
      latestLedger: latest,
      oldestLedger: oldest,
      latestLedgerCloseTime: String(Math.floor(Date.parse(closedAt(latest)) / 1000)),
      oldestLedgerCloseTime: String(Math.floor(Date.parse(closedAt(oldest)) / 1000)),
    };
  }

  function handle(method: string, params: unknown) {
    switch (method) {
      case 'getHealth':
        return {
          status: 'healthy',
          latestLedger: latestLedger(),
          oldestLedger: oldestLedger(),
          ledgerRetentionWindow: opts.retentionLedgers,
        };
      case 'getLatestLedger':
        return { id: 'bench', protocolVersion: 23, sequence: latestLedger() };
      case 'getNetwork':
        return { passphrase: PASSPHRASE, protocolVersion: 23 };
      case 'getLedgerEntries':
        return { entries: [], latestLedger: latestLedger() };
      case 'getEvents':
        return getEvents(params as Parameters<typeof getEvents>[0]);
      default:
        throw new RpcFault(-32601, `method not found: ${method}`);
    }
  }

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let reply: object;
      let msg: { id?: unknown; method?: string; params?: unknown } = {};
      try {
        msg = JSON.parse(body);
        const method = msg.method ?? '';
        stats.calls[method] = (stats.calls[method] ?? 0) + 1;
        reply = { jsonrpc: '2.0', id: msg.id, result: handle(method, msg.params) };
      } catch (err) {
        stats.errors++;
        const code = err instanceof RpcFault ? err.code : -32603;
        reply = { jsonrpc: '2.0', id: msg.id, error: { code, message: (err as Error).message } };
      }
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply));
      }, opts.latencyMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    options: opts,
    latestLedger,
    /** A copy of the counters, for diffing between two points in time. */
    stats: (): MockRpcStats => ({ ...stats, calls: { ...stats.calls } }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
