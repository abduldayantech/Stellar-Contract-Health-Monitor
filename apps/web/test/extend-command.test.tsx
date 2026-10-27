import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExtendCommand, needsExtending } from '@/components/extend-command';
import type { StorageEntry } from '@/lib/types';

const contract = {
  contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  network: 'TESTNET' as const,
};

function entry(overrides: Partial<StorageEntry> = {}): StorageEntry {
  return {
    id: 's1',
    kind: 'PERSISTENT',
    label: 'Admin',
    ledgerKeyXdr: 'x',
    exists: true,
    liveUntilLedger: 2000,
    ledgersRemaining: 1000,
    estimatedExpiry: null,
    lastCheckedAt: null,
    lastError: null,
    extend: { kind: 'data', durability: 'persistent', key: { symbol: 'Admin' } },
    ...overrides,
  };
}

describe('ExtendCommand', () => {
  it('renders a copyable stellar contract extend command', () => {
    render(<ExtendCommand contract={contract} entry={entry()} />);
    const command = `stellar contract extend --id ${contract.contractId} --key Admin --durability persistent --ledgers-to-extend 535679 --network testnet --source <YOUR_IDENTITY>`;
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Copy command: ${command}` })).toBeInTheDocument();
  });

  it('flags live entries that expire within about a week', () => {
    expect(needsExtending(entry())).toBe(true);
    expect(needsExtending(entry({ ledgersRemaining: 500_000 }))).toBe(false);
    expect(needsExtending(entry({ exists: false }))).toBe(false);
    expect(needsExtending(entry({ extend: null }))).toBe(false);
  });
});
