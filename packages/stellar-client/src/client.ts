import { rpc, xdr } from '@stellar/stellar-sdk';
import { classifyRpcError, RpcError } from './errors';
import { contractCodeLedgerKey, contractInstanceLedgerKey, ledgerKeyToXdr } from './keys';
import { withRetry } from './retry';
import { decodeScVal } from './scval';

/** Upper bound of contract IDs in one getEvents call (5 filters x 5 IDs). */
export const MAX_CONTRACTS_PER_REQUEST = 25;

export interface RpcHealth {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

export interface NormalizedEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  contractId: string | null;
  topics: string[];
  topicsXdr: string[];
  value: unknown;
  valueXdr: string;
  inSuccessfulContractCall: boolean;
}

export interface EventsPage {
  events: NormalizedEvent[];
  /** Cursor to resume from; RPC advances it even when no events were found. */
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
}

export type GetEventsParams = {
  contractIds: string[];
  limit?: number;
} & ({ cursor: string; startLedger?: never } | { startLedger: number; cursor?: never });

export interface ContractInfo {
  contractId: string;
  executableType: 'wasm' | 'stellar_asset';
  wasmHash: string | null;
  instanceLedgerKeyXdr: string;
  codeLedgerKeyXdr: string | null;
  instanceLiveUntilLedger: number | null;
  codeLiveUntilLedger: number | null;
  latestLedger: number;
}

export interface LedgerEntryTtl {
  ledgerKeyXdr: string;
  exists: boolean;
  liveUntilLedger: number | null;
  lastModifiedLedger: number | null;
}

/** Narrow interface the API and worker depend on; implemented by StellarRpcClient and test fakes. */
export interface StellarClient {
  getHealth(): Promise<RpcHealth>;
  getNetworkPassphrase(): Promise<string>;
  getEvents(params: GetEventsParams): Promise<EventsPage>;
  getContractInfo(contractId: string): Promise<ContractInfo | null>;
  getLedgerEntryTtls(
    ledgerKeysXdr: string[],
  ): Promise<{ latestLedger: number; entries: LedgerEntryTtl[] }>;
  /** The provider URL currently serving calls. */
  activeRpcUrl?(): string;
}

export interface StellarRpcClientOptions {
  rpcUrl: string;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  headers?: Record<string, string>;
  onRetry?: (err: RpcError, attempt: number, delayMs: number) => void;
  /** Called after each RPC method call; used for metrics. */
  onCall?: (method: string, durationMs: number, ok: boolean) => void;
}

const MAX_KEYS_PER_REQUEST = 200;

export class StellarRpcClient implements StellarClient {
  private readonly server: rpc.Server;

  constructor(private readonly opts: StellarRpcClientOptions) {
    this.server = new rpc.Server(opts.rpcUrl, {
      allowHttp: opts.rpcUrl.startsWith('http://'),
      timeout: opts.timeoutMs ?? 15_000,
      headers: opts.headers,
    });
  }

  activeRpcUrl(): string {
    return this.opts.rpcUrl;
  }

  private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await withRetry(
        async () => {
          try {
            return await fn();
          } catch (err) {
            throw classifyRpcError(err);
          }
        },
        {
          retries: this.opts.retries ?? 3,
          baseDelayMs: this.opts.baseDelayMs ?? 500,
          maxDelayMs: this.opts.maxDelayMs ?? 8_000,
          shouldRetry: (err) => err instanceof RpcError && err.retryable,
          onRetry: (err, attempt, delay) => this.opts.onRetry?.(err as RpcError, attempt, delay),
        },
      );
      this.opts.onCall?.(method, Date.now() - started, true);
      return result;
    } catch (err) {
      this.opts.onCall?.(method, Date.now() - started, false);
      throw err;
    }
  }

  async getHealth(): Promise<RpcHealth> {
    const h = await this.call('getHealth', () => this.server.getHealth());
    return {
      status: h.status,
      latestLedger: h.latestLedger,
      oldestLedger: h.oldestLedger,
      ledgerRetentionWindow: h.ledgerRetentionWindow,
    };
  }

  async getNetworkPassphrase(): Promise<string> {
    const n = await this.call('getNetwork', () => this.server.getNetwork());
    return n.passphrase;
  }

  async getEvents(params: GetEventsParams): Promise<EventsPage> {
    const ids = params.contractIds;
    if (ids.length === 0 || ids.length > MAX_CONTRACTS_PER_REQUEST) {
      throw new RpcError(
        `getEvents supports 1-${MAX_CONTRACTS_PER_REQUEST} contract IDs per request`,
        'invalid_request',
        false,
      );
    }
    // RPC allows 5 filters of 5 contract IDs each; filters are OR-ed together.
    const filters: rpc.Api.EventFilter[] = [];
    for (let i = 0; i < ids.length; i += 5) filters.push({ contractIds: ids.slice(i, i + 5) });
    const limit = params.limit ?? 200;
    const request: rpc.Api.GetEventsRequest =
      params.cursor !== undefined
        ? { filters, cursor: params.cursor, limit }
        : { filters, startLedger: params.startLedger, limit };
    const res = await this.call('getEvents', () => this.server.getEvents(request));
    return {
      events: res.events.map(normalizeEvent),
      cursor: res.cursor,
      latestLedger: res.latestLedger,
      oldestLedger: res.oldestLedger,
    };
  }

  async getContractInfo(contractId: string): Promise<ContractInfo | null> {
    const instanceKey = contractInstanceLedgerKey(contractId);
    const res = await this.call('getLedgerEntries', () =>
      this.server.getLedgerEntries(instanceKey),
    );
    const entry = res.entries[0];
    if (!entry) return null;

    const instance = entry.val.contractData().val().instance();
    const executable = instance.executable();
    let executableType: ContractInfo['executableType'] = 'stellar_asset';
    let wasmHash: string | null = null;
    if (executable.switch().value === xdr.ContractExecutableType.contractExecutableWasm().value) {
      executableType = 'wasm';
      wasmHash = Buffer.from(executable.wasmHash()).toString('hex');
    }

    let codeLedgerKeyXdr: string | null = null;
    let codeLiveUntilLedger: number | null = null;
    if (wasmHash) {
      const codeKey = contractCodeLedgerKey(wasmHash);
      codeLedgerKeyXdr = ledgerKeyToXdr(codeKey);
      const code = await this.call('getLedgerEntries', () => this.server.getLedgerEntries(codeKey));
      codeLiveUntilLedger = code.entries[0]?.liveUntilLedgerSeq ?? null;
    }

    return {
      contractId,
      executableType,
      wasmHash,
      instanceLedgerKeyXdr: ledgerKeyToXdr(instanceKey),
      codeLedgerKeyXdr,
      instanceLiveUntilLedger: entry.liveUntilLedgerSeq ?? null,
      codeLiveUntilLedger,
      latestLedger: res.latestLedger,
    };
  }

  async getLedgerEntryTtls(
    ledgerKeysXdr: string[],
  ): Promise<{ latestLedger: number; entries: LedgerEntryTtl[] }> {
    const results = new Map<string, LedgerEntryTtl>();
    let latestLedger = 0;
    for (let i = 0; i < ledgerKeysXdr.length; i += MAX_KEYS_PER_REQUEST) {
      const chunk = ledgerKeysXdr.slice(i, i + MAX_KEYS_PER_REQUEST);
      const keys = chunk.map((k) => xdr.LedgerKey.fromXDR(k, 'base64'));
      const res = await this.call('getLedgerEntries', () => this.server.getLedgerEntries(...keys));
      latestLedger = Math.max(latestLedger, res.latestLedger);
      for (const e of res.entries) {
        const keyXdr = e.key.toXDR('base64');
        results.set(keyXdr, {
          ledgerKeyXdr: keyXdr,
          exists: true,
          liveUntilLedger: e.liveUntilLedgerSeq ?? null,
          lastModifiedLedger: e.lastModifiedLedgerSeq ?? null,
        });
      }
    }
    return {
      latestLedger,
      entries: ledgerKeysXdr.map(
        (k) =>
          results.get(k) ?? {
            ledgerKeyXdr: k,
            exists: false,
            liveUntilLedger: null,
            lastModifiedLedger: null,
          },
      ),
    };
  }
}

export function normalizeEvent(e: rpc.Api.EventResponse): NormalizedEvent {
  const topics = e.topic.map(decodeScVal);
  const value = decodeScVal(e.value);
  return {
    id: e.id,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: new Date(e.ledgerClosedAt),
    txHash: e.txHash,
    contractId: e.contractId ? e.contractId.contractId() : null,
    topics: topics.map((t) => t.display),
    topicsXdr: topics.map((t) => t.xdr),
    value: value.json,
    valueXdr: value.xdr,
    // Newer RPC versions omit this field: since protocol 23 failed transactions emit no contract events.
    inSuccessfulContractCall: e.inSuccessfulContractCall ?? true,
  };
}
