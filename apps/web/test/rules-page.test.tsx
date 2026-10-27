import type * as ApiModule from '@/lib/api';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertRule, Contract, Destination } from '@/lib/types';

const apiMock = vi.fn();
const mutateMock = vi.fn();

const rule = {
  id: 'r1',
  name: 'Quiet',
  type: 'INACTIVITY',
  contractRefId: 'c1',
  contract: { id: 'c1', contractId: 'CABC', label: 'Token', network: 'TESTNET' },
  enabled: true,
  severity: 'WARNING',
  config: { windowSeconds: 7200 },
  cooldownSeconds: 120,
  destinations: [{ id: 'd1', name: 'Ops hook', type: 'WEBHOOK' }],
  createdAt: '2026-01-01T00:00:00.000Z',
} as AlertRule;

const contracts = [
  { id: 'c1', label: 'Token', contractId: 'CABC', network: 'TESTNET' },
  { id: 'c2', label: 'Other', contractId: 'CDEF', network: 'TESTNET' },
] as Contract[];

const destinations = [
  {
    id: 'd1',
    name: 'Ops hook',
    type: 'WEBHOOK',
    enabled: true,
    config: { url: 'https://example.test/hook' },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
] as Destination[];

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  useApi: (path: string | null) => {
    if (path === '/alert-rules') {
      return { data: { items: [rule] }, isLoading: false, mutate: mutateMock };
    }
    if (path === '/contracts?limit=500') {
      return { data: { items: contracts }, isLoading: false, mutate: vi.fn() };
    }
    if (path === '/destinations') {
      return { data: { items: destinations }, isLoading: false, mutate: vi.fn() };
    }
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
  api: async (...args: unknown[]) => {
    apiMock(...args);
    return {};
  },
}));

const { default: RulesPage } = await import('@/app/alerts/rules/page');

beforeEach(() => {
  apiMock.mockReset();
  mutateMock.mockReset();
  window.scrollTo = vi.fn();
});

describe('Alert rules page', () => {
  it('opens a pre-filled create form and posts a new rule without changing the original', async () => {
    const user = userEvent.setup();
    render(<RulesPage />);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Quiet (copy)');
    expect(screen.getByLabelText('Type')).toBeEnabled();
    expect(screen.getByLabelText('Type')).toHaveValue('INACTIVITY');
    expect(screen.getByLabelText('Contract')).toBeEnabled();
    expect(screen.getByLabelText('Contract')).toHaveValue('c1');
    expect(screen.getByRole('checkbox', { name: /Ops hook/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Contract'), 'c2');
    await user.click(screen.getByRole('button', { name: 'Create rule' }));

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith('/alert-rules', {
      method: 'POST',
      body: expect.objectContaining({
        name: 'Quiet (copy)',
        type: 'INACTIVITY',
        contractRefId: 'c2',
        severity: 'WARNING',
        cooldownSeconds: 120,
        destinationIds: ['d1'],
        config: { windowSeconds: 7200 },
      }),
    });
    expect(screen.getByText('Quiet')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Quiet (copy)')).not.toBeInTheDocument();
    expect(mutateMock).toHaveBeenCalled();
  });
});
