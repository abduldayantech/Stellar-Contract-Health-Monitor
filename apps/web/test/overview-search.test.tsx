import type * as ApiModule from '@/lib/api';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, useSyncExternalStore, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from '@/lib/types';

const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  return {
    replace: vi.fn((url: string) => {
      const next = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      if (next === search) return;
      search = next;
      listeners.forEach((listener) => listener());
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSearch: () => search,
    setSearch(next: string) {
      search = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      search = '';
      this.replace.mockClear();
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/',
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(nav.subscribe, nav.getSearch, nav.getSearch)),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

function matches(contract: Contract, search: string): boolean {
  const q = search.trim();
  if (!q) return true;
  const label = (contract.label ?? '').toLowerCase();
  return (
    label.includes(q.toLowerCase()) || contract.contractId.toUpperCase().startsWith(q.toUpperCase())
  );
}

const contracts = [
  {
    id: 'c1',
    label: 'Alpha token',
    contractId: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    network: 'TESTNET',
    health: 'healthy',
    eventCount: 3,
    lastEventAt: null,
    openAlerts: 0,
    nearestExpiryLedgers: null,
    lastError: null,
  },
  {
    id: 'c2',
    label: 'Beta pool',
    contractId: 'CZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS',
    network: 'TESTNET',
    health: 'warning',
    eventCount: 1,
    lastEventAt: null,
    openAlerts: 1,
    nearestExpiryLedgers: null,
    lastError: null,
  },
] as Contract[];

function contractsPage(path: string) {
  const search = new URL(path, 'http://localhost').searchParams.get('search') ?? '';
  return { items: contracts.filter((contract) => matches(contract, search)), nextCursor: null };
}

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  // The contract grid pages with useSWRInfinite, which fetches through api().
  api: async (path: string) => contractsPage(path),
  useApi: (path: string | null) => {
    if (!path || path.startsWith('/events') || path.startsWith('/alerts')) {
      return { data: { items: [] }, isLoading: false };
    }
    if (path.startsWith('/contracts')) return { data: contractsPage(path), isLoading: false };
    return { data: undefined, isLoading: false };
  },
}));

const { default: OverviewPage } = await import('@/app/page');

beforeEach(() => {
  nav.reset();
});

describe('Overview contract search', () => {
  it('filters by label without changing the monitored total, and keeps the query in the URL', async () => {
    const user = userEvent.setup();
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <OverviewPage />
      </SWRConfig>,
    );

    expect(await screen.findByText('Alpha token')).toBeInTheDocument();
    expect(screen.getByText('Beta pool')).toBeInTheDocument();
    expect(screen.getByText('Monitored contracts').parentElement).toHaveTextContent('2');

    await user.type(screen.getByLabelText('Search contracts'), 'ALPHA');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByText('Beta pool')).toBeInTheDocument();

    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/?q=ALPHA', { scroll: false }));
    await waitFor(() => expect(screen.queryByText('Beta pool')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha token')).toBeInTheDocument();
    expect(screen.getByText('Monitored contracts').parentElement).toHaveTextContent('2');

    await user.clear(screen.getByLabelText('Search contracts'));
    await waitFor(() => expect(screen.getByText('Beta pool')).toBeInTheDocument());
    expect(nav.replace).toHaveBeenCalledWith('/', { scroll: false });
  });

  it('reads ?q= and filters by contract ID prefix', async () => {
    nav.setSearch('q=czzz');
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <OverviewPage />
      </SWRConfig>,
    );

    expect(screen.getByLabelText('Search contracts')).toHaveValue('czzz');
    expect(await screen.findByText('Beta pool')).toBeInTheDocument();
    expect(screen.queryByText('Alpha token')).not.toBeInTheDocument();
    expect(screen.getByText('Monitored contracts').parentElement).toHaveTextContent('2');
  });
});
