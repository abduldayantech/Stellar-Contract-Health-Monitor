import type * as ApiModule from '@/lib/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const push = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: (...args: unknown[]) => api(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/app-shell', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const { default: AddContractPage } = await import('@/app/contracts/new/page');
const ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

beforeEach(() => {
  api.mockReset();
  push.mockReset();
  api.mockImplementation(async (path: string) =>
    path === '/contracts/validate'
      ? {
          contractId: ID,
          network: 'TESTNET',
          executableType: 'wasm',
          wasmHash: null,
          instanceLiveUntilLedger: null,
          codeLiveUntilLedger: null,
          latestLedger: 1,
          alreadyRegistered: null,
        }
      : { id: 'c1' },
  );
});

async function addContract() {
  fireEvent.change(screen.getByLabelText('Contract ID'), { target: { value: ID } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
  await screen.findByTestId('validation-result');
  fireEvent.click(screen.getByRole('button', { name: 'Start monitoring' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/contracts/c1'));
  return api.mock.calls.find(([path]) => path === '/contracts')![1].body;
}

describe('Add contract backfill', () => {
  it('defaults to one day of history and explains retention', async () => {
    render(<AddContractPage />);
    expect(screen.getByLabelText('Backfill history')).toHaveValue('1d');
    expect(screen.getByText(/start at the oldest ledger available/)).toBeInTheDocument();
    expect(await addContract()).toMatchObject({ contractId: ID, lookbackLedgers: 17_280 });
  });

  it.each([
    ['none', 0],
    ['1h', 720],
    ['7d', 120_960],
  ])('sends %s as %i ledgers', async (choice, ledgers) => {
    render(<AddContractPage />);
    fireEvent.change(screen.getByLabelText('Backfill history'), { target: { value: choice } });
    expect(await addContract()).toMatchObject({ lookbackLedgers: ledgers });
  });
});
