import { describe, expect, it } from 'vitest';
import { extendTtlCommand } from '../src';

const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('extendTtlCommand', () => {
  it('extends the contract instance without a key', () => {
    expect(extendTtlCommand({ contractId, network: 'TESTNET', target: { kind: 'instance' } })).toBe(
      `stellar contract extend --id ${contractId} --ledgers-to-extend 535679 --network testnet --source <YOUR_IDENTITY>`,
    );
  });

  it('extends contract code by Wasm hash', () => {
    const hash = 'ab'.repeat(32);
    expect(
      extendTtlCommand({
        contractId,
        network: 'MAINNET',
        target: { kind: 'code', wasmHash: hash },
        ledgersToExtend: 100,
        source: 'alice',
      }),
    ).toBe(
      `stellar contract extend --wasm-hash ${hash} --ledgers-to-extend 100 --network mainnet --source alice`,
    );
  });

  it('passes symbol keys with --key and other keys with --key-xdr, with durability', () => {
    expect(
      extendTtlCommand({
        contractId,
        network: 'TESTNET',
        target: { kind: 'data', durability: 'temporary', key: { symbol: 'admin' } },
      }),
    ).toContain(`--id ${contractId} --key admin --durability temporary --ledgers-to-extend`);
    expect(
      extendTtlCommand({
        contractId,
        network: 'FUTURENET',
        target: { kind: 'data', durability: 'persistent', key: { xdr: 'AAAAEAAAAAEAAAAB' } },
      }),
    ).toContain('--key-xdr AAAAEAAAAAEAAAAB --durability persistent');
  });

  it('quotes values that need it', () => {
    expect(
      extendTtlCommand({
        contractId,
        network: 'LOCAL',
        target: { kind: 'data', durability: 'persistent', key: { symbol: "it's" } },
      }),
    ).toContain(`--key 'it'\\''s'`);
  });
});
