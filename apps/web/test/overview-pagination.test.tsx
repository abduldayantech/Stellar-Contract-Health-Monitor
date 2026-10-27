import type * as ApiModule from '@/lib/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi } from 'vitest';
import type { Contract } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

const all = Array.from(
  { length: 60 },
  (_, i) =>
    ({
      id: `c${i}`,
      label: `Contract ${i}`,
      contractId: `C${String(i).padStart(55, 'A')}`,
      network: 'TESTNET',
      health: 'healthy',
      eventCount: 0,
      lastEventAt: null,
      openAlerts: 0,
      nearestExpiryLedgers: null,
      lastError: null,
    }) as Contract,
);

const api = vi.fn(async (path: string) => {
  const url = new URL(path, 'http://localhost');
  const limit = Number(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');
  const start = cursor ? all.findIndex((c) => c.id === cursor) + 1 : 0;
  const items = all.slice(start, start + limit);
  return { items, nextCursor: start + limit < all.length ? items.at(-1)!.id : null };
});

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: (path: string) => api(path),
  useApi: (path: string | null) =>
    path?.startsWith('/status')
      ? {
          data: {
            database: { ok: true, latencyMs: 1 },
            redis: { ok: true, latencyMs: 1 },
            workerHealthy: true,
            workers: [],
            networks: [],
            totals: {
              contracts: { ACTIVE: 58, PAUSED: 2 },
              events24h: 0,
              openAlerts: 0,
              failedDeliveries24h: 0,
            },
          },
          isLoading: false,
        }
      : { data: { items: path?.startsWith('/contracts') ? all : [] }, isLoading: false },
}));

const { default: OverviewPage } = await import('@/app/page');

describe('Overview contract pagination', () => {
  it('loads further pages with the cursor and counts every contract', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <OverviewPage />
      </SWRConfig>,
    );
    expect(await screen.findByText('Contract 49')).toBeInTheDocument();
    expect(screen.queryByText('Contract 50')).not.toBeInTheDocument();
    expect(screen.getByText('Monitored contracts').parentElement).toHaveTextContent('60');

    fireEvent.click(screen.getByRole('button', { name: 'Load more contracts' }));
    expect(await screen.findByText('Contract 59')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/contracts?limit=50&cursor=c49');
    expect(screen.queryByRole('button', { name: 'Load more contracts' })).not.toBeInTheDocument();
  });
});
