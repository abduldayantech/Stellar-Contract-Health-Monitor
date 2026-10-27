import type { Network } from './networks';

/** What `stellar contract extend` needs to know about a storage entry. */
export type ExtendTarget =
  | { kind: 'instance' }
  | { kind: 'code'; wasmHash: string }
  | {
      kind: 'data';
      durability: 'persistent' | 'temporary';
      /** Symbol keys can be passed as `--key`; anything else as base64 ScVal `--key-xdr`. */
      key: { symbol: string } | { xdr: string };
    };

/** ~31 days at 5s per ledger. Networks cap a TTL at their max entry TTL, so larger values are clamped. */
export const DEFAULT_EXTEND_LEDGERS = 535_679;

const NETWORK_FLAG: Record<Network, string> = {
  TESTNET: 'testnet',
  MAINNET: 'mainnet',
  FUTURENET: 'futurenet',
  LOCAL: 'local',
};

/** Quotes a value for POSIX shells unless it only has characters that never need quoting. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_+/=.:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a copyable Stellar CLI command that extends an entry's TTL:
 * - instance: `--id <contract>` with no key extends the contract instance
 * - code:     `--wasm-hash <hash>` extends the contract's Wasm code entry
 * - data:     `--id <contract> --key <symbol>` (or `--key-xdr`) with its durability
 */
export function extendTtlCommand(params: {
  contractId: string;
  network: Network;
  target: ExtendTarget;
  ledgersToExtend?: number;
  source?: string;
}): string {
  const { target } = params;
  const args = ['stellar', 'contract', 'extend'];
  if (target.kind === 'code') {
    args.push('--wasm-hash', shellArg(target.wasmHash));
  } else {
    args.push('--id', shellArg(params.contractId));
    if (target.kind === 'data') {
      if ('symbol' in target.key) args.push('--key', shellArg(target.key.symbol));
      else args.push('--key-xdr', shellArg(target.key.xdr));
      args.push('--durability', target.durability);
    }
  }
  args.push(
    '--ledgers-to-extend',
    String(params.ledgersToExtend ?? DEFAULT_EXTEND_LEDGERS),
    '--network',
    NETWORK_FLAG[params.network],
    '--source',
    params.source ?? '<YOUR_IDENTITY>',
  );
  return args.join(' ');
}
