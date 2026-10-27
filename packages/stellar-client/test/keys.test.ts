import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  buildStorageKeyScVal,
  contractCodeLedgerKey,
  contractDataLedgerKey,
  contractInstanceLedgerKey,
  extendTargetForLedgerKey,
  ledgerKeyToXdr,
} from '../src';

const ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('ledger keys', () => {
  it('builds the instance key matching what RPC returns', () => {
    expect(ledgerKeyToXdr(contractInstanceLedgerKey(ID))).toBe(
      'AAAABgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAABQAAAAB',
    );
  });

  it('builds symbol and enum-variant storage keys', () => {
    expect(buildStorageKeyScVal('symbol', 'Admin').switch().name).toBe('scvSymbol');
    const variant = buildStorageKeyScVal('enum_variant', 'Admin');
    expect(variant.switch().name).toBe('scvVec');
    expect(variant.vec()?.[0]?.sym().toString()).toBe('Admin');
  });

  it('accepts raw XDR keys', () => {
    const b64 = xdr.ScVal.scvU32(7).toXDR('base64');
    expect(buildStorageKeyScVal('xdr', b64).u32()).toBe(7);
  });

  it('encodes durability', () => {
    const key = contractDataLedgerKey(ID, buildStorageKeyScVal('symbol', 'x'), 'TEMPORARY');
    expect(key.contractData().durability().name).toBe('temporary');
  });
});

describe('extendTargetForLedgerKey', () => {
  it('recognises instance, code and data keys', () => {
    expect(extendTargetForLedgerKey(ledgerKeyToXdr(contractInstanceLedgerKey(ID)))).toEqual({
      kind: 'instance',
    });
    const hash = 'ab'.repeat(32);
    expect(extendTargetForLedgerKey(ledgerKeyToXdr(contractCodeLedgerKey(hash)))).toEqual({
      kind: 'code',
      wasmHash: hash,
    });
    const symbolKey = contractDataLedgerKey(
      ID,
      buildStorageKeyScVal('symbol', 'admin'),
      'TEMPORARY',
    );
    expect(extendTargetForLedgerKey(ledgerKeyToXdr(symbolKey))).toEqual({
      kind: 'data',
      durability: 'temporary',
      key: { symbol: 'admin' },
    });
    const variant = buildStorageKeyScVal('enum_variant', 'Admin');
    const variantKey = contractDataLedgerKey(ID, variant, 'PERSISTENT');
    expect(extendTargetForLedgerKey(ledgerKeyToXdr(variantKey))).toEqual({
      kind: 'data',
      durability: 'persistent',
      key: { xdr: variant.toXDR('base64') },
    });
  });

  it('returns null for invalid XDR', () => {
    expect(extendTargetForLedgerKey('not-xdr')).toBeNull();
  });
});
