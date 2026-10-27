import type * as ApiModule from '@/lib/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '@/lib/types';

const api = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: (...args: unknown[]) => api(...args),
}));

const { DestinationsCard } = await import('@/components/destinations');

beforeEach(() => {
  api.mockReset();
});

const slack: Destination = {
  id: 'd1',
  name: 'Ops channel',
  type: 'SLACK',
  enabled: true,
  config: { webhookUrl: 'https://hooks.slack.com/…ghij' },
  createdAt: '2026-10-26T00:00:00Z',
};

describe('DestinationsCard', () => {
  it('creates a Slack destination with its webhook URL', async () => {
    api.mockResolvedValue({ ...slack, config: {} });
    const onChange = vi.fn();
    render(<DestinationsCard destinations={[]} loading={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'SLACK' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops channel' } });
    fireEvent.change(screen.getByLabelText('Slack webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/T/B/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/destinations', {
      method: 'POST',
      body: {
        type: 'SLACK',
        name: 'Ops channel',
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
      },
    });
  });

  it('creates a Discord destination with its webhook URL', async () => {
    api.mockResolvedValue({ ...slack, type: 'DISCORD', config: {} });
    const onChange = vi.fn();
    render(<DestinationsCard destinations={[]} loading={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'DISCORD' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Community' } });
    fireEvent.change(screen.getByLabelText('Discord webhook URL'), {
      target: { value: 'https://discord.com/api/webhooks/1/abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/destinations', {
      method: 'POST',
      body: {
        type: 'DISCORD',
        name: 'Community',
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      },
    });
  });

  it('creates a Telegram destination with a bot token and chat ID', async () => {
    api.mockResolvedValue({ ...slack, type: 'TELEGRAM', config: { chatId: '-100123' } });
    const onChange = vi.fn();
    render(<DestinationsCard destinations={[]} loading={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'TELEGRAM' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bot' } });
    fireEvent.change(screen.getByLabelText(/Bot token/), { target: { value: '123:abc' } });
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '-100123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/destinations', {
      method: 'POST',
      body: { type: 'TELEGRAM', name: 'Bot', config: { botToken: '123:abc', chatId: '-100123' } },
    });
  });

  it('shows the masked Slack URL in the list', () => {
    render(<DestinationsCard destinations={[slack]} loading={false} onChange={vi.fn()} />);
    expect(screen.getByText('https://hooks.slack.com/…ghij')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
  });
});
