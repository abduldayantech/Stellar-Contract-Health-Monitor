import { describeWasmChanged } from '@stellar-health/alert-engine';
import type { Contract } from '@stellar-health/db';
import type { StellarClient } from '@stellar-health/stellar-client';
import { activeRulesFor, triggerAlert } from './alerts';
import type { WorkerDeps } from './deps';

/**
 * Detects a contract upgrade by comparing the instance's current WASM hash with the stored one.
 * Fires WASM_CHANGED rules (one alert per change), then records the new hash and re-points the
 * CODE storage entry at the new code so TTL checks follow the upgrade.
 */
export async function checkWasmUpgrade(
  deps: WorkerDeps,
  contract: Contract,
  client: StellarClient,
): Promise<{ changed: boolean }> {
  const info = await client.getContractInfo(contract.contractId);
  if (!info?.wasmHash || info.wasmHash === contract.wasmHash) return { changed: false };

  const previous = contract.wasmHash;
  if (previous) {
    const rules = await activeRulesFor(deps, contract.id, 'WASM_CHANGED');
    for (const rule of rules) {
      try {
        await triggerAlert(deps, {
          rule,
          contract,
          severity: rule.severity,
          level: false,
          description: describeWasmChanged({
            ruleName: rule.name,
            contract,
            previousWasmHash: previous,
            newWasmHash: info.wasmHash,
            latestLedger: info.latestLedger,
          }),
        });
      } catch (err) {
        deps.logger.error({ err, ruleId: rule.id, contractRefId: contract.id }, 'WASM rule failed');
      }
    }
    deps.logger.warn(
      { contractRefId: contract.id, previous, current: info.wasmHash },
      'contract WASM changed',
    );
  }

  const now = deps.now();
  await deps.prisma.$transaction(async (tx) => {
    await tx.contract.update({
      where: { id: contract.id },
      data: { wasmHash: info.wasmHash, executableType: info.executableType },
    });
    if (!info.codeLedgerKeyXdr) return;
    const code = {
      ledgerKeyXdr: info.codeLedgerKeyXdr,
      exists: info.codeLiveUntilLedger !== null,
      liveUntilLedger: info.codeLiveUntilLedger,
      lastCheckedLedger: info.latestLedger,
      lastCheckedAt: now,
      lastError: null,
    };
    const existing = await tx.storageEntry.findFirst({
      where: { contractRefId: contract.id, kind: 'CODE' },
    });
    if (existing) await tx.storageEntry.update({ where: { id: existing.id }, data: code });
    else
      await tx.storageEntry.create({
        data: { ...code, contractRefId: contract.id, kind: 'CODE', label: 'Contract code (WASM)' },
      });
  });
  return { changed: true };
}
