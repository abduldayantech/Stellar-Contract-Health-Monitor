import {
  decideLevelTransition,
  describeTtl,
  evaluateTtl,
  isCoolingDown,
  ttlSeverity,
} from '@stellar-health/alert-engine';
import { ttlExpiryConfigSchema, type Network } from '@stellar-health/shared-types';
import { activeRulesFor, openAlertFor, resolveLevelAlert, triggerAlert } from './alerts';
import type { WorkerDeps } from './deps';
import { checkWasmUpgrade } from './upgrades';

/**
 * Refreshes TTLs (liveUntilLedger) of a contract's monitored storage entries
 * and evaluates TTL_EXPIRY rules against them.
 */
export async function checkStorage(deps: WorkerDeps, contractRefId: string) {
  const { prisma } = deps;
  const contract = await prisma.contract.findUnique({
    where: { id: contractRefId },
    include: { storageEntries: true },
  });
  if (!contract || contract.status !== 'ACTIVE' || contract.storageEntries.length === 0) {
    return { checked: 0 };
  }
  const network = contract.network as Network;
  const client = await deps.getClient(network);
  const now = deps.now();

  if (contract.executableType !== 'stellar_asset') {
    try {
      const { changed } = await checkWasmUpgrade(deps, contract, client);
      // The CODE entry now points at the new code; reload before refreshing TTLs.
      if (changed)
        contract.storageEntries = await prisma.storageEntry.findMany({
          where: { contractRefId: contract.id },
        });
    } catch (err) {
      deps.logger.warn({ err, contractRefId }, 'failed to check for a WASM upgrade');
    }
  }

  const { latestLedger, entries } = await client.getLedgerEntryTtls(
    contract.storageEntries.map((s) => s.ledgerKeyXdr),
  );
  const byKey = new Map(entries.map((e) => [e.ledgerKeyXdr, e]));
  await prisma.$transaction(
    contract.storageEntries.map((s) => {
      const ttl = byKey.get(s.ledgerKeyXdr);
      return prisma.storageEntry.update({
        where: { id: s.id },
        data: {
          exists: ttl?.exists ?? false,
          liveUntilLedger: ttl?.liveUntilLedger ?? null,
          lastCheckedLedger: latestLedger,
          lastCheckedAt: now,
          lastError: null,
        },
      });
    }),
  );
  await prisma.networkState.upsert({
    where: { network },
    create: { network, latestLedger, lastCheckedAt: now },
    update: { latestLedger, lastCheckedAt: now },
  });

  const fresh = contract.storageEntries.map((s) => {
    const ttl = byKey.get(s.ledgerKeyXdr);
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      exists: ttl?.exists ?? false,
      liveUntilLedger: ttl?.liveUntilLedger ?? null,
    };
  });

  const rules = await activeRulesFor(deps, contract.id, 'TTL_EXPIRY');
  for (const rule of rules) {
    try {
      const config = ttlExpiryConfigSchema.parse(rule.config);
      const breaches = evaluateTtl({ config, entries: fresh, latestLedger });
      const { state, openAlertId } = await openAlertFor(deps, rule.id, contract.id);
      const transition = decideLevelTransition({
        conditionActive: breaches.length > 0,
        hasOpenAlert: openAlertId !== null,
        coolingDown: isCoolingDown(state?.lastTriggeredAt ?? null, rule.cooldownSeconds, now),
      });
      if (transition === 'trigger') {
        await triggerAlert(deps, {
          rule,
          contract,
          severity: ttlSeverity(rule.severity, breaches),
          level: true,
          description: describeTtl({
            ruleName: rule.name,
            contract,
            breaches,
            latestLedger,
            ledgersThreshold: config.ledgersThreshold,
          }),
        });
      } else if (transition === 'resolve' && openAlertId) {
        await resolveLevelAlert(deps, { rule, contractRefId: contract.id, alertId: openAlertId });
      }
    } catch (err) {
      deps.logger.error({ err, ruleId: rule.id, contractRefId }, 'failed to evaluate TTL rule');
    }
  }
  return { checked: entries.length, latestLedger };
}
