'use client';

import { extendTtlCommand } from '@stellar-health/shared-types/extend-command';
import type { ContractDetail, StorageEntry } from '@/lib/types';
import { CopyButton } from './copy-button';

/** About 7 days of ledgers: entries below this get a highlighted "Extend TTL" button. */
export const EXTEND_SOON_LEDGERS = 120_960;

export function needsExtending(entry: StorageEntry): boolean {
  return (
    entry.exists &&
    entry.extend !== null &&
    entry.ledgersRemaining !== null &&
    entry.ledgersRemaining <= EXTEND_SOON_LEDGERS
  );
}

/** Copyable `stellar contract extend` command for one storage entry. */
export function ExtendCommand({
  contract,
  entry,
}: {
  contract: Pick<ContractDetail, 'contractId' | 'network'>;
  entry: StorageEntry;
}) {
  if (!entry.extend) return null;
  const command = extendTtlCommand({
    contractId: contract.contractId,
    network: contract.network,
    target: entry.extend,
  });
  return (
    <div className="space-y-1.5" data-testid="extend-command">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Extend the TTL with the{' '}
        <a
          className="underline"
          href="https://developers.stellar.org/docs/tools/cli/stellar-cli"
          target="_blank"
          rel="noreferrer"
        >
          Stellar CLI
        </a>
        . Replace <code>&lt;YOUR_IDENTITY&gt;</code> with the account that pays the fee; anyone can
        extend a TTL.
      </p>
      <div className="flex items-start gap-2">
        <code className="block flex-1 overflow-x-auto rounded bg-slate-100 px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap dark:bg-slate-800">
          {command}
        </code>
        <CopyButton value={command} label="Copy command" />
      </div>
    </div>
  );
}
