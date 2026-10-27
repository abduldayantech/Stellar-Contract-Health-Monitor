import type * as ApiModule from '@/lib/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Destination } from '@/lib/types';

const api = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: (...args: unknown[]) => api(...args),
}));

const { DestinationsCard } = await import('@/components/destinations');

const base: Destination = {
  id: 'd1',
  name: 'Ops hook',
  type: 'WEBHOOK',
  enabled: true,
  config: { url: 'https://example.com/hook', secret: 'whsec_…abcd', headers: [] },
  createdAt: '2026-10-26T00:00:00Z',
};

describe('destination health', () => {
  it('shows why a destination was disabled and re-enables it', async () => {
    const onChange = vi.fn();
    const reason = 'Disabled automatically after 20 failed deliveries in a row since 2026-10-01';
    render(
      <DestinationsCard
        destinations={[{ ...base, enabled: false, disabledReason: reason }]}
        loading={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(reason)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-enable' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/destinations/d1', {
      method: 'PATCH',
      body: { enabled: true },
    });
  });

  it('warns about a running failure streak', () => {
    render(
      <DestinationsCard
        destinations={[{ ...base, consecutiveFailures: 3 }]}
        loading={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 failed deliveries in a row/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });
});
