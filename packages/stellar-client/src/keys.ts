import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { ExtendTarget } from '@stellar-health/shared-types';

export type StorageKeyType = 'symbol' | 'enum_variant' | 'xdr';
export type Durability = 'PERSISTENT' | 'TEMPORARY';

/**
 * Builds the ScVal for a storage key.
 * - symbol:       `symbol_short!("admin")` style keys → ScSymbol
 * - enum_variant: `DataKey::Admin` (unit variant of a #[contracttype] enum) → ScVec[ScSymbol]
 * - xdr:          any key, given as base64 ScVal XDR
 */
export function buildStorageKeyScVal(type: StorageKeyType, key: string): xdr.ScVal {
  switch (type) {
    case 'symbol':
      return nativeToScVal(key, { type: 'symbol' });
    case 'enum_variant':
      return xdr.ScVal.scvVec([nativeToScVal(key, { type: 'symbol' })]);
    case 'xdr':
      return xdr.ScVal.fromXDR(key, 'base64');
  }
}

export function contractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function contractDataLedgerKey(
  contractId: string,
  key: xdr.ScVal,
  durability: Durability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability:
        durability === 'TEMPORARY'
          ? xdr.ContractDataDurability.temporary()
          : xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function contractCodeLedgerKey(wasmHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, 'hex') }),
  );
}

export function ledgerKeyToXdr(key: xdr.LedgerKey): string {
  return key.toXDR('base64');
}

/**
 * Describes a monitored ledger key the way `stellar contract extend` takes it.
 * Returns null for keys that are not contract data or code.
 */
export function extendTargetForLedgerKey(ledgerKeyXdr: string): ExtendTarget | null {
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.fromXDR(ledgerKeyXdr, 'base64');
  } catch {
    return null;
  }
  switch (key.switch()) {
    case xdr.LedgerEntryType.contractCode():
      return { kind: 'code', wasmHash: key.contractCode().hash().toString('hex') };
    case xdr.LedgerEntryType.contractData(): {
      const data = key.contractData();
      const scKey = data.key();
      if (scKey.switch() === xdr.ScValType.scvLedgerKeyContractInstance())
        return { kind: 'instance' };
      return {
        kind: 'data',
        durability:
          data.durability() === xdr.ContractDataDurability.temporary() ? 'temporary' : 'persistent',
        key:
          scKey.switch() === xdr.ScValType.scvSymbol()
            ? { symbol: scKey.sym().toString() }
            : { xdr: scKey.toXDR('base64') },
      };
    }
    default:
      return null;
  }
}
